test('sigfig: significant figures of typed strings', function () {
  var sf = VLab.sigfig.sf;
  assert.equal(sf('0.50'), 2);
  assert.equal(sf('0.5'), 1);
  assert.equal(sf('50.0'), 3);
  assert.equal(sf('0.050'), 2);
  assert.equal(sf('12.34'), 4);
  assert.equal(sf('100.'), 3);
  assert.equal(sf('0'), 1);
  assert.equal(sf('0.00'), 1);
  assert.equal(sf('1.20e3'), 3);
  assert.equal(sf('1.2×10^-3'), 2);
  assert.equal(sf('1.2 × 10⁻³'), 2);
  var p = VLab.sigfig.parse('1200');
  assert.equal(p.sfMin, 2); assert.equal(p.sfMax, 4); assert.equal(p.sf, 4);
});
test('sigfig: decimal places and values', function () {
  var parse = VLab.sigfig.parse;
  assert.equal(parse('50.0').dp, 1);
  assert.equal(parse('0.500').dp, 3);
  assert.equal(parse('12').dp, 0);
  assert.equal(parse('1.25e-3').dp, 5);
  assert.equal(parse('1.2e3').dp, -2);
  assert.close(parse('−0.25').value, -0.25, 1e-12, 'unicode minus');
  assert.close(parse('2.0x10^-3').value, 0.002, 1e-15);
  assert.ok(parse('.5').ok && parse('.5').problems.length === 1, 'leading point flagged');
});
test('sigfig: rejects non-numbers', function () {
  ['', '1,2', '12 cm', '1/2', 'abc', '.', '-'].forEach(function (s) {
    assert.ok(!VLab.sigfig.parse(s).ok, JSON.stringify(s));
  });
});
test('sigfig: formatting keeps trailing zeros', function () {
  var f = VLab.sigfig.formatSF;
  assert.equal(f(2, 3), '2.00');
  assert.equal(f(0.0123456, 3), '0.0123');
  assert.equal(f(9.996, 3), '10.0');
  assert.equal(f(4.0243, 3), '4.02');
  assert.equal(f(123456, 3), '123000');
  assert.equal(f(0, 2), '0.0');
  assert.equal(f(1.23e-5, 3), '1.23e-5');
  assert.equal(VLab.sigfig.formatDP(2.5, 2), '2.50');
  assert.equal(VLab.sigfig.roundSF(0.0004567, 2), 0.00046);
});
test('sigfig: agreesWithin and leastSF', function () {
  var a = VLab.sigfig.agreesWithin;
  assert.ok(a('4.02', 4.024));
  assert.ok(!a('4.03', 4.024));
  assert.ok(a('4.0', 4.04));
  assert.ok(a('4.03', 4.024, 0.005));
  assert.equal(VLab.sigfig.leastSF(['50.0', '1.23', 'x', '0.5']), 1);
});
