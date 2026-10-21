/**
 * Circuit engine for the Circuit lab and the electricity experiments.
 *
 * A Circuit is a list of parts (components on the bench) and wires (connecting leads between terminals).
 * Every part has hidden "true" values (actual resistance within tolerance, cell e.m.f. and internal resistance,
 * meter resistance, wire resistivity ...) drawn from the circuit seed + part id, so a reload rebuilds exactly
 * the same apparatus. The student only ever sees what a real component shows: its label, its dial settings and
 * what the meters indicate.
 *
 * Solver: nodal analysis (every source is a Norton equivalent, so the matrix is pure conductance), Newton–Raphson
 * for diodes / LEDs, an outer fixed-point loop for filament lamps (resistance depends on temperature, set by the
 * electrical power) and power-supply current limiting, and backward-Euler companion models for capacitors when a
 * time step is given. Each connected piece of the circuit gets its own reference node.
 *
 *   var c = VL.circuit.create('CIR-7K2Q-91C3');
 *   var cell = VL.circuit.addPart(c, 'cell', 10, 10);
 *   ...
 *   VL.circuit.addWire(c, { part: cell.id, term: '+' }, { part: r.id, term: 'a' });
 *   var sim = VL.circuit.createSim(c);
 *   var res = sim.step(0.05);           // or sim.solve() for a steady state
 *   res.parts[ammeter.id].reading       // what the meter indicates (in its own unit), before display rounding
 *
 * Units: ohm, volt, ampere, second, farad, °C; positions in cm.
 */
