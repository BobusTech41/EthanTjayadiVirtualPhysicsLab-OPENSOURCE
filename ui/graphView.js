/**
 * Graph paper (browser only). docs/ARCHITECTURE.md §9.
 *
 *   VL.ui.graphView.mount(container, graph, table, { readOnly, hints, extension, onChange(graph), dpr? })
 *     -> { destroy(), canvas, undo(), redo(), refresh(graph?, table?), renderClean() -> canvas, el }
 *   dpr: device pixels per css px for the canvas (default: the screen's), e.g. 2 for a print-quality export.
 *
 * Exam-style graph paper drawn on a canvas (large squares var(--grid-major), small squares var(--grid-minor)).
 * The student chooses the columns, axis labels and scales, plots every cross by hand, draws the line with a
 * ruler, circles anomalies, draws a gradient triangle and types the read-offs, and finds the intercept.
 * The cursor position is NEVER shown in value units: the student must read the scales, exactly as on paper.
 *
 * Keyboard (canvas focused): arrow keys nudge the selected cross / ruler end / triangle corner by 0.1 small
 * square (Shift: 1 small square, Ctrl/Cmd: 1 large square) or move the placing cross-hair; Enter or Space
 * places / toggles; N / Shift+N selects the next / previous item; Delete removes; Escape cancels;
 * M toggles the magnifier; Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo.
 *
 * Bus: emits 'graph:plotRow' ({ rowId }) with the row being plotted (so the table can highlight it);
 * listens to 'table:changed' to refresh column choices and the plotting list.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var LOUPE_R = 64;          // css px
  var LOUPE_ZOOM = 4;
  var WARN_ICON = '⚠';

  var MODES = [
    { id: 'plot', glyph: '×', label: 'Plot', title: 'Plot crosses for the rows of your table' },
    { id: 'line', glyph: '╱', label: 'Line', title: 'Draw the line of best fit with a ruler' },
    { id: 'anomaly', glyph: '○', label: 'Anomaly', title: 'Circle (or uncircle) an anomalous point' },
    { id: 'gradient', glyph: '◺', label: 'Gradient', title: 'Draw a gradient triangle and type your read-offs' },
    { id: 'intercept', glyph: '⊥', label: 'Intercept', title: 'Find the y-intercept' },
    { id: 'erase', glyph: '⌫', label: 'Erase', title: 'Rub out a cross, the line or the triangle' },
    { id: 'worst', glyph: '╲', label: 'Worst line', title: 'Extension: worst acceptable line', extension: true }
  ];

  var SUB = { x1: 'x₁', y1: 'y₁', x2: 'x₂', y2: 'y₂' };

  /** Both axis columns chosen and both scales usable (origin a number, a positive value per large square). */
  function axesReady(graph) {
    return ['x', 'y'].every(function (a) {
      var ax = graph && graph[a];
      return !!(ax && ax.colId && isFinite(ax.origin) && isFinite(ax.perLarge) && ax.perLarge > 0);
    });
  }

  /**
   * Mount a graph view.
   * @param {HTMLElement} container
   * @param {object} graph VL.graph Graph (mutated in place)
   * @param {object} table the student's VL.datatable Table (read only here)
   * @param {{readOnly?: boolean, hints?: boolean, extension?: boolean, onChange?: function(object)}} [opts]
   */
  function mount(container, graph, table, opts) {
    opts = opts || {};
    var h = ui.h;
    var GR = VL.graph;
    var readOnly = !!opts.readOnly;
    var hintsOn = !!opts.hints && !readOnly;
    var extension = !!opts.extension;
    // device pixels per css px: opts.dpr fixes it (e.g. 2 for a print-quality export), else the screen's
    var fixedDpr = typeof opts.dpr === 'number' && opts.dpr > 0 ? opts.dpr : 0;

    var S = {
      graph: graph,
      table: table,
      hist: GR.history(graph),
      mode: readOnly ? null : 'plot',
      plotRowId: null,
      plotExplicit: false,      // true when the student picked the row to plot from the list
      sel: null,              // {type:'point', id} | {type:'handle', which:'line'|'worstLine', end:'a'|'b'} | {type:'vertex', end:'p1'|'p2'}
      pendingVertex: null,    // first corner of a new triangle
      cursor: null,           // keyboard cross-hair {gx, gy}
      kbd: false,
      focused: false,
      drag: null,
      hover: null,            // {x, y} css px
      touch: null,            // finger position during a touch drag
      loupe: false,
      zoom: 1,
      L: null,
      lastWidth: 0,
      raf: 0,
      nudgeTimer: 0,
      editing: false,
      scaleNote: false,
      axesOpen: !axesReady(graph),   // open until both columns and scales are set; after that the student decides
      hintsOpen: true,
      lastPlotEmit: undefined
    };

    var idBase = 'vg' + (mount.counter = (mount.counter || 0) + 1);

    /* ================================================================ DOM skeleton */

    var root = h('div', { class: 'vg-root' + (readOnly ? ' vg-root--readonly' : '') });
    var toolbar = h('div', { class: 'vg-toolbar', role: 'toolbar', 'aria-label': 'Graph tools' });
    var axesBox = h('div', { class: 'vg-axes-wrap' });
    var panel = h('div', { class: 'vg-panel', id: idBase + '-panel' });
    var statusEl = h('p', { class: 'vg-status', role: 'status', 'aria-live': 'polite' });
    var wrap = h('div', { class: 'vg-canvas-wrap' });
    var canvas = h('canvas', {
      class: 'vg-canvas', tabindex: '0',
      role: readOnly ? 'img' : 'application',
      'aria-roledescription': 'graph paper',
      'aria-label': readOnly ? 'Model answer graph' : 'Graph paper. Use the tools above; instructions follow.',
      'aria-describedby': idBase + '-panel'
    });
    var hintsBox = h('div', { class: 'vg-hints-wrap' });
    var buttons = {};
    var modeButtons = {};

    wrap.appendChild(canvas);

    function tbtn(key, content, title, onClick, cls) {
      var b = h('button', { type: 'button', class: 'vg-btn' + (cls ? ' ' + cls : ''), title: title, on: { click: onClick } }, content);
      buttons[key] = b;
      return b;
    }

    if (!readOnly) {
      var modeGroup = h('div', { class: 'vg-group vg-modes', role: 'group', 'aria-label': 'Drawing tool' });
      MODES.forEach(function (m) {
        if (m.extension && !extension) return;
        var b = h('button', {
          type: 'button', class: 'vg-btn vg-mode' + (m.extension ? ' vg-mode--ext' : ''), title: m.title,
          'aria-pressed': 'false', dataset: { mode: m.id },
          on: { click: function () { setMode(m.id); } }
        }, h('span', { class: 'vg-glyph', 'aria-hidden': 'true' }, m.glyph), ' ', m.label,
        m.extension ? h('span', { class: 'vg-ext-tag' }, 'extension') : null);
        modeButtons[m.id] = b;
        modeGroup.appendChild(b);
      });
      toolbar.appendChild(modeGroup);
    }
    var viewGroup = h('div', { class: 'vg-group', role: 'group', 'aria-label': 'View' },
      tbtn('loupe', [h('span', { class: 'vg-glyph', 'aria-hidden': 'true' }, '⌕'), ' Magnifier (M)'],
        'Show a magnifying loupe under the pointer (key M)', function () { toggleLoupe(); }));
    buttons.loupe.setAttribute('aria-pressed', 'false');
    var zoomSel = h('select', { class: 'vg-select', 'aria-label': 'Paper size',
      on: { change: function () { S.zoom = Number(zoomSel.value) || 1; S.lastWidth = 0; scheduleDraw(); } } },
    h('option', { value: '1' }, 'Fit width'), h('option', { value: '1.5' }, '150 %'), h('option', { value: '2' }, '200 %'));
    viewGroup.appendChild(h('label', { class: 'vg-inline' }, h('span', { class: 'vg-inline-label' }, 'Paper size'), zoomSel));
    toolbar.appendChild(viewGroup);
    if (!readOnly) {
      toolbar.appendChild(h('div', { class: 'vg-group', role: 'group', 'aria-label': 'History' },
        tbtn('undo', '↶ Undo', 'Undo (Ctrl+Z)', function () { api.undo(); }),
        tbtn('redo', '↷ Redo', 'Redo (Ctrl+Shift+Z or Ctrl+Y)', function () { api.redo(); })));
    }
    if (canExport()) {
      toolbar.appendChild(h('div', { class: 'vg-group', role: 'group', 'aria-label': 'Export' },
        tbtn('png', 'Export PNG', 'Download the graph as a PNG image', exportPNG)));
    }

    root.appendChild(toolbar);
    root.appendChild(axesBox);
    if (!readOnly) root.appendChild(panel);
    root.appendChild(wrap);
    root.appendChild(statusEl);
    if (hintsOn) root.appendChild(hintsBox);
    container.appendChild(root);

    /* ================================================================ small helpers */

    function canExport() {
      return !!(VL.export && typeof VL.export.downloadCanvasPNG === 'function');
    }

    function say(msg) { statusEl.textContent = msg || ''; }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function nx() { return S.graph.grid.cols * S.graph.grid.small; }
    function ny() { return S.graph.grid.rows * S.graph.grid.small; }
    function clampG(p) { return { gx: clamp(p.gx, 0, nx()), gy: clamp(p.gy, 0, ny()) }; }
    function onGrid(p) { return p.gx >= 0 && p.gx <= nx() && p.gy >= 0 && p.gy <= ny(); }

    /**
     * Where a ruler end dragged towards pointer position p (grid units, may be off the grid) goes, keeping the
     * direction from the fixed end: inside the grid it is p itself; outside, the point where the segment from the
     * fixed end towards p leaves the grid. Clamping x and y separately would change the slope the student drew.
     * @returns {{gx: number, gy: number}|null} null: the fixed end is on the edge and p points outwards (no move)
     */
    function clipAlong(fixed, p) {
      if (onGrid(p)) return { gx: p.gx, gy: p.gy };
      var f = clampG(fixed);
      var dx = p.gx - f.gx, dy = p.gy - f.gy;
      var t = 1;
      if (dx > 0) t = Math.min(t, (nx() - f.gx) / dx);
      else if (dx < 0) t = Math.min(t, (0 - f.gx) / dx);
      if (dy > 0) t = Math.min(t, (ny() - f.gy) / dy);
      else if (dy < 0) t = Math.min(t, (0 - f.gy) / dy);
      if (!(t > 1e-9)) return null;
      return clampG({ gx: f.gx + t * dx, gy: f.gy + t * dy });
    }

    function cssVar(name, fallback) {
      var v = '';
      try { v = getComputedStyle(root).getPropertyValue(name).trim(); } catch (e) { /* ignore */ }
      return v || fallback;
    }

    function colours() {
      return {
        paper: cssVar('--paper', '#fffffb'), panel: cssVar('--panel', '#ffffff'),
        major: cssVar('--grid-major', '#e07a7a'), minor: cssVar('--grid-minor', '#f3c7c7'),
        ink: cssVar('--ink', '#111418'), plot: cssVar('--plot-ink', '#0d1b4c'), muted: cssVar('--muted', '#4a5360'),
        accent: cssVar('--accent', '#0b4fb3'), accentSoft: cssVar('--accent-soft', '#dce8fb'),
        focus: cssVar('--focus', '#ffb300'), bad: cssVar('--bad', '#a3221b')
      };
    }

    function columnHeading(colId) {
      var cols = S.table && S.table.columns ? S.table.columns : [];
      for (var i = 0; i < cols.length; i++) if (cols[i].id === colId) return cols[i].heading;
      return '';
    }

    function columnName(colId) {
      var cols = S.table && S.table.columns ? S.table.columns : [];
      for (var i = 0; i < cols.length; i++) {
        if (cols[i].id === colId) return cols[i].heading.trim() || 'column ' + (i + 1);
      }
      return 'a deleted column';
    }

    function rowNumber(rowId) {
      var rows = S.table && S.table.rows ? S.table.rows : [];
      for (var i = 0; i < rows.length; i++) if (rows[i].id === rowId) return i + 1;
      return 0;
    }

    function cell(row, colId) {
      var v = row && row.cells ? row.cells[colId] : undefined;
      return v === undefined || v === null ? '' : String(v);
    }

    /** Clean 4-s.f. formatting for values computed from the student's typed numbers. */
    function fmt4(x) {
      if (!isFinite(x)) return '—';
      return GR.formatNumber(Number(x.toPrecision(4)));
    }

    function changed() {
      if (typeof opts.onChange === 'function') {
        try { opts.onChange(S.graph); } catch (e) { console.error('[graphView onChange]', e); }
      }
      updateButtons();
      renderHints();
    }

    function updateButtons() {
      if (buttons.undo) buttons.undo.disabled = !S.hist.canUndo() && !S.editing;
      if (buttons.redo) buttons.redo.disabled = !S.hist.canRedo();
      Object.keys(modeButtons).forEach(function (id) {
        var on = S.mode === id;
        modeButtons[id].setAttribute('aria-pressed', on ? 'true' : 'false');
        modeButtons[id].classList.toggle('vg-mode--on', on);
      });
      buttons.loupe.setAttribute('aria-pressed', S.loupe ? 'true' : 'false');
      buttons.loupe.classList.toggle('vg-btn--on', S.loupe);
      canvas.classList.toggle('vg-canvas--edit', !readOnly && S.mode !== 'intercept');
    }

    /* ================================================================ plotting targets */

    function plotRows() {
      return GR.plottableRows(S.graph, S.table);
    }

    /** First unplotted row, searching after `afterRowId` first (wrapping round). */
    function nextUnplotted(afterRowId) {
      var rows = plotRows();
      var start = 0;
      if (afterRowId) {
        for (var i = 0; i < rows.length; i++) if (rows[i].rowId === afterRowId) { start = i + 1; break; }
      }
      for (var k = 0; k < rows.length; k++) {
        var r = rows[(start + k) % rows.length];
        if (!GR.pointForRow(S.graph, r.rowId)) return r.rowId;
      }
      return null;
    }

    /** Keep the plotting target valid: a row the student picked stays; otherwise the next unplotted row. */
    function ensurePlotTarget() {
      var rows = plotRows();
      var ok = rows.some(function (r) { return r.rowId === S.plotRowId; });
      if (!ok || (!S.plotExplicit && GR.pointForRow(S.graph, S.plotRowId))) {
        S.plotRowId = nextUnplotted(ok ? S.plotRowId : null);
        S.plotExplicit = false;
      }
      emitPlotRow();
    }

    function emitPlotRow() {
      var id = S.mode === 'plot' ? S.plotRowId : null;
      if (id === S.lastPlotEmit) return;
      S.lastPlotEmit = id;
      if (ui.bus) ui.bus.emit('graph:plotRow', { rowId: id });
    }

    function targetRow() {
      var rows = plotRows();
      for (var i = 0; i < rows.length; i++) if (rows[i].rowId === S.plotRowId) return rows[i];
      return null;
    }

    /* ================================================================ axes panel */

    function axisValues(axisName) {
      var ax = S.graph[axisName];
      if (!ax.colId || !S.table) return [];
      return VL.datatable.columnValues(S.table, ax.colId)
        .filter(function (v) { return v.num && v.num.ok; })
        .map(function (v) { return v.num.value; });
    }

    function renderAxes() {
      ui.clear(axesBox);
      if (readOnly) {
        var sum = h('dl', { class: 'vg-axes-summary' });
        ['x', 'y'].forEach(function (a) {
          var ax = S.graph[a];
          sum.appendChild(h('dt', null, a + '-axis'));
          sum.appendChild(h('dd', null, (ax.label || '(no label)') + ' — ' + GR.formatNumber(ax.origin) +
            ' at the origin, ' + GR.formatNumber(ax.perLarge) + ' per large square'));
        });
        axesBox.appendChild(sum);
        return;
      }
      var unset = !S.graph.x.colId || !S.graph.y.colId;
      var details = h('details', { class: 'vg-axes' });
      details.open = S.axesOpen;
      details.addEventListener('toggle', function () { S.axesOpen = details.open; });
      details.appendChild(h('summary', { class: 'vg-axes-summary-line' }, 'Axes and scales',
        h('span', { class: 'vg-axes-brief' }, unset ? ' — choose what to plot' :
          ' — ' + (S.graph.y.label || columnName(S.graph.y.colId)) + ' against ' +
          (S.graph.x.label || columnName(S.graph.x.colId)))));
      var grid = h('div', { class: 'vg-axes-grid' });
      grid.appendChild(axisFieldset('y'));
      grid.appendChild(axisFieldset('x'));
      details.appendChild(grid);
      if (S.scaleNote) {
        details.appendChild(h('p', { class: 'vg-note' }, h('span', { 'aria-hidden': 'true' }, WARN_ICON + ' '),
          'Your crosses stay where you drew them. If you change a column or a scale after plotting, plot the points again.'));
      }
      axesBox.appendChild(details);
    }

    function axisFieldset(a) {
      var ax = S.graph[a];
      var fid = idBase + '-' + a;
      var fs = h('fieldset', { class: 'vg-fieldset' });
      fs.appendChild(h('legend', null, a === 'x' ? 'x-axis (across)' : 'y-axis (up)'));

      // column
      var sel = h('select', { id: fid + '-col', class: 'vg-select', dataset: { field: a + '-col' } });
      sel.appendChild(h('option', { value: '' }, '— choose a column —'));
      (S.table && S.table.columns ? S.table.columns : []).forEach(function (c, i) {
        var o = h('option', { value: c.id }, c.heading.trim() || 'Column ' + (i + 1) + ' (no heading)');
        if (c.id === ax.colId) o.selected = true;
        sel.appendChild(o);
      });
      if (ax.colId && !columnHeading(ax.colId) && !(S.table.columns || []).some(function (c) { return c.id === ax.colId; })) {
        sel.appendChild(h('option', { value: ax.colId, selected: true }, '(deleted column)'));
      }
      sel.addEventListener('change', function () {
        var newId = sel.value || null;
        var hadFocus = document.activeElement === sel;
        var oldHeading = ax.colId ? columnHeading(ax.colId) : '';
        if (S.graph.points.length && newId !== ax.colId) S.scaleNote = true;
        commit(function (g) {
          var axis = g[a];
          var lbl = axis.label.trim();
          axis.colId = newId;
          if (newId && (!lbl || lbl === oldHeading.trim())) axis.label = columnHeading(newId);
        });
        ensurePlotTarget();
        renderAxes();
        renderPanel();
        if (hadFocus) refocus(a + '-col');
        say(newId ? 'The ' + a + '-axis now shows ' + columnName(newId) + '.' : 'No column chosen for the ' + a + '-axis.');
      });
      fs.appendChild(field(fid + '-col', 'Column to plot', sel));

      // label
      var lab = h('input', { id: fid + '-label', type: 'text', class: 'vg-input', autocomplete: 'off',
        spellcheck: 'false', dataset: { field: a + '-label' } });
      lab.value = ax.label;
      bindTextEdit(lab, function (g, v) { g[a].label = v; }, function () { scheduleDraw(); });
      fs.appendChild(field(fid + '-label', 'Axis label', lab));

      // origin & scale
      var org = numberInput(fid + '-origin', ax.origin, a + '-origin');
      var per = numberInput(fid + '-per', ax.perLarge, a + '-per');
      var orgErr = h('span', { class: 'vg-error', id: fid + '-origin-err' });
      var perErr = h('span', { class: 'vg-error', id: fid + '-per-err' });
      org.setAttribute('aria-describedby', orgErr.id);
      per.setAttribute('aria-describedby', perErr.id);
      org.addEventListener('change', function () {
        var hadFocus = document.activeElement === org;
        var v = GR.parseNumber(org.value);
        if (!isFinite(v)) { showErr(org, orgErr, 'Type a number.'); return; }
        showErr(org, orgErr, '');
        if (v === S.graph[a].origin) return;
        if (S.graph.points.length) S.scaleNote = true;
        commit(function (g) { g[a].origin = v; });
        say('The ' + a + '-axis now starts at ' + org.value.trim() + '.');
        renderAxes();
        if (hadFocus) refocus(a + '-origin');
      });
      per.addEventListener('change', function () {
        var hadFocus = document.activeElement === per;
        var v = GR.parseNumber(per.value);
        if (!isFinite(v) || v <= 0) { showErr(per, perErr, 'Type a number greater than zero.'); return; }
        showErr(per, perErr, '');
        if (v === S.graph[a].perLarge) return;
        if (S.graph.points.length) S.scaleNote = true;
        commit(function (g) { g[a].perLarge = v; });
        say('Scale on the ' + a + '-axis: ' + per.value.trim() + ' per large square.');
        renderAxes();
        if (hadFocus) refocus(a + '-per');
      });
      fs.appendChild(field(fid + '-origin', a === 'x' ? 'Value at the left-hand edge' : 'Value at the bottom edge', org, orgErr));
      fs.appendChild(field(fid + '-per', 'Value per large square (2 cm)', per, perErr));

      // label every
      var every = h('select', { id: fid + '-every', class: 'vg-select', dataset: { field: a + '-every' } });
      [1, 2, 3, 4, 5].forEach(function (n) {
        var o = h('option', { value: String(n) }, n === 1 ? 'every large square' : 'every ' + n + ' large squares');
        if (n === ax.labelEvery) o.selected = true;
        every.appendChild(o);
      });
      every.addEventListener('change', function () {
        commit(function (g) { g[a].labelEvery = Number(every.value); });
      });
      fs.appendChild(field(fid + '-every', 'Number the scale', every));
      return fs;
    }

    function field(id, label, control, extra) {
      return h('div', { class: 'vg-field' }, h('label', { for: id, class: 'vg-label' }, label), control, extra || null);
    }

    function numberInput(id, value, fieldName) {
      var inp = h('input', { id: id, type: 'text', inputmode: 'decimal', class: 'vg-input vg-input--num',
        autocomplete: 'off', spellcheck: 'false', dataset: { field: fieldName } });
      // plain, junk-free text the student can edit (e.g. 0.3, 2e-7)
      inp.value = isFinite(value) ? String(parseFloat(Number(value).toPrecision(12))) : '';
      return inp;
    }

    function showErr(inp, errEl, msg) {
      errEl.textContent = msg;
      if (msg) inp.setAttribute('aria-invalid', 'true');
      else inp.removeAttribute('aria-invalid');
    }

    function refocus(fieldName) {
      var el = root.querySelector('[data-field="' + fieldName + '"]');
      if (el && el.focus) el.focus();
    }

    /** Typing into a text box is one undo step per edit (begin on first keystroke, end on blur/Enter). */
    function bindTextEdit(inp, setter, after) {
      inp.addEventListener('input', function () {
        if (!S.editing) { S.hist.begin(); S.editing = true; }
        setter(S.graph, inp.value);
        if (after) after();
        changed();
      });
      var finish = function () {
        if (!S.editing) return;
        S.editing = false;
        S.hist.end();
        updateButtons();
      };
      inp.addEventListener('change', finish);
      inp.addEventListener('blur', finish);
    }

    /** One undoable change. */
    function commit(fn) {
      finishEditing();
      var did = S.hist.change(fn);
      if (did) changed();
      scheduleDraw();
      return did;
    }

    function finishEditing() {
      if (S.editing) { S.editing = false; S.hist.end(); }
    }

    /* ================================================================ mode panel */

    var dyn = {};    // dynamic parts of the current panel

    function setMode(id) {
      if (readOnly) return;
      finishEditing();
      endDrag(true);
      S.mode = id;
      S.sel = null;
      S.pendingVertex = null;
      if (id === 'plot') ensurePlotTarget();
      emitPlotRow();
      renderPanel();
      updateButtons();
      scheduleDraw();
      var m = MODES.filter(function (x) { return x.id === id; })[0];
      say(m ? m.label + ' tool selected.' : '');
    }

    function renderPanel() {
      if (readOnly) return;
      var active = document.activeElement;
      var activeField = active && panel.contains(active) && active.dataset ? active.dataset.field : null;
      ui.clear(panel);
      dyn = {};
      var builders = { plot: panelPlot, line: panelLine, anomaly: panelAnomaly, gradient: panelGradient,
        intercept: panelIntercept, erase: panelErase, worst: panelWorst };
      (builders[S.mode] || function () {})();
      if (activeField) refocus(activeField);
    }

    function para(text, cls) { return h('p', { class: cls || 'vg-help' }, text); }

    function smallBtn(label, onClick, disabled, cls) {
      return h('button', { type: 'button', class: 'vg-btn vg-btn--small' + (cls ? ' ' + cls : ''),
        disabled: !!disabled, on: { click: onClick } }, label);
    }

    function panelPlot() {
      if (!S.graph.x.colId || !S.graph.y.colId) {
        panel.appendChild(para('First choose the columns for the x-axis and the y-axis in “Axes and scales”, ' +
          'then set your scales.', 'vg-help vg-help--strong'));
        return;
      }
      ensurePlotTarget();
      var rows = plotRows();
      var plotted = rows.filter(function (r) { return GR.pointForRow(S.graph, r.rowId); }).length;
      var t = targetRow();
      var box = h('div', { class: 'vg-target' });
      if (t) {
        box.appendChild(h('p', { class: 'vg-target-title' }, 'Plotting row ' + (t.index + 1) + ':'));
        box.appendChild(h('p', { class: 'vg-target-values' },
          h('span', { class: 'vg-kv' }, h('span', { class: 'vg-k' }, 'x '), h('code', { class: 'vg-v' }, t.xs),
            h('span', { class: 'vg-unit' }, ' (' + columnName(S.graph.x.colId) + ')')),
          h('span', { class: 'vg-kv' }, h('span', { class: 'vg-k' }, 'y '), h('code', { class: 'vg-v' }, t.ys),
            h('span', { class: 'vg-unit' }, ' (' + columnName(S.graph.y.colId) + ')'))));
        if (GR.pointForRow(S.graph, t.rowId)) {
          box.appendChild(para('This row is already plotted: placing it again moves its cross.', 'vg-help vg-help--small'));
        }
      } else {
        box.appendChild(h('p', { class: 'vg-target-title' }, rows.length
          ? '✓ Every row with numbers has been plotted.'
          : 'Your table has no rows with numbers in both of these columns yet.'));
      }
      panel.appendChild(box);

      var sel = h('select', { class: 'vg-select', id: idBase + '-row', dataset: { field: 'plot-row' } });
      rows.forEach(function (r) {
        var done = !!GR.pointForRow(S.graph, r.rowId);
        var o = h('option', { value: r.rowId }, 'Row ' + (r.index + 1) + (done ? ' — plotted ✓' : ' — not plotted'));
        if (r.rowId === S.plotRowId) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        S.plotRowId = sel.value || null;
        S.plotExplicit = true;
        emitPlotRow();
        renderPanel();
        scheduleDraw();
      });
      var tools = h('div', { class: 'vg-row' },
        h('label', { class: 'vg-inline', for: sel.id }, h('span', { class: 'vg-inline-label' }, 'Row to plot'), sel),
        h('span', { class: 'vg-count' }, plotted + ' of ' + rows.length + ' plotted'),
        smallBtn('Delete selected cross', function () {
          if (S.sel && S.sel.type === 'point') deleteSelected();
          else say('Select a cross first: click it, or press N with the graph focused.');
        }));
      if (rows.length) panel.appendChild(tools);

      var unplottable = (S.table.rows || []).filter(function (row) {
        var xs = cell(row, S.graph.x.colId), ys = cell(row, S.graph.y.colId);
        return (xs.trim() || ys.trim()) && !(isFinite(GR.parseNumber(xs)) && isFinite(GR.parseNumber(ys)));
      }).map(function (row) { return rowNumber(row.id); });
      if (unplottable.length) {
        panel.appendChild(para((unplottable.length === 1 ? 'Row ' + unplottable[0] + ' cannot be plotted'
          : 'Rows ' + unplottable.join(', ') + ' cannot be plotted') + ' because a value is missing or is not a number.',
        'vg-help vg-help--small'));
      }
      var orphans = S.graph.points.filter(function (p) {
        return !rows.some(function (r) { return r.rowId === p.rowId; });
      }).length;
      if (orphans) {
        panel.appendChild(para(WARN_ICON + ' ' + (orphans === 1 ? 'One cross no longer matches' : orphans + ' crosses no longer match') +
          ' a row of your table. Rub it out with the Erase tool.', 'vg-help vg-help--small vg-help--warn'));
      }
      panel.appendChild(para('Click or tap where the point belongs, reading the scales yourself. Drag a cross to adjust it ' +
        '(turn on the magnifier for precision). Keyboard: arrow keys move the cross-hair, Enter places the cross.',
      'vg-help vg-help--small'));
    }

    function panelLine() {
      panel.appendChild(para(S.graph.line
        ? 'Drag an end of the ruler (A or B) or its middle to adjust your line. Aim for a single thin line with the ' +
          'points balanced on either side along its whole length.'
        : 'Drag across the grid to lay the ruler along your points, or use “Place ruler”.'));
      panel.appendChild(h('div', { class: 'vg-row' },
        smallBtn(S.graph.line ? 'Reset ruler' : 'Place ruler', function () { placeDefaultLine('line'); }),
        smallBtn('Remove line', function () {
          if (commit(function (g) { g.line = null; })) say('Line rubbed out.');
          S.sel = null;
          renderPanel();
        }, !S.graph.line)));
      panel.appendChild(para('Keyboard: N selects end A or B, arrow keys move it (Shift for bigger steps).', 'vg-help vg-help--small'));
    }

    function panelWorst() {
      panel.appendChild(para('Extension (not marked). Draw the worst acceptable straight ' +
        'line: the steepest or shallowest line that still passes through the error bars of your points.', 'vg-help vg-help--ext'));
      panel.appendChild(h('div', { class: 'vg-row' },
        smallBtn(S.graph.worstLine ? 'Reset worst line' : 'Place worst line', function () { placeDefaultLine('worstLine'); }),
        smallBtn('Remove worst line', function () {
          if (commit(function (g) { g.worstLine = null; })) say('Worst line rubbed out.');
          S.sel = null;
          renderPanel();
        }, !S.graph.worstLine)));
    }

    function panelAnomaly() {
      var n = S.graph.points.filter(function (p) { return p.anomaly; }).length;
      panel.appendChild(para('Click a cross to circle it as anomalous; click it again to remove the circle. Only circle a ' +
        'point you have a reason to reject — at most one point may be ignored when you draw your line.'));
      panel.appendChild(para(n === 0 ? 'No points are circled.' : n === 1 ? 'One point is circled.' : n + ' points are circled.',
        'vg-help vg-help--small'));
    }

    function panelErase() {
      panel.appendChild(para('Click a cross, the line, the triangle or the worst line to rub it out. Undo puts it back.'));
    }

    function panelGradient() {
      if (!S.graph.line) {
        panel.appendChild(para('Draw your line of best fit first (Line tool), then draw a large triangle on it.', 'vg-help vg-help--strong'));
        return;
      }
      panel.appendChild(para(S.graph.triangle
        ? 'Drag a corner of the triangle along the line to change it. Make the hypotenuse at least half as long as your line.'
        : 'Click two points on your line, far apart, to draw the gradient triangle.'));
      var ro = S.graph.readOffs;
      var grid = h('div', { class: 'vg-readoffs' });
      ['x1', 'y1', 'x2', 'y2'].forEach(function (k) {
        var id = idBase + '-ro-' + k;
        var inp = h('input', { id: id, type: 'text', inputmode: 'decimal', class: 'vg-input vg-input--num',
          autocomplete: 'off', spellcheck: 'false', dataset: { field: 'ro-' + k } });
        inp.value = ro[k];
        bindTextEdit(inp, function (g, v) { g.readOffs[k] = v; }, updateGradientResult);
        grid.appendChild(h('div', { class: 'vg-field vg-field--ro' },
          h('label', { for: id, class: 'vg-label' }, SUB[k] + ' ='), inp));
      });
      panel.appendChild(h('p', { class: 'vg-help vg-help--small' },
        'Type the coordinates you read off the scales for the two corners on the line: (' + SUB.x1 + ', ' + SUB.y1 +
        ') and (' + SUB.x2 + ', ' + SUB.y2 + ').'));
      panel.appendChild(grid);
      // Practice with hints only: in an exam (or with hints off) the student works out Δy/Δx, which the gradient
      // mark rewards, so no calculation is shown.
      if (hintsOn) {
        dyn.result = h('p', { class: 'vg-result', 'aria-live': 'polite' });
        panel.appendChild(dyn.result);
        updateGradientResult();
      }
      panel.appendChild(h('div', { class: 'vg-row' },
        smallBtn('Place triangle', placeDefaultTriangle, !!S.graph.triangle),
        smallBtn('Remove triangle', function () {
          if (commit(function (g) { g.triangle = null; })) say('Triangle rubbed out.');
          S.sel = null;
          renderPanel();
        }, !S.graph.triangle)));
    }

    function readOffNums() {
      var ro = S.graph.readOffs;
      return { x1: GR.parseNumber(ro.x1), y1: GR.parseNumber(ro.y1), x2: GR.parseNumber(ro.x2), y2: GR.parseNumber(ro.y2) };
    }

    /** Δy/Δx worked out from the typed read-offs (practice with hints only; nothing otherwise). */
    function updateGradientResult() {
      if (!dyn.result || !hintsOn) return;
      var ro = S.graph.readOffs, n = readOffNums();
      ui.clear(dyn.result);
      var all = [n.x1, n.y1, n.x2, n.y2].every(isFinite);
      dyn.result.appendChild(document.createTextNode('Δy/Δx from your read-offs = '));
      if (!all) {
        dyn.result.appendChild(document.createTextNode('… (type all four values)'));
        return;
      }
      if (n.x2 === n.x1) {
        dyn.result.appendChild(document.createTextNode('cannot be calculated (' + SUB.x1 + ' = ' + SUB.x2 + ')'));
        return;
      }
      dyn.result.appendChild(h('span', { class: 'vg-frac' }, '(' + ro.y2.trim() + ' − ' + bracketNeg(ro.y1) + ') / (' +
        ro.x2.trim() + ' − ' + bracketNeg(ro.x1) + ')'));
      dyn.result.appendChild(document.createTextNode(' = '));
      dyn.result.appendChild(h('strong', null, fmt4((n.y2 - n.y1) / (n.x2 - n.x1))));
    }

    function bracketNeg(s) {
      s = String(s).trim();
      return /^[-−]/.test(s) ? '(' + s + ')' : s;
    }

    function panelIntercept() {
      var falseOrigin = S.graph.x.origin !== 0;
      var method = S.graph.intercept.method || (falseOrigin ? 'substitution' : 'direct');
      var radios = h('fieldset', { class: 'vg-fieldset vg-fieldset--inline' }, h('legend', null, 'Method'));
      [['direct', 'Read it where the line meets the y-axis'], ['substitution', 'Calculate it: c = y − mx']].forEach(function (m) {
        var id = idBase + '-im-' + m[0];
        var r = h('input', { type: 'radio', name: idBase + '-im', id: id, value: m[0], dataset: { field: 'im-' + m[0] } });
        r.checked = method === m[0];
        r.addEventListener('change', function () {
          if (!r.checked) return;
          commit(function (g) { g.intercept.method = m[0]; });
          renderPanel();
        });
        radios.appendChild(h('label', { class: 'vg-radio', for: id }, r, ' ', m[1]));
      });
      panel.appendChild(radios);

      if (method === 'direct') {
        panel.appendChild(para(falseOrigin
          ? WARN_ICON + ' Your x-axis does not start at zero (a false origin), so the left edge of your grid is not where x is zero. ' +
            'The intercept cannot be read directly: calculate it instead.'
          : 'Your x-axis starts at zero, so read the value of y where your line meets the y-axis (where x is zero).',
        falseOrigin ? 'vg-help vg-help--warn' : 'vg-help'));
      } else {
        panel.appendChild(para('Substitute a point (x₁, y₁) on your line and your gradient m into y = mx + c, ' +
          'so c = y₁ − m x₁.'));
      }
      // The worked substitution is a practice hint: in an exam (or with hints off) the student calculates c.
      if (method !== 'direct' && hintsOn) {
        var n = readOffNums(), ro = S.graph.readOffs;
        var haveRO = isFinite(n.x1) && isFinite(n.y1);
        var m = [n.x1, n.y1, n.x2, n.y2].every(isFinite) && n.x2 !== n.x1 ? (n.y2 - n.y1) / (n.x2 - n.x1) : NaN;
        var helper = h('p', { class: 'vg-result' });
        if (haveRO && isFinite(m)) {
          var c = n.y1 - m * n.x1;
          helper.appendChild(document.createTextNode('Using your read-offs (' + ro.x1.trim() + ', ' + ro.y1.trim() +
            ') and m = ' + fmt4(m) + ' from your triangle: c = ' + ro.y1.trim() + ' − (' + fmt4(m) + ' × ' +
            bracketNeg(ro.x1) + ') = '));
          helper.appendChild(h('strong', null, fmt4(c)));
        } else {
          helper.appendChild(document.createTextNode('Complete your gradient triangle and type its read-offs (Gradient tool) ' +
            'to use this helper, or calculate c from another point on your line.'));
        }
        panel.appendChild(helper);
      }
      var id = idBase + '-icpt';
      var inp = h('input', { id: id, type: 'text', inputmode: 'decimal', class: 'vg-input vg-input--num',
        autocomplete: 'off', spellcheck: 'false', dataset: { field: 'icpt' } });
      inp.value = S.graph.intercept.value;
      bindTextEdit(inp, function (g, v) { g.intercept.value = v; g.intercept.method = method; });
      panel.appendChild(h('div', { class: 'vg-field vg-field--wide' },
        h('label', { for: id, class: 'vg-label' }, 'Your y-intercept ='), inp));
    }

    /* ================================================================ hints (practice only) */

    function renderHints() {
      if (!hintsOn) return;
      ui.clear(hintsBox);
      var msgs = [];
      ['x', 'y'].forEach(function (a) {
        var ax = S.graph[a];
        if (!ax.colId) return;
        var vals = axisValues(a);
        if (vals.length < 2) return;
        var r = GR.checkScale(S.graph, a, vals);
        r.problems.forEach(function (p) {
          if (/less than half/.test(p)) {
            msgs.push('Your points fill less than half of the grid in the ' + a + ' direction. A scale with smaller ' +
              'steps (or a false origin) would spread them out.');
          } else if (/Awkward/.test(p)) {
            msgs.push(p + ' Steps such as 3, 6, 7 or 9 make plotting and reading off difficult.');
          } else {
            msgs.push(p);
          }
        });
        r.advice.forEach(function (p) { msgs.push(p); });
      });
      if (S.graph.triangle && S.graph.line) {
        var tri = GR.checkTriangle(S.graph);
        if (tri.present && !tri.bigEnough) msgs.push('Your gradient triangle is small: make its hypotenuse at least half the length of your line.');
      }
      if (S.graph.intercept.method === 'direct' && S.graph.x.origin !== 0) {
        msgs.push('With a false origin on the x-axis, the y-intercept must be calculated, not read from the grid.');
      }
      if (!msgs.length) return;
      var d = h('details', { class: 'vg-hints' });
      d.open = S.hintsOpen;
      d.addEventListener('toggle', function () { S.hintsOpen = d.open; });
      d.appendChild(h('summary', null, h('span', { 'aria-hidden': 'true' }, WARN_ICON + ' '), 'Graph hints (' + msgs.length + ')'));
      var ul = h('ul', { class: 'vg-hints-list' });
      msgs.forEach(function (m) {
        ul.appendChild(h('li', { class: 'vg-hint' }, h('span', { class: 'vg-hint-icon', 'aria-hidden': 'true' }, WARN_ICON),
          h('span', null, m)));
      });
      d.appendChild(ul);
      hintsBox.appendChild(d);
    }

    /* ================================================================ layout & drawing */

    function ticks(a) {
      var ax = S.graph[a], grid = S.graph.grid;
      if (!(isFinite(ax.origin) && isFinite(ax.perLarge) && ax.perLarge > 0)) return [];
      var le = Math.max(1, Math.floor(ax.labelEvery) || 1);
      var n = a === 'x' ? grid.cols : grid.rows;
      var out = [];
      for (var k = 0; k <= n; k += le) {
        var v = ax.origin + k * ax.perLarge;
        out.push({ pos: k * grid.small, text: GR.formatTick(v, ax.perLarge * le, ax.origin) });
      }
      return out;
    }

    function layout(ctx) {
      var avail = wrap.clientWidth;
      if (!avail) return null;
      var dpr = fixedDpr || globalThis.devicePixelRatio || 1;
      var W = Math.max(240, Math.floor(avail * S.zoom));
      var font = cssVar('--font-ui', 'system-ui, sans-serif');
      var xt = ticks('x'), yt = ticks('y');
      var tickPx = 12;
      ctx.font = tickPx + 'px ' + font;
      var yW = 0;
      yt.forEach(function (t) { yW = Math.max(yW, ctx.measureText(t.text).width); });
      var lastXW = xt.length ? ctx.measureText(xt[xt.length - 1].text).width : 0;
      var mL = Math.ceil(Math.max(28, yW + 16)), mR = Math.ceil(Math.max(16, lastXW / 2 + 6));
      var mT = 34, mB = 58;
      var NX = nx(), NY = ny();
      // Every small square is a whole number of device pixels, so the ruling is perfectly uniform like printed
      // graph paper (a fractional size gives visible beat patterns). The paper is centred in its frame.
      var s = Math.max(2, Math.floor(((W - mL - mR) / NX) * dpr) / dpr);
      var gridW = s * NX, gridH = s * NY;
      var ox = Math.round(mL * dpr) / dpr, oy = Math.round((mT + gridH) * dpr) / dpr;
      // x tick labels: shrink the font if they would overlap
      var spacing = xt.length > 1 ? (xt[1].pos - xt[0].pos) * s : Infinity;
      var maxXW = 0;
      xt.forEach(function (t) { maxXW = Math.max(maxXW, ctx.measureText(t.text).width); });
      var xTickPx = maxXW > spacing - 6 ? Math.max(9, Math.floor(tickPx * (spacing - 6) / maxXW)) : tickPx;
      return { W: Math.ceil(ox + gridW + mR), H: Math.ceil(oy + mB), s: s, ox: ox, oy: oy, gridW: gridW, gridH: gridH,
        NX: NX, NY: NY, dpr: dpr, font: font, tickPx: tickPx, xTickPx: xTickPx, xt: xt, yt: yt };
    }

    function X(L, gx) { return L.ox + gx * L.s; }
    function Y(L, gy) { return L.oy - gy * L.s; }
    function toPx(L, p) { return { x: X(L, p.gx), y: Y(L, p.gy) }; }
    function toG(L, x, y) { return { gx: (x - L.ox) / L.s, gy: (L.oy - y) / L.s }; }

    function scheduleDraw() {
      if (S.raf) return;
      var raf = globalThis.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      S.raf = raf(function () { S.raf = 0; draw(); });
    }

    function draw(o) {
      o = o || {};
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      var L = layout(ctx);
      if (!L) return;
      S.L = L;
      S.lastWidth = wrap.clientWidth;
      var needW = Math.round(L.W * L.dpr), needH = Math.round(L.H * L.dpr);
      if (canvas.width !== needW || canvas.height !== needH || canvas.style.width !== L.W + 'px') {
        ctx = ui.fitCanvas(canvas, L.W, L.H, L.dpr);
      } else {
        ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      }
      var C = colours();
      ctx.clearRect(0, 0, L.W, L.H);
      ctx.fillStyle = C.paper;
      ctx.fillRect(0, 0, L.W, L.H);
      drawScene(ctx, L, C, { k: 1, clean: !!o.clean });
      if (!o.clean) drawLoupeIfNeeded(ctx, L, C);
      else S.loupeDrawn = false;
    }

    function drawScene(ctx, L, C, o) {
      var k = o.k, dpr = L.dpr, loupe = k !== 1;
      function crisp(v, wDev) {
        if (loupe) return v;
        return (Math.round(v * dpr) + (wDev % 2 ? 0.5 : 0)) / dpr;
      }
      var small = S.graph.grid.small;
      var top = Y(L, L.NY), bottom = Y(L, 0), left = X(L, 0), right = X(L, L.NX);

      // --- grid: minor then major lines
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = C.minor;
      ctx.lineWidth = loupe ? k : 1 / dpr;            // in the loupe: about 1 css px after magnification
      ctx.beginPath();
      var i, x, y;
      for (i = 0; i <= L.NX; i++) {
        if (i % small === 0) continue;
        x = crisp(X(L, i), 1);
        ctx.moveTo(x, top); ctx.lineTo(x, bottom);
      }
      for (i = 0; i <= L.NY; i++) {
        if (i % small === 0) continue;
        y = crisp(Y(L, i), 1);
        ctx.moveTo(left, y); ctx.lineTo(right, y);
      }
      ctx.stroke();
      var majorDev = dpr >= 2 ? Math.round(1.5 * dpr) : 1;
      ctx.strokeStyle = C.major;
      ctx.lineWidth = loupe ? 1.5 * k : majorDev / dpr;
      ctx.beginPath();
      for (i = 0; i <= L.NX; i += small) {
        x = crisp(X(L, i), majorDev);
        ctx.moveTo(x, top); ctx.lineTo(x, bottom);
      }
      for (i = 0; i <= L.NY; i += small) {
        y = crisp(Y(L, i), majorDev);
        ctx.moveTo(left, y); ctx.lineTo(right, y);
      }
      ctx.stroke();

      // --- axes along the left and bottom edges, ticks, scale numbers, labels
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.moveTo(left, top - 6); ctx.lineTo(left, bottom); ctx.lineTo(right + 6, bottom);
      L.xt.forEach(function (t) { var tx = X(L, t.pos); ctx.moveTo(tx, bottom); ctx.lineTo(tx, bottom + 5); });
      L.yt.forEach(function (t) { var ty = Y(L, t.pos); ctx.moveTo(left, ty); ctx.lineTo(left - 5, ty); });
      ctx.stroke();
      ctx.fillStyle = C.ink;
      ctx.font = L.xTickPx + 'px ' + L.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      L.xt.forEach(function (t) { ctx.fillText(t.text, X(L, t.pos), bottom + 7); });
      ctx.font = L.tickPx + 'px ' + L.font;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      L.yt.forEach(function (t) { ctx.fillText(t.text, left - 8, Y(L, t.pos)); });
      ctx.font = '14px ' + L.font;
      if (S.graph.x.label) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(S.graph.x.label, (left + right) / 2, bottom + 12 + L.xTickPx + 8);
      }
      if (S.graph.y.label) {
        var w = ctx.measureText(S.graph.y.label).width;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(S.graph.y.label, Math.max(4, Math.min(left - w / 2, L.W - w - 4)), top - 10);
      }
      ctx.restore();

      var thin = Math.min(1, 0.4 * L.s) * k;      // pencil line: well under half a small square

      // --- worst line (Paper 5)
      if (S.graph.worstLine) {
        ctx.save();
        ctx.strokeStyle = C.plot;
        ctx.lineWidth = thin;
        ctx.setLineDash([6 * k, 4 * k]);
        segment(ctx, L, S.graph.worstLine);
        ctx.restore();
      }
      // --- best-fit line
      if (S.graph.line) {
        ctx.save();
        ctx.strokeStyle = C.plot;
        ctx.lineWidth = thin;
        segment(ctx, L, S.graph.line);
        ctx.restore();
      }
      // --- gradient triangle
      var tri = S.graph.triangle;
      if (tri) {
        var p1 = toPx(L, tri.p1), p2 = toPx(L, tri.p2);
        ctx.save();
        ctx.strokeStyle = C.plot;
        ctx.lineWidth = thin;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.restore();
      }
      // --- crosses and anomaly circles
      var arm = clamp(0.45 * L.s, 3, 5.5);
      S.graph.points.forEach(function (p) {
        var c = toPx(L, p);
        ctx.save();
        ctx.strokeStyle = C.plot;
        ctx.lineWidth = 1.25 * k;
        ctx.beginPath();
        ctx.moveTo(c.x - arm, c.y - arm); ctx.lineTo(c.x + arm, c.y + arm);
        ctx.moveTo(c.x - arm, c.y + arm); ctx.lineTo(c.x + arm, c.y - arm);
        ctx.stroke();
        if (p.anomaly) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, Math.max(8, 1.3 * L.s), 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      });

      if (o.clean || readOnly) return;
      drawOverlays(ctx, L, C, k, arm);
    }

    function segment(ctx, L, seg) {
      var a = toPx(L, seg.a), b = toPx(L, seg.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    function drawOverlays(ctx, L, C, k, arm) {
      var mode = S.mode;
      // ruler and its handles
      var which = mode === 'line' ? 'line' : mode === 'worst' ? 'worstLine' : null;
      if (which && S.graph[which]) drawRuler(ctx, L, C, k, S.graph[which], which);
      // triangle corners
      if (mode === 'gradient') {
        var labels = [['p1', '(x₁, y₁)'], ['p2', '(x₂, y₂)']];
        if (S.graph.triangle) {
          labels.forEach(function (lb) {
            var c = toPx(L, S.graph.triangle[lb[0]]);
            handle(ctx, C, k, c, S.sel && S.sel.type === 'vertex' && S.sel.end === lb[0]);
            label(ctx, L, C, k, lb[1], c.x + 10, c.y + (lb[0] === 'p1' ? 14 : -14));
          });
        }
        if (S.pendingVertex) {
          var pv = toPx(L, S.pendingVertex);
          handle(ctx, C, k, pv, true);
          label(ctx, L, C, k, labels[0][1], pv.x + 10, pv.y + 14);
        }
      }
      // ghost cross while placing
      if (S.drag && S.drag.kind === 'place') {
        var g = toPx(L, S.drag.pos);
        ctx.save();
        ctx.strokeStyle = C.plot;
        ctx.lineWidth = 1.25 * k;
        ctx.beginPath();
        ctx.moveTo(g.x - arm, g.y - arm); ctx.lineTo(g.x + arm, g.y + arm);
        ctx.moveTo(g.x - arm, g.y + arm); ctx.lineTo(g.x + arm, g.y - arm);
        ctx.stroke();
        ctx.strokeStyle = C.accent;
        ctx.setLineDash([3 * k, 3 * k]);
        ctx.beginPath();
        ctx.arc(g.x, g.y, 11, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      // selected cross
      if (S.sel && S.sel.type === 'point') {
        var sp = GR.findPoint(S.graph, S.sel.id);
        if (sp) {
          var c = toPx(L, sp);
          var r = arm + 5;
          ctx.save();
          ctx.strokeStyle = C.focus;
          ctx.lineWidth = 2.5 * k;
          ctx.setLineDash([4 * k, 3 * k]);
          ctx.strokeRect(c.x - r, c.y - r, 2 * r, 2 * r);
          ctx.restore();
        }
      }
      // keyboard cross-hair
      if (S.kbd && S.focused && S.cursor && !S.sel && (mode === 'plot' || mode === 'gradient')) {
        var kc = toPx(L, S.cursor);
        ctx.save();
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 1.5 * k;
        ctx.beginPath();
        ctx.moveTo(kc.x - 14, kc.y); ctx.lineTo(kc.x - 3, kc.y);
        ctx.moveTo(kc.x + 3, kc.y); ctx.lineTo(kc.x + 14, kc.y);
        ctx.moveTo(kc.x, kc.y - 14); ctx.lineTo(kc.x, kc.y - 3);
        ctx.moveTo(kc.x, kc.y + 3); ctx.lineTo(kc.x, kc.y + 14);
        ctx.stroke();
        ctx.restore();
      }
    }

    function drawRuler(ctx, L, C, k, seg, which) {
      var a = toPx(L, seg.a), b = toPx(L, seg.b);
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len, nxv = -uy, nyv = ux;
      var ext = 14, half = 13;
      var a2 = { x: a.x - ux * ext, y: a.y - uy * ext }, b2 = { x: b.x + ux * ext, y: b.y + uy * ext };
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = C.accentSoft;
      ctx.beginPath();
      ctx.moveTo(a2.x + nxv * half, a2.y + nyv * half);
      ctx.lineTo(b2.x + nxv * half, b2.y + nyv * half);
      ctx.lineTo(b2.x - nxv * half, b2.y - nyv * half);
      ctx.lineTo(a2.x - nxv * half, a2.y - nyv * half);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1 * k;
      ctx.stroke();
      ctx.restore();
      ['a', 'b'].forEach(function (end) {
        var c = end === 'a' ? a : b;
        var sel = S.sel && S.sel.type === 'handle' && S.sel.which === which && S.sel.end === end;
        handle(ctx, C, k, c, sel);
        label(ctx, L, C, k, end.toUpperCase(), c.x + nxv * 22, c.y + nyv * 22);
      });
    }

    function handle(ctx, C, k, c, selected) {
      ctx.save();
      ctx.fillStyle = C.panel;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2 * k;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      // centre dot shows the exact point
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = C.focus;
        ctx.lineWidth = 3 * k;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function label(ctx, L, C, k, text, x, y) {
      ctx.save();
      ctx.font = '13px ' + L.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var w = ctx.measureText(text).width + 8;
      x = clamp(x, w / 2 + 2, L.W - w / 2 - 2);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = C.panel;
      ctx.fillRect(x - w / 2, y - 9, w, 18);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.accent;
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    function drawLoupeIfNeeded(ctx, L, C) {
      var focus = null, centre = null;
      S.loupeDrawn = false;
      if (S.touch) {
        focus = S.touch;
        centre = { x: S.touch.x, y: S.touch.y - (LOUPE_R + 36) };
        if (centre.y < LOUPE_R + 4) centre.y = S.touch.y + LOUPE_R + 36;
      } else if (S.loupe) {
        // follow the pointer; without one, follow the selection / cross-hair only when the student is using the
        // keyboard (a mouse click also focuses the canvas and selects, and the loupe must not stay behind then)
        if (S.hover) focus = S.hover;
        else if (S.focused && S.kbd) {
          var fp = selectedPos() || S.cursor;
          if (fp) focus = toPx(L, fp);
        }
        if (focus) centre = { x: focus.x, y: focus.y };
      }
      if (!focus) return;
      S.loupeDrawn = true;
      centre.x = clamp(centre.x, LOUPE_R + 2, L.W - LOUPE_R - 2);
      centre.y = clamp(centre.y, LOUPE_R + 2, L.H - LOUPE_R - 2);
      ctx.save();
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, LOUPE_R, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = C.paper;
      ctx.fill();
      ctx.clip();
      ctx.translate(centre.x, centre.y);
      ctx.scale(LOUPE_ZOOM, LOUPE_ZOOM);
      ctx.translate(-focus.x, -focus.y);
      drawScene(ctx, L, C, { k: 1 / LOUPE_ZOOM });
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, LOUPE_R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(centre.x - 16, centre.y); ctx.lineTo(centre.x - 5, centre.y);
      ctx.moveTo(centre.x + 5, centre.y); ctx.lineTo(centre.x + 16, centre.y);
      ctx.moveTo(centre.x, centre.y - 16); ctx.lineTo(centre.x, centre.y - 5);
      ctx.moveTo(centre.x, centre.y + 5); ctx.lineTo(centre.x, centre.y + 16);
      ctx.stroke();
      ctx.restore();
    }

    function selectedPos() {
      if (!S.sel) return null;
      if (S.sel.type === 'point') return GR.findPoint(S.graph, S.sel.id);
      if (S.sel.type === 'handle') return S.graph[S.sel.which] ? S.graph[S.sel.which][S.sel.end] : null;
      if (S.sel.type === 'vertex') return S.graph.triangle ? S.graph.triangle[S.sel.end] : null;
      return null;
    }

    /* ================================================================ hit testing */

    function pxDist(a, b) { return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)); }

    function hitPoint(p, r) {
      var best = null, bd = r;
      S.graph.points.forEach(function (pt) {
        var d = pxDist(p, toPx(S.L, pt));
        if (d <= bd) { bd = d; best = pt; }
      });
      return best;
    }

    function hitEnd(p, seg, r) {
      if (!seg) return null;
      var da = pxDist(p, toPx(S.L, seg.a)), db = pxDist(p, toPx(S.L, seg.b));
      if (da <= r && da <= db) return 'a';
      if (db <= r) return 'b';
      return null;
    }

    function distToSegment(p, seg) {
      var a = toPx(S.L, seg.a), b = toPx(S.L, seg.b);
      var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      var t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
      return pxDist(p, { x: a.x + t * dx, y: a.y + t * dy });
    }

    /** Project a grid position onto the line (perpendicular foot). */
    function projectOnLine(g) {
      var line = S.graph.line;
      var ax = line.a.gx, ay = line.a.gy, dx = line.b.gx - ax, dy = line.b.gy - ay;
      var l2 = dx * dx + dy * dy;
      if (!l2) return { gx: ax, gy: ay };
      var t = ((g.gx - ax) * dx + (g.gy - ay) * dy) / l2;
      return { gx: ax + t * dx, gy: ay + t * dy };
    }

    function triangleHit(p, r) {
      var tri = S.graph.triangle;
      if (!tri) return false;
      var c = { a: tri.p1, b: { gx: tri.p2.gx, gy: tri.p1.gy } }, d = { a: { gx: tri.p2.gx, gy: tri.p1.gy }, b: tri.p2 };
      return distToSegment(p, c) <= r || distToSegment(p, d) <= r ||
        pxDist(p, toPx(S.L, tri.p1)) <= r || pxDist(p, toPx(S.L, tri.p2)) <= r;
    }

    /* ================================================================ pointer interaction */

    function evPos(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function onPointerDown(ev) {
      if (!S.L || ev.button > 0) return;
      var p = evPos(ev);
      S.hover = p;
      var touch = ev.pointerType === 'touch' || ev.pointerType === 'pen';
      if (touch) S.touch = p;
      S.kbd = false;
      if (readOnly || !S.mode || S.mode === 'intercept') { scheduleDraw(); return; }
      try { canvas.focus({ preventScroll: true }); } catch (e) { canvas.focus(); }
      var r = touch ? 18 : 9;
      var g = clampG(toG(S.L, p.x, p.y));
      var drag = null;
      switch (S.mode) {
        case 'plot': {
          var hit = hitPoint(p, r);
          if (hit) {
            S.sel = { type: 'point', id: hit.id };
            S.hist.begin();
            drag = { kind: 'point', id: hit.id, off: { gx: hit.gx - g.gx, gy: hit.gy - g.gy } };
          } else if (targetRow()) {
            S.sel = null;
            drag = { kind: 'place', pos: g };
          } else {
            say(S.graph.x.colId && S.graph.y.colId ? 'Every row with numbers has been plotted. Drag a cross to move it.'
              : 'Choose the columns to plot first (Axes and scales).');
          }
          break;
        }
        case 'line':
        case 'worst': {
          var which = S.mode === 'line' ? 'line' : 'worstLine';
          var seg = S.graph[which];
          var end = hitEnd(p, seg, touch ? 22 : 12);
          if (end) {
            S.sel = { type: 'handle', which: which, end: end };
            S.hist.begin();
            drag = { kind: 'handle', which: which, end: end };
          } else if (seg && distToSegment(p, seg) <= (touch ? 18 : 13)) {
            S.hist.begin();
            drag = { kind: 'body', which: which, start: g, a0: { gx: seg.a.gx, gy: seg.a.gy }, b0: { gx: seg.b.gx, gy: seg.b.gy } };
          } else if (!seg) {
            S.hist.begin();
            S.graph[which] = { a: { gx: g.gx, gy: g.gy }, b: { gx: g.gx, gy: g.gy } };
            S.sel = { type: 'handle', which: which, end: 'b' };
            drag = { kind: 'newline', which: which };
          } else {
            S.sel = null;
            say('Drag an end (A or B) or the middle of the ruler to move it.');
          }
          break;
        }
        case 'anomaly': {
          var hp = hitPoint(p, r);
          if (hp) {
            commit(function (gr) { var q = GR.findPoint(gr, hp.id); if (q) q.anomaly = !q.anomaly; });
            S.sel = { type: 'point', id: hp.id };
            var now = GR.findPoint(S.graph, hp.id);
            say(now && now.anomaly ? 'Point circled as anomalous.' : 'Circle removed.');
            renderPanel();
          } else {
            say('Click on a cross to circle it.');
          }
          break;
        }
        case 'gradient': {
          if (!S.graph.line) { say('Draw your line first (Line tool).'); break; }
          var vend = null;
          if (S.graph.triangle) {
            if (pxDist(p, toPx(S.L, S.graph.triangle.p1)) <= r + 3) vend = 'p1';
            else if (pxDist(p, toPx(S.L, S.graph.triangle.p2)) <= r + 3) vend = 'p2';
          }
          if (vend) {
            S.sel = { type: 'vertex', end: vend };
            S.hist.begin();
            drag = { kind: 'vertex', end: vend };
          } else {
            drag = { kind: 'corner' };
          }
          break;
        }
        case 'erase': {
          eraseAt(p, r);
          break;
        }
      }
      if (drag) {
        drag.pointerId = ev.pointerId;
        drag.startPx = p;
        drag.moved = false;
        S.drag = drag;
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        ev.preventDefault();
      }
      scheduleDraw();
    }

    function onPointerMove(ev) {
      if (!S.L) return;
      var p = evPos(ev);
      S.hover = p;
      S.kbd = false;
      if (S.touch) S.touch = p;
      var d = S.drag;
      if (!d || d.pointerId !== ev.pointerId) {
        updateCursorStyle(p);
        if (S.loupe) scheduleDraw();
        return;
      }
      if (pxDist(p, d.startPx) > 3) d.moved = true;
      var g = clampG(toG(S.L, p.x, p.y));
      switch (d.kind) {
        case 'place': d.pos = g; break;
        case 'point': {
          var pt = GR.findPoint(S.graph, d.id);
          if (pt) { var q = clampG({ gx: g.gx + d.off.gx, gy: g.gy + d.off.gy }); pt.gx = q.gx; pt.gy = q.gy; }
          break;
        }
        case 'handle':
        case 'newline': {
          var seg = S.graph[d.which];
          if (seg) {
            var e = d.kind === 'newline' ? 'b' : d.end;
            // past the edge of the grid the end stops at the edge along the direction drawn (slope kept)
            var q2 = clipAlong(seg[e === 'a' ? 'b' : 'a'], toG(S.L, p.x, p.y));
            if (q2) { seg[e].gx = q2.gx; seg[e].gy = q2.gy; }
          }
          break;
        }
        case 'body': {
          var s2 = S.graph[d.which];
          if (!s2) break;
          var dx = g.gx - d.start.gx, dy = g.gy - d.start.gy;
          // keep both ends on the grid
          dx = clamp(dx, -Math.min(d.a0.gx, d.b0.gx), nx() - Math.max(d.a0.gx, d.b0.gx));
          dy = clamp(dy, -Math.min(d.a0.gy, d.b0.gy), ny() - Math.max(d.a0.gy, d.b0.gy));
          s2.a.gx = d.a0.gx + dx; s2.a.gy = d.a0.gy + dy;
          s2.b.gx = d.b0.gx + dx; s2.b.gy = d.b0.gy + dy;
          break;
        }
        case 'vertex': {
          if (S.graph.triangle && S.graph.line) {
            var pr = clampG(projectOnLine(g));
            S.graph.triangle[d.end] = pr;
          }
          break;
        }
      }
      scheduleDraw();
    }

    function onPointerUp(ev) {
      var d = S.drag;
      if (!d || d.pointerId !== ev.pointerId) { S.touch = null; scheduleDraw(); return; }
      S.drag = null;
      S.touch = null;
      if (ev.pointerType === 'touch') S.hover = null;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      var g = S.L ? clampG(toG(S.L, evPos(ev).x, evPos(ev).y)) : null;
      switch (d.kind) {
        case 'place': placeCross(d.pos); break;
        case 'point': if (S.hist.end()) { say('Cross moved.'); changed(); } break;
        case 'handle':
        case 'body':
          if (S.hist.end()) { say(d.kind === 'body' ? 'Ruler moved.' : 'Ruler end ' + d.end.toUpperCase() + ' moved.'); changed(); }
          break;
        case 'newline': {
          var seg = S.graph[d.which];
          if (!seg || pxDist(toPx(S.L, seg.a), toPx(S.L, seg.b)) < 12) {
            S.hist.cancel();
            S.sel = null;
            say('Drag across the grid to lay the ruler along your points.');
          } else {
            S.hist.end();
            say(d.which === 'line' ? 'Line drawn. Drag the ends to adjust it.' : 'Worst line drawn.');
            changed();
          }
          renderPanel();
          break;
        }
        case 'vertex': if (S.hist.end()) { say('Triangle corner moved.'); changed(); } break;
        case 'corner': if (g) cornerClick(g); break;
      }
      scheduleDraw();
    }

    function onPointerCancel() {
      endDrag(true);
      S.touch = null;
      scheduleDraw();
    }

    function onPointerLeave(ev) {
      if (S.drag) return;
      S.hover = null;
      if (ev.pointerType === 'touch') S.touch = null;
      scheduleDraw();
    }

    function endDrag(cancel) {
      var d = S.drag;
      if (!d) return;
      S.drag = null;
      if (d.kind !== 'place' && d.kind !== 'corner') {
        if (cancel) S.hist.cancel();
        else S.hist.end();
      }
    }

    function updateCursorStyle(p) {
      if (readOnly || !S.L) { canvas.style.cursor = ''; return; }
      var cur = 'crosshair';
      if (S.mode === 'plot' && hitPoint(p, 9)) cur = 'grab';
      else if ((S.mode === 'line' || S.mode === 'worst')) {
        var seg = S.graph[S.mode === 'line' ? 'line' : 'worstLine'];
        if (seg && (hitEnd(p, seg, 12) || distToSegment(p, seg) <= 13)) cur = 'grab';
      } else if (S.mode === 'anomaly' || S.mode === 'erase') cur = 'pointer';
      else if (S.mode === 'intercept') cur = 'default';
      canvas.style.cursor = cur;
    }

    /* ================================================================ actions */

    function placeCross(pos) {
      var t = targetRow();
      if (!t) return;
      var rowId = t.rowId;
      var existing = GR.pointForRow(S.graph, rowId);
      var newId = null;
      commit(function (g) {
        var q = existing ? GR.findPoint(g, existing.id) : null;
        if (q) { q.gx = pos.gx; q.gy = pos.gy; newId = q.id; }
        else newId = GR.addPoint(g, rowId, pos.gx, pos.gy).id;
      });
      S.sel = { type: 'point', id: newId };
      S.plotExplicit = false;
      S.plotRowId = nextUnplotted(rowId);
      emitPlotRow();
      var next = targetRow();
      say('Cross for row ' + (t.index + 1) + (existing ? ' moved.' : ' plotted.') +
        (next ? ' Next: row ' + (next.index + 1) + '.' : ' Every row has been plotted.'));
      renderPanel();
    }

    function cornerClick(g) {
      if (!S.graph.line) return;
      var pr = projectOnLine(g);
      var dpx = pxDist(toPx(S.L, pr), toPx(S.L, g));
      if (dpx > Math.max(24, 3 * S.L.s)) { say('Click on your line to mark a corner of the triangle.'); return; }
      pr = clampG(pr);
      if (!S.pendingVertex) {
        S.pendingVertex = pr;
        say('First corner marked. Now click a second point on the line, well away from the first.');
      } else {
        var p1 = S.pendingVertex;
        S.pendingVertex = null;
        if (Math.abs(pr.gx - p1.gx) < 0.5) { say('The two corners are too close together. Try again.'); return; }
        commit(function (gr) { gr.triangle = p1.gx <= pr.gx ? { p1: p1, p2: pr } : { p1: pr, p2: p1 }; });
        say('Triangle drawn. Read the coordinates of its two corners and type them below.');
        renderPanel();
      }
    }

    function eraseAt(p, r) {
      var hit = hitPoint(p, r);
      if (hit) {
        commit(function (g) { GR.removePoint(g, hit.id); });
        say('Cross rubbed out.');
      } else if (triangleHit(p, r)) {
        commit(function (g) { g.triangle = null; });
        say('Triangle rubbed out.');
      } else if (S.graph.worstLine && distToSegment(p, S.graph.worstLine) <= r) {
        commit(function (g) { g.worstLine = null; });
        say('Worst line rubbed out.');
      } else if (S.graph.line && distToSegment(p, S.graph.line) <= r) {
        commit(function (g) { g.line = null; });
        say('Line rubbed out.');
      } else {
        say('Nothing to rub out there.');
        return;
      }
      S.sel = null;
      ensurePlotTarget();
    }

    function deleteSelected() {
      if (!S.sel) return;
      if (S.sel.type === 'point') {
        var id = S.sel.id;
        if (commit(function (g) { GR.removePoint(g, id); })) say('Cross rubbed out.');
        ensurePlotTarget();
      } else if (S.sel.type === 'handle') {
        var w = S.sel.which;
        if (commit(function (g) { g[w] = null; })) say(w === 'line' ? 'Line rubbed out.' : 'Worst line rubbed out.');
      } else if (S.sel.type === 'vertex') {
        if (commit(function (g) { g.triangle = null; })) say('Triangle rubbed out.');
      }
      S.sel = null;
      renderPanel();
    }

    function placeDefaultLine(which) {
      var W = nx(), H = ny();
      commit(function (g) {
        g[which] = which === 'line'
          ? { a: { gx: W * 0.15, gy: H * 0.2 }, b: { gx: W * 0.85, gy: H * 0.8 } }
          : { a: { gx: W * 0.15, gy: H * 0.3 }, b: { gx: W * 0.85, gy: H * 0.7 } };
      });
      S.sel = { type: 'handle', which: which, end: 'a' };
      say('Ruler placed. Move ends A and B to lie along your points (N switches end, arrow keys move it).');
      renderPanel();
      try { canvas.focus({ preventScroll: true }); } catch (e) { canvas.focus(); }
    }

    function placeDefaultTriangle() {
      var line = S.graph.line;
      if (!line) return;
      var ax = Math.min(line.a.gx, line.b.gx), bx = Math.max(line.a.gx, line.b.gx);
      var x1 = ax + 0.2 * (bx - ax), x2 = ax + 0.8 * (bx - ax);
      commit(function (g) {
        g.triangle = { p1: clampG({ gx: x1, gy: GR.lineY(line, x1) }), p2: clampG({ gx: x2, gy: GR.lineY(line, x2) }) };
      });
      S.pendingVertex = null;
      S.sel = { type: 'vertex', end: 'p1' };
      say('Triangle placed. Move its corners along the line if you wish (N switches corner), then type your read-offs.');
      renderPanel();
      try { canvas.focus({ preventScroll: true }); } catch (e) { canvas.focus(); }
    }

    function toggleLoupe() {
      S.loupe = !S.loupe;
      updateButtons();
      say(S.loupe ? 'Magnifier on.' : 'Magnifier off.');
      scheduleDraw();
    }

    function exportPNG() {
      if (!canExport()) return;
      draw({ clean: true });
      try {
        VL.export.downloadCanvasPNG(canvas, 'graph.png');
        say('Graph exported as graph.png.');
      } catch (e) {
        console.error('[graphView export]', e);
        say('The graph could not be exported.');
      }
      scheduleDraw();
    }

    /* ================================================================ keyboard */

    function selectables() {
      var m = S.mode;
      if (m === 'plot' || m === 'anomaly' || m === 'erase') {
        return S.graph.points.slice().sort(function (a, b) { return a.gx - b.gx; })
          .map(function (p) { return { type: 'point', id: p.id }; });
      }
      if (m === 'line' && S.graph.line) return [{ type: 'handle', which: 'line', end: 'a' }, { type: 'handle', which: 'line', end: 'b' }];
      if (m === 'worst' && S.graph.worstLine) {
        return [{ type: 'handle', which: 'worstLine', end: 'a' }, { type: 'handle', which: 'worstLine', end: 'b' }];
      }
      if (m === 'gradient' && S.graph.triangle) return [{ type: 'vertex', end: 'p1' }, { type: 'vertex', end: 'p2' }];
      return [];
    }

    function sameSel(a, b) {
      return !!a && !!b && a.type === b.type && a.id === b.id && a.which === b.which && a.end === b.end;
    }

    function describeSel() {
      if (!S.sel) return '';
      if (S.sel.type === 'point') {
        var p = GR.findPoint(S.graph, S.sel.id);
        var rn = p ? rowNumber(p.rowId) : 0;
        return (rn ? 'Cross for row ' + rn : 'Cross') + (p && p.anomaly ? ' (circled)' : '') + ' selected.';
      }
      if (S.sel.type === 'handle') return 'Ruler end ' + S.sel.end.toUpperCase() + ' selected.';
      return 'Triangle corner (' + (S.sel.end === 'p1' ? 'x₁, y₁' : 'x₂, y₂') + ') selected.';
    }

    function cycle(dir) {
      var items = selectables();
      if (!items.length) { say('Nothing to select with this tool.'); return; }
      var i = -1;
      items.forEach(function (it, j) { if (sameSel(it, S.sel)) i = j; });
      S.sel = items[(i + dir + items.length) % items.length];
      say(describeSel());
      renderPanelIfPlot();
      scheduleDraw();
    }

    function renderPanelIfPlot() {
      if (S.mode === 'plot') renderPanel();
    }

    function nudge(dx, dy) {
      if (!S.sel) {
        if (!S.cursor) S.cursor = { gx: nx() / 2, gy: ny() / 2 };
        S.cursor = clampG({ gx: S.cursor.gx + dx, gy: S.cursor.gy + dy });
        S.kbd = true;
        scheduleDraw();
        return;
      }
      S.hist.begin();
      if (S.sel.type === 'point') {
        var p = GR.findPoint(S.graph, S.sel.id);
        if (p) { var q = clampG({ gx: p.gx + dx, gy: p.gy + dy }); p.gx = q.gx; p.gy = q.gy; }
      } else if (S.sel.type === 'handle') {
        var seg = S.graph[S.sel.which];
        if (seg) { var e = clampG({ gx: seg[S.sel.end].gx + dx, gy: seg[S.sel.end].gy + dy }); seg[S.sel.end] = e; }
      } else if (S.sel.type === 'vertex' && S.graph.triangle && S.graph.line) {
        var v = S.graph.triangle[S.sel.end];
        var step = dx || dy;
        var gy = GR.lineY(S.graph.line, v.gx + step);
        if (gy !== null) S.graph.triangle[S.sel.end] = clampG({ gx: v.gx + step, gy: gy });
      }
      clearTimeout(S.nudgeTimer);
      S.nudgeTimer = setTimeout(function () { if (S.hist.end()) changed(); }, 600);
      scheduleDraw();
    }

    function onCanvasKeyDown(ev) {
      if (ev.ctrlKey && !ev.metaKey && !ev.altKey && /^Arrow/.test(ev.key)) {
        // Ctrl+arrow: one large square
      } else if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        return;
      }
      var key = ev.key;
      var handled = true;
      var big = ev.ctrlKey ? S.graph.grid.small : ev.shiftKey ? 1 : 0.1;
      if (readOnly) {
        if (key === 'm' || key === 'M') toggleLoupe();
        else handled = false;
      } else if (key === 'ArrowLeft') nudge(-big, 0);
      else if (key === 'ArrowRight') nudge(big, 0);
      else if (key === 'ArrowUp') nudge(0, big);
      else if (key === 'ArrowDown') nudge(0, -big);
      else if (key === 'n' || key === 'N') cycle(ev.shiftKey ? -1 : 1);
      else if (key === 'Escape') {
        if (S.drag) { endDrag(true); say('Cancelled.'); }
        else if (S.pendingVertex) { S.pendingVertex = null; say('Corner cleared.'); }
        else if (S.sel) { S.sel = null; say('Nothing selected. Arrow keys now move the cross-hair.'); renderPanelIfPlot(); }
        else handled = false;
      } else if (key === 'Delete' || key === 'Backspace') {
        if (S.sel) deleteSelected();
        else handled = false;
      } else if (key === 'Enter' || key === ' ') {
        keyActivate();
      } else if (key === 'm' || key === 'M') {
        toggleLoupe();
      } else handled = false;
      if (handled) {
        // keyboard mode: the magnifier follows the selection / cross-hair until the pointer is used again
        S.kbd = true;
        S.hover = null;
        ev.preventDefault();
        ev.stopPropagation();
        scheduleDraw();
      }
    }

    function keyActivate() {
      S.kbd = true;
      if (!S.cursor) S.cursor = { gx: nx() / 2, gy: ny() / 2 };
      switch (S.mode) {
        case 'plot':
          if (S.sel) { S.sel = null; say('Cross deselected. Arrow keys move the cross-hair; Enter places the next cross.'); renderPanel(); }
          else if (targetRow()) placeCross(clampG(S.cursor));
          else say('Every row with numbers has been plotted.');
          break;
        case 'line':
          if (!S.graph.line) placeDefaultLine('line');
          else cycle(1);
          break;
        case 'worst':
          if (!S.graph.worstLine) placeDefaultLine('worstLine');
          else cycle(1);
          break;
        case 'gradient':
          if (!S.graph.line) say('Draw your line first (Line tool).');
          else if (!S.graph.triangle) placeDefaultTriangle();
          else cycle(1);
          break;
        case 'anomaly':
          if (S.sel && S.sel.type === 'point') {
            var id = S.sel.id;
            commit(function (g) { var q = GR.findPoint(g, id); if (q) q.anomaly = !q.anomaly; });
            var p = GR.findPoint(S.graph, id);
            say(p && p.anomaly ? 'Point circled as anomalous.' : 'Circle removed.');
            renderPanel();
          } else {
            cycle(1);
          }
          break;
        case 'erase':
          if (S.sel) deleteSelected();
          else cycle(1);
          break;
      }
    }

    function onRootKeyDown(ev) {
      var mod = ev.ctrlKey || ev.metaKey;
      var k = (ev.key || '').toLowerCase();
      if (mod && !ev.altKey && !readOnly) {
        if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); api.undo(); return; }
        if ((k === 'z' && ev.shiftKey) || k === 'y') { ev.preventDefault(); ev.stopPropagation(); api.redo(); return; }
      }
      if (!mod && !ev.altKey && k === 'm' && ev.target !== canvas && !(ui.isTyping && ui.isTyping(ev))) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleLoupe();
      }
    }

    /* ================================================================ wiring */

    var offs = [];
    offs.push(ui.on(canvas, 'pointerdown', onPointerDown));
    offs.push(ui.on(canvas, 'pointermove', onPointerMove));
    offs.push(ui.on(canvas, 'pointerup', onPointerUp));
    offs.push(ui.on(canvas, 'pointercancel', onPointerCancel));
    offs.push(ui.on(canvas, 'pointerleave', onPointerLeave));
    offs.push(ui.on(canvas, 'keydown', onCanvasKeyDown));
    offs.push(ui.on(canvas, 'focus', function () { S.focused = true; scheduleDraw(); }));
    offs.push(ui.on(canvas, 'blur', function () { S.focused = false; S.kbd = false; scheduleDraw(); }));
    offs.push(ui.on(canvas, 'contextmenu', function (ev) { if (!readOnly) ev.preventDefault(); }));
    offs.push(ui.on(root, 'keydown', onRootKeyDown));

    var ro = null;
    if (typeof globalThis.ResizeObserver === 'function') {
      ro = new globalThis.ResizeObserver(function () {
        if (wrap.clientWidth !== S.lastWidth) scheduleDraw();
      });
      ro.observe(wrap);
    } else {
      offs.push(ui.on(globalThis, 'resize', scheduleDraw));
    }
    var mo = null;
    if (typeof globalThis.MutationObserver === 'function') {
      mo = new globalThis.MutationObserver(function () { scheduleDraw(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    }
    var tableTimer = 0;
    if (ui.bus) {
      offs.push(ui.bus.on('table:changed', function (d) {
        if (d && d.table && d.table !== S.table) return;
        clearTimeout(tableTimer);
        tableTimer = setTimeout(function () {
          var typing = root.contains(document.activeElement) && ui.isTyping && ui.isTyping({ target: document.activeElement });
          if (!typing) { renderAxes(); renderPanel(); }
          ensurePlotTarget();
          renderHints();
          scheduleDraw();
        }, 200);
      }));
    }

    function afterHistory(did, word) {
      S.editing = false;
      S.drag = null;
      S.pendingVertex = null;
      if (S.sel && !selectedPos()) S.sel = null;
      renderAxes();
      renderPanel();
      ensurePlotTarget();
      say(did ? (word === 'undo' ? 'Undone.' : 'Redone.') : 'Nothing to ' + word + '.');
      if (did) changed();
      else updateButtons();
      scheduleDraw();
    }

    var api = {
      el: root,
      canvas: canvas,
      /**
       * Testing helper (e2e): viewport (client) coordinates of a grid position in small squares, or null before
       * the first layout. Never shown to the student.
       */
      gridToClient: function (gx, gy) {
        if (!S.L) return null;
        var r = canvas.getBoundingClientRect();
        return { x: r.left + X(S.L, gx), y: r.top + Y(S.L, gy) };
      },
      /** Testing helper (e2e): whether the last frame drew the magnifier loupe. */
      loupeShown: function () { return !!S.loupeDrawn; },
      /**
       * Draw the graph now without the magnifier, the selection, hover or the keyboard cross-hair (for exports).
       * @returns {HTMLCanvasElement}
       */
      renderClean: function () {
        draw({ clean: true });
        return canvas;
      },
      /** Undo the last graph change. */
      undo: function () {
        if (readOnly) return false;
        clearTimeout(S.nudgeTimer);
        S.editing = false;
        var did = S.hist.undo();
        afterHistory(did, 'undo');
        return did;
      },
      /** Redo the last undone graph change. */
      redo: function () {
        if (readOnly) return false;
        clearTimeout(S.nudgeTimer);
        finishEditing();
        var did = S.hist.redo();
        afterHistory(did, 'redo');
        return did;
      },
      /** Redraw, optionally switching graph and/or table (history resets when the graph changes). */
      refresh: function (newGraph, newTable) {
        if (newGraph && newGraph !== S.graph) {
          S.graph = newGraph;
          S.hist.reset(newGraph);
          S.axesOpen = !axesReady(newGraph);
          S.sel = null;
          S.pendingVertex = null;
          S.editing = false;
        }
        if (newTable) S.table = newTable;
        renderAxes();
        renderPanel();
        ensurePlotTarget();
        renderHints();
        updateButtons();
        S.lastWidth = 0;
        scheduleDraw();
      },
      /** Remove the view and all listeners. */
      destroy: function () {
        clearTimeout(S.nudgeTimer);
        clearTimeout(tableTimer);
        if (S.raf) {
          var caf = globalThis.cancelAnimationFrame || clearTimeout;
          caf(S.raf);
        }
        offs.forEach(function (off) { off(); });
        if (ro) ro.disconnect();
        if (mo) mo.disconnect();
        if (S.mode === 'plot' && ui.bus) ui.bus.emit('graph:plotRow', { rowId: null });
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };

    renderAxes();
    renderPanel();
    ensurePlotTarget();
    renderHints();
    updateButtons();
    draw();
    scheduleDraw();
    return api;
  }

  ui.graphView = { mount: mount };
})(globalThis.VLab = globalThis.VLab || {});
