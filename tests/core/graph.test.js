/* Tests for core/graph.js (VL.graph). */
(function () {
  'use strict';
  var VL = globalThis.VLab;
  var G = VL.graph;
  var DT = VL.datatable;

  /** Table with x and y columns from arrays of strings. */
  function table(xh, yh, xs, ys) {
    var t = DT.create({ columns: 2, rows: xs.length });
    DT.setHeading(t, 'c1', xh);
    DT.setHeading(t, 'c2', yh);
    xs.forEach(function (x, i) {
      DT.setCell(t, t.rows[i].id, 'c1', x);
      DT.setCell(t, t.rows[i].id, 'c2', ys[i]);
    });
    return t;
  }

  /** Graph with given scales, columns c1/c2 and labels. */
  function graph(xo, xp, yo, yp) {
    var g = G.create();
    g.x = { colId: 'c1', label: 'L / cm', origin: xo, perLarge: xp, labelEvery: 2 };
    g.y = { colId: 'c2', label: 'T² / s²', origin: yo, perLarge: yp, labelEvery: 1 };
    return g;
  }

  /** Plot every row exactly (test helper; the student UI never does this). */
  function plotAll(g, t) {
    G.plottableRows(g, t).forEach(function (r) {
      var p = G.toGrid(g, r.x, r.y);
      G.addPoint(g, r.rowId, p.gx, p.gy);
    });
  }

  // A clean straight-line data set: y = 0.04 x + 0.05 (pendulum-like T² against L, L in cm)
  var XS = ['20.0', '35.0', '50.0', '65.0', '80.0', '95.0'];
  var YS = ['0.85', '1.45', '2.05', '2.65', '3.25', '3.85'];

  test('create: default 14 × 10 large squares of 10 small squares', function () {
    var g = G.create();
    assert.deepEqual(g.grid, { cols: 14, rows: 10, small: 10 });
    assert.deepEqual(g.x, { colId: null, label: '', origin: 0, perLarge: 1, labelEvery: 1 });
    assert.equal(g.points.length, 0);
    assert.equal(g.line, null);
    assert.deepEqual(g.readOffs, { x1: '', y1: '', x2: '', y2: '' });
    assert.deepEqual(g.intercept, { method: null, value: '' });
    assert.equal(g.worstLine, null);
  });

  test('valueToGrid / gridToValue are inverse and respect the origin', function () {
    var axis = { origin: 20, perLarge: 5 };
    assert.close(G.valueToGrid(axis, 32.5), 25, 1e-12);
    assert.close(G.gridToValue(axis, 25), 32.5, 1e-12);
    assert.close(G.valueToGrid({ origin: 0, perLarge: 0.2 }, 1.0), 50, 1e-9);
    assert.close(G.valueToGrid({ origin: 0, perLarge: 0.2 }, 1.0, 5), 25, 1e-9, 'custom small squares');
    [0, 0.37, 13.9, 140].forEach(function (gx) {
      assert.close(G.valueToGrid(axis, G.gridToValue(axis, gx)), gx, 1e-9);
    });
    assert.ok(isNaN(G.valueToGrid({ origin: 0, perLarge: 0 }, 1)), 'unusable scale gives NaN');
  });

  test('lineY, lineLength, lineValueAt', function () {
    var g = graph(0, 10, 0, 0.5);
    g.line = { a: { gx: 0, gy: 10 }, b: { gx: 100, gy: 90 } };
    assert.close(G.lineY(g.line, 50), 50, 1e-12);
    assert.close(G.lineY(g.line, 150), 130, 1e-12, 'extrapolates');
    assert.close(G.lineLength(g.line), Math.sqrt(100 * 100 + 80 * 80), 1e-9);
    // x = 50 value -> gx = 50 -> gy = 50 -> y = 2.5
    assert.close(G.lineValueAt(g, 50), 2.5, 1e-12);
    assert.close(G.lineGradient(g), 0.8 * 0.5 / 10, 1e-12);
    assert.equal(G.lineY({ a: { gx: 3, gy: 0 }, b: { gx: 3, gy: 9 } }, 3), null, 'vertical line');
  });

  test('checkScale: allowed and awkward scale mantissas', function () {
    var vals = [0, 1.4];
    function awk(per) {
      var g = graph(0, per, 0, 1);
      return G.checkScale(g, 'x', vals).awkward;
    }
    [1, 2, 4, 5, 0.1, 0.2, 0.4, 0.5, 10, 20, 50, 0.002, 4e-5, 5e6].forEach(function (p) {
      assert.equal(awk(p), false, p + ' per large square is fine');
    });
    [3, 6, 7, 9, 2.5, 0.3, 1.5, 0.25, 8].forEach(function (p) {
      assert.equal(awk(p), true, p + ' per large square is awkward');
    });
    assert.equal(G.isAwkward(0.30000000000000004), true);
    assert.equal(G.isAwkward(0.1 + 0.2 - 0.1), false, 'float junk around 0.2 is still 2');
  });

  test('checkScale: fill, fit, labelEvery, label', function () {
    var g = graph(0, 10, 0, 0.5);
    var xs = XS.map(Number);
    var r = G.checkScale(g, 'x', xs);
    assert.close(r.fill, 75 / 140, 1e-9, 'x data spans 7.5 of 14 large squares');
    assert.ok(r.fitsOnGrid && r.labelled && !r.awkward && r.labelEveryOk);
    assert.ok(r.ok);
    g.x.perLarge = 20;                       // spans 3.75 / 14 large squares
    r = G.checkScale(g, 'x', XS);            // strings are accepted too
    assert.ok(r.fill < 0.5 && !r.ok);
    assert.ok(r.problems.some(function (p) { return /less than half/.test(p); }));
    g.x.perLarge = 5;                        // 95 needs 19 large squares
    r = G.checkScale(g, 'x', xs);
    assert.equal(r.fitsOnGrid, false);
    assert.equal(r.ok, false);
    g.x.perLarge = 10;
    g.x.labelEvery = 4;
    r = G.checkScale(g, 'x', xs);
    assert.equal(r.labelEveryOk, false);
    assert.equal(r.ok, false);
    g.x.labelEvery = 3;
    g.x.label = '  ';
    r = G.checkScale(g, 'x', xs);
    assert.ok(r.labelEveryOk && !r.labelled && !r.ok);
    // y: T² 0.85 … 3.85 with 0.5 per large -> spans 6 of 10 large squares
    r = G.checkScale(g, 'y', YS.map(Number));
    assert.close(r.fill, 0.6, 1e-9);
    assert.ok(r.ok);
    g.y.origin = 0.35;
    assert.ok(G.checkScale(g, 'y', YS).advice.length >= 1, 'advice about a misaligned origin');
    g.y.perLarge = 0;
    r = G.checkScale(g, 'y', YS);
    assert.equal(r.validScale, false);
    assert.equal(r.ok, false);
  });

  test('checkPlotting: 0.5 small square tolerance, missing and extra points', function () {
    var t = table('L / cm', 'T² / s²', XS.concat(['', 'abc']), YS.concat(['1.00', '2.00']));
    var g = graph(0, 10, 0, 0.5);
    var r = G.checkPlotting(g, t);
    assert.equal(r.expected, 6, 'rows without numeric x and y are not required');
    assert.equal(r.missingRows.length, 6);
    assert.equal(r.ok, false);
    plotAll(g, t);
    r = G.checkPlotting(g, t);
    assert.ok(r.allPlotted && r.ok);
    g.points[2].gx += 0.5;                  // exactly half a small square: still fine
    g.points[3].gy -= 0.49;
    assert.ok(G.checkPlotting(g, t).ok);
    g.points[2].gx += 0.11;                 // now 0.61 out
    r = G.checkPlotting(g, t);
    assert.equal(r.ok, false);
    var bad = r.points.filter(function (p) { return !p.ok; });
    assert.equal(bad.length, 1);
    assert.equal(bad[0].rowId, t.rows[2].id);
    assert.close(bad[0].errX, 0.61, 1e-9);
    assert.ok(r.problems.some(function (p) { return /row 3/.test(p); }));
    g.points[2].gx -= 0.61;
    G.addPoint(g, null, 5, 5);
    r = G.checkPlotting(g, t);
    assert.equal(r.extraPoints.length, 1);
    assert.equal(r.ok, false);
    G.removePoint(g, r.extraPoints[0]);
    G.removePoint(g, g.points[0].id);
    r = G.checkPlotting(g, t);
    assert.deepEqual(r.missingRows, [t.rows[0].id]);
    assert.equal(r.allPlotted, false);
    var g2 = G.create();
    assert.equal(G.checkPlotting(g2, t).ok, false, 'no columns chosen');
  });

  test('checkLine: a least-squares line is balanced; shifted or tilted lines are not', function () {
    var t = table('L / cm', 'T² / s²', XS, ['0.86', '1.43', '2.07', '2.63', '3.27', '3.84']);
    var g = graph(0, 10, 0, 0.5);
    plotAll(g, t);
    var lsq = G.checkLine(g, t);
    assert.equal(lsq.present, false);
    // fit in grid units and draw the line across the data
    var xs = g.points.map(function (p) { return p.gx; }), ys = g.points.map(function (p) { return p.gy; });
    var n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    var m = (n * sxy - sx * sy) / (n * sxx - sx * sx), c = (sy - m * sx) / n;
    g.line = { a: { gx: 15, gy: m * 15 + c }, b: { gx: 100, gy: m * 100 + c } };
    var r = G.checkLine(g, t);
    assert.ok(r.present && r.balanced && r.spansData && r.ok, JSON.stringify(r.problems));
    assert.equal(r.usedPoints, 6);
    assert.ok(Math.abs(r.above - r.below) <= 2);
    assert.close(r.lsq.m, 0.04, 0.001, 'lsq gradient in value units (s² per cm)');
    assert.close(r.lsq.c, 0.05, 0.03, 'lsq intercept in value units');
    // shift the line up by 3 small squares -> all points below
    g.line = { a: { gx: 15, gy: m * 15 + c + 3 }, b: { gx: 100, gy: m * 100 + c + 3 } };
    r = G.checkLine(g, t);
    assert.equal(r.balanced, false);
    assert.ok(r.problems.some(function (p) { return /above most/.test(p); }));
    // tilt: pivot about the centre so the ends are 3 small squares out in opposite directions
    g.line = { a: { gx: 15, gy: m * 15 + c - 3.4 }, b: { gx: 100, gy: m * 100 + c + 3.4 } };
    r = G.checkLine(g, t);
    assert.equal(r.balanced, false);
    assert.ok(r.problems.some(function (p) { return /trend/.test(p); }));
    // a line covering only half of the data range
    g.line = { a: { gx: 15, gy: m * 15 + c }, b: { gx: 50, gy: m * 50 + c } };
    r = G.checkLine(g, t);
    assert.equal(r.spansData, false);
    assert.equal(r.ok, false);
    // fewer than 5 points
    g.line = { a: { gx: 15, gy: m * 15 + c }, b: { gx: 100, gy: m * 100 + c } };
    g.points.splice(0, 2);
    r = G.checkLine(g, t);
    assert.equal(r.usedPoints, 4);
    assert.equal(r.balanced, false);
  });

  test('checkLine: only a circled anomaly may be ignored', function () {
    var ys = ['0.85', '1.45', '2.05', '3.60', '3.25', '3.85', '4.45'];   // row 4 is an anomaly
    var xs = XS.concat(['110.0']);
    var t = table('L / cm', 'T² / s²', xs, ys);
    var g = graph(0, 10, 0, 0.5);
    plotAll(g, t);
    // the true line y = 0.04x + 0.05 through the good points
    g.line = { a: { gx: 15, gy: (0.04 * 15 + 0.05) / 0.05 }, b: { gx: 115, gy: (0.04 * 115 + 0.05) / 0.05 } };
    var r = G.checkLine(g, t);
    assert.equal(r.ok, false, 'a line that ignores an uncircled anomaly is not balanced');
    assert.ok(r.ignoresUncircled);
    // a line dragged towards the uncircled anomaly (least squares through all points) is not balanced either:
    // most points lie on one side of it, so the student must circle the anomaly
    var xsG = g.points.map(function (p) { return p.gx; }), ysG = g.points.map(function (p) { return p.gy; });
    var n = xsG.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += xsG[i]; sy += ysG[i]; sxx += xsG[i] * xsG[i]; sxy += xsG[i] * ysG[i]; }
    var m = (n * sxy - sx * sy) / (n * sxx - sx * sx), c = (sy - m * sx) / n;
    var trueLine = g.line;
    g.line = { a: { gx: 15, gy: m * 15 + c }, b: { gx: 115, gy: m * 115 + c } };
    r = G.checkLine(g, t);
    assert.ok(!r.ok && !r.ignoresUncircled, 'line through all points: ' + JSON.stringify(r.problems));
    assert.ok(r.problems.some(function (p) { return /not balanced/.test(p); }));
    g.line = trueLine;
    g.points[3].anomaly = true;
    r = G.checkLine(g, t);
    assert.equal(r.usedPoints, 6);
    assert.ok(r.ok, 'circled anomaly is ignored: ' + JSON.stringify(r.problems));
    g.points[0].anomaly = true;
    r = G.checkLine(g, t);
    assert.equal(r.ok, false, 'two circled anomalies are not allowed');
    assert.ok(r.problems.some(function (p) { return /only one/.test(p); }));
  });

  /** Least-squares line (grid units) through the uncircled points, drawn from gx a to gx b. */
  function lsqLine(g, a, b) {
    var pts = g.points.filter(function (p) { return !p.anomaly; });
    var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(function (p) { sx += p.gx; sy += p.gy; sxx += p.gx * p.gx; sxy += p.gx * p.gy; });
    var m = (n * sxy - sx * sy) / (n * sxx - sx * sx), c = (sy - m * sx) / n;
    return { a: { gx: a, gy: m * a + c }, b: { gx: b, gy: m * b + c } };
  }

  test('checkLine: an uncircled outlier cannot be ignored with only 5 points used, nor widen the tolerance', function () {
    // y = 0.04x + 0.05 with 0.05 s² per small square; row 4 raised by 0.37 s² (7.4 small squares)
    var trueLine = { a: { gx: 15, gy: (0.04 * 15 + 0.05) / 0.05 }, b: { gx: 100, gy: (0.04 * 100 + 0.05) / 0.05 } };
    var five = ['0.85', '1.45', '2.05', '3.02', '3.25'];
    // (a) 5 points, the outlier not circled, the line through the other 4
    var t = table('L / cm', 'T² / s²', XS.slice(0, 5), five);
    var g = graph(0, 10, 0, 0.5);
    plotAll(g, t);
    g.line = trueLine;
    var r = G.checkLine(g, t);
    assert.equal(r.ok, false, '5 points: ' + JSON.stringify(r));
    assert.equal(r.ignoresUncircled, true);
    assert.ok(r.problems.some(function (p) { return /far from it but not circled/.test(p); }));
    // (b) 6 points, a GOOD point (row 1) circled and the outlier (row 4) left uncircled
    var t6 = table('L / cm', 'T² / s²', XS, five.concat(['3.85']));
    var g6 = graph(0, 10, 0, 0.5);
    plotAll(g6, t6);
    g6.line = trueLine;
    g6.points[0].anomaly = true;
    r = G.checkLine(g6, t6);
    assert.equal(r.ok, false, 'the wrong point circled: ' + JSON.stringify(r.problems));
    assert.equal(r.ignoresUncircled, true);
    // (c) the outlier circled: it may be ignored (with 5 points left the line is credited)
    g6.points[0].anomaly = false;
    g6.points[3].anomaly = true;
    r = G.checkLine(g6, t6);
    assert.ok(r.ok, 'outlier circled, 5 points left: ' + JSON.stringify(r.problems));
    g.points[3].anomaly = true;
    r = G.checkLine(g, t);
    assert.equal(r.ignoresUncircled, false, 'the same 5 points with the outlier circled: nothing uncircled is ignored');
    assert.deepEqual(r.problems, ['At least five plotted points are needed to judge a line of best fit (4 used).'],
      'only the Cambridge "five points left after the anomaly" rule applies');
    // (d) a genuinely balanced line through 5 noisy points is still credited
    var tn = table('L / cm', 'T² / s²', XS.slice(0, 5), ['0.87', '1.42', '2.08', '2.62', '3.27']);
    var gn = graph(0, 10, 0, 0.5);
    plotAll(gn, tn);
    gn.line = lsqLine(gn, 15, 85);
    r = G.checkLine(gn, tn);
    assert.ok(r.ok && !r.ignoresUncircled, 'least-squares line: ' + JSON.stringify(r.problems));
    gn.line = { a: { gx: 15, gy: gn.line.a.gy + 0.25 }, b: { gx: 85, gy: gn.line.b.gy - 0.25 } };
    r = G.checkLine(gn, tn);
    assert.ok(r.ok, 'slightly tilted from the least-squares line: ' + JSON.stringify(r.problems));
    assert.close(r.tol, 1, 1e-9, 'tolerance not widened by the scatter of 5 good points');
  });

  test('checkTriangle: hypotenuse fraction and read-off accuracy', function () {
    var g = graph(0, 10, 0, 0.5);
    g.line = { a: { gx: 0, gy: 0 }, b: { gx: 100, gy: 80 } };          // y = 0.8 gx
    g.triangle = { p1: { gx: 20, gy: 16 }, p2: { gx: 80, gy: 64 } };   // 60 % of the line
    // vertex values: x = gx (10 per large = 1 per small), y = gy * 0.05
    g.readOffs = { x1: '20.0', y1: '0.80', x2: '80.0', y2: '3.20' };
    var r = G.checkTriangle(g);
    assert.ok(r.present && r.onLine);
    assert.close(r.hypFraction, 0.6, 1e-9);
    assert.ok(r.bigEnough);
    assert.ok(r.readOffsOk);
    assert.close(r.gradient, 0.04, 1e-12, 'Δy/Δx from typed read-offs');
    assert.ok(r.ok);
    // swapped order is fine
    g.readOffs = { x1: '80.0', y1: '3.20', x2: '20.0', y2: '0.80' };
    assert.ok(G.checkTriangle(g).readOffsOk);
    // read-off 0.4 small square out in y (0.02 s²) is fine; 0.6 small square (0.03 s²) is not
    g.readOffs = { x1: '20.0', y1: '0.82', x2: '80.0', y2: '3.20' };
    assert.ok(G.checkTriangle(g).readOffsOk);
    g.readOffs = { x1: '20.0', y1: '0.83', x2: '80.0', y2: '3.20' };
    r = G.checkTriangle(g);
    assert.equal(r.readOffsOk, false);
    assert.close(r.gradient, (3.20 - 0.83) / 60, 1e-12, 'gradient still from what was typed');
    // small triangle: 30 % of the line
    g.triangle = { p1: { gx: 40, gy: 32 }, p2: { gx: 70, gy: 56 } };
    r = G.checkTriangle(g);
    assert.close(r.hypFraction, 0.3, 1e-9);
    assert.equal(r.bigEnough, false);
    assert.ok(r.problems.some(function (p) { return /too small/.test(p); }));
    // vertex off the line
    g.triangle = { p1: { gx: 20, gy: 18 }, p2: { gx: 80, gy: 64 } };
    assert.equal(G.checkTriangle(g).onLine, false);
    // missing read-offs
    g.readOffs = { x1: '', y1: '', x2: '', y2: '' };
    r = G.checkTriangle(g);
    assert.equal(r.gradient, null);
    assert.equal(r.ok, false);
  });

  test('checkIntercept: direct reading when the x-axis starts at 0', function () {
    var g = graph(0, 10, 0, 0.5);
    g.line = { a: { gx: 10, gy: 9 }, b: { gx: 100, gy: 81 } };   // gy = 0.8 gx + 1 -> y(0) = 0.05
    var r = G.checkIntercept(g, '0.05');
    assert.equal(r.falseOrigin, false);
    assert.ok(r.readable);
    assert.close(r.expected, 0.05, 1e-12);
    assert.ok(r.ok);
    assert.equal(r.method, 'direct');
    assert.ok(G.checkIntercept(g, '0.07').ok, '0.4 small square out is fine');
    assert.equal(G.checkIntercept(g, '0.09').ok, false, '0.8 small square out is not');
    assert.equal(G.checkIntercept(g, '').ok, false);
  });

  test('checkIntercept: false origin needs substitution with the student’s own values', function () {
    var g = graph(20, 5, 0.5, 0.4);
    // y = 0.04 x + 0.05 drawn on a false-origin grid
    function gpt(x) { return G.toGrid(g, x, 0.04 * x + 0.05); }
    g.line = { a: gpt(20), b: gpt(90) };
    var r = G.checkIntercept(g, '0.05');
    assert.ok(r.falseOrigin);
    assert.equal(r.readable, false);
    assert.close(r.expected, 0.05, 1e-9);
    assert.ok(r.ok, 'the exact extrapolated value is accepted');
    // student read-offs slightly off the exact line but within half a small square
    g.triangle = { p1: gpt(30), p2: gpt(85) };
    g.readOffs = { x1: '30.0', y1: '1.26', x2: '85.0', y2: '3.45' };
    var tri = G.checkTriangle(g);
    assert.ok(tri.readOffsOk, 'read-offs within half a small square');
    var m = tri.gradient;                     // (3.45 - 1.26) / 55
    var c = 1.26 - m * 30;
    r = G.checkIntercept(g, String(c.toFixed(3)));
    assert.ok(r.ok, 'c = y1 − m x1 from the student’s read-offs is accepted');
    assert.equal(r.method, 'substitution');
    // using a gradient the student typed as an answer
    r = G.checkIntercept(g, (1.26 - 0.0398 * 30).toFixed(3), { gradient: '0.0398' });
    assert.ok(r.ok);
    // the value at the left edge of the grid (x = 20) is a classic mistake
    r = G.checkIntercept(g, '0.85');
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(function (p) { return /does not start at zero/.test(p); }));
  });

  test('formatTick and formatNumber avoid floating-point junk', function () {
    assert.equal(G.formatTick(0.1 * 3, 0.1), '0.3');
    assert.equal(G.formatTick(0.2 + 0.1, 0.1), '0.3');
    assert.equal(G.formatTick(1, 0.5), '1.0');
    assert.equal(G.formatTick(0, 0.5), '0');
    assert.equal(G.formatTick(-1e-17, 0.5), '0');
    assert.equal(G.formatTick(40, 20), '40');
    assert.equal(G.formatTick(0.006, 0.002), '0.006');
    assert.equal(G.formatTick(1.25, 0.25), '1.25');
    assert.equal(G.formatTick(-0.4, 0.2), '−0.4');
    assert.equal(G.formatTick(3e-5, 1e-5), '3 × 10⁻⁵');
    assert.equal(G.formatNumber(0.1 + 0.2), '0.3');
    assert.equal(G.decimalsFor(0.25), 2);
    assert.equal(G.formatTick(0.35 + 0.2, 0.2, 0.35), '0.55', 'origin decimals kept');
    assert.equal(G.formatTick(20 + 3 * 5, 5, 20), '35');
  });

  test('niceScale picks 1, 2, 4 or 5 × 10ⁿ and fits the data', function () {
    var s = G.niceScale(20, 95, 14);
    assert.equal(G.isAwkward(s.perLarge), false);
    assert.ok(s.origin <= 20 && s.origin + 14 * s.perLarge >= 95);
    assert.ok((95 - 20) / (14 * s.perLarge) >= 0.5, 'fills at least half the grid');
    var z = G.niceScale(0, 3.85, 10);
    assert.equal(z.origin, 0);
    assert.equal(z.perLarge, 0.4);
  });

  test('modelGraph passes every check (model answers only)', function () {
    var t = table('L / cm', 'T² / s²', XS, ['0.86', '1.43', '2.07', '2.63', '3.27', '3.84']);
    var g = G.modelGraph(t, 'c1', 'c2');
    assert.ok(G.checkScale(g, 'x', XS).ok, JSON.stringify(G.checkScale(g, 'x', XS).problems));
    assert.ok(G.checkScale(g, 'y', ['0.86', '3.84']).ok);
    assert.ok(G.checkPlotting(g, t).ok);
    assert.ok(G.checkLine(g, t).ok, JSON.stringify(G.checkLine(g, t).problems));
    var tri = G.checkTriangle(g);
    assert.ok(tri.ok, JSON.stringify(tri.problems));
    assert.close(tri.gradient, 0.0399, 0.001);
    var ic = G.checkIntercept(g, g.intercept.value, { gradient: tri.gradient });
    assert.ok(ic.ok, JSON.stringify(ic));
    // the intercept is read directly at x = 0, so the line is drawn down to the y-axis
    assert.equal(g.x.origin, 0);
    assert.equal(g.intercept.method, 'direct');
    assert.close(Math.min(g.line.a.gx, g.line.b.gx), 0, 1e-9, 'line reaches x = 0');
    assert.ok(Math.max(g.line.a.gx, g.line.b.gx) <= G.valueToGrid(g.x, 95) + 5 + 1e-9, 'and stops just past the data');
    // a data set far from zero gets a false origin and substitution
    var t2 = table('m / g', 'V / cm³', ['400', '450', '500', '550', '600', '650'],
      ['801', '852', '899', '951', '1002', '1049']);
    var g2 = G.modelGraph(t2, 'c1', 'c2');
    assert.ok(g2.x.origin !== 0);
    assert.equal(g2.intercept.method, 'substitution');
    assert.ok(G.checkLine(g2, t2).ok);
    assert.ok(G.checkTriangle(g2).ok);
    assert.ok(G.checkIntercept(g2, g2.intercept.value).ok);
  });

  test('history: undo / redo restore the graph in place', function () {
    var g = graph(0, 10, 0, 0.5);
    var h = G.history(g);
    h.change(function (gr) { G.addPoint(gr, 'r1', 10, 10); });
    h.begin();
    g.points[0].gx = 11;
    g.points[0].gx = 12;                     // a drag: several moves, one step
    h.end();
    assert.equal(h.change(function () {}), false, 'no-op not recorded');
    h.change(function (gr) { gr.line = { a: { gx: 0, gy: 0 }, b: { gx: 10, gy: 10 } }; });
    var ref = g;
    assert.ok(h.undo());
    assert.equal(g.line, null);
    assert.ok(h.undo());
    assert.equal(g.points[0].gx, 10);
    assert.ok(h.undo());
    assert.equal(g.points.length, 0);
    assert.equal(h.undo(), false);
    assert.ok(h.redo() && h.redo() && h.redo());
    assert.equal(g.points[0].gx, 12);
    assert.ok(g.line);
    assert.ok(ref === g, 'same object');
    h.begin();
    g.points[0].gx = 99;
    h.cancel();
    assert.equal(g.points[0].gx, 12, 'cancel restores');
  });

  test('JSON round trip, clone independence and repair', function () {
    var g = graph(20, 5, 0.5, 0.4);
    var p = G.addPoint(g, 'r1', 12.3, 45.6);
    p.anomaly = true;
    g.line = { a: { gx: 1, gy: 2 }, b: { gx: 100, gy: 90 } };
    g.triangle = { p1: { gx: 10, gy: 11 }, p2: { gx: 80, gy: 70 } };
    g.readOffs = { x1: '25.0', y1: '0.94', x2: '60.0', y2: '3.30' };
    g.intercept = { method: 'substitution', value: '0.05' };
    g.worstLine = { a: { gx: 0, gy: 5 }, b: { gx: 100, gy: 85 } };
    var back = G.fromJSON(JSON.parse(JSON.stringify(G.toJSON(g))));
    assert.deepEqual(back, g);
    var c = G.clone(g);
    c.points[0].gx = 0;
    assert.equal(g.points[0].gx, 12.3);
    var repaired = G.fromJSON({ points: [{ gx: 1, gy: 2 }, { gx: 'x', gy: 1 }], line: { a: { gx: 1 } }, nextId: 0 });
    assert.equal(repaired.points.length, 1);
    assert.ok(repaired.points[0].id);
    assert.equal(repaired.line, null);
    assert.deepEqual(repaired.grid, { cols: 14, rows: 10, small: 10 });
    var q = G.addPoint(repaired, 'r1', 3, 3);
    assert.ok(q.id !== repaired.points[0].id, 'no id clash');
  });
})();
