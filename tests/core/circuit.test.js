/* Circuit engine: zero-noise physics checks against hand-calculated values. */
function circ() { VLab.noise.level = 0; return VLab.circuit.create('TST-0000-0000'); }
function wire(c, a, at, b, bt) { return VLab.circuit.addWire(c, { part: a.id, term: at }, { part: b.id, term: bt }); }

test('circuit: cell + resistor + ammeter + voltmeter (Ohm and internal resistance)', function () {
  var C = VLab.circuit, c = circ();
  var cell = C.addPart(c, 'cell'); cell.truth = { emf: 1.5, r: 0.5 };
  var sw = C.addPart(c, 'switch', 0, 0, { closed: true }); sw.truth = { R: 0 + 1e-6 };
  var R = C.addPart(c, 'resistor', 0, 0, { nominal: 10 });
  var A = C.addPart(c, 'ammeter'); A.truth = { r1: 0.1, r100: 1 };
  var V = C.addPart(c, 'voltmeter'); V.truth = { perVolt: 1e9 };
  wire(c, cell, '+', sw, 'a'); wire(c, sw, 'b', A, '+'); wire(c, A, '-', R, 'a'); wire(c, R, 'b', cell, '-');
  wire(c, V, '+', R, 'a'); wire(c, V, '-', R, 'b');
  var res = C.createSim(c).solve();
  var I = 1.5 / (10 + 0.5 + 0.1);
  assert.close(res.parts[A.id].reading, I, 1e-6, 'ammeter');
  assert.close(res.parts[V.id].reading, I * 10, 1e-5, 'voltmeter across R');
  assert.close(res.parts[cell.id].terminalPd, 1.5 - I * 0.5, 1e-5, 'terminal p.d.');
  assert.equal(res.warnings.length, 0);
});

test('circuit: open switch gives no current; reversed ammeter reads negative and warns', function () {
  var C = VLab.circuit, c = circ();
  var cell = C.addPart(c, 'cell'); cell.truth = { emf: 1.5, r: 0.5 };
  var sw = C.addPart(c, 'switch');
  var R = C.addPart(c, 'resistor', 0, 0, { nominal: 10 });
  var A = C.addPart(c, 'ammeter');
  wire(c, cell, '+', sw, 'a'); wire(c, sw, 'b', A, '-'); wire(c, A, '+', R, 'a'); wire(c, R, 'b', cell, '-');
  var sim = C.createSim(c);
  assert.close(sim.solve().parts[A.id].reading, 0, 1e-9);
  sw.settings.closed = true;
  var res = sim.solve();
  assert.ok(res.parts[A.id].reading < -0.1, 'negative reading');
  assert.ok(res.warnings.some(function (w) { return w.kind === 'reversed'; }));
});

test('circuit: parallel resistors, resistance box and rheostat', function () {
  var C = VLab.circuit, c = circ();
  var ps = C.addPart(c, 'psu', 0, 0, { setV: 6 }); ps.truth = { gain: 1, offset: 0, r: 1e-6, Ilimit: 5 };
  var r1 = C.addPart(c, 'resistor', 0, 0, { nominal: 10 });
  var box = C.addPart(c, 'rbox', 0, 0, { x10: 1, x1: 5 }); box.truth = { gain: 1, Rc: 0 };
  wire(c, ps, '+', r1, 'a'); wire(c, ps, '+', box, 'a'); wire(c, r1, 'b', ps, '-'); wire(c, box, 'b', ps, '-');
  var res = C.createSim(c).solve();
  assert.close(res.parts[ps.id].current, 6 / 10 + 6 / 15, 1e-4, 'parallel current');
  // rheostat as potential divider: slider at 0.25 of 20 Ω from A, output A–S unloaded
  var c2 = circ();
  var ps2 = C.addPart(c2, 'psu', 0, 0, { setV: 4 }); ps2.truth = { gain: 1, offset: 0, r: 1e-6, Ilimit: 5 };
  var rh = C.addPart(c2, 'rheostat', 0, 0, { pos: 0.25 }); rh.truth = { Rt: 20 };
  var dmm = C.addPart(c2, 'dmm', 0, 0, { mode: 'V', range: '20 V' }); dmm.truth = { gain: 1, Rin: 1e12, Rhi: 0.01 };
  wire(c2, ps2, '+', rh, 'B'); wire(c2, ps2, '-', rh, 'A'); wire(c2, dmm, 'V', rh, 'S'); wire(c2, dmm, 'COM', rh, 'A');
  assert.close(C.createSim(c2).solve().parts[dmm.id].reading, 1.0, 1e-4, 'divider output');
});

