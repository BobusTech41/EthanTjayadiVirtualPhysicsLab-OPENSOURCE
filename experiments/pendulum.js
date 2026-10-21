/**
 * Simple pendulum — Cambridge International AS Level Physics 9702, Paper 3 style.
 * Spec: docs/experiments/pendulum.md. Contract: docs/ARCHITECTURE.md §4 (experiment) and §4.1 (apparatus).
 *
 * Variants
 *   graph    (Q1, 20 marks)  six sets of L and T, graph of T² against L, gradient/intercept → a, b and g.
 *   twopoint (Q2, 20 marks)  two lengths, k = T²/(L + d/2) twice, conclusion, g, limitations and improvements.
 *
 * Hidden physics (model)
 *   L     = length of string from the BOTTOM of the split cork to the TOP of the bob (what the student measures)
 *   Leff  = L + d/2 + δ       (δ: the string flexes a little inside the cork, so the real pivot is above its bottom)
 *   T     = 2π √(Leff / g) · (1 + θ₀²/16)      θ₀ = current angular amplitude in rad, g = 9.81 m s⁻²
 *   θ(t)  = θ₀ e^(−t/τ) cos φ(t)  with φ(t) chosen so that the instantaneous period follows the amplitude (see
 *           swingPhase). Everything is analytic in REAL time (services.now()), so a student's own stopwatch timing
 *           of the animation is exactly as good as their key presses — there is no artificial reaction noise.
 *
 * Public, beyond the contract (additive):
 *   def.model.amplitudeFactor / swingPhase / swingAngle / oscillationsBetween
 *   def.bank                      limitations / improvements bank (rows A–G)
 *   modelAnswer(...).log          the simulated careful student's lab record (stopwatch events, lengths), so that
 *                                 the log-based mark points can be exercised when the model answer is marked
 *   controller.actions            the apparatus operations used by the DOM controls (also handy for tests)
 *   hints                         per-variant map { graph: {partId: html}, twopoint: {...} } (ui/app.js hintsFor)
 *
 * No DOM access at load time; createApparatus() is browser-only except for its pure parts (tests drive it with a
 * fake services object and a stub canvas context).
 */
