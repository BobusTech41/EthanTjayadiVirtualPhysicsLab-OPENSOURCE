/**
 * Circuit lab templates: the electricity set-ups that appear in Paper 3 style practicals.
 *
 * Each template gives the student a KIT of components on the bench (unwired) and a circuit DIAGRAM to build.
 * The student wires it themselves; "Check my circuit" compares their wiring with `match` (VL.circuit.matchTemplate).
 *
 *   { id, title, level: 'AS'|'A Level', aim, steps: [html], investigate: [html],
 *     kit: [{ ref, type, x, y, settings? }],              // bench positions in cm
 *     match: { parts: [{ ref, category, polar? , label }], nets: [['ref:term', ...], ...] },
 *     solution: [['ref:term', 'ref:term'], ...],          // one correct set of leads (used by tests and "show me")
 *     diagram: { w, h, items: [...], wires: [[x, y], ...][], dots: [[x, y]] }   // see ui/circuitSymbols.js
 *   }
 * Diagram units: 1 = one grid step; symbols run between their two end points (p, q).
 */
(function (VL) {
  'use strict';

  var T = [];

  function add(t) { T.push(t); return t; }

  /* ---------------------------------------------------------------- 1. resistance of a resistor */
  add({
    id: 'ohm', title: 'Resistance of a resistor (V against I)', level: 'AS',
    aim: 'Find the resistance of the resistor labelled X by measuring the current in it and the potential difference across it.',
    steps: [
      'Build the circuit in the diagram. Keep the switch open while you connect it.',
      'Close the switch, read the ammeter and the voltmeter, then open the switch again.',
      'Change the current with the variable resistor and repeat.'
    ],
    investigate: ['Plot V on the y-axis against I on the x-axis. The gradient is the resistance of X.'],
    kit: [
      { ref: 'E', type: 'battery', x: 14, y: 16 },
      { ref: 'S', type: 'switch', x: 44, y: 14 },
      { ref: 'Rh', type: 'rheostat', x: 76, y: 14, settings: { nominal: 22, pos: 0.5 } },
      { ref: 'A', type: 'ammeter', x: 104, y: 22, settings: { range: '0–1 A' } },
      { ref: 'X', type: 'unknownR', x: 60, y: 52, settings: { label: 'X', size: 'small (2–20 Ω)' } },
      { ref: 'V', type: 'voltmeter', x: 28, y: 54, settings: { range: '0–5 V' } }
    ],
    match: {
      parts: [
        { ref: 'E', category: 'battery', label: 'battery' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'Rh', category: 'rheostat', label: 'variable resistor' },
        { ref: 'A', category: 'ammeter', polar: true, label: 'ammeter' }, { ref: 'X', category: 'resistor', label: 'resistor X' },
        { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['E:+', 'S:a'], ['S:b', 'Rh:A'], ['Rh:S', 'A:+'], ['A:-', 'X:a', 'V:+'], ['X:b', 'V:-', 'E:-']]
    },
    solution: [['E:+', 'S:a'], ['S:b', 'Rh:A'], ['Rh:S', 'A:+'], ['A:-', 'X:a'], ['X:a', 'V:+'], ['X:b', 'V:-'], ['V:-', 'E:-']],
    diagram: {
      w: 10, h: 8,
      items: [
        { sym: 'battery', ref: 'E', p: [2, 1], q: [4, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [5, 1], q: [7, 1] },
        { sym: 'rheostat', ref: 'Rh', p: [9, 1.5], q: [9, 3.5] },
        { sym: 'ammeter', ref: 'A', p: [9, 4.5], q: [9, 6], plus: 'p' },
        { sym: 'resistor', ref: 'X', p: [6, 6], q: [4, 6], label: 'X' },
        { sym: 'voltmeter', ref: 'V', p: [6, 7.5], q: [4, 7.5], plus: 'p' }
      ],
      wires: [[[1, 1], [2, 1]], [[4, 1], [5, 1]], [[7, 1], [9, 1], [9, 1.5]], [[9, 3.5], [9, 4.5]],
        [[9, 6], [6, 6]], [[4, 6], [1, 6], [1, 1]], [[7, 6], [7, 7.5], [6, 7.5]], [[4, 7.5], [3, 7.5], [3, 6]]],
      dots: [[7, 6], [3, 6]]
    }
  });

  /* ---------------------------------------------------------------- 2. resistivity */
  add({
    id: 'resistivity', title: 'Resistance of a wire and resistivity', level: 'AS',
    aim: 'Investigate how the resistance R of a wire depends on its length x, and find the resistivity of the metal.',
    steps: [
      'Build the circuit. The lead from the ammeter is clipped to end A of the wire (0 cm); the jockey touches the wire a distance x from A.',
      'Close the switch only while you take readings.',
      'Read the jockey position on the metre rule, the current and the potential difference. Repeat for several values of x.',
      'Measure the diameter of the wire with a micrometer in the Instrument lab practice (or use the value you are given).'
    ],
    investigate: ['Calculate R = V / I. Plot R against x: the gradient is ρ / A where A = πd²/4.'],
    kit: [
      { ref: 'E', type: 'cell', x: 14, y: 14 },
      { ref: 'S', type: 'switch', x: 44, y: 14 },
      { ref: 'A', type: 'ammeter', x: 104, y: 20 },
      { ref: 'W', type: 'wire', x: 12, y: 56, settings: { material: 'constantan', jockey: 50 } },
      { ref: 'V', type: 'voltmeter', x: 74, y: 22, settings: { range: '0–5 V' } }
    ],
    match: {
      parts: [
        { ref: 'E', category: 'cell', label: 'cell' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'A', category: 'ammeter', polar: true, label: 'ammeter' }, { ref: 'W', category: 'wire', label: 'resistance wire' },
        { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['E:+', 'S:a'], ['S:b', 'A:+'], ['A:-', 'W:A', 'V:+'], ['W:J', 'V:-', 'E:-']]
    },
    solution: [['E:+', 'S:a'], ['S:b', 'A:+'], ['A:-', 'W:A'], ['W:A', 'V:+'], ['W:J', 'V:-'], ['V:-', 'E:-']],
    diagram: {
      w: 10, h: 9,
      items: [
        { sym: 'cell', ref: 'E', p: [2, 1], q: [4, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [5, 1], q: [7, 1] },
        { sym: 'ammeter', ref: 'A', p: [9, 2], q: [9, 4], plus: 'p' },
        { sym: 'wire', ref: 'W', p: [8, 5.5], q: [2, 5.5], jockey: [4, 7], label: 'wire', ends: ['A', 'B'] },
        { sym: 'voltmeter', ref: 'V', p: [7, 8.5], q: [5, 8.5], plus: 'p' }
      ],
      wires: [[[1, 1], [2, 1]], [[4, 1], [5, 1]], [[7, 1], [9, 1], [9, 2]], [[9, 4], [9, 5.5], [8, 5.5]],
        [[4, 7], [1, 7], [1, 1]], [[8.6, 5.5], [8.6, 8.5], [7, 8.5]], [[5, 8.5], [4, 8.5], [4, 7]]],
      dots: [[8.6, 5.5], [4, 7]],
      dims: [{ from: [8, 4.7], to: [4, 4.7], label: 'x' }]
    }
  });

  /* ---------------------------------------------------------------- 3. potential divider (wire) */
  add({
    id: 'potdivider', title: 'Potential divider using a resistance wire', level: 'AS',
    aim: 'Investigate how the potential difference V between end A of a wire and the jockey depends on the distance x.',
    steps: [
      'Connect the cell and switch across the WHOLE wire, from A to B.',
      'Connect the voltmeter between end A and the jockey.',
      'Close the switch, move the jockey, and read x and V each time.'
    ],
    investigate: ['Plot V against x. A straight line through the origin shows V ∝ x for a uniform wire.'],
    kit: [
      { ref: 'E', type: 'cell', x: 14, y: 14 },
      { ref: 'S', type: 'switch', x: 44, y: 14 },
      { ref: 'W', type: 'wire', x: 12, y: 56, settings: { material: 'nichrome', jockey: 50 } },
      { ref: 'V', type: 'dmm', x: 82, y: 18, settings: { mode: 'V', range: '2 V' } }
    ],
    match: {
      parts: [
        { ref: 'E', category: 'cell', label: 'cell' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'W', category: 'wire', label: 'resistance wire' }, { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['E:+', 'S:a'], ['S:b', 'W:B'], ['W:A', 'E:-', 'V:-'], ['W:J', 'V:+']]
    },
    solution: [['E:+', 'S:a'], ['S:b', 'W:B'], ['W:A', 'E:-'], ['W:A', 'V:-'], ['W:J', 'V:+']],
    diagram: {
      w: 10, h: 8,
      items: [
        { sym: 'cell', ref: 'E', p: [4, 1], q: [6, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [7, 1], q: [9, 1] },
        { sym: 'wire', ref: 'W', p: [1, 4], q: [9, 4], jockey: [6, 5.5], ends: ['A', 'B'] },
        { sym: 'voltmeter', ref: 'V', p: [5, 7], q: [3, 7], plus: 'p' }
      ],
      wires: [[[9, 1], [9.6, 1], [9.6, 4], [9, 4]], [[1, 4], [0.4, 4], [0.4, 1], [4, 1]], [[6, 1], [7, 1]],
        [[6, 5.5], [6, 7], [5, 7]], [[3, 7], [0.4, 7], [0.4, 4]]],
      dots: [[0.4, 4]],
      dims: [{ from: [1, 3.2], to: [6, 3.2], label: 'x' }]
    }
  });

  /* ---------------------------------------------------------------- 4. e.m.f. and internal resistance */
  add({
    id: 'emf', title: 'E.m.f. and internal resistance of a cell', level: 'AS',
    aim: 'Measure the terminal potential difference V of a cell for different currents I and find its e.m.f. E and internal resistance r.',
    steps: [
      'Build the circuit: the voltmeter is connected directly across the cell terminals.',
      'Close the switch, read I and V, then open the switch (the cell recovers between readings).',
      'Change the variable resistor and repeat for a wide range of currents.'
    ],
    investigate: ['Plot V against I. V = E − Ir: the y-intercept is E and the gradient is −r.'],
    kit: [
      { ref: 'E', type: 'cell', x: 20, y: 16 },
      { ref: 'S', type: 'switch', x: 52, y: 14 },
      { ref: 'A', type: 'ammeter', x: 104, y: 22 },
      { ref: 'Rh', type: 'rheostat', x: 62, y: 54, settings: { nominal: 10, pos: 0.6 } },
      { ref: 'V', type: 'voltmeter', x: 22, y: 50, settings: { range: '0–5 V' } }
    ],
    match: {
      parts: [
        { ref: 'E', category: 'cell', label: 'cell' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'A', category: 'ammeter', polar: true, label: 'ammeter' }, { ref: 'Rh', category: 'rheostat', label: 'variable resistor' },
        { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['E:+', 'S:a', 'V:+'], ['S:b', 'A:+'], ['A:-', 'Rh:A'], ['Rh:S', 'E:-', 'V:-']]
    },
    solution: [['E:+', 'S:a'], ['E:+', 'V:+'], ['S:b', 'A:+'], ['A:-', 'Rh:A'], ['Rh:S', 'E:-'], ['E:-', 'V:-']],
    diagram: {
      w: 10, h: 7,
      items: [
        { sym: 'cell', ref: 'E', p: [3, 2], q: [5, 2], plus: 'q' },
        { sym: 'voltmeter', ref: 'V', p: [5, 0.5], q: [3, 0.5], plus: 'p' },
        { sym: 'switch', ref: 'S', p: [6.5, 2], q: [8.5, 2] },
        { sym: 'ammeter', ref: 'A', p: [9.5, 3], q: [9.5, 5], plus: 'p' },
        { sym: 'rheostat', ref: 'Rh', p: [7, 6], q: [3, 6] }
      ],
      wires: [[[5, 2], [6.5, 2]], [[8.5, 2], [9.5, 2], [9.5, 3]], [[9.5, 5], [9.5, 6], [7, 6]], [[3, 6], [1, 6], [1, 2], [3, 2]],
        [[5.7, 2], [5.7, 0.5], [5, 0.5]], [[3, 0.5], [2.2, 0.5], [2.2, 2]]],
      dots: [[5.7, 2], [2.2, 2]]
    }
  });

  /* ---------------------------------------------------------------- 5. resistors in parallel */
  add({
    id: 'parallel', title: 'Resistors in parallel with a resistance box', level: 'AS',
    aim: 'Find the resistance of X by connecting it in parallel with a resistance box of resistance R.',
    steps: [
      'Build the circuit with X and the resistance box in parallel.',
      'Set R on the box, close the switch, and record I and V. Open the switch.',
      'Repeat for several values of R.'
    ],
    investigate: ['I/V = 1/R + 1/X. Plot I/V against 1/R: the gradient should be 1 and the y-intercept is 1/X.'],
    kit: [
      { ref: 'E', type: 'battery', x: 14, y: 14 },
      { ref: 'S', type: 'switch', x: 46, y: 14 },
      { ref: 'A', type: 'ammeter', x: 104, y: 22 },
      { ref: 'X', type: 'unknownR', x: 50, y: 46, settings: { label: 'X', size: 'small (2–20 Ω)' } },
      { ref: 'B', type: 'rbox', x: 72, y: 56, settings: { x10: 2, x1: 0 } },
      { ref: 'V', type: 'dmm', x: 18, y: 50, settings: { mode: 'V', range: '20 V' } }
    ],
    match: {
      parts: [
        { ref: 'E', category: 'battery', label: 'battery' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'A', category: 'ammeter', polar: true, label: 'ammeter' }, { ref: 'X', category: 'resistor', label: 'resistor X' },
        { ref: 'B', category: 'rbox', label: 'resistance box' }, { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['E:+', 'S:a'], ['S:b', 'A:+'], ['A:-', 'X:a', 'B:a', 'V:+'], ['X:b', 'B:b', 'V:-', 'E:-']]
    },
    solution: [['E:+', 'S:a'], ['S:b', 'A:+'], ['A:-', 'X:a'], ['X:a', 'B:a'], ['B:a', 'V:+'], ['X:b', 'B:b'], ['B:b', 'V:-'], ['V:-', 'E:-']],
    diagram: {
      w: 10, h: 9,
      items: [
        { sym: 'battery', ref: 'E', p: [2, 1], q: [4, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [5, 1], q: [7, 1] },
        { sym: 'ammeter', ref: 'A', p: [9, 2], q: [9, 4], plus: 'p' },
        { sym: 'resistor', ref: 'X', p: [6, 5], q: [4, 5], label: 'X' },
        { sym: 'resistor', ref: 'B', p: [6, 6.5], q: [4, 6.5], label: 'R', variable: true },
        { sym: 'voltmeter', ref: 'V', p: [6, 8.2], q: [4, 8.2], plus: 'p' }
      ],
      wires: [[[1, 1], [2, 1]], [[4, 1], [5, 1]], [[7, 1], [9, 1], [9, 2]], [[9, 4], [9, 5], [6, 5]],
        [[7, 5], [7, 8.2], [6, 8.2]], [[6, 6.5], [7, 6.5]], [[4, 5], [1, 5], [1, 1]],
        [[4, 6.5], [3, 6.5], [3, 5]], [[4, 8.2], [3, 8.2], [3, 6.5]]],
      dots: [[7, 5], [7, 6.5], [3, 5], [3, 6.5]]
    }
  });

  /* ---------------------------------------------------------------- 6. filament lamp I–V */
  add({
    id: 'lampIV', title: 'I–V characteristic of a filament lamp', level: 'AS',
    aim: 'Investigate how the current I in a filament lamp varies with the potential difference V across it.',
    steps: [
      'Use the rheostat as a POTENTIAL DIVIDER: its two ends across the supply, the slider feeding the lamp. This lets V go right down to zero.',
      'Set the supply to about 3 V. Move the slider to change V, reading V and I each time.',
      'Do not exceed the lamp rating (2.5 V).'
    ],
    investigate: ['Plot I against V. The curve bends towards the V-axis: the resistance V/I increases as the filament gets hotter.'],
    kit: [
      { ref: 'P', type: 'psu', x: 14, y: 16, settings: { setV: 3 } },
      { ref: 'S', type: 'switch', x: 46, y: 12 },
      { ref: 'Rh', type: 'rheostat', x: 76, y: 12, settings: { nominal: 22, pos: 0.2 } },
      { ref: 'A', type: 'ammeter', x: 104, y: 40 },
      { ref: 'L', type: 'lamp', x: 62, y: 56, settings: { rating: '2.5 V 0.3 A' } },
      { ref: 'V', type: 'voltmeter', x: 28, y: 54 }
    ],
    match: {
      parts: [
        { ref: 'P', category: 'psu', label: 'power supply' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'Rh', category: 'rheostat', label: 'rheostat' }, { ref: 'A', category: 'ammeter', polar: true, label: 'ammeter' },
        { ref: 'L', category: 'lamp', label: 'lamp' }, { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['P:+', 'S:a'], ['S:b', 'Rh:B'], ['Rh:S', 'A:+'], ['A:-', 'L:a', 'V:+'], ['L:b', 'V:-', 'Rh:A', 'P:-']]
    },
    solution: [['P:+', 'S:a'], ['S:b', 'Rh:B'], ['Rh:S', 'A:+'], ['A:-', 'L:a'], ['L:a', 'V:+'], ['L:b', 'V:-'], ['V:-', 'Rh:A'], ['Rh:A', 'P:-']],
    diagram: {
      w: 10, h: 9,
      items: [
        { sym: 'dcsupply', ref: 'P', p: [2, 1], q: [4, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [5, 1], q: [7, 1] },
        { sym: 'pot', ref: 'Rh', p: [9, 1.5], q: [9, 4.5], slider: [7.6, 3] },
        { sym: 'ammeter', ref: 'A', p: [6.5, 3], q: [6.5, 5], plus: 'p' },
        { sym: 'lamp', ref: 'L', p: [6.5, 6], q: [4.5, 6] },
        { sym: 'voltmeter', ref: 'V', p: [6.5, 8], q: [4.5, 8], plus: 'p' }
      ],
      wires: [[[1, 1], [2, 1]], [[4, 1], [5, 1]], [[7, 1], [9, 1], [9, 1.5]], [[7.6, 3], [6.5, 3]],
        [[6.5, 5], [6.5, 6]], [[7.2, 6], [7.2, 8], [6.5, 8]], [[6.5, 6], [7.2, 6]],
        [[4.5, 6], [3.5, 6], [3.5, 7]], [[4.5, 8], [3.5, 8], [3.5, 7]],
        [[3.5, 7], [1, 7], [1, 1]], [[9, 4.5], [9, 7], [3.5, 7]]],
      dots: [[6.5, 6], [3.5, 7]]
    }
  });

  /* ---------------------------------------------------------------- 7. diode / LED */
  add({
    id: 'diodeIV', title: 'Characteristic of a diode (LED)', level: 'AS',
    aim: 'Investigate how the current in a light-emitting diode depends on the potential difference across it.',
    steps: [
      'The fixed resistor protects the LED: never leave it out.',
      'Use the milliampere range of the ammeter.',
      'Vary the variable resistor; record V and I. Then reverse the LED and show that almost no current flows.'
    ],
    investigate: ['Plot I against V. The LED conducts only above a threshold voltage of about 1.8 V.'],
    kit: [
      { ref: 'P', type: 'psu', x: 14, y: 16, settings: { setV: 5 } },
      { ref: 'S', type: 'switch', x: 46, y: 12 },
      { ref: 'Rh', type: 'rheostat', x: 76, y: 12, settings: { nominal: 100, pos: 0.8 } },
      { ref: 'R', type: 'resistor', x: 104, y: 44, settings: { nominal: 100 } },
      { ref: 'A', type: 'ammeter', x: 78, y: 54, settings: { range: '0–100 mA' } },
      { ref: 'D', type: 'led', x: 52, y: 60 },
      { ref: 'V', type: 'dmm', x: 18, y: 52, settings: { mode: 'V', range: '20 V' } }
    ],
    match: {
      parts: [
        { ref: 'P', category: 'psu', label: 'power supply' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'Rh', category: 'rheostat', label: 'variable resistor' }, { ref: 'R', category: 'resistor', label: 'protective resistor' },
        { ref: 'A', category: 'ammeter', polar: true, label: 'ammeter' }, { ref: 'D', category: 'led', polar: true, label: 'LED' },
        { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['P:+', 'S:a'], ['S:b', 'Rh:A'], ['Rh:S', 'R:a'], ['R:b', 'A:+'], ['A:-', 'D:A', 'V:+'], ['D:K', 'V:-', 'P:-']]
    },
    solution: [['P:+', 'S:a'], ['S:b', 'Rh:A'], ['Rh:S', 'R:a'], ['R:b', 'A:+'], ['A:-', 'D:A'], ['D:A', 'V:+'], ['D:K', 'V:-'], ['V:-', 'P:-']],
    diagram: {
      w: 10, h: 9,
      items: [
        { sym: 'dcsupply', ref: 'P', p: [2, 1], q: [4, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [5, 1], q: [7, 1] },
        { sym: 'rheostat', ref: 'Rh', p: [9, 1.5], q: [9, 3.5] },
        { sym: 'resistor', ref: 'R', p: [9, 4], q: [9, 6] },
        { sym: 'ammeter', ref: 'A', p: [8, 7], q: [6, 7], plus: 'p' },
        { sym: 'led', ref: 'D', p: [5, 7], q: [3, 7] },
        { sym: 'voltmeter', ref: 'V', p: [5, 8.6], q: [3, 8.6], plus: 'p' }
      ],
      wires: [[[1, 1], [2, 1]], [[4, 1], [5, 1]], [[7, 1], [9, 1], [9, 1.5]], [[9, 3.5], [9, 4]], [[9, 6], [9, 7], [8, 7]],
        [[6, 7], [5, 7]], [[5.5, 7], [5.5, 8.6], [5, 8.6]], [[3, 7], [1, 7], [1, 1]], [[3, 8.6], [2.4, 8.6], [2.4, 7]]],
      dots: [[5.5, 7], [2.4, 7]]
    }
  });

  /* ---------------------------------------------------------------- 8. thermistor */
  add({
    id: 'thermistor', title: 'Thermistor in a potential divider', level: 'AS',
    aim: 'Investigate how the output voltage of a potential divider containing a thermistor changes with temperature.',
    steps: [
      'Build the potential divider: thermistor and fixed resistor in series across the battery.',
      'Measure the voltage across the FIXED resistor.',
      'Change the water temperature, wait for the thermometer reading to settle, and read the temperature and the voltage.'
    ],
    investigate: ['As the temperature rises the thermistor resistance falls, so the voltage across the fixed resistor rises.'],
    kit: [
      { ref: 'E', type: 'battery', x: 14, y: 16 },
      { ref: 'S', type: 'switch', x: 46, y: 12 },
      { ref: 'Th', type: 'thermistor', x: 80, y: 22 },
      { ref: 'R', type: 'resistor', x: 60, y: 60, settings: { nominal: 4700 } },
      { ref: 'V', type: 'dmm', x: 20, y: 50, settings: { mode: 'V', range: '20 V' } }
    ],
    match: {
      parts: [
        { ref: 'E', category: 'battery', label: 'battery' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'Th', category: 'thermistor', label: 'thermistor' }, { ref: 'R', category: 'resistor', label: 'fixed resistor' },
        { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['E:+', 'S:a'], ['S:b', 'Th:a'], ['Th:b', 'R:a', 'V:+'], ['R:b', 'V:-', 'E:-']]
    },
    solution: [['E:+', 'S:a'], ['S:b', 'Th:a'], ['Th:b', 'R:a'], ['R:a', 'V:+'], ['R:b', 'V:-'], ['V:-', 'E:-']],
    diagram: {
      w: 10, h: 8,
      items: [
        { sym: 'battery', ref: 'E', p: [2, 1], q: [4, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [5, 1], q: [7, 1] },
        { sym: 'thermistor', ref: 'Th', p: [9, 2], q: [9, 4.5] },
        { sym: 'resistor', ref: 'R', p: [6, 5.5], q: [4, 5.5] },
        { sym: 'voltmeter', ref: 'V', p: [6, 7.2], q: [4, 7.2], plus: 'p' }
      ],
      wires: [[[1, 1], [2, 1]], [[4, 1], [5, 1]], [[7, 1], [9, 1], [9, 2]], [[9, 4.5], [9, 5.5], [6, 5.5]],
        [[7, 5.5], [7, 7.2], [6, 7.2]], [[4, 5.5], [1, 5.5], [1, 1]], [[4, 7.2], [3, 7.2], [3, 5.5]]],
      dots: [[7, 5.5], [3, 5.5]]
    }
  });

  /* ---------------------------------------------------------------- 9. LDR */
  add({
    id: 'ldr', title: 'Light-dependent resistor', level: 'AS',
    aim: 'Investigate how the voltage across an LDR in a potential divider depends on the distance d of a lamp from it.',
    steps: [
      'Build the potential divider: fixed resistor and LDR in series across the battery.',
      'Measure the voltage across the LDR.',
      'Slide the lamp along its scale, read d and the voltage.'
    ],
    investigate: ['The closer the lamp, the brighter the light, the smaller the LDR resistance and the smaller the voltage across it.'],
    kit: [
      { ref: 'E', type: 'battery', x: 14, y: 16 },
      { ref: 'S', type: 'switch', x: 46, y: 12 },
      { ref: 'R', type: 'resistor', x: 84, y: 16, settings: { nominal: 1000 } },
      { ref: 'L', type: 'ldr', x: 52, y: 52 },
      { ref: 'V', type: 'dmm', x: 18, y: 50, settings: { mode: 'V', range: '20 V' } }
    ],
    match: {
      parts: [
        { ref: 'E', category: 'battery', label: 'battery' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'R', category: 'resistor', label: 'fixed resistor' }, { ref: 'L', category: 'ldr', label: 'LDR' },
        { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['E:+', 'S:a'], ['S:b', 'R:a'], ['R:b', 'L:a', 'V:+'], ['L:b', 'V:-', 'E:-']]
    },
    solution: [['E:+', 'S:a'], ['S:b', 'R:a'], ['R:b', 'L:a'], ['L:a', 'V:+'], ['L:b', 'V:-'], ['V:-', 'E:-']],
    diagram: {
      w: 10, h: 8,
      items: [
        { sym: 'battery', ref: 'E', p: [2, 1], q: [4, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [5, 1], q: [7, 1] },
        { sym: 'resistor', ref: 'R', p: [9, 2], q: [9, 4.5] },
        { sym: 'ldr', ref: 'L', p: [6, 5.5], q: [4, 5.5] },
        { sym: 'voltmeter', ref: 'V', p: [6, 7.2], q: [4, 7.2], plus: 'p' }
      ],
      wires: [[[1, 1], [2, 1]], [[4, 1], [5, 1]], [[7, 1], [9, 1], [9, 2]], [[9, 4.5], [9, 5.5], [6, 5.5]],
        [[7, 5.5], [7, 7.2], [6, 7.2]], [[4, 5.5], [1, 5.5], [1, 1]], [[4, 7.2], [3, 7.2], [3, 5.5]]],
      dots: [[7, 5.5], [3, 5.5]]
    }
  });

  /* ---------------------------------------------------------------- 10. capacitor (A Level extension) */
  add({
    id: 'capacitor', title: 'Charging a capacitor (A Level extension)', level: 'A Level',
    aim: 'Investigate how the potential difference across a capacitor increases with time when it charges through a resistor.',
    steps: [
      'Build the circuit with the capacitor + terminal towards the supply +.',
      'Start the stopwatch as you close the switch; read the voltmeter at regular times.',
      'To discharge, open the switch and connect a lead across the capacitor (through a resistor).'
    ],
    investigate: ['V = V₀(1 − e^(−t/RC)). Plot ln(1 − V/V₀) against t: the gradient is −1/RC.'],
    kit: [
      { ref: 'P', type: 'psu', x: 14, y: 16, settings: { setV: 6 } },
      { ref: 'S', type: 'switch', x: 46, y: 12 },
      { ref: 'R', type: 'resistor', x: 82, y: 14, settings: { nominal: 22000 } },
      { ref: 'C', type: 'capacitor', x: 66, y: 52, settings: { nominal: 1000 } },
      { ref: 'V', type: 'dmm', x: 18, y: 50, settings: { mode: 'V', range: '20 V' } }
    ],
    match: {
      parts: [
        { ref: 'P', category: 'psu', label: 'power supply' }, { ref: 'S', category: 'switch', label: 'switch' },
        { ref: 'R', category: 'resistor', label: 'resistor' }, { ref: 'C', category: 'capacitor', polar: true, label: 'capacitor' },
        { ref: 'V', category: 'voltmeter', polar: true, label: 'voltmeter' }
      ],
      nets: [['P:+', 'S:a'], ['S:b', 'R:a'], ['R:b', 'C:+', 'V:+'], ['C:-', 'V:-', 'P:-']]
    },
    solution: [['P:+', 'S:a'], ['S:b', 'R:a'], ['R:b', 'C:+'], ['C:+', 'V:+'], ['C:-', 'V:-'], ['V:-', 'P:-']],
    diagram: {
      w: 10, h: 8,
      items: [
        { sym: 'dcsupply', ref: 'P', p: [2, 1], q: [4, 1], plus: 'q' },
        { sym: 'switch', ref: 'S', p: [5, 1], q: [7, 1] },
        { sym: 'resistor', ref: 'R', p: [9, 2], q: [9, 4.5] },
        { sym: 'capacitor', ref: 'C', p: [6, 5.5], q: [4, 5.5], plus: 'p' },
        { sym: 'voltmeter', ref: 'V', p: [6, 7.2], q: [4, 7.2], plus: 'p' }
      ],
      wires: [[[1, 1], [2, 1]], [[4, 1], [5, 1]], [[7, 1], [9, 1], [9, 2]], [[9, 4.5], [9, 5.5], [6, 5.5]],
        [[7, 5.5], [7, 7.2], [6, 7.2]], [[4, 5.5], [1, 5.5], [1, 1]], [[4, 7.2], [3, 7.2], [3, 5.5]]],
      dots: [[7, 5.5], [3, 5.5]]
    }
  });

  VL.circuitTemplates = {
    list: T,
    get: function (id) { for (var i = 0; i < T.length; i++) if (T[i].id === id) return T[i]; return null; },
    /** Build the kit (unwired) into a fresh circuit; returns { circuit, refs: { ref: partId } }. */
    build: function (tpl, seed, opts) {
      var C = VL.circuit, c = C.create(seed);
      var refs = {};
      tpl.kit.forEach(function (k) {
        var p = C.addPart(c, k.type, k.x, k.y, k.settings || {});
        p.ref = k.ref;
        refs[k.ref] = p.id;
      });
      if (opts && opts.wired) {
        var colors = ['red', 'black', 'blue', 'yellow', 'green'];
        tpl.solution.forEach(function (pair, i) {
          var a = pair[0].split(':'), b = pair[1].split(':');
          var pa = C.getPart(c, refs[a[0]]), pb = C.getPart(c, refs[b[0]]);
          C.addWire(c, { part: pa.id, term: termFor(pa, a[1]) }, { part: pb.id, term: termFor(pb, b[1]) }, colors[i % colors.length]);
        });
      }
      return { circuit: c, refs: refs };
    }
  };

  /** Template terminal names → actual terminal ids (a multimeter used as a voltmeter / ammeter). */
  function termFor(part, term) {
    if (part.type === 'dmm') {
      if (term === '+') return VL.circuit.types.dmm.socket(part.settings);
      if (term === '-') return 'COM';
    }
    return term;
  }
  VL.circuitTemplates.termFor = termFor;
})(globalThis.VLab = globalThis.VLab || {});
