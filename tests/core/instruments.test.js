/* Tests for the instrument engine (core/instruments/*.js). Uses the global test()/assert API. */
(function () {
  'use strict';
  var VL = globalThis.VLab;
  var I = VL.instruments;

  /** A seeded rng: VL.rng when loaded, else a tiny stand-in implementing the Rng contract. */
  function seeded(seed) {
    if (VL.rng) return VL.rng.create(seed);
    var s = 0;
    for (var i = 0; i < seed.length; i++) s = (Math.imul(s ^ seed.charCodeAt(i), 2654435761) >>> 0);
    function next() {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      seed: seed, next: next,
      uniform: function (a, b) { return a + (b - a) * next(); },
      int: function (a, b) { return a + Math.floor(next() * (b - a + 1)); },
      normal: function () { return Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next()); },
      chance: function (p) { return next() < p; },
      pick: function (a) { return a[Math.floor(next() * a.length)]; },
      fork: function (n) { return seeded(seed + '/' + n); }
    };
  }
  function isMultiple(v, step) { return Math.abs(v / step - Math.round(v / step)) < 1e-6; }

  var ALL = ['metreRule', 'rule30', 'setSquare', 'vernier', 'micrometer', 'protractor', 'balance', 'cylinder',
    'thermometer', 'stopwatch', 'lightGateTimer', 'analogueMeter', 'digitalMeter'];

  test('instruments: every contract type is defined and has the common fields', function () {
    ALL.forEach(function (t) {
      assert.ok(I.types[t], t + ' defined');
      var inst = I.create(t, {}, seeded('FIELDS-' + t));
      assert.equal(inst.type, t);
      assert.ok(typeof inst.name === 'string' && inst.name.length > 0, t + ' name');
      assert.ok(typeof inst.unit === 'string' && inst.unit.length > 0, t + ' unit');
      assert.ok(inst.resolution > 0, t + ' resolution');
      assert.ok(Array.isArray(inst.range) && inst.range.length === 2, t + ' range');
      assert.ok(typeof inst.zeroError === 'number', t + ' zeroError');
      assert.ok(inst.tolerance > 0, t + ' tolerance');
      assert.equal(typeof inst.indicate, 'function');
      assert.equal(typeof inst.draw, 'function');
      assert.equal(typeof inst.apparentShift, 'function');
      var html = inst.describe();
      assert.match(html, /<h3>/, t + ' describe heading');
      assert.match(html, /[Rr]esolution|reading/, t + ' describe content');
    });
    assert.throws(function () { I.create('noSuchThing'); }, 'unknown type throws');
  });

  test('instruments: describe() covers reading, zero error, parallax / technique and uncertainty', function () {
    ['metreRule', 'vernier', 'micrometer', 'protractor', 'balance', 'cylinder', 'thermometer', 'analogueMeter',
      'digitalMeter', 'stopwatch'].forEach(function (t) {
      var h = I.create(t).describe();
      assert.match(h, /How to read/i, t);
      assert.match(h, /Uncertainty to quote/i, t);
      assert.match(h, /zero/i, t);
    });
  });

  test('instruments: tolerance is resolution/2 for analogue and resolution for digital', function () {
    assert.equal(I.create('metreRule').tolerance, 0.05);
    assert.equal(I.create('vernier', { resolution: 0.02 }).tolerance, 0.01);
    assert.equal(I.create('micrometer').tolerance, 0.005);
    assert.equal(I.create('balance', { resolution: 0.01 }).tolerance, 0.01);
    assert.equal(I.create('stopwatch').tolerance, 0.01);
    assert.equal(I.create('digitalMeter', { range: '2 V' }).tolerance, 0.001);
  });

  test('instruments: indicate() without and with a zero error', function () {
    var rule = I.create('metreRule');
    assert.equal(rule.zeroError, 0);
    assert.equal(rule.indicate(47.36), 47.36, 'analogue: no quantization');
    var v = I.create('vernier', { zeroError: 0.2 });
    assert.equal(v.zeroError, 0.2);
    assert.close(v.indicate(23.4), 23.6, 1e-9);
    assert.close(v.readingFor(23.4), 23.6, 1e-9);
    var m = I.create('micrometer', { zeroError: -0.03 });
    assert.close(m.indicate(0.41), 0.38, 1e-9);
    var th = I.create('thermometer', { zeroError: 1, initial: 20 });
    assert.equal(th.indicate(), 21);
    assert.equal(th.indicate(150), 113, 'clamped at the top of the capillary');
    var am = I.create('analogueMeter', { kind: 'A', zeroError: 0.02 });
    assert.close(am.indicate(0.5), 0.52, 1e-9);
    assert.close(am.indicate(5), 1.04, 1e-9, 'needle stop above full scale');
  });

  test('instruments: digital quantization (balance, multimeter, stopwatch)', function () {
    var b = I.create('balance', { resolution: 0.01, zeroError: 0 });
    assert.equal(b.indicate(12.3456), 12.35);
    assert.equal(b.display(12.3456), '12.35');
    assert.equal(b.display(12.3), '12.30', 'trailing zero kept');
    var b1 = I.create('balance', { resolution: 0.1, zeroError: 0 });
    assert.equal(b1.indicate(12.34), 12.3);
    assert.equal(b1.display(0.04), '0.0', 'never "-0.0"');
    assert.equal(b1.display(-0.04), '0.0');
    var dm = I.create('digitalMeter', { range: '2 V', zeroError: 0 });
    assert.equal(dm.indicate(1.23456), 1.235);
    assert.equal(dm.display(1.2), '1.200');
    assert.equal(dm.display(2.5), 'OL');
    dm.setRange('20 V');
    assert.equal(dm.resolution, 0.01);
    assert.equal(dm.display(2.5), '2.50');
    var ma = I.create('digitalMeter', { range: '200 mA', zeroError: 0 });
    assert.equal(ma.unit, 'mA');
    assert.equal(ma.resolution, 0.1);
    assert.equal(ma.indicateSI(0.12345), 123.5);
    var amp = I.create('digitalMeter', { range: '2 A', zeroError: 0 });
    assert.equal(amp.resolution, 0.001);
    var sw = I.create('stopwatch');
    assert.equal(sw.indicate(12.349), 12.34, 'stopwatch truncates');
  });

  test('instruments: digital flicker is deterministic, only with `now`, and off at noise level 0', function () {
    if (!VL.noise) return; // needs VL.noise.level
    VL.noise.level = 1;
    var b = I.create('balance', { resolution: 0.01, zeroError: 0 }, seeded('FLICK-1'));
    var seen = {};
    for (var t = 0; t < 40000; t += 450) {
      var r = b.indicate(10.005, t);
      assert.ok(isMultiple(r, 0.01), 'quantized');
      assert.ok(Math.abs(r - 10.005) <= 0.03 + 1e-9, 'flicker is only in the last digit or so');
      assert.equal(b.indicate(10.005, t), r, 'same time -> same value');
      seen[r] = true;
    }
    assert.ok(Object.keys(seen).length >= 2, 'last digit flickers at a rounding boundary');
    assert.equal(b.indicate(10.004), 10.0, 'no flicker without now');
    VL.noise.level = 0;
    for (var t2 = 0; t2 < 20000; t2 += 450) assert.equal(b.indicate(10.004, t2), 10.0, 'exact at level 0');
  });

  test('instruments: balance tare and untared offset', function () {
    var b = I.create('balance', { resolution: 0.1, zeroError: 0.3 });
    assert.equal(b.indicate(0), 0.3, 'untared offset shows with an empty pan');
    assert.equal(b.indicate(20), 20.3);
    b.tare();
    assert.ok(b.tared);
    assert.equal(b.indicate(0), 0);
    assert.equal(b.indicate(20), 20);
    b.tare(55.0);                            // beaker on the pan
    assert.equal(b.indicate(55.0 + 12.5), 12.5);
    b.untare();
    assert.equal(b.indicate(0), 0.3);
    assert.equal(b.display(700), 'Err', 'overload');
  });

  test('instruments: vernier readingFor, decompose and geometry helpers', function () {
    var v = I.create('vernier', { resolution: 0.1, zeroError: 0 });
    assert.equal(v.divisions, 10);
    assert.close(v.vernierSpacing, 0.9, 1e-12);
    assert.equal(v.unit, 'mm');
    assert.close(v.readingFor(23.43), 23.43, 1e-9);
    assert.equal(v.scaleReading(23.43), 23.4);
    assert.deepEqual(v.decompose(23.43), { reading: 23.4, main: 23, division: 4 });
    // The aligned vernier mark really does coincide with a main-scale mark.
    var d = v.decompose(23.43);
    var pos = 23.4 + d.division * v.vernierSpacing;
    assert.close(pos, Math.round(pos), 1e-9, 'vernier mark lines up with a main-scale mm mark');

    var f = I.create('vernier', { resolution: 0.02, zeroError: 0 });
    assert.equal(f.divisions, 50);
    assert.close(f.vernierSpacing, 0.98, 1e-12);
    assert.equal(f.scaleReading(12.345), 12.34);
    assert.deepEqual(f.decompose(12.345), { reading: 12.34, main: 12, division: 17 });
    assert.equal(f.alignedDivision(12.34), 17);

    var z = I.create('vernier', { resolution: 0.1, zeroError: -0.3 });
    var dz = z.decompose(0);
    assert.equal(dz.reading, -0.3);
    assert.equal(dz.main, -1);
    assert.equal(dz.division, 7, 'negative zero error: division 7 lines up');

    var place = { x: 10, y: 20 };
    var faces = v.jawFaces(place, { opening: 25 });
    assert.close(faces.fixed, 10, 1e-12);
    assert.close(faces.moving, 12.5, 1e-12);
    assert.ok(faces.bottom > faces.top);
    assert.close(v.openingForX(place, 12.5), 25, 1e-9);
    assert.equal(v.openingForX(place, 5), 0, 'clamped at closed');
    assert.ok(v.sliderContains(place, { opening: 25 }, { x: 13, y: 20.5 }));
    assert.ok(!v.sliderContains(place, { opening: 25 }, { x: 5, y: 20.5 }));
    assert.close(z.vernierZeroX(place, { opening: 10 }), 10 + 0.97, 1e-9);
  });

  /** A stub 2D context that records the line width of every stroke made with the given stroke style. */
  function strokeRecorder(style) {
    var widths = [], state = { strokeStyle: '', lineWidth: 1 };
    var noop = function () {};
    var grad = { addColorStop: noop };
    var target = {
      canvas: null,
      createLinearGradient: function () { return grad; },
      createRadialGradient: function () { return grad; },
      measureText: function () { return { width: 10 }; },
      stroke: function () { if (state.strokeStyle === style) widths.push(state.lineWidth); }
    };
    var g = new Proxy(target, {
      get: function (t, k) { return k in t ? t[k] : (k in state ? state[k] : noop); },
      set: function (t, k, v) { state[k] = v; return true; }
    });
    return { g: g, widths: widths };
  }

  test('instruments: the 0.02 mm vernier is drawn with fine graduations (readable at 800 px per cm)', function () {
    var view = { scale: 800, eyeAngle: 0 };
    var fine = strokeRecorder('#111');
    I.create('vernier', { resolution: 0.02, zeroError: 0 }).draw(fine.g, { x: 0, y: 0 }, view, { opening: 20.12 });
    assert.deepEqual(fine.widths, [0.004, 0.004], 'main scale and vernier graduations 0.004 cm wide');
    assert.ok(0.004 * view.scale >= 3, 'about 3 px wide');
    assert.ok(0.002 * view.scale >= 1.5, 'adjacent vernier lines are 0.02 mm (1.6 px) out of step with the main scale');
    var coarse = strokeRecorder('#111');
    I.create('vernier', { resolution: 0.1, zeroError: 0 }).draw(coarse.g, { x: 0, y: 0 }, view, { opening: 20.1 });
    assert.deepEqual(coarse.widths, [0.006, 0.005], 'the 0.1 mm vernier is unchanged');
  });

  test('instruments: stopwatch getState / setState keep a stopped reading (light-gate timer too)', function () {
    var sw = I.create('stopwatch');
    sw.start(0);
    sw.stop(1500);
    assert.deepEqual(sw.getState(), { elapsed: 1.5, running: false });
    var sw2 = I.create('stopwatch');
    sw2.setState({ elapsed: 1.5 });
    assert.equal(sw2.display(123456), '1.50', 'restored stopped');
    assert.equal(sw2.running, false);
    sw2.start(0);
    sw2.stop(500);
    assert.close(sw2.elapsed(), 2.0, 1e-12, 'a later start keeps accumulating');
    var run = I.create('stopwatch');
    run.start(1000);
    var st = run.getState(3250);
    assert.equal(st.running, true);
    assert.close(st.elapsed, 2.25, 1e-12);
    var back = I.create('stopwatch');
    back.setState(st);
    assert.equal(back.running, false, 'a running watch comes back stopped at its elapsed time');
    assert.equal(back.display(), '2.25');
    back.setState({ elapsed: -3 });
    assert.equal(back.elapsed(), 0, 'nonsense restores zero');
    var lg = I.create('lightGateTimer');
    lg.setState({ elapsed: 0.4567 });
    assert.equal(lg.display(), '0.456');
    assert.deepEqual(lg.getState(), { elapsed: 0.4567, running: false });
  });

  test('instruments: micrometer decompose', function () {
    var m = I.create('micrometer', { zeroError: 0 });
    var d = m.decompose(6.73);
    assert.equal(d.sleeve, 6.5);
    assert.close(d.thimble, 23, 1e-9);
    assert.equal(d.thimbleDivision, 23);
    assert.equal(d.value, 6.73);
    var d2 = m.decompose(3.47);
    assert.equal(d2.sleeve, 3.0);
    assert.equal(d2.thimbleDivision, 47);
    var d3 = m.decompose(0.38);
    assert.equal(d3.sleeve, 0);
    assert.equal(d3.thimbleDivision, 38);
    var d4 = m.decompose(5.5);
    assert.equal(d4.sleeve, 5.5);
    assert.equal(d4.thimbleDivision, 0);
    var neg = I.create('micrometer', { zeroError: -0.03 });
    var dn = neg.decompose(0);
    assert.equal(dn.sleeve, -0.5);
    assert.equal(dn.thimbleDivision, 47, 'thimble zero above the datum: reads 47');
    assert.equal(dn.value, -0.03);
    var pos = I.create('micrometer', { zeroError: 0.02 });
    assert.equal(pos.decompose(0).thimbleDivision, 2);
    assert.equal(pos.scaleReading(0.4), 0.42);
    // Geometry and parallax.
    var place = { x: 0, y: 0 };
    assert.close(m.spindleX(place, { gap: 5 }) - m.anvilX(place), 0.5, 1e-12);
    assert.close(m.apparentThimble(2.0, { eyeAngle: 0 }), 2.0, 1e-9);
    assert.ok(m.apparentThimble(2.0, { eyeAngle: 10 }) > 2.0, 'eye above reads high');
    assert.ok(m.apparentThimble(2.0, { eyeAngle: 10 }) - 2.0 < 0.01, 'by less than a division');
  });

  test('instruments: protractor angleReading', function () {
    var p = I.create('protractor');
    var place = { x: 5, y: 5, rotation: 0 };
    assert.close(p.angleReading(place, 0), 0, 1e-9, 'ray to the right');
    assert.close(p.angleReading(place, -Math.PI / 2), 90, 1e-9, 'ray straight up');
    assert.close(p.angleReading(place, Math.atan2(-1, -1)), 135, 1e-9);
    assert.close(p.angleReading(place, Math.PI), 180, 1e-9);
    var both = p.angleReadings(place, Math.atan2(-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)));
    assert.close(both.outer, 30, 1e-9);
    assert.close(both.inner, 150, 1e-9);
    var rotated = { x: 0, y: 0, rotation: Math.PI / 6 };
    assert.close(p.angleReading(rotated, Math.PI / 6), 0, 1e-9, 'baseline follows the rotation');
    assert.close(p.angleReading(rotated, p.rayAngleFor(rotated, 72)), 72, 1e-9, 'rayAngleFor is the inverse');
    assert.ok(p.contains(place, { x: 5, y: 1 }));
    assert.ok(!p.contains(place, { x: 5, y: 9 }));
  });

  test('instruments: rules readingAt and parallax helpers', function () {
    var r = I.create('metreRule');
    assert.equal(r.unit, 'cm');
    assert.equal(r.resolution, 0.1);
    var h = { x: 10, y: 5, angle: 0 };
    assert.close(r.readingAt(h, { x: 22.3, y: 7 }), 12.3, 1e-9);
    var down = { x: 0, y: 0, angle: Math.PI / 2 };
    assert.close(r.readingAt(down, { x: 1.5, y: 47.8 }), 47.8, 1e-9);
    var pt = r.pointAt(down, 30);
    assert.close(pt.x, 0, 1e-9); assert.close(pt.y, 30, 1e-9);
    assert.equal(r.apparentShift(1.5, { eyeAngle: 0 }), 0);
    var s = r.apparentShift(1.5, { eyeAngle: 10 });
    assert.close(s, 1.5 * Math.tan(10 * Math.PI / 180), 1e-12, 'gap * tan(angle)');
    assert.close(r.apparentReadingAt(down, { x: 1.5, y: 47.8 }, 1.5, { eyeAngle: 10 }), 47.8 + s, 1e-4,
      'eye above: an object in front appears lower on a rule reading downwards');
    var up = { x: 0, y: 100, angle: -Math.PI / 2 };
    assert.close(r.readingAt(up, { x: 0, y: 60 }), 40, 1e-9);
    assert.ok(r.apparentReadingAt(up, { x: 0, y: 60 }, 2, { eyeAngle: 8 }) < 40, 'standing rule: eye above reads low');
    assert.ok(r.contains(h, { x: 20, y: 6 }));
    assert.ok(!r.contains(h, { x: 20, y: 4 }));
    var r30 = I.create('rule30');
    assert.deepEqual(r30.range, [0, 30]);
    assert.equal(I.apparentShift(2, { eyeAngle: 0 }), 0);
  });

  test('instruments: cylinder meniscus geometry and parallax', function () {
    var c = I.create('cylinder');
    assert.equal(c.resolution, 1);
    var big = I.create('cylinder', { capacity: 250 });
    assert.equal(big.resolution, 2);
    var place = { x: 0, y: 30 };
    var y = c.levelY(place, 64);
    assert.close(c.volumeAtY(place, y), 64, 1e-9);
    assert.ok(c.levelY(place, 80) < y, 'more liquid -> higher level (smaller y)');
    assert.close(c.apparentReading(64, { eyeAngle: 0 }), 64, 1e-9);
    assert.ok(c.apparentReading(64, { eyeAngle: 8 }) > 64, 'eye above reads high');
    assert.ok(c.apparentReading(64, { eyeAngle: -8 }) < 64, 'eye below reads low');
  });

  test('instruments: thermometer bulb lag and parallax', function () {
    var t = I.create('thermometer', { initial: 20, zeroError: 0 });
    assert.equal(t.tau, 5);
    t.update(5, 80);
    assert.close(t.temperature, 80 - 60 * Math.exp(-1), 1e-9, 'one time constant');
    for (var i = 0; i < 100; i++) t.update(1, 80);
    assert.close(t.temperature, 80, 1e-6);
    assert.equal(t.indicate(), 80);
    var place = { x: 0, y: 40 };
    assert.close(t.tempAtY(place, t.yFor(place, 37)), 37, 1e-9);
    assert.close(t.yFor(place, 0) - t.yFor(place, 10), 2.0, 1e-9, '0.2 cm per degree');
    assert.ok(t.apparentReading(50, { eyeAngle: 10 }) > 50, 'eye above reads high');
  });

  test('instruments: stopwatch elapsed, display and formatting', function () {
    var sw = I.create('stopwatch');
    assert.equal(sw.display(0), '0.00');
    assert.ok(!sw.running);
    sw.start(1000);
    assert.ok(sw.running);
    assert.close(sw.elapsed(3500), 2.5, 1e-12);
    sw.stop(13340);
    assert.ok(!sw.running);
    assert.close(sw.elapsed(99999), 12.34, 1e-12, 'frozen after stop');
    assert.equal(sw.display(99999), '12.34');
    sw.start(20000); sw.stop(21000);
    assert.close(sw.elapsed(), 13.34, 1e-9, 'start/stop cycles accumulate');
    sw.reset();
    assert.equal(sw.elapsed(5), 0);
    assert.equal(sw.toggle(0), 'start');
    assert.equal(sw.toggle(62350), 'stop');
    assert.equal(sw.display(), '1:02.35');
    assert.equal(sw.reading(), 62.35);
    assert.equal(I.formatTime(12.349), '12.34', 'truncated, not rounded');
    assert.equal(I.formatTime(59.999), '59.99');
    assert.equal(I.formatTime(60), '1:00.00');
    assert.equal(I.formatTime(3605.5), '1:00:05.50');
    assert.equal(I.formatTime(0.452, 3), '0.452');
    assert.equal(I.formatTime(-1), '0.00');
  });

  test('instruments: light-gate timer', function () {
    var lg = I.create('lightGateTimer');
    assert.equal(lg.resolution, 0.001);
    assert.equal(lg.trigger(1000), 'start');
    assert.equal(lg.trigger(1452.7), 'stop');
    assert.equal(lg.display(), '0.452');
    assert.equal(lg.measure(0.45279), 0.452);
    assert.equal(lg.display(), '0.452');
    lg.reset();
    assert.equal(lg.display(), '0.000');
  });

  test('instruments: analogue meter tolerance, damping and mirror parallax', function () {
    var a = I.create('analogueMeter', { kind: 'A', range: { max: 1, minor: 0.02 }, zeroError: 0 });
    assert.equal(a.unit, 'A');
    assert.equal(a.resolution, 0.02);
    assert.equal(a.tolerance, 0.01);
    assert.equal(a.divisions, 50);
    var v = I.create('analogueMeter', { kind: 'V', range: { max: 5, minor: 0.1 }, zeroError: 0 });
    assert.equal(v.unit, 'V');
    assert.close(v.tolerance, 0.05, 1e-12);
    assert.equal(a.needle, 0);
    var peak = 0;
    for (var i = 0; i < 300; i++) { a.update(1 / 60, 0.6); peak = Math.max(peak, a.needle); }
    assert.close(a.needle, 0.6, 1e-4, 'needle settles on the value');
    assert.ok(peak > 0.6 && peak < 0.66, 'small overshoot');
    assert.close(a.settle(0.3), 0.3, 1e-12);
    assert.close(a.apparentValue(0.5, { eyeAngle: 0 }), 0.5, 1e-12);
    var app = a.apparentValue(0.5, { eyeAngle: 10 });
    assert.ok(app > 0.5 && app - 0.5 < 0.02, 'parallax shifts the reading by under one division at 10 degrees');
    assert.close(a.angleFor(0) * 180 / Math.PI, -45, 1e-9);
    assert.close(a.angleFor(1) * 180 / Math.PI, 45, 1e-9);
    var off = I.create('analogueMeter', { kind: 'A', zeroError: -0.02 });
    assert.close(off.needle, -0.02, 1e-12, 'needle off zero with no current');
  });

  test('instruments: zero errors are deterministic for a seeded rng and multiples of the resolution', function () {
    if (!VL.noise) return;
    VL.noise.level = 1;
    ['vernier', 'micrometer', 'balance', 'analogueMeter', 'digitalMeter'].forEach(function (t) {
      var a = I.create(t, {}, seeded('ZERO-' + t + '-1'));
      var b = I.create(t, {}, seeded('ZERO-' + t + '-1'));
      assert.equal(a.zeroError, b.zeroError, t + ' same seed, same zero error');
    });
    var nonZero = 0, m;
    for (var i = 0; i < 200; i++) {
      m = I.create('micrometer', {}, seeded('MIC-' + i));
      assert.ok(isMultiple(m.zeroError, 0.01), 'multiple of 0.01 mm');
      assert.ok(Math.abs(m.zeroError) <= 0.03 + 1e-12, 'within ±0.03 mm');
      if (m.zeroError) nonZero++;
    }
    assert.ok(nonZero > 30 && nonZero < 140, 'some but not all micrometers have a zero error (' + nonZero + ')');
    var v = I.create('vernier', { resolution: 0.02 }, seeded('V-7'));
    assert.ok(isMultiple(v.zeroError, 0.02));
    // An explicit zero error overrides the rng; zeroErrorChance 0 disables it.
    assert.equal(I.create('vernier', { zeroError: 0.1 }, seeded('X')).zeroError, 0.1);
    for (var j = 0; j < 50; j++) assert.equal(I.create('vernier', { zeroErrorChance: 0 }, seeded('NZ-' + j)).zeroError, 0);
    // No rng -> no zero error.
    assert.equal(I.create('micrometer').zeroError, 0);
  });

  test('instruments: noise.level = 0 => every zero error is 0', function () {
    if (!VL.noise) return;
    VL.noise.level = 0;
    for (var i = 0; i < 60; i++) {
      ['vernier', 'micrometer', 'balance', 'thermometer', 'analogueMeter', 'digitalMeter'].forEach(function (t) {
        assert.equal(I.create(t, {}, seeded('L0-' + t + '-' + i)).zeroError, 0, t);
      });
    }
    var b = I.create('balance', { resolution: 0.01 }, seeded('L0-B'));
    assert.equal(b.indicate(0, 12345), 0, 'balance reads exactly zero, no flicker');
    assert.equal(b.display(37.256, 999), '37.26');
  });

  test('instruments: zero-error draws consume the rng identically whatever the level', function () {
    if (!VL.noise || !VL.rng) return;
    VL.noise.level = 0;
    var r1 = seeded('CONSUME');
    I.create('vernier', {}, r1);
    var after0 = r1.next();
    VL.noise.level = 1;
    var r2 = seeded('CONSUME');
    I.create('vernier', {}, r2);
    assert.equal(r2.next(), after0, 'other streams stay reproducible');
  });

  test('instruments: list() and util helpers', function () {
    var names = I.list().map(function (e) { return e.type; });
    ALL.forEach(function (t) { assert.ok(names.indexOf(t) >= 0, t + ' listed'); });
    var U = I.util;
    assert.equal(U.decimalsOf(0.02), 2);
    assert.equal(U.decimalsOf(0.1), 1);
    assert.equal(U.decimalsOf(2), 0);
    assert.equal(U.roundTo(0.1 + 0.2, 0.1), 0.3);
    assert.equal(U.fixed(-0.001, 2), '0.00');
    assert.equal(U.truncate(12.349, 0.01), 12.34);
    assert.ok(U.normalAt(5, 3) === U.normalAt(5, 3), 'pure pseudo-noise');
  });
})();
