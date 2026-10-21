/* Tests for core/datatable.js (VL.datatable). */
(function () {
  'use strict';
  var VL = globalThis.VLab;
  var DT = VL.datatable;

  /** Build a table from headings and row arrays of strings. */
  function make(headings, rows) {
    var t = DT.create({ columns: headings.length, rows: rows.length });
    headings.forEach(function (h, i) { DT.setHeading(t, t.columns[i].id, h); });
    rows.forEach(function (r, ri) {
      r.forEach(function (s, ci) { DT.setCell(t, t.rows[ri].id, t.columns[ci].id, s); });
    });
    return t;
  }

  test('create: default 3 columns × 7 rows, empty, unique ids', function () {
    var t = DT.create();
    assert.equal(t.columns.length, 3);
    assert.equal(t.rows.length, 7);
    t.columns.forEach(function (c) { assert.equal(c.heading, ''); });
    t.rows.forEach(function (r) { assert.deepEqual(r.cells, {}); });
    var ids = t.columns.map(function (c) { return c.id; }).concat(t.rows.map(function (r) { return r.id; }));
    assert.equal(ids.length, new Set(ids).size, 'ids unique');
    assert.equal(t.columns[0].id, 'c1');
    assert.equal(t.rows[0].id, 'r1');
    assert.ok(t.nextId >= 8, 'nextId beyond existing ids');
    var t2 = DT.create({ columns: 1, rows: 1 });
    assert.deepEqual(DT.toJSON(t2), { columns: [{ id: 'c1', heading: '' }], rows: [{ id: 'r1', cells: {} }], nextId: 2 });
  });

  test('cells keep the exact strings typed', function () {
    var t = DT.create({ columns: 2, rows: 2 });
    var r = t.rows[0].id, c = t.columns[0].id;
    DT.setCell(t, r, c, '0.50');
    assert.equal(DT.getCell(t, r, c), '0.50');
    DT.setCell(t, r, c, ' 12.0 ');
    assert.equal(DT.getCell(t, r, c), ' 12.0 ', 'white space is not trimmed');
    DT.setCell(t, r, c, '1.20×10^-3');
    assert.equal(DT.getCell(t, r, c), '1.20×10^-3');
    assert.equal(DT.getCell(t, t.rows[1].id, c), '', 'missing cell is empty string');
    assert.equal(DT.getCell(t, 'nope', c), '', 'unknown row is empty string');
    DT.setCell(t, r, c, '');
    assert.ok(!Object.prototype.hasOwnProperty.call(t.rows[0].cells, c), 'empty removes entry');
    assert.throws(function () { DT.setCell(t, 'r999', c, '1'); }, 'unknown row throws');
    assert.throws(function () { DT.setCell(t, r, 'c999', '1'); }, 'unknown column throws');
  });

  test('add / remove / move columns and rows', function () {
    var t = make(['a', 'b', 'c'], [['1', '2', '3'], ['4', '5', '6']]);
    var col = DT.addColumn(t, 'new', 1);
    assert.equal(t.columns[1].id, col.id);
    assert.equal(col.heading, 'new');
    var end = DT.addColumn(t);
    assert.equal(t.columns[t.columns.length - 1].id, end.id);
    assert.equal(end.heading, '');
    var bId = t.columns[2].id;
    var removed = DT.removeColumn(t, bId);
    assert.equal(removed.index, 2);
    assert.equal(removed.cells[t.rows[0].id], '2');
    assert.ok(t.rows.every(function (r) { return !(bId in r.cells); }), 'cells of removed column deleted');
    var aId = t.columns[0].id;
    var prev = DT.moveColumn(t, aId, 99);
    assert.equal(prev, 0);
    assert.equal(t.columns[t.columns.length - 1].id, aId, 'clamped to the end');
    var row = DT.addRow(t, 0);
    assert.equal(t.rows[0].id, row.id);
    assert.deepEqual(row.cells, {});
    var r2 = t.rows[2].id;
    DT.moveRow(t, r2, 0);
    assert.equal(t.rows[0].id, r2);
    var rr = DT.removeRow(t, r2);
    assert.equal(rr.index, 0);
    assert.equal(rr.row.id, r2);
    assert.equal(t.rows.length, 2);
    var ids = t.columns.map(function (c) { return c.id; }).concat(t.rows.map(function (r) { return r.id; }));
    assert.equal(ids.length, new Set(ids).size, 'ids stay unique');
  });

  test('columnValues returns non-empty cells only with parsed numbers', function () {
    var t = make(['L / cm', 'T / s'], [['50.0', '1.42'], ['', '1.20'], ['  ', 'x'], ['70.0', '']]);
    var vals = DT.columnValues(t, t.columns[0].id);
    assert.equal(vals.length, 2);
    assert.equal(vals[0].rowId, t.rows[0].id);
    assert.equal(vals[0].str, '50.0');
    assert.ok(vals[0].num.ok);
    assert.close(vals[0].num.value, 50, 1e-12);
    assert.equal(vals[0].num.dp, 1);
    var tv = DT.columnValues(t, t.columns[1].id);
    assert.equal(tv.length, 3);
    assert.equal(tv[2].num.ok, false, '"x" is not a number');
  });

  test('filledRows ignores blank and white-space-only rows', function () {
    var t = make(['a', 'b'], [['1', ''], ['', ''], [' ', ''], ['', '2']]);
    var f = DT.filledRows(t);
    assert.deepEqual(f.map(function (r) { return r.id; }), [t.rows[0].id, t.rows[3].id]);
  });

  test('history: setCell undo / redo', function () {
    var t = DT.create({ columns: 2, rows: 2 });
    var h = DT.history(t);
    var r = t.rows[0].id, c = t.columns[0].id;
    assert.equal(h.canUndo(), false);
    h.apply({ type: 'setCell', rowId: r, colId: c, value: '1.0' });
    h.apply({ type: 'setCell', rowId: r, colId: c, value: '1.00' });
    assert.equal(DT.getCell(t, r, c), '1.00');
    assert.ok(h.undo());
    assert.equal(DT.getCell(t, r, c), '1.0');
    assert.ok(h.undo());
    assert.equal(DT.getCell(t, r, c), '');
    assert.equal(h.undo(), false, 'nothing left to undo');
    assert.ok(h.canRedo());
    assert.ok(h.redo());
    assert.equal(DT.getCell(t, r, c), '1.0');
    h.apply({ type: 'setCell', rowId: r, colId: c, str: '2' });
    assert.equal(h.canRedo(), false, 'new op clears redo');
    assert.equal(DT.getCell(t, r, c), '2', '`str` accepted as an alias of value');
    assert.ok(h.table === t);
  });

  test('history: merge typing into one step, seal ends it', function () {
    var t = DT.create({ columns: 1, rows: 1 });
    var h = DT.history(t);
    var r = t.rows[0].id, c = t.columns[0].id;
    ['5', '50', '50.', '50.0'].forEach(function (v) {
      h.apply({ type: 'setCell', rowId: r, colId: c, value: v, merge: true });
    });
    h.seal();
    h.apply({ type: 'setCell', rowId: r, colId: c, value: '50.03', merge: true });
    assert.equal(DT.getCell(t, r, c), '50.03');
    h.undo();
    assert.equal(DT.getCell(t, r, c), '50.0', 'second edit undone');
    h.undo();
    assert.equal(DT.getCell(t, r, c), '', 'whole first edit undone in one step');
    h.redo();
    assert.equal(DT.getCell(t, r, c), '50.0');
    h.apply({ type: 'setHeading', colId: c, value: 'L', merge: true });
    h.apply({ type: 'setHeading', colId: c, value: 'L / cm', merge: true });
    h.undo();
    assert.equal(t.columns[0].heading, '');
  });

  test('history: structural ops are undone exactly and redo keeps ids', function () {
    var t = make(['L / cm', 'T / s'], [['20.0', '0.90'], ['40.0', '1.27']]);
    function snap() { var j = DT.toJSON(t); delete j.nextId; return j; }   // nextId never goes backwards
    var before = snap();
    var h = DT.history(t);
    var row = h.apply({ type: 'addRow', index: 1 });
    assert.equal(t.rows[1].id, row.id);
    var col = h.apply({ type: 'addColumn', heading: 'T² / s²' });
    h.apply({ type: 'setCell', rowId: row.id, colId: col.id, value: '1.61' });
    h.apply({ type: 'moveColumn', colId: col.id, newIndex: 0 });
    assert.equal(t.columns[0].id, col.id);
    h.apply({ type: 'moveRow', rowId: row.id, index: 0 });
    var firstCol = t.columns[1].id;
    h.apply({ type: 'removeColumn', colId: firstCol });
    h.apply({ type: 'removeRow', rowId: t.rows[2].id });
    var after = snap();
    var steps = 0;
    while (h.undo()) steps++;
    assert.equal(steps, 7);
    assert.deepEqual(snap(), before, 'undo restores the exact original table');
    assert.deepEqual(t.rows.map(function (r) { return r.id; }), ['r1', 'r2'], 'row order restored');
    while (h.redo()) steps--;
    assert.equal(steps, 0);
    assert.deepEqual(snap(), after, 'redo reproduces the same ids and contents');
    assert.deepEqual(t.columns.map(function (c) { return c.id; }), after.columns.map(function (c) { return c.id; }));
  });

  test('history: batch is one step; failed op is not recorded', function () {
    var t = DT.create({ columns: 2, rows: 2 });
    var h = DT.history(t);
    h.apply({ type: 'batch', ops: [
      { type: 'setHeading', colId: 'c1', value: 'm / g' },
      { type: 'setCell', rowId: 'r1', colId: 'c1', value: '100' }
    ] });
    h.undo();
    assert.equal(t.columns[0].heading, '');
    assert.equal(DT.getCell(t, 'r1', 'c1'), '');
    assert.throws(function () { h.apply({ type: 'removeRow', rowId: 'zz' }); });
    assert.throws(function () { h.apply({ type: 'bogus' }); });
    assert.throws(function () {
      h.apply({ type: 'batch', ops: [{ type: 'setHeading', colId: 'c1', value: 'x' }, { type: 'removeRow', rowId: 'zz' }] });
    });
    assert.equal(t.columns[0].heading, '', 'partial batch rolled back');
    assert.equal(h.canUndo(), false, 'failed ops not recorded');
  });

  test('JSON round trip, clone independence and repair', function () {
    var t = make(['L / cm', 'T / s'], [['50.0', '1.42'], ['60.0', '']]);
    var json = JSON.parse(JSON.stringify(DT.toJSON(t)));
    var back = DT.fromJSON(json);
    assert.deepEqual(DT.toJSON(back), DT.toJSON(t));
    var c = DT.clone(t);
    DT.setCell(c, c.rows[0].id, c.columns[0].id, '99.9');
    assert.equal(DT.getCell(t, t.rows[0].id, t.columns[0].id), '50.0', 'clone is deep');
    var repaired = DT.fromJSON({ columns: [{ heading: 'a' }, { id: 'c7', heading: 3 }],
      rows: [{ id: 'r2', cells: { c7: 4.5, zz: '1' } }, { cells: {} }], nextId: 1 });
    assert.equal(repaired.columns[1].heading, '3');
    assert.equal(DT.getCell(repaired, 'r2', 'c7'), '4.5');
    assert.ok(!('zz' in repaired.rows[0].cells), 'cells of unknown columns dropped');
    assert.ok(repaired.columns[0].id && repaired.rows[1].id, 'missing ids created');
    assert.ok(repaired.nextId > 7, 'nextId repaired');
    var added = DT.addRow(repaired);
    var ids = repaired.rows.map(function (r) { return r.id; });
    assert.equal(ids.length, new Set(ids).size, 'no id clash after repair: ' + added.id);
  });

  test('lint: empty headings and empty columns', function () {
    var t = make(['', '', 'T / s'], [['50.0', '', '1.42']]);
    var msgs = DT.lint(t);
    var c1 = msgs.filter(function (m) { return m.colId === t.columns[0].id; });
    assert.ok(c1.some(function (m) { return m.level === 'warn' && /no heading/.test(m.message); }), 'warns about data without heading');
    var c2 = msgs.filter(function (m) { return m.colId === t.columns[1].id; });
    assert.ok(c2.some(function (m) { return m.level === 'info' && /empty/.test(m.message); }), 'info about an empty column');
  });

  test('lint: inconsistent decimal places in a column', function () {
    var t = make(['L / cm'], [['20.0'], ['35.0'], ['50'], ['65.00']]);
    var msgs = DT.lint(t).filter(function (m) { return /decimal places/.test(m.message); });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].level, 'warn');
    assert.match(msgs[0].message, /row 3/);
    assert.match(msgs[0].message, /row 4/);
    var ok = make(['L / cm'], [['20.0'], ['35.0'], ['50.0']]);
    assert.equal(DT.lint(ok).filter(function (m) { return /decimal places/.test(m.message); }).length, 0);
    // calculated values with consistent s.f. but different d.p. are correct: no hint at all
    var derived = make(['T² / s²'], [['0.810'], ['1.61'], ['4.04']]);
    assert.equal(DT.lint(derived).filter(function (m) { return /decimal places/.test(m.message); }).length, 0);
    var T = make(['T / s'], [['1.453'], ['0.9287'], ['1.209']]);
    assert.equal(DT.lint(T).filter(function (m) { return /decimal places/.test(m.message); }).length, 0, 'all 4 s.f.');
    // different d.p. AND different s.f.: still a warning
    var mixed = make(['T / s'], [['1.45'], ['0.929'], ['1.2']]);
    var w = DT.lint(mixed).filter(function (m) { return /decimal places/.test(m.message); });
    assert.equal(w.length, 1);
    assert.equal(w[0].level, 'warn');
  });

  test('lint: non-numeric cells and units typed in cells', function () {
    var t = make(['L / cm'], [['50 cm'], ['abc'], ['60.0']]);
    var msgs = DT.lint(t).filter(function (m) { return m.rowId; });
    var r1 = msgs.filter(function (m) { return m.rowId === t.rows[0].id; });
    assert.ok(r1.some(function (m) { return m.level === 'warn' && /unit in the column heading/.test(m.message); }));
    var r2 = msgs.filter(function (m) { return m.rowId === t.rows[1].id; });
    assert.ok(r2.some(function (m) { return /not a number/.test(m.message) && !/unit in the column/.test(m.message); }));
    assert.equal(msgs.filter(function (m) { return m.rowId === t.rows[2].id; }).length, 0);
  });

  test('lint: heading problems come from VL.units.parseHeading', function () {
    var t = make(['T (s)', 'T in s', 'L / cm'], [['1.42', '1.42', '50.0']]);
    var saved = VL.units;
    var calls = [];
    if (!saved || typeof saved.parseHeading !== 'function') {
      // VL.units not loaded yet: check the plumbing with a temporary in-test double, then restore.
      VL.units = { parseHeading: function (s) {
        calls.push(s);
        return /\sin\s/.test(s) ? { ok: false, style: 'none', problems: ['unit not separated by / or ( )'] }
          : { ok: true, style: /\//.test(s) ? 'slash' : 'brackets', problems: [] };
      } };
    }
    try {
      var msgs = DT.lint(t);
      var bad = msgs.filter(function (m) { return m.colId === t.columns[1].id && m.level === 'warn'; });
      assert.ok(bad.length >= 1, 'heading "T in s" reported');
      assert.match(bad[0].message, /T in s/);
      assert.equal(msgs.filter(function (m) { return m.colId === t.columns[2].id; }).length, 0, 'good heading is quiet');
    } finally {
      VL.units = saved;
    }
  });

  test('lint: a heading without a unit is only an info (fine for dimensionless quantities)', function () {
    if (!VL.units || typeof VL.units.parseHeading !== 'function') return;   // needs the real units module
    var t = make(['n', 'L / cm'], [['20', '50.0']]);
    var msgs = DT.lint(t).filter(function (m) { return m.colId === t.columns[0].id; });
    assert.equal(msgs.length, 1, JSON.stringify(msgs));
    assert.equal(msgs[0].level, 'info');
    assert.match(msgs[0].message, /no unit/);
    var bad = make(['T in s'], [['1.42']]);
    assert.ok(DT.lint(bad).some(function (m) { return m.level === 'warn' && /T in s/.test(m.message); }));
  });

  test('lint: duplicate headings are noted', function () {
    var t = make(['t / s', 't / s'], [['12.31', '12.40']]);
    assert.ok(DT.lint(t).some(function (m) { return m.level === 'info' && /Two columns/.test(m.message); }));
  });
})();
