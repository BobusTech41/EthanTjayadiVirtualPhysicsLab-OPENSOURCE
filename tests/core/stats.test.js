test('stats: basics', function () {
  var S = VLab.stats;
  assert.equal(S.mean([1, 2, 3]), 2);
  assert.equal(S.range([4, 1, 9]), 8);
  assert.close(S.halfRange([2.1, 2.5]), 0.2, 1e-12);
  assert.equal(S.median([3, 1, 2, 10]), 2.5);
  assert.close(S.sd([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.001);
  assert.ok(isNaN(S.mean([])));
});
test('stats: least squares', function () {
  var f = VLab.stats.linearFit([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.close(f.m, 2, 1e-12); assert.close(f.c, 1, 1e-12); assert.close(f.r2, 1, 1e-12);
  var r = VLab.stats.residuals([0, 1], [1.5, 2.5], 1, 1);
  assert.close(r[0], 0.5, 1e-12); assert.close(r[1], 0.5, 1e-12);
  assert.ok(isNaN(VLab.stats.linearFit([1], [1]).m));
});
