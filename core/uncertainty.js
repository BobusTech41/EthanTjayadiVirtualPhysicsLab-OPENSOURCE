/**
 * Uncertainty helpers: absolute, fractional and percentage uncertainty, combining uncertainties,
 * and (Paper 5 extension) worst-acceptable gradient lines.
 */
(function (VL) {
  'use strict';

  function finite(a) { return (a || []).filter(function (x) { return typeof x === 'number' && isFinite(x); }); }

  /** Half the range of repeated readings. */
  function halfRange(values) {
    var v = finite(values);
    if (!v.length) return NaN;
    return (Math.max.apply(null, v) - Math.min.apply(null, v)) / 2;
  }
  function fractional(abs, value) { return Math.abs(abs / value); }
  function percent(abs, value) { return 100 * Math.abs(abs / value); }
  function fromPercent(pct, value) { return Math.abs(value) * pct / 100; }

  /** Mean of repeated readings with uncertainty = half the range. */
  function meanWithUncertainty(values) {
    var v = finite(values);
    var mean = v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : NaN;
    var abs = halfRange(v);
    return { mean: mean, abs: abs, percent: percent(abs, mean) };
  }

  /**
   * Products, quotients and powers: fractional uncertainties add, each multiplied by |power|.
   * @param {{value:number, abs:number, power?:number}[]} terms
   */
  function product(terms) {
    var f = (terms || []).reduce(function (s, t) {
      var p = t.power === undefined ? 1 : t.power;
      return s + Math.abs(p) * Math.abs(t.abs / t.value);
    }, 0);
    return { fractional: f, percent: 100 * f };
  }

  /** Sums and differences: absolute uncertainties add. */
  function sum(terms) {
    return (terms || []).reduce(function (s, t) { return s + Math.abs(t.abs); }, 0);
  }

  function lineThrough(p, q) {
    var m = (q.y - p.y) / (q.x - p.x);
    return { m: m, c: p.y - m * p.x };
  }

  /**
   * Worst acceptable lines through the extreme error-bar corners of the first and last points.
   * @param {{x:number, y:number, ex?:number, ey?:number}[]} points
   * @returns {{best:{m,c}, steep:{m,c}, shallow:{m,c}, dm:number}}
   */
  function worstLine(points) {
    var pts = (points || []).filter(function (p) { return isFinite(p.x) && isFinite(p.y); })
      .slice().sort(function (a, b) { return a.x - b.x; });
    if (pts.length < 2) return null;
    var best = VL.stats ? VL.stats.linearFit(pts.map(function (p) { return p.x; }), pts.map(function (p) { return p.y; })) : null;
    if (!best) {
      best = lineThrough(pts[0], pts[pts.length - 1]);
    }
    var a = pts[0], b = pts[pts.length - 1];
    var ex1 = a.ex || 0, ey1 = a.ey || 0, ex2 = b.ex || 0, ey2 = b.ey || 0;
    var s = best.m >= 0 ? 1 : -1;
    // steepest: start low/right, end high/left (for a positive gradient); mirror for negative
    var steep = lineThrough({ x: a.x + ex1, y: a.y - s * ey1 }, { x: b.x - ex2, y: b.y + s * ey2 });
    var shallow = lineThrough({ x: a.x - ex1, y: a.y + s * ey1 }, { x: b.x + ex2, y: b.y - s * ey2 });
    var dm = Math.max(Math.abs(steep.m - best.m), Math.abs(best.m - shallow.m));
    return { best: { m: best.m, c: best.c }, steep: steep, shallow: shallow, dm: dm };
  }

  VL.uncertainty = {
    halfRange: halfRange,
    fractional: fractional,
    percent: percent,
    fromPercent: fromPercent,
    meanWithUncertainty: meanWithUncertainty,
    product: product,
    sum: sum,
    worstLine: worstLine
  };
})(globalThis.VLab = globalThis.VLab || {});