test('circuit: resistance wire R = ρL/A with the jockey', function () {
  var C = VLab.circuit, c = circ();
  var ps = C.addPart(c, 'psu', 0, 0, { setV: 2 }); ps.truth = { gain: 1, offset: 0, r: 1e-6, Ilimit: 5 };
  var w = C.addPart(c, 'wire', 0, 0, { jockey: 40 });
  var d = 0.3e-3, rho = 4.9e-7;
  w.truth = { rho: rho, d: d, L: 1, Rc: 0, alpha: 0, kHeat: 0, tau: 10 };
  wire(c, ps, '+', w, 'A'); wire(c, ps, '-', w, 'J');
  var res = C.createSim(c).solve();
  var R = rho * 0.40 / (Math.PI * d * d / 4);
  assert.close(res.parts[ps.id].current, 2 / R, 1e-4);
});

test('circuit: diode conducts forwards only, LED about 1.9 V', function () {
  var C = VLab.circuit, c = circ();
  var ps = C.addPart(c, 'psu', 0, 0, { setV: 5 }); ps.truth = { gain: 1, offset: 0, r: 1e-6, Ilimit: 5 };
  var r = C.addPart(c, 'resistor', 0, 0, { nominal: 470 });
  var D = C.addPart(c, 'diode');
  wire(c, ps, '+', r, 'a'); wire(c, r, 'b', D, 'A'); wire(c, D, 'K', ps, '-');
  var sim = C.createSim(c), res = sim.solve();
  var I = res.parts[D.id].current;
  var Vd = res.parts[D.id].terminalV.A - res.parts[D.id].terminalV.K;
  assert.ok(Vd > 0.55 && Vd < 0.85, 'forward voltage ' + Vd);
  assert.close(I, (5 - Vd) / 470, 1e-6, 'KVL');
  ps.settings.setV = 0; ps.truth = { gain: 1, offset: -5, r: 1e-6, Ilimit: 5 };
  // reverse: swap the diode
  var c2 = circ();
  var ps2 = C.addPart(c2, 'psu', 0, 0, { setV: 5 }); ps2.truth = { gain: 1, offset: 0, r: 1e-6, Ilimit: 5 };
  var r2 = C.addPart(c2, 'resistor', 0, 0, { nominal: 470 }); var D2 = C.addPart(c2, 'diode');
  wire(c2, ps2, '+', r2, 'a'); wire(c2, r2, 'b', D2, 'K'); wire(c2, D2, 'A', ps2, '-');
  assert.ok(Math.abs(C.createSim(c2).solve().parts[D2.id].current) < 1e-7, 'reverse current tiny');
  var c3 = circ();
  var ps3 = C.addPart(c3, 'psu', 0, 0, { setV: 5 }); ps3.truth = { gain: 1, offset: 0, r: 1e-6, Ilimit: 5 };
  var r3 = C.addPart(c3, 'resistor', 0, 0, { nominal: 220 }); var L3 = C.addPart(c3, 'led');
  wire(c3, ps3, '+', r3, 'a'); wire(c3, r3, 'b', L3, 'A'); wire(c3, L3, 'K', ps3, '-');
  var r3s = C.createSim(c3).solve().parts[L3.id];
  var VL3 = r3s.terminalV.A - r3s.terminalV.K;
  assert.ok(VL3 > 1.7 && VL3 < 2.1, 'LED forward voltage ' + VL3);
});

