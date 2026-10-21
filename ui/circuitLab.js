/**
 * Circuit lab page (#/circuits): build any circuit from 9702 electricity components, read the meters yourself,
 * record readings in your own table and plot your own graph. Not marked — it is a practice bench.
 *
 *   VL.ui.circuitLab.mount(container, { headerCtx, headerBar, toast }) -> { destroy() }
 *
 * Left: the circuit bench (VL.ui.circuitBench inside VL.ui.apparatusView, so zoom, eye level, stopwatch and the
 * reading pad work exactly as in the experiments). Right: tabs Circuit (set-ups, diagram, check), Table, Graph,
 * Tools. Everything is saved in localStorage under 'circuitlab'.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};
  var STORE_KEY = 'circuitlab';
  var FREE = 'free';

  function store() { return VL.storage || { get: function (k, d) { return d; }, set: function () {} }; }

  function freshState(templateId, seed) {
    seed = seed || (VL.rng ? VL.rng.newSeed('CIR') : 'CIR-0000-0000');
    var tpl = templateId && templateId !== FREE && VL.circuitTemplates ? VL.circuitTemplates.get(templateId) : null;
    var circuit = tpl ? VL.circuitTemplates.build(tpl, seed).circuit : VL.circuit.create(seed);
    return {
      version: 1, templateId: tpl ? tpl.id : FREE, seed: seed, circuit: circuit,
      table: VL.datatable ? VL.datatable.create({ columns: 3, rows: 8 }) : { columns: [], rows: [], nextId: 1 },
      graph: VL.graph ? VL.graph.create() : null,
      question: { seed: seed, startedAt: new Date().toISOString(), log: [] }
    };
  }

  function loadState() {
    var s = store().get(STORE_KEY, null);
    if (!s || !s.circuit || !Array.isArray(s.circuit.parts)) return null;
    s.question = s.question || { seed: s.seed, startedAt: new Date().toISOString(), log: [] };
    s.question.log = [];             // the lab is not marked: do not keep a growing log
    return s;
  }

  function mount(container, env) {
    env = env || {};
    var h = ui.h;
    var toast = env.toast || ui.toast || function () {};
    var state = loadState() || freshState(FREE);
    var destroyed = false;
    var app = null, bench = null, views = {}, target = null, tab = 'circuit';
    var saveTimer = null;

    document.body.classList.add('vl-body--ws');

    /* ---------------------------------------------------------- layout */

    var left = h('section', { class: 'vl-ws-left', 'aria-label': 'Circuit bench' });
    var tablist = h('div', { class: 'vl-tabs', role: 'tablist', 'aria-label': 'Circuit lab' });
    var panels = h('div', { class: 'vl-tabpanels' });
    var right = h('section', { class: 'vl-ws-right', 'aria-label': 'Circuit, table, graph and tools' }, tablist, panels);
    var root = h('div', { class: 'vl-ws vl-circuitlab', dataset: { show: 'apparatus' } }, h('div', { class: 'vl-ws-main' }, left, right));
    container.appendChild(root);

    var saveEl = h('span', { class: 'vl-save', role: 'status' }, '');
    root.insertBefore(h('h1', { class: 'vl-sr-only' }, 'Circuit lab'), root.firstChild);
    if (env.headerCtx) env.headerCtx.appendChild(h('span', { class: 'vl-ws-title vc-title' }, 'Circuit lab'));
    var narrow = h('div', { class: 'vl-narrow-toggle', role: 'group', 'aria-label': 'Show' },
      h('button', { type: 'button', class: 'vl-btn', dataset: { show: 'apparatus' }, 'aria-pressed': 'true', on: { click: function () { showSide('apparatus'); } } }, 'Bench'),
      h('button', { type: 'button', class: 'vl-btn', dataset: { show: 'panel' }, 'aria-pressed': 'false', on: { click: function () { showSide('panel'); } } }, 'Panel'));
    var seedEl = h('code', { class: 'vl-seed-code' }, state.seed);
    if (env.headerBar) {
      env.headerBar.appendChild(h('div', { class: 'vl-ws-seed' }, h('span', { class: 'vl-ws-seed-label' }, 'Seed '), seedEl));
      env.headerBar.appendChild(saveEl);
      env.headerBar.appendChild(narrow);
    } else {
      root.insertBefore(h('div', { class: 'vc-topbar' }, 'Seed ', seedEl, ' ', saveEl, narrow), root.firstChild);
    }
    function showSide(which) {
      root.dataset.show = which;
      Array.prototype.forEach.call(narrow.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', b.dataset.show === which ? 'true' : 'false');
      });
    }

    /* ---------------------------------------------------------- saving */

    function save() {
      if (destroyed) return;
      if (app) { try { app.saveState(); } catch (e) { /* ignore */ } }
      var ok = store().set(STORE_KEY, state);
      saveEl.textContent = ok === false ? '⚠ Not saved' : '✓ Saved';
      saveEl.className = 'vl-save ' + (ok === false ? 'vl-save--error' : 'vl-save--saved');
    }
    function markDirty() {
      saveEl.textContent = 'Saving…';
      saveEl.className = 'vl-save vl-save--pending';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 800);
    }

    /* ---------------------------------------------------------- bench */

    var pseudoExp = {
      id: 'circuitlab', title: 'Circuit lab',
      sampleParams: function () { return {}; },
      createApparatus: function (ctx) {
        bench = ui.circuitBench.createController(ctx, {
          circuit: state.circuit,
          onChange: function () { markDirty(); refreshCheck(false); },
          onWarnings: function () { /* shown on the bench and in the controls */ }
        });
        return bench;
      }
    };

    function mountBench() {
      if (app) { try { app.destroy(); } catch (e) { console.error(e); } app = null; bench = null; }
      ui.clear(left);
      if (!ui.apparatusView || !ui.circuitBench) {
        left.appendChild(h('p', { class: 'vl-error' }, 'The circuit bench is not available.'));
        return;
      }
      app = ui.apparatusView.mount(left, {
        exp: pseudoExp, question: state.question,
        services: { mode: 'practice', hints: true, toast: function (m) { toast(m); } },
        readOnlyText: '',
        onRecord: recordTo,
        onChange: function () { markDirty(); }
      });
      if (app) app.setTargetLabel(target ? target.label : null);
    }

    function recordTo(str, o) {
      if (!target) return null;
      if (!(o && o.confirmed) && typeof target.current === 'function') {
        var old = '';
        try { old = String(target.current() || ''); } catch (e) { old = ''; }
        if (old.trim() && old.trim() !== String(str).trim()) return { needsConfirm: true, old: old, label: target.label };
      }
      var ok = false;
      try { ok = target.write(str); } catch (e) { ok = false; }
      if (ok === false) { setTarget(null); return null; }
      markDirty();
      return { label: target.label };
    }
    function setTarget(t) {
      target = t && typeof t.write === 'function' ? t : null;
      if (app) app.setTargetLabel(target ? target.label : null);
    }

    /* ---------------------------------------------------------- tabs */

    var TABS = [
      { id: 'circuit', label: 'Circuit' },
      { id: 'table', label: 'Table' },
      { id: 'graph', label: 'Graph' },
      { id: 'tools', label: 'Tools' }
    ];
    var tabBtns = {}, tabPanels = {};
    TABS.forEach(function (t) {
      var tid = 'vc-tab-' + t.id, pid = 'vc-panel-' + t.id;
      tabBtns[t.id] = h('button', { type: 'button', role: 'tab', id: tid, class: 'vl-tab', 'aria-selected': 'false', 'aria-controls': pid, tabindex: '-1',
        on: { click: function () { activate(t.id); } } }, t.label);
      tabPanels[t.id] = h('div', { role: 'tabpanel', id: pid, class: 'vl-tabpanel vl-tabpanel--' + t.id, 'aria-labelledby': tid, hidden: true, tabindex: '-1' });
      tablist.appendChild(tabBtns[t.id]);
      panels.appendChild(tabPanels[t.id]);
    });
    tablist.addEventListener('keydown', function (ev) {
      var ids = TABS.map(function (t) { return t.id; }), i = ids.indexOf(tab), next = null;
      if (ev.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
      else if (ev.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
      if (next) { ev.preventDefault(); activate(next); tabBtns[next].focus(); }
    });

    function activate(id) {
      tab = id;
      TABS.forEach(function (t) {
        var on = t.id === id;
        tabBtns[t.id].setAttribute('aria-selected', on ? 'true' : 'false');
        tabBtns[t.id].setAttribute('tabindex', on ? '0' : '-1');
        tabPanels[t.id].hidden = !on;
      });
      if (target && target.tab && target.tab !== id) setTarget(null);
      if (!views[id]) mountTab(id);
      else if (id === 'graph' && views.graph && views.graph.refresh) views.graph.refresh(state.graph, state.table);
      if (id === 'circuit') drawDiagram();
    }

    function mountTab(id) {
      var panel = tabPanels[id];
      try {
        if (id === 'circuit') { views.circuit = buildCircuitTab(panel); return; }
        if (id === 'table') {
          if (!ui.tableView) { panel.appendChild(h('p', {}, 'The table is not available.')); return; }
          panel.appendChild(h('p', { class: 'vl-ctl-note' }, 'Make your own table: write each heading as quantity / unit, e.g. I / A. Click a cell, read the meter, type the reading in the reading pad and press Record.'));
          views.table = ui.tableView.mount(panel, state.table, {
            hints: true,
            onChange: function (t) { state.table = t || state.table; markDirty(); },
            onFocusCell: function (t) { if (t) t.tab = 'table'; setTarget(t); }
          });
          return;
        }
        if (id === 'graph') {
          if (!ui.graphView || !state.graph) { panel.appendChild(h('p', {}, 'The graph is not available.')); return; }
          views.graph = ui.graphView.mount(panel, state.graph, state.table, {
            hints: true, extension: true,
            onChange: function (gr) { state.graph = gr || state.graph; markDirty(); }
          });
          return;
        }
        if (id === 'tools') {
          if (ui.uncertaintyView) views.tools = ui.uncertaintyView.mount(panel, { graph: state.graph, table: state.table, extension: true, mode: 'practice' });
          else if (ui.calculator) views.tools = ui.calculator.mount(panel);
        }
      } catch (e) {
        console.error('[circuitLab tab ' + id + ']', e);
        panel.appendChild(h('p', { class: 'vl-error' }, 'This tab could not be shown: ' + e.message));
      }
    }

    /* ---------------------------------------------------------- Circuit tab */

    var diagramCanvas = null, checkBox = null, tplBox = null;

    function buildCircuitTab(panel) {
      var list = VL.circuitTemplates ? VL.circuitTemplates.list : [];
      var sel = h('select', { id: 'vc-template', class: 'vc-template-select' },
        h('option', { value: FREE, selected: state.templateId === FREE }, 'Free build — empty bench'),
        list.map(function (t) {
          return h('option', { value: t.id, selected: t.id === state.templateId }, t.title + (t.level === 'A Level' ? ' (A Level)' : ''));
        }));
      var setOut = h('button', { type: 'button', class: 'vl-btn vl-btn--primary', on: { click: function () { startTemplate(sel.value, false); } } }, 'Set out this bench');
      var newSeed = h('button', { type: 'button', class: 'vl-btn', title: 'Same components, different hidden values', on: { click: function () { startTemplate(sel.value, true); } } }, 'New hidden values');
      panel.appendChild(h('div', { class: 'vc-chooser' },
        h('label', { for: 'vc-template' }, 'Set-up '), sel, setOut, newSeed));
      panel.appendChild(h('p', { class: 'vl-ctl-note' },
        'Choosing a set-up puts its components on the bench, unconnected. You wire the circuit yourself from the diagram. ',
        'In free build, add any components from the component box under the bench.'));
      tplBox = h('div', { class: 'vc-template' });
      panel.appendChild(tplBox);
      renderTemplate();
      return { destroy: function () {} };
    }

    function currentTemplate() {
      return state.templateId !== FREE && VL.circuitTemplates ? VL.circuitTemplates.get(state.templateId) : null;
    }

    function renderTemplate() {
      if (!tplBox) return;
      ui.clear(tplBox);
      var tpl = currentTemplate();
      if (!tpl) {
        tplBox.appendChild(h('h2', { class: 'vc-h2' }, 'Free build'));
        tplBox.appendChild(h('p', {}, 'Build any circuit you like. Every component behaves like the real thing: cells have internal resistance, meters have resistance of their own, lamps heat up, fuses blow and cells get hot if you short-circuit them.'));
        tplBox.appendChild(h('h3', { class: 'vc-h3' }, 'Circuit symbols'));
        var key = h('ul', { class: 'vc-symbol-key' });
        var seen = {};
        Object.keys(VL.circuit.types).forEach(function (type) {
          var t = VL.circuit.types[type];
          var sym = t.symbol === 'dmm' ? 'voltmeter' : t.symbol;
          if (seen[sym]) return;
          seen[sym] = true;
          var li = h('li', {});
          if (ui.circuitSymbols) li.appendChild(ui.circuitSymbols.icon(sym, 54, inkColour()));
          li.appendChild(h('span', {}, symbolName(sym)));
          key.appendChild(li);
        });
        tplBox.appendChild(key);
        diagramCanvas = null;
        checkBox = null;
        return;
      }
      tplBox.appendChild(h('h2', { class: 'vc-h2' }, tpl.title));
      tplBox.appendChild(h('p', { class: 'vc-aim' }, h('strong', {}, 'Aim: '), tpl.aim));
      diagramCanvas = h('canvas', { class: 'vc-diagram', role: 'img', 'aria-label': 'Circuit diagram for ' + tpl.title });
      tplBox.appendChild(h('figure', { class: 'vc-figure' }, diagramCanvas, h('figcaption', {}, 'Fig. 1 — the circuit to build')));
      tplBox.appendChild(h('h3', { class: 'vc-h3' }, 'Carry out the following steps.'));
      tplBox.appendChild(h('ol', { class: 'vc-steps' }, tpl.steps.map(function (s) { return h('li', {}, s); })));
      var actions = h('div', { class: 'vc-actions' },
        h('button', { type: 'button', class: 'vl-btn vl-btn--primary', on: { click: function () { refreshCheck(true); } } }, 'Check my circuit'),
        h('button', { type: 'button', class: 'vl-btn', on: { click: wireForMe } }, 'Wire it for me'));
      tplBox.appendChild(actions);
      checkBox = h('div', { class: 'vc-check', role: 'status', 'aria-live': 'polite' });
      tplBox.appendChild(checkBox);
      tplBox.appendChild(h('h3', { class: 'vc-h3' }, 'What to do with your readings'));
      tplBox.appendChild(h('ul', {}, tpl.investigate.map(function (s) { return h('li', {}, s); })));
      drawDiagram();
    }

    function symbolName(sym) {
      return ({
        cell: 'cell', battery: 'battery of cells', dcsupply: 'd.c. power supply', switch: 'switch', resistor: 'fixed resistor',
        rheostat: 'variable resistor', pot: 'potential divider / potentiometer', wire: 'resistance wire with jockey',
        ammeter: 'ammeter', voltmeter: 'voltmeter', lamp: 'filament lamp', diode: 'diode', led: 'light-emitting diode (LED)',
        thermistor: 'thermistor', ldr: 'light-dependent resistor (LDR)', capacitor: 'capacitor'
      })[sym] || sym;
    }

    function inkColour() {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--ink');
      return (v && v.trim()) || '#111';
    }

    function drawDiagram() {
      var tpl = currentTemplate();
      if (!tpl || !diagramCanvas || !ui.circuitSymbols || tab !== 'circuit') return;
      var w = Math.max(240, Math.min(560, (diagramCanvas.parentNode && diagramCanvas.parentNode.clientWidth) || 420));
      var hgt = Math.round(w * (tpl.diagram.h + 1.6) / (tpl.diagram.w + 1.6));
      var g = ui.fitCanvas(diagramCanvas, w, hgt);
      g.clearRect(0, 0, w, hgt);
      ui.circuitSymbols.drawDiagram(g, tpl.diagram, { x: 0, y: 0, w: w, h: hgt }, { ink: inkColour() });
    }

    function refreshCheck(explicit) {
      var tpl = currentTemplate();
      if (!tpl || !checkBox) return;
      if (!explicit && !checkBox.dataset.shown) return;
      checkBox.dataset.shown = '1';
      ui.clear(checkBox);
      var m = VL.circuit.matchTemplate(state.circuit, tpl.match);
      if (m.ok) {
        checkBox.className = 'vc-check vc-check--ok';
        checkBox.appendChild(h('p', {}, h('strong', {}, '✓ Your circuit matches the diagram. '), 'Close the switch and take your readings.'));
      } else {
        checkBox.className = 'vc-check vc-check--bad';
        checkBox.appendChild(h('p', {}, h('strong', {}, '✗ Not yet. ')));
        checkBox.appendChild(h('ul', {}, m.problems.map(function (p) { return h('li', {}, p); })));
      }
    }

    function wireForMe() {
      var tpl = currentTemplate();
      if (!tpl) return;
      var go = function () {
        var refs = {};
        state.circuit.parts.forEach(function (p) { if (p.ref) refs[p.ref] = p; });
        var missing = tpl.kit.filter(function (k) { return !refs[k.ref]; });
        if (missing.length) { toast('Some components of this set-up are no longer on the bench. Set out the bench again first.', 'warn'); return; }
        state.circuit.wires.length = 0;
        var colours = ['red', 'black', 'blue', 'yellow', 'green'];
        tpl.solution.forEach(function (pair, i) {
          var a = pair[0].split(':'), b = pair[1].split(':');
          var pa = refs[a[0]], pb = refs[b[0]];
          VL.circuit.addWire(state.circuit, { part: pa.id, term: VL.circuitTemplates.termFor(pa, a[1]) },
            { part: pb.id, term: VL.circuitTemplates.termFor(pb, b[1]) }, colours[i % colours.length]);
        });
        if (bench) bench.resolve();
        markDirty();
        refreshCheck(true);
      };
      if (ui.dialog && ui.dialog.confirm) {
        ui.dialog.confirm({ title: 'Wire it for you?', message: 'This replaces your leads with the circuit from the diagram. Try wiring it yourself first — it is an important practical skill.', confirmLabel: 'Wire it', cancelLabel: 'Cancel' })
          .then(function (ok) { if (ok) go(); });
      } else if (globalThis.confirm('Replace your leads with the circuit from the diagram?')) go();
    }

    function startTemplate(id, newSeed) {
      var go = function () {
        var seed = newSeed || id !== state.templateId ? null : state.seed;
        var keepTable = state.table, keepGraph = state.graph;
        state = freshState(id, seed || undefined);
        state.table = keepTable; state.graph = keepGraph;
        seedEl.textContent = state.seed;
        mountBench();
        renderTemplate();
        save();
        if (root.dataset.show === 'panel') showSide('apparatus');
      };
      var busy = state.circuit.parts.length > 0;
      if (!busy) { go(); return; }
      var msg = 'This clears the bench (your table and graph are kept).';
      if (ui.dialog && ui.dialog.confirm) {
        ui.dialog.confirm({ title: 'Set out a new bench?', message: msg, confirmLabel: 'Clear and set out', cancelLabel: 'Cancel' })
          .then(function (ok) { if (ok) go(); });
      } else if (globalThis.confirm(msg)) go();
    }

    /* ---------------------------------------------------------- start */

    mountBench();
    activate('circuit');
    var onResize = ui.debounce ? ui.debounce(drawDiagram, 150) : drawDiagram;
    globalThis.addEventListener('resize', onResize);
    var onTheme = ui.bus ? ui.bus.on('theme:changed', function () { drawDiagram(); }) : null;
    function onHide() { if (document.hidden) save(); }
    document.addEventListener('visibilitychange', onHide);
    globalThis.addEventListener('pagehide', save);

    var api = {
      el: root,
      destroy: function () {
        save();
        destroyed = true;
        clearTimeout(saveTimer);
        globalThis.removeEventListener('resize', onResize);
        globalThis.removeEventListener('pagehide', save);
        document.removeEventListener('visibilitychange', onHide);
        if (onTheme) onTheme();
        Object.keys(views).forEach(function (k) { if (views[k] && views[k].destroy) { try { views[k].destroy(); } catch (e) { /* ignore */ } } });
        if (app) { try { app.destroy(); } catch (e) { /* ignore */ } }
        document.body.classList.remove('vl-body--ws');
        if (VL._circuitLabPage === api) VL._circuitLabPage = null;
      },
      // test hooks
      state: function () { return state; },
      bench: function () { return bench; },
      apparatus: function () { return app; }
    };
    VL._circuitLabPage = api;          // test hook
    return api;
  }

  ui.circuitLab = { mount: mount };
})(globalThis.VLab = globalThis.VLab || {});