(function (VL) {
  'use strict';

  /* ================================================================== constants */

  var G_TRUE = 9.81;                       // m s⁻²
  var TWO_PI = 2 * Math.PI;
  var DEG = Math.PI / 180;
  var FOUR_PI2 = 4 * Math.PI * Math.PI;

  /* Scene geometry (world units: cm, y downwards). */
  var WORLD = { width: 110, height: 130 };
  var PIVOT = { x: 52, y: 10 };            // bottom of the split cork: L is measured from here
  var BENCH_Y = 118;                       // bench top
  var ROD_X = 10;                          // retort stand rod
  var ARM_Y = PIVOT.y - 1.7;               // clamp arm height
  var RULE_GAP = 1.5;                      // string and bob hang this far in front of the rule's scale (cm)
  var RULE_START = { x: 61, y: PIVOT.y - 2 };   // initial zero mark of the metre rule (y: params.ruleStartY, 1–3 cm above
                                           // the cork; this y only for sessions from before that parameter)
  var RULE_LIMITS = { x0: 22, x1: 92, y0: -5, y1: 17 };
  var PROTRACTOR_PLACE = { x: PIVOT.x, y: PIVOT.y, rotation: Math.PI };   // arc below the pivot
  var VPLACE = { x: 66, y: 122.5 };        // vernier main-scale zero (inset on the bench)
  var V_OPEN = 40;                         // mm: jaws open with the spare bob between them
  var V_MAX = 60;                          // mm: widest the sliding jaw may be dragged
  var SPARE_ASIDE = { x: 99, y: 125.2 };   // spare bob set aside while the zero is checked
  var INSET = { x: 57.5, y: 118.7, w: 50.5, h: 11 };

  /* Controls. */
  var L_MIN = 10.0, L_MAX = 100.0;         // cm (the string may slip a little beyond L_MAX)
  var SLIP_ROOM = 1.5;                     // cm
  var AMP_MAX = 30;                        // degrees
  var COARSE = 0.5, FINE = 0.1;            // cm per press (with a little scatter: string never moves exactly)
  var PULL_STEP = 2;                       // degrees per "Pull bob aside" press
  var SETTLE_MS = 1200;                    // a length change is logged once the string has been left alone
  var MAX_PX_PER_CM = 800;                 // controller.maxPxPerCm: the view may zoom this far (0.02 mm = 1.6 px)

  /* Marking tolerances (spec tables). */
  var TOL_D_CM = 0.03;
  var TOL_L_CM = 0.3;
  var L_WINDOW = 5;                        // cm: a length the question asks for ("about 50 cm") may be this far out
  var TOL_T = 0.03;
  var MIN_OSC = 9.5;                       // "at least 10 oscillations", allowing for start/stop judgement

  /* ================================================================== small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function round(x, n) { var f = Math.pow(10, n); return Math.round(x * f) / f; }
  function mean(a) {
    var n = a.filter(isNum);
    return n.length ? n.reduce(function (s, x) { return s + x; }, 0) / n.length : NaN;
  }
  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function perfNow() {
    var p = globalThis.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }
  function sfFormat(x, n) {
    return VL.sigfig && VL.sigfig.formatSF ? VL.sigfig.formatSF(x, n) : String(Number(x.toPrecision(n)));
  }

  /* ================================================================== physics model */

  /**
   * Amplitude correction factor 1 + θ₀²/16 (θ₀ in rad).
   * @param {number} amplitudeDeg angular amplitude in degrees
   * @returns {number}
   */
  function amplitudeFactor(amplitudeDeg) {
    var th = (amplitudeDeg || 0) * DEG;
    return 1 + th * th / 16;
  }

  /**
   * Effective length of the pendulum (pivot to centre of the bob).
   * @param {number} Lcm   length from the bottom of the cork to the top of the bob (cm)
   * @param {number} dcm   bob diameter (cm)
   * @param {number} deltacm hidden pivot offset (cm)
   * @returns {number} cm
   */
  function Leff(Lcm, dcm, deltacm) {
    return Lcm + (dcm || 0) / 2 + (deltacm || 0);
  }

  /**
   * Period of the pendulum.
   * @param {number} Lcm
   * @param {number} dcm
   * @param {number} deltacm
   * @param {number} amplitudeDeg
   * @returns {number} seconds
   */
  function period(Lcm, dcm, deltacm, amplitudeDeg) {
    return TWO_PI * Math.sqrt(Leff(Lcm, dcm, deltacm) / 100 / G_TRUE) * amplitudeFactor(amplitudeDeg);
  }

  /**
   * g from the gradient of a graph of T² against L: g = 4π² / a.
   * @param {number} a gradient
   * @param {string} [unit='s² m⁻¹'] unit of a, e.g. 's2/m', 's² cm⁻¹', 's^2 cm^-1'
   * @returns {number} g in m s⁻²
   */
  function gFromGradient(a, unit) {
    var factor = 1;
    if (unit) {
      var u = VL.units && VL.units.parseUnit ? VL.units.parseUnit(String(unit)) : null;
      if (u && u.ok) factor = u.factor;
      else if (/cm/.test(unit)) factor = 100;
      else if (/mm/.test(unit)) factor = 1000;
    }
    return FOUR_PI2 / (a * factor);
  }

  /**
   * Phase φ(t) of a damped swing released from rest at θ₀, with amplitude A(t) = |θ₀| e^(−t/τ):
   * φ(t) = (2π/T₀)[t − (θ₀² τ / 32)(1 − e^(−2t/τ))], so dφ/dt = 2π/(T₀(1 + A²/16)) to first order — the
   * instantaneous period follows the amplitude-dependent period.
   * @param {number} t   seconds since release
   * @param {number} theta0 release angle (rad)
   * @param {number} T0  small-amplitude period (s)
   * @param {number} tau damping time constant (s)
   * @returns {number} rad
   */
  function swingPhase(t, theta0, T0, tau) {
    var A2 = theta0 * theta0;
    return TWO_PI / T0 * (t - A2 * tau / 32 * (1 - Math.exp(-2 * t / tau)));
  }

  /**
   * Angular displacement θ(t) = θ₀ e^(−t/τ) cos φ(t) (rad, + = bob to the right).
   * @returns {number}
   */
  function swingAngle(t, theta0, T0, tau) {
    return theta0 * Math.exp(-t / tau) * Math.cos(swingPhase(t, theta0, T0, tau));
  }

  /** Number of oscillations completed between t1 and t2 (s after release). */
  function oscillationsBetween(t1, t2, theta0, T0, tau) {
    return (swingPhase(t2, theta0, T0, tau) - swingPhase(t1, theta0, T0, tau)) / TWO_PI;
  }

  var model = {
    g: G_TRUE,
    Leff: Leff,
    period: period,
    amplitudeFactor: amplitudeFactor,
    gFromGradient: gFromGradient,
    swingPhase: swingPhase,
    swingAngle: swingAngle,
    oscillationsBetween: oscillationsBetween
  };

  var knownValues = [
    { name: 'T for L = 100.0 cm, d = 0, δ = 0, small amplitude', actual: function () { return period(100, 0, 0, 0); }, expected: 2.006, tol: 0.0005 },
    { name: 'T for L = 24.53 cm, d = 0, δ = 0, small amplitude', actual: function () { return period(24.53, 0, 0, 0); }, expected: 0.9935, tol: 0.001 },
    { name: 'amplitude factor at 10°', actual: function () { return amplitudeFactor(10); }, expected: 1.0019, tol: 0.00005 },
    { name: 'g from a gradient of 4.024 s² m⁻¹', actual: function () { return gFromGradient(4.024); }, expected: 9.81, tol: 0.01 }
  ];

  /* ================================================================== hidden parameters */

  /**
   * Hidden zero error of the vernier (mm). Uses VL.noise.zeroError (always the same number of draws).
   * @param {object} rng
   * @param {number} res resolution (mm)
   */
  function vernierZero(rng, res) {
    var z;
    if (VL.noise && typeof VL.noise.zeroError === 'function') {
      z = VL.noise.zeroError(rng, { resolution: res, chance: 0.3, maxDivisions: 3 });
    } else {
      var hit = rng.chance(0.3), k = rng.int(1, 3), sign = rng.chance(0.5) ? 1 : -1;
      z = hit ? sign * k * res : 0;
    }
    return round(z, 4) || 0;
  }

  /**
   * Hidden parameters for one seed. The number and order of draws never depend on the variant or on the noise
   * level, so the same seed always gives the same apparatus.
   * @param {object} rng the 'params' fork of the session rng
   * (The contract's second argument, variantId, is not needed: both variants share one apparatus.)
   * @returns {{g, d, delta, tau, vernierRes, vernierZero, eyeStart, L0, slipChance, ruleStartY}}
   *   d, delta, L0 in cm; vernierRes, vernierZero in mm; tau in s; eyeStart in degrees; ruleStartY: world y (cm) of
   *   the metre rule's zero mark at the start, 1–3 cm above the bottom of the cork (drawn LAST, so the other
   *   parameters of a seed are the same as before it was added)
   */
  function sampleParams(rng) {
    var d = round(rng.uniform(1.80, 2.60), 3);
    var delta = round(rng.uniform(0.00, 0.40), 3);
    var tau = round(rng.uniform(60, 150), 1);
    var vernierRes = rng.chance(0.5) ? 0.1 : 0.02;
    var vz = vernierZero(rng, vernierRes);
    var eyeSign = rng.chance(0.5) ? 1 : -1;
    var eyeStart = round(eyeSign * rng.uniform(3, 9), 2);
    var L0 = round(rng.uniform(38, 72), 2);
    var slipChance = VL.noise && isNum(VL.noise.anomalyRate) ? VL.noise.anomalyRate : 0.03;
    var ruleStartY = round(PIVOT.y - rng.uniform(1, 3), 2);   // keep this the last draw
    return {
      g: G_TRUE, d: d, delta: delta, tau: tau,
      vernierRes: vernierRes, vernierZero: vz,
      eyeStart: eyeStart, L0: L0, slipChance: slipChance, ruleStartY: ruleStartY
    };
  }

  /* ================================================================== variants, apparatus list, quantities */

  var VARIANTS = [
    { id: 'graph', style: 'Q1', title: 'Period and length: graph of T² against L' },
    { id: 'twopoint', style: 'Q2', title: 'Period and length: testing T² = k(L + d/2)' }
  ];

  /**
   * Apparatus listed on the question paper.
   * @returns {string[]} (the same for both variants)
   */
  function apparatusList() {
    var list = [
      'a pendulum: a metal bob on a string, the string passing through a split cork',
      'a stand, boss and clamp holding the split cork',
      'a metre rule',
      'a protractor fixed behind the point of suspension',
      'vernier callipers holding a second bob, identical to the pendulum bob',
      'a stopwatch',
      'a fiducial marker (a vertical pointer that can be placed below the bob)'
    ];
    return list;   // the same apparatus for both variants
  }

  /**
   * Quantities for column identification (VL.marking.identifyColumns).
   * @returns {object[]}
   */
  function quantities() {
    return [
      { id: 'd', symbols: ['d', 'D'], dims: { m: 1 }, kind: 'raw', label: 'd', unitHint: 'cm or mm' },
      { id: 'L', symbols: ['L', 'l'], dims: { m: 1 }, kind: 'raw', label: 'L', unitHint: 'cm or m',
        names: ['length', 'length of string', 'string length', 'length of pendulum', 'pendulum length'] },
      { id: 't', symbols: ['t', 'time', '/^\\d+T$/', 'nT', 'NT'], dims: { s: 1 }, kind: 'raw', repeat: true, label: 't', unitHint: 's',
        names: ['time', 'time taken', 'total time'] },
      { id: 'tMean', symbols: ['t_mean', 't_av', 't_avg', 't_ave', 'mean t', 'average t'], dims: { s: 1 }, kind: 'derived', meanOf: 't', label: 'mean t', unitHint: 's',
        names: ['mean time', 'average time'] },
      { id: 'n', symbols: ['n', 'N'], dims: {}, kind: 'raw', label: 'n',
        names: ['number of oscillations', 'number of swings', 'oscillations'] },
      { id: 'T', symbols: ['T', 'period'], dims: { s: 1 }, kind: 'derived', label: 'T', unitHint: 's',
        names: ['period', 'time period', 'periodic time', 'time for one oscillation', 'time for 1 oscillation'] },
      { id: 'T2', symbols: ['T²', 'T^2', 'T2'], dims: { s: 2 }, kind: 'derived', label: 'T²', unitHint: 's²',
        names: ['period^2', 'period squared', 'time period^2'] }
    ];
  }

  /* ================================================================== question papers */

  var NOTE = 'You may not need to use all of the apparatus provided.';

  function paperGraph() {
    return {
      title: 'Question 1',
      totalMarks: 20,
      intro: '<p>In this experiment, you will investigate how the period <i>T</i> of a simple pendulum depends on the ' +
        'length <i>L</i> of its string.</p>',
      apparatusNote: NOTE,
      apparatus: apparatusList('graph'),
      parts: [
        {
          id: 'a', label: '(a)', marks: 1,
          html: '<p>The pendulum bob is a metal sphere. A second bob, identical to the pendulum bob, is held in the ' +
            'vernier callipers on the bench.</p>' +
            '<p>Use the vernier callipers to measure the diameter <i>d</i> of this second bob.</p>',
          answers: [{ key: 'd', type: 'value', prefix: 'd =' }]
        },
        {
          id: 'b', label: '(b)', marks: 1,
          html: '<p>The string of the pendulum passes through a split cork held in a clamp. <i>L</i> is the length of ' +
            'string between the bottom of the split cork and the top of the bob.</p>' +
            '<p>Adjust the string until <i>L</i> is approximately 50&nbsp;cm.</p>' +
            '<p>Measure and record <i>L</i>.</p>',
          answers: [{ key: 'L', type: 'value', prefix: 'L =' }]
        },
        {
          id: 'c', label: '(c)', marks: 1,
          html: '<p>Carry out the following steps.</p><ul>' +
            '<li>Pull the bob a short distance to one side so that the string makes a small angle with the vertical.</li>' +
            '<li>Release the bob so that it oscillates in a vertical plane.</li></ul>' +
            '<p>Take measurements to determine the period <i>T</i> of the oscillations. Show your working.</p>',
          answers: [{ key: 'T', type: 'working', prefix: 'T =' }]
        },
        {
          id: 'd', label: '(d)', marks: 8,
          html: '<p>Change the length of the string and repeat (b) and (c) until you have six sets of values of ' +
            '<i>L</i> and <i>T</i>.</p>' +
            '<p>Record all your measurements in a table. Include values of <i>T</i><sup>2</sup> in your table.</p>',
          answers: [{ type: 'table' }]
        },
        {
          id: 'e', label: '(e)',
          subparts: [
            {
              id: 'e-i', label: '(i)', marks: 3,
              html: '<p>Plot a graph of <i>T</i><sup>2</sup> on the <i>y</i>-axis against <i>L</i> on the <i>x</i>-axis.</p>',
              answers: [{ type: 'graph' }]
            },
            {
              id: 'e-ii', label: '(ii)', marks: 1,
              html: '<p>Draw the straight line of best fit.</p>',
              answers: [{ type: 'graph', label: 'Draw the line on your graph on the Graph tab.' }]
            },
            {
              id: 'e-iii', label: '(iii)', marks: 2,
              html: '<p>Determine the gradient and the <i>y</i>-intercept of this line.</p>',
              answers: [
                { key: 'gradient', type: 'value', prefix: 'gradient =' },
                { key: 'intercept', type: 'value', prefix: 'y-intercept =' }
              ],
              tools: ['gradient', 'intercept']
            }
          ]
        },
        {
          id: 'f', label: '(f)', marks: 2,
          html: '<p>It is suggested that the quantities <i>T</i> and <i>L</i> are related by the equation</p>' +
            '<p class="vl-eq"><i>T</i><sup>2</sup> = <i>aL</i> + <i>b</i></p>' +
            '<p>where <i>a</i> and <i>b</i> are constants.</p>' +
            '<p>Using your answers in (e)(iii), determine the values of <i>a</i> and <i>b</i>. Give appropriate units.</p>',
          answers: [
            { key: 'a', type: 'value', prefix: 'a =' },
            { key: 'b', type: 'value', prefix: 'b =' }
          ]
        },
        {
          id: 'g', label: '(g)', marks: 1,
          html: '<p>Theory shows that <i>a</i> = 4π<sup>2</sup>/<i>g</i>, where <i>g</i> is the acceleration of free fall.</p>' +
            '<p>Use your value of <i>a</i> to determine <i>g</i>. Give your answer, with a unit, to an appropriate ' +
            'number of significant figures.</p>',
          answers: [{ key: 'g', type: 'working', prefix: 'g =' }]
        }
      ]
    };
  }

  function paperTwoPoint() {
    function timing(n) {
      return [
        { key: 'n' + n, type: 'value', prefix: 'n =' },
        { key: 't' + n + 'a', type: 'value', prefix: 'first timing =' },
        { key: 't' + n + 'b', type: 'value', prefix: 'second timing =' },
        { key: 'T' + n, type: 'value', prefix: 'T' + (n === 1 ? '₁' : '₂') + ' =' }
      ];
    }
    return {
      title: 'Question 2',
      totalMarks: 20,
      intro: '<p>In this experiment, you will investigate how the period of a simple pendulum depends on its length.</p>',
      apparatusNote: NOTE,
      apparatus: apparatusList('twopoint'),
      parts: [
        {
          id: 'a', label: '(a)', marks: 1,
          html: '<p>A second bob, identical to the pendulum bob, is held in the vernier callipers on the bench.</p>' +
            '<p>Use the vernier callipers to measure the diameter <i>d</i> of this bob.</p>',
          answers: [{ key: 'd', type: 'value', prefix: 'd =' }]
        },
        {
          id: 'b', label: '(b)', marks: 1,
          html: '<p>Estimate the percentage uncertainty in your value of <i>d</i>.</p>',
          answers: [
            { key: 'dAbs', type: 'value', prefix: 'absolute uncertainty in d =' },
            { key: 'dPct', type: 'value', prefix: 'percentage uncertainty in d =' }
          ]
        },
        {
          id: 'c', label: '(c)',
          html: '<p>The string of the pendulum passes through a split cork held in a clamp. <i>L</i> is the length of ' +
            'string between the bottom of the split cork and the top of the bob.</p>',
          subparts: [
            {
              id: 'c-i', label: '(i)', marks: 1,
              html: '<p>Adjust the string until <i>L</i> is approximately 30&nbsp;cm.</p><p>Measure and record <i>L</i>.</p>',
              answers: [{ key: 'L1', type: 'value', prefix: 'L₁ =' }]
            },
            {
              id: 'c-ii', label: '(ii)', marks: 2,
              html: '<p>Displace the bob through a small angle and release it so that it oscillates in a vertical plane.</p>' +
                '<p>Take repeated timings of several oscillations to determine the period <i>T</i><sub>1</sub> of the ' +
                'pendulum.</p><p>Record the number <i>n</i> of oscillations in each timing, and your raw timings.</p>',
              answers: timing(1)
            }
          ]
        },
        {
          id: 'd', label: '(d)', marks: 3,
          html: '<p>Change the length of the string so that <i>L</i> is approximately 80&nbsp;cm.</p>' +
            '<p>Repeat (c) to obtain the new length <i>L</i><sub>2</sub> and period <i>T</i><sub>2</sub>.</p>',
          answers: [{ key: 'L2', type: 'value', prefix: 'L₂ =' }].concat(timing(2))
        },
        {
          id: 'e', label: '(e)',
          html: '<p>It is suggested that <i>T</i>, <i>L</i> and <i>d</i> are related by the equation</p>' +
            '<p class="vl-eq"><i>T</i><sup>2</sup> = <i>k</i>(<i>L</i> + <i>d</i>/2)</p>' +
            '<p>where <i>k</i> is a constant.</p>',
          subparts: [
            {
              id: 'e-i', label: '(i)', marks: 1,
              html: '<p>Using your data, calculate two values of <i>k</i>.</p>',
              answers: [
                { key: 'k1', type: 'working', prefix: 'first value of k =' },
                { key: 'k2', type: 'value', prefix: 'second value of k =' }
              ]
            },
            {
              id: 'e-ii', label: '(ii)', marks: 1,
              html: '<p>Justify the number of significant figures that you have given for your values of <i>k</i>.</p>',
              answers: [{ key: 'sfJust', type: 'text', rows: 3 }]
            }
          ]
        },
        {
          id: 'f', label: '(f)', marks: 1,
          html: '<p>Explain whether your results support the suggested relationship.</p>',
          answers: [{ key: 'conclusion', type: 'text', rows: 4 }]
        },
        {
          id: 'g', label: '(g)', marks: 1,
          html: '<p>Theory shows that <i>k</i> = 4π<sup>2</sup>/<i>g</i>, where <i>g</i> is the acceleration of free fall.</p>' +
            '<p>Use your results to determine a value of <i>g</i>. Give a unit with your answer.</p>',
          answers: [{ key: 'g', type: 'working', prefix: 'g =' }]
        },
        {
          id: 'h', label: '(h)',
          subparts: [
            {
              id: 'h-i', label: '(i)', marks: 4,
              html: '<p>Describe four sources of uncertainty or limitations of the procedure for this experiment.</p>',
              answers: [{ key: 'limitations', type: 'list', count: 4 }]
            },
            {
              id: 'h-ii', label: '(ii)', marks: 4,
              html: '<p>Describe four improvements that could be made to this experiment. You may suggest the use of ' +
                'other apparatus or different procedures.</p>',
              answers: [{ key: 'improvements', type: 'list', count: 4 }]
            }
          ]
        }
      ]
    };
  }

  /**
   * Question paper for a variant.
   * @param {string} variantId 'graph' | 'twopoint'
   * The contract also passes the hidden params; the wording does not depend on them.
   * @returns {object} Paper (contract §6)
   */
  function paper(variantId) {
    return variantId === 'twopoint' ? paperTwoPoint() : paperGraph();
  }

  /* ================================================================== limitations / improvements bank */

  var DIFFICULT = '/\\b(difficult|hard|not easy|tricky|impossible|uncertain|unclear|could not|can not|unable|not possible)\\b/';

  /**
   * Bank rows A–G (spec table). Concepts follow VL.textmatch: { all: [group...], none: [group...] }, a group
   * being a list of alternatives (phrases or '/regex/' strings tested on the normalised text).
   */
  var BANK = [
    {
      id: 'A',
      limitation: {
        label: 'Two sets of readings are not enough to draw a valid conclusion',
        concepts: [
          { all: [
            ['/\\b(only )?(two|2) (sets|readings|results|values|lengths|measurements|data|points|values of k)\\b/',
              '/\\b(too few|not enough|insufficient|only a few|small number of|limited number of) (sets|readings|results|values|lengths|measurements|data|points)\\b/'],
            ['/\\b(not enough|insufficient|too few|only|can not|not (valid|reliable|sufficient)|unreliable|conclusion|conclude|trend|relationship)\\b/']
          ] }
        ]
      },
      improvement: {
        label: 'Take more readings (more lengths) and plot a graph',
        concepts: [
          { all: [
            ['/\\b(more|several|many|six|6|five|5|seven|at least|further|additional|other|different|range of|wider range)\\b/'],
            ['/\\b(readings|reading|sets|results|values|lengths|length|measurements|data|points)\\b/'],
            ['/\\b(graph|plot)/']
          ] }
        ]
      }
    },
    {
      id: 'B',
      limitation: {
        label: 'Difficult to judge the start or end of an oscillation / reaction time large compared with the time measured',
        concepts: [
          { all: [[DIFFICULT],
            ['/\\b(start|end|beginning|finish|when|exact (point|moment|time|position)|instant|complete|centre|center|middle|extreme|turning point|top of the swing)\\b/'],
            ['/\\b(oscillation|swing|period|timing|stopwatch|stop watch|time)/']],
          none: [['/\\b(length|l|rule|ruler|metre|cork|diameter|angle|amplitude)\\b/']] },
          { all: [['/reaction ?time/'],
            ['/\\b(large|significant|big|compared|comparable|relative|proportion|percentage|short|small|fraction)\\b/']] },
          { all: [['/\\b(times?|timings?|periods?|intervals?)\\b[a-z0-9 ]{0,30}\\b(is|are|was|were|being) (too |very |quite )?(short|small)\\b/',
            '/\\b(short|small) (times?|timings?|periods?|time intervals?)\\b/'],
          ['/reaction|uncertaint|error|percentage|accura|precis/']] }
        ]
      },
      improvement: {
        label: 'Fiducial marker at the centre of the swing / time more oscillations / light gate or video with a timer',
        concepts: [
          { all: [['/fiducial|marker|pointer|reference (line|mark|point)|mark (on|behind|below)/'],
            ['/\\b(centre|center|middle|lowest|bottom|equilibrium|rest position|vertical|start|end|each|pass|passes|passing)/']] },
          { all: [['/\\b(more|20|twenty|25|30|thirty|40|50|larger number|greater number|large number)\\b/'],
            ['/\\b(oscillation|swing)/'], ['/\\b(time|tim|count|measure)/']],
          none: [['/\\bfewer\\b/']] },
          { all: [['/light ?gate|motion sensor|position sensor/']] },
          { all: [['/video|film|camera|slow motion/'], ['/tim|clock|frame|stopwatch|stop watch|scale/']] }
        ]
      }
    },
    {
      id: 'C',
      limitation: {
        label: 'Difficult to measure L: the bob, cork or string is hard to judge against the rule (with a reason)',
        concepts: [
          { all: [[DIFFICULT],
            ['/\\b(measur|read|judg|determin|find|see|line up|align|position)/'],
            ['/\\b(l|length|string|bob|cork)\\b/'],
            ['/\\b(rule|ruler|metre|scale|gap|touch|touching|in front|away from|parallax|top of the bob|bottom of the cork|exact position|exactly where|curved|not straight|vertical)/']],
          none: [['/\\b(start|end) of (the |an |each )?(oscillation|swing)/']] },
          { all: [['/parallax/'], ['/\\b(rule|ruler|scale|metre)\\b/'], ['/\\b(string|bob|cork|l|length)\\b/']] }
        ]
      },
      improvement: {
        label: 'Use a set square to transfer the position to the rule / clamp the rule vertically next to the string',
        concepts: [
          { all: [['/set ?square|straight ?edge|spirit level|horizontal (edge|rule|ruler)|card/'],
            ['/\\b(bob|cork|string|top|bottom|rule|ruler|scale|align|transfer|line up|level)/']] },
          { all: [['/\\b(clamp|clamped|fix|fixed|hold|held|attach|mount|mounted|stand)\\b/'],
            ['/\\b(rule|ruler|scale|metre)\\b/'],
            ['/\\b(vertical|vertically|next to|beside|close to|touching|against|alongside|behind|parallel)/']] }
        ]
      }
    },
    {
      id: 'D',
      limitation: {
        label: 'Amplitude not kept constant / a large amplitude changes the period',
        concepts: [
          { all: [['/amplitude|angle|release (position|point|height)|displacement|how far/'],
            ['/\\b(not (kept |always |the )?(constant|same|controlled|measured|consistent|fixed)|differ|differs|different|varied|vary|varies|changed|change|changes|inconsistent|large|big|too far|too large|too big)\\b/']],
          none: [['/decreas|decay|damp|\\bdie|\\bdies|\\bdied|reduc|air resistance|during (the )?(timing|oscillation)|as (it|the bob) swings|over time|gets smaller|got smaller|became smaller/']] }
        ]
      },
      improvement: {
        label: 'Use the protractor to release from the same small angle each time',
        concepts: [
          { all: [['/protractor/', '/\\b(angle|amplitude|release point|release position)\\b/'],
            ['/\\b(same|constant|fixed|small|smaller|less than|below|under|at most|10|ten|5|five|measure|check|equal)\\b/']],
          none: [['/\\b(time|count) (fewer|less)\\b/']] }
        ]
      }
    },
    {
      id: 'E',
      limitation: {
        label: 'The bob does not swing in a single plane (ellipse, twisting)',
        concepts: [
          { all: [['/\\bplane\\b|ellip|circle|circular|conical|twist|spin|rotat|sideways|wobbl|straight line|figure of eight|figure eight/'],
            ['/\\b(bob|pendulum|swing|swings|oscillat|string|move|moving|moves)/']] },
          // "side to side" alone is the normal swing; it only counts with motion out of the plane as well
          { all: [['/side to side/'], ['/as well as|perpendicular|not in (one|a single) plane|\\balso\\b|instead of|ellip|circle/']] }
        ]
      },
      improvement: {
        label: 'Release carefully from a fixed point / use a release mechanism or bifilar suspension',
        concepts: [
          { all: [['/bifilar|two strings|2 strings|v ?shape|release mechanism|release gate|electromagnet|holder/']] },
          { all: [['/release/'],
            ['/\\b(fixed|same|single|one) (point|position|plane)|without (pushing|a push|spin|spinning|twist|twisting)|gently|from rest|in one plane|in a (single |vertical )?plane|vertical plane|perpendicular/']],
          none: [['/\\b(angle|amplitude|protractor)\\b/']] }
        ]
      }
    },
    {
      id: 'F',
      limitation: {
        label: 'The string slips in the cork / the pivot point is not fixed',
        concepts: [
          { all: [['/slip|slid|slide|loose|not (fixed|tight|secure|firm|held)|pulled? through|move(s|d)? (in|through|up|down)/'],
            ['/\\b(string|cork|pivot|clamp|suspension)\\b/']] },
          { all: [['/pivot|point of suspension|suspension point/'],
            ['/\\b(not (fixed|clear|well defined|definite|exact|certain)|not (clearly|clear|well) (defined|fixed|known)|uncertain|unclear|moves?|inside|within|flex|flexes|bend|bends|unknown)\\b/']] },
          { all: [['/\\b(l|length)\\b/'], ['/\\b(changed|changes|change|increased|increases|increase)\\b/'],
            ['/\\b(during|while|after (release|releasing|swinging|timing))\\b|slipp/']] }
        ]
      },
      improvement: {
        label: 'Clamp the split cork tightly / check L after each set of oscillations',
        concepts: [
          { all: [['/tighten|tightly|more tightly|securely|firmly|screw/'], ['/\\b(cork|clamp|string|pivot|boss)\\b/']],
            // clamping the stand to the bench is about a wobbling stand, not the string slipping in the cork
            none: [['/\\b(rule|ruler|scale|metre)\\b/'], ['/^(?!.*\\b(cork|string|pivot)\\b).*\\b(stand|bench|base|table)\\b/']] },
          { all: [['/\\b(check|re ?measure|remeasure|measure (it|l|the length) again|measure again)\\b/'],
            ['/\\b(l|length)\\b/'], ['/\\b(after|each|every|before and after|end|between)\\b/']] },
          { all: [['/knife ?edge|\\bpin\\b|two (wooden |metal )?(blocks|plates)|fixed pivot|rigid (pivot|support)/']] }
        ]
      }
    },
    {
      id: 'G',
      limitation: {
        label: 'The amplitude decreases during the timing (damping)',
        concepts: [
          { all: [['/amplitude|swing|oscillation|angle|displacement/'],
            ['/decreas|decay|damp|\\bdie|\\bdies|\\bdied|dying|smaller|reduc|slow(s|ed|ing)? down|los(e|es|ing|t) energy|gets less|got less/']] },
          { all: [['/air resistance|air friction|\\bdrag\\b|friction/'],
            ['/amplitude|swing|oscillat|bob|slow|stop|energy|decreas|reduc|motion/']] }
        ]
      },
      improvement: {
        label: 'Use a denser or smaller bob to reduce air resistance',
        concepts: [
          // (timing FEWER oscillations is not credited: it raises the percentage uncertainty from the reaction time)
          { all: [['/dens|heavier|more massive|larger mass|greater mass|smaller|streamlined|compact|lead|steel/'],
            ['/\\b(bob|sphere|ball|mass)\\b/']],
          none: [['/\\b(angle|amplitude)\\b/']] }
        ]
      }
    }
  ];

  /* ================================================================== marking helpers */

  function M() { return VL.marking; }
  function util() { return VL.marking.util; }
  function res(awarded, comment, details) { return { awarded: awarded, comment: comment, details: details || null }; }

  function firstAnswer(ctx, key) {
    var v = ctx.answer(key);
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) if (str(v[i]).trim()) return str(v[i]).trim();
      return '';
    }
    return str(v).trim();
  }

  function dimsIs(unit, dims) {
    return !!(unit && unit.ok && VL.units && VL.units.dimsEqual(unit.dims, dims));
  }

  /** Value answers may be written 'x ± Δx unit': x is marked as if it had been typed alone (Δx is ignored). */
  var WITH_UNC = { allowUncertainty: true };

  /** Length typed in an answer, in cm (no unit: taken to be cm). NaN if unusable. */
  function lengthCm(ctx, key) {
    var raw = firstAnswer(ctx, key);
    if (!raw) return NaN;
    var vu = ctx.vu(raw, WITH_UNC);
    if (!vu.ok) return NaN;
    if (vu.unitStr && vu.unit && vu.unit.ok) return dimsIs(vu.unit, { m: 1 }) ? vu.si * 100 : NaN;
    return vu.num.value;
  }

  /** Time typed in an answer, in s (no unit: taken to be s). NaN if unusable. */
  function timeS(ctx, key) {
    var raw = firstAnswer(ctx, key);
    if (!raw) return NaN;
    var vu = ctx.vu(raw, WITH_UNC);
    if (!vu.ok) return NaN;
    if (vu.unitStr && vu.unit && vu.unit.ok) return dimsIs(vu.unit, { s: 1 }) ? vu.si : NaN;
    return vu.num.value;
  }

  /** First whole number in an answer (e.g. '20', '20 oscillations'). */
  function countOf(ctx, key) {
    var m = /(\d+(?:\.\d+)?)/.exec(firstAnswer(ctx, key));
    return m ? parseFloat(m[1]) : NaN;
  }

  /** Every length of the pendulum (cm) recorded in the lab log, plus the initial length. */
  function lengthCandidates(ctx) {
    var out = [];
    if (ctx.params && isNum(ctx.params.L0)) out.push(ctx.params.L0);
    (Array.isArray(ctx.log) ? ctx.log : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      if (isNum(e.L)) out.push(e.L);
      if (e.snapshot && isNum(e.snapshot.L)) out.push(e.snapshot.L);
    });
    return out;
  }

  function nearest(list, x) {
    var best = NaN;
    list.forEach(function (v) { if (!isNum(best) || Math.abs(v - x) < Math.abs(best - x)) best = v; });
    return best;
  }

  /** Stopwatch stop events (hidden truth logged by the apparatus) with L within `window` cm of Lcm. */
  function stopsNear(ctx, Lcm, window) {
    return (Array.isArray(ctx.log) ? ctx.log : []).filter(function (e) {
      return e && e.type === 'stopwatch-stop' && isNum(e.L) && isNum(e.oscillationsTrue) && Math.abs(e.L - Lcm) <= window;
    });
  }

  /**
   * Timings in the lab record, one per reset cycle of the stopwatch: the stopwatch accumulates over start/stop
   * cycles, so the LAST 'stopwatch-stop' before each 'stopwatch-reset' (or the end of the log) is one timing, with
   * its cumulative oscillationsTrue (what the display showed). Kept when its L is within `window` cm of Lcm.
   */
  function timingsNear(ctx, Lcm, window) {
    var out = [], last = null;
    (Array.isArray(ctx.log) ? ctx.log : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      if (e.type === 'stopwatch-stop') last = e;
      else if (e.type === 'stopwatch-reset') { if (last) out.push(last); last = null; }
    });
    if (last) out.push(last);
    return out.filter(function (e) {
      return isNum(e.L) && isNum(e.oscillationsTrue) && Math.abs(e.L - Lcm) <= window;
    });
  }

  /** True period at a length: from the stopwatch events there (includes the amplitude used), else the model. */
  function trueT(ctx, Lcm, events) {
    var Ts = (events || []).map(function (e) { return e.T; }).filter(isNum);
    if (Ts.length) return mean(Ts);
    var p = ctx.params || {};
    return period(Lcm, p.d || 0, p.delta || 0, 5);
  }

  /** Events for the timing at a typed length (falls back to a nominal length when L was not given). */
  function timingEvents(ctx, Lcm, nominal) {
    return isNum(Lcm) ? stopsNear(ctx, Lcm, 1.0) : stopsNear(ctx, nominal, 10);
  }

  function fmt(x, n) { return util().fmt(x, n || 3); }

  /** Zero error (mm) with its sign, to the resolution of the callipers: '+0.04', '−0.3'. */
  function signedMm(z, resMm) {
    var dp = resMm === 0.02 ? 2 : 1;
    return (z > 0 ? '+' : z < 0 ? '−' : '') + Math.abs(z).toFixed(dp);
  }

  /** The jaws close on the bob to within this (mm): a careful reading may be this much more than half a division out. */
  var SQUEEZE_MM = 0.01;

  /**
   * answerValue `reject` for d when the callipers have a hidden zero error z (mm). A careful, corrected reading
   * lies less than half a division + the squeeze from the true diameter (only at the very edge of the squeeze is it
   * that far out); any value that could be such a reading is accepted (ties favour the student). Otherwise a value
   * clearly nearer the scale reading (true + z) was not corrected, and one clearly nearer reading + z (true + 2z)
   * had the zero error added instead of subtracted.
   */
  function zeroErrorReject(ctx, v) {
    var p = ctx.params || {};
    var z = p.vernierZero, res = isNum(p.vernierRes) ? p.vernierRes : 0.1;
    if (!isNum(z) || z === 0 || !isNum(p.d) || !isNum(v.si)) return null;
    var typed = v.si * 1000, trueMm = p.d * 10;
    var dTrue = Math.abs(typed - trueMm);
    if (dTrue < res / 2 + SQUEEZE_MM - 1e-6) return null;              // could be a correct, corrected reading
    var dScale = Math.abs(typed - (trueMm + z));         // the scale reading, not corrected
    var dAdded = Math.abs(typed - (trueMm + 2 * z));     // reading + zero error
    if (dAdded < dScale && dAdded < dTrue - SQUEEZE_MM) {
      return 'the zero error has been added instead of subtracted: the callipers have a zero error of ' + signedMm(z, res) +
        ' mm, so corrected reading = reading − (' + signedMm(z, res) + ' mm)';
    }
    if (dScale < dTrue - SQUEEZE_MM) {
      return 'this is the scale reading: the callipers have a zero error of ' + signedMm(z, res) + ' mm, so subtract it ' +
        '(corrected reading = reading − zero error)';
    }
    return null;
  }

  /* ------------------------------------------------------------------ mark-point builders */

  /**
   * L recorded to the nearest mm with a unit, within ±0.3 cm of the pendulum's length at the time, and within
   * o.window cm of the length the question asks for (o.nominal, cm).
   */
  function lengthPoint(o) {
    return M().points.custom({
      id: o.id, part: o.part, skill: 'MMO', max: 1, label: o.label,
      check: function (ctx) {
        var raw = firstAnswer(ctx, o.key);
        if (!raw) return res(0, '✗ No value given for ' + o.name + '.');
        var vu = ctx.vu(raw, WITH_UNC);
        if (!vu.ok) return res(0, '✗ “' + raw + '” could not be read as a length with a unit.');
        if (!vu.unitStr || !vu.unit || !vu.unit.ok) return res(0, '✗ ' + o.name + ' = ' + raw + ': no unit given.');
        if (!dimsIs(vu.unit, { m: 1 })) return res(0, '✗ ' + o.name + ' = ' + raw + ': ' + vu.unitStr + ' is not a unit of length.');
        var problems = [];
        var unit = vu.unit.canonical || vu.unitStr;
        if (isNum(o.nominal) && isNum(o.window) && Math.abs(vu.si * 100 - o.nominal) > o.window + 1e-9) {
          return res(0, '✗ ' + o.name + ' = ' + raw + ': the question asks you to set ' + o.name + ' to about ' + o.nominal + ' cm.',
            { typedCm: vu.si * 100, nominalCm: o.nominal });
        }
        var needDp = util().requiredDp(0.001 / vu.unit.factor);
        if (vu.num.dp !== needDp) {
          problems.push(o.name + ' should be recorded to the nearest millimetre (' + needDp + ' d.p. in ' + unit + ')');
        }
        var Lcm = vu.si * 100;
        var cands = lengthCandidates(ctx);
        var best = nearest(cands, Lcm);
        var details = { typedCm: Lcm, nearestTrueCm: best };
        if (!isNum(best)) problems.push('no measurement of the pendulum was found in your lab record');
        else if (Math.abs(best - Lcm) > TOL_L_CM + 1e-9) {
          problems.push('the pendulum length at the time was ' + best.toFixed(1) + ' cm, so your value is more than 3 mm out ' +
            '(line up the zero of the rule with the bottom of the cork, and put your eye level with each end before reading it)');
        }
        if (problems.length) return res(0, '✗ ' + o.name + ' = ' + raw + ': ' + problems.join('; ') + '.', details);
        return res(1, '✓ ' + o.name + ' = ' + raw + ': to the nearest mm, with a unit, and within 3 mm of the length of the pendulum.', details);
      }
    });
  }

  /**
   * Q1 (c): the lab record shows at least two timings of ≥ 10 oscillations at this length, and T is within 3 %.
   */
  function timingAndPeriodPoint() {
    return M().points.custom({
      id: 'T', part: 'c', skill: 'MMO', max: 1,
      label: 'Repeated timings of at least 10 oscillations; T within 3 %',
      check: function (ctx) {
        var Lcm = lengthCm(ctx, 'L');
        var events = timingEvents(ctx, Lcm, 50);
        // timings are counted per reset cycle (a stop without a reset is not a new timing)
        var timings = isNum(Lcm) ? timingsNear(ctx, Lcm, 1.0) : timingsNear(ctx, 50, 10);
        var longOnes = timings.filter(function (e) { return e.oscillationsTrue >= MIN_OSC; });
        var Ttrue = trueT(ctx, isNum(Lcm) ? Lcm : 50, events);
        var T = timeS(ctx, 'T');
        var problems = [];
        if (!timings.length) problems.push('your lab record shows no stopwatch timings at this length');
        else if (longOnes.length < 2) {
          var most = Math.max.apply(null, timings.map(function (e) { return e.oscillationsTrue; }));
          problems.push(longOnes.length === 1 ? 'only one timing of 10 or more oscillations: repeat the timing'
            : 'your timings were of about ' + Math.round(most) + ' oscillation' + (Math.round(most) === 1 ? '' : 's') +
              ': time at least 10 oscillations and repeat');
        }
        if (!isNum(T)) problems.push('no value of T given (in s)');
        else if (Math.abs(T - Ttrue) > TOL_T * Ttrue) problems.push('T = ' + firstAnswer(ctx, 'T') + ' is not within 3 % of the period of the pendulum (' + Ttrue.toFixed(3) + ' s)');
        var details = { timings: timings.length, longTimings: longOnes.length, trueT: Ttrue, typedT: T };
        if (problems.length) return res(0, '✗ ' + cap(problems.join('; ')) + '.', details);
        return res(1, '✓ ' + longOnes.length + ' timings of at least 10 oscillations, and T is within 3 % of the true period.', details);
      }
    });
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /**
   * Number of oscillations and two raw times present (optionally: n ≥ 10 and t/n consistent with T; withLength:
   * L<set> given with a unit of length, and within lengthWindow cm of the nominal length when lengthWindow is set).
   */
  function rawTimesPoint(o) {
    return M().points.custom({
      id: o.id, part: o.part, skill: 'MMO', max: 1, label: o.label,
      check: function (ctx) {
        var n = countOf(ctx, 'n' + o.set);
        var ta = timeS(ctx, 't' + o.set + 'a'), tb = timeS(ctx, 't' + o.set + 'b');
        var problems = [];
        if (o.withLength) {
          var rawL = firstAnswer(ctx, 'L' + o.set);
          var vuL = rawL ? ctx.vu(rawL, WITH_UNC) : null;
          var nameL = 'L' + (o.set === 1 ? '₁' : '₂');
          if (!rawL) problems.push('no value of ' + nameL + ' given');
          else if (!vuL.ok || !vuL.unitStr || !dimsIs(vuL.unit, { m: 1 })) problems.push(nameL + ' needs a value and a unit of length');
          else if (isNum(o.lengthWindow) && Math.abs(vuL.si * 100 - o.nominal) > o.lengthWindow + 1e-9) {
            problems.push(nameL + ' = ' + rawL + ': the question asks you to set ' + nameL + ' to about ' + o.nominal + ' cm');
          }
        }
        if (!isNum(n)) problems.push('the number of oscillations timed is not given');
        else if (o.requireTen && n < 10) problems.push('time at least 10 oscillations (you timed ' + n + ')');
        if (!isNum(ta) || !isNum(tb)) problems.push('two raw timings (repeated readings) are needed');
        var details = { n: n, ta: ta, tb: tb };
        if (!problems.length && o.checkConsistency) {
          var Lcm = lengthCm(ctx, 'L' + o.set);
          var Ttrue = trueT(ctx, isNum(Lcm) ? Lcm : o.nominal, timingEvents(ctx, Lcm, o.nominal));
          details.trueT = Ttrue;
          [ta, tb].forEach(function (t) {
            if (Math.abs(t / n - Ttrue) > 0.1 * Ttrue && problems.length === 0) {
              problems.push('a time of ' + t + ' s is not consistent with ' + n + ' oscillations of this pendulum');
            }
          });
        }
        if (problems.length) return res(0, '✗ ' + cap(problems.join('; ')) + '.', details);
        return res(1, '✓ ' + (o.okText || 'Repeated raw timings of ' + n + ' oscillations recorded.'), details);
      }
    });
  }

  /** T within 3 % of the true period at the length typed under key L<set>. */
  function periodPoint(o) {
    return M().points.custom({
      id: o.id, part: o.part, skill: 'MMO', max: 1, label: o.label,
      check: function (ctx) {
        var key = 'T' + o.set, name = 'T' + (o.set === 1 ? '₁' : '₂');
        var T = timeS(ctx, key);
        if (!isNum(T)) return res(0, '✗ No value of ' + name + ' given (in s).');
        var Lcm = lengthCm(ctx, 'L' + o.set);
        var events = timingEvents(ctx, Lcm, o.nominal);
        var Ttrue = trueT(ctx, isNum(Lcm) ? Lcm : o.nominal, events);
        var details = { trueT: Ttrue, typedT: T };
        if (Math.abs(T - Ttrue) > TOL_T * Ttrue) {
          return res(0, '✗ ' + name + ' = ' + firstAnswer(ctx, key) + ' is not within 3 % of the period of the pendulum (' + Ttrue.toFixed(3) + ' s).', details);
        }
        return res(1, '✓ ' + name + ' is within 3 % of the true period.', details);
      }
    });
  }

  /** Factor converting a graph axis value to SI, from the heading unit of the plotted column. */
  function axisFactor(ctx, axisName) {
    var g = ctx.graph, colId = g && g[axisName] && g[axisName].colId;
    var d = colId && ctx.colInfo && ctx.colInfo.details ? ctx.colInfo.details[colId] : null;
    return d && d.unit && d.unit.ok ? d.unit.factor : NaN;
  }

  /**
   * Does a typed value (e.g. a = 0.0402 s² cm⁻¹) equal a reference answer (e.g. the gradient), allowing for a
   * conversion of units? refFactor converts the reference number to SI when it has no unit of its own.
   */
  function matchesReference(ctx, typedRaw, refRaw, refFactor, dims) {
    if (!typedRaw || !refRaw) return false;
    var a = ctx.vu(typedRaw), r = ctx.vu(refRaw);
    if (!a.ok || !r.ok) return false;
    var SF = VL.sigfig;
    // the same number, copied with or without a unit
    if (SF.agreesWithin(a.valueStr, r.num.value, 0.01) || SF.agreesWithin(r.valueStr, a.num.value, 0.01)) return true;
    // a converted value
    var aHasUnit = a.unitStr && a.unit && a.unit.ok && dimsIs(a.unit, dims);
    if (!aHasUnit) return false;
    var refSI = [];
    if (r.unitStr && r.unit && r.unit.ok && dimsIs(r.unit, dims)) refSI.push(r.si);
    if (isNum(refFactor)) refSI.push(r.num.value * refFactor);
    return refSI.some(function (v) { return v !== 0 && Math.abs(a.si - v) <= 0.01 * Math.abs(v); });
  }

  /** SI value of a quantity read from the graph (gradient, intercept): its own unit, else × the axis factor. */
  function graphRefSI(ctx, refRaw, factor, dims) {
    var r = refRaw ? ctx.vu(refRaw) : null;
    if (!r || !r.ok) return NaN;
    if (r.unitStr && r.unit && r.unit.ok) return dimsIs(r.unit, dims) ? r.si : NaN;
    return isNum(factor) ? r.num.value * factor : NaN;
  }

  /**
   * Is a value typed with a unit (a, b) consistent with the graph quantity it was taken from (gradient, intercept)?
   * Judged only when the typed number is that quantity's number times a power of ten (copied, or converted),
   * because only then does the unit say which value was meant.
   * @returns {null|{ok: boolean, expected: number, refSI: number, unit: string}} expected: in the typed unit
   */
  function unitConsistency(ctx, typedRaw, refRaw, factor, dims) {
    var a = typedRaw ? ctx.vu(typedRaw) : null;
    if (!a || !a.ok || !a.unitStr || !dimsIs(a.unit, dims) || !a.num.value) return null;
    var refSI = graphRefSI(ctx, refRaw, factor, dims);
    if (!isNum(refSI) || refSI === 0) return null;
    var ratio = a.num.value / ctx.vu(refRaw).num.value;
    var k = ratio > 0 ? Math.round(Math.log(ratio) / Math.LN10) : NaN;
    if (!isNum(k) || Math.abs(ratio / Math.pow(10, k) - 1) > 0.05) return null;
    var half = 0.5 * Math.pow(10, -a.num.dp) * a.unit.factor;
    return { ok: Math.abs(a.si - refSI) <= 0.05 * Math.abs(refSI) + half, expected: refSI / a.unit.factor, refSI: refSI,
      unit: a.unit.canonical || a.unitStr };
  }

  /** 'cm' → 'cm⁻¹', 'm²' → 'm⁻²', 'cm⁻¹' → 'cm' (a unit written as its reciprocal). */
  function invUnit(u) {
    var SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
    return str(u).split(/\s+/).filter(Boolean).map(function (tok) {
      var m = /^(.*?)(⁻?)([⁰¹²³⁴⁵⁶⁷⁸⁹]*)$/.exec(tok);
      if (!m[3]) return m[2] ? m[1] : tok + '⁻¹';
      if (m[2]) return m[3] === '¹' ? m[1] : m[1] + m[3];
      return m[1] + '⁻' + m[3];
    }).join(' ');
  }

  /** Unit of a plotted axis column for comments ('' if unknown). */
  function axisUnitText(ctx, axisName) {
    var colId = ctx.graph && ctx.graph[axisName] && ctx.graph[axisName].colId;
    return colId ? util().unitTextOf(ctx, colId) : '';
  }

  /**
   * a and b checked against the gradient and intercept they were taken from, in the units the student gave them
   * (e.g. a gradient of 0.0403 from an L axis in cm is 0.0403 s² cm⁻¹ = 4.03 s² m⁻¹, not 0.0403 s² m⁻¹).
   * @returns {{a: object|null, b: object|null, problems: string[]}} a / b: unitConsistency results
   */
  function abConsistency(ctx) {
    var fx = axisFactor(ctx, 'x'), fy = axisFactor(ctx, 'y');
    var gRaw = firstAnswer(ctx, 'gradient');
    var cRaw = firstAnswer(ctx, 'intercept') || str(ctx.graph && ctx.graph.intercept && ctx.graph.intercept.value).trim();
    var aRaw = firstAnswer(ctx, 'a'), bRaw = firstAnswer(ctx, 'b');
    var out = { a: null, b: null, problems: [] };
    if (!isNum(fx) || !isNum(fy)) return out;
    out.a = unitConsistency(ctx, aRaw, gRaw, fy / fx, { s: 2, m: -1 });
    out.b = unitConsistency(ctx, bRaw, cRaw, fy, { s: 2 });
    var xU = axisUnitText(ctx, 'x'), yU = axisUnitText(ctx, 'y');
    var gq = util().graphQuantities(ctx);
    var xName = gq.x ? util().nameOf(ctx, gq.x) : 'x', yName = gq.y ? util().nameOf(ctx, gq.y) : 'y';
    var bare = function (raw) { var v = ctx.vu(raw); return !(v.unitStr && v.unit && v.unit.ok); };
    if (out.a && !out.a.ok) {
      out.problems.push('a = ' + aRaw + ': your gradient ' + gRaw + (bare(gRaw) && xU && yU
        ? ' is in ' + yU + ' ' + invUnit(xU) + ' because ' + xName + ' is plotted in ' + xU : '') + ', so with the unit ' + out.a.unit + ' a would be ' + fmt(out.a.expected, Math.max(2, ctx.vu(gRaw).num.sf || 3)));
    }
    if (out.b && !out.b.ok) {
      out.problems.push('b = ' + bRaw + ': your y-intercept ' + cRaw + (bare(cRaw) && yU ? ' is in ' + yU + ' because ' + yName + ' is plotted in ' + yU : '') +
        ', so with the unit ' + out.b.unit + ' b would be ' + fmt(out.b.expected, Math.max(2, ctx.vu(cRaw).num.sf || 3)));
    }
    return out;
  }

  /**
   * g answer: unit m s⁻², 2–3 s.f. (unless opts.requireSf is false), in range, and consistent (ECF) with one of the
   * SI values in `expectedFromSI`. opts.unitNote: the value g comes from had a unit with the wrong dimensions; a
   * consistent g is still credited, and an inconsistent one is explained with this note.
   */
  function checkG(ctx, expectedFromSI, range, label, opts) {
    opts = opts || {};
    var raw = firstAnswer(ctx, 'g');
    if (!raw) return res(0, '✗ No value of g given.');
    var vu = ctx.vu(raw);
    if (!vu.ok) return res(0, '✗ “' + raw + '” could not be read as a value with a unit.');
    var problems = [];
    if (!vu.unitStr || !vu.unit || !vu.unit.ok) problems.push('no unit given (m s⁻²)');
    else if (!dimsIs(vu.unit, { m: 1, s: -2 })) problems.push('the unit should be m s⁻²');
    if (opts.requireSf !== false) {
      var sfOk = false;
      for (var s = vu.num.sfMin || vu.num.sf; s <= vu.num.sf; s++) if (s === 2 || s === 3) sfOk = true;
      if (!sfOk) problems.push('give g to 2 or 3 significant figures (you gave ' + vu.num.sf + ')');
    }
    var gSI = vu.unit && vu.unit.ok && dimsIs(vu.unit, { m: 1, s: -2 }) ? vu.si : vu.num.value;
    if (!(gSI >= range[0] && gSI <= range[1])) {
      problems.push('the value is not within the accepted range (' + range[0].toFixed(2) + '–' + range[1].toFixed(2) + ' m s⁻²)');
    }
    var halfUnit = 0.5 * Math.pow(10, -vu.num.dp) * (vu.unit && vu.unit.ok ? vu.unit.factor : 1);
    var expected = expectedFromSI.filter(isNum);
    var consistent = expected.some(function (e) { return Math.abs(gSI - e) <= Math.max(halfUnit, 0.02 * e); });
    if (!expected.length) problems.push('g cannot be checked because ' + (opts.unitNote || label + ' is missing or unreadable'));
    else if (!consistent) {
      problems.push('g does not follow from your value of ' + label + ' (expected about ' + fmt(expected[0]) + ' m s⁻²)' +
        (opts.unitNote ? '; ' + opts.unitNote : ''));
    }
    var details = { gSI: gSI, expected: expected };
    if (problems.length) return res(0, '✗ g = ' + raw + ': ' + problems.join('; ') + '.', details);
    return res(1, '✓ g = ' + raw + ': calculated correctly from ' + label + ', with a unit' +
      (opts.requireSf !== false ? ' and a suitable number of s.f.' : '') + '.', details);
  }

  /**
   * SI values a quantity like a or k (s² m⁻¹) could have: from its unit, or as s² m⁻¹ / s² cm⁻¹ when no unit is
   * given or the unit has the wrong dimensions (e.g. '4.08 s m⁻¹': the number is still carried forward).
   */
  function perMetreCandidates(ctx, key) {
    var raw = firstAnswer(ctx, key);
    if (!raw) return [];
    var vu = ctx.vu(raw, WITH_UNC);
    if (!vu.ok || !vu.num.value) return [];
    if (vu.unitStr && vu.unit && vu.unit.ok && dimsIs(vu.unit, { s: 2, m: -1 })) return [vu.si];
    return [vu.num.value, vu.num.value * 100];
  }

  /** The answer has a unit, but not one of s² m⁻¹ dimensions. */
  function wrongPerMetreUnit(ctx, key) {
    var raw = firstAnswer(ctx, key);
    var vu = raw ? ctx.vu(raw, WITH_UNC) : null;
    return !!(vu && vu.ok && vu.unitStr && !(vu.unit && vu.unit.ok && dimsIs(vu.unit, { s: 2, m: -1 })));
  }

  /* ------------------------------------------------------------------ rubrics */

  function readingsTrend(sets, ctx) {
    var rows = ctx.table && ctx.table.rows ? ctx.table.rows : [];
    var pts = [];
    sets.forEach(function (s) {
      var row = rows[s.rowNumber - 1];
      if (!row) return;
      var rv = util().rowValues(ctx, row);
      var y = isNum(rv.T) ? rv.T : isNum(rv.T2) ? rv.T2 : isNum(rv.tMean) ? rv.tMean : rv.t;
      if (isNum(y) && isNum(s.x)) pts.push({ x: s.x, y: y });
    });
    if (pts.length < 2) return true;
    var f = VL.stats && VL.stats.linearFit ? VL.stats.linearFit(pts.map(function (p) { return p.x; }), pts.map(function (p) { return p.y; })) : null;
    return !f || !isNum(f.m) || f.m > 0;
  }

  function rubricGraph() {
    var P = M().points;
    return [
      P.answerValue({
        id: 'd', part: 'a', skill: 'MMO', key: 'd', name: 'd', label: 'Diameter d from the vernier callipers',
        dims: { m: 1 }, unitHint: 'cm or mm',
        range: function (ctx) { return [(ctx.params.d - TOL_D_CM) / 100, (ctx.params.d + TOL_D_CM) / 100]; },
        dpOf: function (ctx) { return ctx.params.vernierRes / 1000; },
        reject: zeroErrorReject
      }),
      lengthPoint({ id: 'L', part: 'b', key: 'L', name: 'L', nominal: 50, window: L_WINDOW, label: 'L measured to the nearest mm, with a unit' }),
      timingAndPeriodPoint(),
      P.readingsCount({ id: 'readings', part: 'd', skill: 'MMO', max: 3, full: 6, xQ: 'L', yQs: [['t', 'tMean', 'T']], trend: readingsTrend,
        label: 'Six sets of readings of L and t' }),
      P.range({ id: 'range', part: 'd', skill: 'MMO', xQ: 'L', minSpanSI: 0.40, label: 'Range of L at least 40 cm' }),
      P.headings({ id: 'headings', part: 'd', skill: 'PDO', exampleQ: 'L', label: 'Column headings with quantity and unit' }),
      P.rawConsistency({ id: 'raw-L', part: 'd', skill: 'PDO', q: 'L', resolutionSI: 0.001, label: 'Raw values of L to the nearest mm' }),
      P.derivedSF({ id: 'sf-T2', part: 'd', skill: 'PDO', q: 'T2', from: ['t'], rawName: 'the raw times', label: 'Significant figures of T²' }),
      P.calc({ id: 'calc-T2', part: 'd', skill: 'PDO', q: 'T2', label: 'T² calculated correctly',
        compute: function (rv) {
          if (isNum(rv.T)) return rv.T * rv.T;
          // no T column: T from the raw times and the number of oscillations (rv.t is already the mean of t₁, t₂ ...)
          var tt = isNum(rv.tMean) ? rv.tMean : rv.t;
          return isNum(tt) && isNum(rv.n) && rv.n > 0 ? Math.pow(tt / rv.n, 2) : NaN;
        } }),
      P.axes({ id: 'axes', part: 'e-i', skill: 'PDO', xQ: 'L', yQ: 'T2' }),
      P.plotting({ id: 'plotting', part: 'e-i', skill: 'PDO' }),
      P.quality({ id: 'quality', part: 'e-i', skill: 'MMO', xQ: 'L', yQ: 'T2', label: 'Quality: points close to a straight line',
        tolY: function (ctx, extra) {
          var ys = extra && extra.ys ? extra.ys : [];
          var span = ys.length ? Math.max.apply(null, ys) - Math.min.apply(null, ys) : 0;
          return Math.max(0.04, 0.01 * span);
        } }),
      P.bestFit({ id: 'best-fit', part: 'e-ii', skill: 'PDO' }),
      P.gradient({ id: 'gradient', part: 'e-iii', skill: 'ACE', sign: 1, xQ: 'L', yQ: 'T2' }),
      P.intercept({ id: 'intercept', part: 'e-iii', skill: 'ACE', xQ: 'L', yQ: 'T2' }),
      P.custom({
        id: 'ab-values', part: 'f', skill: 'ACE', max: 1, label: 'a = gradient and b = y-intercept',
        check: function (ctx) {
          // a and b come from the graph of T² against L; the gradient of any other graph is not a
          var wrong = util().wrongGraphComment(ctx, { xQ: 'L', yQ: 'T2' });
          if (wrong) return res(0, wrong);
          var aRaw = firstAnswer(ctx, 'a'), bRaw = firstAnswer(ctx, 'b');
          var gRaw = firstAnswer(ctx, 'gradient'), cRaw = firstAnswer(ctx, 'intercept') || str(ctx.graph && ctx.graph.intercept && ctx.graph.intercept.value).trim();
          var fx = axisFactor(ctx, 'x'), fy = axisFactor(ctx, 'y');
          var problems = [];
          if (!aRaw || !bRaw) problems.push('values of both a and b are needed');
          else {
            if (!matchesReference(ctx, aRaw, gRaw, fy / fx, { s: 2, m: -1 })) problems.push('the value of a should equal your gradient' + (gRaw ? ' (' + gRaw + ')' : ''));
            if (!matchesReference(ctx, bRaw, cRaw, fy, { s: 2 })) problems.push('the value of b should equal your y-intercept' + (cRaw ? ' (' + cRaw + ')' : ''));
          }
          if (problems.length) return res(0, '✗ ' + cap(problems.join('; ')) + '.');
          return res(1, '✓ a and b taken from your gradient and y-intercept.');
        }
      }),
      P.custom({
        id: 'ab-units', part: 'f', skill: 'ACE', max: 1, label: 'Units of a and b',
        check: function (ctx) {
          var a = ctx.vu(firstAnswer(ctx, 'a')), b = ctx.vu(firstAnswer(ctx, 'b'));
          var problems = [];
          if (!a.ok || !a.unitStr || !dimsIs(a.unit, { s: 2, m: -1 })) problems.push('the unit of a should be s² cm⁻¹ or s² m⁻¹');
          if (!b.ok || !b.unitStr || !dimsIs(b.unit, { s: 2 })) problems.push('the unit of b should be s²');
          if (problems.length) return res(0, '✗ ' + cap(problems.join('; ')) + '.');
          // the unit must also suit the value: a gradient from an L axis in cm is in s² cm⁻¹
          var mismatch = abConsistency(ctx).problems;
          if (mismatch.length) return res(0, '✗ ' + mismatch.join('; ') + '.');
          return res(1, '✓ Correct units for a and b.');
        }
      }),
      P.custom({
        id: 'g', part: 'g', skill: 'ACE', max: 1, label: 'g = 4π²/a with unit and 2–3 s.f.',
        check: function (ctx) {
          var cands = perMetreCandidates(ctx, 'a');
          var gr = ctx.vu(firstAnswer(ctx, 'gradient'));
          var fx = axisFactor(ctx, 'x'), fy = axisFactor(ctx, 'y');
          var gradSI = gr.ok && isNum(fx) && isNum(fy) ? gr.num.value * fy / fx : NaN;
          var ac = abConsistency(ctx).a;
          var wrongUnit = wrongPerMetreUnit(ctx, 'a');
          // a's unit contradicts its value (marked in (f)): carry forward the gradient converted to SI instead
          if (ac && !ac.ok) cands = [ac.refSI].concat(cands);
          // no a, or a with a unit of the wrong dimensions: the gradient converted to SI is also accepted
          if ((!cands.length || wrongUnit) && isNum(gradSI)) cands = cands.concat([gradSI]);
          return checkG(ctx, cands.filter(function (v) { return v > 0; }).map(function (v) { return FOUR_PI2 / v; }),
            [G_TRUE * 0.9, G_TRUE * 1.1], 'a', { unitNote: wrongUnit ? 'the unit of a is wrong (it should be s² cm⁻¹ or s² m⁻¹)' : '' });
        }
      })
    ];
  }

  function kSI(ctx, set) {
    var T = timeS(ctx, 'T' + set), L = lengthCm(ctx, 'L' + set), d = lengthCm(ctx, 'd');
    if (!isNum(T) || !isNum(L) || !isNum(d)) return NaN;
    return T * T / ((L + d / 2) / 100);
  }

  function rubricTwoPoint() {
    var P = M().points;
    var bank = BANK;
    return [
      P.answerValue({
        id: 'd', part: 'a', skill: 'MMO', key: 'd', name: 'd', label: 'Diameter d from the vernier callipers',
        dims: { m: 1 }, unitHint: 'cm or mm',
        range: function (ctx) { return [(ctx.params.d - TOL_D_CM) / 100, (ctx.params.d + TOL_D_CM) / 100]; },
        dpOf: function (ctx) { return ctx.params.vernierRes / 1000; },
        reject: zeroErrorReject
      }),
      P.percentUncertainty({
        id: 'd-uncertainty', part: 'b', skill: 'ACE', absKey: 'dAbs', pctKey: 'dPct', valueKey: 'd', name: 'd',
        absRangeSI: function (ctx) { return ctx.params.vernierRes === 0.02 ? [0.00002, 0.0005] : [0.0001, 0.0005]; }
      }),
      lengthPoint({ id: 'L1', part: 'c-i', key: 'L1', name: 'L₁', nominal: 30, window: L_WINDOW, label: 'L₁ measured to the nearest mm, with a unit' }),
      rawTimesPoint({ id: 'raw-times-1', part: 'c-ii', set: 1, nominal: 30, requireTen: true, checkConsistency: true,
        label: 'Repeated timings of at least 10 oscillations' }),
      periodPoint({ id: 'T1', part: 'c-ii', set: 1, nominal: 30, label: 'T₁ within 3 % of the true period' }),
      rawTimesPoint({ id: 'set-2', part: 'd', set: 2, nominal: 80, withLength: true, lengthWindow: L_WINDOW, label: 'Second length and raw timings recorded',
        okText: 'Second length and repeated raw timings recorded.' }),
      periodPoint({ id: 'T2', part: 'd', set: 2, nominal: 80, label: 'T₂ within 3 % of the true period' }),
      P.custom({
        id: 'trend', part: 'd', skill: 'MMO', max: 1, label: 'Trend: T₂ > T₁ for the longer length',
        check: function (ctx) {
          var T1 = timeS(ctx, 'T1'), T2 = timeS(ctx, 'T2'), L1 = lengthCm(ctx, 'L1'), L2 = lengthCm(ctx, 'L2');
          if (!isNum(T1) || !isNum(T2)) return res(0, '✗ Both T₁ and T₂ are needed to judge the trend.');
          if (isNum(L1) && isNum(L2) && L2 < L1) {
            return T2 < T1 ? res(1, '✓ The longer pendulum has the longer period.') : res(0, '✗ The longer pendulum should have the longer period.');
          }
          return T2 > T1 ? res(1, '✓ T₂ > T₁: the longer pendulum has the longer period.') : res(0, '✗ T₂ should be greater than T₁ for the longer length.');
        }
      }),
      P.answerCalc({
        id: 'k-values', part: 'e-i', skill: 'PDO', keys: ['k1', 'k2'], names: ['first value of k', 'second value of k'],
        dims: { s: 2, m: -1 }, unitHint: 's² m⁻¹',
        label: 'Both values of k calculated correctly',
        compute: function (ctx, key) { return kSI(ctx, key === 'k1' ? 1 : 2); }
      }),
      P.sfJustification({ id: 'sf-justification', part: 'e-ii', skill: 'PDO', key: 'sfJust', rawWords: ['L', 'd', 't', 'T', 'time', 'length', 'diameter'] }),
      P.conclusion({ id: 'conclusion', part: 'f', skill: 'ACE', k1Key: 'k1', k2Key: 'k2', key: 'conclusion' }),
      P.custom({
        id: 'g', part: 'g', skill: 'ACE', max: 1, label: 'g = 4π²/k̄ with a unit',
        check: function (ctx) {
          var c1 = perMetreCandidates(ctx, 'k1'), c2 = perMetreCandidates(ctx, 'k2');
          var exp = [];
          c1.forEach(function (a, i) {
            if (isNum(c2[i])) exp.push(FOUR_PI2 / ((a + c2[i]) / 2));
            exp.push(FOUR_PI2 / a);
          });
          c2.forEach(function (b) { exp.push(FOUR_PI2 / b); });
          var wrongUnit = wrongPerMetreUnit(ctx, 'k1') || wrongPerMetreUnit(ctx, 'k2');
          // the paper asks only for a unit here (no s.f. condition, unlike Q1 (g))
          return checkG(ctx, exp.filter(isNum), [G_TRUE * 0.85, G_TRUE * 1.15], 'k',
            { requireSf: false, unitNote: wrongUnit ? 'the unit of k is wrong (it should be s² m⁻¹)' : '' });
        }
      }),
      P.limitationsImprovements({ id: 'evaluation', limKey: 'limitations', impKey: 'improvements', bank: bank,
        limPart: 'h-i', impPart: 'h-ii', maxEach: 4, skill: 'ACE' })
    ];
  }

  /**
   * Mark points for a variant (part ids match the paper; totals match the spec tables).
   * @param {string} variantId
   * @returns {Array} MarkPoint[] (limitations/improvements as a nested pair, flattened by the runner)
   */
  function rubric(variantId) {
    return variantId === 'twopoint' ? rubricTwoPoint() : rubricGraph();
  }

  /* ================================================================== model answer */

  /** Vernier reading a careful student takes of the spare bob, corrected for zero error (cm string). */
  function modelDiameter(params, rng) {
    var resMm = params.vernierRes, z = params.vernierZero || 0;
    // a careful student: the jaws squeeze the bob by less than 0.01 mm, so the reading never sits exactly half a
    // division from the true diameter (where it could not be told apart from an uncorrected reading)
    var squeeze = VL.noise ? clamp(VL.noise.gauss(rng, 0.005), -0.009, 0.009) : 0;
    var reading = Math.round((params.d * 10 + z + squeeze) / resMm) * resMm;
    var dMm = reading - z;
    var dpCm = resMm === 0.02 ? 3 : 2;
    return { str: (dMm / 10).toFixed(dpCm) + ' cm', cm: dMm / 10, zeroReading: z, readingMm: reading, dpCm: dpCm };
  }

  /** Two stopwatch timings of n oscillations (display values, truncated to 0.01 s) and the matching log events. */
  function modelTimings(params, Lcm, n, amplitudeDeg, rng, tStart) {
    var T = period(Lcm, params.d, params.delta, amplitudeDeg);
    var times = [], events = [];
    for (var i = 0; i < 2; i++) {
      var err = VL.noise ? VL.noise.gauss(rng, 0.08) : 0;
      var t = n * T + err;
      var shown = Math.floor(t * 100 + 1e-6) / 100;
      times.push(shown.toFixed(2));
      events.push({ t: tStart + i * 40000 + 2000, type: 'stopwatch-start', L: Lcm, T: round(T, 5), amplitudeDeg: amplitudeDeg, swinging: true });
      events.push({ t: tStart + i * 40000 + 2000 + Math.round(t * 1000), type: 'stopwatch-stop', shown: shown.toFixed(2),
        elapsedTrue: round(t, 4), oscillationsTrue: round(t / T, 3), amplitudeDeg: amplitudeDeg, L: Lcm, T: round(T, 5), swinging: true });
      events.push({ t: tStart + i * 40000 + 3000 + Math.round(t * 1000), type: 'stopwatch-reset', shown: '0.00' });
    }
    return { times: times, events: events, T: T };
  }

  function makeTable(headings, rows) {
    var DT = VL.datatable;
    var t;
    if (DT && DT.create) {
      t = DT.create({ columns: headings.length, rows: rows.length });
      headings.forEach(function (hd, i) { DT.setHeading(t, t.columns[i].id, hd); });
      rows.forEach(function (r, ri) {
        r.forEach(function (v, ci) { DT.setCell(t, t.rows[ri].id, t.columns[ci].id, v); });
      });
      return t;
    }
    t = { columns: [], rows: [], nextId: 1 };
    headings.forEach(function (hd, i) { t.columns.push({ id: 'c' + (i + 1), heading: hd }); });
    rows.forEach(function (r, i) {
      var cells = {};
      r.forEach(function (v, j) { cells['c' + (j + 1)] = v; });
      t.rows.push({ id: 'r' + (i + 1), cells: cells });
    });
    t.nextId = Math.max(headings.length, rows.length) + 1;
    return t;
  }

  /** Contract-shaped graph when core/graph.js is unavailable (least-squares line, triangle, read-offs). */
  function fallbackGraph(table, xId, yId) {
    var xs = [], ys = [], ids = [];
    table.rows.forEach(function (r) {
      var x = parseFloat(r.cells[xId]), y = parseFloat(r.cells[yId]);
      if (isNum(x) && isNum(y)) { xs.push(x); ys.push(y); ids.push(r.id); }
    });
    var n = xs.length, mx = mean(xs), my = mean(ys), sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
    var m = sxy / sxx, c = my - m * mx;
    var gx = { colId: xId, label: 'L / cm', origin: 0, perLarge: 10, labelEvery: 1 };
    var gy = { colId: yId, label: 'T² / s²', origin: 0, perLarge: 0.5, labelEvery: 1 };
    var pts = ids.map(function (id, k) { return { id: 'p' + (k + 1), rowId: id, gx: xs[k], gy: ys[k] / 0.05, anomaly: false }; });
    var x1 = 20, x2 = 120;
    return {
      grid: { cols: 14, rows: 10, small: 10 }, x: gx, y: gy, points: pts,
      line: { a: { gx: 10, gy: (m * 10 + c) / 0.05 }, b: { gx: 130, gy: (m * 130 + c) / 0.05 } },
      triangle: { p1: { gx: x1, gy: (m * x1 + c) / 0.05 }, p2: { gx: x2, gy: (m * x2 + c) / 0.05 } },
      readOffs: { x1: String(x1), y1: (m * x1 + c).toFixed(3), x2: String(x2), y2: (m * x2 + c).toFixed(3) },
      intercept: { method: 'direct', value: c.toFixed(3) }, worstLine: null, nextId: pts.length + 1
    };
  }

  /** Decimal places of a typed number ('0.86' → 2). */
  function dpOfStr(s) {
    var m = /\.(\d+)/.exec(String(s));
    return m ? m[1].length : 0;
  }

  /**
   * A careful student's line is balanced: if the least-squares line leaves the points unevenly spread about it
   * (possible with six points), shift it parallel by up to 1.5 small squares until VL.graph.checkLine accepts it,
   * moving the gradient-triangle vertices with it and re-reading the read-offs and the intercept.
   * @returns {object} the same graph (mutated)
   */
  function balanceLine(graph, table) {
    var Gr = VL.graph;
    if (!Gr || !Gr.checkLine || !graph || !graph.line || Gr.checkLine(graph, table).ok) return graph;
    var small = graph.grid.small, base = JSON.parse(JSON.stringify(graph));
    var steps = [];
    for (var k = 1; k <= 15; k++) steps.push(k / 10, -k / 10);
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      graph.line = { a: { gx: base.line.a.gx, gy: base.line.a.gy + s }, b: { gx: base.line.b.gx, gy: base.line.b.gy + s } };
      if (!Gr.checkLine(graph, table).ok) continue;
      if (base.triangle) {
        graph.triangle = { p1: { gx: base.triangle.p1.gx, gy: base.triangle.p1.gy + s }, p2: { gx: base.triangle.p2.gx, gy: base.triangle.p2.gy + s } };
        var dec = dpOfStr(base.readOffs.y1);
        graph.readOffs = {
          x1: base.readOffs.x1, x2: base.readOffs.x2,
          y1: Gr.gridToValue(graph.y, graph.triangle.p1.gy, small).toFixed(dec),
          y2: Gr.gridToValue(graph.y, graph.triangle.p2.gy, small).toFixed(dec)
        };
      }
      if (base.intercept && base.intercept.method === 'direct') {
        var y0 = Gr.lineValueAt(graph, 0);
        graph.intercept = { method: 'direct', value: y0 === null ? '' : y0.toFixed(dpOfStr(base.intercept.value)) };
      } else if (base.intercept && base.intercept.method === 'substitution') {
        var m = Gr.checkTriangle(graph).gradient;
        if (m !== null) {
          var c = parseFloat(graph.readOffs.y1) - m * parseFloat(graph.readOffs.x1);
          graph.intercept = { method: 'substitution', value: String(Number(c.toPrecision(3))) };
        }
      }
      return graph;
    }
    return Object.assign(graph, base);
  }

  function modelGraphQ1(params, rng) {
    var noteList = [];
    var dia = modelDiameter(params, rng);
    var lengths = [20, 35, 50, 65, 80, 95];
    var amp = 5;
    var log = [{ t: 5000, type: 'zero-check', instrument: 'vernier', zeroReadingMm: dia.zeroReading }];
    var rows = [], tAt = 60000, row50 = null;
    lengths.forEach(function (L) {
      log.push({ t: tAt, type: 'length-set', L: L });
      log.push({ t: tAt + 500, type: 'release', L: L, amplitudeDeg: amp });
      var tm = modelTimings(params, L, 20, amp, rng, tAt + 1000);
      tm.events.forEach(function (e) { log.push(e); });
      var Tm = (parseFloat(tm.times[0]) + parseFloat(tm.times[1])) / 2 / 20;
      var Tstr = sfFormat(Tm, 4);
      var T2str = sfFormat(parseFloat(Tstr) * parseFloat(Tstr), 4);
      var row = [L.toFixed(1), tm.times[0], tm.times[1], Tstr, T2str];
      rows.push(row);
      if (L === 50) row50 = row;
      tAt += 120000;
    });
    var table = makeTable(['L / cm', 't₁ / s', 't₂ / s', 'T / s', 'T² / s²'], rows);
    var xId = table.columns[0].id, yId = table.columns[4].id;
    var graph = VL.graph && VL.graph.modelGraph
      ? balanceLine(VL.graph.modelGraph(table, xId, yId, { xLabel: 'L / cm', yLabel: 'T² / s²' }), table)
      : fallbackGraph(table, xId, yId);
    var ro = graph.readOffs;
    var grad = (parseFloat(ro.y2) - parseFloat(ro.y1)) / (parseFloat(ro.x2) - parseFloat(ro.x1));
    var gradStr = sfFormat(grad, 3);
    var icStr = graph.intercept && graph.intercept.value ? graph.intercept.value : '';
    var aSI = parseFloat(gradStr) * 100;          // s² cm⁻¹ → s² m⁻¹
    var gVal = FOUR_PI2 / aSI;
    var answers = {
      d: dia.str,
      L: '50.0 cm',
      T_working: 't₁ = ' + row50[1] + ' s and t₂ = ' + row50[2] + ' s for 20 oscillations.\n' +
        'Mean time = ' + ((parseFloat(row50[1]) + parseFloat(row50[2])) / 2).toFixed(2) + ' s, so T = mean ÷ 20.',
      T: row50[3] + ' s',
      gradient: gradStr,
      intercept: icStr,
      a: gradStr + ' s² cm⁻¹',
      b: icStr + ' s²',
      g_working: 'a = ' + gradStr + ' s² cm⁻¹ = ' + sfFormat(aSI, 3) + ' s² m⁻¹\ng = 4π² / a = 39.48 / ' + sfFormat(aSI, 3),
      g: sfFormat(gVal, 3) + ' m s⁻²'
    };
    noteList.push('(a) Close the jaws first: the zero reading is ' + (dia.zeroReading ? (dia.zeroReading > 0 ? '+' : '') + dia.zeroReading + ' mm' : 'zero') +
      '. Grip the spare bob gently, read the main scale and the vernier, then subtract the zero error: d = ' + dia.str + '.');
    noteList.push('(b) Drag the metre rule next to the string with its zero at the bottom of the cork, with the eye level with the cork when reading the cork, and level with the top of the bob when reading the bob (the eye stays where it is when the view moves, so re-level it at each end). Read the top of the bob to the nearest mm.');
    noteList.push('(c) Release from about 5° from the vertical (a protractor reading of about 85° or 95°), switch on the fiducial marker, and time 20 oscillations starting as the bob passes the marker. Repeat and average.');
    noteList.push('(d) Lengths spread from 20 cm to 95 cm. Raw L to 0.1 cm, raw times to 0.01 s; T and T² to 4 s.f. (the raw times have 4 s.f.).');
    noteList.push('(e) Scales of 1, 2, 4 or 5 per large square so the points fill more than half the grid; every point plotted to within half a small square; a balanced line; a triangle covering more than half the line.');
    noteList.push('(f) Comparing T² = aL + b with y = mx + c: a = gradient (unit s² cm⁻¹ because L is in cm) and b = y-intercept (unit s²).');
    noteList.push('(g) Convert a to s² m⁻¹ before using g = 4π²/a, and give g to 2 or 3 s.f. with its unit.');
    return { table: table, graph: graph, answers: answers, notes: noteList, log: log };
  }

  function modelTwoPoint(params, rng) {
    var dia = modelDiameter(params, rng);
    var amp = 5, n = 20;
    var log = [{ t: 5000, type: 'zero-check', instrument: 'vernier', zeroReadingMm: dia.zeroReading }];
    var sets = [30, 80].map(function (L, i) {
      var tAt = 60000 + i * 150000;
      log.push({ t: tAt, type: 'length-set', L: L });
      log.push({ t: tAt + 500, type: 'release', L: L, amplitudeDeg: amp });
      var tm = modelTimings(params, L, n, amp, rng, tAt + 1000);
      tm.events.forEach(function (e) { log.push(e); });
      var Tm = (parseFloat(tm.times[0]) + parseFloat(tm.times[1])) / 2 / n;
      var Tstr = sfFormat(Tm, 4);
      var k = parseFloat(Tstr) * parseFloat(Tstr) / ((L + dia.cm / 2) / 100);
      return { L: L, times: tm.times, Tstr: Tstr, k: k, kStr: sfFormat(k, 3) };
    });
    // s.f. of the raw data, counted from the strings in this answer (d has 4 s.f. with the 0.02 mm vernier)
    var sfOf = function (x) { return VL.sigfig && VL.sigfig.sf ? VL.sigfig.sf(String(x).split(' ')[0]) : NaN; };
    var sfL = Math.min(sfOf('30.0'), sfOf('80.0')), sfD = sfOf(dia.str);
    var sfT = Math.min.apply(null, sets[0].times.concat(sets[1].times).map(sfOf));
    var sfK = Math.min(sfL, sfD, sfT);
    var sfWhy = 'L was measured to ' + sfL + ' s.f., d to ' + sfD + ' s.f. and t to ' + sfT + ' s.f.';
    if (isNum(sfK)) sets.forEach(function (st) { st.kStr = sfFormat(st.k, sfK); });   // (always 3: L has 3 s.f.)
    else sfK = 3;
    var resCm = params.vernierRes / 10;
    var absStr = resCm === 0.002 ? '0.002 cm' : '0.01 cm';
    var pct = resCm / dia.cm * 100;
    var k1 = parseFloat(sets[0].kStr), k2 = parseFloat(sets[1].kStr);
    var diffPct = Math.abs(k1 - k2) / ((k1 + k2) / 2) * 100;
    var kMean = (k1 + k2) / 2;
    var gVal = FOUR_PI2 / kMean;
    var supports = diffPct <= 10;
    var answers = {
      d: dia.str,
      dAbs: absStr,
      dPct: sfFormat(pct, 2) + ' %',
      L1: '30.0 cm', n1: String(n), t1a: sets[0].times[0] + ' s', t1b: sets[0].times[1] + ' s', T1: sets[0].Tstr + ' s',
      L2: '80.0 cm', n2: String(n), t2a: sets[1].times[0] + ' s', t2b: sets[1].times[1] + ' s', T2: sets[1].Tstr + ' s',
      k1_working: 'k = T² / (L + d/2) with L + d/2 in m: k₁ = ' + sets[0].Tstr + '² / ' + ((30 + dia.cm / 2) / 100).toFixed(4),
      k1: sets[0].kStr + ' s² m⁻¹',
      k2: sets[1].kStr + ' s² m⁻¹',
      sfJust: sfWhy + ', so k is given to ' + sfK + ' s.f., the least number of s.f. in the raw data.',
      conclusion: 'The percentage difference between the two values of k is ' + diffPct.toFixed(1) + ' %. ' +
        'I take 10 % as the criterion for agreement, allowing for the uncertainties in the experiment. ' +
        (supports ? 'The difference is less than 10 %, so the results support the suggested relationship.'
          : 'The difference is more than 10 %, so the results do not support the suggested relationship.'),
      g_working: 'mean k = ' + sfFormat(kMean, 3) + ' s² m⁻¹; g = 4π² / k',
      g: sfFormat(gVal, 3) + ' m s⁻²',
      limitations: [
        'Only two sets of readings were taken, which is not enough to draw a valid conclusion.',
        'It is difficult to judge the exact end of an oscillation, so reaction time is significant compared with the time measured.',
        'It is difficult to measure L because the top of the bob and the bottom of the cork are not touching the metre rule.',
        'The amplitude was not kept the same for both lengths, and a large amplitude changes the period.',
        'The bob did not always swing in a single vertical plane; it sometimes moved in an ellipse.',
        'The string may slip in the split cork, so the pivot is not fixed and L may change.'
      ],
      improvements: [
        'Take readings for at least six different lengths and plot a graph of T² against (L + d/2).',
        'Use a fiducial marker at the centre of the swing to start and stop the stopwatch.',
        'Use a set square to transfer the position of the top of the bob to the metre rule.',
        'Use the protractor to release the bob from the same small angle (less than 10°) each time.',
        'Use a bifilar suspension (two strings in a V shape) so that the bob swings in one plane.',
        'Tighten the clamp on the split cork so that the string cannot slip, and measure L again after each timing.'
      ]
    };
    var notes = [
      '(a) Check the zero of the callipers first, then grip the spare bob gently; corrected d = ' + dia.str + '.',
      '(b) The absolute uncertainty is the resolution of the callipers, ' + absStr + '; % uncertainty = ' + absStr.split(' ')[0] + ' ÷ ' + dia.cm.toFixed(dia.dpCm) + ' × 100.',
      '(c)(d) Two timings of 20 oscillations at each length, released from about 5° from the vertical (a protractor reading of about 85° or 95°) and started at the fiducial marker; T = mean ÷ 20.',
      '(e) k = T²/(L + d/2) from your own values, to ' + sfK + ' s.f. because the least number of s.f. in the raw data is ' +
        sfK + ' (' + sfWhy + ').',
      '(f) State a numerical criterion (here 10 %) before comparing the percentage difference in k with it.',
      '(g) g = 4π²/k using the mean k in s² m⁻¹.',
      '(h) Limitations and improvements must be specific to this experiment; each improvement answers a limitation.'
    ];
    return { table: null, graph: null, answers: answers, notes: notes, log: log };
  }

  /**
   * Model answer: a careful student working with the same hidden apparatus (same seed), with realistic
   * reaction-time scatter (sd 0.08 s per timing, through VL.noise so that noise level 0 gives exact values).
   * @param {object} params
   * @param {string} variantId
   * @param {object} rng the 'model' fork
   * @returns {{table, graph, answers, notes, log}}
   */
  function modelAnswer(params, variantId, rng) {
    return variantId === 'twopoint' ? modelTwoPoint(params, rng) : modelGraphQ1(params, rng);
  }

  /* ================================================================== common mistakes and hints */

  function commonMistakes(variantId) {
    var common = [
      'Timing only one oscillation: the reaction time is then a large fraction of the period. Time at least 10 (better 20) oscillations.',
      'Not repeating the timings, so there is no check on a mis-count or a slow reaction.',
      'Recording L as “50 cm” instead of “50.0 cm”: the metre rule reads to the nearest millimetre.',
      'Forgetting to check the vernier callipers for a zero error, or adding the zero error instead of subtracting it.',
      'Reading both ends of L without moving the eye level with each one (parallax). The string and bob hang 1.5 cm in front of the scale, so with the eye above a mark the bob appears further down the rule.'
    ];
    if (variantId === 'twopoint') {
      return common.concat([
        'Justifying the s.f. of k by decimal places instead of the significant figures of the raw data.',
        'Writing a conclusion without a numerical criterion, e.g. “the values of k are close, so it is supported”.',
        'Using L instead of (L + d/2), or mixing cm and m when calculating k.',
        'Generic improvements such as “use better equipment”, “be more careful” or “repeat the experiment”, which score nothing.'
      ]);
    }
    return common.concat([
      'Headings such as “T²” with no unit, or “T² (s)” with the wrong unit: the unit of T² is s².',
      'Giving T² to too many or too few significant figures (use the s.f. of the raw times, or one more).',
      'Plotting T instead of T², or forcing the line through the origin.',
      'Drawing a small gradient triangle, or reading the intercept at a false origin instead of calculating it.',
      'Forgetting to convert a from s² cm⁻¹ to s² m⁻¹ before calculating g.'
    ]);
  }

  var HINTS = {
    graph: {
      a: 'Close the jaws first and read the scale to check for a zero error. Then grip the bob gently and read the main scale and the vernier. Corrected reading = reading − zero error. Record d to the resolution of the callipers.',
      b: 'Drag the metre rule next to the string. Line up the zero of the rule with the bottom of the cork (or read both ends and subtract). Before reading each end, move your eye until it is level with that mark: first level with the cork, then move it down level with the top of the bob. Your eye does not move when you move the view, so re-level it at each end. Record L to the nearest mm, with a unit.',
      c: 'Time at least 10–20 oscillations, start timing as the bob passes the centre (switch on the fiducial marker), and repeat. T = mean time ÷ number of oscillations. The protractor hangs upside down with its centre at the cork. The string hangs vertically along the 90° line, so the angle from the vertical is the difference from 90° (a reading of 82° or 98° means 8°).',
      d: 'Spread L over the whole range available (roughly 20 cm to 95 cm). Each heading needs a quantity and a unit, e.g. L / cm, t / s, T² / s². Record raw L to 0.1 cm and give T² to the same number of s.f. as the raw times, or one more.',
      'e-i': 'Choose scales of 1, 2, 4 or 5 per large square so that the points cover at least half the grid in both directions. T² goes on the y-axis.',
      'e-ii': 'A thin straight line with the points balanced on either side. Do not force it through the origin.',
      'e-iii': 'Use a triangle whose hypotenuse is at least half the length of your line, with vertices on the line. If the x-axis does not start at zero, calculate the intercept from y = mx + c.',
      f: 'Compare T² = aL + b with y = mx + c: a is the gradient and b is the y-intercept. The unit of a is the y unit divided by the x unit.',
      g: 'g = 4π²/a. If a is in s² cm⁻¹, convert it to s² m⁻¹ (multiply by 100) first. Give g with its unit.'
    },
    twopoint: {
      a: 'Close the jaws first and read the scale to check for a zero error. Then grip the bob gently and read the main scale and the vernier. Corrected reading = reading − zero error.',
      b: 'The absolute uncertainty is usually the resolution of the callipers (or half the range of repeated readings). Percentage uncertainty = (absolute uncertainty ÷ d) × 100.',
      'c-i': 'Line up the zero of the rule with the bottom of the cork (or read both ends and subtract). Before reading each end, move your eye until it is level with that mark: first level with the cork, then move it down level with the top of the bob. Your eye does not move when you move the view, so re-level it at each end. Record L to the nearest mm, with a unit.',
      'c-ii': 'Time at least 10–20 oscillations, start timing as the bob passes the centre, and repeat. T = mean time ÷ number of oscillations. The protractor hangs upside down with its centre at the cork. The string hangs vertically along the 90° line, so the angle from the vertical is the difference from 90° (a reading of 82° or 98° means 8°).',
      d: 'Make the second length very different from the first (about 80 cm), so that the change in T is large compared with the uncertainty.',
      'e-i': 'k = T²/(L + d/2). Use the same unit for L and d, and give k a unit.',
      'e-ii': 'Refer to the significant figures (not the decimal places) of the raw readings you used: L, d and the times t.',
      f: 'State a numerical criterion, e.g. “the two values of k should agree within 10 %”. Then calculate the percentage difference between your values and say whether the relationship is supported.',
      g: 'k = 4π²/g, so g = 4π²/k. Use the mean of your two values of k in s² m⁻¹ and give a unit.',
      'h-i': 'Be specific to this experiment: e.g. judging the end of an oscillation, measuring L against the rule, keeping the amplitude constant. “Human error” or “parallax” on its own scores nothing.',
      'h-ii': 'Each improvement should fix a limitation, e.g. a fiducial marker at the centre of the swing, or a set square to transfer the position of the bob to the rule.'
    }
  };

  /* ================================================================== apparatus (browser) */

  /**
   * Build the apparatus controller (contract §4.1).
   * @param {{params, variantId, rng, services, savedState}} actx
   * @returns {object} Controller
   */
  function createApparatus(actx) {
    actx = actx || {};
    var params = actx.params || {};
    var services = actx.services || {};
    var rng = actx.rng || (VL.rng ? VL.rng.create('PEN-0000-0000').fork('noise') : null);
    var I = VL.instruments;
    var U = I.util;

    var d = isNum(params.d) ? params.d : 2.2;
    var r = d / 2;
    var delta = isNum(params.delta) ? params.delta : 0.2;
    var tau = isNum(params.tau) ? params.tau : 100;
    var slipChance = isNum(params.slipChance) ? params.slipChance : 0.03;

    var rule = I.create('metreRule', {}, null);
    var protractor = I.create('protractor', {}, null);
    var vernier = I.create('vernier', {
      resolution: params.vernierRes === 0.02 ? 0.02 : 0.1,
      zeroError: isNum(params.vernierZero) ? params.vernierZero : 0
    }, null);

    var st = {
      L: clamp(isNum(params.L0) ? params.L0 : 50, L_MIN, L_MAX),
      pendingSlip: false,
      // the rule's zero starts 1–3 cm above the cork (not lined up: the student aligns it or reads both ends)
      rule: { x: RULE_START.x, y: clamp(isNum(params.ruleStartY) ? params.ruleStartY : RULE_START.y, RULE_LIMITS.y0, RULE_LIMITS.y1) },
      vernier: { opening: V_OPEN, bobIn: true },
      fiducial: false,
      swing: null,            // { t0 (ms), theta0 (rad), T0 (s), id }
      held: null,             // angle (rad) while the bob is held aside
      swingId: 0,
      lengthDirtyAt: null,
      lastLoggedL: null
    };
    var contact = { opening: d * 10, touching: false };
    var sw = { osc: 0, elapsedAtStart: 0, startPhase: null, startSwingId: null };
    var drag = null;          // { kind: 'bob'|'rule'|'vernier', ... }
    var lastScale = 4, lastEye = isNum(params.eyeStart) ? params.eyeStart : 0;
    var lastEyeY = null;      // world height of the eye (cm, y down) from the view, when it gives one
    var sayFn = null;
    var ruleRepeat = 0;

    /* ---------------------------------------------------------------- services */

    function now() { return typeof services.now === 'function' ? services.now() : perfNow(); }
    function log(e) { if (typeof services.log === 'function') services.log(e); }
    function redraw() { if (typeof services.requestRedraw === 'function') services.requestRedraw(); }
    function toast(m) { if (typeof services.toast === 'function') services.toast(m); }
    function say(m) { if (sayFn) sayFn(m); }

    /* ---------------------------------------------------------------- pendulum state */

    function phaseAt(tMs) {
      if (!st.swing) return 0;
      return swingPhase(Math.max(0, (tMs - st.swing.t0) / 1000), st.swing.theta0, st.swing.T0, tau);
    }
    function angleAt(tMs) {
      if (st.held !== null) return st.held;
      if (!st.swing) return 0;
      return swingAngle(Math.max(0, (tMs - st.swing.t0) / 1000), st.swing.theta0, st.swing.T0, tau);
    }
    function amplitudeAt(tMs) {
      if (st.held !== null) return Math.abs(st.held);
      if (!st.swing) return 0;
      return Math.abs(st.swing.theta0) * Math.exp(-Math.max(0, (tMs - st.swing.t0) / 1000) / tau);
    }
    /** True period now (amplitude-dependent). */
    function periodAt(tMs) { return period(st.L, d, delta, amplitudeAt(tMs) / DEG); }
    function effPivot() { return { x: PIVOT.x, y: PIVOT.y - delta }; }
    function bobCentre(theta) {
      var E = effPivot(), Le = Leff(st.L, d, delta);
      return { x: E.x + Le * Math.sin(theta), y: E.y + Le * Math.cos(theta) };
    }

    function flushLength() {
      if (st.lengthDirtyAt === null) return;
      st.lengthDirtyAt = null;
      if (st.lastLoggedL !== null && Math.abs(st.lastLoggedL - st.L) < 1e-9) return;
      st.lastLoggedL = st.L;
      log({ type: 'length-set', L: round(st.L, 3) });
    }

    function stopMotion(reason) {
      var was = !!st.swing || st.held !== null;
      st.swing = null;
      st.held = null;
      if (was && reason) say(reason);
      redraw();
      return was;
    }

    /**
     * Change the string length by about `step` cm (the string never slides exactly the same distance).
     * @returns {boolean} true if the length changed
     */
    function changeLength(step) {
      if (st.swing || st.held !== null) stopMotion('The bob was stopped so that the string could be adjusted.');
      if (step > 0 && st.L >= L_MAX - 1e-9) { say('The string cannot be made any longer: the bob would reach the bench.'); return false; }
      if (step < 0 && st.L <= L_MIN + 1e-9) { say('The string cannot be made any shorter.'); return false; }
      var jitter = rng && VL.noise ? clamp(VL.noise.gauss(rng, 0.15), -0.5, 0.5) : 0;
      var next = st.L + step * (1 + jitter);
      next = clamp(next, L_MIN, Math.max(L_MAX, step < 0 ? st.L : L_MAX));
      st.L = next;
      st.pendingSlip = true;
      st.lengthDirtyAt = now();
      redraw();
      return true;
    }

    /** After a length change, the first release may make the string slip through the cork (hidden anomaly). */
    function maybeSlip() {
      if (!st.pendingSlip) return;
      st.pendingSlip = false;
      if (!rng || !VL.noise || typeof VL.noise.maybeAnomaly !== 'function') return;
      if (VL.noise.maybeAnomaly(rng, slipChance)) {
        var amount = round(rng.uniform(0.3, 0.8), 3);
        var before = st.L;
        st.L = Math.min(st.L + amount, L_MAX + SLIP_ROOM);
        st.lastLoggedL = st.L;
        log({ type: 'anomaly', kind: 'slip', amount: round(st.L - before, 3), L: round(st.L, 3), before: round(before, 3) });
      }
    }

    /** Hold the bob aside at an angle (rad); a swinging bob is caught first. */
    function hold(theta) {
      st.swing = null;
      st.held = clamp(theta, -AMP_MAX * DEG, AMP_MAX * DEG);
      redraw();
    }

    /** Let go of a held bob: it swings from rest at the held angle. */
    function release() {
      if (st.held === null) return false;
      var th = st.held;
      st.held = null;
      flushLength();
      maybeSlip();
      if (Math.abs(th) < 0.3 * DEG) { st.swing = null; redraw(); return false; }
      st.swingId += 1;
      st.swing = { t0: now(), theta0: th, T0: period(st.L, d, delta, 0), id: st.swingId };
      log({ type: 'release', L: round(st.L, 3), amplitudeDeg: round(Math.abs(th) / DEG, 2) });
      if (Math.abs(th) > 15 * DEG) toast('A large release angle makes the period longer. Release from a small angle (about 10° or less).');
      redraw();
      return true;
    }

    /* ---------------------------------------------------------------- vernier */

    function vernierMin() { return st.vernier.bobIn ? contact.opening : 0; }

    /**
     * Move the sliding jaw to an opening (mm). With the bob between the jaws it stops at contact; once the jaws
     * have been opened well clear of the bob, the next contact is a fresh one (slightly different squeeze).
     */
    function setOpening(mm) {
      if (st.vernier.bobIn && contact.touching && mm > contact.opening + 0.5) newContact();
      var o = clamp(mm, vernierMin(), V_MAX);
      if (st.vernier.bobIn) contact.touching = o <= contact.opening + 1e-9;
      st.vernier.opening = o;
      redraw();
    }

    /** A new contact with the bob: the jaws close on it to d·10 mm, give or take a slight squeeze. */
    function newContact() {
      var j = rng && VL.noise ? clamp(VL.noise.gauss(rng, 0.005), -0.01, 0.01) : 0;
      contact.opening = d * 10 + j;
      contact.touching = false;
    }

    function gripBob() {
      if (!st.vernier.bobIn) { st.vernier.bobIn = true; st.vernier.opening = V_OPEN; newContact(); }
      if (st.vernier.opening > contact.opening + 0.5) newContact();
      setOpening(contact.opening);
    }
    function openJaws() {
      if (!st.vernier.bobIn) { st.vernier.bobIn = true; newContact(); }
      st.vernier.opening = V_OPEN;
      contact.touching = false;
      redraw();
    }
    function closeJawsZero() {
      st.vernier.bobIn = false;
      st.vernier.opening = 0;
      log({ type: 'zero-check', instrument: 'vernier', zeroReadingMm: vernier.zeroError });
      redraw();
    }

    /* ---------------------------------------------------------------- rule */

    function moveRule(dx, dy) {
      st.rule.x = clamp(st.rule.x + dx, RULE_LIMITS.x0, RULE_LIMITS.x1);
      st.rule.y = clamp(st.rule.y + dy, RULE_LIMITS.y0, RULE_LIMITS.y1);
      redraw();
    }
    function ruleNextToString() {
      st.rule.x = PIVOT.x + 0.8;
      redraw();
    }
    function parallaxDy(eye) { return U.parallaxShift(RULE_GAP, eye || 0); }
    /** The rule as drawn: shifted opposite to the parallax shift of the pendulum, which is in front of it. */
    function rulePlaceDrawn() {
      return { x: st.rule.x, y: st.rule.y - parallaxDy(lastEye), angle: Math.PI / 2, side: -1 };
    }
    function rulePlace() { return { x: st.rule.x, y: st.rule.y, angle: Math.PI / 2, side: -1 }; }

    /* ---------------------------------------------------------------- drawing */

    function lw(view, cm) { return U.lineW(view, cm); }

    function metalGradient(g, x0, y0, x1, y1, dark) {
      var gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, dark ? '#6b7682' : '#9aa5b1');
      gr.addColorStop(0.35, dark ? '#c4ccd4' : '#eef2f6');
      gr.addColorStop(0.65, dark ? '#8a95a1' : '#b9c3cd');
      gr.addColorStop(1, dark ? '#4d5661' : '#7d8893');
      return gr;
    }

    function drawBench(g, view) {
      var gr = g.createLinearGradient(0, BENCH_Y, 0, WORLD.height + 20);
      gr.addColorStop(0, '#cfae80');
      gr.addColorStop(1, '#a98457');
      g.fillStyle = gr;
      g.fillRect(-40, BENCH_Y, WORLD.width + 80, WORLD.height - BENCH_Y + 40);
      g.strokeStyle = '#6e5232';
      g.lineWidth = lw(view, 0.1);
      g.beginPath(); g.moveTo(-40, BENCH_Y); g.lineTo(WORLD.width + 40, BENCH_Y); g.stroke();
    }

    function drawStand(g, view) {
      // base plate
      U.roundRect(g, 1.5, BENCH_Y - 2.2, 27, 2.2, 0.4);
      g.fillStyle = metalGradient(g, 0, BENCH_Y - 2.2, 0, BENCH_Y, true);
      g.fill();
      g.strokeStyle = '#2e353d'; g.lineWidth = lw(view, 0.04); g.stroke();
      // rod
      g.fillStyle = metalGradient(g, ROD_X - 0.65, 0, ROD_X + 0.65, 0, false);
      g.fillRect(ROD_X - 0.65, 1, 1.3, BENCH_Y - 3.2);
      g.strokeStyle = '#59636d'; g.lineWidth = lw(view, 0.02);
      g.strokeRect(ROD_X - 0.65, 1, 1.3, BENCH_Y - 3.2);
      // boss
      U.roundRect(g, ROD_X - 1.7, ARM_Y - 2.0, 3.4, 4.0, 0.35);
      g.fillStyle = metalGradient(g, ROD_X - 1.7, 0, ROD_X + 1.7, 0, true);
      g.fill(); g.strokeStyle = '#2e353d'; g.lineWidth = lw(view, 0.03); g.stroke();
      // boss screw (towards the viewer)
      g.beginPath(); g.arc(ROD_X - 2.3, ARM_Y + 1.1, 0.55, 0, TWO_PI);
      g.fillStyle = '#3a424b'; g.fill();
      g.fillStyle = '#2b3138'; g.fillRect(ROD_X - 3.6, ARM_Y + 0.85, 1.4, 0.5);
    }

    function drawClampAndCork(g, view) {
      // arm from the boss to the clamp
      g.fillStyle = metalGradient(g, 0, ARM_Y - 0.45, 0, ARM_Y + 0.45, false);
      g.fillRect(ROD_X + 1.7, ARM_Y - 0.45, PIVOT.x - 2.6 - (ROD_X + 1.7), 0.9);
      g.strokeStyle = '#59636d'; g.lineWidth = lw(view, 0.02);
      g.strokeRect(ROD_X + 1.7, ARM_Y - 0.45, PIVOT.x - 2.6 - (ROD_X + 1.7), 0.9);
      // cork (in front of the top of the string)
      var top = PIVOT.y - 3.2, x = PIVOT.x;
      g.beginPath();
      g.moveTo(x - 1.35, top); g.lineTo(x + 1.35, top); g.lineTo(x + 1.05, PIVOT.y); g.lineTo(x - 1.05, PIVOT.y); g.closePath();
      var cg = g.createLinearGradient(x - 1.35, 0, x + 1.35, 0);
      cg.addColorStop(0, '#a77a43'); cg.addColorStop(0.45, '#d7b07a'); cg.addColorStop(1, '#9c6f3b');
      g.fillStyle = cg; g.fill();
      g.strokeStyle = '#6b4a22'; g.lineWidth = lw(view, 0.02); g.stroke();
      // cork texture (deterministic speckles)
      g.fillStyle = 'rgba(90,60,25,0.45)';
      for (var i = 0; i < 26; i++) {
        var sx = x - 1.0 + 2.0 * U.unitAt(7, i), sy = top + 0.2 + 2.8 * U.unitAt(11, i);
        g.beginPath(); g.arc(sx, sy, 0.03 + 0.04 * U.unitAt(13, i), 0, TWO_PI); g.fill();
      }
      // the split
      g.strokeStyle = '#4a3216'; g.lineWidth = lw(view, 0.015);
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, PIVOT.y); g.stroke();
      // clamp jaws gripping the cork
      [-1, 1].forEach(function (s) {
        var jx = s < 0 ? x - 1.35 - 0.9 : x + 1.3;
        U.roundRect(g, jx, top + 0.35, 0.95, 2.3, 0.15);
        g.fillStyle = metalGradient(g, jx, 0, jx + 0.95, 0, true);
        g.fill(); g.strokeStyle = '#2e353d'; g.lineWidth = lw(view, 0.02); g.stroke();
      });
      // clamp frame behind the jaws joining the arm
      g.strokeStyle = '#5c6670'; g.lineWidth = lw(view, 0.35);
      g.beginPath();
      g.moveTo(PIVOT.x - 2.6, ARM_Y); g.lineTo(x - 1.9, ARM_Y);
      g.moveTo(x - 1.9, top - 0.2); g.lineTo(x + 1.9, top - 0.2);
      g.stroke();
      // tightening screw
      g.fillStyle = '#3a424b';
      g.fillRect(x + 2.25, top + 1.2, 1.2, 0.45);
      g.beginPath(); g.arc(x + 3.6, top + 1.42, 0.38, 0, TWO_PI); g.fill();
    }

    /** Metal sphere with a highlight (physical radius in cm). */
    function drawSphere(g, view, cx, cy, rad, holeAngle) {
      var gr = g.createRadialGradient(cx - 0.38 * rad, cy - 0.42 * rad, rad * 0.06, cx, cy, rad);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.22, '#e3e8ee');
      gr.addColorStop(0.6, '#99a3ae');
      gr.addColorStop(0.9, '#4f5862');
      gr.addColorStop(1, '#3a4149');
      g.beginPath(); g.arc(cx, cy, rad, 0, TWO_PI);
      g.fillStyle = gr; g.fill();
      g.strokeStyle = '#262c33'; g.lineWidth = lw(view, 0.02); g.stroke();
      // soft reflected light from the bench at the bottom right
      var rg = g.createRadialGradient(cx + 0.45 * rad, cy + 0.55 * rad, 0, cx + 0.45 * rad, cy + 0.55 * rad, rad * 0.6);
      rg.addColorStop(0, 'rgba(230,200,150,0.35)');
      rg.addColorStop(1, 'rgba(230,200,150,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(cx, cy, rad, 0, TWO_PI); g.fill();
      if (holeAngle !== null && holeAngle !== undefined) {
        // the hole the string passes through, at the top of the bob
        var hx = cx - Math.sin(holeAngle) * rad * 0.97, hy = cy - Math.cos(holeAngle) * rad * 0.97;
        g.save(); g.translate(hx, hy); g.rotate(-holeAngle);
        g.beginPath(); g.ellipse(0, 0, 0.09, 0.035, 0, 0, TWO_PI);
        g.fillStyle = '#1b1f24'; g.fill();
        g.restore();
      }
    }

    function drawString(g, view, theta) {
      var E = effPivot(), Le = Leff(st.L, d, delta) - r;
      g.strokeStyle = '#2f2a24';
      g.lineWidth = lw(view, 0.05);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(E.x, E.y);
      g.lineTo(E.x + Le * Math.sin(theta), E.y + Le * Math.cos(theta));
      g.stroke();
    }

    function drawFiducial(g, view) {
      var tip = Math.min(BENCH_Y - 3, PIVOT.y + st.L + 2 * r + 1.0);
      var x = PIVOT.x;
      // base
      U.roundRect(g, x - 2.2, BENCH_Y - 1.2, 4.4, 1.2, 0.2);
      g.fillStyle = '#2f3b48'; g.fill();
      // pointer rod with bands so it is visible against any background
      var h = BENCH_Y - 1.2 - tip;
      g.fillStyle = '#f4f4f4';
      g.fillRect(x - 0.12, tip + 0.6, 0.24, h - 0.6);
      g.fillStyle = '#b3261e';
      for (var y = tip + 0.6; y < BENCH_Y - 1.2; y += 2) g.fillRect(x - 0.12, y, 0.24, Math.min(1, BENCH_Y - 1.2 - y));
      g.strokeStyle = '#1b1f24'; g.lineWidth = lw(view, 0.015);
      g.strokeRect(x - 0.12, tip + 0.6, 0.24, h - 0.6);
      // sharp tip
      g.beginPath(); g.moveTo(x - 0.12, tip + 0.6); g.lineTo(x, tip); g.lineTo(x + 0.12, tip + 0.6); g.closePath();
      g.fillStyle = '#1b1f24'; g.fill();
    }

    function drawVernierInset(g, view) {
      U.roundRect(g, INSET.x, INSET.y, INSET.w, INSET.h, 0.6);
      g.fillStyle = '#3f6e57';            // green cutting mat
      g.fill();
      g.strokeStyle = '#24402f'; g.lineWidth = lw(view, 0.05); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = lw(view, 0.02);
      g.beginPath();
      for (var gx = INSET.x + 2; gx < INSET.x + INSET.w; gx += 2) { g.moveTo(gx, INSET.y + 0.3); g.lineTo(gx, INSET.y + INSET.h - 0.3); }
      g.stroke();
      U.text(g, 'Vernier callipers and spare bob', INSET.x + 1, INSET.y + INSET.h - 0.7, 0.55,
        { align: 'left', colour: '#f2f6f3', weight: '600' });
      vernier.draw(g, VPLACE, view, { opening: st.vernier.opening });
      if (st.vernier.bobIn) drawSphere(g, view, VPLACE.x + r, VPLACE.y + 2.45, r, null);
      else drawSphere(g, view, SPARE_ASIDE.x, SPARE_ASIDE.y, r, null);
    }

    function draw(g, view) {
      view = view || { scale: 10, eyeAngle: 0 };
      var t = isNum(view.now) ? view.now : now();
      lastScale = view.scale || lastScale;
      // view.eyeAngle: the angle of the line of sight at the CENTRE of the view (the eye is a fixed height, eyeY, so
      // each end of L is seen at its own angle and has to be re-levelled); the whole rule is shifted by that angle
      lastEye = view.eyeAngle || 0;
      if (isNum(view.eyeY)) lastEyeY = view.eyeY;
      var theta = angleAt(t);
      drawBench(g, view);
      drawStand(g, view);
      rule.draw(g, rulePlaceDrawn(), view);
      // the protractor hangs just behind the string, in front of the rule (its body is semi-transparent, so the rule
      // shows through and the graduations near 90° stay readable when the rule is beside the string)
      protractor.draw(g, PROTRACTOR_PLACE, view);
      if (st.fiducial) drawFiducial(g, view);
      drawString(g, view, theta);
      drawClampAndCork(g, view);
      var c = bobCentre(theta);
      drawSphere(g, view, c.x, c.y, r, theta);
      drawVernierInset(g, view);
    }

    /* ---------------------------------------------------------------- pointer */

    function hitTarget(p) {
      var tNow = now();
      var pad = 22 / (lastScale || 4);
      // vernier sliding jaw
      var vstate = { opening: st.vernier.opening };
      var face = vernier.jawFaces(VPLACE, vstate).moving;
      if (vernier.sliderContains(VPLACE, vstate, p) ||
        (Math.abs(p.x - (face + 1.0)) <= Math.max(1.6, pad) && p.y >= VPLACE.y - 2.6 && p.y <= VPLACE.y + 4.9)) {
        return 'vernier';
      }
      var c = bobCentre(angleAt(tNow));
      if (Math.hypot(p.x - c.x, p.y - c.y) <= Math.max(r + 0.5, pad)) return 'bob';
      if (rule.contains(rulePlaceDrawn(), p, Math.max(0, pad - 1.4))) return 'rule';
      return null;
    }

    function bobAngleFor(p) {
      var E = effPivot();
      var dy = Math.max(0.5, p.y - E.y);
      return Math.atan2(p.x - E.x, dy);
    }

    var pointer = {
      down: function (p) {
        var target = hitTarget(p);
        if (!target) return false;
        if (target === 'vernier') {
          var face = vernier.jawFaces(VPLACE, { opening: st.vernier.opening }).moving;
          drag = { kind: 'vernier', dx: p.x - face };
        } else if (target === 'bob') {
          var th = angleAt(now());
          drag = { kind: 'bob', offset: bobAngleFor(p) - th };
          hold(th);
        } else {
          drag = { kind: 'rule', dx: p.x - st.rule.x, dy: p.y - st.rule.y };
        }
        redraw();
        return true;
      },
      move: function (p) {
        if (!drag) return;
        if (drag.kind === 'vernier') setOpening(vernier.openingForX(VPLACE, p.x - drag.dx));
        else if (drag.kind === 'bob') hold(bobAngleFor(p) - drag.offset);
        else {
          st.rule.x = clamp(p.x - drag.dx, RULE_LIMITS.x0, RULE_LIMITS.x1);
          st.rule.y = clamp(p.y - drag.dy, RULE_LIMITS.y0, RULE_LIMITS.y1);
          redraw();
        }
      },
      up: function () {
        if (drag && drag.kind === 'bob') release();
        drag = null;
        redraw();
      },
      hover: function (p) { return hitTarget(p) !== null; }
    };

    /* ---------------------------------------------------------------- DOM controls (browser) */

    function controls(container, ui) {
      ui = ui || VL.ui;
      var h = ui.h;
      function button(label, fn, opts) {
        if (typeof ui.button === 'function') return ui.button(label, fn, opts);
        return h('button', { type: 'button', class: 'vl-btn vl-ctl-btn', title: opts && opts.title, on: { click: fn } }, label);
      }
      function group(label) {
        if (typeof ui.group === 'function') return ui.group(label);
        return h('div', { class: 'vl-ctl-group', role: 'group', 'aria-label': label }, h('span', { class: 'vl-ctl-group-label' }, label));
      }
      var status = h('p', { class: 'vl-ctl-note vl-ctl-status', role: 'status', 'aria-live': 'polite' });
      sayFn = function (msg) { status.textContent = msg; };

      var gLen = group('String length');
      gLen.appendChild(button('Shorten', function () { actions.shorten(); }, { hold: true, title: 'Pull the string up through the cork (about 5 mm per press). Hold to repeat.' }));
      gLen.appendChild(button('Lengthen', function () { actions.lengthen(); }, { hold: true, title: 'Let the string down through the cork (about 5 mm per press). Hold to repeat.' }));
      gLen.appendChild(button('Shorten 1 mm', function () { actions.shorten(FINE); }, { hold: true, title: 'Fine adjustment, about 1 mm per press.' }));
      gLen.appendChild(button('Lengthen 1 mm', function () { actions.lengthen(FINE); }, { hold: true, title: 'Fine adjustment, about 1 mm per press.' }));

      var gBob = group('Bob');
      gBob.appendChild(button('Pull bob aside', function () { actions.pullAside(); }, { hold: true, title: 'Pull the bob aside (a little further to the left each press). The angle from the vertical is the difference between the protractor reading and 90°.' }));
      gBob.appendChild(button('Release bob', function () { actions.release(); }));
      gBob.appendChild(button('Stop the bob', function () { actions.stopBob(); }));
      if (typeof ui.note === 'function') gBob.appendChild(ui.note('Or drag the bob sideways in the picture and let go.'));

      var gRule = group('Metre rule');
      function ruleBtn(label, dx, dy, title) {
        return button(label, function (ev) {
          ruleRepeat = ev && ev.repeat ? ruleRepeat + 1 : 0;
          var step = ruleRepeat > 12 ? 0.5 : 0.1;
          actions.moveRule(dx * step, dy * step);
        }, { hold: true, title: title });
      }
      gRule.appendChild(ruleBtn('Rule up', 0, -1, 'Move the rule up (hold to move faster).'));
      gRule.appendChild(ruleBtn('Rule down', 0, 1, 'Move the rule down (hold to move faster).'));
      gRule.appendChild(ruleBtn('Rule left', -1, 0, 'Move the rule to the left.'));
      gRule.appendChild(ruleBtn('Rule right', 1, 0, 'Move the rule to the right.'));
      gRule.appendChild(button('Rule next to string', function () { actions.ruleNextToString(); }, { title: 'Slide the rule sideways until its scale is beside the string. You still have to line it up vertically.' }));
      if (typeof ui.note === 'function') gRule.appendChild(ui.note('Or drag the rule in the picture.'));

      var gVer = group('Vernier callipers');
      gVer.appendChild(button('Close jaws on the spare bob', function () { actions.gripBob(); }));
      gVer.appendChild(button('Open jaws', function () { actions.openJaws(); }));
      gVer.appendChild(button('Close jaws (check zero)', function () { actions.closeJawsZero(); }, { title: 'Take the bob out and close the jaws completely to check the zero reading.' }));
      if (typeof ui.note === 'function') gVer.appendChild(ui.note('Or drag the sliding jaw in the picture.'));

      var gOther = group('Fiducial marker');
      if (typeof ui.toggle === 'function') {
        gOther.appendChild(ui.toggle('Fiducial marker', st.fiducial, function (on) { actions.setFiducial(on); },
          { title: 'A vertical pointer at the centre of the swing: start and stop the stopwatch as the bob passes it.' }));
      } else {
        gOther.appendChild(button('Fiducial marker on/off', function () { actions.setFiducial(!st.fiducial); }));
      }

      [gLen, gBob, gRule, gVer, gOther, status].forEach(function (el) { container.appendChild(el); });
    }

    /* ---------------------------------------------------------------- actions (used by controls and tests) */

    var actions = {
      /** Shorten the string by about `step` cm (default 0.5). */
      shorten: function (step) { return changeLength(-(step || COARSE)); },
      /** Lengthen the string by about `step` cm (default 0.5). */
      lengthen: function (step) { return changeLength(step || COARSE); },
      /** Pull the bob further aside (to the left) by `deg` degrees (default 2°). */
      pullAside: function (deg) {
        var base = st.held !== null && !st.swing ? st.held : 0;
        var dir = base > 0 ? 1 : -1;          // keep pulling the way it is already held (default: to the left)
        var next = base + dir * (deg || PULL_STEP) * DEG;
        if (Math.abs(next) > AMP_MAX * DEG) say('The bob is already pulled well aside; small angles give a period that does not depend on the amplitude.');
        hold(next);
      },
      /** Hold the bob at a given angle (degrees, + = to the right). */
      holdAt: function (deg) { hold(deg * DEG); },
      release: function () {
        if (st.held === null) { say(st.swing ? 'The bob is already swinging.' : 'Pull the bob aside first.'); return false; }
        return release();
      },
      stopBob: function () { if (!stopMotion()) say('The bob is not moving.'); },
      moveRule: moveRule,
      ruleNextToString: ruleNextToString,
      gripBob: gripBob,
      openJaws: openJaws,
      closeJawsZero: closeJawsZero,
      /** Drag-equivalent: set the vernier opening (mm); it stops at contact with the bob. */
      setVernierOpening: function (mm) { setOpening(mm); },
      setFiducial: function (on) { st.fiducial = !!on; redraw(); }
    };

    /* ---------------------------------------------------------------- snapshot / stopwatch / state */

    function snapshot() {
      var t = now();
      flushLength();
      var amp = amplitudeAt(t) / DEG;
      var top = { x: PIVOT.x, y: PIVOT.y + st.L };
      var cork = { x: PIVOT.x, y: PIVOT.y };
      var dyAp = parallaxDy(lastEye);
      return {
        L: round(st.L, 3), d: d, delta: delta, Leff: round(Leff(st.L, d, delta), 3),
        T: round(periodAt(t), 5), amplitudeDeg: round(amp, 2), swinging: !!st.swing,
        ruleOffset: round(st.rule.y - PIVOT.y, 3), ruleGapX: round(st.rule.x - PIVOT.x, 3),
        vernierOpening: round(st.vernier.opening, 4), vernierZeroError: vernier.zeroError,
        vernierReading: round(vernier.readingFor(st.vernier.opening), 4), vernierResolution: vernier.resolution,
        vernierHoldsBob: st.vernier.bobIn,
        eyeAngle: round(lastEye, 2),
        eyeY: isNum(lastEyeY) ? round(lastEyeY, 3) : null,
        ruleReadings: {
          cork: round(rule.readingAt(rulePlace(), cork), 3),
          bobTop: round(rule.readingAt(rulePlace(), top), 3),
          corkSeen: round(rule.readingAt(rulePlace(), { x: cork.x, y: cork.y + dyAp }), 3),
          bobTopSeen: round(rule.readingAt(rulePlace(), { x: top.x, y: top.y + dyAp }), 3)
        },
        fiducial: st.fiducial
      };
    }

    /**
     * Hidden truth logged with stopwatch events. Oscillations are counted from the swing phase, so a stop
     * event reports how many oscillations really happened while the watch ran (≈ elapsed / T).
     */
    function onStopwatchEvent(kind, info) {
      info = info || {};
      var t = isNum(info.nowMs) ? info.nowMs : now();
      var elapsed = isNum(info.elapsed) ? info.elapsed : 0;
      flushLength();
      if (kind === 'reset') {
        sw = { osc: 0, elapsedAtStart: 0, startPhase: null, startSwingId: null };
        return null;
      }
      var amp = amplitudeAt(t) / DEG;
      var T = periodAt(t);
      if (kind === 'start') {
        sw.elapsedAtStart = elapsed;
        sw.startSwingId = st.swing ? st.swing.id : null;
        sw.startPhase = st.swing ? phaseAt(t) : null;
        return { L: round(st.L, 3), T: round(T, 5), amplitudeDeg: round(amp, 2), swinging: !!st.swing };
      }
      if (kind === 'stop') {
        var osc = 0;
        if (st.swing) {
          var p0 = sw.startSwingId === st.swing.id && sw.startPhase !== null ? sw.startPhase : 0;
          osc = (phaseAt(t) - p0) / TWO_PI;
        }
        sw.osc += Math.max(0, osc);
        sw.startPhase = null;
        sw.startSwingId = null;
        return {
          elapsedTrue: round(elapsed, 4), oscillationsTrue: round(sw.osc, 3), amplitudeDeg: round(amp, 2),
          L: round(st.L, 3), T: round(T, 5), swinging: !!st.swing
        };
      }
      return null;
    }

    function getState() {
      var t = now();
      return {
        v: 1,
        L: round(st.L, 4),
        pendingSlip: st.pendingSlip,
        rule: { x: round(st.rule.x, 3), y: round(st.rule.y, 3) },
        vernier: { opening: round(st.vernier.opening, 4), bobIn: st.vernier.bobIn },
        fiducial: st.fiducial,
        swinging: !!st.swing,
        amplitudeDeg: st.swing ? round(amplitudeAt(t) / DEG, 3) : 0,
        direction: st.swing && angleAt(t) < 0 ? -1 : 1,
        lastLoggedL: st.lastLoggedL,
        // oscillations counted by the stopwatch since its last reset, so that a timing continued after a reload
        // still logs the right cumulative oscillationsTrue (the view restores the watch stopped at its time)
        sw: { osc: round(sw.osc, 4) }
      };
    }

    function setState(o) {
      if (!o || typeof o !== 'object') return;
      if (isNum(o.L)) st.L = clamp(o.L, L_MIN, L_MAX + SLIP_ROOM);
      st.pendingSlip = !!o.pendingSlip;
      if (o.rule && isNum(o.rule.x) && isNum(o.rule.y)) {
        st.rule.x = clamp(o.rule.x, RULE_LIMITS.x0, RULE_LIMITS.x1);
        st.rule.y = clamp(o.rule.y, RULE_LIMITS.y0, RULE_LIMITS.y1);
      }
      if (o.vernier) {
        st.vernier.bobIn = o.vernier.bobIn !== false;
        if (isNum(o.vernier.opening)) {
          st.vernier.opening = clamp(o.vernier.opening, st.vernier.bobIn ? contact.opening : 0, V_MAX);
          contact.touching = st.vernier.bobIn && st.vernier.opening <= contact.opening + 1e-9;
        }
      }
      st.fiducial = !!o.fiducial;
      if (isNum(o.lastLoggedL)) st.lastLoggedL = o.lastLoggedL;
      // the watch comes back stopped: keep its cumulative count, but a timing segment in progress is not resumed
      sw = { osc: o.sw && isNum(o.sw.osc) && o.sw.osc > 0 ? o.sw.osc : 0, elapsedAtStart: 0, startPhase: null, startSwingId: null };
      st.held = null;
      st.swing = null;
      if (o.swinging && isNum(o.amplitudeDeg) && o.amplitudeDeg > 0.3) {
        st.swingId += 1;
        var th = clamp(o.amplitudeDeg, 0, AMP_MAX) * DEG * (o.direction === -1 ? -1 : 1);
        st.swing = { t0: now(), theta0: th, T0: period(st.L, d, delta, 0), id: st.swingId };
      }
      redraw();
    }

    function update(dt, nowMs) {
      var t = isNum(nowMs) ? nowMs : now();
      if (st.lengthDirtyAt !== null && t - st.lengthDirtyAt > SETTLE_MS) flushLength();
      if (st.swing && amplitudeAt(t) < 0.02 * DEG) st.swing = null;
    }

    /**
     * True while the scene changes with time without input: the bob swinging, held or being dragged (or anything
     * else being dragged), or a length change waiting to settle (update() logs it after SETTLE_MS). Nothing else
     * moves on its own: every control and pointer action calls services.requestRedraw().
     * @returns {boolean}
     */
    function isAnimating() {
      return !!st.swing || st.held !== null || drag !== null || st.lengthDirtyAt !== null;
    }

    function bobRestTop() { return { x: PIVOT.x, y: PIVOT.y + st.L }; }

    /**
     * View for the "… and rule" zoom targets: centred between the string and the rule's scale edge, zoomed in fully
     * (×14) when the rule is beside the string, and less when it is further away, so that both stay in view.
     */
    function withRule() {
      var gap = Math.abs(st.rule.x - PIVOT.x);
      var x = (PIVOT.x + st.rule.x) / 2 + (st.rule.x >= PIVOT.x ? 0.5 : -0.5);
      var zoom = gap <= 3 ? 14 : clamp(14 * 5 / (gap + 2), 3, 14);
      return { x: x, zoom: zoom };
    }

    var controller = {
      world: { width: WORLD.width, height: WORLD.height },
      uses: ['stopwatch'],
      // zoom far enough to read the 0.02 mm vernier: at 800 css px per cm, 0.02 mm (the step between adjacent
      // vernier lines and the main scale) is 1.6 px
      maxPxPerCm: MAX_PX_PER_CM,
      draw: draw,
      update: update,
      isAnimating: isAnimating,
      pointer: pointer,
      controls: controls,
      zoomTargets: [
        { id: 'cork', label: 'Cork and rule', get x() { return withRule().x; }, y: PIVOT.y, get zoom() { return withRule().zoom; } },
        { id: 'bob', label: 'Bob and rule', get x() { return withRule().x; }, get y() { return bobRestTop().y; }, get zoom() { return withRule().zoom; } },
        { id: 'protractor', label: 'Protractor', x: PIVOT.x, y: PIVOT.y + 4.5, zoom: 6 },
        { id: 'vernier', label: 'Vernier scale',
          get x() { return VPLACE.x + vernier.readingFor(st.vernier.opening) / 10 + vernier.vernierLength / 20; },
          y: VPLACE.y, zoom: 22 }
      ],
      snapshot: snapshot,
      onStopwatchEvent: onStopwatchEvent,
      getState: getState,
      setState: setState,
      destroy: function () { drag = null; sayFn = null; },
      actions: actions
    };

    if (actx.savedState) setState(actx.savedState);
    else {
      newContact();
      log({ type: 'setup', vernierZeroErrorMm: vernier.zeroError, vernierResolutionMm: vernier.resolution, L: round(st.L, 3) });
      st.lastLoggedL = st.L;
    }
    return controller;
  }

  /* ================================================================== registration */

  var def = {
    id: 'pendulum',
    title: 'Simple pendulum',
    topic: 'Oscillations / kinematics',
    seedPrefix: 'PEN',
    variants: VARIANTS,
    apparatusList: apparatusList,
    sampleParams: sampleParams,
    model: model,
    knownValues: knownValues,
    quantities: quantities,
    paper: paper,
    rubric: rubric,
    modelAnswer: modelAnswer,
    commonMistakes: commonMistakes,
    hints: HINTS,
    bank: BANK,
    createApparatus: createApparatus
  };

  if (typeof VL.registerExperiment === 'function') VL.registerExperiment(def);
  else (VL.pendingExperiments = VL.pendingExperiments || []).push(def);
})(globalThis.VLab = globalThis.VLab || {});
