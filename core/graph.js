/**
 * Graph-paper model and Cambridge-style graph checks (docs/ARCHITECTURE.md §3.9).
 *
 * All positions are in SMALL SQUARES measured from the bottom-left corner of the grid (floats).
 * One large square = grid.small small squares (10) = 2 cm on the printed grid.
 *
 *   Graph = {
 *     grid: { cols: 14, rows: 10, small: 10 },
 *     x: { colId, label, origin, perLarge, labelEvery },   // origin = value at the left edge
 *     y: { colId, label, origin, perLarge, labelEvery },   // origin = value at the bottom edge
 *     points: [ { id, rowId, gx, gy, anomaly } ],
 *     line: null | { a: {gx, gy}, b: {gx, gy} },
 *     triangle: null | { p1: {gx, gy}, p2: {gx, gy} },
 *     readOffs: { x1, y1, x2, y2 },                        // strings exactly as typed by the student
 *     intercept: { method: null|'direct'|'substitution', value: '' },
 *     worstLine: null | { a, b },                          // Paper 5 extension only
 *     nextId
 *   }
 *
 * Additive helpers beyond the contract (documented in the lead's report): toGrid/toValue, lineGradient,
 * addPoint/removePoint/findPoint/pointForRow, scaleMantissa/isAwkward, formatTick/formatNumber,
 * niceScale, modelGraph (model answers ONLY — never used to fill in a student's graph), history (snapshot
 * undo/redo), parseNumber. valueToGrid / gridToValue take an optional third argument `small`
 * (small squares per large square, default 10) because an axis object does not know the grid.
 */
