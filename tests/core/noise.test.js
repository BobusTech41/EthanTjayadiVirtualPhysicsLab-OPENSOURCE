test('noise: level 0 gives exact values', function () {
  var r = VLab.rng.create('n');
  VLab.noise.level = 0;
  assert.equal(VLab.noise.gauss(r, 5), 0);
  assert.ok(!VLab.noise.maybeAnomaly(r, 1));
  for (var i = 0; i < 20; i++) assert.equal(VLab.noise.zeroError(r, { resolution: 0.01, chance: 1 }), 0);
});
test('noise: zero errors are multiples of the resolution and reproducible', function () {
  VLab.noise.level = 1;
  var a = VLab.rng.create('z'), b = VLab.rng.create('z');
  for (var i = 0; i < 30; i++) {
    var z = VLab.noise.zeroError(a, { resolution: 0.01, chance: 0.5, maxDivisions: 3 });
    assert.equal(z, VLab.noise.zeroError(b, { resolution: 0.01, chance: 0.5, maxDivisions: 3 }));
    assert.ok(Math.abs(z) <= 0.03 + 1e-12);
    assert.close(Math.round(z / 0.01) * 0.01, z, 1e-12);
  }
});
test('noise: quantize and parallax', function () {
  assert.equal(VLab.noise.quantize(0.30000000000000004, 0.1), 0.3);
  assert.equal(VLab.noise.quantize(23.456, 0.01), 23.46);
  assert.close(VLab.noise.parallaxShift(1.5, 45), 1.5, 1e-12);
  assert.equal(VLab.noise.parallaxShift(1.5, 0), 0);
});
