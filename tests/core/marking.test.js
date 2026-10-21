/* Tests for core/marking.js (VL.marking) using a small synthetic pendulum-style experiment. */
(function () {
  'use strict';
  var VL = globalThis.VLab;
  var M = VL.marking;
  var P = M.points;
  var G = VL.graph;
  var SF = VL.sigfig;
  var g0 = 9.81;

  /* ------------------------------------------------------------------ fixtures */

  /** Table from headings and rows of strings (empty strings = empty cells). */
  function makeTable(headings, rows) {
    var t = { columns: [], rows: [], nextId: 1 };
    headings.forEach(function (h, i) { t.columns.push({ id: 'c' + (i + 1), heading: h }); });
    rows.forEach(function (r, i) {
      var cells = {};
      r.forEach(function (v, j) { if (v !== '' && v !== undefined) cells['c' + (j + 1)] = v; });
      t.rows.push({ id: 'r' + (i + 1), cells: cells });
    });
    t.nextId = Math.max(headings.length, rows.length) + 1;
    return t;
  }

  var QUANTITIES = [
    { id: 'L', symbols: ['L', 'l'], dims: { m: 1 }, kind: 'raw', label: 'L' },
    { id: 't', symbols: ['t', '/^\\d+T$/', 'nT'], dims: { s: 1 }, kind: 'raw', repeat: true, label: 't' },
    { id: 'tMean', symbols: ['mean t', 't_mean'], dims: { s: 1 }, kind: 'derived', meanOf: 't', label: 'mean t' },
    { id: 'T', symbols: ['T', 'period'], dims: { s: 1 }, kind: 'derived', label: 'T' },
    { id: 'T2', symbols: ['T²', 'T^2', 'T2'], dims: { s: 2 }, kind: 'derived', label: 'T²' },
    { id: 'n', symbols: ['n', 'N'], dims: {}, kind: 'raw' }
  ];

  var LS = ['20.0', '35.0', '50.0', '65.0', '80.0', '95.0'];
  var OFFSETS = [0.04, -0.03, 0.05, -0.02, 0.03, -0.05];   // small timing scatter (s, for 20 oscillations)

  /** A careful student's readings: L / cm, t₁, t₂ (20 oscillations), T, T² — derived values from their own data. */
  function goodRows(c) {
    c = c === undefined ? 0.012 : c;
    return LS.map(function (Ls, i) {
      var T = 2 * Math.PI * Math.sqrt((parseFloat(Ls) / 100 + c) / g0);
      var t1 = (20 * T + OFFSETS[i]).toFixed(2), t2 = (20 * T - OFFSETS[i] / 2).toFixed(2);
      var Tm = SF.formatSF((parseFloat(t1) + parseFloat(t2)) / 40, 4);
      var T2 = SF.formatSF(parseFloat(Tm) * parseFloat(Tm), 4);
      return [Ls, t1, t2, Tm, T2];
    });
  }
  var HEADINGS = ['L / cm', 't₁ / s', 't₂ / s', 'T / s', 'T² / s²'];

  function goodTable() { return makeTable(HEADINGS, goodRows()); }

  /** Good graph of T² (c5) against L (c1), drawn as an examiner would (test fixture only). */
  function goodGraph(table, opts) { return G.modelGraph(table, 'c1', 'c5', opts); }

  /** Student's gradient from the typed read-offs, to 3 s.f. */
  function gradientFrom(graph) {
    var r = graph.readOffs;
    return SF.formatSF((parseFloat(r.y2) - parseFloat(r.y1)) / (parseFloat(r.x2) - parseFloat(r.x1)), 3);
  }

  /** Marking context without an experiment: just quantities, table, graph and answers. */
  function ctxFor(table, graph, answers, params) {
    var exp = {
      id: 'synthetic', quantities: function () { return QUANTITIES; },
      sampleParams: function () { return params || {}; }
    };
    return M.createContext(exp, { variantId: 'graph', seed: 'TST-0000-0000', table: table, graph: graph, answers: answers || {} }, params || {});
  }

  function mark(point, ctx) { return point.check(ctx); }

  /* ------------------------------------------------------------------ identifyColumns */

  test('identifyColumns: symbols, repeat columns, units and table order', function () {
    var info = M.identifyColumns(goodTable(), QUANTITIES);
    assert.deepEqual(info.map.L, ['c1']);
    assert.deepEqual(info.map.t, ['c2', 'c3'], 't₁ and t₂ are repeat columns of t');
    assert.deepEqual(info.map.T, ['c4'], 'T (capital) is not t (case-sensitive)');
    assert.deepEqual(info.map.T2, ['c5']);
    assert.deepEqual(info.unknown, []);
    assert.equal(info.details.c1.factor, 0.01, 'cm → m');
    assert.equal(info.details.c5.dimsOk, true);
  });

  test('identifyColumns: unknown columns, wrong units and missing headings are reported, not fatal', function () {
    var t = makeTable(['T² (s)', 'mass / kg', '', 'L in cm', 'T2 / s2'], [['1.00', '0.1', '5', '50.0', '1.00']]);
    var info = M.identifyColumns(t, QUANTITIES);
    assert.deepEqual(info.map.T2, ['c1', 'c5']);
    assert.equal(info.details.c1.dimsOk, false, 's is not a unit of T²');
    assert.equal(info.details.c5.dimsOk, true);
    assert.deepEqual(info.map.L, ['c4'], 'badly separated heading still identified');
    assert.deepEqual(info.unknown, ['c2', 'c3']);
    var empty = M.identifyColumns(null, QUANTITIES);
    assert.deepEqual(empty.map.L, []);
    assert.deepEqual(M.identifyColumns(goodTable(), null).unknown.length, 5);
  });

  test('identifyColumns: lg/ln headings map to their inner quantity with a log flag', function () {
    var t = makeTable(['L / cm', 'lg (L / cm)', 'T / s', 'lg (T / s)', 'ln(T/s)'], [['50.0', '1.699', '1.42', '0.152', '0.351']]);
    var info = M.identifyColumns(t, QUANTITIES);
    assert.deepEqual(info.map.L, ['c1', 'c2']);
    assert.equal(info.details.c2.log, 'lg');
    assert.equal(info.details.c1.log, null);
    assert.deepEqual(info.map.T, ['c3', 'c4', 'c5']);
    assert.equal(info.details.c5.log, 'ln');
    var ctx = ctxFor(t);
    assert.deepEqual(ctx.colsOf('T'), ['c3']);
    assert.deepEqual(ctx.colsOf('lg(T)'), ['c4']);
    assert.deepEqual(ctx.colsOf('ln:T'), ['c5']);
  });

  test('identifyColumns: a quantity defined as lg(x) itself takes lg headings', function () {
    var qs = QUANTITIES.concat([{ id: 'lgT', symbols: ['lg(T)'], dims: {}, kind: 'derived' }]);
    var info = M.identifyColumns(makeTable(['lg (T / s)'], [['0.152']]), qs);
    assert.deepEqual(info.map.lgT, ['c1']);
    assert.deepEqual(info.map.T, []);
  });

  test('identifyColumns: patterns (20T), indexed symbols and mean columns', function () {
    var t = makeTable(['20T / s', 't1 / s', 't (2) / s', 'mean t / s', 'n'], [['28.40', '28.40', '28.50', '28.45', '20']]);
    var info = M.identifyColumns(t, QUANTITIES);
    assert.deepEqual(info.map.t, ['c1', 'c2', 'c3']);
    assert.deepEqual(info.map.tMean, ['c4']);
    assert.deepEqual(info.map.n, ['c5'], 'dimensionless quantity without a unit');
    var bar = M.identifyColumns(makeTable(['t̄ / s', '<t> / s'], [['1', '1']]), QUANTITIES);
    assert.deepEqual(bar.map.tMean, ['c1', 'c2']);
  });

  test('identifyColumns: a third plain t column holding the means is moved to the mean quantity', function () {
    var t = makeTable(['t₁ / s', 't₂ / s', 't / s'], [['28.40', '28.50', '28.45'], ['31.10', '31.20', '31.15']]);
    var info = M.identifyColumns(t, QUANTITIES);
    assert.deepEqual(info.map.t, ['c1', 'c2']);
    assert.deepEqual(info.map.tMean, ['c3']);
    var notMeans = makeTable(['t₁ / s', 't₂ / s', 't / s'], [['28.40', '28.50', '28.60']]);
    assert.deepEqual(M.identifyColumns(notMeans, QUANTITIES).map.t, ['c1', 'c2', 'c3'], 'third repeat stays a repeat');
  });

  /** QUANTITIES with word names (Quantity.names), as an experiment would declare them. */
  var NAMED = QUANTITIES.map(function (q) {
    var names = {
      L: ['length', 'length of string', 'string length', 'length of pendulum', 'pendulum length'],
      t: ['time', 'time taken', 'total time'],
      tMean: ['mean time', 'average time'],
      n: ['number of oscillations', 'number of swings', 'oscillations'],
      T: ['period', 'time period', 'periodic time', 'time for one oscillation', 'time for 1 oscillation'],
      T2: ['period^2', 'period squared', 'time period^2']
    }[q.id];
    return names ? Object.assign({}, q, { names: names }) : q;
  });

  function qIdOf(heading, qs) {
    var info = M.identifyColumns(makeTable([heading], [['1.00']]), qs || NAMED);
    return info.details.c1.qId;
  }

  test('identifyColumns: word headings — names, "for N oscillations", repeat markers and single tokens', function () {
    [
      ['length / cm', 'L'], ['Length / cm', 'L'], ['Length L / cm', 'L'], ['length of string / cm', 'L'],
      ['time t₁ / s', 't'], ['Time for 20 oscillations / s', 't'], ['t₁ for 20 oscillations / s', 't'], ['1st t / s', 't'],
      ['second t / s', 't'], ['time for n oscillations / s', 't'],
      ['period T / s', 'T'], ['Time for one oscillation / s', 'T'],
      ['T squared / s²', 'T2'], ['Period² / s²', 'T2'], ['period squared / s²', 'T2'],
      ['number of oscillations', 'n'], ['mean time / s', 'tMean']
    ].forEach(function (c) { assert.equal(qIdOf(c[0]), c[1], c[0]); });
    // the stages that matched before are unchanged
    [['L / cm', 'L', 'symbol'], ['t1 (s)', 't', 'repeat'], ['t_1 / s', 't', 'repeat'], ['T² / s^2', 'T2', 'symbol'], ['Period / s', 'T', 'case']]
      .forEach(function (c) {
        var info = M.identifyColumns(makeTable([c[0]], [['1.00']]), NAMED);
        assert.equal(info.details.c1.qId, c[1], c[0]);
        assert.equal(info.details.c1.via, c[2], c[0] + ' via');
      });
    var twice = M.identifyColumns(makeTable(['t / s', 't / s'], [['28.40', '28.50']]), NAMED);
    assert.deepEqual(twice.map.t, ['c1', 'c2'], 't / s used twice');
    assert.equal(qIdOf('banana / cm'), null, 'nonsense stays unknown');
    assert.equal(qIdOf('T₁ / s'), null, 'a repeat marker only suits a repeated quantity');
    assert.equal(qIdOf('length / cm', QUANTITIES), null, 'without names a word is not matched');
    assert.equal(qIdOf('L against T / s'), null, 'tokens pointing to different quantities: no match');
  });

  test('readingsCount and headings name a column with values that matched no quantity (mark unchanged)', function () {
    var t = goodTable();
    t.columns[0].heading = 'banana / cm';
    var ctx = ctxFor(t);
    assert.deepEqual(ctx.colInfo.unknown, ['c1']);
    var r = mark(P.readingsCount({ xQ: 'L', yQs: ['T'] }), ctx);
    assert.equal(r.awarded, 0);
    assert.match(r.comment, /No column of L found/);
    assert.match(r.comment, /The column headed “banana \/ cm” could not be matched to a quantity in this experiment, so it was not marked; use the symbol from the question, e\.g\. L \/ m\./, 'example in SI (no unitHint)');
    var h = mark(P.headings({ exampleQ: 'L' }), ctx);
    assert.equal(h.awarded, 1, 'the headings mark itself is unchanged');
    assert.match(h.comment, /“banana \/ cm” could not be matched/);
    assert.ok(mark(P.headings(), ctxFor(goodTable())).comment.indexOf('could not be matched') < 0, 'no note when every column is identified');
  });

  /* ------------------------------------------------------------------ answerValue */

  test('answerValue: unit, dimensions, range, s.f. and instrument precision', function () {
    var pt = P.answerValue({ id: 'd', part: 'a', skill: 'MMO', key: 'd', name: 'd', dims: { m: 1 },
      range: [0.0230, 0.0236], dpOf: 1e-4 });
    assert.equal(pt.skill, 'MMO');
    assert.equal(pt.max, 1);
    var ok = mark(pt, ctxFor(null, null, { d: '2.33 cm' }));
    assert.equal(ok.awarded, 1, ok.comment);
    assert.match(ok.comment, /^✓ d = 2\.33 cm/);
    assert.equal(mark(pt, ctxFor(null, null, { d: '23.3 mm' })).awarded, 1, '0.1 mm in mm = 1 d.p.');
    assert.equal(mark(pt, ctxFor(null, null, { d: 'd = 0.0233 m' })).awarded, 1);
    var noUnit = mark(pt, ctxFor(null, null, { d: '2.33' }));
    assert.equal(noUnit.awarded, 0);
    assert.match(noUnit.comment, /no unit/);
    assert.match(mark(pt, ctxFor(null, null, { d: '2.33 s' })).comment, /not a unit of d/);
    var far = mark(pt, ctxFor(null, null, { d: '2.45 cm' }));
    assert.equal(far.awarded, 0);
    assert.match(far.comment, /accepted range \(2\.30–2\.36 cm\)/);
    var prec = mark(pt, ctxFor(null, null, { d: '2.3 cm' }));
    assert.equal(prec.awarded, 0);
    assert.match(prec.comment, /resolution of the instrument/);
    assert.match(mark(pt, ctxFor(null, null, {})).comment, /No value given/);
    assert.match(mark(pt, ctxFor(null, null, { d: 'about two' })).comment, /could not be read/);
    assert.match(mark(pt, ctxFor(null, null, { d: '2.33 furlongs' })).comment, /not recognised/);
  });

  test('answerValue: s.f. range, functions of ctx and dimensionless answers', function () {
    var pt = P.answerValue({ id: 'g', part: 'g', key: 'g', dims: { m: 1, s: -2 }, unitHint: 'm s⁻²',
      range: function (ctx) { return [ctx.params.g * 0.9, ctx.params.g * 1.1]; }, sf: [2, 3] });
    var c = function (a) { return ctxFor(null, null, { g: a }, { g: 9.81 }); };
    assert.equal(mark(pt, c('9.7 m s⁻²')).awarded, 1);
    assert.equal(mark(pt, c('9.72 m/s^2')).awarded, 1);
    var sf = mark(pt, c('9.7234 m s-2'));
    assert.equal(sf.awarded, 0);
    assert.match(sf.comment, /2 or 3 s\.f\./);
    assert.match(mark(pt, c('9.7 m s⁻¹')).comment, /expected m s⁻²/);
    var n = P.answerValue({ part: 'x', key: 'n', dims: {} });
    assert.equal(mark(n, ctxFor(null, null, { n: '20' })).awarded, 1, 'no unit needed for a dimensionless answer');
  });

  /* ------------------------------------------------------------------ table marks */

  test('readingsCount: six sets → 3, each missing set −1, examiner-style comments', function () {
    var pt = P.readingsCount({ id: 'n', part: 'd', xQ: 'L', yQs: ['t'], trend: 'increasing' });
    assert.equal(pt.max, 3);
    var r6 = mark(pt, ctxFor(goodTable()));
    assert.equal(r6.awarded, 3);
    assert.equal(r6.comment, '✓ Six sets of readings with correct trend');
    var r5 = mark(pt, ctxFor(makeTable(HEADINGS, goodRows().slice(0, 5))));
    assert.equal(r5.awarded, 2);
    assert.equal(r5.comment, '✗ Only five sets of readings (2 of 3)');
    var r4 = mark(pt, ctxFor(makeTable(HEADINGS, goodRows().slice(0, 4))));
    assert.equal(r4.awarded, 1);
    assert.equal(r4.comment, '✗ Only four sets of readings (1 of 3)');
    assert.equal(mark(pt, ctxFor(makeTable(HEADINGS, goodRows().slice(0, 3)))).awarded, 0);
  });

  test('readingsCount: wrong trend scores zero; incomplete rows and repeated x do not count', function () {
    var pt = P.readingsCount({ part: 'd', xQ: 'L', yQs: ['t'], trend: 'decreasing' });
    var w = mark(pt, ctxFor(goodTable()));
    assert.equal(w.awarded, 0);
    assert.match(w.comment, /trend is wrong: t should decrease as L increases \(0 of 3\)/);
    var rows = goodRows();
    rows[5] = ['95.0', '', '', '', ''];
    rows[4] = ['20.0'].concat(rows[4].slice(1));
    var inc = mark(P.readingsCount({ part: 'd', xQ: 'L', yQs: ['t'] }), ctxFor(makeTable(HEADINGS, rows)));
    assert.equal(inc.awarded, 1, 'only four distinct complete sets');
    assert.match(inc.comment, /row 6 incomplete/);
    assert.match(mark(pt, ctxFor(makeTable([], []))).comment, /No column of L/);
    assert.match(mark(P.readingsCount({ part: 'd', xQ: 'L' }), ctxFor(makeTable(['L / cm'], []))).comment, /No complete sets/);
  });

  test('readingsCount: a yQs entry may list alternatives (raw t or T completes a set)', function () {
    // L and T only (no raw times): six sets with ['t'] required → none; with [['t', 'T']] → all six
    var rows = goodRows().map(function (r) { return [r[0], r[3]]; });
    var table = makeTable(['L / cm', 'T / s'], rows);
    assert.equal(mark(P.readingsCount({ part: 'd', xQ: 'L', yQs: ['t'] }), ctxFor(table)).awarded, 0);
    var alt = mark(P.readingsCount({ part: 'd', xQ: 'L', yQs: [['t', 'T']], trend: 'increasing' }), ctxFor(table));
    assert.equal(alt.awarded, 3, 'six sets of L and T');
    assert.equal(alt.comment, '✓ Six sets of readings with correct trend');
    var wrong = makeTable(['L / cm', 'T / s'], rows.map(function (r, i) { return [r[0], rows[5 - i][1]]; }));
    assert.equal(mark(P.readingsCount({ part: 'd', xQ: 'L', yQs: [['t', 'T']], trend: 'increasing' }), ctxFor(wrong)).awarded, 0,
      'trend judged on the alternative that is present');
    // the full table still works (t present)
    assert.equal(mark(P.readingsCount({ part: 'd', xQ: 'L', yQs: [['t', 'T']] }), ctxFor(goodTable())).awarded, 3);
  });

  test('range: span of the independent variable in SI', function () {
    var pt = P.range({ part: 'd', xQ: 'L', minSpanSI: 0.40 });
    var ok = mark(pt, ctxFor(goodTable()));
    assert.equal(ok.awarded, 1);
    assert.equal(ok.comment, '✓ Range of L: 20.0 cm to 95.0 cm.');
    var narrow = makeTable(['L / m'], [['0.300'], ['0.400'], ['0.500']]);
    var bad = mark(pt, ctxFor(narrow));
    assert.equal(bad.awarded, 0);
    assert.match(bad.comment, /span 0\.200 m; at least 0\.40 m needed/);
    assert.equal(mark(P.range({ part: 'd', xQ: 'L', minSpanSI: 0.1, lowSI: 0.25 }), ctxFor(narrow)).awarded, 0);
    assert.match(mark(pt, ctxFor(makeTable(['L / cm'], [['50.0']]))).comment, /Not enough values/);
  });

  test('repeats: every set needs at least two readings', function () {
    var pt = P.repeats({ part: 'c', q: 't' });
    assert.equal(mark(pt, ctxFor(goodTable())).awarded, 1);
    var rows = goodRows();
    rows[2][2] = '';
    var miss = mark(pt, ctxFor(makeTable(HEADINGS, rows)));
    assert.equal(miss.awarded, 0);
    assert.match(miss.comment, /missing for row 3/);
    var single = mark(pt, ctxFor(makeTable(['L / cm', 't / s'], [['50.0', '28.40'], ['60.0', '31.00']])));
    assert.match(single.comment, /No repeated readings of t \(only one column of t\)/);
    var byRows = P.repeats({ part: 'c', q: 't', xQ: 'L' });
    assert.equal(mark(byRows, ctxFor(makeTable(['L / cm', 't / s'], [['50.0', '28.40'], ['50.0', '28.50']]))).awarded, 1,
      'repeats in separate rows with the same L also count');
  });

  test('headings: quantity and unit with matching dimensions', function () {
    var pt = P.headings({ part: 'd' });
    var ok = mark(pt, ctxFor(goodTable()));
    assert.equal(ok.awarded, 1, ok.comment);
    var bracket = mark(pt, ctxFor(makeTable(['L (cm)', 'T (s)'], [['50.0', '1.42']])));
    assert.equal(bracket.awarded, 1, 'brackets style accepted');
    var wrong = mark(pt, ctxFor(makeTable(['L / cm', 'T² (s)'], [['50.0', '2.02']])));
    assert.equal(wrong.awarded, 0);
    assert.match(wrong.comment, /unit s does not match T² \(expected s²\)/);
    assert.match(mark(pt, ctxFor(makeTable(['L in cm'], [['50.0']]))).comment, /quantity \/ unit/);
    assert.match(mark(pt, ctxFor(makeTable(['L / cm', 'T²'], [['50.0', '2.02']]))).comment, /no unit given \(expected s²\)/);
    assert.match(mark(pt, ctxFor(makeTable(['L / cm', ''], [['50.0', '2.02']]))).comment, /Column 2 has values but no heading/);
    assert.match(mark(pt, ctxFor(makeTable(['n / s'], [['20']]))).comment, /n has no unit/);
    assert.equal(mark(pt, ctxFor(makeTable(['n', 'lg (T / s)'], [['20', '0.152']]))).awarded, 1);
    assert.match(mark(pt, ctxFor(makeTable(['lg (T)'], [['0.152']]))).comment, /unit inside lg/);
    assert.match(mark(pt, ctxFor(makeTable([], []))).comment, /no column headings/);
  });

  test('rawConsistency: same d.p. and matching the instrument resolution', function () {
    var pt = P.rawConsistency({ part: 'd', q: 'L', resolutionSI: 0.001 });
    var ok = mark(pt, ctxFor(goodTable()));
    assert.equal(ok.awarded, 1, ok.comment);
    assert.match(ok.comment, /1 d\.p\..*0\.1 cm/);
    var mixed = goodRows();
    mixed[1][0] = '35';
    var m = mark(pt, ctxFor(makeTable(HEADINGS, mixed)));
    assert.equal(m.awarded, 0);
    assert.match(m.comment, /not all given to the same number of decimal places \(20\.0, 35\)/);
    var coarse = makeTable(['L / cm'], [['20'], ['35'], ['50']]);
    var c = mark(pt, ctxFor(coarse));
    assert.equal(c.awarded, 0);
    assert.match(c.comment, /nearest 0\.1 cm .* nearest 1 cm/);
    assert.equal(mark(pt, ctxFor(makeTable(['L / m'], [['0.200'], ['0.350']]))).awarded, 1, 'metres to 3 d.p. is also the nearest mm');
    assert.equal(mark(P.rawConsistency({ part: 'd', q: 't', resolutionSI: [0.01, 0.1] }), ctxFor(goodTable())).awarded, 1);
    assert.match(mark(pt, ctxFor(makeTable(['L / cm'], [['50.0 cm']]))).comment, /not a number: units belong in the heading/);
    assert.match(mark(pt, ctxFor(makeTable(['L / cm'], []))).comment, /No values of L/);
  });

  test('derivedSF: same s.f. as the least raw s.f., or one more', function () {
    var pt = P.derivedSF({ part: 'd', q: 'T2', from: ['t'], rawName: 'raw times' });
    var ok = mark(pt, ctxFor(goodTable()));
    assert.equal(ok.awarded, 1, ok.comment);
    var rows = goodRows().map(function (r) { return r.slice(0, 4).concat([SF.formatSF(parseFloat(r[4]), 2)]); });
    var bad = mark(pt, ctxFor(makeTable(HEADINGS, rows)));
    assert.equal(bad.awarded, 0);
    assert.equal(bad.comment, '✗ T² values given to 2 s.f. but raw times have 4 s.f.');
    var five = goodRows().map(function (r) { return r.slice(0, 4).concat([SF.formatSF(parseFloat(r[4]), 5)]); });
    assert.equal(mark(pt, ctxFor(makeTable(HEADINGS, five))).awarded, 1, 'one more s.f. allowed');
    var one = goodRows();
    one[3][4] = SF.formatSF(parseFloat(one[3][4]), 6);
    var r1 = mark(pt, ctxFor(makeTable(HEADINGS, one)));
    assert.equal(r1.awarded, 0);
    assert.match(r1.comment, /\(row 4\)\.$/);
    assert.match(mark(P.derivedSF({ part: 'd', q: 'T2', from: ['t'] }), ctxFor(makeTable(HEADINGS, rows))).comment,
      /but the raw data \(t\) have 4 s\.f\./);
  });

  test('derivedSF: lg columns use the d.p. rule', function () {
    var pt = P.derivedSF({ part: 'd', q: 'lg(T)' });
    var t = makeTable(['T / s', 'lg (T / s)'], [['1.42', '0.152'], ['1.65', '0.2175'], ['1.81', '0.26']]);
    var r = mark(pt, ctxFor(t));
    assert.equal(r.awarded, 0);
    assert.match(r.comment, /lg T values given to 2 d\.p\. but T has 3 s\.f\.: lg\/ln values need 3 or 4 d\.p\. \(row 3\)\.$/);
    var good = makeTable(['T / s', 'lg (T / s)'], [['1.42', '0.152'], ['1.65', '0.2175']]);
    assert.equal(mark(pt, ctxFor(good)).awarded, 1);
  });

  test('calc: checked against the student\'s own raw values (error carried forward)', function () {
    var ptT = P.calc({ part: 'd', q: 'T', compute: function (v) { return v.t / 20; } });
    var ptT2 = P.calc({ id: 'calcT2', part: 'd', q: 'T2', compute: function (v) { return v.T !== undefined ? v.T * v.T : Math.pow(v.t / 20, 2); } });
    var ok = mark(ptT2, ctxFor(goodTable()));
    assert.equal(ok.awarded, 1, ok.comment);
    assert.equal(ok.comment, '✓ T² calculated correctly from your own readings in all 6 rows.');
    assert.equal(mark(ptT, ctxFor(goodTable())).awarded, 1);
    // a student whose timings are far from the truth but who calculates consistently still earns the mark
    var odd = goodRows().map(function (r) {
      var t1 = (parseFloat(r[1]) + 3).toFixed(2), t2 = (parseFloat(r[2]) + 3).toFixed(2);
      var T = SF.formatSF((parseFloat(t1) + parseFloat(t2)) / 40, 4);
      return [r[0], t1, t2, T, SF.formatSF(parseFloat(T) * parseFloat(T), 4)];
    });
    assert.equal(mark(ptT2, ctxFor(makeTable(HEADINGS, odd))).awarded, 1);
    var wrong = goodRows();
    wrong[3][4] = SF.formatSF(parseFloat(wrong[3][4]) * 1.03, 4);
    var w = mark(ptT2, ctxFor(makeTable(HEADINGS, wrong)));
    assert.equal(w.awarded, 0);
    assert.match(w.comment, /T² incorrect in row 4 \(“[\d.]+”; from your own values it should be [\d.]+\)/);
    var missing = goodRows();
    missing[5][4] = '';
    assert.match(mark(ptT2, ctxFor(makeTable(HEADINGS, missing))).comment, /not calculated for row 6/);
    assert.match(mark(ptT2, ctxFor(makeTable(['L / cm'], [['1']]))).comment, /No column of T²/);
  });

  test('calc: unit conversions and lg columns', function () {
    var t = makeTable(['t₁ / ms', 't₂ / ms', 'T / s', 'lg (T / s)'], [['28400', '28500', '1.4225', '0.1530']]);
    var ptT = P.calc({ part: 'd', q: 'T', compute: function (v) { return v.t / 20; } });
    assert.equal(mark(ptT, ctxFor(t)).awarded, 1, 'ms converted to s');
    var ptLg = P.calc({ part: 'd', q: 'lg(T)', compute: function (v) { return v.T; } });
    assert.equal(mark(ptLg, ctxFor(t)).awarded, 1);
    var bad = makeTable(['T / s', 'lg (T / s)'], [['1.4225', '0.160']]);
    assert.equal(mark(ptLg, ctxFor(bad)).awarded, 0);
  });

  test('answerCalc: calculated answer values with error carried forward', function () {
    var pt = P.answerCalc({ part: 'e', keys: ['k1', 'k2'], compute: function (ctx, key) {
      var T = parseFloat(ctx.answer(key === 'k1' ? 'T1' : 'T2'));
      var L = ctx.vu(ctx.answer(key === 'k1' ? 'L1' : 'L2')).si;
      return T * T / L;
    } });
    var ans = { T1: '1.10', L1: '30.0 cm', T2: '1.80', L2: '80.0 cm', k1: '4.03 s² m⁻¹', k2: '0.0405 s² cm⁻¹' };
    assert.equal(mark(pt, ctxFor(null, null, ans)).awarded, 1);
    ans.k2 = '4.05';
    assert.equal(mark(pt, ctxFor(null, null, ans)).awarded, 1, 'no unit: compared numerically');
    ans.k2 = '4.50 s² m⁻¹';
    var r = mark(pt, ctxFor(null, null, ans));
    assert.equal(r.awarded, 0);
    assert.match(r.comment, /k₂ = 4\.50 s² m⁻¹ does not follow from your readings/);
  });

  /* ------------------------------------------------------------------ graph marks */

  test('graph marks: a well-drawn graph earns axes, plotting, best fit, gradient and intercept', function () {
    var t = goodTable();
    var g = goodGraph(t);
    var ans = { gradient: gradientFrom(g), intercept: g.intercept.value };
    var ctx = ctxFor(t, g, ans);
    [P.axes({ part: 'e' }), P.plotting({ part: 'e' }), P.bestFit({ part: 'e' }), P.gradient({ part: 'e', sign: 1 }),
      P.intercept({ part: 'e' })].forEach(function (pt) {
      var r = mark(pt, ctx);
      assert.equal(r.awarded, 1, pt.id + ': ' + r.comment);
      assert.match(r.comment, /^✓ /);
    });
  });

  test('graph marks: missing graph is handled', function () {
    var ctx = ctxFor(goodTable(), null, {});
    assert.equal(mark(P.axes({ part: 'e' }), ctx).comment, '✗ No graph drawn.');
    assert.equal(mark(P.plotting({ part: 'e' }), ctx).comment, '✗ No points plotted.');
    assert.equal(mark(P.bestFit({ part: 'e' }), ctx).comment, '✗ No line of best fit drawn.');
    assert.match(mark(P.gradient({ part: 'e' }), ctx).comment, /No line drawn/);
    assert.match(mark(P.intercept({ part: 'e' }), ctx).comment, /No value given/);
  });

  test('axes: awkward scale, unlabelled axis and small fill lose the mark', function () {
    var t = goodTable();
    var g = goodGraph(t);
    g.y.perLarge = g.y.perLarge * 1.5;   // e.g. 0.3 per large square
    var r = mark(P.axes({ part: 'e' }), ctxFor(t, g));
    assert.equal(r.awarded, 0);
    assert.match(r.comment, /Awkward scale on the y-axis/);
    var g2 = goodGraph(t);
    g2.x.label = '';
    assert.match(mark(P.axes({ part: 'e' }), ctxFor(t, g2)).comment, /x-axis is not labelled/);
    var g3 = goodGraph(t);
    g3.x.perLarge = g3.x.perLarge * 4;
    assert.match(mark(P.axes({ part: 'e' }), ctxFor(t, g3)).comment, /less than half of the grid/);
  });

  test('plotting: a misplotted or missing point loses the mark', function () {
    var t = goodTable();
    var g = goodGraph(t);
    g.points[2].gy += 1.2;
    var r = mark(P.plotting({ part: 'e' }), ctxFor(t, g));
    assert.equal(r.awarded, 0);
    assert.match(r.comment, /row 3 is more than half a small square/);
    var g2 = goodGraph(t);
    g2.points.splice(4, 1);
    assert.match(mark(P.plotting({ part: 'e' }), ctxFor(t, g2)).comment, /row 5 missing/);
  });

  test('bestFit: an unbalanced line loses the mark', function () {
    var t = goodTable();
    var g = goodGraph(t);
    g.line = { a: { gx: g.line.a.gx, gy: g.line.a.gy + 6 }, b: { gx: g.line.b.gx, gy: g.line.b.gy + 6 } };
    var r = mark(P.bestFit({ part: 'e' }), ctxFor(t, g));
    assert.equal(r.awarded, 0);
    assert.match(r.comment, /above/);
  });

  test('gradient: small triangle, wrong read-offs, Δx/Δy and sign', function () {
    var t = goodTable();
    var g = goodGraph(t);
    var grad = gradientFrom(g);
    var small = G.clone(g);
    var mid = (small.triangle.p1.gx + small.triangle.p2.gx) / 2;
    small.triangle.p2 = { gx: mid, gy: G.lineY(small.line, mid) };
    var r = mark(P.gradient({ part: 'e' }), ctxFor(t, small, { gradient: grad }));
    assert.equal(r.awarded, 0);
    assert.match(r.comment, /too small/);
    var wrongAns = mark(P.gradient({ part: 'e' }), ctxFor(t, g, { gradient: SF.formatSF(parseFloat(grad) * 1.2, 3) }));
    assert.equal(wrongAns.awarded, 0);
    assert.match(wrongAns.comment, /does not equal Δy\/Δx from your read-offs/);
    var inv = mark(P.gradient({ part: 'e' }), ctxFor(t, g, { gradient: SF.formatSF(1 / parseFloat(grad), 3) }));
    assert.match(inv.comment, /Δx\/Δy instead of Δy\/Δx/);
    var sign = mark(P.gradient({ part: 'e', sign: -1 }), ctxFor(t, g, { gradient: grad }));
    assert.match(sign.comment, /should be negative/);
    var ro = G.clone(g);
    ro.readOffs.y2 = String(parseFloat(ro.readOffs.y2) + 0.3);
    assert.match(mark(P.gradient({ part: 'e' }), ctxFor(t, ro, { gradient: grad })).comment, /read off do not match/);
    // the gradient quoted in other units (read-offs in cm, gradient per m) is accepted
    var perM = SF.formatSF(parseFloat(grad) * 100, 3) + ' s² m⁻¹';
    assert.equal(mark(P.gradient({ part: 'e' }), ctxFor(t, g, { gradient: perM })).awarded, 1);
  });

  test('intercept: direct reading and substitution with a false origin', function () {
    var t = goodTable();
    var g = goodGraph(t, { includeZero: false });
    assert.ok(g.x.origin !== 0, 'fixture has a false origin');
    var grad = gradientFrom(g);
    var r = mark(P.intercept({ part: 'e' }), ctxFor(t, g, { gradient: grad, intercept: g.intercept.value }));
    assert.equal(r.awarded, 1, r.comment);
    assert.match(r.comment, /substituting/);
    // reading the value at the left edge of a false-origin graph is wrong
    var edge = G.gridToValue(g.y, G.lineY(g.line, 0));
    var bad = mark(P.intercept({ part: 'e' }), ctxFor(t, g, { gradient: grad, intercept: SF.formatSF(edge, 3) }));
    assert.equal(bad.awarded, 0);
    assert.match(bad.comment, /does not start at zero/);
  });

  test('quality: scatter about the student\'s own straight line, one circled anomaly allowed', function () {
    var pt = P.quality({ part: 'e', tolY: 0.04, xQ: 'L', yQ: 'T2' });
    var t = goodTable();
    var ok = mark(pt, ctxFor(t, goodGraph(t)));
    assert.equal(ok.awarded, 1, ok.comment);
    assert.equal(ok.comment, '✓ All points lie within 0.040 s² of a straight line.');
    var rows = goodRows();
    rows[2][4] = SF.formatSF(parseFloat(rows[2][4]) + 0.25, 4);
    var t2 = makeTable(HEADINGS, rows);
    var g2 = goodGraph(t2);
    var bad = mark(pt, ctxFor(t2, g2));
    assert.equal(bad.awarded, 0);
    assert.match(bad.comment, /Scatter too large: the point in row 3 is/);
    g2.points[2].anomaly = true;
    var circled = mark(pt, ctxFor(t2, g2));
    assert.equal(circled.awarded, 1, circled.comment);
    assert.match(circled.comment, /circled anomaly in row 3 ignored/);
    // tolerance as a function of the data
    var rel = P.quality({ part: 'e', xQ: 'L', yQ: 'T2', tolY: function (ctx, info) { return 1e-5 * Math.max.apply(null, info.ys); } });
    assert.equal(mark(rel, ctxFor(t)).awarded, 0, 'a very tight tolerance fails');
    assert.match(mark(pt, ctxFor(makeTable(HEADINGS, goodRows().slice(0, 4)))).comment, /Too few results/);
    assert.match(mark(P.quality({ part: 'e', tolY: 0.04 }), ctxFor(t)).comment, /no graph columns chosen/);
  });

  test('graphQuantities / xQ, yQ: the graph must plot the quantities asked for; quality needs every row plotted', function () {
    var t = goodTable();
    var g = goodGraph(t);
    var ctx = ctxFor(t, g, { gradient: gradientFrom(g), intercept: g.intercept.value });
    assert.deepEqual(M.util.graphQuantities(ctx), { x: 'L', y: 'T2', xHeading: 'L / cm', yHeading: 'T² / s²' });
    var spec = { part: 'e', xQ: 'L', yQ: 'T2' };
    [P.axes(spec), P.gradient(spec), P.intercept(spec), P.quality(Object.assign({ tolY: 0.04 }, spec))].forEach(function (pt) {
      assert.equal(mark(pt, ctx).awarded, 1, pt.id + ': ' + mark(pt, ctx).comment);
    });
    // T plotted instead of T²
    var gT = G.modelGraph(t, 'c1', 'c4');
    var ctxT = ctxFor(t, gT, { gradient: gradientFrom(gT), intercept: gT.intercept.value });
    [P.axes(spec), P.gradient(spec), P.intercept(spec), P.quality(Object.assign({ tolY: 0.04 }, spec))].forEach(function (pt) {
      var r = mark(pt, ctxT);
      assert.equal(r.awarded, 0, pt.id);
      assert.equal(r.comment, '✗ The question asks for a graph of T² (y-axis) against L (x-axis); your graph shows T against L.');
    });
    assert.equal(mark(P.axes({ part: 'e' }), ctxT).awarded, 1, 'without xQ/yQ the plotted quantities are not checked');
    // axes the wrong way round; an unknown column is quoted by its heading
    var gS = G.modelGraph(t, 'c5', 'c1');
    assert.equal(mark(P.axes(spec), ctxFor(t, gS)).comment, '✗ The axes are the wrong way round: T² should be on the y-axis and L on the x-axis.');
    var tu = goodTable();
    tu.columns[4].heading = 'banana / s²';
    assert.match(mark(P.axes(spec), ctxFor(tu, G.modelGraph(tu, 'c1', 'c5'))).comment, /your graph shows “banana \/ s²” against L\./);
    // quality: empty graph, rows missing from the graph, requirePlotted: false
    var q = P.quality(Object.assign({ tolY: 0.04 }, spec));
    assert.equal(mark(q, ctxFor(t, G.create())).comment, '✗ No graph drawn.');
    var g3 = goodGraph(t);
    g3.points = g3.points.slice(0, 3);
    var r3 = mark(q, ctxFor(t, g3));
    assert.equal(r3.awarded, 0);
    assert.match(r3.comment, /All the points in the table \(at least 5\) must be plotted on your graph of T² against L for this mark/);
    var circled = goodGraph(t);
    circled.points[2].anomaly = true;
    assert.equal(mark(q, ctxFor(t, circled)).awarded, 1, 'a circled anomaly counts as plotted');
    assert.equal(mark(P.quality(Object.assign({ tolY: 0.04, requirePlotted: false }, spec)), ctxFor(t, G.create())).awarded, 1,
      'requirePlotted: false judges the table alone');
  });

  /* ------------------------------------------------------------------ written answers */

  test('sfJustification: s.f. linked to the raw data is credited', function () {
    var pt = P.sfJustification({ part: 'e-ii', key: 'why', rawWords: ['L', 't', 'd'] });
    ['k is given to 3 s.f. because L and t were measured to 3 s.f.',
      'Same number of sig figs as the least precise raw data.',
      'Three significant figures, as the readings of t had 3 s.f.',
      'The raw data (L, d and t) have 3 sf so k has 3 sf'].forEach(function (s) {
      var r = mark(pt, ctxFor(null, null, { why: s }));
      assert.equal(r.awarded, 1, s + ' → ' + r.comment);
    });
  });

  test('sfJustification: decimal places, no s.f. or no raw data are not credited', function () {
    var pt = P.sfJustification({ part: 'e-ii', key: 'why', rawWords: ['L', 't', 'd'] });
    var dp = mark(pt, ctxFor(null, null, { why: 'Because L and t were measured to 1 d.p.' }));
    assert.equal(dp.awarded, 0);
    assert.match(dp.comment, /decimal places/);
    var link = mark(pt, ctxFor(null, null, { why: 'k is to 3 s.f. because L is to 1 d.p. and t to 2 d.p.' }));
    assert.equal(link.awarded, 0, 'raw data tied to d.p., not s.f.');
    var noRaw = mark(pt, ctxFor(null, null, { why: 'Given to 3 s.f. since that is sensible.' }));
    assert.equal(noRaw.awarded, 0);
    assert.match(noRaw.comment, /does not link them to the raw data/);
    assert.match(mark(pt, ctxFor(null, null, { why: 'Same as the raw data.' })).comment, /Does not mention significant figures/);
    assert.match(mark(pt, ctxFor(null, null, {})).comment, /No justification/);
  });

  test('sfJustification: shorthand such as 3sf, 3SF, 3s.f. and sig. fig. is recognised; d.p. still is not s.f.', function () {
    var pt = P.sfJustification({ part: 'e-ii', key: 'why', rawWords: ['L', 't', 'd'] });
    ['3sf as L, d and t were 3sf', 'k to 3SF because L and t are 3SF', 'k is 3s.f. because L is 3s.f.',
      'L was 3 sig. fig. so k 3 sig. fig.', 'k is 3 sf because L is 3 sf'].forEach(function (s) {
      var r = mark(pt, ctxFor(null, null, { why: s }));
      assert.equal(r.awarded, 1, s + ' → ' + r.comment);
    });
    ['same d.p. as L', '3dp like t', 'k to 2d.p. because L is 1d.p.'].forEach(function (s) {
      var r = mark(pt, ctxFor(null, null, { why: s }));
      assert.equal(r.awarded, 0, s);
      assert.match(r.comment, /decimal places/, s);
    });
  });

  test('percentUncertainty: realistic absolute uncertainty and correct percentage', function () {
    var pt = P.percentUncertainty({ part: 'b', absKey: 'dd', pctKey: 'pd', valueKey: 'd', absRangeSI: [1e-4, 5e-4] });
    var c = function (a) { return ctxFor(null, null, a); };
    var ok = mark(pt, c({ d: '2.34 cm', dd: '0.01 cm', pd: '0.43 %' }));
    assert.equal(ok.awarded, 1, ok.comment);
    assert.equal(mark(pt, c({ d: '2.34 cm', dd: '0.01', pd: '0.4' })).awarded, 1, 'no unit: same unit as d; % sign optional');
    assert.equal(mark(pt, c({ d: '2.34 cm', dd: '0.1 mm', pd: '0.427%' })).awarded, 1, 'mixed units converted');
    var unreal = mark(pt, c({ d: '2.34 cm', dd: '0.5 cm', pd: '21 %' }));
    assert.equal(unreal.awarded, 0);
    assert.match(unreal.comment, /not realistic for this measurement \(expected 0\.01–0\.05 cm\)/);
    var wrong = mark(pt, c({ d: '2.34 cm', dd: '0.01 cm', pd: '4.3 %' }));
    assert.equal(wrong.awarded, 0);
    assert.match(wrong.comment, /should be 0\.01 cm \/ 2\.34 cm × 100 = 0\.427 %/);
    assert.equal(mark(pt, c({ d: '2.34 cm', pd: '0.43 %' })).awarded, 1, 'percentage alone implies a realistic absolute uncertainty');
    assert.match(mark(pt, c({ dd: '0.01 cm', pd: '0.43 %' })).comment, /value of d is needed/);
    assert.match(mark(pt, c({ d: '2.34 cm' })).comment, /No uncertainty given/);
  });

  test('parseConclusion: criteria, stated differences and claims', function () {
    var p = M.parseConclusion('The percentage difference between k1 and k2 is 4.3 %, which is less than 10 %, so the results support the suggestion.');
    assert.deepEqual(p.criteria, [10]);
    assert.deepEqual(p.differences, [4.3]);
    assert.equal(p.claim, 'supports');
    assert.equal(M.parseConclusion('The results do not support the suggestion').claim, 'not');
    assert.equal(M.parseConclusion("The values of k aren't consistent").claim, 'not');
    assert.equal(M.parseConclusion('Not supported.').claim, 'not');
    assert.equal(M.parseConclusion('Yes, the relationship is confirmed').claim, 'supports');
    assert.equal(M.parseConclusion('No.').claim, 'not');
    assert.equal(M.parseConclusion('T² is not proportional to L').claim, 'not');
    assert.equal(M.parseConclusion('The suggestion is incorrect as the values differ by more than 1%.').claim, 'not');
    assert.equal(M.parseConclusion('Supported, as the difference is under 10%.').claim, 'supports');
    assert.equal(M.parseConclusion('The values are within 10 % of each other').claim, 'supports');
    var cond = M.parseConclusion('If the values were within 10 % the suggestion would be supported, but they differ by 15 % so it is not supported.');
    assert.equal(cond.claim, 'not', 'conditional clause ignored');
    assert.deepEqual(cond.criteria, [10]);
    assert.deepEqual(cond.differences, [15]);
    assert.deepEqual(M.parseConclusion('k1/k2 = 0.97, which lies between 0.9 and 1.1, so it is consistent').ratioCriteria.map(Math.round), [10]);
    assert.deepEqual(M.parseConclusion('Since 12 % > 10 %, the suggestion is not valid.').criteria, [10]);
    assert.equal(M.parseConclusion('').claim, null);
  });

  test('conclusion: claim must be consistent with the student\'s own k values and stated criterion', function () {
    var pt = P.conclusion({ part: 'f', k1Key: 'k1', k2Key: 'k2', key: 'conc' });
    var c = function (k1, k2, text) { return ctxFor(null, null, { k1: k1, k2: k2, conc: text }); };
    // k values 3.2 % apart
    var a = mark(pt, c('4.03 s² m⁻¹', '4.16 s² m⁻¹', 'The values of k agree within 10 %, so the results support the suggestion.'));
    assert.equal(a.awarded, 1, a.comment);
    assert.match(a.comment, /^✓ Criterion stated \(10 %\); your values of k differ by 3\.2 %/);
    var b = mark(pt, c('4.03', '4.16', 'My criterion is 2 %. The difference is 3.2 % so the results do not support the suggestion.'));
    assert.equal(b.awarded, 1, b.comment);
    var wrong = mark(pt, c('4.03', '4.16', 'The difference is less than 2 % so the suggestion is supported.'));
    assert.equal(wrong.awarded, 0);
    assert.match(wrong.comment, /differ by 3\.2 %, which is more than your criterion of 2 %/);
    var noCrit = mark(pt, c('4.03', '4.16', 'The values are close so the suggestion is supported.'));
    assert.equal(noCrit.awarded, 0);
    assert.match(noCrit.comment, /No numerical criterion stated/);
    var noClaim = mark(pt, c('4.03', '4.16', 'The criterion is 10 %.'));
    assert.match(noClaim.comment, /No clear statement/);
    // k values 14 % apart
    var big = mark(pt, c('4.0', '4.6', "The k values differ by more than 10 %, so the results don't support the suggestion."));
    assert.equal(big.awarded, 1, big.comment);
    var bigWrong = mark(pt, c('4.0', '4.6', 'The k values are within 10 % so it is supported.'));
    assert.equal(bigWrong.awarded, 0);
    var ratio = mark(pt, c('4.03', '4.16', 'k1/k2 = 0.97 which is between 0.95 and 1.05 so the results are consistent with the suggestion.'));
    assert.equal(ratio.awarded, 1, ratio.comment);
    var silly = mark(pt, c('4.0', '4.6', 'They agree within 80 % so it is supported.'));
    assert.equal(silly.awarded, 0);
    assert.match(silly.comment, /not a meaningful test/);
    assert.match(mark(pt, c('', '4.16', 'Supported within 10 %')).comment, /Both values of k are needed/);
    assert.match(mark(pt, c('4.03', '4.16', '')).comment, /No conclusion given/);
  });

  test('conclusion: the verdict clause decides the claim, not a subordinate clause about the k values', function () {
    var pt = P.conclusion({ part: 'f', k1Key: 'k1', k2Key: 'k2', key: 'conc' });
    var c = function (k1, k2, text) { return ctxFor(null, null, { k1: k1, k2: k2, conc: text }); };
    var t1 = 'The results support the relationship, although the k values do not agree within 10%.';
    assert.equal(M.parseConclusion(t1).claim, 'supports');
    var r1 = mark(pt, c('4.08 s² m⁻¹', '3.50 s² m⁻¹', t1));                 // 15 % apart
    assert.equal(r1.awarded, 0, r1.comment);
    assert.match(r1.comment, /but your conclusion says they do \(“the results support the relationship”\)/);
    var t2 = 'The results do not support the relationship, although the k values agree within 10%.';
    assert.equal(M.parseConclusion(t2).claim, 'not');
    var r2 = mark(pt, c('4.08 s² m⁻¹', '4.05 s² m⁻¹', t2));                 // 0.74 % apart
    assert.equal(r2.awarded, 0, r2.comment);
    assert.match(r2.comment, /says they do not \(“the results do not support the relationship”\)/);
    var t3 = 'The two values of k are not equal, so the relationship is not supported, although they agree within 10%.';
    assert.equal(M.parseConclusion(t3).claim, 'not');
    assert.equal(mark(pt, c('4.08 s² m⁻¹', '4.05 s² m⁻¹', t3)).awarded, 0);
    // verdicts that contradict each other: no clear statement
    var both = M.parseConclusion('The results support the suggestion. The relationship is not valid.');
    assert.equal(both.claim, null);
    assert.equal(both.conflict, true);
    var rb = mark(pt, c('4.08', '4.05', 'The difference is less than 10 %, so the results support the suggestion. The relationship is not valid.'));
    assert.equal(rb.comment, '✗ Your conclusion does not make a clear statement of whether the results support the suggestion.');
    // with no verdict clause, the clauses about the k values still decide
    assert.equal(M.parseConclusion('The k values agree within 10 %').claim, 'supports');
    assert.equal(M.parseConclusion('The k values do not agree within 10 %').claim, 'not');
  });

  test('conclusion: "within the percentage uncertainty" uses the student\'s own % uncertainty when linked', function () {
    var pt = P.conclusion({ part: 'f', k1Key: 'k1', k2Key: 'k2', key: 'conc', pctUncertaintyKey: 'pct' });
    var r = mark(pt, ctxFor(null, null, { k1: '4.03', k2: '4.16', pct: '5 %',
      conc: 'The difference is within the percentage uncertainty so the suggestion is supported.' }));
    assert.equal(r.awarded, 1, r.comment);
    var n = mark(pt, ctxFor(null, null, { k1: '4.03', k2: '4.16', pct: '5 %',
      conc: 'The percentage uncertainty is 2 %, and the values differ by more than this, so the suggestion is not supported.' }));
    assert.equal(n.awarded, 1, n.comment);
  });

  test('limitationsImprovements: two ACE mark points, max 4 each, on their own parts', function () {
    var bank = [
      { id: 'A', limitation: { label: 'two readings are not enough', concepts: [{ all: [['two', 'only'], ['/reading|set|result/'], ['/enough|conclusion/']] }] },
        improvement: { label: 'take more readings and plot a graph', concepts: [{ all: [['more'], ['/graph|plot/']] }] } },
      { id: 'B', limitation: { label: 'reaction time large compared with time measured', concepts: [{ all: [['/reaction ?time/'], ['/large|compared|short/']] }] },
        improvement: { label: 'time more oscillations / fiducial marker', concepts: [{ all: [['/fiducial|marker/']] }, { all: [['more', '20'], ['oscillation']] }] } }
    ];
    var pts = P.limitationsImprovements({ id: 'eval', limKey: 'lim', impKey: 'imp', bank: bank, limPart: 'h-i', impPart: 'h-ii' });
    assert.equal(pts.length, 2);
    assert.equal(pts[0].part, 'h-i');
    assert.equal(pts[1].part, 'h-ii');
    assert.equal(pts[0].skill, 'ACE');
    assert.equal(pts[0].max, 4);
    assert.equal(pts[0].id, 'eval-lim');
    var ctx = ctxFor(null, null, {
      lim: ['Only two readings were taken, which is not enough to draw a conclusion', 'Human error'],
      imp: ['Take more readings and plot a graph', 'Use a fiducial marker', 'Use more accurate equipment']
    });
    var l = mark(pts[0], ctx), i = mark(pts[1], ctx);
    assert.equal(l.awarded, 1);
    assert.equal(l.comment, '✗ 1 of 4 limitations credited: two readings are not enough (1 answer not credited).');
    assert.equal(l.details.rejected[0].text, 'Human error');
    assert.match(l.details.rejected[0].reason, /not a valid limitation/);
    assert.equal(i.awarded, 2);
    assert.match(i.comment, /\(1 answer not credited\)\.$/);
    assert.match(i.details.rejected[0].reason, /^“More accurate”/);
    assert.deepEqual(i.details.misses, []);
    assert.equal(mark(pts[0], ctxFor(null, null, {})).comment, '✗ No limitations given.');
  });

  test('custom: wraps an experiment-specific check', function () {
    var pt = P.custom({ id: 'x', part: 'a', skill: 'MMO', label: 'Something', check: function (ctx) {
      return { awarded: ctx.answer('a') === 'yes' ? this.max : 0, comment: 'ok' };
    } });
    assert.equal(mark(pt, ctxFor(null, null, { a: 'yes' })).awarded, 1);
    assert.equal(mark(pt, ctxFor(null, null, { a: 'no' })).awarded, 0);
  });

  test('robustness: junk cells, list-shaped value answers and a graph with no columns chosen', function () {
    var junk = makeTable(['L / cm', 't₁ / s', 't₂ / s'], [['20.0', '18.47', '18.50'], ['abc', '20.1', '20.2'], ['50.0 cm', '', ''], ['', '', '']]);
    var ctx = ctxFor(junk, null, { d: ['', '2.33 cm'] });
    assert.equal(mark(P.readingsCount({ part: 'd', xQ: 'L', yQs: ['t'] }), ctx).awarded, 0, 'one valid set only');
    assert.match(mark(P.rawConsistency({ part: 'd', q: 'L' }), ctx).comment, /“abc” \(row 2\) is not a number/);
    assert.equal(mark(P.answerValue({ part: 'a', key: 'd', dims: { m: 1 } }), ctx).awarded, 1, 'first non-empty list entry used');
    var g = G.create();
    G.addPoint(g, 'r1', 10, 10);
    G.addPoint(g, 'r2', 50, 40);
    var c2 = ctxFor(goodTable(), g);
    assert.match(mark(P.plotting({ part: 'e' }), c2).comment, /Choose which columns/);
    assert.equal(mark(P.axes({ part: 'e' }), c2).awarded, 0);
    assert.equal(mark(P.range({ part: 'd', xQ: 'L', minSpanSI: function (cx) { return cx.params.span; } }), ctxFor(goodTable(), null, {}, { span: 0.5 })).awarded, 1);
    assert.equal(typeof M.util.fmt, 'function');
    assert.equal(M.util.fmt(0.000012345, 3), '1.23 × 10⁻⁵');
    assert.equal(M.util.fmtRange(8.829, 10.791), '8.83–10.79');
    assert.equal(M.util.requiredDp(0.02), 2);
    assert.equal(M.util.requiredDp(0.5), 1);
    assert.equal(M.util.requiredDp(10), -1);
  });

  /* ------------------------------------------------------------------ run() */

  /** Synthetic experiment with a Q1-style paper using subparts. */
  function syntheticExperiment(extraPoints) {
    return {
      id: 'synthetic', title: 'Synthetic pendulum', seedPrefix: 'SYN',
      variants: [{ id: 'graph', style: 'Q1' }],
      sampleParams: function (rng, variantId) { return { c: rng.uniform(0.008, 0.025), g: 9.81, variant: variantId }; },
      quantities: function () { return QUANTITIES; },
      paper: function () {
        return { title: 'Question 1', totalMarks: 12, parts: [
          { id: 'a', label: '(a)', marks: 1 },
          { id: 'd', label: '(d)', marks: 8 },
          { id: 'e', label: '(e)', subparts: [
            { id: 'e-i', label: '(i)', marks: 2 }, { id: 'e-ii', label: '(ii)', marks: 1 }] }
        ] };
      },
      rubric: function () {
        return [
          P.answerValue({ id: 'g', part: 'a', skill: 'ACE', key: 'g', dims: { m: 1, s: -2 }, range: [8.8, 10.8] }),
          P.readingsCount({ id: 'count', part: 'd', xQ: 'L', yQs: ['t'], trend: 'increasing' }),
          P.range({ id: 'range', part: 'd', xQ: 'L', minSpanSI: 0.4 }),
          P.headings({ id: 'head', part: 'd' }),
          P.rawConsistency({ id: 'raw', part: 'd', q: 'L', resolutionSI: 0.001 }),
          P.derivedSF({ id: 'sf', part: 'd', q: 'T2', from: ['t'] }),
          P.axes({ id: 'axes', part: 'e-i' }),
          P.plotting({ id: 'plot', part: 'e-i' }),
          P.bestFit({ id: 'line', part: 'e-ii' })
        ].concat(extraPoints || []);
      },
      modelAnswer: function (params, variantId, rng) { return { table: null, graph: null, answers: { g: '9.81 m s⁻²' }, notes: ['n'], c: params.c, r: rng.next() }; },
      commonMistakes: function () { return ['Timing only one oscillation.'] },
      createApparatus: function () { return {}; }
    };
  }

  test('run: aggregates per skill and per part (with subpart labels) and attaches model answer', function () {
    var exp = syntheticExperiment();
    var t = goodTable();
    var q = { qid: 'q1', expId: 'synthetic', variantId: 'graph', seed: 'SYN-AAAA-BBBB', table: t, graph: goodGraph(t),
      answers: { g: '9.79 m s⁻²' }, markedAt: '2026-01-01T00:00:00.000Z' };
    var rep = M.run(exp, q);
    assert.equal(rep.expId, 'synthetic');
    assert.equal(rep.variantId, 'graph');
    assert.equal(rep.seed, 'SYN-AAAA-BBBB');
    assert.equal(rep.markedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(rep.max, 11);
    assert.equal(rep.total, 11, JSON.stringify(rep.points.filter(function (p) { return p.awarded < p.max; })));
    assert.deepEqual(rep.skills.MMO, { got: 4, max: 4 });
    assert.deepEqual(rep.skills.PDO, { got: 6, max: 6 });
    assert.deepEqual(rep.skills.ACE, { got: 1, max: 1 });
    assert.deepEqual(rep.parts, [
      { part: 'a', label: '(a)', got: 1, max: 1 },
      { part: 'd', label: '(d)', got: 7, max: 7 },
      { part: 'e-i', label: '(e)(i)', got: 2, max: 2 },
      { part: 'e-ii', label: '(e)(ii)', got: 1, max: 1 }
    ]);
    assert.equal(rep.points.length, 9);
    assert.equal(rep.points[1].comment, '✓ Six sets of readings with correct trend');
    var params = exp.sampleParams(VL.rng.create('SYN-AAAA-BBBB').fork('params'), 'graph');
    assert.equal(rep.modelAnswer.c, params.c, 'params rebuilt from the seed');
    assert.equal(rep.modelAnswer.r, VL.rng.create('SYN-AAAA-BBBB').fork('model').next(), 'model rng is the model fork');
    assert.deepEqual(rep.commonMistakes, ['Timing only one oscillation.']);
  });

  test('run: a throwing mark point scores 0 with "could not be marked"; ctx has params and helpers', function () {
    var seen = null;
    var exp = syntheticExperiment([
      P.custom({ id: 'boom', part: 'a', skill: 'MMO', check: function () { throw new Error('bug'); } }),
      P.custom({ id: 'spy', part: 'zz', skill: 'MMO', max: 2, check: function (ctx) {
        seen = ctx;
        return { awarded: 5, comment: 'over-awarded' };
      } })
    ]);
    var rep = M.run(exp, { expId: 'synthetic', variantId: 'graph', seed: 'SYN-CCCC-DDDD' });
    var boom = rep.points.filter(function (p) { return p.id === 'boom'; })[0];
    assert.equal(boom.awarded, 0);
    assert.match(boom.comment, /could not be marked/);
    var spy = rep.points.filter(function (p) { return p.id === 'spy'; })[0];
    assert.equal(spy.awarded, 2, 'awarded clamped to max');
    assert.equal(seen.params.c, exp.sampleParams(VL.rng.create('SYN-CCCC-DDDD').fork('params'), 'graph').c);
    assert.equal(typeof seen.answer, 'function');
    assert.equal(seen.answer('missing'), '');
    assert.equal(seen.num('0.50').sf, 2);
    assert.equal(seen.vu('9.8 m s^-2').unit.ok, true);
    assert.ok(seen.cols && Array.isArray(seen.cols.L));
    var zz = rep.parts.filter(function (p) { return p.part === 'zz'; })[0];
    assert.equal(zz.max, 2, 'parts not in the paper are appended');
    assert.match(rep.markedAt, /^\d{4}-\d\d-\d\dT/);
  });

  test('run: an empty question (no table, graph or answers) marks without errors', function () {
    var exp = syntheticExperiment();
    var rep = M.run(exp, { expId: 'synthetic', variantId: 'graph', seed: 'SYN-EEEE-FFFF', table: null, graph: null, answers: {} });
    assert.equal(rep.total, 0);
    assert.equal(rep.max, 11);
    rep.points.forEach(function (p) {
      assert.ok(!/could not be marked/.test(p.comment), p.id + ' threw: ' + JSON.stringify(p.details));
      assert.match(p.comment, /^✗ /);
    });
  });

  test('run: limitationsImprovements arrays inside a rubric are flattened', function () {
    var bank = [{ id: 'A', limitation: { label: 'l', concepts: [[['alpha']]] }, improvement: { label: 'i', concepts: [[['beta']]] } }];
    var exp = syntheticExperiment([P.limitationsImprovements({ limKey: 'lim', impKey: 'imp', bank: bank, limPart: 'h-i', impPart: 'h-ii' })]);
    var rep = M.run(exp, { variantId: 'graph', seed: 'SYN-GGGG-HHHH', answers: { lim: 'alpha', imp: ['beta'] } });
    var ev = rep.points.filter(function (p) { return /^evaluation/.test(p.id); });
    assert.equal(ev.length, 2);
    assert.equal(ev[0].awarded, 1);
    assert.equal(ev[1].awarded, 1);
    assert.equal(rep.skills.ACE.max, 9);
  });
})();
