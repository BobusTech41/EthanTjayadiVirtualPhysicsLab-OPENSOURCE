/**
 * Exam-style results table (browser only). docs/ARCHITECTURE.md §9.
 *
 *   VL.ui.tableView.mount(container, table, { readOnly, hints, onChange(table), onFocusCell(target) })
 *     -> { destroy(), writeToSelected(str) -> bool, undo(), redo(), refresh(table?), el }
 *
 * The student types headings ("quantity / unit") and readings; every string is stored exactly as typed and
 * never reformatted. Nothing is ever filled in for the student.
 *
 * Keyboard: Enter / Shift+Enter = down / up, Tab / Shift+Tab = across, arrow keys between cells (left/right
 * only when the caret is at the edge of the text), Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo,
 * Shift+F10 or the context-menu key = column/row actions for the selected cell.
 *
 * Bus: listens to 'graph:plotRow' ({ rowId }) to highlight the row the graph view is plotting;
 * emits 'table:changed' ({ table }) after every change.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var WARN_ICON = '\u26a0';   // ⚠
  var INFO_ICON = '\u2139';   // ℹ

  /**
   * Mount a table view.
   * @param {HTMLElement} container
   * @param {object} table VL.datatable Table (mutated in place)
   * @param {{readOnly?: boolean, hints?: boolean, onChange?: function(object), onFocusCell?: function(object)}} [opts]
   */
  function mount(container, table, opts) {
    opts = opts || {};
    var h = ui.h;
    var DT = VL.datatable;
    var readOnly = !!opts.readOnly;
    var hintsOn = !!opts.hints && !readOnly;

    var S = {
      table: table,
      hist: DT.history(table),
      sel: null,              // { kind: 'cell'|'heading', rowId?, colId }
      plotRowId: null,
      lint: [],
      hintsOpen: true,
      menu: null,
      lintTimer: null,
      flashTimer: null
    };

    /* ---------------------------------------------------------------- skeleton */

    var root = h('div', { class: 'vt-root' + (readOnly ? ' vt-root--readonly' : '') });
    var toolbar = readOnly ? null : h('div', { class: 'vt-toolbar', role: 'toolbar', 'aria-label': 'Table tools' });
    var selInfo = h('p', { class: 'vt-selinfo', id: uid('vt-selinfo') });
    var status = h('p', { class: 'vt-status', role: 'status', 'aria-live': 'polite' });
    var scroller = h('div', { class: 'vt-scroll' });
    var hintsBox = h('div', { class: 'vt-hints-wrap' });
    var buttons = {};

    function btn(key, label, title, onClick, extraClass) {
      var b = h('button', {
        type: 'button', class: 'vt-btn' + (extraClass ? ' ' + extraClass : ''), title: title,
        'aria-label': title, on: { click: onClick }
      }, label);
      buttons[key] = b;
      return b;
    }

    if (toolbar) {
      toolbar.appendChild(h('div', { class: 'vt-group', role: 'group', 'aria-label': 'Add' },
        btn('addRow', '+ Row', 'Add a row at the bottom', function () { addRowAt(S.table.rows.length, true); }),
        btn('addCol', '+ Column', 'Add a column at the right', function () { addColumnAt(S.table.columns.length); })));
      toolbar.appendChild(h('div', { class: 'vt-group', role: 'group', 'aria-label': 'Selected cell' },
        btn('colMenu', 'Column \u25be', 'Actions for the selected column', function (ev) {
          openMenu(columnItems(), { anchor: ev.currentTarget, label: 'Column actions' });
        }),
        btn('rowMenu', 'Row \u25be', 'Actions for the selected row', function (ev) {
          openMenu(rowItems(), { anchor: ev.currentTarget, label: 'Row actions' });
        })));
      toolbar.appendChild(h('div', { class: 'vt-group', role: 'group', 'aria-label': 'History' },
        btn('undo', '\u21b6 Undo', 'Undo (Ctrl+Z)', function () { api.undo(); }),
        btn('redo', '\u21b7 Redo', 'Redo (Ctrl+Shift+Z or Ctrl+Y)', function () { api.redo(); })));
    }
    if (canExport()) {
      var exportGroup = h('div', { class: 'vt-group', role: 'group', 'aria-label': 'Export' },
        btn('csv', 'Export CSV', 'Download the table as a CSV file', exportCSV));
      if (toolbar) toolbar.appendChild(exportGroup);
      else root.appendChild(h('div', { class: 'vt-toolbar' }, exportGroup));
    }

    if (toolbar) root.appendChild(toolbar);
    if (!readOnly) root.appendChild(h('div', { class: 'vt-infobar' }, selInfo, status));
    root.appendChild(scroller);
    if (hintsOn) root.appendChild(hintsBox);
    container.appendChild(root);

    /* ---------------------------------------------------------------- helpers */

    function uid(prefix) {
      mount.counter = (mount.counter || 0) + 1;
      return prefix + '-' + mount.counter;
    }

    function canExport() {
      return !!(VL.export && typeof VL.export.tableToCSV === 'function' && typeof VL.export.download === 'function');
    }

    function colIdx(colId) {
      for (var i = 0; i < S.table.columns.length; i++) if (S.table.columns[i].id === colId) return i;
      return -1;
    }

    function rowIdx(rowId) {
      for (var i = 0; i < S.table.rows.length; i++) if (S.table.rows[i].id === rowId) return i;
      return -1;
    }

    /** Text used for a column in labels: its heading, or "column N". */
    function colName(colId) {
      var i = colIdx(colId);
      if (i < 0) return 'column';
      var hd = S.table.columns[i].heading.trim();
      return hd || 'column ' + (i + 1);
    }

    function cellLabel(rowId, colId) {
      return 'row ' + (rowIdx(rowId) + 1) + ', ' + colName(colId);
    }

    function say(msg) {
      status.textContent = msg || '';
    }

    function changed(structural) {
      if (typeof opts.onChange === 'function') {
        try { opts.onChange(S.table); } catch (e) { console.error('[tableView onChange]', e); }
      }
      if (ui.bus) ui.bus.emit('table:changed', { table: S.table });
      if (structural) runLint();
      else scheduleLint();
      updateButtons();
    }

    /* ---------------------------------------------------------------- rendering */

    var tableEl = null;

    function render() {
      var active = document.activeElement;
      var hadFocus = !!(active && root.contains(active) && tableEl && tableEl.contains(active));
      var scrollLeft = scroller.scrollLeft;
      ui.clear(scroller);
      tableEl = h('table', { class: 'vt-table' });
      tableEl.appendChild(h('caption', { class: 'vt-sr' },
        readOnly ? 'Results table' : 'Your results table. Type each heading as quantity / unit in the first row.'));

      var headRow = h('tr', null, h('th', { scope: 'col', class: 'vt-corner' }, h('span', { class: 'vt-sr' }, 'Row')));
      S.table.columns.forEach(function (col, ci) {
        var th = h('th', { scope: 'col', class: 'vt-head', dataset: { colId: col.id } });
        if (readOnly) {
          th.appendChild(h('span', { class: 'vt-text vt-text--head' }, col.heading));
        } else {
          var inp = h('input', {
            type: 'text', class: 'vt-input vt-input--head', placeholder: 'quantity / unit',
            autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off',
            'aria-label': 'Heading of column ' + (ci + 1),
            dataset: { kind: 'heading', colId: col.id }
          });
          inp.value = col.heading;
          th.appendChild(inp);
        }
        headRow.appendChild(th);
      });
      tableEl.appendChild(h('thead', null, headRow));

      var tbody = h('tbody');
      S.table.rows.forEach(function (row, ri) {
        var tr = h('tr', { dataset: { rowId: row.id } });
        tr.appendChild(h('th', { scope: 'row', class: 'vt-rownum' },
          h('span', { class: 'vt-rowmark', 'aria-hidden': 'true' }, '\u25b6'), String(ri + 1)));
        S.table.columns.forEach(function (col) {
          var td = h('td', { class: 'vt-cell', dataset: { rowId: row.id, colId: col.id } });
          var v = DT.getCell(S.table, row.id, col.id);
          if (readOnly) {
            td.appendChild(h('span', { class: 'vt-text' }, v));
          } else {
            var inp = h('input', {
              type: 'text', class: 'vt-input', autocomplete: 'off', spellcheck: 'false',
              autocapitalize: 'off', autocorrect: 'off',
              'aria-label': 'Row ' + (ri + 1) + ', ' + colName(col.id),
              dataset: { kind: 'cell', rowId: row.id, colId: col.id }
            });
            inp.value = v;
            td.appendChild(inp);
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      tableEl.appendChild(tbody);

      if (!S.table.columns.length || !S.table.rows.length) {
        scroller.appendChild(h('p', { class: 'vt-empty' }, readOnly ? 'The table is empty.'
          : 'The table has no ' + (!S.table.columns.length ? 'columns' : 'rows') + '. Use \u201c+ Column\u201d and ' +
            '\u201c+ Row\u201d to add some.'));
      }
      scroller.appendChild(tableEl);
      scroller.scrollLeft = scrollLeft;

      // keep the selection valid
      if (S.sel && (colIdx(S.sel.colId) < 0 || (S.sel.kind === 'cell' && rowIdx(S.sel.rowId) < 0))) S.sel = null;
      applySelectionClasses();
      applyPlotHighlight();
      applyLintMarks();
      if (hadFocus && S.sel) focusSel(false);
      updateButtons();
    }

    function inputFor(sel) {
      if (!tableEl || !sel) return null;
      var q = sel.kind === 'heading'
        ? 'input[data-kind="heading"][data-col-id="' + cssEsc(sel.colId) + '"]'
        : 'input[data-kind="cell"][data-row-id="' + cssEsc(sel.rowId) + '"][data-col-id="' + cssEsc(sel.colId) + '"]';
      return tableEl.querySelector(q);
    }

    function cssEsc(s) {
      return String(s).replace(/["\\]/g, '\\$&');
    }

    function applySelectionClasses() {
      if (!tableEl) return;
      Array.prototype.forEach.call(tableEl.querySelectorAll('.vt-cell--selected, .vt-head--selected, .vt-col--selected'),
        function (el) { el.classList.remove('vt-cell--selected', 'vt-head--selected', 'vt-col--selected'); });
      if (!S.sel) { selInfo.textContent = readOnly ? '' : 'Select a cell to record a reading into it.'; return; }
      var inp = inputFor(S.sel);
      if (inp && inp.parentNode) inp.parentNode.classList.add(S.sel.kind === 'heading' ? 'vt-head--selected' : 'vt-cell--selected');
      selInfo.textContent = S.sel.kind === 'cell'
        ? 'Selected: ' + cellLabel(S.sel.rowId, S.sel.colId)
        : 'Selected: heading of column ' + (colIdx(S.sel.colId) + 1);
    }

    function applyPlotHighlight() {
      if (!tableEl) return;
      Array.prototype.forEach.call(tableEl.querySelectorAll('tr.vt-row--plot'), function (tr) {
        tr.classList.remove('vt-row--plot');
      });
      if (!S.plotRowId) return;
      var tr = tableEl.querySelector('tr[data-row-id="' + cssEsc(S.plotRowId) + '"]');
      if (tr) tr.classList.add('vt-row--plot');
    }

    /* ---------------------------------------------------------------- selection & focus */

    function select(sel, notify) {
      S.sel = sel;
      applySelectionClasses();
      updateButtons();
      if (notify && sel && sel.kind === 'cell' && typeof opts.onFocusCell === 'function') {
        try { opts.onFocusCell(makeTarget(sel.rowId, sel.colId)); } catch (e) { console.error('[tableView onFocusCell]', e); }
      }
    }

    /** Record target for VL record flow: { kind: 'cell', tab: 'table', label, write(str), current() }. */
    function makeTarget(rowId, colId) {
      return {
        kind: 'cell',
        tab: 'table',
        label: cellLabel(rowId, colId),
        rowId: rowId,
        colId: colId,
        /** The cell's present text ('' when the row or column has gone). */
        current: function () { return rowIdx(rowId) >= 0 && colIdx(colId) >= 0 ? DT.getCell(S.table, rowId, colId) : ''; },
        write: function (str) { return writeCell(rowId, colId, str); }
      };
    }

    function writeCell(rowId, colId, str) {
      if (readOnly || rowIdx(rowId) < 0 || colIdx(colId) < 0) return false;
      S.hist.seal();
      S.hist.apply({ type: 'setCell', rowId: rowId, colId: colId, value: String(str === undefined ? '' : str) });
      S.hist.seal();
      var inp = inputFor({ kind: 'cell', rowId: rowId, colId: colId });
      if (inp) {
        inp.value = DT.getCell(S.table, rowId, colId);
        var td = inp.parentNode;
        td.classList.remove('vt-cell--flash');
        void td.offsetWidth;                      // restart the animation
        td.classList.add('vt-cell--flash');
        clearTimeout(S.flashTimer);
        S.flashTimer = setTimeout(function () { td.classList.remove('vt-cell--flash'); }, 1200);
      }
      say('Recorded \u201c' + str + '\u201d in ' + cellLabel(rowId, colId) + '.');
      changed(false);
      return true;
    }

    function focusSel(selectText) {
      var inp = inputFor(S.sel);
      if (!inp) return;
      inp.focus({ preventScroll: false });
      if (selectText) { try { inp.select(); } catch (e) { /* ignore */ } }
    }

    /** Move the selection by (dRow, dCol); row -1 is the heading row. */
    function move(dRow, dCol) {
      if (!S.sel) return;
      var r = S.sel.kind === 'heading' ? -1 : rowIdx(S.sel.rowId);
      var c = colIdx(S.sel.colId);
      var nr = Math.max(-1, Math.min(S.table.rows.length - 1, r + dRow));
      var nc = Math.max(0, Math.min(S.table.columns.length - 1, c + dCol));
      if (nr === r && nc === c) return;
      var colId = S.table.columns[nc].id;
      S.sel = nr < 0 ? { kind: 'heading', colId: colId } : { kind: 'cell', rowId: S.table.rows[nr].id, colId: colId };
      focusSel(true);
    }

    /* ---------------------------------------------------------------- structural actions */

    function apply(op, msg) {
      var res;
      try {
        S.hist.seal();
        res = S.hist.apply(op);
      } catch (e) {
        say('That change could not be made.');
        console.error('[tableView]', e);
        return null;
      }
      render();
      if (msg) say(msg);
      changed(true);
      return res;
    }

    function addRowAt(index, focusNew) {
      var row = apply({ type: 'addRow', index: index }, 'Row ' + (index + 1) + ' added.');
      if (row && focusNew && S.table.columns.length) {
        S.sel = { kind: 'cell', rowId: row.id, colId: (S.sel && colIdx(S.sel.colId) >= 0 ? S.sel.colId : S.table.columns[0].id) };
        render();
        focusSel(true);                // focusin notifies onFocusCell
      }
    }

    function addColumnAt(index) {
      var col = apply({ type: 'addColumn', heading: '', index: index }, 'Column ' + (index + 1) + ' added.');
      if (col) {
        S.sel = { kind: 'heading', colId: col.id };
        render();
        focusSel(true);
      }
    }

    function columnItems() {
      var c = S.sel ? colIdx(S.sel.colId) : -1;
      var none = c < 0;
      var colId = none ? null : S.sel.colId;
      return [
        { heading: none ? 'Select a cell first' : 'Column ' + (c + 1) + (colName(colId) !== 'column ' + (c + 1) ? ' (' + colName(colId) + ')' : '') },
        { label: 'Insert column to the left', disabled: none, action: function () { addColumnAt(c); } },
        { label: 'Insert column to the right', disabled: none, action: function () { addColumnAt(c + 1); } },
        { label: 'Move column left', disabled: none || c === 0,
          action: function () { apply({ type: 'moveColumn', colId: colId, index: c - 1 }, 'Column moved left.'); focusSel(false); } },
        { label: 'Move column right', disabled: none || c >= S.table.columns.length - 1,
          action: function () { apply({ type: 'moveColumn', colId: colId, index: c + 1 }, 'Column moved right.'); focusSel(false); } },
        { label: 'Delete column', danger: true, disabled: none, action: function () { deleteColumn(colId); } }
      ];
    }

    function rowItems() {
      var r = S.sel && S.sel.kind === 'cell' ? rowIdx(S.sel.rowId) : -1;
      var none = r < 0;
      var rowId = none ? null : S.sel.rowId;
      return [
        { heading: none ? 'Select a cell in a row first' : 'Row ' + (r + 1) },
        { label: 'Insert row above', disabled: none, action: function () { addRowAt(r, true); } },
        { label: 'Insert row below', disabled: none, action: function () { addRowAt(r + 1, true); } },
        { label: 'Move row up', disabled: none || r === 0,
          action: function () { apply({ type: 'moveRow', rowId: rowId, index: r - 1 }, 'Row moved up.'); focusSel(false); } },
        { label: 'Move row down', disabled: none || r >= S.table.rows.length - 1,
          action: function () { apply({ type: 'moveRow', rowId: rowId, index: r + 1 }, 'Row moved down.'); focusSel(false); } },
        { label: 'Delete row', danger: true, disabled: none, action: function () { deleteRow(rowId); } }
      ];
    }

    function deleteColumn(colId) {
      var c = colIdx(colId);
      var name = colName(colId);
      var keepRow = S.sel && S.sel.kind === 'cell' ? S.sel.rowId : null;
      apply({ type: 'removeColumn', colId: colId }, 'Deleted ' + name + '. Press Ctrl+Z to undo.');
      if (S.table.columns.length) {
        var nc = S.table.columns[Math.min(c, S.table.columns.length - 1)].id;
        S.sel = keepRow ? { kind: 'cell', rowId: keepRow, colId: nc } : { kind: 'heading', colId: nc };
        render();
        focusSel(false);
      }
    }

    function deleteRow(rowId) {
      var r = rowIdx(rowId);
      var colId = S.sel ? S.sel.colId : null;
      apply({ type: 'removeRow', rowId: rowId }, 'Deleted row ' + (r + 1) + '. Press Ctrl+Z to undo.');
      if (S.table.rows.length && colId && colIdx(colId) >= 0) {
        S.sel = { kind: 'cell', rowId: S.table.rows[Math.min(r, S.table.rows.length - 1)].id, colId: colId };
        render();
        focusSel(false);
      }
    }

    function updateButtons() {
      if (buttons.undo) buttons.undo.disabled = !S.hist.canUndo();
      if (buttons.redo) buttons.redo.disabled = !S.hist.canRedo();
      if (buttons.colMenu) buttons.colMenu.disabled = !S.sel;
      if (buttons.rowMenu) buttons.rowMenu.disabled = !(S.sel && S.sel.kind === 'cell');
    }

    /* ---------------------------------------------------------------- menu */

    function openMenu(items, o) {
      closeMenu();
      var returnFocus = o.returnFocus || document.activeElement;
      var menu = h('div', { class: 'vt-menu', role: 'menu', 'aria-label': o.label || 'Actions' });
      var entries = [];
      items.forEach(function (it) {
        if (it.separator) { menu.appendChild(h('div', { class: 'vt-menu-sep', role: 'separator' })); return; }
        if (it.heading) { menu.appendChild(h('div', { class: 'vt-menu-heading', role: 'presentation' }, it.heading)); return; }
        var b = h('button', {
          type: 'button', role: 'menuitem', tabindex: '-1', disabled: !!it.disabled,
          class: 'vt-menu-item' + (it.danger ? ' vt-menu-item--danger' : ''),
          on: { click: function () { closeMenu(true); it.action(); } }
        }, it.label);
        menu.appendChild(b);
        if (!it.disabled) entries.push(b);
      });
      menu.addEventListener('keydown', function (ev) {
        var i = entries.indexOf(document.activeElement);
        if (ev.key === 'ArrowDown') { ev.preventDefault(); if (entries.length) entries[(i + 1) % entries.length].focus(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (entries.length) entries[(i - 1 + entries.length) % entries.length].focus(); }
        else if (ev.key === 'Home') { ev.preventDefault(); if (entries.length) entries[0].focus(); }
        else if (ev.key === 'End') { ev.preventDefault(); if (entries.length) entries[entries.length - 1].focus(); }
        else if (ev.key === 'Escape' || ev.key === 'Tab') {
          ev.preventDefault();
          closeMenu();
          if (returnFocus && returnFocus.focus) returnFocus.focus();
        }
        ev.stopPropagation();
      });
      document.body.appendChild(menu);
      // position (fixed, kept inside the viewport)
      var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      var x, y;
      if (o.x !== undefined) { x = o.x; y = o.y; }
      else {
        var r = o.anchor.getBoundingClientRect();
        x = r.left; y = r.bottom + 4;
      }
      var mr = menu.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(x, vw - mr.width - 8)) + 'px';
      menu.style.top = Math.max(8, (y + mr.height > vh - 8 ? Math.max(8, y - mr.height - 8) : y)) + 'px';
      var outside = function (ev) { if (!menu.contains(ev.target)) closeMenu(); };
      setTimeout(function () { document.addEventListener('pointerdown', outside, true); }, 0);
      S.menu = { el: menu, outside: outside, returnFocus: returnFocus };
      if (entries.length) {
        entries[0].focus();
      } else {
        menu.setAttribute('tabindex', '-1');
        menu.focus();
      }
    }

    function closeMenu(keepFocus) {
      if (!S.menu) return;
      document.removeEventListener('pointerdown', S.menu.outside, true);
      if (S.menu.el.parentNode) S.menu.el.parentNode.removeChild(S.menu.el);
      var rf = S.menu.returnFocus;
      S.menu = null;
      if (keepFocus && rf && rf.focus && document.body.contains(rf)) rf.focus();
    }

    function contextItems() {
      return columnItems().concat([{ separator: true }], rowItems());
    }

    /* ---------------------------------------------------------------- lint (practice hints) */

    function scheduleLint() {
      if (!hintsOn) return;
      clearTimeout(S.lintTimer);
      S.lintTimer = setTimeout(runLint, 400);
    }

    function runLint() {
      if (!hintsOn) return;
      clearTimeout(S.lintTimer);
      try { S.lint = DT.lint(S.table); } catch (e) { S.lint = []; console.error('[tableView lint]', e); }
      applyLintMarks();
      renderHints();
    }

    function applyLintMarks() {
      if (!hintsOn || !tableEl) return;
      Array.prototype.forEach.call(tableEl.querySelectorAll('.vt-warnmark'), function (el) { el.parentNode.removeChild(el); });
      Array.prototype.forEach.call(tableEl.querySelectorAll('.vt-cell--warn, .vt-head--warn'), function (el) {
        el.classList.remove('vt-cell--warn', 'vt-head--warn');
      });
      S.lint.forEach(function (m) {
        if (m.level !== 'warn' || !m.colId) return;
        var inp = inputFor(m.rowId ? { kind: 'cell', rowId: m.rowId, colId: m.colId } : { kind: 'heading', colId: m.colId });
        if (!inp) return;
        var cell = inp.parentNode;
        if (cell.querySelector('.vt-warnmark')) return;
        cell.classList.add(m.rowId ? 'vt-cell--warn' : 'vt-head--warn');
        cell.appendChild(h('span', { class: 'vt-warnmark', title: m.message, 'aria-hidden': 'true' }, WARN_ICON));
      });
    }

    function renderHints() {
      ui.clear(hintsBox);
      if (!hintsOn || !S.lint.length) return;
      var nWarn = S.lint.filter(function (m) { return m.level === 'warn'; }).length;
      var details = h('details', { class: 'vt-hints' });
      details.open = S.hintsOpen;
      details.addEventListener('toggle', function () { S.hintsOpen = details.open; });
      details.appendChild(h('summary', { class: 'vt-hints-summary' },
        h('span', { 'aria-hidden': 'true' }, WARN_ICON + ' '),
        'Table hints (' + S.lint.length + (nWarn ? ', ' + nWarn + ' to check' : '') + ')'));
      var list = h('ul', { class: 'vt-hints-list' });
      S.lint.forEach(function (m) {
        var item = h('li', { class: 'vt-hint vt-hint--' + m.level },
          h('span', { class: 'vt-hint-icon', 'aria-hidden': 'true' }, m.level === 'warn' ? WARN_ICON : INFO_ICON),
          h('span', { class: 'vt-sr' }, m.level === 'warn' ? 'Check: ' : 'Note: '),
          h('span', { class: 'vt-hint-text' }, m.message));
        if (m.colId && colIdx(m.colId) >= 0) {
          var go = h('button', { type: 'button', class: 'vt-hint-go', on: { click: function () {
            S.sel = m.rowId && rowIdx(m.rowId) >= 0 ? { kind: 'cell', rowId: m.rowId, colId: m.colId } : { kind: 'heading', colId: m.colId };
            focusSel(true);
          } } }, 'Show');
          item.appendChild(go);
        }
        list.appendChild(item);
      });
      details.appendChild(list);
      hintsBox.appendChild(details);
    }

    /* ---------------------------------------------------------------- export */

    function exportCSV() {
      if (!canExport()) { say('Export is not available.'); return; }
      try {
        VL.export.download('results-table.csv', VL.export.tableToCSV(S.table), 'text/csv;charset=utf-8');
        say('Table exported as results-table.csv.');
      } catch (e) {
        console.error('[tableView export]', e);
        say('The table could not be exported.');
      }
    }

    /* ---------------------------------------------------------------- events */

    function onFocusIn(ev) {
      var t = ev.target;
      if (!t || !t.dataset || !t.dataset.kind) return;
      var sel = t.dataset.kind === 'heading' ? { kind: 'heading', colId: t.dataset.colId }
        : { kind: 'cell', rowId: t.dataset.rowId, colId: t.dataset.colId };
      select(sel, true);
    }

    function onFocusOut(ev) {
      if (ev.target && ev.target.dataset && ev.target.dataset.kind) S.hist.seal();
    }

    function onInput(ev) {
      var t = ev.target;
      if (!t || !t.dataset || !t.dataset.kind) return;
      try {
        if (t.dataset.kind === 'heading') {
          S.hist.apply({ type: 'setHeading', colId: t.dataset.colId, value: t.value, merge: true });
          // keep the aria-labels of the column's cells in step with its heading
          Array.prototype.forEach.call(tableEl.querySelectorAll('input[data-kind="cell"][data-col-id="' + cssEsc(t.dataset.colId) + '"]'),
            function (inp) { inp.setAttribute('aria-label', 'Row ' + (rowIdx(inp.dataset.rowId) + 1) + ', ' + colName(t.dataset.colId)); });
          applySelectionClasses();
        } else {
          S.hist.apply({ type: 'setCell', rowId: t.dataset.rowId, colId: t.dataset.colId, value: t.value, merge: true });
        }
      } catch (e) {
        console.error('[tableView input]', e);
        return;
      }
      changed(false);
    }

    function caretAt(inp, end) {
      try {
        if (inp.selectionStart !== inp.selectionEnd) return false;
        return end ? inp.selectionEnd === inp.value.length : inp.selectionStart === 0;
      } catch (e) {
        return true;
      }
    }

    function onTableKeyDown(ev) {
      var t = ev.target;
      if (!t || !t.dataset || !t.dataset.kind) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === 'Enter') { ev.preventDefault(); S.hist.seal(); move(ev.shiftKey ? -1 : 1, 0); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); S.hist.seal(); move(1, 0); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); S.hist.seal(); move(-1, 0); }
      else if (ev.key === 'ArrowLeft' && !ev.shiftKey && caretAt(t, false)) { ev.preventDefault(); S.hist.seal(); move(0, -1); }
      else if (ev.key === 'ArrowRight' && !ev.shiftKey && caretAt(t, true)) { ev.preventDefault(); S.hist.seal(); move(0, 1); }
      else if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
        ev.preventDefault();
        var r = t.getBoundingClientRect();
        openMenu(contextItems(), { x: r.left, y: r.bottom + 2, label: 'Table actions', returnFocus: t });
      }
    }

    function onContextMenu(ev) {
      if (readOnly) return;
      var t = ev.target;
      if (!t || !t.dataset || !t.dataset.kind) return;
      ev.preventDefault();
      t.focus();
      openMenu(contextItems(), { x: ev.clientX, y: ev.clientY, label: 'Table actions', returnFocus: t });
    }

    function onRootKeyDown(ev) {
      if (readOnly) return;
      var mod = ev.ctrlKey || ev.metaKey;
      if (!mod || ev.altKey) return;
      var k = (ev.key || '').toLowerCase();
      if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); api.undo(); }
      else if ((k === 'z' && ev.shiftKey) || k === 'y') { ev.preventDefault(); ev.stopPropagation(); api.redo(); }
    }

    var offs = [];
    if (!readOnly) {
      offs.push(ui.on(scroller, 'focusin', onFocusIn));
      offs.push(ui.on(scroller, 'focusout', onFocusOut));
      offs.push(ui.on(scroller, 'input', onInput));
      offs.push(ui.on(scroller, 'keydown', onTableKeyDown));
      offs.push(ui.on(scroller, 'contextmenu', onContextMenu));
      offs.push(ui.on(root, 'keydown', onRootKeyDown));
    }
    if (ui.bus) {
      offs.push(ui.bus.on('graph:plotRow', function (d) {
        S.plotRowId = d && d.rowId ? d.rowId : null;
        applyPlotHighlight();
      }));
    }

    /* ---------------------------------------------------------------- public API */

    /** Position of the selection, so it can fall back to the nearest cell if its row/column disappears. */
    function selPosition() {
      if (!S.sel) return null;
      return { r: S.sel.kind === 'heading' ? -1 : rowIdx(S.sel.rowId), c: colIdx(S.sel.colId) };
    }

    function afterHistory(did, word, pos) {
      if (!did) { say('Nothing to ' + word + '.'); updateButtons(); return; }
      var focusInside = root.contains(document.activeElement);
      if (pos && S.sel && (colIdx(S.sel.colId) < 0 || (S.sel.kind === 'cell' && rowIdx(S.sel.rowId) < 0)) &&
          S.table.columns.length) {
        var c = S.table.columns[Math.max(0, Math.min(pos.c, S.table.columns.length - 1))].id;
        var r = Math.min(pos.r, S.table.rows.length - 1);
        S.sel = r < 0 ? { kind: 'heading', colId: c } : { kind: 'cell', rowId: S.table.rows[r].id, colId: c };
      }
      render();
      if (focusInside && S.sel) focusSel(false);
      say(word === 'undo' ? 'Undone.' : 'Redone.');
      changed(true);
    }

    var api = {
      el: root,
      /** Undo the last change. */
      undo: function () {
        if (readOnly) return false;
        S.hist.seal();
        var pos = selPosition();
        var did = S.hist.undo();
        afterHistory(did, 'undo', pos);
        return did;
      },
      /** Redo the last undone change. */
      redo: function () {
        if (readOnly) return false;
        var pos = selPosition();
        var did = S.hist.redo();
        afterHistory(did, 'redo', pos);
        return did;
      },
      /**
       * Write a recorded reading into the selected cell (replacing its contents).
       * @returns {boolean} false when no data cell is selected or the view is read-only
       */
      writeToSelected: function (str) {
        if (readOnly || !S.sel || S.sel.kind !== 'cell') return false;
        return writeCell(S.sel.rowId, S.sel.colId, str);
      },
      /** Re-render, optionally switching to another table (history is reset when the table changes). */
      refresh: function (newTable) {
        if (newTable && newTable !== S.table) {
          S.table = newTable;
          S.hist.reset(newTable);
          S.sel = null;
        }
        render();
        runLint();
      },
      /** Remove the view and its listeners. */
      destroy: function () {
        closeMenu();
        clearTimeout(S.lintTimer);
        clearTimeout(S.flashTimer);
        offs.forEach(function (off) { off(); });
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };

    render();
    runLint();
    return api;
  }

  ui.tableView = { mount: mount };
})(globalThis.VLab = globalThis.VLab || {});