(function (VL) {
  'use strict';

  var EPS = 1e-9;
  var ALLOWED_MANTISSAS = [1, 2, 4, 5];
  var DEFAULT_GRID = { cols: 14, rows: 10, small: 10 };

  /* ------------------------------------------------------------------ numbers */

  /**
   * Parse a typed number (string) or pass a number through. Uses VL.sigfig.parse when loaded.
   * @param {string|number} v
   * @returns {number} NaN when not a number
   */
  function parseNumber(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) return NaN;
    var s = String(v);
    if (!s.trim()) return NaN;
    if (VL.sigfig && typeof VL.sigfig.parse === 'function') {
      var p = VL.sigfig.parse(s);
      return p && p.ok ? p.value : NaN;
    }
    if (VL.datatable && typeof VL.datatable.parseNumber === 'function') {
      var q = VL.datatable.parseNumber(s);
      return q && q.ok ? q.value : NaN;
    }
    var n = Number(s.trim().replace(/−/g, '-'));
    return isFinite(n) ? n : NaN;
  }

  /** Remove floating-point junk: 0.30000000000000004 -> 0.3. */
  function clean(x) {
    return isFinite(x) ? parseFloat(Number(x).toPrecision(12)) : x;
  }

  /**
   * Number of decimal places needed to write `step` exactly (0.25 -> 2, 0.5 -> 1, 20 -> 0).
   * @param {number} step
   */
  function decimalsFor(step) {
    step = Math.abs(step);
    if (!isFinite(step) || step === 0) return 0;
    for (var d = 0; d <= 12; d++) {
      var v = step * Math.pow(10, d);
      if (Math.abs(v - Math.round(v)) < 1e-6 * Math.max(1, v)) return d;
    }
    return 12;
  }

  var SUPERSCRIPT = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

  function superscript(n) {
    return String(n).split('').map(function (c) { return SUPERSCRIPT[c] || c; }).join('');
  }

  /**
   * Format any number cleanly for messages (no float junk); very large/small values use × 10ⁿ.
   * @param {number} x
   * @returns {string}
   */
  function formatNumber(x) {
    if (!isFinite(x)) return String(x);
    var c = clean(x);
    if (c === 0) return '0';
    var a = Math.abs(c);
    if (a >= 1e-4 && a < 1e6) return String(c).replace('-', '−');
    var e = Math.floor(Math.log10(a));
    var m = clean(c / Math.pow(10, e));
    return String(m).replace('-', '−') + ' × 10' + superscript(e);
  }

  /**
   * Format a scale number so that every label on an axis has the same, minimal number of decimal places
   * for its step (no floating-point junk). Zero is written '0'. Steps below 1e-4 or from 1e6 use × 10ⁿ.
   * @param {number} value
   * @param {number} step distance between labelled values
   * @param {number} [origin] first labelled value; its decimals are kept too (origin 0.35, step 0.2 -> '0.55')
   * @returns {string}
   */
  function formatTick(value, step, origin) {
    if (!isFinite(value)) return '';
    var s = Math.abs(step) || 1;
    var v = Math.abs(value) < s * 1e-6 ? 0 : value;
    if (v === 0) return '0';
    var o = origin && isFinite(origin) ? Math.abs(clean(origin)) : 0;
    if (s < 1e-4 || s >= 1e6) {
      var e = Math.floor(Math.log10(s));
      var m = v / Math.pow(10, e);
      var d = Math.max(decimalsFor(clean(s / Math.pow(10, e))), o ? decimalsFor(clean(o / Math.pow(10, e))) : 0);
      return m.toFixed(d).replace('-', '−') + ' × 10' + superscript(e);
    }
    var out = v.toFixed(Math.max(decimalsFor(clean(s)), o ? decimalsFor(o) : 0));
    if (/^-0(\.0*)?$/.test(out)) out = out.slice(1);
    return out.replace('-', '−');
  }

  /* ------------------------------------------------------------------ construction */

  function defaultAxis() {
    return { colId: null, label: '', origin: 0, perLarge: 1, labelEvery: 1 };
  }

  /**
   * Create an empty graph.
   * @param {{cols?:number, rows?:number, small?:number}} [opts] grid size (default 14 × 10 large squares of 10)
   * @returns {object} Graph
   */
  function create(opts) {
    opts = opts || {};
    return {
      grid: {
        cols: opts.cols || DEFAULT_GRID.cols,
        rows: opts.rows || DEFAULT_GRID.rows,
        small: opts.small || DEFAULT_GRID.small
      },
      x: defaultAxis(),
      y: defaultAxis(),
      points: [],
      line: null,
      triangle: null,
      readOffs: { x1: '', y1: '', x2: '', y2: '' },
      intercept: { method: null, value: '' },
      worstLine: null,
      nextId: 1
    };
  }

  /* ------------------------------------------------------------------ mapping */

  function smallOf(graph) {
    return (graph && graph.grid && graph.grid.small) || DEFAULT_GRID.small;
  }

  function validAxis(axis) {
    return !!axis && isFinite(axis.origin) && isFinite(axis.perLarge) && axis.perLarge > 0;
  }

  /**
   * Value → position in small squares along one axis.
   * @param {object} axis { origin, perLarge }
   * @param {number} value
   * @param {number} [small=10] small squares per large square
   * @returns {number} NaN when the scale is unusable
   */
  function valueToGrid(axis, value, small) {
    if (!validAxis(axis)) return NaN;
    small = small || DEFAULT_GRID.small;
    return (value - axis.origin) / axis.perLarge * small;
  }

  /**
   * Position in small squares → value along one axis.
   * @param {object} axis
   * @param {number} g small squares from the left / bottom edge
   * @param {number} [small=10]
   */
  function gridToValue(axis, g, small) {
    if (!validAxis(axis)) return NaN;
    small = small || DEFAULT_GRID.small;
    return axis.origin + g / small * axis.perLarge;
  }

  /** @returns {{gx:number, gy:number}} */
  function toGrid(graph, x, y) {
    var s = smallOf(graph);
    return { gx: valueToGrid(graph.x, x, s), gy: valueToGrid(graph.y, y, s) };
  }

  /** @returns {{x:number, y:number}} */
  function toValue(graph, gx, gy) {
    var s = smallOf(graph);
    return { x: gridToValue(graph.x, gx, s), y: gridToValue(graph.y, gy, s) };
  }

  /**
   * y position (small squares) of a line at a given x position; extrapolates beyond the endpoints.
   * @returns {number|null} null for a vertical (or missing) line
   */
  function lineY(line, gx) {
    if (!line || !line.a || !line.b) return null;
    var dx = line.b.gx - line.a.gx;
    if (Math.abs(dx) < 1e-12) return null;
    return line.a.gy + (gx - line.a.gx) * (line.b.gy - line.a.gy) / dx;
  }

  /** Length of a line segment in small squares (0 if missing). */
  function lineLength(line) {
    if (!line || !line.a || !line.b) return 0;
    return Math.sqrt(Math.pow(line.b.gx - line.a.gx, 2) + Math.pow(line.b.gy - line.a.gy, 2));
  }

  /**
   * y value of the student's line at a given x value.
   * @returns {number|null}
   */
  function lineValueAt(graph, xValue) {
    if (!graph || !graph.line) return null;
    var s = smallOf(graph);
    var gx = valueToGrid(graph.x, xValue, s);
    if (!isFinite(gx)) return null;
    var gy = lineY(graph.line, gx);
    if (gy === null) return null;
    var v = gridToValue(graph.y, gy, s);
    return isFinite(v) ? v : null;
  }

  /**
   * Gradient of a drawn line in value units (Δy/Δx), or null.
   * @param {object} graph
   * @param {object} [line=graph.line]
   */
  function lineGradient(graph, line) {
    line = line || graph.line;
    if (!line || !validAxis(graph.x) || !validAxis(graph.y)) return null;
    var dx = line.b.gx - line.a.gx;
    if (Math.abs(dx) < 1e-12) return null;
    return (line.b.gy - line.a.gy) / dx * graph.y.perLarge / graph.x.perLarge;
  }

  /** Perpendicular distance (small squares) from a point to the infinite line through line.a, line.b. */
  function perpDistance(p, line) {
    var L = lineLength(line);
    if (L < EPS) return Infinity;
    var ax = line.a.gx, ay = line.a.gy, bx = line.b.gx, by = line.b.gy;
    return Math.abs((bx - ax) * (ay - p.gy) - (ax - p.gx) * (by - ay)) / L;
  }

  /* ------------------------------------------------------------------ points */

  /**
   * Add a plotted point for a table row.
   * @returns {{id:string, rowId:string|null, gx:number, gy:number, anomaly:boolean}}
   */
  function addPoint(graph, rowId, gx, gy) {
    var p = { id: 'p' + graph.nextId, rowId: rowId === undefined ? null : rowId, gx: gx, gy: gy, anomaly: false };
    graph.nextId += 1;
    graph.points.push(p);
    return p;
  }

  /** @returns {boolean} true if removed */
  function removePoint(graph, pointId) {
    for (var i = 0; i < graph.points.length; i++) {
      if (graph.points[i].id === pointId) { graph.points.splice(i, 1); return true; }
    }
    return false;
  }

  function findPoint(graph, pointId) {
    for (var i = 0; i < graph.points.length; i++) if (graph.points[i].id === pointId) return graph.points[i];
    return null;
  }

  /** First point plotted for a table row, or null. */
  function pointForRow(graph, rowId) {
    for (var i = 0; i < graph.points.length; i++) if (graph.points[i].rowId === rowId) return graph.points[i];
    return null;
  }

  /* ------------------------------------------------------------------ table access */

  function cellOf(row, colId) {
    var v = row && row.cells ? row.cells[colId] : undefined;
    return v === undefined || v === null ? '' : String(v);
  }

  /**
   * Rows of the table with numeric values in both plotted columns.
   * @returns {Array<{rowId, index, xs, ys, x, y}>}
   */
  function plottableRows(graph, table) {
    var out = [];
    if (!table || !Array.isArray(table.rows) || !graph.x.colId || !graph.y.colId) return out;
    table.rows.forEach(function (row, i) {
      var xs = cellOf(row, graph.x.colId), ys = cellOf(row, graph.y.colId);
      var x = parseNumber(xs), y = parseNumber(ys);
      if (isFinite(x) && isFinite(y)) out.push({ rowId: row.id, index: i, xs: xs, ys: ys, x: x, y: y });
    });
    return out;
  }

  function rowList(nums) {
    if (nums.length === 1) return 'row ' + nums[0];
    return 'rows ' + nums.slice(0, -1).join(', ') + ' and ' + nums[nums.length - 1];
  }

  /* ------------------------------------------------------------------ checks */

  /**
   * Mantissa of a scale step in [1, 10): 0.04 -> 4, 250 -> 2.5.
   * @returns {number} NaN for a non-positive step
   */
  function scaleMantissa(perLarge) {
    if (!(perLarge > 0) || !isFinite(perLarge)) return NaN;
    var e = Math.floor(Math.log10(perLarge));
    var m = parseFloat((perLarge / Math.pow(10, e)).toPrecision(10));
    if (m >= 10) m = parseFloat((m / 10).toPrecision(10));
    if (m < 1) m = parseFloat((m * 10).toPrecision(10));
    return m;
  }

  /** True unless the step is 1, 2, 4 or 5 × 10ⁿ. */
  function isAwkward(perLarge) {
    var m = scaleMantissa(perLarge);
    if (!isFinite(m)) return true;
    return !ALLOWED_MANTISSAS.some(function (a) { return Math.abs(m - a) < 1e-6; });
  }

  /**
   * Check one axis scale against Cambridge conventions.
   * @param {object} graph
   * @param {'x'|'y'} axisName
   * @param {Array<number|string>} values the data values plotted on this axis
   * @returns {{ok, awkward, fill, fitsOnGrid, labelEveryOk, labelled, validScale, originAligned,
   *            problems: string[], advice: string[]}}
   *   problems explain why ok is false; advice holds softer suggestions that do not affect ok.
   */
  function checkScale(graph, axisName, values) {
    var axis = graph[axisName];
    var small = smallOf(graph);
    var nLarge = axisName === 'x' ? graph.grid.cols : graph.grid.rows;
    var total = nLarge * small;
    var nums = (values || []).map(parseNumber).filter(function (v) { return isFinite(v); });
    var axisWord = axisName + '-axis';
    var res = {
      ok: false, awkward: true, fill: 0, fitsOnGrid: false, labelEveryOk: false, labelled: false,
      validScale: validAxis(axis), originAligned: false, problems: [], advice: []
    };
    res.labelled = typeof axis.label === 'string' && axis.label.trim() !== '';
    var le = axis.labelEvery;
    res.labelEveryOk = typeof le === 'number' && Math.floor(le) === le && le >= 1 && le <= 3;

    if (!res.labelled) res.problems.push('The ' + axisWord + ' is not labelled with the quantity plotted.');
    if (!res.validScale) {
      res.problems.push('The ' + axisWord + ' has no usable scale: the value per large square must be a number ' +
        'greater than zero.');
    } else {
      res.awkward = isAwkward(axis.perLarge);
      var gs = nums.map(function (v) { return valueToGrid(axis, v, small); });
      if (gs.length) {
        var lo = Math.min.apply(null, gs), hi = Math.max.apply(null, gs);
        res.fill = clean((hi - lo) / total);
        res.fitsOnGrid = lo >= -1e-6 && hi <= total + 1e-6;
      } else {
        res.fitsOnGrid = true;
      }
      var ratio = axis.origin / axis.perLarge;
      res.originAligned = Math.abs(ratio - Math.round(ratio)) < 1e-6;
      if (res.awkward) {
        res.problems.push('Awkward scale on the ' + axisWord + ': ' + formatNumber(axis.perLarge) +
          ' per large square. Use 1, 2, 4 or 5 × 10ⁿ per large square.');
      }
      if (!res.fitsOnGrid) res.problems.push('Some values do not fit on the grid along the ' + axisWord + '.');
      if (nums.length >= 2 && res.fill < 0.5 - EPS) {
        res.problems.push('The plotted points occupy less than half of the grid in the ' + axisName +
          ' direction (about ' + Math.round(res.fill * 100) + ' %).');
      } else if (nums.length < 2) {
        res.problems.push('There are not enough values to judge the ' + axisWord + ' scale.');
      }
      if (!res.originAligned) {
        res.advice.push('The ' + axisWord + ' starts at a value that is not a whole number of scale steps, ' +
          'which makes values harder to read.');
      }
    }
    if (!res.labelEveryOk) {
      res.problems.push(le > 3
        ? 'Scale markings on the ' + axisWord + ' are more than 3 large squares apart.'
        : 'Choose how often to number the ' + axisWord + ' (every 1, 2 or 3 large squares).');
    }
    res.ok = res.validScale && !res.awkward && res.fill >= 0.5 - EPS && res.fitsOnGrid &&
      res.labelEveryOk && res.labelled;
    return res;
  }

  /**
   * Check plotted points against the student's own table values.
   * ok: every filled row with numeric x and y has a point within 0.5 small square in x and in y, and there
   * are no points that do not belong to such a row.
   * @returns {{allPlotted, missingRows: string[], points: Array<{pointId,rowId,errX,errY,ok}>,
   *            extraPoints: string[], expected: number, ok, problems: string[]}}
   */
  function checkPlotting(graph, table) {
    var res = { allPlotted: false, missingRows: [], points: [], extraPoints: [], expected: 0, ok: false, problems: [] };
    if (!graph.x.colId || !graph.y.colId) {
      res.problems.push('Choose which columns of your table to plot on the x-axis and the y-axis.');
      return res;
    }
    if (!validAxis(graph.x) || !validAxis(graph.y)) {
      res.problems.push('Set a scale on both axes before plotting.');
      return res;
    }
    var small = smallOf(graph);
    var rows = plottableRows(graph, table);
    var matched = {};
    var missingNums = [], badNums = [];
    rows.forEach(function (r) {
      res.expected += 1;
      var ex = valueToGrid(graph.x, r.x, small), ey = valueToGrid(graph.y, r.y, small);
      var p = pointForRow(graph, r.rowId);
      if (!p) {
        res.missingRows.push(r.rowId);
        missingNums.push(r.index + 1);
        return;
      }
      matched[p.id] = true;
      var errX = Math.abs(p.gx - ex), errY = Math.abs(p.gy - ey);
      var ok = errX <= 0.5 + 1e-6 && errY <= 0.5 + 1e-6;
      if (!ok) badNums.push(r.index + 1);
      res.points.push({ pointId: p.id, rowId: r.rowId, errX: errX, errY: errY, ok: ok });
    });
    graph.points.forEach(function (p) { if (!matched[p.id]) res.extraPoints.push(p.id); });
    res.allPlotted = res.expected > 0 && res.missingRows.length === 0;
    res.ok = res.allPlotted && res.extraPoints.length === 0 && res.points.every(function (p) { return p.ok; });
    if (res.expected === 0) res.problems.push('There are no rows with numbers in both plotted columns.');
    if (missingNums.length) res.problems.push('Not every row has been plotted (' + rowList(missingNums) + ' missing).');
    if (badNums.length) {
      res.problems.push('The point for ' + rowList(badNums) + (badNums.length === 1 ? ' is' : ' are') +
        ' more than half a small square from the correct position.');
    }
    if (res.extraPoints.length) {
      res.problems.push(res.extraPoints.length === 1
        ? 'One point does not match a row of your table.'
        : res.extraPoints.length + ' points do not match a row of your table.');
    }
    return res;
  }

  /** Least-squares fit y = m x + c. @returns {{m, c}|null} */
  function fit(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    var d = n * sxx - sx * sx;
    if (Math.abs(d) < 1e-12 * Math.max(1, n * sxx)) return null;
    var m = (n * sxy - sx * sy) / d;
    return { m: m, c: (sy - m * sx) / n };
  }

  /**
   * Judge the student's line of best fit.
   * Balanced: ignoring circled anomalies (at most opts.maxAnomalies, default 1), with ≥ 5 points, the line
   * at the smallest and largest plotted x lies within tol of the least-squares line, where
   * tol = max(1.0 small square, 1.5 × RMS of the LSQ residuals without the largest one), AND
   * |#above − #below| ≤ 2. (Leaving out the largest residual stops one uncircled outlier widening tol.)
   * spansData: the drawn line covers at least 80 % of the data x-span.
   * Only a CIRCLED anomaly may be ignored: with ≥ 5 uncircled points, if one point lies far from the line
   * (> 3 small squares and > 3 × the scatter of the others) and the line matches the least-squares fit WITHOUT
   * that point better than the fit with it, the line "ignores an uncircled anomaly" → ignoresUncircled = true,
   * not balanced.
   * @param {object} graph
   * @param {object} [table] reserved (the line is judged against the plotted points)
   * @param {{maxAnomalies?: number}} [opts]
   * @returns {{present, nPoints, usedPoints, anomalies, balanced, above, below, maxDev, lsq: {m,c}|null,
   *            tol, endDevs, spansData, ignoresUncircled, ok, problems: string[]}}
   */
  function checkLine(graph, table, opts) {
    var maxAnomalies = opts && opts.maxAnomalies !== undefined ? opts.maxAnomalies : 1;
    var line = graph.line;
    var used = graph.points.filter(function (p) { return !p.anomaly; });
    var res = {
      present: !!line && lineLength(line) > EPS, nPoints: graph.points.length, usedPoints: used.length,
      anomalies: graph.points.length - used.length, balanced: false, above: 0, below: 0, maxDev: null,
      lsq: null, tol: null, endDevs: null, spansData: false, ok: false, problems: []
    };
    if (!res.present) {
      res.problems.push('No line of best fit has been drawn.');
      return res;
    }
    var vertical = lineY(line, 0) === null;
    if (vertical) res.problems.push('The line is vertical.');

    var gxs = used.map(function (p) { return p.gx; }), gys = used.map(function (p) { return p.gy; });
    var f = fit(gxs, gys);
    var small = smallOf(graph);
    if (f) {
      // RMS of the residuals without the largest one, so that one uncircled outlier cannot widen the tolerance
      var resid = gxs.map(function (x, i) { return gys[i] - (f.m * x + f.c); });
      var big = 0;
      resid.forEach(function (r, i) { if (Math.abs(r) > Math.abs(resid[big])) big = i; });
      var rest = resid.length > 1 ? resid.filter(function (r, i) { return i !== big; }) : resid;
      var rms = rest.length ? Math.sqrt(rest.reduce(function (s, r) { return s + r * r; }, 0) / rest.length) : 0;
      res.tol = Math.max(1.0, 1.5 * rms);
      if (validAxis(graph.x) && validAxis(graph.y)) {
        var mv = f.m * graph.y.perLarge / graph.x.perLarge;
        res.lsq = { m: mv, c: graph.y.origin - mv * graph.x.origin + f.c * graph.y.perLarge / small };
      }
    }
    var endsOk = false;
    if (!vertical && used.length) {
      var maxDev = 0;
      used.forEach(function (p) {
        var dev = p.gy - lineY(line, p.gx);
        if (dev > 0.05) res.above += 1;
        else if (dev < -0.05) res.below += 1;
        maxDev = Math.max(maxDev, Math.abs(dev));
      });
      res.maxDev = maxDev;
      var xmin = Math.min.apply(null, gxs), xmax = Math.max.apply(null, gxs);
      var lo = Math.min(line.a.gx, line.b.gx), hi = Math.max(line.a.gx, line.b.gx);
      var span = xmax - xmin;
      res.spansData = span > EPS && Math.max(0, Math.min(hi, xmax) - Math.max(lo, xmin)) >= 0.8 * span - EPS;
      if (f) {
        var d0 = lineY(line, xmin) - (f.m * xmin + f.c);
        var d1 = lineY(line, xmax) - (f.m * xmax + f.c);
        res.endDevs = [d0, d1];
        endsOk = Math.abs(d0) <= res.tol + EPS && Math.abs(d1) <= res.tol + EPS;
        if (!endsOk) {
          if (d0 > res.tol && d1 > res.tol) res.problems.push('The line lies above most of the points.');
          else if (d0 < -res.tol && d1 < -res.tol) res.problems.push('The line lies below most of the points.');
          else {
            res.problems.push('The line does not follow the trend of the points: towards one end most points ' +
              'lie above it and towards the other end most lie below it.');
          }
        }
      }
    }
    // Only a CIRCLED anomaly may be ignored. A single far-off point inflates the RMS-based tolerance, so check
    // separately whether the line follows the fit without that point rather than the fit with it.
    res.ignoresUncircled = false;
    if (!vertical && f && used.length >= 5) {
      var devs = used.map(function (p) { return p.gy - lineY(line, p.gx); });
      var k = 0;
      devs.forEach(function (d, j) { if (Math.abs(d) > Math.abs(devs[k])) k = j; });
      var others = devs.filter(function (d, j) { return j !== k; });
      var rmsOthers = Math.sqrt(others.reduce(function (s, d) { return s + d * d; }, 0) / others.length);
      if (Math.abs(devs[k]) > Math.max(3, 3 * Math.max(1, 1.5 * rmsOthers))) {
        var fo = fit(gxs.filter(function (v, j) { return j !== k; }), gys.filter(function (v, j) { return j !== k; }));
        var xa = Math.min.apply(null, gxs), xb = Math.max.apply(null, gxs);
        var dist = function (ff) {
          return Math.abs(lineY(line, xa) - (ff.m * xa + ff.c)) + Math.abs(lineY(line, xb) - (ff.m * xb + ff.c));
        };
        if (fo && dist(fo) < dist(f)) {
          res.ignoresUncircled = true;
          endsOk = false;
          res.problems.push('The line ignores a point that is far from it but not circled. Circle a point if you ' +
            'decide it is anomalous; otherwise the line must be balanced about every point.');
        }
      }
    }
    if (used.length < 5) {
      res.problems.push('At least five plotted points are needed to judge a line of best fit (' +
        used.length + ' used).');
    }
    if (Math.abs(res.above - res.below) > 2) {
      res.problems.push('The points are not balanced about the line: ' + res.above + ' above and ' +
        res.below + ' below.');
    }
    if (!vertical && !res.spansData) res.problems.push('The line does not extend across the range of the plotted points.');
    if (res.anomalies > maxAnomalies) {
      res.problems.push('More than ' + (maxAnomalies === 1 ? 'one point is' : maxAnomalies + ' points are') +
        ' circled as anomalous; only ' + (maxAnomalies === 1 ? 'one anomalous point' : maxAnomalies + ' points') +
        ' may be ignored.');
    }
    res.balanced = !vertical && used.length >= 5 && endsOk && Math.abs(res.above - res.below) <= 2;
    res.ok = res.balanced && res.spansData && res.anomalies <= maxAnomalies;
    return res;
  }

  /**
   * Check the gradient triangle and the read-offs the student typed.
   * @returns {{present, hypFraction, bigEnough, onLine, readOffsOk, gradient: number|null,
   *            lineGradient: number|null, ok, problems: string[]}}
   *   gradient is Δy/Δx from the TYPED read-offs (x1, y1, x2, y2).
   */
  function checkTriangle(graph) {
    var tri = graph.triangle, line = graph.line;
    var small = smallOf(graph);
    var res = {
      present: !!(tri && tri.p1 && tri.p2), hypFraction: 0, bigEnough: false, onLine: false,
      readOffsOk: false, gradient: null, lineGradient: lineGradient(graph), ok: false, problems: []
    };
    if (!res.present) res.problems.push('No gradient triangle has been drawn.');
    if (!line) res.problems.push('Draw the line of best fit before the gradient triangle.');
    if (res.present && line) {
      var L = lineLength(line);
      var hyp = Math.sqrt(Math.pow(tri.p2.gx - tri.p1.gx, 2) + Math.pow(tri.p2.gy - tri.p1.gy, 2));
      res.hypFraction = L > EPS ? clean(hyp / L) : 0;
      res.bigEnough = res.hypFraction >= 0.5 - EPS;
      res.onLine = perpDistance(tri.p1, line) <= 0.5 + 1e-6 && perpDistance(tri.p2, line) <= 0.5 + 1e-6;
      if (!res.bigEnough) {
        res.problems.push('The triangle is too small: its hypotenuse should be at least half the length of ' +
          'the line (yours is about ' + Math.round(res.hypFraction * 100) + ' %).');
      }
      if (!res.onLine) res.problems.push('Both vertices of the triangle used for the gradient should lie on the line.');
    }
    var ro = graph.readOffs || {};
    var x1 = parseNumber(ro.x1), y1 = parseNumber(ro.y1), x2 = parseNumber(ro.x2), y2 = parseNumber(ro.y2);
    if ([x1, y1, x2, y2].every(isFinite)) {
      if (Math.abs(x2 - x1) > 0) res.gradient = (y2 - y1) / (x2 - x1);
      else res.problems.push('x₁ and x₂ are equal, so Δy/Δx cannot be calculated.');
      if (res.present && validAxis(graph.x) && validAxis(graph.y)) {
        var near = function (p, x, y) {
          return Math.abs(valueToGrid(graph.x, x, small) - p.gx) <= 0.5 + 1e-6 &&
            Math.abs(valueToGrid(graph.y, y, small) - p.gy) <= 0.5 + 1e-6;
        };
        res.readOffsOk = (near(tri.p1, x1, y1) && near(tri.p2, x2, y2)) ||
          (near(tri.p1, x2, y2) && near(tri.p2, x1, y1));
        if (!res.readOffsOk) {
          res.problems.push('The coordinates you read off do not match the vertices of the triangle to within ' +
            'half a small square.');
        }
      }
    } else {
      res.problems.push('Type the coordinates you read off for both vertices (x₁, y₁, x₂, y₂).');
    }
    res.ok = res.present && res.bigEnough && res.onLine && res.readOffsOk && res.gradient !== null;
    return res;
  }

  /**
   * Check a y-intercept value typed by the student.
   * Direct reading (x-axis starts at 0 and the crossing is on the grid): within 0.5 small square (y units)
   * of the drawn line at x = 0. Otherwise (false origin): also accepted when the value equals
   * y − m x for one of the student's read-off points that lies on the line, with m = opts.gradient (the
   * student's gradient) or Δy/Δx from the typed read-offs.
   * @param {object} graph
   * @param {string|number} typedValue
   * @param {{gradient?: string|number}} [opts]
   * @returns {{falseOrigin, readable, expected: number|null, typed, tolerance, method, substitution, ok,
   *            problems: string[]}}
   */
  function checkIntercept(graph, typedValue, opts) {
    opts = opts || {};
    var small = smallOf(graph);
    var res = {
      falseOrigin: graph.x.origin !== 0, readable: false, expected: null, typed: parseNumber(typedValue),
      tolerance: validAxis(graph.y) ? 0.5 * graph.y.perLarge / small : NaN,
      method: null, substitution: null, ok: false, problems: []
    };
    res.expected = lineValueAt(graph, 0);
    if (res.expected === null) {
      res.problems.push(graph.line ? 'The line is vertical, so it has no y-intercept.'
        : 'No line has been drawn, so the y-intercept cannot be found.');
    } else {
      var gy0 = valueToGrid(graph.y, res.expected, small);
      res.readable = !res.falseOrigin && gy0 >= -1e-6 && gy0 <= graph.grid.rows * small + 1e-6;
    }
    if (!isFinite(res.typed)) {
      res.problems.push('No value has been given for the y-intercept.');
      return res;
    }
    if (res.expected !== null && Math.abs(res.typed - res.expected) <= res.tolerance * (1 + 1e-9) + 1e-12) {
      res.ok = true;
      res.method = res.readable ? 'direct' : 'substitution';
    } else if (res.expected !== null && !res.readable) {
      var m = opts.gradient !== undefined ? parseNumber(opts.gradient) : checkTriangle(graph).gradient;
      var ro = graph.readOffs || {};
      var cands = [[ro.x1, ro.y1], [ro.x2, ro.y2]];
      if (opts.point) cands.unshift([opts.point.x, opts.point.y]);
      if (m !== null && isFinite(m)) {
        for (var i = 0; i < cands.length && !res.ok; i++) {
          var x = parseNumber(cands[i][0]), y = parseNumber(cands[i][1]);
          if (!isFinite(x) || !isFinite(y)) continue;
          var gx = valueToGrid(graph.x, x, small), gyL = lineY(graph.line, gx);
          var onLine = gyL !== null && Math.abs(valueToGrid(graph.y, y, small) - gyL) <= 0.5 + 1e-6;
          var c = y - m * x;
          var tol = res.tolerance + 0.005 * Math.abs(m * x);   // allow m rounded to 3 s.f.
          if (onLine && Math.abs(res.typed - c) <= tol) {
            res.ok = true;
            res.method = 'substitution';
            res.substitution = { x: x, y: y, m: m, c: c };
          }
        }
      }
    }
    if (!res.ok) {
      if (res.readable) {
        res.problems.push('The y-intercept should be read where the line crosses x = 0; your value differs from ' +
          'your line by more than half a small square.');
      } else if (res.expected !== null) {
        res.problems.push(res.falseOrigin
          ? 'The x-axis does not start at zero, so the y-intercept cannot be read from the graph. Substitute a ' +
            'point on your line and your gradient into y = mx + c.'
          : 'Your line crosses x = 0 off the grid, so calculate the y-intercept by substituting a point on the ' +
            'line and your gradient into y = mx + c.');
      }
    }
    return res;
  }

  /* ------------------------------------------------------------------ serialisation */

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function copyPt(p) {
    return p && isFinite(Number(p.gx)) && isFinite(Number(p.gy)) ? { gx: Number(p.gx), gy: Number(p.gy) } : null;
  }

  function copySeg(s, k1, k2) {
    if (!s) return null;
    var a = copyPt(s[k1]), b = copyPt(s[k2]);
    if (!a || !b) return null;
    var o = {};
    o[k1] = a;
    o[k2] = b;
    return o;
  }

  function copyAxis(a) {
    a = a || {};
    var d = defaultAxis();
    return {
      colId: a.colId === undefined || a.colId === '' ? null : a.colId,
      label: typeof a.label === 'string' ? a.label : d.label,
      origin: num(a.origin, d.origin),
      perLarge: num(a.perLarge, d.perLarge),
      labelEvery: num(a.labelEvery, d.labelEvery)
    };
  }

  /**
   * Rebuild a Graph from JSON, filling defaults for anything missing.
   * @returns {object} Graph
   */
  function fromJSON(o) {
    o = o || {};
    var g = create(o.grid || {});
    g.x = copyAxis(o.x);
    g.y = copyAxis(o.y);
    var maxId = 0;
    (Array.isArray(o.points) ? o.points : []).forEach(function (p) {
      if (!p || !isFinite(Number(p.gx)) || !isFinite(Number(p.gy))) return;
      var id = p.id ? String(p.id) : null;
      var n = id ? parseInt((/(\d+)$/.exec(id) || [0, 0])[1], 10) : 0;
      maxId = Math.max(maxId, n);
      g.points.push({ id: id, rowId: p.rowId === undefined ? null : p.rowId, gx: Number(p.gx),
        gy: Number(p.gy), anomaly: !!p.anomaly });
    });
    g.line = copySeg(o.line, 'a', 'b');
    g.triangle = copySeg(o.triangle, 'p1', 'p2');
    g.worstLine = copySeg(o.worstLine, 'a', 'b');
    var ro = o.readOffs || {};
    g.readOffs = {
      x1: ro.x1 == null ? '' : String(ro.x1), y1: ro.y1 == null ? '' : String(ro.y1),
      x2: ro.x2 == null ? '' : String(ro.x2), y2: ro.y2 == null ? '' : String(ro.y2)
    };
    var ic = o.intercept || {};
    g.intercept = {
      method: ic.method === 'direct' || ic.method === 'substitution' ? ic.method : null,
      value: ic.value == null ? '' : String(ic.value)
    };
    g.nextId = Math.max(num(o.nextId, 1), maxId + 1);
    g.points.forEach(function (p) {
      if (!p.id) { p.id = 'p' + g.nextId; g.nextId += 1; }
    });
    return g;
  }

  /** Plain JSON-safe deep copy. */
  function toJSON(g) {
    return JSON.parse(JSON.stringify(fromJSON(g)));
  }

  /** Deep copy. */
  function clone(g) {
    return fromJSON(toJSON(g));
  }

  /* ------------------------------------------------------------------ undo / redo */

  /**
   * Snapshot-based undo/redo for a graph (mutated in place, so references held elsewhere stay valid).
   * Usage: h.change(fn) for a one-shot edit, or h.begin() … mutate … h.end() around a drag;
   * h.cancel() restores the state saved by begin().
   * @param {object} g Graph
   * @param {{limit?: number}} [opts] default 200 steps
   * @returns {{graph, begin, end, cancel, change, undo, redo, canUndo, canRedo, reset}}
   */
  function history(g, opts) {
    var limit = (opts && opts.limit) || 200;
    var undoStack = [], redoStack = [], pending = null;
    var api = { graph: g };
    function snap() { return JSON.stringify(toJSON(api.graph)); }
    function restore(s) {
      var o = fromJSON(JSON.parse(s));
      Object.keys(api.graph).forEach(function (k) { delete api.graph[k]; });
      Object.keys(o).forEach(function (k) { api.graph[k] = o[k]; });
    }
    /** Start an edit (no-op if one is already open). */
    api.begin = function () { if (pending === null) pending = snap(); };
    /** Finish an edit; records an undo step only if the graph changed. @returns {boolean} */
    api.end = function () {
      if (pending === null) return false;
      var before = pending;
      pending = null;
      if (before === snap()) return false;
      undoStack.push(before);
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
      return true;
    };
    /** Abandon the open edit and restore the graph as it was at begin(). */
    api.cancel = function () {
      if (pending === null) return;
      restore(pending);
      pending = null;
    };
    /** Run fn(graph) as one undoable step. @returns {boolean} true if the graph changed */
    api.change = function (fn) {
      api.begin();
      try { fn(api.graph); } catch (e) { api.end(); throw e; }
      return api.end();
    };
    api.undo = function () {
      api.end();
      if (!undoStack.length) return false;
      redoStack.push(snap());
      restore(undoStack.pop());
      return true;
    };
    api.redo = function () {
      api.end();
      if (!redoStack.length) return false;
      undoStack.push(snap());
      restore(redoStack.pop());
      return true;
    };
    api.canUndo = function () { return undoStack.length > 0; };
    api.canRedo = function () { return redoStack.length > 0; };
    /** Forget history (optionally switching to another graph). */
    api.reset = function (newGraph) {
      if (newGraph) api.graph = newGraph;
      undoStack.length = 0;
      redoStack.length = 0;
      pending = null;
    };
    return api;
  }

  /* ------------------------------------------------------------------ model-answer helpers */

  /**
   * Choose a sensible Cambridge scale (1, 2, 4 or 5 × 10ⁿ per large square) that fits [min, max] on nLarge
   * large squares with the largest possible spread. For MODEL ANSWERS and drills only.
   * @param {number} min
   * @param {number} max
   * @param {number} nLarge
   * @param {{includeZero?: boolean}} [opts]
   * @returns {{origin:number, perLarge:number, labelEvery:number}}
   */
  function niceScale(min, max, nLarge, opts) {
    var lo = min, hi = max;
    if (opts && opts.includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    var span = hi - lo;
    if (!(span > 0)) span = Math.abs(hi) || 1;
    var e0 = Math.floor(Math.log10(span / nLarge)) - 1;
    for (var e = e0; e <= e0 + 3; e++) {
      for (var i = 0; i < ALLOWED_MANTISSAS.length; i++) {
        var per = clean(ALLOWED_MANTISSAS[i] * Math.pow(10, e));
        var origin = clean(Math.floor(lo / per + 1e-9) * per);
        if (origin + per * nLarge >= hi - Math.abs(per) * 1e-9) return { origin: origin, perLarge: per, labelEvery: 1 };
      }
    }
    return { origin: clean(lo), perLarge: clean(Math.pow(10, Math.ceil(Math.log10(span)))), labelEvery: 1 };
  }

  /** Horizontal extent of a segment (small squares). */
  function xSpan(line) {
    return Math.abs(line.b.gx - line.a.gx);
  }

  /** Clip the infinite line y = m x + c (grid units) to the x-range [x0, x1] and to the grid. */
  function clipToGrid(m, c, x0, x1, W, H) {
    var a = Math.max(0, x0), b = Math.min(W, x1);
    if (Math.abs(m) > 1e-12) {
      var xa = (0 - c) / m, xb = (H - c) / m;
      a = Math.max(a, Math.min(xa, xb));
      b = Math.min(b, Math.max(xa, xb));
    }
    if (b <= a) return null;
    return { a: { gx: a, gy: m * a + c }, b: { gx: b, gy: m * b + c } };
  }

  /**
   * Build a complete, well-drawn graph from a table, as an examiner would: good scales, every point plotted
   * exactly, least-squares line, large gradient triangle with read-offs, intercept read directly when the
   * x-axis can start at 0 (otherwise by substitution). The line covers the data (± half a small square); when the
   * intercept is read directly it is drawn on down to x = 0 (clipped to the grid) so the reading can be seen.
   * FOR MODEL ANSWERS ONLY — the student UI never uses it.
   * @param {object} table
   * @param {string} xColId
   * @param {string} yColId
   * @param {{grid?: object, xLabel?: string, yLabel?: string, includeZero?: boolean|'auto'}} [opts]
   * @returns {object} Graph
   */
  function modelGraph(table, xColId, yColId, opts) {
    opts = opts || {};
    var g = create(opts.grid);
    var small = g.grid.small, W = g.grid.cols * small, H = g.grid.rows * small;
    function heading(id) {
      for (var i = 0; i < table.columns.length; i++) if (table.columns[i].id === id) return table.columns[i].heading;
      return '';
    }
    g.x.colId = xColId;
    g.y.colId = yColId;
    g.x.label = opts.xLabel !== undefined ? opts.xLabel : heading(xColId);
    g.y.label = opts.yLabel !== undefined ? opts.yLabel : heading(yColId);
    var rows = plottableRows(g, table);
    if (rows.length < 2) return g;
    var xs = rows.map(function (r) { return r.x; }), ys = rows.map(function (r) { return r.y; });
    var f = fit(xs, ys);
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);

    function fills(sx, sy) {
      return (xmax - xmin) / (sx.perLarge * g.grid.cols) >= 0.5 && (ymax - ymin) / (sy.perLarge * g.grid.rows) >= 0.5;
    }
    var sx, sy, useZero = false;
    if (opts.includeZero !== false && f) {
      sx = niceScale(Math.min(xmin, 0), Math.max(xmax, 0), g.grid.cols);
      sy = niceScale(Math.min(ymin, f.c), Math.max(ymax, f.c), g.grid.rows);
      useZero = opts.includeZero === true || (sx.origin === 0 && fills(sx, sy));
    }
    if (!useZero) {
      sx = niceScale(xmin, xmax, g.grid.cols);
      sy = niceScale(ymin, ymax, g.grid.rows);
    }
    g.x.origin = sx.origin; g.x.perLarge = sx.perLarge; g.x.labelEvery = g.grid.cols > 10 ? 2 : 1;
    g.y.origin = sy.origin; g.y.perLarge = sy.perLarge; g.y.labelEvery = 1;

    rows.forEach(function (r) {
      var p = toGrid(g, r.x, r.y);
      addPoint(g, r.rowId, p.gx, p.gy);
    });
    if (!f) return g;
    // least-squares line in grid units
    var gfit = fit(g.points.map(function (p) { return p.gx; }), g.points.map(function (p) { return p.gy; }));
    var gxmin = valueToGrid(g.x, xmin, small), gxmax = valueToGrid(g.x, xmax, small);
    g.line = clipToGrid(gfit.m, gfit.c, gxmin - small / 2, gxmax + small / 2, W, H);
    if (!g.line) return g;
    // the y-intercept will be read directly at x = 0: draw the line down to the y-axis so the reading can be seen
    var gyAt0 = lineY(g.line, valueToGrid(g.x, 0, small));
    if (g.x.origin === 0 && gyAt0 !== null && gyAt0 >= 0 && gyAt0 <= H) {
      g.line = clipToGrid(gfit.m, gfit.c, 0, gxmax + small / 2, W, H) || g.line;
    }
    // triangle vertices on large-square lines inside the data range and off the grid edges (so the legs do not
    // lie along the axes); small-square lines if that makes the triangle too small
    var lo = Math.max(gxmin, 1), hi = Math.min(gxmax, W - 1);
    var ax = Math.ceil(lo / small - 1e-9) * small, bx = Math.floor(hi / small + 1e-9) * small;
    if (bx - ax < 0.55 * xSpan(g.line)) { ax = Math.ceil(lo - 1e-9); bx = Math.floor(hi + 1e-9); }
    g.triangle = { p1: { gx: ax, gy: lineY(g.line, ax) }, p2: { gx: bx, gy: lineY(g.line, bx) } };
    var halfY = g.y.perLarge / small / 2;
    var dec = Math.max(0, Math.ceil(-Math.log10(halfY) - 1e-9));
    var stepX = g.x.perLarge / small;
    var v1 = toValue(g, ax, g.triangle.p1.gy), v2 = toValue(g, bx, g.triangle.p2.gy);
    g.readOffs = {
      x1: formatTick(clean(v1.x), stepX).replace('−', '-'), y1: v1.y.toFixed(dec),
      x2: formatTick(clean(v2.x), stepX).replace('−', '-'), y2: v2.y.toFixed(dec)
    };
    var m = checkTriangle(g).gradient;
    var gy0 = lineY(g.line, valueToGrid(g.x, 0, small));
    if (g.x.origin === 0 && gy0 !== null && gy0 >= 0 && gy0 <= H) {
      g.intercept = { method: 'direct', value: gridToValue(g.y, gy0, small).toFixed(dec) };
    } else if (m !== null) {
      var c = parseNumber(g.readOffs.y1) - m * parseNumber(g.readOffs.x1);
      g.intercept = { method: 'substitution', value: clean(Number(c.toPrecision(3))).toString() };
    }
    return g;
  }

  VL.graph = {
    create: create,
    valueToGrid: valueToGrid,
    gridToValue: gridToValue,
    toGrid: toGrid,
    toValue: toValue,
    lineY: lineY,
    lineLength: lineLength,
    lineValueAt: lineValueAt,
    lineGradient: lineGradient,
    perpDistance: perpDistance,
    addPoint: addPoint,
    removePoint: removePoint,
    findPoint: findPoint,
    pointForRow: pointForRow,
    plottableRows: plottableRows,
    scaleMantissa: scaleMantissa,
    isAwkward: isAwkward,
    checkScale: checkScale,
    checkPlotting: checkPlotting,
    checkLine: checkLine,
    checkTriangle: checkTriangle,
    checkIntercept: checkIntercept,
    clone: clone,
    toJSON: toJSON,
    fromJSON: fromJSON,
    history: history,
    niceScale: niceScale,
    modelGraph: modelGraph,
    formatTick: formatTick,
    formatNumber: formatNumber,
    decimalsFor: decimalsFor,
    parseNumber: parseNumber
  };
})(globalThis.VLab = globalThis.VLab || {});