test('circuit: filament lamp is non-ohmic and reaches its rating', function () {
  var C = VLab.circuit, c = circ();
  var ps = C.addPart(c, 'psu', 0, 0, { setV: 2.5 }); ps.truth = { gain: 1, offset: 0, r: 1e-6, Ilimit: 5 };
  var L = C.addPart(c, 'lamp', 0, 0, { rating: '2.5 V 0.3 A' });
  wire(c, ps, '+', L, 'a'); wire(c, L, 'b', ps, '-');
  var sim = C.createSim(c), I1 = sim.solve().parts[ps.id].current;
  assert.close(I1, 0.3, 0.003, 'rated current at rated voltage');
  ps.settings.setV = 0.25;
  var I2 = C.createSim(c).solve().parts[ps.id].current;
  assert.ok(0.25 / I2 < 2.5 / I1 * 0.6, 'resistance much lower when cool');
});

test('circuit: thermistor resistance falls as the water warms; capacitor charges with time constant RC', function () {
  var C = VLab.circuit, c = circ();
  var th = C.addPart(c, 'thermistor'); th.truth = { R25: 4700, B: 3800, tau: 1 };
  assert.close(C.types.thermistor.resistance(th.truth, 25), 4700, 1e-6);
  assert.ok(C.types.thermistor.resistance(th.truth, 80) < 1000);
  var c2 = circ();
  var ps = C.addPart(c2, 'psu', 0, 0, { setV: 6 }); ps.truth = { gain: 1, offset: 0, r: 1e-6, Ilimit: 5 };
  var R = C.addPart(c2, 'resistor', 0, 0, { nominal: 10000 });
  var cap = C.addPart(c2, 'capacitor', 0, 0, { nominal: 1000 }); cap.truth = { C: 1e-3, Rleak: 1e15 };
  wire(c2, ps, '+', R, 'a'); wire(c2, R, 'b', cap, '+'); wire(c2, cap, '-', ps, '-');
  var sim = C.createSim(c2);
  for (var t = 0; t < 10; t += 0.01) sim.step(0.01);         // one time constant (RC = 10 s)
  assert.close(sim.state[cap.id].Vc, 6 * (1 - Math.exp(-1)), 0.03);
});

test('circuit: short circuit warns; multimeter fuse blows; ohmmeter reads a disconnected resistor', function () {
  var C = VLab.circuit, c = circ();
  var cell = C.addPart(c, 'cell'); cell.truth = { emf: 1.5, r: 0.5 };
  var d = C.addPart(c, 'dmm', 0, 0, { mode: 'A', range: '200 mA' }); d.truth = { gain: 1, Rin: 1e7, Rhi: 0.01 };
  wire(c, cell, '+', d, 'V'); wire(c, d, 'COM', cell, '-');
  var sim = C.createSim(c), res = sim.step(0.05);
  assert.ok(res.warnings.some(function (w) { return w.kind === 'fuse'; }), 'fuse blew');
  assert.close(sim.step(0.05).parts[d.id].reading, 0, 1e-9);
  var c2 = circ();
  var cell2 = C.addPart(c2, 'cell'); cell2.truth = { emf: 1.5, r: 0.5 };
  var r2 = C.addPart(c2, 'resistor', 0, 0, { nominal: 1 }); r2.truth = { R: 0.01, Pmax: 0.5 };
  wire(c2, cell2, '+', r2, 'a'); wire(c2, r2, 'b', cell2, '-');
  assert.ok(C.createSim(c2).solve().warnings.some(function (w) { return w.kind === 'short'; }), 'short warning');
  var c3 = circ();
  var m = C.addPart(c3, 'dmm', 0, 0, { mode: 'Ω', range: '2 kΩ' }); m.truth = { gain: 1, Rin: 1e7, Rhi: 0.01 };
  var r3 = C.addPart(c3, 'resistor', 0, 0, { nominal: 470 }); r3.truth = { R: 470, Pmax: 0.5 };
  wire(c3, m, 'V', r3, 'a'); wire(c3, m, 'COM', r3, 'b');
  assert.close(C.createSim(c3).solve().parts[m.id].reading, 470, 1e-3);
});

