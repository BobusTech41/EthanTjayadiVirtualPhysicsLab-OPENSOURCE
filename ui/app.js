/**
 * Application shell: router, pages, workspace, autosave, dialogs (browser only for start(); helpers are pure).
 * docs/ARCHITECTURE.md §5, §8, §9.
 *
 * Routes (URL hash):
 *   #/             home
 *   #/practice     practice set-up  (?exp=<id>&variant=<id> preselects)
 *   #/exam         exam set-up
 *   #/drills       VL.ui.drillsView        #/progress  VL.ui.progressView
 *   #/instruments  VL.ui.instrumentLab     #/sessions  saved sessions (resume / delete)
 *   #/circuits     VL.ui.circuitLab (free circuit bench)
 *   #/s/<id>       workspace for a saved session
 *
 * Public:
 *   VL.ui.app = { start(), navigate(hash), parseRoute(hash), deriveSeed(rng, prefix), chooseExamQuestions(exps, seed),
 *                 createPracticeSession(o), createExamSession(o), progressEntry(session, q, report),
 *                 hintsFor(exp, variantId), current() }
 *   VL.ui.dialog = { open({title, body, actions, alert}), confirm({title, message, confirmLabel, cancelLabel, danger}),
 *                    alert({title, message}) }   -> Promise
 *
 * Nothing is ever filled in for the student: the workspace only wires the student's own typing, readings and
 * drawings into the session, saves it, and runs the marker when the student submits.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var EXAM_DEFAULT_MIN = 120;     // [verify] official Paper 3 duration (see PLAN.md)
  var EXAM_SHORT_MIN = 75;
  var TABS = [
    { id: 'paper', label: 'Paper' },
    { id: 'table', label: 'Table' },
    { id: 'graph', label: 'Graph' },
    { id: 'tools', label: 'Tools' },
    { id: 'report', label: 'Report' }
  ];

  /* ================================================================== */
  /* Pure helpers (no DOM; tested in Node)                               */
  /* ================================================================== */

  /**
   * Parse a location hash into a route.
   * @param {string} hash e.g. '#/s/abc' or '#/practice?exp=pendulum'
   * @returns {{name: string, id?: string, query: object}}
   */
  function parseRoute(hash) {
    var s = String(hash || '').replace(/^#/, '');
    var query = {};
    var qi = s.indexOf('?');
    if (qi !== -1) {
      s.slice(qi + 1).split('&').forEach(function (kv) {
        if (!kv) return;
        var eq = kv.indexOf('=');
        var k = eq === -1 ? kv : kv.slice(0, eq), v = eq === -1 ? '' : kv.slice(eq + 1);
        try { query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { query[k] = v; }
      });
      s = s.slice(0, qi);
    }
    var parts = s.split('/').filter(Boolean);
    if (!parts.length) return { name: 'home', query: query };
    var simple = ['practice', 'exam', 'drills', 'progress', 'instruments', 'circuits', 'sessions'];
    if (simple.indexOf(parts[0]) !== -1 && parts.length === 1) return { name: parts[0], query: query };
    if (parts[0] === 's' && parts[1]) {
      var id = parts[1];
      try { id = decodeURIComponent(id); } catch (e) { /* keep raw */ }
      return { name: 'session', id: id, query: query };
    }
    return { name: 'notfound', path: s, query: query };
  }

  function cleanPrefix(p) {
    p = String(p || 'LAB').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (p.length < 2) p = (p + 'LAB').slice(0, 3);
    return p;
  }

  /**
   * A valid, re-enterable seed drawn from a seeded Rng (so question seeds follow from the exam seed).
   * @param {object} rng VL.rng Rng
   * @param {string} prefix 2–4 letters
   * @returns {string} e.g. 'PEN-7K2Q-91C3'
   */
  function deriveSeed(rng, prefix) {
    var alphabet = (VL.rng && VL.rng.ALPHABET) || CROCKFORD;
    var s = '';
    for (var i = 0; i < 8; i++) s += alphabet.charAt(rng.int(0, alphabet.length - 1));
    return cleanPrefix(prefix) + '-' + s.slice(0, 4) + '-' + s.slice(4);
  }

  /**
   * Choose the exam questions: one Q1-style and one Q2-style variant, preferring two different experiments.
   * Question seeds are derived from the exam seed.
   * @param {object[]} experiments registered experiment definitions
   * @param {string} examSeed
   * @returns {{expId: string, variantId: string, seed: string, style: string}[]}
   */
  function chooseExamQuestions(experiments, examSeed) {
    var rng = VL.rng.create(String(examSeed)).fork('exam');
    var seedRng = VL.rng.create(String(examSeed)).fork('question-seeds');
    var q1 = [], q2 = [];
    (experiments || []).forEach(function (e) {
      (e.variants || []).forEach(function (v) { (v.style === 'Q2' ? q2 : q1).push({ exp: e, variant: v }); });
    });
    var picks = [];
    if (q1.length && q2.length) {
      var q1Good = q1.filter(function (c) { return q2.some(function (d) { return d.exp.id !== c.exp.id; }); });
      var first = rng.pick(q1Good.length ? q1Good : q1);
      var pool = q2.filter(function (d) { return d.exp.id !== first.exp.id; });
      picks = [first, rng.pick(pool.length ? pool : q2)];
    } else if (q1.length || q2.length) {
      // Only one style is installed: two questions of that style, from different experiments when possible.
      var all = q1.length ? q1 : q2;
      var a = rng.pick(all);
      var rest = all.filter(function (c) { return c.exp.id !== a.exp.id; });
      if (!rest.length) rest = all.filter(function (c) { return c !== a; });
      picks = rest.length ? [a, rng.pick(rest)] : [a];
    }
    return picks.map(function (c) {
      return { expId: c.exp.id, variantId: c.variant.id, style: c.variant.style, seed: deriveSeed(seedRng, c.exp.seedPrefix) };
    });
  }

  /** A fresh, unique session id (time-based plus a random seed fragment). */
  function makeSessionId(nowMs) {
    var rand = VL.rng && VL.rng.newSeed ? VL.rng.newSeed('SES').slice(4).replace('-', '').toLowerCase() : String(nowMs % 100000);
    return 's' + Number(nowMs || Date.now()).toString(36) + '-' + rand;
  }

  /** New empty Question (contract §5). */
  function newQuestion(qid, exp, variantId, seed, nowIso) {
    return {
      qid: qid, expId: exp.id, variantId: variantId, seed: seed,
      apparatusState: null,
      table: VL.datatable && VL.datatable.create ? VL.datatable.create({}) : null,
      graph: VL.graph && VL.graph.create ? VL.graph.create() : null,
      answers: {}, log: [], startedAt: nowIso, submitted: false, report: null
    };
  }

  function variantTitle(exp, variantId) {
    var v = VL.getVariant ? VL.getVariant(exp, variantId) : null;
    return exp.title + (v && v.title ? ' — ' + v.title : '');
  }

  /**
   * Practice session for one experiment variant.
   * @param {{exp: object, variantId: string, seed: string, hints: boolean, nowIso?: string, nowMs?: number}} o
   */
  function createPracticeSession(o) {
    var nowIso = o.nowIso || new Date().toISOString();
    var nowMs = o.nowMs || Date.parse(nowIso) || Date.now();
    return {
      id: makeSessionId(nowMs), mode: 'practice', created: nowIso, updated: nowIso,
      title: variantTitle(o.exp, o.variantId), seed: o.seed, hints: !!o.hints,
      elapsedMs: 0, finished: false,
      questions: [newQuestion('q1', o.exp, o.variantId, o.seed, nowIso)]
    };
  }

  /**
   * Timed exam session with the questions chosen by chooseExamQuestions.
   * @param {{experiments: object[], seed: string, minutes: number, nowIso?: string, nowMs?: number}} o
   */
  function createExamSession(o) {
    var nowIso = o.nowIso || new Date().toISOString();
    var nowMs = o.nowMs || Date.parse(nowIso) || Date.now();
    var picks = chooseExamQuestions(o.experiments, o.seed);
    var byId = {};
    (o.experiments || []).forEach(function (e) { byId[e.id] = e; });
    return {
      id: makeSessionId(nowMs), mode: 'exam', created: nowIso, updated: nowIso,
      title: 'Exam ' + o.seed, seed: o.seed, hints: false,
      examMinutes: o.minutes || EXAM_DEFAULT_MIN, elapsedMs: 0, finished: false, currentQ: 0,
      questions: picks.map(function (p, i) { return newQuestion('q' + (i + 1), byId[p.expId], p.variantId, p.seed, nowIso); })
    };
  }

  /**
   * ProgressEntry (contract §5) for a marked question.
   * @param {number} [qIndex] index of the question in the session (stored as entry.qIndex when given)
   */
  function progressEntry(session, q, report, qIndex) {
    var skills = {};
    ['MMO', 'PDO', 'ACE'].forEach(function (k) {
      var s = report && report.skills && report.skills[k];
      skills[k] = { got: s ? s.got : 0, max: s ? s.max : 0 };
    });
    var entry = {
      sessionId: session.id, date: (report && report.markedAt) || new Date().toISOString(), mode: session.mode,
      expId: q.expId, variantId: q.variantId, seed: q.seed,
      total: report ? report.total : 0, max: report ? report.max : 0, skills: skills
    };
    if (typeof qIndex === 'number' && isFinite(qIndex)) entry.qIndex = qIndex;
    return entry;
  }

  /** Practice hints for a variant: exp.hints may be a map, a per-variant map, or a function(variantId). */
  function hintsFor(exp, variantId) {
    var hnt = exp && exp.hints;
    if (!hnt) return null;
    try {
      if (typeof hnt === 'function') hnt = hnt(variantId);
      else if (hnt[variantId] && typeof hnt[variantId] === 'object') hnt = hnt[variantId];
    } catch (e) { return null; }
    return hnt && typeof hnt === 'object' ? hnt : null;
  }

  /* ================================================================== */
  /* Storage (VL.storage, or an in-memory fallback for this page only)   */
  /* ================================================================== */

  var memory = { kv: {}, sessions: {}, progress: [], settings: { examMinutes: EXAM_DEFAULT_MIN, theme: 'light', hintsInPractice: true } };
  var memoryStorage = {
    available: function () { return false; },
    get: function (k, f) { return k in memory.kv ? memory.kv[k] : f; },
    set: function (k, v) { memory.kv[k] = v; return true; },
    remove: function (k) { delete memory.kv[k]; },
    saveSession: function (s) { memory.sessions[s.id] = JSON.parse(JSON.stringify(s)); return true; },
    loadSession: function (id) { return memory.sessions[id] ? JSON.parse(JSON.stringify(memory.sessions[id])) : null; },
    listSessions: function () { return Object.keys(memory.sessions).map(function (k) { return memory.sessions[k]; }); },
    deleteSession: function (id) { delete memory.sessions[id]; },
    addProgress: function (e) { memory.progress.push(e); },
    getProgress: function () { return memory.progress.slice(); },
    clearProgress: function () { memory.progress = []; },
    getSettings: function () { return Object.assign({}, memory.settings); },
    setSettings: function (p) { Object.assign(memory.settings, p); return Object.assign({}, memory.settings); }
  };

  function store() { return VL.storage || memoryStorage; }
  function persistent() {
    try { return !!(VL.storage && VL.storage.available()); } catch (e) { return false; }
  }
  function settings() {
    var d = { examMinutes: EXAM_DEFAULT_MIN, theme: 'light', hintsInPractice: true };
    try { return Object.assign(d, store().getSettings() || {}); } catch (e) { return d; }
  }
  function setSettings(patch) { try { store().setSettings(patch); } catch (e) { /* ignore */ } }

  /* ================================================================== */
  /* Browser-only from here on                                           */
  /* ================================================================== */

  var h = function () { return ui.h.apply(null, arguments); };
  var page = null;              // { destroy() } of the current page
  var headerCtx = null;         // header context slot (first row, next to the brand)
  var headerBar = null;         // second header row (workspace only)
  var menuWsSlot = null;        // workspace items inside the main menu (small screens only, see styles/main.css)
  var closeMenuFn = function () {};
  var mainEl = null;
  var currentWorkspace = null;

  function navigate(hash) {
    if (globalThis.location.hash === hash) onRoute();
    else globalThis.location.hash = hash;
  }

  function toast(msg, kind) { if (ui.toast) ui.toast(msg, kind); }

  /* ---------------------------------------------------------------- dialogs */

  var dlgCount = 0;
  function focusables(el) {
    return Array.prototype.filter.call(el.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    function (x) { return !x.disabled && x.offsetParent !== null; });
  }

  /**
   * Open a modal dialog.
   * @param {{title: string, body?: Node|string, actions?: {label, value, primary?, danger?}[], alert?: boolean,
   *          cancelValue?: *, initialFocus?: number}} o
   * @returns {Promise<*>} the chosen action's value (cancelValue on Escape)
   */
  function openDialog(o) {
    return new Promise(function (resolve) {
      var root = document.getElementById('modal-root') || document.body;
      var prev = document.activeElement;
      var titleId = 'vl-dlg-' + (++dlgCount);
      var bodyId = titleId + '-body';
      var cancelValue = o.cancelValue === undefined ? false : o.cancelValue;
      var actions = o.actions || [{ label: 'OK', value: true, primary: true }];
      var btns = actions.map(function (a) {
        return h('button', {
          type: 'button', class: 'vl-btn' + (a.primary ? ' vl-btn--primary' : '') + (a.danger ? ' vl-btn--danger' : ''),
          on: { click: function () { close(a.value); } }
        }, a.label);
      });
      var body = typeof o.body === 'string' ? h('p', null, o.body) : (o.body || null);
      var dlg = h('div', {
        class: 'vl-modal', role: o.alert ? 'alertdialog' : 'dialog', 'aria-modal': 'true',
        'aria-labelledby': titleId, 'aria-describedby': body ? bodyId : null
      },
      h('h2', { class: 'vl-modal-title', id: titleId }, o.title || ''),
      body ? h('div', { class: 'vl-modal-body', id: bodyId }, body) : null,
      h('div', { class: 'vl-modal-actions' }, btns));
      var backdrop = h('div', { class: 'vl-modal-backdrop' }, dlg);
      var inerted = [document.getElementById('app'), document.getElementById('app-header')].filter(Boolean);
      inerted.forEach(function (el) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); });
      root.appendChild(backdrop);

      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(cancelValue); return; }
        if (ev.key === 'Tab') {
          var f = focusables(dlg);
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        }
      }
      backdrop.addEventListener('keydown', onKey);
      backdrop.addEventListener('mousedown', function (ev) { if (ev.target === backdrop && !o.alert) close(cancelValue); });
      var done = false;
      function close(v) {
        if (done) return;
        done = true;
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (!root.querySelector('.vl-modal-backdrop')) {
          inerted.forEach(function (el) { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); });
        }
        if (prev && prev.focus && document.contains(prev)) { try { prev.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        resolve(v);
      }
      var initial = typeof o.initialFocus === 'number' ? btns[o.initialFocus] : null;
      (initial || btns.filter(function (b, i) { return actions[i].primary; })[0] || btns[0] || dlg).focus();
    });
  }

  ui.dialog = {
    open: openDialog,
    /** @returns {Promise<boolean>} */
    confirm: function (o) {
      return openDialog({
        title: o.title, body: o.message || o.body,
        actions: [
          { label: o.cancelLabel || 'Cancel', value: false },
          { label: o.confirmLabel || 'OK', value: true, primary: !o.danger, danger: !!o.danger }
        ],
        initialFocus: o.danger ? 0 : 1
      });
    },
    alert: function (o) {
      return openDialog({ title: o.title, body: o.message || o.body, alert: true, actions: [{ label: o.okLabel || 'OK', value: true, primary: true }] });
    }
  };

  /* ---------------------------------------------------------------- theme */

  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    if (ui.bus) ui.bus.emit('theme:changed', { theme: theme === 'dark' ? 'dark' : 'light' });
  }

  /* ---------------------------------------------------------------- header */

  var menuOpen = false;
  function renderHeader() {
    var header = document.getElementById('app-header');
    if (!header) return;
    ui.clear(header);
    headerCtx = h('div', { class: 'vl-header-ctx', id: 'vl-header-ctx' });
    var themeBtn = h('button', { type: 'button', class: 'vl-menu-item', role: 'menuitemcheckbox' });
    function syncTheme() {
      var dark = settings().theme === 'dark';
      themeBtn.setAttribute('aria-checked', dark ? 'true' : 'false');
      themeBtn.textContent = (dark ? '✓ ' : '') + 'Dark theme';
    }
    syncTheme();
    themeBtn.addEventListener('click', function () {
      var next = settings().theme === 'dark' ? 'light' : 'dark';
      setSettings({ theme: next });
      applyTheme(next);
      syncTheme();
      closeMenu(true);
    });
    var links = [
      ['#/', 'Home'], ['#/practice', 'Practice mode'], ['#/exam', 'Exam mode'], ['#/drills', 'Skill drills'],
      ['#/instruments', 'Instrument lab'], ['#/circuits', 'Circuit lab'], ['#/progress', 'Progress'], ['#/sessions', 'Saved sessions']
    ];
    // Workspace items (question switch, seed, save status, Submit / Finish): filled by the workspace and shown only
    // on small screens, where the header is one compact row and these leave the header for the menu.
    menuWsSlot = h('div', { class: 'vl-menu-ws', role: 'group', 'aria-label': 'This session' });
    var menu = h('div', { class: 'vl-menu', id: 'vl-menu', role: 'menu', 'aria-label': 'Main menu', hidden: true },
      menuWsSlot,
      links.map(function (l) { return h('a', { class: 'vl-menu-item', href: l[0], role: 'menuitem' }, l[1]); }),
      h('hr', { class: 'vl-menu-sep', 'aria-hidden': 'true' }),
      themeBtn,
      h('button', { type: 'button', class: 'vl-menu-item', role: 'menuitem', on: { click: function () { closeMenu(); if (ui.shortcuts) ui.shortcuts.showHelp(); } } }, 'Keyboard shortcuts (?)'));
    var menuBtn = h('button', {
      type: 'button', class: 'vl-btn vl-menu-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'vl-menu'
    }, h('span', { class: 'vl-menu-icon', 'aria-hidden': 'true' }, '☰'), ' ', h('span', { class: 'vl-menu-text' }, 'Menu'));
    function openMenu() {
      menuOpen = true; menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true');
      var first = Array.prototype.filter.call(menu.querySelectorAll('.vl-menu-item'), function (x) {
        return x.offsetParent !== null && !x.disabled;
      })[0];
      if (first) first.focus();
    }
    function closeMenu(refocus) {
      if (!menuOpen) return;
      menuOpen = false; menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false');
      if (refocus) menuBtn.focus();
    }
    menuBtn.addEventListener('click', function () { if (menuOpen) closeMenu(); else openMenu(); });
    menu.addEventListener('click', function (ev) { if (ev.target.closest('a')) closeMenu(); });
    closeMenuFn = closeMenu;
    menu.addEventListener('keydown', function (ev) {
      // only the items that are shown (the session items are hidden on large screens)
      var items = Array.prototype.filter.call(menu.querySelectorAll('.vl-menu-item'), function (x) {
        return x.offsetParent !== null && !x.disabled;
      });
      var i = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(true); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); items[0].focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); items[items.length - 1].focus(); }
      else if (ev.key === 'Tab') closeMenu();
    });
    document.addEventListener('pointerdown', function (ev) {
      if (menuOpen && !menu.contains(ev.target) && !menuBtn.contains(ev.target)) closeMenu();
    });
    header.appendChild(h('a', { class: 'vl-brand', href: '#/', title: 'Home' },
      h('span', { class: 'vl-brand-mark', 'aria-hidden': 'true' }, 'P3'),
      h('span', { class: 'vl-brand-text' },
        h('span', { class: 'vl-brand-name' }, 'Virtual Practical Lab'),
        h('span', { class: 'vl-brand-sub' }, ''))));
    header.appendChild(headerCtx);
    header.appendChild(h('div', { class: 'vl-header-menu' }, menuBtn, menu));
    headerBar = h('div', { class: 'vl-header-bar' });
    header.appendChild(headerBar);
  }

  /* ---------------------------------------------------------------- router */

  function onRoute() {
    var route = parseRoute(globalThis.location.hash);
    if (page && typeof page.destroy === 'function') {
      try { page.destroy(); } catch (e) { console.error('[app destroy page]', e); }
    }
    page = null;
    ui.clear(headerCtx);
    ui.clear(headerBar);
    if (menuWsSlot) ui.clear(menuWsSlot);
    document.body.classList.remove('vl-body--ws');
    ui.clear(mainEl);
    var render = {
      home: renderHome, practice: renderPractice, exam: renderExamSetup, sessions: renderSessions,
      drills: function (el) { return renderOptional(el, 'drillsView', 'Skill drills', function (c) { return ui.drillsView.mount(c, { storage: VL.storage }); }); },
      progress: function (el) { return renderOptional(el, 'progressView', 'Progress', function (c) { return ui.progressView.mount(c); }); },
      instruments: function (el) { return renderOptional(el, 'instrumentLab', 'Instrument lab', function (c) { return ui.instrumentLab.mount(c); }); },
      circuits: renderCircuitLab,
      session: function (el, r) { return renderWorkspace(el, r.id); },
      notfound: renderNotFound
    }[route.name] || renderNotFound;
    try {
      page = render(mainEl, route) || null;
    } catch (e) {
      console.error('[app render ' + route.name + ']', e);
      ui.clear(mainEl);
      mainEl.appendChild(pageWrap(h('h1', null, 'Something went wrong'),
        h('p', { class: 'vl-error' }, 'This page could not be shown: ' + (e && e.message ? e.message : e)),
        h('p', null, h('a', { href: '#/', class: 'vl-btn' }, 'Back to the home page'))));
    }
    var heading = mainEl.querySelector('h1');
    if (route.name !== 'session' && heading) {
      heading.setAttribute('tabindex', '-1');
      try { heading.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    var titleBase = 'Virtual Practical Lab';
    document.title = heading && route.name !== 'home' ? heading.textContent + ' · ' + titleBase : titleBase;
    globalThis.scrollTo(0, 0);
  }

  function pageWrap() {
    var el = h('div', { class: 'vl-page' });
    for (var i = 0; i < arguments.length; i++) ui.append(el, arguments[i]);
    return el;
  }

  function renderNotFound(el) {
    el.appendChild(pageWrap(h('h1', null, 'Page not found'),
      h('p', null, 'There is nothing at this address.'),
      h('p', null, h('a', { href: '#/', class: 'vl-btn vl-btn--primary' }, 'Go to the home page'))));
  }

  /** Mount an optional component, or a friendly placeholder when it is not installed. */
  function renderOptional(el, name, title, mountFn) {
    if (!ui[name] || typeof ui[name].mount !== 'function') {
      el.appendChild(pageWrap(h('h1', null, title),
        h('div', { class: 'vl-placeholder-card' },
          h('p', null, title + ' is not available in this version of the lab yet.'),
          h('p', null, h('a', { href: '#/', class: 'vl-btn' }, 'Back to the home page')))));
      return null;
    }
    var box = h('div', { class: 'vl-page vl-page--wide vl-page--' + name });
    el.appendChild(box);
    try {
      return mountFn(box);
    } catch (e) {
      console.error('[app ' + name + ']', e);
      ui.clear(box);
      box.appendChild(h('h1', null, title));
      box.appendChild(h('p', { class: 'vl-error' }, title + ' could not be opened: ' + (e && e.message ? e.message : e)));
      return null;
    }
  }

  /** Circuit lab: a full-height workspace like an experiment (bench on the left, tabs on the right). */
  function renderCircuitLab(el) {
    if (!ui.circuitLab || !VL.circuit) {
      return renderOptional(el, 'circuitLab', 'Circuit lab', function () { return null; });
    }
    return ui.circuitLab.mount(el, { headerCtx: headerCtx, headerBar: headerBar, toast: toast });
  }

  /* ---------------------------------------------------------------- home */

  function listSessionsSafe() {
    var list = [];
    try { list = store().listSessions() || []; } catch (e) { list = []; }
    return list.filter(function (s) { return s && s.id; }).sort(function (a, b) {
      return String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || ''));
    });
  }

  function renderHome(el) {
    var items = [
      { href: '#/practice', title: 'Practice', text: 'Do one experiment, with hints and no time limit, then get it marked.' },
      { href: '#/exam', title: 'Exam', text: 'Two experiments, timed, no hints. Marked at the end.' },
      { href: '#/circuits', title: 'Circuit lab', text: 'Build any circuit from components and read the meters.' },
      { href: '#/instruments', title: 'Instrument lab', text: 'Practise reading rules, vernier callipers, micrometers, meters and more.' },
      { href: '#/drills', title: 'Drills', text: 'Short exercises: tables, graphs, uncertainties, evaluation.' },
      { href: '#/progress', title: 'Progress', text: 'Your marks over time.' },
      { href: '#/sessions', title: 'Saved sessions', text: 'Resume or delete earlier work.' }
    ];
    var resume = listSessionsSafe().filter(function (s) { return !s.finished; })[0];
    var storageNote = persistent() ? null : h('p', { class: 'vl-notice vl-notice--warn', role: 'note' },
      'Your work will not be saved in this browser window (storage is blocked).');
    el.appendChild(pageWrap(h('div', { class: 'vl-home' },
      h('h1', null, 'Virtual Practical Lab'),
      resume ? h('p', { class: 'vl-home-resume' }, h('a', { class: 'vl-btn vl-btn--primary', href: '#/s/' + encodeURIComponent(resume.id) },
        'Continue: ' + (resume.title || 'last session'))) : null,
      storageNote,
      h('nav', { 'aria-label': 'Features' },
        h('ul', { class: 'vl-home-list' }, items.map(function (c) {
          return h('li', null, h('a', { href: c.href }, c.title), h('span', null, c.text));
        }))))));
    return null;
  }

  /* ---------------------------------------------------------------- practice set-up */

  function experimentsSafe() {
    try { return typeof VL.listExperiments === 'function' ? VL.listExperiments() : []; } catch (e) { return []; }
  }

  function seedField(idBase, label, help) {
    var input = h('input', { class: 'vl-input vl-input--seed', id: idBase, type: 'text', autocomplete: 'off', spellcheck: 'false',
      autocapitalize: 'characters', 'aria-describedby': idBase + '-help ' + idBase + '-err', placeholder: 'e.g. PEN-7K2Q-91C3' });
    var err = h('p', { class: 'vl-field-error', id: idBase + '-err', role: 'alert', hidden: true });
    var el = h('div', { class: 'vl-field' },
      h('label', { class: 'vl-label', for: idBase }, label),
      h('p', { class: 'vl-help', id: idBase + '-help' }, help),
      input, err);
    return {
      el: el, input: input,
      /** @returns {{ok: boolean, seed: string|null}} */
      read: function () {
        var raw = input.value.trim();
        err.hidden = true; err.textContent = '';
        input.removeAttribute('aria-invalid');
        if (!raw) return { ok: true, seed: null };
        if (!VL.rng || !VL.rng.isValidSeed(raw)) {
          err.textContent = '⚠ That is not a valid seed. A seed looks like PEN-7K2Q-91C3: 2–4 letters, then two groups of four letters or digits.';
          err.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return { ok: false, seed: null };
        }
        return { ok: true, seed: VL.rng.normalizeSeed(raw) };
      }
    };
  }

  function renderPractice(el, route) {
    var exps = experimentsSafe();
    var st = settings();
    var wrap = pageWrap(h('h1', null, 'Practice mode'),
      h('p', { class: 'vl-lead' }, 'Choose an experiment. Hints are available and there is no time limit. Your work is saved as you go.'));
    el.appendChild(wrap);
    if (!exps.length) {
      wrap.appendChild(h('div', { class: 'vl-placeholder-card' }, h('p', null, 'No experiments are installed yet.')));
      return null;
    }
    var pre = route.query || {};
    var form = h('form', { class: 'vl-form', novalidate: true });
    var fs = h('fieldset', { class: 'vl-choices' }, h('legend', { class: 'vl-legend' }, 'Experiment and question type'));
    var first = true, anyChecked = false;
    exps.forEach(function (exp) {
      var group = h('div', { class: 'vl-choice-group' },
        h('h2', { class: 'vl-choice-exp' }, exp.title, exp.topic ? h('span', { class: 'vl-choice-topic' }, ' · ' + exp.topic) : null));
      exp.variants.forEach(function (v) {
        var id = 'vl-pv-' + exp.id + '-' + v.id;
        var checked = (pre.exp === exp.id && (!pre.variant || pre.variant === v.id) && !anyChecked) || false;
        if (checked) anyChecked = true;
        var input = h('input', { type: 'radio', name: 'variant', id: id, value: exp.id + '|' + v.id, class: 'vl-radio-input', checked: checked });
        if (first) { input.dataset.first = '1'; first = false; }
        group.appendChild(h('label', { class: 'vl-radio-card', for: id },
          input,
          h('span', { class: 'vl-radio-card-body' },
            h('span', { class: 'vl-radio-card-title' }, v.title || v.id),
            h('span', { class: 'vl-tag vl-tag--' + v.style.toLowerCase() }, v.style === 'Q1' ? 'Question 1 style' : 'Question 2 style'),
            v.description ? h('span', { class: 'vl-radio-card-text' }, v.description) : null)));
      });
      fs.appendChild(group);
    });
    if (!anyChecked) { var f0 = fs.querySelector('input[data-first]'); if (f0) f0.checked = true; }
    var seed = seedField('vl-practice-seed', 'Seed (optional)',
      'Leave blank for a new random set-up. Type a seed to repeat exactly the same apparatus and hidden values.');
    if (pre.seed) seed.input.value = pre.seed;
    var hints = h('input', { type: 'checkbox', id: 'vl-practice-hints', checked: st.hintsInPractice !== false });
    form.appendChild(fs);
    form.appendChild(seed.el);
    form.appendChild(h('div', { class: 'vl-field vl-check' }, hints, h('label', { for: 'vl-practice-hints' }, 'Show hints on the question paper')));
    form.appendChild(h('div', { class: 'vl-form-actions' }, h('button', { type: 'submit', class: 'vl-btn vl-btn--primary vl-btn--large' }, 'Start practice')));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var choice = form.querySelector('input[name=variant]:checked');
      if (!choice) return;
      var s = seed.read();
      if (!s.ok) return;
      var parts = choice.value.split('|');
      var exp = VL.getExperiment(parts[0]);
      setSettings({ hintsInPractice: hints.checked });
      var session = createPracticeSession({ exp: exp, variantId: parts[1], seed: s.seed || VL.rng.newSeed(exp.seedPrefix), hints: hints.checked });
      startSession(session);
    });
    wrap.appendChild(form);
    return null;
  }

  function startSession(session) {
    try { store().saveSession(session); } catch (e) { console.error('[app saveSession]', e); }
    sessionCache = session;
    navigate('#/s/' + encodeURIComponent(session.id));
  }

  /* ---------------------------------------------------------------- exam set-up */

  function renderExamSetup(el) {
    var exps = experimentsSafe();
    var st = settings();
    var wrap = pageWrap(h('h1', null, 'Exam mode'),
      h('p', { class: 'vl-lead' }, 'Two questions, 20 marks each. Timed. No hints; calculator only. Marked when you finish or when time runs out.'),
      h('p', { class: 'vl-help' }, 'The timer pauses if you leave the exam page, and continues when you come back.'));
    el.appendChild(wrap);
    if (!exps.length) {
      wrap.appendChild(h('div', { class: 'vl-placeholder-card' }, h('p', null, 'No experiments are installed yet.')));
      return null;
    }
    var form = h('form', { class: 'vl-form', novalidate: true });
    var minutes = st.examMinutes === EXAM_SHORT_MIN ? EXAM_SHORT_MIN : EXAM_DEFAULT_MIN;
    var dur = h('fieldset', { class: 'vl-choices vl-choices--inline' }, h('legend', { class: 'vl-legend' }, 'Time allowed'),
      durationOption(EXAM_DEFAULT_MIN, '2 hours', '', minutes === EXAM_DEFAULT_MIN),
      durationOption(EXAM_SHORT_MIN, '1 hour 15 minutes', '', minutes === EXAM_SHORT_MIN));
    function durationOption(min, title, text, checked) {
      var id = 'vl-exam-min-' + min;
      return h('label', { class: 'vl-radio-card', for: id },
        h('input', { type: 'radio', name: 'minutes', id: id, value: String(min), class: 'vl-radio-input', checked: checked }),
        h('span', { class: 'vl-radio-card-body' }, h('span', { class: 'vl-radio-card-title' }, title), h('span', { class: 'vl-radio-card-text' }, text)));
    }
    var seed = seedField('vl-exam-seed', 'Exam seed (optional)', 'Leave blank for a new random paper. Type an exam seed (for example EXM-4R7T-0K2M) to sit exactly the same paper again.');
    var installed = h('details', { class: 'vl-details' }, h('summary', null, 'Experiments that can appear (' + exps.length + ')'),
      h('ul', null, exps.map(function (e) { return h('li', null, e.title + (e.topic ? ' — ' + e.topic : '')); })));
    form.appendChild(dur);
    form.appendChild(seed.el);
    form.appendChild(installed);
    form.appendChild(h('div', { class: 'vl-form-actions' }, h('button', { type: 'submit', class: 'vl-btn vl-btn--primary vl-btn--large' }, 'Start the exam')));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var s = seed.read();
      if (!s.ok) return;
      var m = Number((form.querySelector('input[name=minutes]:checked') || {}).value) || EXAM_DEFAULT_MIN;
      setSettings({ examMinutes: m });
      var session = createExamSession({ experiments: exps, seed: s.seed || VL.rng.newSeed('EXM'), minutes: m });
      if (!session.questions.length) { toast('No questions could be chosen.', 'bad'); return; }
      startSession(session);
    });
    wrap.appendChild(form);
    return null;
  }

  /* ---------------------------------------------------------------- saved sessions */

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  /**
   * Status line for a saved session. Works from a storage summary (finished, total, max, elapsedMs, examMinutes)
   * and only loads the full session when the summary lacks what is needed.
   */
  function sessionStatus(s) {
    var full = s;
    var needFull = !s.questions && (s.title === undefined || (s.finished && s.max === undefined));
    if (needFull && s.id) { try { full = store().loadSession(s.id) || s; } catch (e) { full = s; } }
    var total = full.total, max = full.max;
    if (full.questions) {
      var marked = full.questions.filter(function (q) { return q.report; });
      if (marked.length) {
        total = 0; max = 0;
        marked.forEach(function (q) { total += q.report.total || 0; max += q.report.max || 0; });
      }
    }
    if (full.finished && max) return { text: 'Marked: ' + total + ' / ' + max, done: true, full: full };
    if (full.finished) return { text: 'Finished', done: true, full: full };
    if (full.mode === 'exam' && full.examMinutes) {
      var left = Math.max(0, full.examMinutes * 60000 - (full.elapsedMs || 0));
      return { text: 'In progress · ' + (ui.timer ? ui.timer.format(left) : Math.round(left / 60000) + ' min') + ' left', done: false, full: full };
    }
    return { text: 'In progress', done: false, full: full };
  }

  function renderSessions(el) {
    var wrap = pageWrap(h('h1', null, 'Saved sessions'));
    el.appendChild(wrap);
    if (!persistent()) {
      wrap.appendChild(h('p', { class: 'vl-notice vl-notice--warn' }, '⚠ This browser is not letting the lab save data, so only sessions from this visit are listed.'));
    }
    var listBox = h('div', { class: 'vl-sessions' });
    wrap.appendChild(listBox);
    function draw() {
      ui.clear(listBox);
      var list = listSessionsSafe();
      if (!list.length) {
        listBox.appendChild(h('div', { class: 'vl-placeholder-card' },
          h('p', null, 'You have no saved sessions yet.'),
          h('p', null, h('a', { href: '#/practice', class: 'vl-btn vl-btn--primary' }, 'Start a practice'), ' ',
            h('a', { href: '#/exam', class: 'vl-btn' }, 'Start an exam'))));
        return;
      }
      listBox.appendChild(h('ul', { class: 'vl-session-list' }, list.map(function (s) {
        var st = sessionStatus(s);
        var title = s.title || st.full.title || 'Session';
        var mode = s.mode || st.full.mode || 'practice';
        return h('li', { class: 'vl-session' },
          h('div', { class: 'vl-session-main' },
            h('span', { class: 'vl-badge vl-badge--' + mode }, mode === 'exam' ? 'Exam' : mode === 'drill' ? 'Drill' : 'Practice'),
            h('a', { class: 'vl-session-title', href: '#/s/' + encodeURIComponent(s.id) }, title),
            h('span', { class: 'vl-session-meta' }, 'Last saved ' + fmtDate(s.updated || s.created || st.full.updated)),
            h('span', { class: 'vl-session-status' + (st.done ? ' vl-session-status--done' : '') }, (st.done ? '✓ ' : '') + st.text)),
          h('div', { class: 'vl-session-actions' },
            h('a', { class: 'vl-btn vl-btn--primary', href: '#/s/' + encodeURIComponent(s.id) }, st.done ? 'Open report' : 'Resume'),
            h('button', { type: 'button', class: 'vl-btn vl-btn--ghost vl-btn--danger-text', 'aria-label': 'Delete ' + title, on: { click: function () {
              ui.dialog.confirm({ title: 'Delete this session?', message: '“' + title + '” will be removed from this browser. Your progress history is kept.', confirmLabel: 'Delete', danger: true })
                .then(function (ok) {
                  if (!ok) return;
                  try { store().deleteSession(s.id); } catch (e) { console.error(e); }
                  if (sessionCache && sessionCache.id === s.id) sessionCache = null;
                  toast('Session deleted.');
                  draw();
                });
            } } }, 'Delete')));
      })));
    }
    draw();
    return null;
  }

  /* ================================================================== */
  /* Workspace                                                           */
  /* ================================================================== */

  var sessionCache = null;      // the session most recently created / opened (avoids a reload round trip)

  function loadSessionById(id) {
    if (sessionCache && sessionCache.id === id) return sessionCache;
    var s = null;
    try { s = store().loadSession(id); } catch (e) { s = null; }
    if (s && Array.isArray(s.questions)) {
      s.questions.forEach(function (q) {
        if (q.table && VL.datatable && VL.datatable.fromJSON) { try { q.table = VL.datatable.fromJSON(q.table); } catch (e) { /* keep */ } }
        if (q.graph && VL.graph && VL.graph.fromJSON) { try { q.graph = VL.graph.fromJSON(q.graph); } catch (e) { /* keep */ } }
        if (!Array.isArray(q.log)) q.log = [];
        if (!q.answers) q.answers = {};
      });
    }
    sessionCache = s;
    return s;
  }

  function renderWorkspace(el, id) {
    var session = loadSessionById(id);
    if (!session || !Array.isArray(session.questions) || !session.questions.length) {
      el.appendChild(pageWrap(h('h1', null, 'Session not found'),
        h('p', null, 'This session is not saved in this browser. It may have been deleted, or it was saved on another device.'),
        h('p', null, h('a', { href: '#/sessions', class: 'vl-btn vl-btn--primary' }, 'Saved sessions'), ' ',
          h('a', { href: '#/', class: 'vl-btn' }, 'Home'))));
      return null;
    }
    var ws = new Workspace(el, session);
    currentWorkspace = ws;
    return { destroy: function () { ws.destroy(); if (currentWorkspace === ws) currentWorkspace = null; } };
  }

  /**
   * The working screen for one session: header context, apparatus (left) and tabs (right).
   * @constructor
   */
  function Workspace(el, session) {
    var self = this;
    this.session = session;
    this.el = el;
    this.views = {};
    this.app = null;
    this.target = null;
    this.tab = 'paper';
    this.destroyed = false;
    this.offs = [];
    this.clockBase = session.elapsedMs || 0;
    this.clockStart = Date.now();
    this.saveState = 'saved';
    this.conflict = null;           // 'changed' | 'deleted' once another tab changed / deleted this session
    this.pendingProgress = [];      // ProgressEntries waiting for the marked session to be saved
    this.scheduleSave = ui.debounce(function () { self.saveNow(); }, 1000);
    this.qIndex = Math.min(Math.max(0, session.currentQ || 0), session.questions.length - 1);

    document.body.classList.add('vl-body--ws');
    this.buildHeader();
    this.buildLayout();
    this.mountQuestion(this.qIndex, session.finished ? 'report' : 'paper');

    var onHide = function () { if (document.hidden) self.saveNow(); };
    document.addEventListener('visibilitychange', onHide);   // pagehide is handled once in start()
    this.offs.push(function () { document.removeEventListener('visibilitychange', onHide); });
    // another tab saving or deleting this session: stop at once (see onConflict)
    var onStorage = function (ev) { self.onStorageEvent(ev); };
    globalThis.addEventListener('storage', onStorage);
    this.offs.push(function () { globalThis.removeEventListener('storage', onStorage); });
    if (session.mode === 'exam' && !session.finished) {
      var iv = setInterval(function () { self.saveNow(); }, 15000);
      this.offs.push(function () { clearInterval(iv); });
    }
    if (ui.shortcuts) {
      ui.shortcuts.install();
      this.offs.push(ui.shortcuts.setContext(this.shortcutContext()));
    }
  }

  Workspace.prototype.isExam = function () { return this.session.mode === 'exam'; };
  Workspace.prototype.question = function () { return this.session.questions[this.qIndex]; };

  Workspace.prototype.elapsed = function () {
    if (this.timer) return this.timer.elapsed();
    if (this.session.finished) return this.session.elapsedMs || 0;
    return this.clockBase + (Date.now() - this.clockStart);
  };

  /* ---------------------------------------------------------------- header context */

  Workspace.prototype.buildHeader = function () {
    var self = this, s = this.session;
    var modeBadge = h('span', { class: 'vl-badge vl-badge--' + s.mode }, s.mode === 'exam' ? 'Exam' : 'Practice');
    this.titleEl = h('span', { class: 'vl-ws-title' });
    headerCtx.appendChild(h('div', { class: 'vl-ws-meta' }, modeBadge, this.titleEl));

    this.qSwitch = h('div', { class: 'vl-qswitch', role: 'group', 'aria-label': 'Question' });
    if (s.questions.length > 1) {
      s.questions.forEach(function (q, i) {
        self.qSwitch.appendChild(h('button', {
          type: 'button', class: 'vl-btn vl-qswitch-btn', dataset: { q: String(i) }, 'aria-pressed': 'false',
          on: { click: function () { self.switchQuestion(i); } }
        }, 'Question ' + (i + 1)));
      });
    } else this.qSwitch.hidden = true;
    this.seedCode = h('code', { class: 'vl-seed-code' });
    var copyBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--small vl-btn--ghost', title: 'Copy the seed', 'aria-label': 'Copy the seed', on: { click: function () { self.copySeed(); } } }, 'Copy');
    this.seedBox = h('span', { class: 'vl-seed' }, h('span', { class: 'vl-seed-label' }, 'Seed'), ' ', this.seedCode, ' ', copyBtn);
    this.timerBox = h('span', { class: 'vl-ws-timer' });
    this.saveEl = h('span', { class: 'vl-save', role: 'status', 'aria-live': 'polite' });
    this.narrow = h('div', { class: 'vl-narrow-toggle', role: 'group', 'aria-label': 'Show' },
      h('button', { type: 'button', class: 'vl-btn', dataset: { show: 'apparatus' }, 'aria-pressed': 'false', on: { click: function () { self.showSide('apparatus'); } } }, 'Apparatus'),
      h('button', { type: 'button', class: 'vl-btn', dataset: { show: 'panel' }, 'aria-pressed': 'true', on: { click: function () { self.showSide('panel'); } } }, 'Paper'));
    this.actions = h('div', { class: 'vl-ws-actions' });
    headerBar.appendChild(this.qSwitch);
    headerBar.appendChild(this.seedBox);
    headerBar.appendChild(this.timerBox);
    headerBar.appendChild(this.saveEl);
    headerBar.appendChild(h('span', { class: 'vl-ws-spacer' }));
    headerBar.appendChild(this.narrow);
    headerBar.appendChild(this.actions);

    this.setSaveStatus(persistent() ? 'saved' : 'nostore');
    if (s.mode === 'exam' && !s.finished && ui.timer) {
      this.timer = ui.timer.mount(this.timerBox, {
        durationMs: (s.examMinutes || EXAM_DEFAULT_MIN) * 60000,
        elapsedMs: s.elapsedMs || 0,
        warnAt: [15, 5],
        onTick: function (ms) { s.elapsedMs = ms; },
        onWarn: function (min) { toast('⚠ ' + min + ' minutes remaining.', 'warn'); },
        onEnd: function () { self.finishExam(true); }
      });
    } else if (s.mode === 'exam' && s.finished) {
      this.timerBox.appendChild(h('span', { class: 'vl-ws-done' }, '✓ Exam finished'));
    }
  };

  Workspace.prototype.setSaveStatus = function (state) {
    this.saveState = state;
    var text = {
      saved: '✓ Saved', pending: 'Saving…', saving: 'Saving…',
      error: '⚠ Not saved', nostore: '⚠ Not saved', conflict: '⚠ Not saved — changed elsewhere'
    }[state] || '';
    this.saveEl.textContent = text;
    this.saveEl.className = 'vl-save vl-save--' + (state === 'conflict' ? 'error vl-save--conflict' : state);
    this.saveEl.title = state === 'nostore' ? 'This browser does not allow the lab to store data; your work will be lost when you close the page.'
      : state === 'error' ? 'Saving failed (the browser storage may be full).'
      : state === 'conflict' ? 'This session was changed or deleted in another tab, so this tab no longer saves it.' : '';
    this.syncMenuSave();
  };

  Workspace.prototype.copySeed = function () {
    var seed = this.question().seed;
    var done = function () { toast('Seed ' + seed + ' copied.'); };
    var fallback = function () {
      var ta = h('textarea', { class: 'vl-offscreen', 'aria-hidden': 'true' });
      ta.value = seed;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) done(); else toast('Copy failed — the seed is ' + seed, 'warn');
    };
    if (globalThis.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(seed).then(done, fallback);
    } else fallback();
  };

  /* ---------------------------------------------------------------- layout */

  Workspace.prototype.buildLayout = function () {
    this.left = h('section', { class: 'vl-ws-left', 'aria-label': 'Apparatus' });
    var self = this;
    this.tablist = h('div', { class: 'vl-tabs', role: 'tablist', 'aria-label': 'Question paper and tools' });
    // roving focus between tabs (registered once; the tabs themselves are rebuilt for each question)
    this.tablist.addEventListener('keydown', function (ev) {
      if (!self.tabButtons) return;
      var ids = Object.keys(self.tabButtons);
      var i = ids.indexOf(self.tab);
      var next = null;
      if (ev.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
      else if (ev.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
      else if (ev.key === 'Home') next = ids[0];
      else if (ev.key === 'End') next = ids[ids.length - 1];
      if (next) { ev.preventDefault(); self.activateTab(next, true); }
    });
    this.panels = h('div', { class: 'vl-tabpanels' });
    this.right = h('section', { class: 'vl-ws-right', 'aria-label': 'Question paper, results and tools' }, this.tablist, this.panels);
    this.bannerBox = h('div', { class: 'vl-ws-banners' });
    this.root = h('div', { class: 'vl-ws', dataset: { show: 'panel' } },
      this.bannerBox,
      h('div', { class: 'vl-ws-main' }, this.left, this.right));
    this.el.appendChild(this.root);
  };

  Workspace.prototype.showSide = function (which) {
    this.root.dataset.show = which;
    Array.prototype.forEach.call(this.narrow.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.show === which ? 'true' : 'false');
    });
  };

  /** The session actions for the current state: [{ label, run(), primary?, title? }]. */
  Workspace.prototype.actionList = function () {
    var self = this, s = this.session, q = this.question();
    if (this.conflict) {
      return [{ label: 'Reload this session', primary: true, run: function () { self.reloadSession(); } }];
    }
    if (s.mode === 'exam') {
      if (!s.finished) return [{ label: 'Finish exam', primary: true, run: function () { self.finishExam(false); } }];
    } else if (!q.submitted) {
      return [{ label: 'Submit for marking', primary: true, run: function () { self.submitPractice(); } }];
    }
    return [
      { label: 'Try again (same seed)', title: 'Start again with exactly the same apparatus and hidden values', run: function () { self.retry(true); } },
      { label: 'New attempt (new seed)', primary: true, run: function () { self.retry(false); } }
    ];
  };

  Workspace.prototype.renderActions = function () {
    var self = this;
    ui.clear(this.actions);
    this.actionList().forEach(function (a) {
      self.actions.appendChild(h('button', { type: 'button', class: 'vl-btn' + (a.primary ? ' vl-btn--primary' : ''), title: a.title || null,
        on: { click: function () { a.run(); } } }, a.label));
    });
    this.renderMenu();
  };

  /**
   * The session's items in the main menu: question switch, copy seed, save status and the actions. CSS shows them
   * only on small screens, where the header is reduced to one row (timer, Apparatus / Paper, Menu).
   */
  Workspace.prototype.renderMenu = function () {
    if (!menuWsSlot || this.destroyed) return;
    var self = this, s = this.session, q = this.question();
    ui.clear(menuWsSlot);
    function item(label, run, extra) {
      var attrs = { type: 'button', class: 'vl-menu-item vl-menu-item--ws', role: 'menuitem',
        on: { click: function () { closeMenuFn(true); run(); } } };
      Object.keys(extra || {}).forEach(function (k) { attrs[k] = extra[k]; });
      return h('button', attrs, label);
    }
    if (s.questions.length > 1) {
      s.questions.forEach(function (qq, i) {
        var on = i === self.qIndex;
        menuWsSlot.appendChild(item((on ? '● ' : '') + 'Question ' + (i + 1) + (qq.submitted ? ' ✓' : ''),
          function () { self.switchQuestion(i); },
          { role: 'menuitemradio', 'aria-checked': on ? 'true' : 'false', dataset: { q: String(i) } }));
      });
    }
    menuWsSlot.appendChild(item('Copy the seed ' + (q ? q.seed : ''), function () { self.copySeed(); }));
    this.menuSave = h('button', { type: 'button', class: 'vl-menu-item vl-menu-status', role: 'menuitem', disabled: true }, '');
    menuWsSlot.appendChild(this.menuSave);
    this.actionList().forEach(function (a) {
      menuWsSlot.appendChild(item(a.label, a.run, a.primary ? { class: 'vl-menu-item vl-menu-item--ws vl-menu-item--primary' } : null));
    });
    menuWsSlot.appendChild(h('hr', { class: 'vl-menu-sep', 'aria-hidden': 'true' }));
    this.syncMenuSave();
  };

  Workspace.prototype.syncMenuSave = function () {
    if (this.menuSave && this.saveEl) this.menuSave.textContent = 'Save status: ' + (this.saveEl.textContent || '—');
  };

  /* ---------------------------------------------------------------- question mounting */

  Workspace.prototype.unmountQuestion = function () {
    var v = this.views;
    Object.keys(v).forEach(function (k) {
      if (v[k] && typeof v[k].destroy === 'function') { try { v[k].destroy(); } catch (e) { console.error('[ws destroy ' + k + ']', e); } }
    });
    this.views = {};
    if (this.app) { try { this.app.destroy(); } catch (e) { console.error('[ws destroy apparatus]', e); } }
    this.app = null;
    this.target = null;
    ui.clear(this.left);
    ui.clear(this.tablist);
    ui.clear(this.panels);
  };

  Workspace.prototype.mountQuestion = function (index, tab) {
    var self = this, s = this.session;
    this.unmountQuestion();
    this.qIndex = index;
    s.currentQ = index;
    var q = this.question();
    var exp = VL.getExperiment ? VL.getExperiment(q.expId) : null;
    this.exp = exp;
    this.params = null;
    this.paper = null;

    Array.prototype.forEach.call(this.qSwitch.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', Number(b.dataset.q) === index ? 'true' : 'false');
      b.classList.toggle('vl-qswitch-btn--done', !!s.questions[Number(b.dataset.q)].submitted);
    });
    this.titleEl.textContent = (s.questions.length > 1 ? 'Question ' + (index + 1) + ': ' : '') + (exp ? variantTitle(exp, q.variantId) : q.expId);
    this.seedCode.textContent = q.seed;
    this.renderActions();

    if (!exp) {
      this.left.appendChild(h('div', { class: 'vl-placeholder-card' }, h('p', null, 'The experiment “' + q.expId + '” is not installed in this version of the lab, so this session cannot be opened.')));
      this.panels.appendChild(h('div', { class: 'vl-placeholder-card' }, h('p', null, 'Nothing to show.')));
      return;
    }
    if (VL.rng) {
      try { this.params = exp.sampleParams(VL.rng.create(q.seed).fork('params'), q.variantId); }
      catch (e) { console.error('[ws sampleParams]', e); }
    }
    try { this.paper = exp.paper(q.variantId, this.params); } catch (e) { console.error('[ws paper]', e); }

    /* apparatus */
    if (ui.apparatusView) {
      try {
        this.app = ui.apparatusView.mount(this.left, {
          exp: exp, question: q, params: this.params, readOnly: !!q.submitted || !!this.conflict,
          readOnlyText: this.conflict && !q.submitted
            ? 'This session was changed in another tab, so it is read-only here. Reload it to carry on.' : undefined,
          services: { mode: s.mode, hints: s.mode === 'practice' && !!s.hints, toast: function (m) { toast(m); } },
          onRecord: function (str, o) { return self.recordTo(str, o); },
          onChange: function () { self.markDirty(); }
        });
      } catch (e) {
        console.error('[ws apparatus]', e);
        this.left.appendChild(h('p', { class: 'vl-error' }, 'The apparatus could not be shown: ' + e.message));
      }
    } else {
      this.left.appendChild(h('div', { class: 'vl-placeholder-card' }, h('p', null, 'The apparatus view is not available.')));
    }

    /* tabs */
    this.tabButtons = {};
    this.tabPanels = {};
    TABS.forEach(function (t) {
      if (t.id === 'report' && !q.submitted) return;
      var tabId = 'vl-tab-' + t.id, panelId = 'vl-panel-' + t.id;
      var btn = h('button', {
        type: 'button', role: 'tab', id: tabId, class: 'vl-tab', 'aria-selected': 'false', 'aria-controls': panelId, tabindex: '-1',
        on: { click: function () { self.activateTab(t.id); } }
      }, t.label, h('span', { class: 'vl-tab-key', 'aria-hidden': 'true' }, 'Alt+' + (TABS.indexOf(t) + 1)));
      var panel = h('div', { role: 'tabpanel', id: panelId, class: 'vl-tabpanel vl-tabpanel--' + t.id, 'aria-labelledby': tabId, hidden: true, tabindex: '-1' });
      self.tabButtons[t.id] = btn;
      self.tabPanels[t.id] = panel;
      self.tablist.appendChild(btn);
      self.panels.appendChild(panel);
    });
    this.activateTab(tab && this.tabButtons[tab] ? tab : 'paper');
  };

  Workspace.prototype.switchQuestion = function (i) {
    if (i === this.qIndex || i < 0 || i >= this.session.questions.length) return;
    this.saveNow();
    var keepTab = this.tab === 'report' && this.session.questions[i].submitted ? 'report' : 'paper';
    this.mountQuestion(i, keepTab);
    this.saveNow();
  };

  /** Show a tab (mounting its component the first time). @returns {boolean} */
  Workspace.prototype.activateTab = function (id, focusTab) {
    if (!this.tabButtons || !this.tabButtons[id]) return false;
    var self = this;
    this.tab = id;
    Object.keys(this.tabButtons).forEach(function (k) {
      var on = k === id;
      self.tabButtons[k].setAttribute('aria-selected', on ? 'true' : 'false');
      self.tabButtons[k].setAttribute('tabindex', on ? '0' : '-1');
      self.tabPanels[k].hidden = !on;
    });
    // a record target belongs to its tab: switching tabs drops it, so a later Record never writes into a box the
    // student cannot see (the narrow Apparatus / Paper toggle is not a tab change and keeps it)
    if (this.target && this.target.tab && this.target.tab !== id) this.setTarget(null);
    if (!this.views[id]) this.mountTab(id);
    if (id === 'paper' && this.views.paper && this.views.paper.refreshStatus) this.views.paper.refreshStatus();
    if (focusTab) this.tabButtons[id].focus();
    if (this.root.dataset.show === 'apparatus') this.showSide('panel');
    return true;
  };

  Workspace.prototype.mountTab = function (id) {
    var self = this, s = this.session, q = this.question(), exp = this.exp;
    var panel = this.tabPanels[id];
    var readOnly = !!q.submitted || !!this.conflict;
    var hints = s.mode === 'practice' && !!s.hints && !readOnly;
    function missing(what) { panel.appendChild(h('div', { class: 'vl-placeholder-card' }, h('p', null, what + ' is not available in this version of the lab.'))); return null; }
    function attempt(fn, what) {
      try { return fn(); } catch (e) {
        console.error('[ws mount ' + id + ']', e);
        panel.appendChild(h('p', { class: 'vl-error' }, what + ' could not be shown: ' + (e && e.message ? e.message : e)));
        return null;
      }
    }
    var view = null;
    switch (id) {
      case 'paper':
        if (!ui.paperView) { view = missing('The question paper'); break; }
        if (!this.paper) { panel.appendChild(h('p', { class: 'vl-error' }, 'The question paper could not be produced for this experiment.')); break; }
        var appList = null;
        try { appList = typeof exp.apparatusList === 'function' ? exp.apparatusList(q.variantId) : null; } catch (e) { appList = null; }
        view = attempt(function () {
          return ui.paperView.mount(panel, {
            paper: self.paper, answers: q.answers, readOnly: readOnly,
            hints: hints ? hintsFor(exp, q.variantId) : null,
            apparatusList: appList,
            title: s.questions.length > 1 ? 'Question ' + (self.qIndex + 1) : null,
            onAnswer: function (key, value) { q.answers[key] = value; self.markDirty(); },
            onFocusAnswer: function (t) { self.setTarget(t); },
            onGoto: function (tab) { self.activateTab(tab); },
            statusFor: function (type) { return self.statusFor(type); }
          });
        }, 'The question paper');
        break;
      case 'table':
        if (!ui.tableView) { view = missing('The results table'); break; }
        if (!q.table && VL.datatable) q.table = VL.datatable.create({});
        if (!q.table) { view = missing('The results table'); break; }
        view = attempt(function () {
          return ui.tableView.mount(panel, q.table, {
            readOnly: readOnly, hints: hints,
            onChange: function (t) { q.table = t; self.markDirty(); },
            onFocusCell: function (t) { self.setTarget(t); }
          });
        }, 'The results table');
        break;
      case 'graph':
        if (!ui.graphView) { view = missing('The graph paper'); break; }
        if (!q.graph && VL.graph) q.graph = VL.graph.create();
        if (!q.graph) { view = missing('The graph paper'); break; }
        view = attempt(function () {
          return ui.graphView.mount(panel, q.graph, q.table || { columns: [], rows: [] }, {
            readOnly: readOnly, hints: hints, extension: false,
            onChange: function (g) { q.graph = g; self.markDirty(); }
          });
        }, 'The graph paper');
        break;
      case 'tools':
        if (!ui.uncertaintyView) { view = missing('The tools'); break; }
        view = attempt(function () {
          return ui.uncertaintyView.mount(panel, { graph: q.graph, table: q.table, extension: true, mode: s.mode });
        }, 'The tools');
        break;
      case 'report':
        view = this.mountReport(panel);
        break;
    }
    this.views[id] = view;
  };

  Workspace.prototype.mountReport = function (panel) {
    var self = this, s = this.session, q = this.question();
    var parts = [];
    if (s.mode === 'exam' && s.finished && ui.reportView && ui.reportView.mountExamSummary) {
      parts.push(ui.reportView.mountExamSummary(panel, { session: s, onOpen: function (i) {
        if (i === self.qIndex) {
          var first = panel.querySelector('.vl-report');
          if (first) first.scrollIntoView({ block: 'start' });
        } else { self.saveNow(); self.mountQuestion(i, 'report'); }
      } }));
    }
    if (!q.report) {
      panel.appendChild(h('div', { class: 'vl-placeholder-card' },
        h('p', null, q.markError ? 'This question could not be marked: ' + q.markError : 'This question has not been marked.')));
    } else if (!ui.reportView) {
      panel.appendChild(h('div', { class: 'vl-placeholder-card' }, h('p', null, 'Total: ' + q.report.total + ' / ' + q.report.max + '. The full report view is not available.')));
    } else {
      try {
        parts.push(ui.reportView.mount(panel, {
          exp: this.exp, question: q, report: q.report, session: s, paper: this.paper
        }));
      } catch (e) {
        console.error('[ws report]', e);
        panel.appendChild(h('p', { class: 'vl-error' }, 'The report could not be shown: ' + e.message));
      }
    }
    return { destroy: function () { parts.forEach(function (p) { if (p && p.destroy) p.destroy(); }); } };
  };

  /** Short, neutral status for the paper's Table / Graph links (never reveals marks). */
  Workspace.prototype.statusFor = function (type) {
    var q = this.question();
    if (type === 'table') {
      var t = q.table;
      if (!t) return '';
      var cols = (t.columns || []).filter(function (c) { return String(c.heading || '').trim(); }).length;
      var rows = VL.datatable && VL.datatable.filledRows ? VL.datatable.filledRows(t).length : 0;
      if (!cols && !rows) return 'Your table is empty.';
      return 'Your table: ' + cols + (cols === 1 ? ' column heading, ' : ' column headings, ') + rows + (rows === 1 ? ' row' : ' rows') + ' with data.';
    }
    if (type === 'graph') {
      var g = q.graph;
      if (!g) return '';
      var bits = [(g.points || []).length + ((g.points || []).length === 1 ? ' point plotted' : ' points plotted')];
      if (g.line) bits.push('line drawn');
      if (g.triangle) bits.push('gradient triangle drawn');
      return 'Your graph: ' + bits.join(', ') + '.';
    }
    return '';
  };

  /* ---------------------------------------------------------------- record target */

  /**
   * Record target contract (where the reading pad writes; set by the paper and table views when a box is focused):
   *   {
   *     kind: 'answer' | 'cell' | …,
   *     tab: 'paper' | 'table' | …,   // the tab that shows the box: switching to another tab clears the target
   *     label,                        // shown in the pad: "Records to: (b) L ="
   *     write(str) -> boolean,        // false when the box no longer exists
   *     current() -> string,          // the box's present text (checked before overwriting it)
   *     appends?: boolean             // write() adds to the text instead of replacing it (text boxes): no confirmation
   *   }
   */
  Workspace.prototype.setTarget = function (t) {
    this.target = t && typeof t.write === 'function' ? t : null;
    if (this.app) this.app.setTargetLabel(this.target ? this.target.label : null);
  };

  /**
   * Write a reading to the current target.
   * A box that already holds a different value is not overwritten unless o.confirmed: nothing is written and
   * { needsConfirm: true, old, label } is returned, so the pad can ask "Replace it?".
   * @param {string} str
   * @param {{confirmed?: boolean}} [o]
   * @returns {{label: string}|{needsConfirm: true, old: string, label: string}|null} null: no target (rough notes)
   */
  Workspace.prototype.recordTo = function (str, o) {
    if (!this.target || this.question().submitted) return null;
    var t = this.target;
    if (!(o && o.confirmed) && !t.appends && typeof t.current === 'function') {
      var old = '';
      try { old = t.current(); } catch (e) { old = ''; }
      old = old === undefined || old === null ? '' : String(old);
      if (old.trim() && old.trim() !== String(str).trim()) return { needsConfirm: true, old: old, label: t.label };
    }
    var ok = false;
    try { ok = this.target.write(str); } catch (e) { console.error('[ws record]', e); ok = false; }
    if (ok === false) {
      toast('That box no longer exists — the reading was kept in Rough notes. Click a table cell or answer line.', 'warn');
      this.setTarget(null);
      return null;
    }
    this.markDirty();
    return { label: this.target.label };
  };

  /* ---------------------------------------------------------------- saving */

  Workspace.prototype.markDirty = function () {
    if (this.destroyed || this.conflict) return;
    if (this.saveState !== 'nostore') this.setSaveStatus('pending');
    this.scheduleSave();
  };

  /**
   * Save the session now. Uses VL.storage.saveSessionChecked when present, so a copy that another tab changed or
   * deleted is never overwritten (that switches this tab to read-only, see onConflict).
   * @returns {boolean} true when the session was stored
   */
  Workspace.prototype.saveNow = function () {
    if (this.destroyed && this.savedOnDestroy) return false;
    if (this.conflict) return false;            // never overwrite the other tab's copy (or re-create a deleted one)
    var s = this.session;
    if (this.app && !this.question().submitted) { try { this.app.saveState(); } catch (e) { console.error('[ws saveState]', e); } }
    else if (this.app) { try { this.app.saveState(); } catch (e) { /* ignore */ } }
    s.updated = new Date().toISOString();
    if (!s.finished) s.elapsedMs = this.elapsed();
    var st = store(), ok = false, res = null;
    try {
      if (typeof st.saveSessionChecked === 'function') {
        res = st.saveSessionChecked(s) || {};
        ok = !!res.ok;
      } else {
        ok = st.saveSession(s) !== false;
      }
    } catch (e) { console.error('[ws saveSession]', e); ok = false; }
    if (res && res.conflict) {
      this.onConflict(res.conflict);
      return false;
    }
    if (this.saveEl) this.setSaveStatus(!persistent() ? 'nostore' : ok ? 'saved' : 'error');
    if (ok) this.flushProgress();
    else if (persistent()) this.showSaveBanner();
    return ok;
  };

  /** Progress entries for questions marked while saving failed are added once the session is stored. */
  Workspace.prototype.flushProgress = function () {
    var list = this.pendingProgress;
    this.pendingProgress = [];
    list.forEach(function (e) { try { store().addProgress(e); } catch (err) { console.error('[ws addProgress]', err); } });
  };

  /* ---------------------------------------------------------------- banners (not saved, changed elsewhere) */

  /**
   * Show a persistent notice above the workspace (replacing one with the same id).
   * @param {string} id
   * @param {Node|string} content
   * @param {{kind?: string, dismissible?: boolean, actions?: {label: string, run: function}[]}} [o]
   */
  Workspace.prototype.showBanner = function (id, content, o) {
    o = o || {};
    var self = this;
    this.hideBanner(id);
    var box = h('div', { class: 'vl-ws-banner vl-notice vl-notice--' + (o.kind || 'warn'), role: 'alert', dataset: { banner: id } },
      h('div', { class: 'vl-ws-banner-text' }, content),
      (o.actions || []).map(function (a) {
        return h('button', { type: 'button', class: 'vl-btn vl-btn--small', on: { click: function () { a.run(); } } }, a.label);
      }),
      o.dismissible === false ? null : h('button', { type: 'button', class: 'vl-btn vl-btn--small vl-btn--ghost vl-ws-banner-close',
        'aria-label': 'Dismiss this message', title: 'Dismiss', on: { click: function () { self.hideBanner(id, true); } } }, '✕'));
    this.bannerBox.appendChild(box);
  };

  Workspace.prototype.hideBanner = function (id, dismissed) {
    var old = this.bannerBox && this.bannerBox.querySelector('[data-banner="' + id + '"]');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (dismissed) { this.dismissed = this.dismissed || {}; this.dismissed[id] = true; }
  };

  var NOT_SAVED_ADVICE = 'Download the CSV and PDF from the Report now, and free space by deleting old sessions on Saved sessions.';

  /** The first time saving fails, a banner says so (the header badge alone is easy to miss). */
  Workspace.prototype.showSaveBanner = function () {
    if (this.dismissed && this.dismissed.save) return;
    if (this.bannerBox && this.bannerBox.querySelector('[data-banner="save"]')) return;
    var marked = this.session.questions.some(function (q) { return q.report; });
    this.showBanner('save', [h('strong', null, '⚠ Your work could not be saved '), '(browser storage is full or blocked). ',
      marked ? NOT_SAVED_ADVICE
        : 'Free space by deleting old sessions on Saved sessions; once your work is marked, download the CSV and PDF from the Report.']);
  };

  /** After marking, when the marked session could not be stored: a dialog that stays until dismissed. */
  Workspace.prototype.notSavedDialog = function () {
    return ui.dialog.alert({
      title: 'Your marked work was not saved',
      message: 'Your marked work could not be saved (browser storage is full or blocked). ' + NOT_SAVED_ADVICE
    });
  };

  /* ---------------------------------------------------------------- the same session in another tab */

  function sessionStorageKey(id) {
    var prefix = VL.storage && typeof VL.storage.PREFIX === 'string' ? VL.storage.PREFIX : 'vlab1:';
    return prefix + 'session:' + id;
  }

  /** window 'storage' event: another tab wrote or removed this session. */
  Workspace.prototype.onStorageEvent = function (ev) {
    if (this.conflict || this.destroyed || !ev) return;
    if (ev.key === null) {                       // storage cleared in another tab
      if (persistent()) this.onConflict('deleted');
      return;
    }
    if (ev.key !== sessionStorageKey(this.session.id)) return;
    if (ev.newValue === null || ev.newValue === undefined) { this.onConflict('deleted'); return; }
    var rev;
    try { rev = (JSON.parse(ev.newValue) || {}).rev; } catch (e) { rev = undefined; }
    if (rev !== this.session.rev) this.onConflict('changed');
  };

  /**
   * Another tab changed or deleted this session: stop saving (autosave, pagehide, question switch), make this tab
   * read-only and ask the student to reload the stored copy or close.
   * @param {'changed'|'deleted'} kind
   */
  Workspace.prototype.onConflict = function (kind) {
    if (this.conflict || this.destroyed) return;
    var self = this;
    this.conflict = kind === 'deleted' ? 'deleted' : 'changed';
    if (this.destroying) return;                 // leaving the page anyway: just do not save
    this.setSaveStatus('conflict');
    var tab = this.tab;
    try { this.mountQuestion(this.qIndex, tab); } catch (e) { console.error('[ws conflict remount]', e); }
    var deleted = this.conflict === 'deleted';
    var title = deleted ? 'This session was deleted in another tab' : 'This session was changed in another tab';
    this.showBanner('conflict', [h('strong', null, '⚠ ' + title + '. '),
      'This tab has stopped saving and is read-only, so it cannot overwrite that work.'],
    { kind: 'bad', dismissible: false, actions: [{ label: 'Reload this session', run: function () { self.reloadSession(); } }] });
    ui.dialog.open({
      title: title,
      body: (deleted ? 'The session was deleted in another tab or window. '
        : 'The same session is open in another tab or window, and a newer copy was saved there. ') +
        'To avoid overwriting that work, this tab has stopped saving and is now read-only.',
      alert: true,
      cancelValue: 'stay',
      actions: [
        { label: 'Close', value: 'close' },
        { label: 'Reload this session', value: 'reload', primary: true }
      ]
    }).then(function (v) {
      if (self.destroyed) return;
      if (v === 'reload') self.reloadSession();
      else if (v === 'close') navigate('#/');
    });
  };

  /** Read the session again from storage and show it (after a conflict). */
  Workspace.prototype.reloadSession = function () {
    sessionCache = null;
    var hash = '#/s/' + encodeURIComponent(this.session.id);
    if (globalThis.location.hash === hash) onRoute();
    else navigate(hash);
  };

  /* ---------------------------------------------------------------- marking */

  /** Mark one question; throws on failure. */
  Workspace.prototype.markQuestion = function (q) {
    var exp = VL.getExperiment ? VL.getExperiment(q.expId) : null;
    if (!exp) throw new Error('the experiment “' + q.expId + '” is not installed');
    if (!VL.marking || typeof VL.marking.run !== 'function') throw new Error('the marking engine is not available in this build');
    var report = VL.marking.run(exp, q);
    if (!report) throw new Error('the marker returned no report');
    if (!report.markedAt) report.markedAt = new Date().toISOString();
    q.report = report;
    q.submitted = true;
    delete q.markError;
    // progress is recorded by the caller once the marked session has been saved (see recordProgress)
    return report;
  };

  /**
   * After marking: save the session and only then record progress for the questions just marked (so progress
   * never counts work that was not stored). When the save fails the entries wait in pendingProgress and are added
   * by the next successful save.
   * @param {number[]} indices questions marked just now
   * @returns {boolean} whether the session was saved
   */
  Workspace.prototype.saveAndRecordProgress = function (indices) {
    var self = this, s = this.session;
    indices.forEach(function (i) {
      var q = s.questions[i];
      if (q && q.report) self.pendingProgress.push(progressEntry(s, q, q.report, i));
    });
    var ok = this.saveNow();
    if (!ok) this.showSaveBanner();
    return ok;
  };

  Workspace.prototype.submitPractice = function () {
    var self = this, q = this.question();
    ui.dialog.confirm({
      title: 'Submit for marking?',
      message: 'Your table, graph and answers will be marked. You will not be able to change them afterwards (you can try the same set-up again).',
      confirmLabel: 'Submit for marking'
    }).then(function (ok) {
      if (!ok || self.conflict || self.destroyed) return;
      if (self.app) self.app.saveState();
      try {
        self.markQuestion(q);
      } catch (e) {
        console.error('[ws mark]', e);
        ui.dialog.alert({ title: 'Marking failed', message: 'Your work could not be marked: ' + e.message + '. Nothing has been locked; your work is saved.' });
        return;
      }
      self.session.finished = true;
      self.session.elapsedMs = self.elapsed();
      var saved = self.saveAndRecordProgress([self.qIndex]);
      if (self.conflict) return;
      self.mountQuestion(self.qIndex, 'report');
      if (saved) toast('Marked: ' + q.report.total + ' / ' + q.report.max + '.', 'ok');
      else self.notSavedDialog();
    });
  };

  /**
   * Finish the exam: confirm (unless the time is up), mark every question, show the reports.
   * @param {boolean} timeUp
   */
  Workspace.prototype.finishExam = function (timeUp) {
    var self = this, s = this.session;
    if (s.finished || this.finishing || this.conflict) return;
    var go = function () {
      if (s.finished || self.conflict || self.destroyed && !timeUp) return;
      self.finishing = true;
      if (self.app) self.app.saveState();
      if (self.timer) { s.elapsedMs = self.timer.elapsed(); self.timer.pause(); }
      var failures = [], marked = [];
      s.questions.forEach(function (q, i) {
        if (q.submitted && q.report) return;
        try { self.markQuestion(q); marked.push(i); } catch (e) {
          console.error('[ws mark exam]', e);
          q.submitted = true;
          q.report = null;
          q.markError = e.message;
          failures.push('Question ' + (i + 1) + ': ' + e.message);
        }
      });
      s.finished = true;
      self.finishing = false;
      var saved = self.saveAndRecordProgress(marked);
      if (self.timer) { self.timer.destroy(); self.timer = null; }
      ui.clear(self.timerBox);
      self.timerBox.appendChild(h('span', { class: 'vl-ws-done' }, '✓ Exam finished'));
      if (self.conflict) return;
      if (!self.destroyed) self.mountQuestion(self.qIndex, 'report');
      if (!saved) {
        var why = failures.length ? ' Some questions could not be marked: ' + failures.join('; ') : '';
        ui.dialog.alert({ title: 'Your marked work was not saved',
          message: 'Your marked work could not be saved (browser storage is full or blocked). ' + NOT_SAVED_ADVICE + why });
      } else if (timeUp) {
        ui.dialog.alert({ title: 'Time is up', message: 'Your answers have been marked. Read the report for each question.' + (failures.length ? ' Some questions could not be marked: ' + failures.join('; ') : '') });
      } else if (failures.length) {
        ui.dialog.alert({ title: 'Some questions could not be marked', message: failures.join('; ') });
      }
    };
    if (timeUp) { go(); return; }
    var left = this.timer ? ui.timer.format(this.timer.remaining()) : '';
    var unanswered = s.questions.filter(function (q) { return !Object.keys(q.answers || {}).some(function (k) { var v = q.answers[k]; return Array.isArray(v) ? v.some(Boolean) : String(v || '').trim(); }); }).length;
    ui.dialog.confirm({
      title: 'Finish the exam?',
      message: 'Both questions will be marked and you will not be able to change your answers.' +
        (left ? ' You still have ' + left + ' left.' : '') +
        (unanswered ? ' ' + unanswered + (unanswered === 1 ? ' question has' : ' questions have') + ' no written answers yet.' : ''),
      confirmLabel: 'Finish and mark', cancelLabel: 'Keep working'
    }).then(function (ok) { if (ok) go(); });
  };

  /** Start a new session: same seed(s) when sameSeed, otherwise new random ones. */
  Workspace.prototype.retry = function (sameSeed) {
    var s = this.session, q = this.question();
    var session;
    if (s.mode === 'exam') {
      var exps = experimentsSafe();
      session = createExamSession({ experiments: exps, seed: sameSeed ? s.seed : VL.rng.newSeed('EXM'), minutes: s.examMinutes });
    } else {
      var exp = VL.getExperiment(q.expId);
      if (!exp) { toast('This experiment is not installed.', 'bad'); return; }
      session = createPracticeSession({ exp: exp, variantId: q.variantId, seed: sameSeed ? q.seed : VL.rng.newSeed(exp.seedPrefix), hints: s.hints });
    }
    this.saveNow();
    startSession(session);
  };

  /* ---------------------------------------------------------------- shortcuts */

  Workspace.prototype.shortcutContext = function () {
    var self = this;
    function app(name) { return function () { if (!self.app || typeof self.app[name] !== 'function') return false; return self.app[name](); }; }
    return {
      stopwatchToggle: app('stopwatchToggle'),
      stopwatchReset: app('stopwatchReset'),
      record: function () { if (!self.app) return false; self.app.record(); return true; },
      undo: function () { var v = self.views[self.tab]; return (self.tab === 'table' || self.tab === 'graph') && v && v.undo ? v.undo() : false; },
      redo: function () { var v = self.views[self.tab]; return (self.tab === 'table' || self.tab === 'graph') && v && v.redo ? v.redo() : false; },
      zoomIn: app('zoomIn'), zoomOut: app('zoomOut'), zoomReset: app('zoomReset'),
      eyeLower: app('eyeLower'), eyeHigher: app('eyeHigher'),
      switchTab: function (i) { var t = TABS[i]; return t ? self.activateTab(t.id, true) : false; }
    };
  };

  Workspace.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroying = true;
    this.saveNow();
    this.savedOnDestroy = true;
    this.destroyed = true;
    if (this.timer) { this.timer.destroy(); this.timer = null; }
    this.unmountQuestion();
    this.offs.forEach(function (off) { try { off(); } catch (e) { /* ignore */ } });
    this.offs = [];
    document.body.classList.remove('vl-body--ws');
  };

  /* ================================================================== */
  /* Boot                                                                */
  /* ================================================================== */

  var started = false;
  function start() {
    if (started) return;
    started = true;
    mainEl = document.getElementById('app');
    if (!mainEl) return;
    applyTheme(settings().theme);
    renderHeader();
    if (ui.shortcuts) ui.shortcuts.install();
    if (!VL.rng) {
      ui.clear(mainEl);
      mainEl.appendChild(pageWrap(h('h1', null, 'The lab could not start'), h('p', { class: 'vl-error' }, 'A core file (core/rng.js) is missing.')));
      return;
    }
    globalThis.addEventListener('hashchange', onRoute);
    globalThis.addEventListener('pagehide', function () { if (currentWorkspace) currentWorkspace.saveNow(); });
    onRoute();
  }

  ui.app = {
    start: start,
    navigate: navigate,
    parseRoute: parseRoute,
    deriveSeed: deriveSeed,
    chooseExamQuestions: chooseExamQuestions,
    createPracticeSession: createPracticeSession,
    createExamSession: createExamSession,
    progressEntry: progressEntry,
    hintsFor: hintsFor,
    makeSessionId: makeSessionId,
    /** The open workspace (for tests and debugging), or null. */
    current: function () { return currentWorkspace; },
    EXAM_DEFAULT_MIN: EXAM_DEFAULT_MIN,
    EXAM_SHORT_MIN: EXAM_SHORT_MIN
  };

  if (globalThis.document && typeof document.addEventListener === 'function') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else setTimeout(start, 0);
  }
})(globalThis.VLab = globalThis.VLab || {});
