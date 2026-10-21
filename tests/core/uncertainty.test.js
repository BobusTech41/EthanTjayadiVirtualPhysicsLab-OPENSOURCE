test('uncertainty: repeated readings', function () {
  var U = VLab.uncertainty;
  var m = U.meanWithUncertainty([40.12, 40.36]);
  assert.close(m.mean, 40.24, 1e-9); assert.close(m.abs, 0.12, 1e-9);
  assert.close(m.percent, 0.298, 0.001);
  assert.close(U.percent(0.01, 2.0), 0.5, 1e-12);
  assert.close(U.fromPercent(2, 50), 1, 1e-12);
});
test('uncertainty: combining', function () {
  var U = VLab.uncertainty;
  // x = a b² / c with 1 %, 2 %, 3 % → 1 + 4 + 3 = 8 %
  var p = U.product([{ value: 100, abs: 1 }, { value: 50, abs: 1, power: 2 }, { value: 10, abs: 0.3, power: -1 }]);
  assert.close(p.percent, 8, 1e-9);
  assert.close(U.sum([{ abs: 0.1 }, { abs: 0.2 }]), 0.3, 1e-12);
});
test('uncertainty: worst acceptable lines (Paper 5 extension)', function () {
  var pts = [0, 1, 2, 3, 4].map(function (x) { return { x: x, y: 2 * x + 1, ey: 0.5 }; });
  var w = VLab.uncertainty.worstLine(pts);
  assert.close(w.best.m, 2, 1e-9);
  assert.close(w.steep.m, 2.25, 1e-9);
  assert.close(w.shallow.m, 1.75, 1e-9);
  assert.close(w.dm, 0.25, 1e-9);
  var neg = [0, 1, 2, 3].map(function (x) { return { x: x, y: -x + 5, ey: 0.3 }; });
  var wn = VLab.uncertainty.worstLine(neg);
  assert.ok(wn.steep.m < wn.best.m && wn.shallow.m > wn.best.m, 'negative gradients mirrored');
});