test('circuit: hidden values are reproducible from the seed and within tolerance', function () {
  var C = VLab.circuit;
  VLab.noise.level = 1;
  var a = C.create('CIR-AAAA-BBBB'), b = C.create('CIR-AAAA-BBBB');
  var pa = C.addPart(a, 'resistor', 0, 0, { nominal: 47 }), pb = C.addPart(b, 'resistor', 0, 0, { nominal: 47 });
  var ha = C.hidden(a, pa), hb = C.hidden(b, pb);
  assert.equal(ha.R, hb.R);
  assert.ok(Math.abs(ha.R - 47) <= 47 * 0.05 + 1e-9);
  var cell = C.addPart(a, 'cell'), h = C.hidden(a, cell);
  assert.ok(h.emf >= 1.48 && h.emf <= 1.62 && h.r >= 0.3 && h.r <= 1.2);
});

test('circuit: matching a built circuit against a template diagram', function () {
  var C = VLab.circuit, c = circ();
  var cell = C.addPart(c, 'cell'), sw = C.addPart(c, 'switch'), R = C.addPart(c, 'resistor'), A = C.addPart(c, 'ammeter'), V = C.addPart(c, 'dmm');
  wire(c, cell, '+', sw, 'b'); wire(c, sw, 'a', A, '+'); wire(c, A, '-', R, 'b'); wire(c, R, 'a', cell, '-');
  wire(c, V, 'V', R, 'b'); wire(c, V, 'COM', R, 'a');
  var tpl = {
    parts: [{ ref: 'E', category: 'cell' }, { ref: 'S', category: 'switch' }, { ref: 'R', category: 'resistor' },
      { ref: 'A', category: 'ammeter', polar: true }, { ref: 'V', category: 'voltmeter', polar: true }],
    nets: [['E:+', 'S:a'], ['S:b', 'A:+'], ['A:-', 'R:a', 'V:+'], ['R:b', 'E:-', 'V:-']]
  };
  var m = C.matchTemplate(c, tpl);
  assert.ok(m.ok, JSON.stringify(m));
  C.removeWire(c, c.wires[c.wires.length - 1].id);           // disconnect the voltmeter COM lead
  assert.ok(!C.matchTemplate(c, tpl).ok);
  var c2 = circ();
  var cell2 = C.addPart(c2, 'cell'), sw2 = C.addPart(c2, 'switch'), R2 = C.addPart(c2, 'resistor'), A2 = C.addPart(c2, 'ammeter'), V2 = C.addPart(c2, 'voltmeter');
  wire(c2, cell2, '+', sw2, 'a'); wire(c2, sw2, 'b', A2, '-'); wire(c2, A2, '+', R2, 'a'); wire(c2, R2, 'b', cell2, '-');
  wire(c2, V2, '+', R2, 'a'); wire(c2, V2, '-', R2, 'b');
  var m2 = C.matchTemplate(c2, tpl);
  assert.ok(!m2.ok && m2.reversed.indexOf('A') !== -1, 'reversed ammeter reported: ' + JSON.stringify(m2));
});

test('circuit: a multimeter lead left in the 20A socket shorts the cell', function () {
  var C = VLab.circuit, c = circ();
  var cell = C.addPart(c, 'cell'); cell.truth = { emf: 1.5, r: 0.5 };
  var d = C.addPart(c, 'dmm', 0, 0, { mode: 'V', range: '2 V' }); d.truth = { gain: 1, Rin: 1e7, Rhi: 0.01 };
  wire(c, cell, '+', d, 'A'); wire(c, d, 'COM', cell, '-');
  var res = C.createSim(c).solve();
  assert.ok(res.warnings.some(function (w) { return w.kind === 'short'; }));
  assert.close(res.parts[d.id].reading, 0, 1e-6, 'the V socket is not connected, so it reads 0');
});
