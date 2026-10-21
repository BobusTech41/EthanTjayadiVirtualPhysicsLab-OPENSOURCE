/**
 * Tests for the safe calculator parser (ui/calculator.js). Needs ui/calculator.js in the manifest sources.
 */
(function () {
  'use strict';
  var C = globalThis.VLab && VLab.ui && VLab.ui.calculator;
  if (!C) {
    test('calculator: skipped (ui/calculator.js not loaded)', function () { assert.ok(true); });
    return;
  }
  var ev = function (s, o) { return C.evaluate(s, o); };
  function throwsKind(expr, kind) {
    var r = C.tryEvaluate(expr);
    assert.equal(r.ok, false, expr + ' should fail');
    assert.equal(r.kind, kind, expr + ' error kind');
  }

  test('calculator: arithmetic and precedence', function () {
    assert.equal(ev('1+2*3'), 7);
    assert.equal(ev('(1+2)*3'), 9);
    assert.equal(ev('10-4-3'), 3);
    assert.equal(ev('2^3^2'), 512, 'power is right-associative');
    assert.equal(ev('-2^2'), -4, 'unary minus binds looser than ^');
    assert.equal(ev('2^-1'), 0.5);
    assert.close(ev('8/4/2'), 1, 1e-12);
    assert.equal(ev('6÷3×2'), 4, 'unicode operators');
    assert.equal(ev('5−7'), -2, 'unicode minus');
  });

  test('calculator: implicit multiplication binds tighter than division', function () {
    assert.close(ev('2π'), 2 * Math.PI, 1e-12);
    assert.close(ev('1/2π'), 1 / (2 * Math.PI), 1e-12);
    assert.equal(ev('3(4+1)'), 15);
    assert.equal(ev('2sin(30)'), 1);
    assert.close(ev('4π^2/2.47'), 4 * Math.PI * Math.PI / 2.47, 1e-12);
  });

  test('calculator: scientific notation', function () {
    assert.close(ev('1.2e-3'), 0.0012, 1e-15);
    assert.equal(ev('1.2E3'), 1200);
    assert.close(ev('1.2×10^-3'), 0.0012, 1e-15);
    assert.close(ev('1.2x10^3'), 1200, 1e-9);
    assert.close(ev('2e'), 2 * Math.E, 1e-12, '2e is 2 × e');
  });

  test('calculator: functions in degrees', function () {
    assert.equal(ev('sin(30)'), 0.5);
    assert.equal(ev('sin(180)'), 0, 'exact zero');
    assert.equal(ev('cos(90)'), 0);
    assert.equal(ev('cos(60)'), 0.5);
    assert.equal(ev('tan(45)'), 1);
    assert.close(ev('asin(0.5)'), 30, 1e-9);
    assert.close(ev('sin⁻¹(0.5)'), 30, 1e-9);
    assert.close(ev('cos^-1(0.5)'), 60, 1e-9);
    assert.close(ev('arctan(1)'), 45, 1e-9);
    assert.close(ev('sin(10)'), Math.sin(10 * Math.PI / 180), 1e-12);
  });

  test('calculator: roots, logs, powers and constants', function () {
    assert.equal(ev('sqrt(16)'), 4);
    assert.equal(ev('√(16)'), 4);
    assert.close(ev('√2'), Math.SQRT2, 1e-12);
    assert.equal(ev('lg(1000)'), 3);
    assert.equal(ev('log(100)'), 2);
    assert.close(ev('ln(e)'), 1, 1e-12);
    assert.close(ev('exp(1)'), Math.E, 1e-12);
    assert.equal(ev('3²'), 9);
    assert.equal(ev('2³'), 8);
    assert.equal(ev('4⁻¹'), 0.25);
    assert.close(ev('e^(2)'), Math.E * Math.E, 1e-12);
    assert.equal(ev('10^(3'), 1000, 'a missing ) at the end is allowed');
    assert.close(ev('(−8)^(1/3)'), -2, 1e-12, 'odd root of a negative number');
  });

  test('calculator: Ans', function () {
    assert.equal(ev('Ans*2', { ans: 21 }), 42);
    assert.equal(ev('ans+1', { ans: 1 }), 2);
    assert.equal(ev('Ans'), 0, 'Ans defaults to 0');
  });

  test('calculator: errors are reported, never thrown as raw exceptions', function () {
    throwsKind('', 'syntax');
    throwsKind('2+', 'syntax');
    throwsKind('2 3', 'syntax');
    throwsKind('1.2.3', 'syntax');
    throwsKind('1,5', 'syntax');
    throwsKind('alert(1)', 'syntax');
    throwsKind('constructor', 'syntax');
    throwsKind('2))', 'syntax');
    throwsKind('1/0', 'maths');
    throwsKind('sqrt(-1)', 'maths');
    throwsKind('lg(0)', 'maths');
    throwsKind('asin(2)', 'maths');
    throwsKind('tan(90)', 'maths');
    throwsKind('10^400', 'maths');
  });

  test('calculator: no eval or Function in the source', function () {
    var src = String(C.evaluate) + String(C.tokenize);
    assert.ok(!/\beval\s*\(/.test(src) && !/new Function|Function\(/.test(src));
  });

  test('calculator: result formatting', function () {
    assert.equal(C.format(0.1 + 0.2), '0.3');
    assert.equal(C.format(1234), '1234');
    assert.equal(C.format(-2.5), '−2.5');
    assert.equal(C.format(1e-5), '1 × 10⁻⁵');
    assert.equal(C.format(6.62607015e-34), '6.62607015 × 10⁻³⁴');
    assert.equal(C.format(12345678901), '1.23456789 × 10¹⁰');
    assert.equal(C.format(0), '0');
    assert.equal(C.format(NaN), 'Error');
  });
})();
