test('rng: same seed gives the same sequence', function () {
  var a = VLab.rng.create('PEN-7K2Q-91C3'), b = VLab.rng.create('PEN-7K2Q-91C3');
  for (var i = 0; i < 20; i++) assert.equal(a.next(), b.next());
});
test('rng: different seeds differ; forks are independent and reproducible', function () {
  var a = VLab.rng.create('A'), b = VLab.rng.create('B');
  assert.ok(a.next() !== b.next());
  var f1 = VLab.rng.create('S').fork('params'), f2 = VLab.rng.create('S').fork('params');
  var g = VLab.rng.create('S').fork('noise');
  var x = f1.next();
  assert.equal(x, f2.next());
  assert.ok(x !== g.next());
});
test('rng: ranges and distributions', function () {
  var r = VLab.rng.create('dist');
  var n = 20000, s = 0, s2 = 0, lo = Infinity, hi = -Infinity, ints = {};
  for (var i = 0; i < n; i++) {
    var z = r.normal(); s += z; s2 += z * z;
    var u = r.uniform(2, 5); lo = Math.min(lo, u); hi = Math.max(hi, u);
    ints[r.int(1, 3)] = true;
  }
  assert.close(s / n, 0, 0.05, 'normal mean');
  assert.close(Math.sqrt(s2 / n), 1, 0.05, 'normal sd');
  assert.ok(lo >= 2 && hi < 5, 'uniform range');
  assert.deepEqual(Object.keys(ints).sort(), ['1', '2', '3']);
  var arr = [1, 2, 3, 4, 5], sh = r.shuffle(arr);
  assert.deepEqual(arr, [1, 2, 3, 4, 5], 'shuffle returns a copy');
  assert.deepEqual(sh.slice().sort(), [1, 2, 3, 4, 5]);
});
test('rng: seeds are readable and validated', function () {
  var s = VLab.rng.newSeed('pen');
  assert.match(s, /^PEN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(VLab.rng.isValidSeed(s));
  assert.ok(VLab.rng.isValidSeed(' pen-7k2q-91c3 '));
  assert.ok(VLab.rng.isValidSeed('PEN-7K2Q-9IC3'), 'I is read as 1');
  assert.ok(!VLab.rng.isValidSeed('PEN-7K2Q'));
  assert.ok(!VLab.rng.isValidSeed('hello'));
});