(function (VL) {
  'use strict';

  var VT = 0.02569;            // thermal voltage at 25 °C (V)
  var GMIN = 1e-12;            // tiny conductance from every node to its reference (keeps the matrix regular)
  var ROOM = 28;               // room temperature (°C) — a warm lab
  var OPEN_R = 1e12;

  function lvl() { return VL.noise ? VL.noise.level : 1; }
  /** nominal × (1 + tol × u × noise level), u uniform in [−1, 1] */
  function tolerance(rng, nominal, tol) { return nominal * (1 + tol * lvl() * (2 * rng.next() - 1)); }
  /** value uniform in [lo, hi]; with noise level 0 the middle of the range */
  function span(rng, lo, hi) { var u = rng.next(); return lvl() ? lo + (hi - lo) * u : (lo + hi) / 2; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ================================================================== */
  /* Component catalogue                                                 */
  /* ================================================================== */

  var E12 = [1, 2.2, 3.3, 4.7, 6.8, 10, 15, 22, 33, 47, 68, 100, 150, 220, 330, 470, 680, 1000, 2200, 4700, 10000, 22000, 47000, 100000];

  /**
   * Each type:
   *   label, group, symbol (schematic symbol name), terminals [{ id, label }], symmetric (terminals interchangeable),
   *   category (for circuit matching; defaults to the type), settings [{ key, label, type: 'choice'|'bool'|'number'|
   *   'position', choices?, min?, max?, step?, unit?, default }], hidden(rng, settings) → true values,
   *   elements(ctx) → array of solver elements, readout(ctx) → extra results.
   * ctx = { part, settings, hid, st (dynamic state), v(term) (after solve), I(name) (element current) }
   */
  var types = {};

  function define(type, def) { def.type = type; def.category = def.category || type; types[type] = def; return def; }

  function fmtOhm(r) {
    if (r >= 1e6) return (r / 1e6) + ' MΩ';
    if (r >= 1e3) return (r / 1e3) + ' kΩ';
    return r + ' Ω';
  }

  /* ---------------- sources ---------------- */

  define('cell', {
    label: 'Cell (1.5 V)', group: 'Sources', symbol: 'cell',
    terminals: [{ id: '+', label: '+' }, { id: '-', label: '−' }],
    settings: [],
    describe: 'A 1.5 V dry cell in a holder. Its e.m.f. and internal resistance are not exactly as labelled, and it runs down a little if you draw a large current for a long time.',
    hidden: function (rng) { return { emf: span(rng, 1.48, 1.62), r: span(rng, 0.3, 1.2) }; },
    elements: function (c) {
      var emf = c.hid.emf * (1 - 0.04 * Math.min(1, (c.st.fatigue || 0)));
      return [{ k: 'V', a: '+', b: '-', E: emf, r: c.hid.r, name: 'src' }];
    },
    dynamics: function (c, res, dt) {
      var I = Math.abs(res.I('src'));
      // polarisation: fatigue builds up with large currents and recovers slowly when idle
      var f = c.st.fatigue || 0;
      f += dt * (I > 0.2 ? (I * I) / 400 : -f / 120);
      c.st.fatigue = clamp(f, 0, 1);
    }
  });

  define('battery', {
    label: 'Battery (2 cells)', group: 'Sources', symbol: 'battery',
    terminals: [{ id: '+', label: '+' }, { id: '-', label: '−' }],
    settings: [],
    describe: 'Two 1.5 V cells in series in one holder.',
    hidden: function (rng) { return { emf: span(rng, 2.98, 3.22), r: span(rng, 0.6, 2.2) }; },
    elements: function (c) { return [{ k: 'V', a: '+', b: '-', E: c.hid.emf, r: c.hid.r, name: 'src' }]; }
  });

  define('psu', {
    label: 'Power supply (d.c.)', group: 'Sources', symbol: 'dcsupply',
    terminals: [{ id: '+', label: '+' }, { id: '-', label: '−' }],
    settings: [
      { key: 'setV', label: 'Voltage knob', type: 'number', min: 0, max: 12, step: 0.5, unit: 'V', default: 3 },
      { key: 'on', label: 'Switched on', type: 'bool', default: true }
    ],
    describe: 'A low-voltage d.c. supply. The knob markings are only approximate — measure the voltage you actually get. It limits its current to about 2 A.',
    hidden: function (rng) { return { gain: tolerance(rng, 1, 0.05), offset: span(rng, -0.08, 0.08), r: 0.08, Ilimit: 2.0 }; },
    elements: function (c) {
      var on = c.settings.on !== false;
      var E = on ? Math.max(0, (Number(c.settings.setV) || 0) * c.hid.gain + c.hid.offset) : 0;
      E *= (c.st.limitScale === undefined ? 1 : c.st.limitScale);
      return [{ k: 'V', a: '+', b: '-', E: E, r: on ? c.hid.r : 1e6, name: 'src' }];
    },
    limit: function (c, res) {
      // current limiting: scale the e.m.f. down until the current is at the limit
      var I = Math.abs(res.I('src')), lim = c.hid.Ilimit;
      var s = c.st.limitScale === undefined ? 1 : c.st.limitScale;
      if (I > lim * 1.001) { c.st.limitScale = s * lim / I; return true; }
      if (s < 1 && I < lim * 0.98) { c.st.limitScale = Math.min(1, s * 1.25); return true; }
      return false;
    }
  });

  /* ---------------- switches and resistors ---------------- */

  define('switch', {
    label: 'Switch', group: 'Control', symbol: 'switch', symmetric: true,
    terminals: [{ id: 'a', label: '' }, { id: 'b', label: '' }],
    settings: [{ key: 'closed', label: 'Closed', type: 'bool', default: false }],
    describe: 'A simple on/off switch. Open it between readings so components do not heat up.',
    hidden: function (rng) { return { R: span(rng, 0.005, 0.02) }; },
    elements: function (c) { return c.settings.closed ? [{ k: 'R', a: 'a', b: 'b', R: c.hid.R, name: 'sw' }] : []; }
  });

  define('resistor', {
    label: 'Fixed resistor', group: 'Resistors', symbol: 'resistor', symmetric: true,
    terminals: [{ id: 'a', label: '' }, { id: 'b', label: '' }],
    settings: [{ key: 'nominal', label: 'Labelled value', type: 'choice', choices: E12, format: fmtOhm, default: 10 }],
    describe: 'A resistor labelled with its nominal value. Its actual resistance is within ±5 % of the label.',
    hidden: function (rng, s) { return { R: tolerance(rng, Number(s.nominal) || 10, 0.05), Pmax: 0.5 }; },
    elements: function (c) { return [{ k: 'R', a: 'a', b: 'b', R: c.hid.R, name: 'R' }]; },
    readout: function (c, res) {
      var P = res.P('R');
      return { power: P, hot: P > 1.5 * c.hid.Pmax };
    }
  });

  define('unknownR', {
    label: 'Unknown resistor X', group: 'Resistors', symbol: 'resistor', category: 'resistor', symmetric: true,
    terminals: [{ id: 'a', label: '' }, { id: 'b', label: '' }],
    settings: [
      { key: 'label', label: 'Label', type: 'choice', choices: ['X', 'Y', 'Z'], default: 'X' },
      { key: 'size', label: 'Approximate size', type: 'choice', choices: ['small (2–20 Ω)', 'medium (20–200 Ω)', 'large (1–10 kΩ)'], default: 'small (2–20 Ω)' }
    ],
    describe: 'A resistor whose value you must find by experiment.',
    hidden: function (rng, s) {
      var sz = String(s.size || '');
      var lo = 2, hi = 20;
      if (/^medium/.test(sz)) { lo = 20; hi = 200; } else if (/^large/.test(sz)) { lo = 1000; hi = 10000; }
      var u = rng.next();
      return { R: lvl() ? lo * Math.pow(hi / lo, u) : Math.sqrt(lo * hi), Pmax: 0.5 };
    },
    elements: function (c) { return [{ k: 'R', a: 'a', b: 'b', R: c.hid.R, name: 'R' }]; }
  });

  define('rbox', {
    label: 'Resistance box', group: 'Resistors', symbol: 'resistor', category: 'rbox', symmetric: true,
    terminals: [{ id: 'a', label: '' }, { id: 'b', label: '' }],
    settings: [
      { key: 'x1000', label: '× 1000 Ω', type: 'number', min: 0, max: 9, step: 1, default: 0 },
      { key: 'x100', label: '× 100 Ω', type: 'number', min: 0, max: 9, step: 1, default: 0 },
      { key: 'x10', label: '× 10 Ω', type: 'number', min: 0, max: 9, step: 1, default: 1 },
      { key: 'x1', label: '× 1 Ω', type: 'number', min: 0, max: 9, step: 1, default: 0 },
      { key: 'x01', label: '× 0.1 Ω', type: 'number', min: 0, max: 9, step: 1, default: 0 }
    ],
    describe: 'A decade resistance box: the resistance is the sum of the dial settings (accurate to about 0.5 %), plus a small contact resistance.',
    hidden: function (rng) { return { gain: tolerance(rng, 1, 0.005), Rc: span(rng, 0.01, 0.04) }; },
    nominal: function (s) {
      return 1000 * (s.x1000 || 0) + 100 * (s.x100 || 0) + 10 * (s.x10 || 0) + (s.x1 || 0) + 0.1 * (s.x01 || 0);
    },
    elements: function (c) { return [{ k: 'R', a: 'a', b: 'b', R: types.rbox.nominal(c.settings) * c.hid.gain + c.hid.Rc, name: 'R' }]; }
  });

  function threeTerminal(Rt, pos) {
    var x = clamp(Number(pos), 0, 1);
    return [
      { k: 'R', a: 'A', b: 'S', R: Math.max(0.02, x * Rt), name: 'AS' },
      { k: 'R', a: 'S', b: 'B', R: Math.max(0.02, (1 - x) * Rt), name: 'SB' }
    ];
  }

  define('rheostat', {
    label: 'Variable resistor (rheostat)', group: 'Resistors', symbol: 'rheostat',
    terminals: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }, { id: 'S', label: 'slider' }],
    settings: [
      { key: 'nominal', label: 'Maximum resistance', type: 'choice', choices: [10, 22, 50, 100], format: fmtOhm, default: 22 },
      { key: 'pos', label: 'Slider position', type: 'position', min: 0, max: 1, step: 0.01, default: 0.5 }
    ],
    describe: 'A wire-wound rheostat. Use two terminals (one end and the slider) as a variable resistor, or all three as a potential divider.',
    hidden: function (rng, s) { return { Rt: tolerance(rng, Number(s.nominal) || 22, 0.05) }; },
    elements: function (c) { return threeTerminal(c.hid.Rt, c.settings.pos === undefined ? 0.5 : c.settings.pos); }
  });

  define('pot', {
    label: 'Potentiometer (rotary)', group: 'Resistors', symbol: 'pot',
    terminals: [{ id: 'A', label: '1' }, { id: 'S', label: '2' }, { id: 'B', label: '3' }],
    settings: [
      { key: 'nominal', label: 'Track resistance', type: 'choice', choices: [1000, 4700, 10000], format: fmtOhm, default: 1000 },
      { key: 'pos', label: 'Knob position', type: 'position', min: 0, max: 1, step: 0.01, default: 0.5 }
    ],
    describe: 'A rotary potentiometer: terminals 1 and 3 are the ends of the track, terminal 2 is the wiper.',
    hidden: function (rng, s) { return { Rt: tolerance(rng, Number(s.nominal) || 1000, 0.1) }; },
    elements: function (c) { return threeTerminal(c.hid.Rt, c.settings.pos === undefined ? 0.5 : c.settings.pos); }
  });

  define('wire', {
    label: 'Resistance wire on a metre rule', group: 'Resistors', symbol: 'wire',
    terminals: [{ id: 'A', label: 'A (0 cm)' }, { id: 'B', label: 'B (100 cm)' }, { id: 'J', label: 'jockey' }],
    settings: [
      { key: 'material', label: 'Wire', type: 'choice', choices: ['constantan', 'nichrome'], default: 'constantan' },
      { key: 'jockey', label: 'Jockey position', type: 'position', min: 0, max: 100, step: 0.1, unit: 'cm', default: 50 }
    ],
    describe: 'A 1.000 m resistance wire taped along a metre rule, with a jockey (crocodile clip) that you can slide along it. Read the jockey position on the rule. The wire warms up if current flows for a long time.',
    hidden: function (rng, s) {
      var nich = s.material === 'nichrome';
      var rho = nich ? tolerance(rng, 1.10e-6, 0.03) : tolerance(rng, 4.9e-7, 0.03);
      var d = span(rng, 0.25, 0.42) * 1e-3;                        // m
      return {
        rho: rho, d: d, L: 1.000,
        Rc: span(rng, 0.03, 0.15),                                // jockey contact resistance
        alpha: nich ? 4e-4 : 2e-5,                                // temperature coefficient /K
        kHeat: 60,                                                // K per W of steady heating
        tau: 15                                                   // s
      };
    },
    rPerCm: function (hid, st) {
      var A = Math.PI * hid.d * hid.d / 4;
      return hid.rho * 0.01 / A * (1 + hid.alpha * (st.dT || 0));
    },
    elements: function (c) {
      var r = types.wire.rPerCm(c.hid, c.st);
      var x = clamp(Number(c.settings.jockey === undefined ? 50 : c.settings.jockey), 0, 100);
      return [
        { k: 'R', a: 'A', b: '#P', R: Math.max(1e-4, r * x), name: 'AP' },
        { k: 'R', a: '#P', b: 'B', R: Math.max(1e-4, r * (100 - x)), name: 'PB' },
        { k: 'R', a: '#P', b: 'J', R: c.hid.Rc, name: 'J' }
      ];
    },
    dynamics: function (c, res, dt) {
      var P = res.P('AP') + res.P('PB');
      var target = c.hid.kHeat * P;
      var dT = c.st.dT || 0;
      c.st.dT = dT + (target - dT) * (1 - Math.exp(-dt / c.hid.tau));
    }
  });

  /* ---------------- meters ---------------- */

  define('ammeter', {
    label: 'Ammeter (analogue)', group: 'Meters', symbol: 'ammeter', category: 'ammeter',
    terminals: [{ id: '+', label: '+' }, { id: '-', label: '−' }],
    settings: [{ key: 'range', label: 'Range', type: 'choice', choices: ['0–1 A', '0–100 mA'], default: '0–1 A' }],
    describe: 'A moving-coil ammeter. Connect it in SERIES, with + towards the positive terminal of the supply. It has a small resistance of its own.',
    meter: 'A',
    hidden: function (rng) { return { r1: span(rng, 0.08, 0.15), r100: span(rng, 0.8, 1.5) }; },
    scale: function (s) { return /mA/.test(String(s.range)) ? { max: 100, minor: 2, unit: 'mA', factor: 1000 } : { max: 1, minor: 0.02, unit: 'A', factor: 1 }; },
    elements: function (c) {
      var r = /mA/.test(String(c.settings.range)) ? c.hid.r100 : c.hid.r1;
      return [{ k: 'R', a: '+', b: '-', R: r, name: 'm' }];
    },
    readout: function (c, res) {
      var sc = types.ammeter.scale(c.settings);
      var I = res.I('m');                               // + → −
      var reading = I * sc.factor;
      return { reading: reading, unit: sc.unit, over: reading > sc.max * 1.04, reversed: reading < -sc.max * 0.02 };
    }
  });

  define('voltmeter', {
    label: 'Voltmeter (analogue)', group: 'Meters', symbol: 'voltmeter', category: 'voltmeter',
    terminals: [{ id: '+', label: '+' }, { id: '-', label: '−' }],
    settings: [{ key: 'range', label: 'Range', type: 'choice', choices: ['0–5 V', '0–15 V'], default: '0–5 V' }],
    describe: 'A moving-coil voltmeter. Connect it in PARALLEL with the component. Its resistance (2 kΩ per volt of range) is not infinite, so it can disturb a high-resistance circuit.',
    meter: 'V',
    hidden: function (rng) { return { perVolt: tolerance(rng, 2000, 0.05) }; },
    scale: function (s) { return /15/.test(String(s.range)) ? { max: 15, minor: 0.5, unit: 'V', factor: 1 } : { max: 5, minor: 0.1, unit: 'V', factor: 1 }; },
    elements: function (c) {
      var sc = types.voltmeter.scale(c.settings);
      return [{ k: 'R', a: '+', b: '-', R: c.hid.perVolt * sc.max, name: 'm' }];
    },
    readout: function (c, res) {
      var sc = types.voltmeter.scale(c.settings);
      var V = res.v('+') - res.v('-');
      return { reading: V, unit: 'V', over: V > sc.max * 1.04, reversed: V < -sc.max * 0.02 };
    }
  });

  var DMM_RANGES = {
    V: ['200 mV', '2 V', '20 V', '200 V'],
    A: ['2 mA', '20 mA', '200 mA', '20 A'],
    'Ω': ['200 Ω', '2 kΩ', '20 kΩ', '200 kΩ']
  };
  var DMM_SHUNT = { '2 mA': 100, '20 mA': 10, '200 mA': 1 };
  var DMM_OHM = { '200 Ω': { E: 0.4, R: 400 }, '2 kΩ': { E: 0.4, R: 4000 }, '20 kΩ': { E: 0.4, R: 40000 }, '200 kΩ': { E: 0.4, R: 400000 } };
  function rangeMax(name) {
    var m = /^([\d.]+)\s*(m|k)?/.exec(String(name));
    var v = m ? parseFloat(m[1]) : 1;
    return m && m[2] === 'm' ? v / 1000 : m && m[2] === 'k' ? v * 1000 : v;
  }

  define('dmm', {
    label: 'Digital multimeter', group: 'Meters', symbol: 'dmm', category: 'dmm',
    terminals: [{ id: 'COM', label: 'COM' }, { id: 'V', label: 'VΩmA' }, { id: 'A', label: '20A' }],
    settings: [
      { key: 'mode', label: 'Dial', type: 'choice', choices: ['V', 'A', 'Ω', 'off'], default: 'V' },
      { key: 'range', label: 'Range', type: 'choice', choices: DMM_RANGES.V.concat(DMM_RANGES.A, DMM_RANGES['Ω']), default: '20 V' }
    ],
    describe: 'A digital multimeter with three sockets. Voltage, resistance and the mA current ranges use VΩmA and COM (the mA ranges are protected by a 250 mA fuse). The 20 A range uses the 20A socket, which is always joined to COM through a very small resistance — so a lead left in 20A acts as a short circuit! Measure resistance only with the component disconnected from any supply.',
    hidden: function (rng) { return { gain: tolerance(rng, 1, 0.004), Rin: 1e7, Rhi: span(rng, 0.008, 0.015) }; },
    validRange: function (s) {
      var list = DMM_RANGES[s.mode] || [];
      return list.indexOf(s.range) !== -1 ? s.range : list[1] || list[0] || '';
    },
    /** The socket that carries the measured quantity (besides COM). */
    socket: function (s) {
      var r = types.dmm.validRange(s);
      return s.mode === 'A' && !/mA/.test(r) ? 'A' : 'V';
    },
    elements: function (c) {
      var s = c.settings, range = types.dmm.validRange(s);
      var mA = s.mode === 'A' && /mA/.test(range);
      var els = [{ k: 'R', a: 'A', b: 'COM', R: c.hid.Rhi, name: 'hi' }];
      if (s.mode === 'Ω') {
        var o = DMM_OHM[range] || DMM_OHM['2 kΩ'];
        els.push({ k: 'V', a: 'V', b: 'COM', E: o.E, r: o.R, name: 'ohm' });
      } else if (mA) {
        els.push({ k: 'R', a: 'V', b: 'COM', R: c.st.blown ? OPEN_R : DMM_SHUNT[range], name: 'shunt' });
      } else {
        els.push({ k: 'R', a: 'V', b: 'COM', R: c.hid.Rin, name: 'vin' });
      }
      return els;
    },
    readout: function (c, res) {
      var s = c.settings, range = types.dmm.validRange(s);
      var out = { mode: s.mode, range: range, unit: '', reading: 0, over: false, reversed: false, blown: !!c.st.blown };
      if (s.mode === 'off') return out;
      if (s.mode === 'V') {
        out.reading = (res.v('V') - res.v('COM')) * c.hid.gain;
        out.unit = 'V';
        out.over = Math.abs(out.reading) > rangeMax(range) * 0.9995;
      } else if (s.mode === 'A') {
        var mA = /mA/.test(range);
        out.reading = (mA ? (c.st.blown ? 0 : res.I('shunt')) : res.I('hi')) * c.hid.gain;   // into the socket, out of COM
        out.unit = 'A';
        out.over = Math.abs(out.reading) > rangeMax(range) * 0.9995;
      } else {
        var o = DMM_OHM[range] || DMM_OHM['2 kΩ'];
        var Vx = res.v('V') - res.v('COM');
        var I = res.I('ohm');                                    // current leaving the VΩ socket into the circuit
        var R = I > 1e-15 ? Vx / I : Infinity;
        out.unit = 'Ω';
        out.reading = R * c.hid.gain;
        out.over = !(R < rangeMax(range) * 0.9995) || R < 0;
        out.disturbed = Math.abs(Vx) > o.E * 1.01 || R < -0.5;   // an external supply is upsetting the reading
      }
      return out;
    },
    dynamics: function (c, res) {
      var s = c.settings;
      if (s.mode === 'A' && /mA/.test(types.dmm.validRange(s)) && !c.st.blown && Math.abs(res.I('shunt')) > 0.25) {
        c.st.blown = true;
        return 'fuse';
      }
      return null;
    }
  });

  /* ---------------- non-ohmic and sensing components ---------------- */

  var LAMPS = {
    '2.5 V 0.3 A': { V: 2.5, I: 0.3 },
    '6 V 0.06 A': { V: 6, I: 0.06 },
    '12 V 0.1 A': { V: 12, I: 0.1 }
  };

  define('lamp', {
    label: 'Filament lamp', group: 'Non-ohmic', symbol: 'lamp', symmetric: true,
    terminals: [{ id: 'a', label: '' }, { id: 'b', label: '' }],
    settings: [{ key: 'rating', label: 'Rating', type: 'choice', choices: Object.keys(LAMPS), default: '2.5 V 0.3 A' }],
    describe: 'A small filament lamp. Its resistance rises a lot as the filament heats up, so it is not ohmic. Too much current blows it.',
    hidden: function (rng, s) {
      var r = LAMPS[s.rating] || LAMPS['2.5 V 0.3 A'];
      var Rhot = tolerance(rng, r.V / r.I, 0.06);
      var Thot = 2700, T0 = ROOM + 273.15;
      var R0 = Rhot / Math.pow(Thot / T0, 1.2);                   // tungsten: R ∝ T^1.2
      var P = r.V * r.V / Rhot;
      return { R0: R0, T0: T0, K: P / (Math.pow(Thot, 4) - Math.pow(T0, 4)), Prated: r.V * r.I, Vr: r.V };
    },
    resistanceAt: function (hid, P) {
      var T = Math.pow(Math.max(0, P) / hid.K + Math.pow(hid.T0, 4), 0.25);
      return { R: hid.R0 * Math.pow(T / hid.T0, 1.2), T: T };
    },
    elements: function (c) {
      if (c.st.blown) return [];
      var P = c.st.P || 0;
      return [{ k: 'R', a: 'a', b: 'b', R: types.lamp.resistanceAt(c.hid, P).R, name: 'f' }];
    },
    iterate: function (c, res) {
      // filament temperature from the electrical power (outer fixed-point loop)
      if (c.st.blown) return false;
      var P = res.P('f'), old = c.st.P || 0;
      var next = old + 0.6 * (P - old);
      c.st.P = next;
      return Math.abs(next - old) > 1e-7 + 1e-5 * Math.abs(next);
    },
    readout: function (c, res) {
      var P = c.st.blown ? 0 : res.P('f');
      return { power: P, brightness: c.st.blown ? 0 : clamp(Math.pow(P / c.hid.Prated, 1.6), 0, 1.5), blown: !!c.st.blown };
    },
    dynamics: function (c, res) {
      if (!c.st.blown && res.P('f') > 2.6 * c.hid.Prated) { c.st.blown = true; c.st.P = 0; return 'blown'; }
      return null;
    }
  });

  define('diode', {
    label: 'Diode', group: 'Non-ohmic', symbol: 'diode',
    terminals: [{ id: 'A', label: 'anode' }, { id: 'K', label: 'cathode' }],
    settings: [],
    describe: 'A silicon diode. It conducts only when the anode is about 0.6–0.7 V more positive than the cathode (the end with the band). Always use a protective resistor.',
    hidden: function (rng) { return { Is: tolerance(rng, 2e-9, 0.4), n: span(rng, 1.8, 2.0), Rs: span(rng, 0.1, 0.3) }; },
    elements: function (c) {
      return [
        { k: 'D', a: 'A', b: '#m', Is: c.hid.Is, n: c.hid.n, name: 'd' },
        { k: 'R', a: '#m', b: 'K', R: c.hid.Rs, name: 'rs' }
      ];
    },
    readout: function (c, res) { return { current: res.I('rs') }; }
  });

  define('led', {
    label: 'LED (red)', group: 'Non-ohmic', symbol: 'led',
    terminals: [{ id: 'A', label: 'anode (+, long leg)' }, { id: 'K', label: 'cathode (−)' }],
    settings: [],
    describe: 'A red light-emitting diode. It lights when it conducts (about 1.8–2 V). More than about 40 mA destroys it — use a protective resistor.',
    hidden: function (rng) { return { Is: tolerance(rng, 1e-18, 0.5), n: span(rng, 1.9, 2.1), Rs: span(rng, 2, 5) }; },
    elements: function (c) {
      if (c.st.blown) return [];
      return [
        { k: 'D', a: 'A', b: '#m', Is: c.hid.Is, n: c.hid.n, name: 'd' },
        { k: 'R', a: '#m', b: 'K', R: c.hid.Rs, name: 'rs' }
      ];
    },
    readout: function (c, res) {
      var I = c.st.blown ? 0 : res.I('rs');
      return { current: I, brightness: clamp(I / 0.02, 0, 1.5), blown: !!c.st.blown };
    },
    dynamics: function (c, res) {
      if (!c.st.blown && res.I('rs') > 0.045) { c.st.blown = true; return 'blown'; }
      return null;
    }
  });

  define('thermistor', {
    label: 'Thermistor (NTC) in water', group: 'Sensors', symbol: 'thermistor', symmetric: true,
    terminals: [{ id: 'a', label: '' }, { id: 'b', label: '' }],
    settings: [{ key: 'heater', label: 'Water', type: 'choice', choices: ['room temperature', 'warm', 'hot', 'ice added'], default: 'room temperature' }],
    describe: 'An NTC thermistor in a beaker of water with a thermometer. Its resistance falls as the temperature rises. Heat or cool the water and wait for the thermometer to settle.',
    hidden: function (rng) { return { R25: tolerance(rng, 4700, 0.1), B: span(rng, 3500, 4100), tau: 25 }; },
    targetTemp: function (s) { return ({ 'room temperature': ROOM, warm: 55, hot: 82, 'ice added': 3 })[s.heater] || ROOM; },
    resistance: function (hid, T) { return hid.R25 * Math.exp(hid.B * (1 / (T + 273.15) - 1 / 298.15)); },
    elements: function (c) {
      var T = c.st.T === undefined ? ROOM : c.st.T;
      return [{ k: 'R', a: 'a', b: 'b', R: types.thermistor.resistance(c.hid, T), name: 'R' }];
    },
    dynamics: function (c, res, dt) {
      var T = c.st.T === undefined ? ROOM : c.st.T;
      var target = types.thermistor.targetTemp(c.settings);
      c.st.T = T + (target - T) * (1 - Math.exp(-dt / c.hid.tau));
    },
    readout: function (c) { return { waterT: c.st.T === undefined ? ROOM : c.st.T }; }
  });

  define('ldr', {
    label: 'LDR with lamp on a track', group: 'Sensors', symbol: 'ldr', symmetric: true,
    terminals: [{ id: 'a', label: '' }, { id: 'b', label: '' }],
    settings: [{ key: 'distance', label: 'Lamp distance', type: 'position', min: 5, max: 50, step: 0.1, unit: 'cm', default: 20 }],
    describe: 'A light-dependent resistor facing a small lamp that slides along a scale. The resistance falls as the light gets brighter (lamp closer).',
    hidden: function (rng) { return { R10: span(rng, 400, 1500), gamma: span(rng, 0.65, 0.8), Rdark: 1e6 }; },
    resistance: function (hid, d) {
      var R = hid.R10 * Math.pow(Math.max(1, d) / 10, 2 * hid.gamma);
      return 1 / (1 / R + 1 / hid.Rdark) + 0;
    },
    elements: function (c) {
      var d = c.settings.distance === undefined ? 20 : Number(c.settings.distance);
      return [{ k: 'R', a: 'a', b: 'b', R: Math.min(types.ldr.resistance(c.hid, d), 1e6), name: 'R' }];
    }
  });

  define('capacitor', {
    label: 'Capacitor (electrolytic)', group: 'Capacitors', symbol: 'capacitor',
    terminals: [{ id: '+', label: '+' }, { id: '-', label: '−' }],
    settings: [{ key: 'nominal', label: 'Labelled value', type: 'choice', choices: [100, 470, 1000, 2200], format: function (v) { return v + ' µF'; }, default: 1000 }],
    describe: 'An electrolytic capacitor (A Level). Connect + to the more positive side. With a large resistor in series you can time it charging and discharging.',
    hidden: function (rng, s) { return { C: tolerance(rng, (Number(s.nominal) || 1000) * 1e-6, 0.2), Rleak: 2e7 }; },
    elements: function (c) {
      return [
        { k: 'C', a: '+', b: '-', C: c.hid.C, V0: c.st.Vc || 0, name: 'c' },
        { k: 'R', a: '+', b: '-', R: c.hid.Rleak, name: 'leak' }
      ];
    },
    dynamics: function (c, res) { c.st.Vc = res.v('+') - res.v('-'); return null; },
    readout: function (c) { return { Vc: c.st.Vc || 0, reversed: (c.st.Vc || 0) < -1 }; }
  });

  /* ================================================================== */
  /* Circuit model                                                       */
  /* ================================================================== */

  function create(seed) {
    return { seed: String(seed || 'CIR-0000-0000'), parts: [], wires: [], nextId: 1 };
  }

  function defaultSettings(type) {
    var s = {};
    (types[type].settings || []).forEach(function (spec) { s[spec.key] = spec.default; });
    return s;
  }

  function addPart(c, type, x, y, settings) {
    if (!types[type]) throw new Error('Unknown component type ' + type);
    var p = { id: 'p' + (c.nextId++), type: type, x: x || 0, y: y || 0, rot: 0, settings: defaultSettings(type) };
    Object.keys(settings || {}).forEach(function (k) { p.settings[k] = settings[k]; });
    c.parts.push(p);
    return p;
  }

  function getPart(c, id) {
    for (var i = 0; i < c.parts.length; i++) if (c.parts[i].id === id) return c.parts[i];
    return null;
  }

  function removePart(c, id) {
    c.parts = c.parts.filter(function (p) { return p.id !== id; });
    c.wires = c.wires.filter(function (w) { return w.a.part !== id && w.b.part !== id; });
  }

  function sameEnd(x, y) { return x.part === y.part && x.term === y.term; }

  /**
   * Connect two terminals with a lead. Returns the wire, or null if it would join a terminal to itself or
   * duplicate an existing lead.
   */
  function addWire(c, a, b, color) {
    if (!a || !b || sameEnd(a, b)) return null;
    var pa = getPart(c, a.part), pb = getPart(c, b.part);
    if (!pa || !pb) return null;
    if (!termExists(pa, a.term) || !termExists(pb, b.term)) return null;
    for (var i = 0; i < c.wires.length; i++) {
      var w = c.wires[i];
      if ((sameEnd(w.a, a) && sameEnd(w.b, b)) || (sameEnd(w.a, b) && sameEnd(w.b, a))) return null;
    }
    var wire = { id: 'w' + (c.nextId++), a: { part: a.part, term: a.term }, b: { part: b.part, term: b.term }, color: color || 'red' };
    c.wires.push(wire);
    return wire;
  }

  function termExists(part, term) {
    return types[part.type].terminals.some(function (t) { return t.id === term; });
  }

  function removeWire(c, id) { c.wires = c.wires.filter(function (w) { return w.id !== id; }); }

  /** Hidden true values of a part (deterministic from circuit seed + part id + its value-defining settings). */
  function hidden(c, part) {
    var t = types[part.type];
    if (part.truth) return part.truth;
    var keyBits = (t.settings || []).filter(function (s) { return s.type === 'choice' && s.key !== 'range' && s.key !== 'mode' && s.key !== 'heater'; })
      .map(function (s) { return s.key + '=' + part.settings[s.key]; }).join(';');
    var rng = VL.rng.create(c.seed + '/' + part.id + '/' + part.type + '/' + keyBits);
    return t.hidden ? t.hidden(rng, part.settings || {}) : {};
  }

  /* ================================================================== */
  /* Netlist and solver                                                  */
  /* ================================================================== */

  function UnionFind() { this.p = {}; }
  UnionFind.prototype.find = function (x) {
    if (this.p[x] === undefined) this.p[x] = x;
    while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; }
    return x;
  };
  UnionFind.prototype.union = function (a, b) { var ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb; };

  /** Node key of a part terminal (or internal node '#x'). */
  function tkey(partId, term) { return partId + ':' + term; }

  /**
   * Group terminals into electrical nodes (terminals joined by leads).
   * @returns {{ nodeOf: function(partId, term): string, nets: Object<string, string[]> }}
   */
  function nets(c) {
    var uf = new UnionFind();
    c.parts.forEach(function (p) { types[p.type].terminals.forEach(function (t) { uf.find(tkey(p.id, t.id)); }); });
    c.wires.forEach(function (w) { uf.union(tkey(w.a.part, w.a.term), tkey(w.b.part, w.b.term)); });
    var groups = {};
    c.parts.forEach(function (p) {
      types[p.type].terminals.forEach(function (t) {
        var k = tkey(p.id, t.id), r = uf.find(k);
        (groups[r] = groups[r] || []).push(k);
      });
    });
    return { nodeOf: function (pid, term) { return uf.find(tkey(pid, term)); }, nets: groups };
  }

  /** Solve A x = b by Gaussian elimination with partial pivoting (A is modified). */
  function gauss(A, b) {
    var n = b.length;
    for (var col = 0; col < n; col++) {
      var piv = col, best = Math.abs(A[col][col]);
      for (var r = col + 1; r < n; r++) { var v = Math.abs(A[r][col]); if (v > best) { best = v; piv = r; } }
      if (best < 1e-300) return null;
      if (piv !== col) { var t = A[piv]; A[piv] = A[col]; A[col] = t; var tb = b[piv]; b[piv] = b[col]; b[col] = tb; }
      for (var r2 = col + 1; r2 < n; r2++) {
        var f = A[r2][col] / A[col][col];
        if (!f) continue;
        for (var k = col; k < n; k++) A[r2][k] -= f * A[col][k];
        b[r2] -= f * b[col];
      }
    }
    var x = new Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var s = b[i];
      for (var j = i + 1; j < n; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  }

  function diodeIV(el, V) {
    var nVt = el.n * VT;
    var Vc = Math.min(V, 40 * nVt + 0.0);                 // avoid overflow; linear beyond
    var e = Math.exp(Vc / nVt);
    var I = el.Is * (e - 1), G = el.Is * e / nVt;
    if (V > Vc) I += G * (V - Vc);
    return { I: I, G: G + 1e-12 };
  }

  /**
   * Create a simulator for a circuit. The simulator keeps dynamic state (heating, capacitor voltages, blown
   * fuses, battery fatigue) between steps; the circuit object itself only holds what the student built.
   */
  function createSim(c, savedState) {
    var state = savedState && typeof savedState === 'object' ? JSON.parse(JSON.stringify(savedState)) : {};
    var hidCache = {};

    function hid(p) {
      var key = p.id + '|' + JSON.stringify(p.settings) + '|' + p.type;
      if (!hidCache[key]) hidCache[key] = hidden(c, p);
      return hidCache[key];
    }
    function st(p) { return (state[p.id] = state[p.id] || {}); }
    function ctxFor(p) { return { part: p, settings: p.settings || {}, hid: hid(p), st: st(p) }; }

    /** Solve once. dt > 0 → capacitors use their companion model, otherwise they are open circuit. */
    function solveOnce(dt) {
      var net = nets(c);
      var nodeIndex = {}, nodeList = [];
      function idx(key) {
        if (nodeIndex[key] === undefined) { nodeIndex[key] = nodeList.length; nodeList.push(key); }
        return nodeIndex[key];
      }
      // expand parts into elements
      var els = [];
      c.parts.forEach(function (p) {
        var t = types[p.type], cx = ctxFor(p);
        var list = t.elements ? t.elements(cx) : [];
        list.forEach(function (e) {
          var el = Object.assign({}, e);
          el.part = p.id;
          if (el.k === 'R') el.R = Math.max(1e-6, el.R);
          if (el.k === 'V') el.r = Math.max(1e-6, el.r);
          el.na = idx(e.a.charAt(0) === '#' ? p.id + ':' + e.a : net.nodeOf(p.id, e.a));
          el.nb = idx(e.b.charAt(0) === '#' ? p.id + ':' + e.b : net.nodeOf(p.id, e.b));
          els.push(el);
        });
      });
      // also give every terminal a node (so unconnected terminals have a voltage)
      c.parts.forEach(function (p) { types[p.type].terminals.forEach(function (t) { idx(net.nodeOf(p.id, t.id)); }); });

      var n = nodeList.length;
      // connected components → one reference node each
      var comp = new UnionFind();
      for (var i = 0; i < n; i++) comp.find(i);
      els.forEach(function (e) { comp.union(e.na, e.nb); });
      var isRef = new Array(n).fill(false), seen = {};
      for (var j = 0; j < n; j++) { var r = comp.find(j); if (!seen[r]) { seen[r] = true; isRef[j] = true; } }
      var map = new Array(n), m = 0;
      for (var q = 0; q < n; q++) map[q] = isRef[q] ? -1 : m++;

      var v = new Array(n).fill(0);
      var diodes = els.filter(function (e) { return e.k === 'D'; });
      var iter = 0, converged = false;
      for (iter = 0; iter < 300; iter++) {
        var A = [], b = new Array(m).fill(0);
        for (var a0 = 0; a0 < m; a0++) { A.push(new Array(m).fill(0)); A[a0][a0] = GMIN; }
        var stampG = function (na, nb, g) {
          var ia = map[na], ib = map[nb];
          if (ia >= 0) A[ia][ia] += g;
          if (ib >= 0) A[ib][ib] += g;
          if (ia >= 0 && ib >= 0) { A[ia][ib] -= g; A[ib][ia] -= g; }
        };
        var stampI = function (na, nb, i) {          // current i flows from na through the element to nb
          var ia = map[na], ib = map[nb];
          if (ia >= 0) b[ia] -= i;
          if (ib >= 0) b[ib] += i;
        };
        els.forEach(function (e) {
          if (e.k === 'R') stampG(e.na, e.nb, 1 / e.R);
          else if (e.k === 'V') { stampG(e.na, e.nb, 1 / e.r); stampI(e.nb, e.na, e.E / e.r); }
          else if (e.k === 'C') {
            if (dt > 0) { var gc = e.C / dt; stampG(e.na, e.nb, gc); stampI(e.nb, e.na, gc * e.V0); }
          } else if (e.k === 'D') {
            var Vd = v[e.na] - v[e.nb], d = diodeIV(e, Vd);
            stampG(e.na, e.nb, d.G);
            stampI(e.na, e.nb, d.I - d.G * Vd);
          }
        });
        var x = m ? gauss(A, b) : [];
        if (!x) break;
        var nv = new Array(n);
        for (var z = 0; z < n; z++) nv[z] = map[z] >= 0 ? x[map[z]] : 0;
        // diode voltage limiting (damped Newton)
        var maxDelta = 0;
        diodes.forEach(function (e) {
          var oldV = v[e.na] - v[e.nb], newV = nv[e.na] - nv[e.nb];
          var lim = 2 * e.n * VT;
          if (newV - oldV > lim && newV > 0.3) {
            var scale = lim / (newV - oldV);
            for (var w = 0; w < n; w++) nv[w] = v[w] + (nv[w] - v[w]) * scale;
          }
        });
        for (var y = 0; y < n; y++) maxDelta = Math.max(maxDelta, Math.abs(nv[y] - v[y]));
        v = nv;
        if (!diodes.length || maxDelta < 1e-10) { converged = true; break; }
      }

      function elCurrent(e) {
        var V = v[e.na] - v[e.nb];
        if (e.k === 'R') return V / e.R;
        if (e.k === 'V') return (e.E - V) / e.r;              // current leaving + terminal through the external circuit... see below
        if (e.k === 'C') return dt > 0 ? e.C / dt * (V - e.V0) : 0;
        if (e.k === 'D') return diodeIV(e, V).I;
        return 0;
      }
      return { net: net, v: v, els: els, nodeIndex: nodeIndex, elCurrent: elCurrent, converged: converged || !diodes.length, iterations: iter };
    }

    function partResult(sol, p) {
      var mine = sol.els.filter(function (e) { return e.part === p.id; });
      function find(name) { for (var i = 0; i < mine.length; i++) if (mine[i].name === name) return mine[i]; return null; }
      var api = {
        v: function (term) {
          var key = term.charAt(0) === '#' ? p.id + ':' + term : sol.net.nodeOf(p.id, term);
          var i = sol.nodeIndex[key];
          return i === undefined ? 0 : sol.v[i];
        },
        /** Element current: R/D/C from a to b; source 'V' elements: current delivered out of + (b → a inside). */
        I: function (name) { var e = find(name); return e ? sol.elCurrent(e) : 0; },
        P: function (name) {
          var e = find(name);
          if (!e) return 0;
          var V = sol.v[e.na] - sol.v[e.nb], I = sol.elCurrent(e);
          return e.k === 'V' ? I * I * e.r : Math.abs(V * I);
        }
      };
      return api;
    }

    /**
     * Solve the circuit (outer loop for lamps and current limits) and, if dt > 0, advance dynamic state.
     * @returns {{ ok, converged, parts: Object<string, object>, warnings: string[], events: object[] }}
     */
    function run(dt) {
      var sol = null, guard = 0, changed = true;
      while (changed && guard++ < 80) {
        sol = solveOnce(dt);
        changed = false;
        for (var i = 0; i < c.parts.length; i++) {
          var p = c.parts[i], t = types[p.type];
          if (t.iterate && t.iterate(ctxFor(p), partResult(sol, p))) changed = true;
          if (t.limit && t.limit(ctxFor(p), partResult(sol, p))) changed = true;
        }
      }
      var out = { ok: true, converged: sol.converged && !changed, parts: {}, warnings: [], events: [] };
      c.parts.forEach(function (p) {
        var t = types[p.type], api = partResult(sol, p), cx = ctxFor(p);
        var r = t.readout ? t.readout(cx, api) : {};
        r.terminalV = {};
        t.terminals.forEach(function (term) { r.terminalV[term.id] = api.v(term.id); });
        if (p.type === 'cell' || p.type === 'battery' || p.type === 'psu') {
          r.current = api.I('src');
          r.terminalPd = api.v('+') - api.v('-');
          if (p.type !== 'psu' && Math.abs(r.current) > 0.8 * cx.hid.emf / cx.hid.r) {
            out.warnings.push({ part: p.id, kind: 'short', text: types[p.type].label + ' is short-circuited — it is getting hot. Open the switch and add resistance.' });
          }
          if (p.type === 'psu' && cx.st.limitScale !== undefined && cx.st.limitScale < 0.999) {
            out.warnings.push({ part: p.id, kind: 'limit', text: 'The power supply is overloaded and limiting its current. Check for a short circuit.' });
          }
        }
        if (r.over) out.warnings.push({ part: p.id, kind: 'over', text: t.label + ': reading beyond full scale — use a higher range.' });
        if (r.reversed) out.warnings.push({ part: p.id, kind: 'reversed', text: t.label + ': connected the wrong way round — the reading is negative.' });
        if (r.hot) out.warnings.push({ part: p.id, kind: 'hot', text: t.label + ' is getting very hot (too much power).' });
        if (r.disturbed) out.warnings.push({ part: p.id, kind: 'ohm', text: 'The multimeter cannot measure resistance while the component is connected to a supply.' });
        out.parts[p.id] = r;
      });
      if (dt > 0) {
        c.parts.forEach(function (p) {
          var t = types[p.type];
          if (t.dynamics) {
            var ev = t.dynamics(ctxFor(p), partResult(sol, p), dt);
            if (ev) out.events.push({ part: p.id, kind: ev });
          }
        });
      }
      // blown fuses / components stay broken (and warned about) until the student replaces them
      c.parts.forEach(function (p) {
        if (!state[p.id] || !state[p.id].blown) return;
        var label = types[p.type].label;
        if (p.type === 'dmm') out.warnings.push({ part: p.id, kind: 'fuse', text: label + ': the fuse has blown (too much current). Fix the circuit, then replace the fuse.' });
        else out.warnings.push({ part: p.id, kind: 'blown', text: label + ' has burnt out (too much current). Add a protective resistor, then replace it.' });
      });
      return out;
    }

    return {
      state: state,
      solve: function () { return run(0); },
      step: function (dt) { return run(Math.max(1e-4, Math.min(dt, 0.25))); },
      hidden: function (p) { return hid(p); },
      /** Replace a blown fuse / lamp / LED. */
      repair: function (partId) { var s = state[partId]; if (s) { s.blown = false; s.P = 0; } },
      getState: function () { return JSON.parse(JSON.stringify(state)); }
    };
  }

  /* ================================================================== */
  /* Circuit matching (did the student build the circuit in the diagram?) */
  /* ================================================================== */

  /**
   * Compare a built circuit with a template.
   * template = { parts: [{ ref: 'cell', category: 'cell' }, ...], nets: [['cell:+', 'sw:a'], ...] }
   *   Template terminals are 'ref:term'. Categories match types[*].category; 'ammeter' also accepts a
   *   multimeter used through its A/COM sockets and 'voltmeter' one used through VΩ/COM.
   * @returns {{ ok, problems: string[], reversed: string[], extra: string[], missing: string[] }}
   */
  function matchTemplate(c, template) {
    var res = { ok: false, problems: [], reversed: [], extra: [], missing: [] };
    var net = nets(c);
    // candidate user parts per template part
    function candidates(tp) {
      return c.parts.filter(function (p) {
        var t = types[p.type];
        if (t.category === tp.category) return true;
        if (p.type === 'dmm' && (tp.category === 'ammeter' || tp.category === 'voltmeter')) return true;
        return false;
      });
    }
    // terminal name mapping for a template part onto a user part
    function termOptions(tp, p) {
      var t = types[p.type];
      if (p.type === 'dmm') {
        var socks = tp.category === 'ammeter' ? ['V', 'A'] : ['V'];
        if (tp.category === 'ammeter' || tp.category === 'voltmeter') {
          var o = [];
          socks.forEach(function (sk) { o.push({ '+': sk, '-': 'COM' }); o.push({ '+': 'COM', '-': sk, __reversed: true }); });
          return o;
        }
      }
      var ids = t.terminals.map(function (x) { return x.id; });
      var ident = {};
      ids.forEach(function (id) { ident[id] = id; });
      var opts = [ident];
      if (t.symmetric && ids.length === 2) { var sw = {}; sw[ids[0]] = ids[1]; sw[ids[1]] = ids[0]; opts.push(sw); }
      if ((p.type === 'rheostat' || p.type === 'pot' || p.type === 'wire')) { var swp = Object.assign({}, ident); swp.A = 'B'; swp.B = 'A'; opts.push(swp); }
      if (tp.polar) { var rev = {}; rev[ids[0]] = ids[1]; rev[ids[1]] = ids[0]; opts.push(Object.assign(rev, { __reversed: true })); }
      return opts;
    }
    var tParts = template.parts;
    // node id for every template terminal mentioned in nets
    var tNode = {};
    template.nets.forEach(function (group, gi) { group.forEach(function (term) { tNode[term] = gi; }); });

    var best = null;
    function check(assign) {
      // template net gi ↔ user node: must be a bijection over the mentioned terminals
      var g2u = {}, u2g = {}, reversed = [];
      for (var i = 0; i < tParts.length; i++) {
        var a = assign[i];
        if (a.map.__reversed) reversed.push(tParts[i].ref);
      }
      var terms = Object.keys(tNode);
      for (var k = 0; k < terms.length; k++) {
        var tt = terms[k], ref = tt.split(':')[0], term = tt.split(':')[1];
        var pi = -1;
        for (var q = 0; q < tParts.length; q++) if (tParts[q].ref === ref) { pi = q; break; }
        if (pi < 0) continue;
        var a2 = assign[pi], uterm = a2.map[term];
        if (!uterm) return null;
        var un = net.nodeOf(a2.part.id, uterm), gi = tNode[tt];
        if (g2u[gi] === undefined) g2u[gi] = un; else if (g2u[gi] !== un) return null;
        if (u2g[un] === undefined) u2g[un] = gi; else if (u2g[un] !== gi) return null;
      }
      return { reversed: reversed };
    }
    function search(i, used, assign) {
      if (best && !best.reversed.length) return;
      if (i === tParts.length) {
        var r = check(assign);
        if (r && (!best || r.reversed.length < best.reversed.length)) best = { reversed: r.reversed, assign: assign.slice() };
        return;
      }
      var cands = candidates(tParts[i]);
      for (var ci = 0; ci < cands.length; ci++) {
        var p = cands[ci];
        if (used[p.id]) continue;
        var opts = termOptions(tParts[i], p);
        for (var oi = 0; oi < opts.length; oi++) {
          used[p.id] = true;
          assign.push({ part: p, map: opts[oi] });
          search(i + 1, used, assign);
          assign.pop();
          used[p.id] = false;
        }
      }
    }
    // quick count check
    var missing = [];
    tParts.forEach(function (tp) {
      var need = tParts.filter(function (x) { return x.category === tp.category; }).length;
      if (candidates(tp).length < need && missing.indexOf(tp.label || tp.category) === -1) missing.push(tp.label || tp.category);
    });
    if (missing.length) {
      res.missing = missing;
      res.problems.push('Missing component(s): ' + missing.join(', ') + '.');
      return res;
    }
    search(0, {}, []);
    if (!best) {
      res.problems.push('The connections do not match the circuit diagram yet. Trace each loop of the diagram and check every lead.');
      return res;
    }
    var usedIds = {};
    best.assign.forEach(function (a) { usedIds[a.part.id] = true; });
    c.parts.forEach(function (p) {
      if (usedIds[p.id]) return;
      var connected = c.wires.some(function (w) { return w.a.part === p.id || w.b.part === p.id; });
      if (connected) res.extra.push(types[p.type].label);
    });
    res.reversed = best.reversed;
    if (res.extra.length) res.problems.push('Extra component(s) connected that are not in the diagram: ' + res.extra.join(', ') + '.');
    if (res.reversed.length) res.problems.push('Connected the wrong way round: ' + res.reversed.join(', ') + ' (check + and −).');
    res.ok = !res.problems.length;
    return res;
  }

  VL.circuit = {
    types: types,
    define: define,
    E12: E12,
    ROOM: ROOM,
    DMM_RANGES: DMM_RANGES,
    LAMPS: LAMPS,
    create: create,
    addPart: addPart,
    getPart: getPart,
    removePart: removePart,
    addWire: addWire,
    removeWire: removeWire,
    hidden: hidden,
    nets: nets,
    createSim: createSim,
    matchTemplate: matchTemplate,
    defaultSettings: defaultSettings,
    rangeMax: rangeMax,
    fmtOhm: fmtOhm,
    _gauss: gauss
  };
})(globalThis.VLab = globalThis.VLab || {});
