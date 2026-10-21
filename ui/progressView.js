/**
 * Progress page (browser only). docs/ARCHITECTURE.md §9.
 *
 *   VL.ui.progressView.mount(container, { storage? }) -> { destroy(), refresh(), el }
 *
 * Shows the student's marked attempts (VL.storage.getProgress()):
 *   - summary cards: number of attempts, average mark, weakest skill over the last 10 attempts;
 *   - a line chart of the MMO / PDO / ACE percentages over attempts (canvas, sharp on high-DPI screens; each skill
 *     has its own colour AND marker shape AND line style, with a legend and labelled axes) plus the same data as
 *     an accessible table;
 *   - every experiment / drill attempted, with best score, date of the last attempt and its seed;
 *   - recent attempts; and a "Clear progress" button (with confirmation).
 *
 * Pure helpers (no DOM) are exported for reuse: summarize(entries), byActivity(entries), activityLabel(expId,
 * variantId), skillPercent(entry, skill), entryPercent(entry).
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var SKILLS = [
    { id: 'MMO', name: 'Manipulation, measurement and observation', cssVar: '--skill-mmo', fallback: '#0b4fb3',
      shape: 'circle', shapeName: 'circles', dash: [], lineName: 'solid line',
      tip: 'Take readings to the precision of the instrument, repeat them, use a wide range of values and check your technique (e.g. time many oscillations).' },
    { id: 'PDO', name: 'Presentation of data and observations', cssVar: '--skill-pdo', fallback: '#7b2cbf',
      shape: 'square', shapeName: 'squares', dash: [9, 5], lineName: 'dashed line',
      tip: 'Write headings as quantity / unit, give raw data to a consistent number of decimal places, give calculated values to the right s.f., choose sensible scales and plot carefully.' },
    { id: 'ACE', name: 'Analysis, conclusions and evaluation', cssVar: '--skill-ace', fallback: '#b35c00',
      shape: 'triangle', shapeName: 'triangles', dash: [2, 4], lineName: 'dotted line',
      tip: 'Use a large gradient triangle, find intercepts correctly, combine uncertainties, state a numerical criterion in conclusions, and give specific limitations and improvements.' }
  ];
  var DRILLS = {
    'drill-graph': 'Graph drill',
    'drill-uncertainty': 'Uncertainty drill',
    'drill-table': 'Table drill',
    'drill-evaluation': 'Evaluation drill'
  };
  var MAX_CHART = 50;      // attempts shown in the chart
  var RECENT = 15;         // rows in the recent-attempts table
  var WEAKEST_WINDOW = 10; // attempts used for the weakest skill

  /* ================================================================== pure helpers */

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /** Percentage of an attempt (null when it has no marks available). */
  function entryPercent(e) {
    var max = num(e && e.max);
    return max > 0 ? 100 * num(e.total) / max : null;
  }

  /** Percentage for one skill in an attempt (null when the attempt did not assess that skill). */
  function skillPercent(e, skill) {
    var s = e && e.skills && e.skills[skill];
    var max = num(s && s.max);
    return max > 0 ? 100 * num(s.got) / max : null;
  }

  /** Display name of an activity. */
  function activityLabel(expId, variantId) {
    if (DRILLS[expId]) return DRILLS[expId];
    var exp = null;
    try { exp = VL.getExperiment ? VL.getExperiment(expId) : null; } catch (e) { exp = null; }
    var title = exp ? exp.title : (expId ? String(expId) : 'Unknown activity');
    if (exp && variantId) {
      var v = VL.getVariant ? VL.getVariant(exp, variantId) : null;
      if (v) return title + ' — ' + (v.title || v.id) + (v.style ? ' (' + v.style + ')' : '');
    }
    return variantId && !exp ? title + ' — ' + variantId : title;
  }

  function sortByDate(entries) {
    return entries.map(function (e, i) { return { e: e, i: i }; }).sort(function (a, b) {
      var c = String(a.e.date || '').localeCompare(String(b.e.date || ''));
      return c || a.i - b.i;
    }).map(function (x) { return x.e; });
  }

  /**
   * Summary statistics.
   * @param {object[]} entries ProgressEntry list (any order)
   * @returns {{attempts:number, exams:number, drills:number, averagePct:number|null,
   *            recent:Object<string,{got:number,max:number,pct:number|null}>,
   *            weakest:{skill:string, pct:number, got:number, max:number}|null}}
   */
  function summarize(entries) {
    var list = sortByDate(Array.isArray(entries) ? entries : []);
    var pcts = list.map(entryPercent).filter(function (p) { return p !== null; });
    var recent = {};
    var last = list.slice(-WEAKEST_WINDOW);
    SKILLS.forEach(function (s) {
      var got = 0, max = 0;
      last.forEach(function (e) {
        var k = e.skills && e.skills[s.id];
        if (k && num(k.max) > 0) { got += num(k.got); max += num(k.max); }
      });
      recent[s.id] = { got: got, max: max, pct: max > 0 ? 100 * got / max : null };
    });
    var weakest = null;
    SKILLS.forEach(function (s) {
      var r = recent[s.id];
      if (r.pct === null) return;
      if (!weakest || r.pct < weakest.pct - 1e-9) weakest = { skill: s.id, pct: r.pct, got: r.got, max: r.max };
    });
    return {
      attempts: list.length,
      exams: list.filter(function (e) { return e.mode !== 'drill'; }).length,
      drills: list.filter(function (e) { return e.mode === 'drill'; }).length,
      averagePct: pcts.length ? pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length : null,
      recent: recent,
      weakest: weakest
    };
  }

  /**
   * Attempts grouped by activity (experiment + variant, or drill), most recently attempted first.
   * @returns {{key, expId, variantId, label, mode, attempts, best:object, last:object}[]}
   */
  function byActivity(entries) {
    var groups = {};
    sortByDate(Array.isArray(entries) ? entries : []).forEach(function (e) {
      var key = (e.expId || '?') + '|' + (DRILLS[e.expId] ? '' : (e.variantId || ''));
      var g = groups[key];
      if (!g) {
        g = groups[key] = { key: key, expId: e.expId, variantId: DRILLS[e.expId] ? null : e.variantId,
          label: activityLabel(e.expId, DRILLS[e.expId] ? null : e.variantId), mode: e.mode, attempts: 0, best: null, last: null };
      }
      g.attempts++;
      var p = entryPercent(e);
      if (p !== null && (!g.best || p > g.best.pct + 1e-9)) g.best = { pct: p, total: num(e.total), max: num(e.max), date: e.date, seed: e.seed };
      g.last = e;
    });
    return Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) {
      return String(b.last.date || '').localeCompare(String(a.last.date || ''));
    });
  }

  /* ================================================================== formatting */

  function fmtPct(p) { return p === null || p === undefined || !isFinite(p) ? '—' : Math.round(p) + ' %'; }

  function fmtDate(iso, withTime) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '—';
    try {
      var o = { day: 'numeric', month: 'short', year: 'numeric' };
      if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
      return d.toLocaleString('en-GB', o);
    } catch (e) {
      return d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ');
    }
  }

  function modeName(mode) {
    return mode === 'exam' ? 'Exam' : mode === 'drill' ? 'Drill' : mode === 'practice' ? 'Practice' : String(mode || '—');
  }

  function skillCell(e, skill) {
    var s = e.skills && e.skills[skill];
    if (!s || !(num(s.max) > 0)) return '—';
    return num(s.got) + ' / ' + num(s.max);
  }

  function cssVar(name, fallback) {
    try {
      var v = globalThis.getComputedStyle(document.documentElement).getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    } catch (e) {
      return fallback;
    }
  }

  /* ================================================================== chart drawing */

  /** Parse '#rgb', '#rrggbb' or 'rgb(r, g, b)' to [r, g, b] (0–255), or null. */
  function parseColour(c) {
    var s = String(c || '').trim(), m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(s))) return m[1].split('').map(function (x) { return parseInt(x + x, 16); });
    if ((m = /^#([0-9a-f]{6})$/i.exec(s))) return [0, 2, 4].map(function (i) { return parseInt(m[1].substr(i, 2), 16); });
    if ((m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s))) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return null;
  }

  /** Relative luminance (0 = black, 1 = white), or null when the colour cannot be read. */
  function luminance(c) {
    var rgb = parseColour(c);
    if (!rgb) return null;
    var l = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  }

  /**
   * The skill colours in tokens.css are chosen for a light panel. On a dark panel they are mixed with white so
   * the lines keep enough contrast (the same hue, just lighter).
   */
  function seriesColour(colour, panel) {
    var lp = luminance(panel), rgb = parseColour(colour);
    if (lp === null || lp > 0.3 || !rgb) return colour;
    var t = 0.45;
    return 'rgb(' + rgb.map(function (v) { return Math.round(v + (255 - v) * t); }).join(', ') + ')';
  }

  /** Draw a marker shape centred on (x, y). */
  function marker(g, shape, x, y, r, fill, stroke) {
    g.beginPath();
    if (shape === 'square') g.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
    else if (shape === 'triangle') { g.moveTo(x, y - r * 1.15); g.lineTo(x + r * 1.1, y + r * 0.85); g.lineTo(x - r * 1.1, y + r * 0.85); g.closePath(); }
    else g.arc(x, y, r, 0, 2 * Math.PI);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = stroke;
    g.stroke();
  }

  /** Small inline SVG legend key: a line in the skill's style with its marker (colours follow the theme). */
  function legendKey(skill) {
    var colour = 'var(--vp-' + skill.id.toLowerCase() + ', var(' + skill.cssVar + ', ' + skill.fallback + '))';
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '44');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 44 18');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', '2'); ln.setAttribute('y1', '9'); ln.setAttribute('x2', '42'); ln.setAttribute('y2', '9');
    ln.setAttribute('style', 'stroke: ' + colour); ln.setAttribute('stroke-width', '2.5');
    if (skill.dash.length) ln.setAttribute('stroke-dasharray', skill.dash.join(' '));
    svg.appendChild(ln);
    var m;
    if (skill.shape === 'square') {
      m = document.createElementNS(NS, 'rect');
      m.setAttribute('x', '16.5'); m.setAttribute('y', '4.5'); m.setAttribute('width', '9'); m.setAttribute('height', '9');
    } else if (skill.shape === 'triangle') {
      m = document.createElementNS(NS, 'polygon');
      m.setAttribute('points', '22,3 27.5,13.5 16.5,13.5');
    } else {
      m = document.createElementNS(NS, 'circle');
      m.setAttribute('cx', '22'); m.setAttribute('cy', '9'); m.setAttribute('r', '5');
    }
    m.setAttribute('style', 'fill: ' + colour);
    m.setAttribute('stroke', 'currentColor');
    m.setAttribute('stroke-width', '1');
    svg.appendChild(m);
    return svg;
  }

  /**
   * Draw the skills chart.
   * @param {HTMLCanvasElement} canvas
   * @param {object[]} list entries in chronological order (already limited)
   * @param {number} firstNumber attempt number of list[0]
   * @param {number} cssW width in CSS px
   */
  function drawChart(canvas, list, firstNumber, cssW) {
    var cssH = cssW < 520 ? 260 : 320;
    var g = ui.fitCanvas(canvas, cssW, cssH);
    var ink = cssVar('--ink', '#111418'), muted = cssVar('--muted', '#4a5360'), line = cssVar('--line', '#b9c2cd');
    var panel = cssVar('--panel', '#ffffff');
    var font = cssVar('--font-ui', 'system-ui, sans-serif');
    g.fillStyle = panel;
    g.fillRect(0, 0, cssW, cssH);

    var left = 58, right = 18, top = 16, bottom = 52;
    var W = cssW - left - right, H = cssH - top - bottom;
    var n = list.length;
    function X(i) { return n <= 1 ? left + W / 2 : left + W * i / (n - 1); }
    function Y(p) { return top + H * (1 - p / 100); }

    // grid lines and y-axis scale (every 20 %)
    g.font = '13px ' + font;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (var p = 0; p <= 100; p += 20) {
      g.strokeStyle = line;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(left, Math.round(Y(p)) + 0.5);
      g.lineTo(left + W, Math.round(Y(p)) + 0.5);
      g.stroke();
      g.fillStyle = muted;
      g.fillText(String(p), left - 8, Y(p));
    }
    // axes
    g.strokeStyle = ink;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(left, top);
    g.lineTo(left, top + H);
    g.lineTo(left + W, top + H);
    g.stroke();
    // x ticks: thin out so labels never collide
    var step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(W / 36))));
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (var i = 0; i < n; i++) {
      if (i % step !== 0 && i !== n - 1) continue;
      if (i !== n - 1 && n - 1 - i < step && i % step === 0 && i !== 0) continue;
      g.beginPath();
      g.moveTo(X(i), top + H);
      g.lineTo(X(i), top + H + 5);
      g.stroke();
      g.fillStyle = muted;
      g.fillText(String(firstNumber + i), X(i), top + H + 8);
    }
    // axis labels
    g.fillStyle = ink;
    g.font = '13px ' + font;
    g.fillText('Attempt number', left + W / 2, top + H + 28);
    g.save();
    g.translate(16, top + H / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = 'middle';
    g.fillText('Mark / %', 0, 0);
    g.restore();

    // series
    SKILLS.forEach(function (s) {
      var colour = seriesColour(cssVar(s.cssVar, s.fallback), panel);
      var pts = [];
      list.forEach(function (e, idx) {
        var pc = skillPercent(e, s.id);
        if (pc !== null) pts.push({ x: X(idx), y: Y(Math.max(0, Math.min(100, pc))) });
      });
      if (!pts.length) return;
      g.save();
      g.strokeStyle = colour;
      g.lineWidth = 2.5;
      g.lineJoin = 'round';
      g.setLineDash(s.dash);
      g.beginPath();
      pts.forEach(function (pt, k) { if (k) g.lineTo(pt.x, pt.y); else g.moveTo(pt.x, pt.y); });
      g.stroke();
      g.restore();
      var r = n > 30 ? 3.5 : 5;
      pts.forEach(function (pt) { marker(g, s.shape, pt.x, pt.y, r, colour, panel); });
    });
    return cssH;
  }

  /* ================================================================== mount */

  /**
   * Mount the Progress page.
   * @param {HTMLElement} container
   * @param {{storage?: object}} [opts]
   * @returns {{destroy: function, refresh: function, el: HTMLElement}}
   */
  function mount(container, opts) {
    opts = opts || {};
    var h = ui.h;
    var store = opts.storage || VL.storage || null;
    var cleanups = [];
    var chart = null;          // { canvas, list, first }
    var filter = 'all';
    try { filter = (store && store.get('progress:filter', 'all')) || 'all'; } catch (e) { filter = 'all'; }
    if (['all', 'papers', 'drills'].indexOf(filter) < 0) filter = 'all';

    var root = h('div', { class: 'vp-root' });
    container.appendChild(root);
    var status = h('p', { class: 'vp-sr', role: 'status', 'aria-live': 'polite' });

    function entries() {
      try { return store && typeof store.getProgress === 'function' ? (store.getProgress() || []) : []; } catch (e) { return []; }
    }

    function filtered(all) {
      if (filter === 'drills') return all.filter(function (e) { return e.mode === 'drill'; });
      if (filter === 'papers') return all.filter(function (e) { return e.mode !== 'drill'; });
      return all;
    }

    /** Column header; numeric columns are right-aligned like their values. */
    function headCell(t) {
      return h('th', { scope: 'col', class: /^(Attempts|Best score|Total|MMO|PDO|ACE)$/.test(t) ? 'vp-num' : null }, t);
    }

    function card(title, value, detail, extraClass) {
      return h('section', { class: 'vp-card' + (extraClass ? ' ' + extraClass : '') },
        h('h2', { class: 'vp-card-title' }, title),
        h('p', { class: 'vp-card-value' }, value),
        detail ? (typeof detail === 'string' ? h('p', { class: 'vp-card-detail' }, detail) : detail) : null);
    }

    function filterBar() {
      var name = 'vp-filter-' + (mount.counter = (mount.counter || 0) + 1);
      var fs = h('fieldset', { class: 'vp-filter' }, h('legend', { class: 'vp-filter-legend' }, 'Show'));
      [['all', 'All attempts'], ['papers', 'Exams and practice'], ['drills', 'Skill drills']].forEach(function (o) {
        var id = name + '-' + o[0];
        var r = h('input', { type: 'radio', name: name, id: id, value: o[0], class: 'vp-radio-input' });
        r.checked = filter === o[0];
        r.addEventListener('change', function () {
          if (!r.checked) return;
          filter = o[0];
          try { if (store) store.set('progress:filter', filter); } catch (e) { /* ignore */ }
          render();
          var again = root.querySelector('#' + id);
          if (again) again.focus();
        });
        fs.appendChild(h('label', { class: 'vp-radio', for: id }, r, h('span', null, o[1])));
      });
      return fs;
    }

    function emptyState() {
      return h('div', { class: 'vp-empty' },
        h('p', { class: 'vp-empty-title' }, 'No marked work yet.'),
        h('p', null, 'Complete a practice question, an exam or a skill drill. Each time your work is marked, your MMO, PDO and ACE marks are recorded here so that you can see how you are improving.'),
        h('p', { class: 'vp-actions' },
          h('a', { class: 'vp-btn vp-btn--primary', href: '#/practice' }, 'Start a practice'),
          h('a', { class: 'vp-btn', href: '#/drills' }, 'Try a skill drill'),
          h('a', { class: 'vp-btn', href: '#/exam' }, 'Sit an exam')));
    }

    function summaryCards(list) {
      var s = summarize(list);
      var weakest;
      if (s.weakest) {
        var sk = SKILLS.filter(function (x) { return x.id === s.weakest.skill; })[0];
        weakest = card('Weakest skill (last ' + Math.min(WEAKEST_WINDOW, s.attempts) + ')',
          h('span', null, h('abbr', { title: sk.name }, sk.id), ' · ' + fmtPct(s.weakest.pct)),
          h('div', { class: 'vp-card-detail' },
            h('p', null, sk.name + ': ' + s.weakest.got + ' / ' + s.weakest.max + ' marks.'),
            h('p', null, h('strong', null, 'Tip: '), sk.tip),
            h('ul', { class: 'vp-skill-list', 'aria-label': 'Skills over the last ' + Math.min(WEAKEST_WINDOW, s.attempts) + ' attempts' },
              SKILLS.map(function (x) {
                var r = s.recent[x.id];
                return h('li', { class: x.id === s.weakest.skill ? 'vp-skill-weak' : null },
                  h('abbr', { title: x.name }, x.id), ': ' + (r.pct === null ? 'not assessed' : fmtPct(r.pct) + ' (' + r.got + ' / ' + r.max + ')') +
                  (x.id === s.weakest.skill ? ' — weakest' : ''));
              }))), 'vp-card--weak');
      } else {
        weakest = card('Weakest skill', '—', 'Not enough marked work yet.');
      }
      return h('div', { class: 'vp-cards' },
        card('Attempts', String(s.attempts),
          s.exams + ' exam or practice ' + (s.exams === 1 ? 'question' : 'questions') + ', ' + s.drills + ' ' + (s.drills === 1 ? 'drill' : 'drills') + '.'),
        card('Average mark', fmtPct(s.averagePct), 'Mean of your percentage marks over these attempts.'),
        weakest);
    }

    function chartSection(list) {
      var sorted = sortByDate(list);
      var first = Math.max(0, sorted.length - MAX_CHART);
      var shown = sorted.slice(first);
      var latest = shown[shown.length - 1];
      var desc = 'Line chart of your MMO, PDO and ACE percentage marks for attempts ' + (first + 1) + ' to ' + sorted.length + '. ' +
        'Latest attempt: ' + SKILLS.map(function (s) { return s.id + ' ' + fmtPct(skillPercent(latest, s.id)).replace('—', 'not assessed'); }).join(', ') +
        '. The same data is in the table below the chart.';
      var canvas = h('canvas', { class: 'vp-canvas', role: 'img', 'aria-label': desc });
      var wrap = h('div', { class: 'vp-chart-wrap' }, canvas);
      var legend = h('ul', { class: 'vp-legend', 'aria-label': 'Key' }, SKILLS.map(function (s) {
        return h('li', { class: 'vp-legend-item' }, legendKey(s),
          h('span', null, h('strong', null, s.id), ' — ' + s.name + ' (' + s.lineName + ', ' + s.shapeName + ')'));
      }));
      var table = h('table', { class: 'vp-table' },
        h('caption', null, 'Percentage mark for each skill, attempt by attempt'),
        h('thead', null, h('tr', null, ['Attempt', 'Date', 'Activity', 'MMO', 'PDO', 'ACE'].map(headCell))),
        h('tbody', null, shown.map(function (e, i) {
          return h('tr', null,
            h('th', { scope: 'row' }, String(first + i + 1)),
            h('td', null, fmtDate(e.date)),
            h('td', null, activityLabel(e.expId, e.variantId)),
            SKILLS.map(function (s) { return h('td', { class: 'vp-num' }, fmtPct(skillPercent(e, s.id))); }));
        })));
      var details = h('details', { class: 'vp-data' }, h('summary', null, 'Show the chart data as a table'), h('div', { class: 'vp-scroll' }, table));
      chart = { canvas: canvas, list: shown, first: first + 1, wrap: wrap };
      return h('section', { class: 'vp-section', 'aria-labelledby': 'vp-chart-h' },
        h('h2', { id: 'vp-chart-h', class: 'vp-h2' }, 'Skills over time'),
        sorted.length > MAX_CHART ? h('p', { class: 'vp-note' }, 'Showing your last ' + MAX_CHART + ' attempts.') : null,
        legend, wrap, details);
    }

    function redrawChart() {
      if (!chart || !chart.canvas.isConnected) return;
      var w = Math.max(260, Math.floor(chart.wrap.clientWidth || 600));
      drawChart(chart.canvas, chart.list, chart.first, w);
    }

    function activitiesSection(list) {
      var groups = byActivity(list);
      return h('section', { class: 'vp-section', 'aria-labelledby': 'vp-act-h' },
        h('h2', { id: 'vp-act-h', class: 'vp-h2' }, 'Experiments and drills completed'),
        h('div', { class: 'vp-scroll' }, h('table', { class: 'vp-table' },
          h('thead', null, h('tr', null, ['Activity', 'Attempts', 'Best score', 'Last attempt', 'Seed of last attempt'].map(headCell))),
          h('tbody', null, groups.map(function (g) {
            return h('tr', null,
              h('th', { scope: 'row' }, g.label),
              h('td', { class: 'vp-num' }, String(g.attempts)),
              h('td', { class: 'vp-num' }, g.best ? g.best.total + ' / ' + g.best.max + ' (' + fmtPct(g.best.pct) + ')' : '—'),
              h('td', null, fmtDate(g.last.date, true)),
              h('td', null, g.last.seed ? h('code', { class: 'vp-seed' }, String(g.last.seed)) : '—'));
          })))));
    }

    function recentSection(list) {
      var rows = sortByDate(list).slice(-RECENT).reverse();
      return h('section', { class: 'vp-section', 'aria-labelledby': 'vp-recent-h' },
        h('h2', { id: 'vp-recent-h', class: 'vp-h2' }, 'Recent attempts'),
        h('div', { class: 'vp-scroll' }, h('table', { class: 'vp-table' },
          h('thead', null, h('tr', null, ['Date', 'Mode', 'Activity', 'Seed', 'Total', 'MMO', 'PDO', 'ACE'].map(headCell))),
          h('tbody', null, rows.map(function (e) {
            var pc = entryPercent(e);
            return h('tr', null,
              h('td', null, fmtDate(e.date, true)),
              h('td', null, modeName(e.mode)),
              h('th', { scope: 'row' }, activityLabel(e.expId, e.mode === 'drill' ? null : e.variantId)),
              h('td', null, e.seed ? h('code', { class: 'vp-seed' }, String(e.seed)) : '—'),
              h('td', { class: 'vp-num' }, num(e.total) + ' / ' + num(e.max) + (pc === null ? '' : ' (' + fmtPct(pc) + ')')),
              SKILLS.map(function (s) { return h('td', { class: 'vp-num' }, skillCell(e, s.id)); }));
          })))));
    }

    function clearButton() {
      return h('div', { class: 'vp-danger-zone' },
        h('button', { type: 'button', class: 'vp-btn vp-btn--danger', on: { click: confirmClear } }, 'Clear progress'),
        h('p', { class: 'vp-note' }, 'Removes every recorded mark from this browser. Saved sessions are not deleted.'));
    }

    function confirmClear() {
      var msg = 'All of your recorded marks will be removed from this browser. This cannot be undone. Your saved sessions are kept.';
      var p;
      if (ui.dialog && typeof ui.dialog.confirm === 'function') {
        p = ui.dialog.confirm({ title: 'Clear all progress?', message: msg, confirmLabel: 'Clear progress', danger: true });
      } else {
        p = Promise.resolve(typeof globalThis.confirm === 'function' ? globalThis.confirm('Clear all progress? ' + msg) : false);
      }
      p.then(function (ok) {
        if (!ok) return;
        var done = false;
        try { done = store ? store.clearProgress() !== false : false; } catch (e) { done = false; }
        render();
        var msgText = done ? 'Progress cleared.' : 'Progress could not be cleared (browser storage is not available).';
        status.textContent = msgText;
        if (ui.toast) ui.toast(msgText);
        var heading = root.querySelector('h1');
        if (heading) heading.focus();
      });
    }

    function render() {
      ui.clear(root);
      chart = null;
      root.appendChild(h('h1', { class: 'vp-h1', tabindex: '-1' }, 'Progress'));
      root.appendChild(status);
      var notPersistent = false;
      try { notPersistent = !!store && typeof store.available === 'function' && !store.available(); } catch (e) { notPersistent = true; }
      if (!store) {
        root.appendChild(h('p', { class: 'vp-notice' }, '⚠ Progress tracking is not available in this version of the lab.'));
        return;
      }
      if (notPersistent) {
        root.appendChild(h('p', { class: 'vp-notice', role: 'note' }, '⚠ This browser is not letting the lab save data (for example in a private window), so only marks from this visit are shown.'));
      }
      var all = entries();
      if (!all.length) {
        root.appendChild(emptyState());
        return;
      }
      root.appendChild(filterBar());
      var list = filtered(all);
      if (!list.length) {
        root.appendChild(h('p', { class: 'vp-empty-filter' }, filter === 'drills' ? 'You have not completed any skill drills yet.' : 'You have not had an exam or practice question marked yet.'));
        root.appendChild(clearButton());
        return;
      }
      root.appendChild(summaryCards(list));
      root.appendChild(chartSection(list));
      root.appendChild(activitiesSection(list));
      root.appendChild(recentSection(list));
      root.appendChild(clearButton());
      redrawChart();
    }

    render();

    // keep the chart sharp and the right width
    var raf = 0;
    function scheduleRedraw() {
      if (raf) return;
      raf = (globalThis.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { raf = 0; redrawChart(); });
    }
    if (typeof globalThis.ResizeObserver === 'function') {
      var lastW = 0;
      var ro = new globalThis.ResizeObserver(function () {
        var w = chart && chart.wrap ? chart.wrap.clientWidth : 0;
        if (w && Math.abs(w - lastW) >= 1) { lastW = w; scheduleRedraw(); }
      });
      ro.observe(root);
      cleanups.push(function () { ro.disconnect(); });
    } else {
      cleanups.push(ui.on(globalThis, 'resize', scheduleRedraw));
    }
    if (ui.bus) {
      cleanups.push(ui.bus.on('theme:changed', function () { render(); }));
      cleanups.push(ui.bus.on('progress:changed', function () { render(); }));
    }
    if (typeof globalThis.MutationObserver === 'function') {
      var mo = new globalThis.MutationObserver(function () { scheduleRedraw(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      cleanups.push(function () { mo.disconnect(); });
    }
    // another tab recorded or cleared progress
    cleanups.push(ui.on(globalThis, 'storage', function (ev) {
      if (!ev || !ev.key || /^vlab1:progress/.test(ev.key)) render();
    }));

    return {
      el: root,
      refresh: render,
      destroy: function () {
        cleanups.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
        cleanups = [];
        if (raf && globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(raf);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  ui.progressView = {
    mount: mount,
    summarize: summarize,
    byActivity: byActivity,
    activityLabel: activityLabel,
    entryPercent: entryPercent,
    skillPercent: skillPercent,
    SKILLS: SKILLS
  };
})(globalThis.VLab = globalThis.VLab || {});
