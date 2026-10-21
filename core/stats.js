/**
 * Small statistics helpers (means, ranges, least-squares straight line).
 */
(function (VL) {
  'use strict';

  function nums(a) { return (a || []).filter(function (x) { return typeof x === 'number' && isFinite(x); }); }
  function sum(a) { return nums(a).reduce(function (s, x) { return s + x; }, 0); }
  function mean(a) { var n = nums(a); return n.length ? sum(n) / n.length : NaN; }
  function min(a) { var n = nums(a); return n.length ? Math.min.apply(null, n) : NaN; }
  function max(a) { var n = nums(a); return n.length ? Math.max.apply(null, n) : NaN; }
  function range(a) { var n = nums(a); return n.length ? max(n) - min(n) : NaN; }
  function halfRange(a) { return range(a) / 2; }
  function median(a) {
    var n = nums(a).slice().sort(function (x, y) { return x - y; });
    if (!n.length) return NaN;
    var mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
  }
  /** Sample standard deviation (n − 1). */
  function sd(a) {
    var n = nums(a);
    if (n.length < 2) return NaN;
    var m = mean(n);
    return Math.sqrt(n.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (n.length - 1));
  }

  /**
   * Least-squares straight line y = m x + c.
   * @returns {{m:number, c:number, r2:number, n:number}}
   */
  function linearFit(xs, ys) {
    var px = [], py = [];
    for (var i = 0; i < Math.min(xs.length, ys.length); i++) {
      if (isFinite(xs[i]) && isFinite(ys[i])) { px.push(xs[i]); py.push(ys[i]); }
    }
    var n = px.length;
    if (n < 2) return { m: NaN, c: NaN, r2: NaN, n: n };
    var mx = mean(px), my = mean(py), sxx = 0, sxy = 0, syy = 0;
    for (var j = 0; j < n; j++) {
      sxx += (px[j] - mx) * (px[j] - mx);
      sxy += (px[j] - mx) * (py[j] - my);
      syy += (py[j] - my) * (py[j] - my);
    }
    if (sxx === 0) return { m: NaN, c: NaN, r2: NaN, n: n };
    var m = sxy / sxx;
    var c = my - m * mx;
    var r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
    return { m: m, c: c, r2: r2, n: n };
  }

  /** Residuals y − (m x + c). */
  function residuals(xs, ys, m, c) {
    return xs.map(function (x, i) { return ys[i] - (m * x + c); });
  }

  VL.stats = {
    sum: sum, mean: mean, min: min, max: max, range: range, halfRange: halfRange,
    median: median, sd: sd, linearFit: linearFit, residuals: residuals
  };
})(globalThis.VLab = globalThis.VLab || {});
