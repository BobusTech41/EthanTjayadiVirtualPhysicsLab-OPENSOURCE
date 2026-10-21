/**
 * Skill drills page (browser only for mount; the data generators and markers are pure). docs/ARCHITECTURE.md §9.
 *
 *   VL.ui.drillsView.mount(container, { storage? }) -> { destroy(), el }
 *
 * Four short drills, each on one Paper 3 skill. Every set is generated from a visible, re-enterable seed, and
 * NOTHING is ever filled in for the student — they read the data, build their own table / graph / answers, and
 * are marked with the same generic mark points the exam marker uses.
 *
 *   1. Graph (PDO/ACE)   a dataset from a linear relationship with realistic noise, shown as a read-only table;
 *                        the student chooses scales, plots, draws the line, gradient triangle and intercept on
 *                        VL.ui.graphView; marked with VL.marking.points axes / plotting / bestFit / gradient /
 *                        intercept, then a model graph is shown.
 *   2. Uncertainty (ACE) nine seeded numeric questions (absolute → %, half-range, mean, products and powers,
 *                        absolute from %, sums, n oscillations, comparing two k values against a criterion),
 *                        each followed by a worked explanation.
 *   3. Table (PDO)       raw readings described as the instruments show them; the student builds the table;
 *                        marked with headings / rawConsistency / derivedSF / calc.
 *   4. Evaluation (ACE)  one of eight experiments; four limitations and four improvements marked with
 *                        VL.textmatch.markLimitationsImprovements against a bank, with the full model list.
 *
 * The first check of each set is recorded with VL.storage.addProgress({ mode: 'drill', expId: 'drill-<id>' ...});
 * later checks of the same set are feedback only. Work in progress is kept with VL.storage.set('drills:state:<id>').
 *
 * Pure exports (Node-testable): graphDataset(seed), uncertaintyQuestions(seed), checkField(field, typed),
 * tableScenario(seed), evaluationScenario(seed), markGraph(ds, graph, answers), markTable(sc, table),
 * markEvaluation(sc, lims, imps), DRILLS, RELATIONSHIPS, TABLE_SCENARIOS, EVAL_SCENARIOS.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var DRILLS = [
    { id: 'graph', expId: 'drill-graph', prefix: 'GRD', tab: 'Graph', title: 'Graph drill', skills: ['PDO', 'ACE'],
      blurb: 'Plot a graph from a table of results: choose sensible scales, plot every point, draw the line of best fit, then find the gradient and the y-intercept.' },
    { id: 'uncertainty', expId: 'drill-uncertainty', prefix: 'UNC', tab: 'Uncertainties', title: 'Uncertainty drill', skills: ['ACE'],
      blurb: 'Nine short calculations: percentage uncertainties, repeated readings, combining uncertainties and testing a relationship against a criterion.' },
    { id: 'table', expId: 'drill-table', prefix: 'TAB', tab: 'Tables', title: 'Table drill', skills: ['PDO'],
      blurb: 'Record raw readings exactly as the instruments show them, with correct headings, consistent decimal places and a calculated column to the right number of significant figures.' },
    { id: 'evaluation', expId: 'drill-evaluation', prefix: 'EVL', tab: 'Evaluation', title: 'Evaluation drill', skills: ['ACE'],
      blurb: 'Write four limitations and four improvements for an experiment. Vague answers such as “use more accurate equipment” score nothing — be specific.' }
  ];
  var SKILL_NAMES = {
    MMO: 'Manipulation, measurement and observation',
    PDO: 'Presentation of data and observations',
    ACE: 'Analysis, conclusions and evaluation'
  };
  var TICK = '✓';
  var CROSS = '✗';

  /* ================================================================== small helpers (pure) */

  function str(v) { return v === undefined || v === null ? '' : String(v); }

  function round(x, d) {
    var f = Math.pow(10, d);
    return Math.round(x * f) / f;
  }

  /** x to d decimal places as a string (keeps trailing zeros). */
  function fmtDP(x, d) {
    return VL.sigfig && VL.sigfig.formatDP ? VL.sigfig.formatDP(x, d) : Number(x).toFixed(d);
  }

  /** x to n significant figures as a string (keeps trailing zeros). */
  function fmtSF(x, n) {
    return VL.sigfig && VL.sigfig.formatSF ? VL.sigfig.formatSF(x, n) : Number(x).toPrecision(n);
  }

  /**
   * Calculated number for explanations: rounded to n s.f. without padding zeros (0.0850 → 0.085), a proper minus
   * sign, and × 10ⁿ for very large / small values.
   */
  function show(x, n) {
    if (!isFinite(x)) return '—';
    var s = VL.marking && VL.marking.util && VL.marking.util.fmt ? VL.marking.util.fmt(x, n || 3) : fmtSF(x, n || 3).replace(/^-/, '−');
    return s.replace(/(\.\d*?)0+(?=$| ×)/, '$1').replace(/\.(?=$| ×)/, '');
  }

  /** Decimal places of a formatted number string. */
  function dpOf(s) {
    var m = /\.(\d+)$/.exec(str(s));
    return m ? m[1].length : 0;
  }

  /** Signed number with a real minus sign. */
  function minus(s) { return str(s).replace(/^-/, '−'); }

  /** Parse a typed number. */
  function parseNum(s) {
    if (VL.sigfig && VL.sigfig.parse) return VL.sigfig.parse(str(s));
    var t = str(s).trim();
    var v = Number(t);
    return { ok: t !== '' && isFinite(v), value: v, sf: NaN, dp: NaN, str: t };
  }

  /** Random error: VL.noise.gauss when loaded (so the global noise level applies), else a plain normal draw. */
  function noise(rng, sd) {
    return VL.noise && VL.noise.gauss ? VL.noise.gauss(rng, sd) : rng.normal(0, sd);
  }

  function dimsOf(unit) {
    try {
      var u = VL.units.parseUnit(unit);
      return u && u.ok ? u.dims : {};
    } catch (e) {
      return {};
    }
  }

  function rngFor(seed, name) {
    var r = VL.rng.create(VL.rng.normalizeSeed ? VL.rng.normalizeSeed(seed) : seed);
    return name ? r.fork(name) : r;
  }

  /** Build a Table from column definitions [{ heading, values: [str] }]. */
  function buildTable(cols) {
    var n = cols.reduce(function (m, c) { return Math.max(m, c.values.length); }, 0);
    var t = { columns: [], rows: [], nextId: 1 };
    cols.forEach(function (c, i) { t.columns.push({ id: 'c' + (i + 1), heading: c.heading }); });
    for (var r = 0; r < n; r++) {
      var cells = {};
      cols.forEach(function (c, i) { if (c.values[r] !== undefined) cells['c' + (i + 1)] = c.values[r]; });
      t.rows.push({ id: 'r' + (r + 1), cells: cells });
    }
    t.nextId = Math.max(cols.length, n) + 1;
    return t;
  }

  function stripMark(comment) {
    return str(comment).replace(/^\s*[✓✗]\s*/, '');
  }

  /* ================================================================== 1. graph drill data */

  /**
   * Linear relationships for the graph drill. make(rng) returns
   * { title, context, instruction, columns: [{heading, values}], x, y (column indexes), xName, yName, sign,
   *   truth: { gradient, intercept }, meaning }.
   */
  var RELATIONSHIPS = [
    {
      id: 'pendulum',
      make: function (rng) {
        var d = rng.uniform(1.8, 2.6), delta = rng.uniform(0, 0.4), amp = rng.uniform(4, 8);
        var exp = VL.getExperiment ? VL.getExperiment('pendulum') : null;
        var builtin = function (L) {
          var th = amp * Math.PI / 180;
          return 2 * Math.PI * Math.sqrt((L + d / 2 + delta) / 100 / 9.81) * (1 + th * th / 16);
        };
        var period = builtin, fromModel = false;
        if (exp && exp.model && typeof exp.model.period === 'function') {
          var probe = NaN;
          try { probe = exp.model.period(50, d, delta, amp); } catch (e) { probe = NaN; }
          if (isFinite(probe) && probe > 0.5 && probe < 3) {
            period = function (L) { return exp.model.period(L, d, delta, amp); };
            fromModel = true;
          }
        }
        var start = rng.int(18, 25), step = rng.int(11, 12);
        var Ls = [], Ts = [], T2s = [];
        for (var i = 0; i < 6; i++) {
          var L = round(start + i * step + rng.uniform(-0.4, 0.4), 1);
          var t20 = round(20 * period(L) + noise(rng, 0.06), 2);
          var T = Number(fmtDP(t20 / 20, 3));
          Ls.push(fmtDP(L, 1));
          Ts.push(fmtDP(T, 3));
          T2s.push(fmtSF(T * T, VL.sigfig ? VL.sigfig.sf(fmtDP(T, 3)) : 4));   // T² to the s.f. of T
        }
        var grad = 4 * Math.PI * Math.PI / 981;
        return {
          title: 'Simple pendulum',
          context: 'A student measured the period T of a simple pendulum for six lengths L of string, timing 20 oscillations each time.' +
            (fromModel ? ' (Data generated from the lab’s pendulum model.)' : ''),
          instruction: 'Plot a graph of T² on the y-axis against L on the x-axis.',
          columns: [{ heading: 'L / cm', values: Ls }, { heading: 'T / s', values: Ts }, { heading: 'T² / s²', values: T2s }],
          x: 0, y: 2, xName: 'L', yName: 'T²', sign: 1,
          truth: { gradient: grad, intercept: grad * (d / 2 + delta), gradientUnit: 's² cm⁻¹', interceptUnit: 's²' },
          meaning: 'T² = (4π²/g)(L + c), so the gradient is 4π²/g (about 0.040 s² cm⁻¹) and the small positive y-intercept comes from the extra length c (the bob radius and the pivot) that is not included in L.'
        };
      }
    },
    {
      id: 'spring',
      make: function (rng) {
        var l0 = rng.uniform(4.0, 7.0), k = rng.uniform(28, 44);
        var ms = [], ls = [];
        for (var i = 1; i <= 6; i++) {
          var m = 100 * i;
          ms.push(String(m));
          ls.push(fmtDP(l0 + 100 * 9.81 * m / 1000 / k + noise(rng, 0.08), 1));
        }
        return {
          title: 'Stretching a spring',
          context: 'A student hung slotted masses m on a spring and measured the length l of the spring each time with a metre rule.',
          instruction: 'Plot a graph of l on the y-axis against m on the x-axis.',
          columns: [{ heading: 'm / g', values: ms }, { heading: 'l / cm', values: ls }],
          x: 0, y: 1, xName: 'm', yName: 'l', sign: 1,
          truth: { gradient: 100 * 9.81 / 1000 / k, intercept: l0, gradientUnit: 'cm g⁻¹', interceptUnit: 'cm' },
          meaning: 'l = l₀ + (g/k) m, so the gradient is g/k and the y-intercept is the unstretched length l₀ of the spring.'
        };
      }
    },
    {
      id: 'emf',
      make: function (rng) {
        var E = rng.uniform(1.45, 1.6), r = rng.uniform(0.8, 2.0);
        var I0 = rng.uniform(0.08, 0.12), dI = rng.uniform(0.07, 0.085);
        var Is = [], Vs = [];
        for (var i = 0; i < 6; i++) {
          var I = round(I0 + i * dI + rng.uniform(-0.01, 0.01), 2);
          Is.push(fmtDP(I, 2));
          Vs.push(fmtDP(E - I * r + noise(rng, 0.006), 2));
        }
        return {
          title: 'e.m.f. and internal resistance',
          context: 'A student connected a cell in series with an ammeter and a variable resistor, with a voltmeter across the cell. For six settings of the resistor the current I and the potential difference V across the cell were recorded.',
          instruction: 'Plot a graph of V on the y-axis against I on the x-axis.',
          columns: [{ heading: 'I / A', values: Is }, { heading: 'V / V', values: Vs }],
          x: 0, y: 1, xName: 'I', yName: 'V', sign: -1,
          truth: { gradient: -r, intercept: E, gradientUnit: 'V A⁻¹ (Ω)', interceptUnit: 'V' },
          meaning: 'V = E − Ir, so the gradient is −r (negative: the internal resistance) and the y-intercept is the e.m.f. E.'
        };
      }
    },
    {
      id: 'lens',
      make: function (rng) {
        var f = rng.uniform(9, 16);
        var us = [], vs = [], ius = [], ivs = [];
        for (var i = 0; i < 6; i++) {
          var u = round(f * (1.5 + 0.5 * i) + rng.uniform(-0.3, 0.3), 1);
          var v = round(u * f / (u - f) + noise(rng, 0.25), 1);
          us.push(fmtDP(u, 1));
          vs.push(fmtDP(v, 1));
          ius.push(fmtSF(1 / u, 3));
          ivs.push(fmtSF(1 / v, 3));
        }
        return {
          title: 'Converging lens',
          context: 'A student found the image distance v for six object distances u using a converging lens and a screen.',
          instruction: 'Plot a graph of 1/v on the y-axis against 1/u on the x-axis.',
          columns: [{ heading: 'u / cm', values: us }, { heading: 'v / cm', values: vs }, { heading: '1/u / cm⁻¹', values: ius }, { heading: '1/v / cm⁻¹', values: ivs }],
          x: 2, y: 3, xName: '1/u', yName: '1/v', sign: -1,
          truth: { gradient: -1, intercept: 1 / f, gradientUnit: '(no unit)', interceptUnit: 'cm⁻¹' },
          meaning: '1/v = 1/f − 1/u, so the gradient should be −1 and the y-intercept is 1/f.'
        };
      }
    },
    {
      id: 'density',
      make: function (rng) {
        var rho = rng.uniform(1.02, 1.2), mc = rng.uniform(70, 110);
        var Vs = [], ms = [];
        for (var i = 0; i < 6; i++) {
          var V = 20 + 15 * i + rng.int(-2, 2);
          Vs.push(String(V));
          ms.push(fmtDP(mc + rho * V + noise(rng, 0.25), 1));
        }
        return {
          title: 'Density of a liquid',
          context: 'A student poured different volumes V of a salt solution into a measuring cylinder standing on a balance and recorded the total mass m each time.',
          instruction: 'Plot a graph of m on the y-axis against V on the x-axis.',
          columns: [{ heading: 'V / cm³', values: Vs }, { heading: 'm / g', values: ms }],
          x: 0, y: 1, xName: 'V', yName: 'm', sign: 1,
          truth: { gradient: rho, intercept: mc, gradientUnit: 'g cm⁻³', interceptUnit: 'g' },
          meaning: 'm = ρV + m_c, so the gradient is the density ρ of the solution and the y-intercept is the mass of the empty measuring cylinder.'
        };
      }
    },
    {
      id: 'wire',
      make: function (rng) {
        var a = rng.uniform(0.06, 0.11), Rc = rng.uniform(0.15, 0.45);
        var Ls = [], Rs = [];
        for (var i = 0; i < 6; i++) {
          var L = round(20 + 15 * i + rng.uniform(-0.5, 0.5), 1);
          Ls.push(fmtDP(L, 1));
          Rs.push(fmtSF((a * L + Rc) * (1 + noise(rng, 0.008)), 3));
        }
        return {
          title: 'Resistance of a wire',
          context: 'A student measured the resistance R of six different lengths L of a wire (R was calculated from voltmeter and ammeter readings).',
          instruction: 'Plot a graph of R on the y-axis against L on the x-axis.',
          columns: [{ heading: 'L / cm', values: Ls }, { heading: 'R / Ω', values: Rs }],
          x: 0, y: 1, xName: 'L', yName: 'R', sign: 1,
          truth: { gradient: a, intercept: Rc, gradientUnit: 'Ω cm⁻¹', interceptUnit: 'Ω' },
          meaning: 'R = (ρ/A) L + R_c, so the gradient is ρ/A and the small y-intercept is the resistance of the contacts and leads.'
        };
      }
    }
  ];

  /**
   * Graph-drill dataset for a seed.
   * @param {string} seed e.g. 'GRD-7K2Q-91C3'
   * @returns {object} { seed, id, title, context, instruction, table, xColId, yColId, xName, yName, sign, truth, meaning }
   */
  function graphDataset(seed) {
    var rel = rngFor(seed, 'pick').pick(RELATIONSHIPS);
    var ds = null;
    // A set is only used when a careful student CAN earn every mark (good scales exist, the scatter is balanced
    // about the best line ...): the examiner-style model graph is marked, and the data are redrawn (deterministically,
    // from the next sub-stream of the seed) if it would lose a mark.
    for (var attempt = 0; attempt < 15; attempt++) {
      ds = rel.make(rngFor(seed, attempt ? 'data/' + attempt : 'data'));
      ds.seed = seed;
      ds.id = rel.id;
      ds.table = buildTable(ds.columns);
      ds.xColId = ds.table.columns[ds.x].id;
      ds.yColId = ds.table.columns[ds.y].id;
      ds.xHeading = ds.columns[ds.x].heading;
      ds.yHeading = ds.columns[ds.y].heading;
      if (modelEarnsFullMarks(ds)) break;
    }
    return ds;
  }

  /** True when the model graph of a dataset scores full marks (or when it cannot be checked in this build). */
  function modelEarnsFullMarks(ds) {
    if (!VL.graph || !VL.graph.modelGraph || !VL.marking || !VL.marking.points) return true;
    try {
      var mg = VL.graph.modelGraph(ds.table, ds.xColId, ds.yColId);
      var m = VL.graph.checkTriangle(mg).gradient;
      if (m === null || !isFinite(m)) return false;
      var res = markGraph(ds, mg, { gradient: String(Number(m.toPrecision(3))), intercept: str(mg.intercept && mg.intercept.value) });
      return res.total === res.max;
    } catch (e) {
      return true;
    }
  }

  /* ================================================================== 2. uncertainty questions */

  /**
   * Is a typed answer acceptable?
   * Accepted when it is within field.relTol of the exact answer (or of an accepted alternative), or when it is the
   * exact answer correctly rounded to the number of figures typed (at least field.minSF significant figures).
   * A trailing unit (or %) matching the expected unit may be typed.
   * @param {{answer:number, unit?:string, relTol?:number, minSF?:number, alternatives?:number[]}} field
   * @param {string} typed
   * @returns {{ok:boolean, error:string|null, value:number}}
   */
  function checkField(field, typed) {
    var s = str(typed).trim().replace(/[−–]/g, '-');
    if (field.unit) {
      var u = field.unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp('\\s*' + u + '\\s*$'), '');
    }
    s = s.replace(/\s*%\s*$/, '').trim();
    if (!s) return { ok: false, error: 'Type a value.', value: NaN };
    var p = parseNum(s);
    if (!p.ok) return { ok: false, error: '“' + str(typed).trim() + '” is not a number. Type just the number' + (field.unit ? ' (the unit ' + field.unit + ' is already given).' : '.'), value: NaN };
    var relTol = field.relTol === undefined ? 0.01 : field.relTol;
    var minSF = field.minSF === undefined ? 2 : field.minSF;
    var targets = [field.answer].concat(field.alternatives || []);
    var ok = targets.some(function (ans) {
      var d = Math.abs(p.value - ans);
      if (d <= relTol * Math.abs(ans) + 1e-12) return true;
      var half = 0.5 * Math.pow(10, -p.dp);
      return p.value !== 0 && isFinite(p.sf) && p.sf >= minSF && d <= half * (1 + 1e-9) + 1e-12;
    });
    return { ok: ok, error: null, value: p.value };
  }

  /**
   * Nine seeded uncertainty questions (always the same nine kinds, in order of difficulty).
   * Question = { id, kind, title, prompt: [paragraphs], fields: [{ key, label, unit, answer, relTol, minSF,
   *              alternatives? }], choice?: { key, legend, options: [{ value, label }], answer }, explain: [lines] }
   */
  function uncertaintyQuestions(seed) {
    var base = rngFor(seed);
    var qs = [];
    function q(id) { return base.fork(id); }

    // 1. absolute → percentage
    (function (r) {
      var c = r.pick([
        { what: 'the length l of a pendulum string', instr: 'a metre rule', sym: 'l', unit: 'cm', val: round(r.uniform(35, 95), 1), dp: 1, abs: 0.1 },
        { what: 'the diameter d of a wire', instr: 'a micrometer screw gauge', sym: 'd', unit: 'mm', val: round(r.uniform(0.25, 0.6), 2), dp: 2, abs: 0.01 },
        { what: 'the current I in a circuit', instr: 'an analogue ammeter', sym: 'I', unit: 'A', val: round(r.uniform(0.2, 0.85), 2), dp: 2, abs: 0.02 },
        { what: 'the mass m of a stone', instr: 'a top-pan balance', sym: 'm', unit: 'g', val: round(r.uniform(20, 80), 1), dp: 1, abs: 0.1 }
      ]);
      var pct = 100 * c.abs / c.val;
      qs.push({
        id: 'q1', kind: 'percentage', title: 'Absolute to percentage uncertainty',
        prompt: ['A student measures ' + c.what + ' with ' + c.instr + ': ' + c.sym + ' = ' + fmtDP(c.val, c.dp) + ' ' + c.unit +
          ', with an absolute uncertainty of ± ' + fmtDP(c.abs, c.dp) + ' ' + c.unit + '.', 'Calculate the percentage uncertainty in ' + c.sym + '.'],
        fields: [{ key: 'p', label: 'percentage uncertainty =', unit: '%', answer: pct, relTol: 0.03, minSF: 1 }],
        explain: ['Percentage uncertainty = (absolute uncertainty ÷ measured value) × 100 %.',
          '= (' + fmtDP(c.abs, c.dp) + ' ÷ ' + fmtDP(c.val, c.dp) + ') × 100 % = ' + show(pct, 3) + ' %.',
          'Uncertainties are normally given to 1 or 2 significant figures, so ' + show(pct, 2) + ' % (or ' + show(pct, 1) + ' %).']
      });
    })(q('q1'));

    // 2. repeated readings: mean and half the range
    (function (r) {
      var n = r.pick([10, 20]);
      var tb = n * r.uniform(0.9, 1.6);
      var ts;
      do {
        ts = [0, 1, 2].map(function () { return round(tb + r.normal(0, 0.12), 2); });
      } while (Math.max.apply(null, ts) - Math.min.apply(null, ts) < 0.05);
      var mean = (ts[0] + ts[1] + ts[2]) / 3;
      var hr = (Math.max.apply(null, ts) - Math.min.apply(null, ts)) / 2;
      qs.push({
        id: 'q2', kind: 'half-range', title: 'Repeated readings',
        prompt: ['A student times ' + n + ' oscillations of a pendulum three times. The stopwatch readings are ' +
          ts.map(function (t) { return fmtDP(t, 2) + ' s'; }).join(', ').replace(/, ([^,]*)$/, ' and $1') + '.',
          'Calculate the mean time t and the absolute uncertainty in t, taking the uncertainty as half the range of the readings.'],
        fields: [
          { key: 'mean', label: 'mean t =', unit: 's', answer: mean, relTol: 0.0005, minSF: 3 },
          { key: 'abs', label: 'uncertainty in t = ±', unit: 's', answer: hr, relTol: 0.03, minSF: 1 }
        ],
        explain: ['Mean t = (' + ts.map(function (t) { return fmtDP(t, 2); }).join(' + ') + ') ÷ 3 = ' + show(mean, 5) + ' s, which is ' + fmtDP(mean, 2) + ' s to the same number of decimal places as the readings.',
          'Range = largest − smallest = ' + fmtDP(Math.max.apply(null, ts), 2) + ' − ' + fmtDP(Math.min.apply(null, ts), 2) + ' = ' + fmtDP(2 * hr, 2) + ' s.',
          'Uncertainty = half the range = ' + fmtDP(2 * hr, 2) + ' ÷ 2 = ' + show(hr, 3) + ' s.',
          'Written with the uncertainty to 1 significant figure and the mean to the same number of decimal places: t = ' +
            fmtDP(mean, dpOf(fmtSF(hr, 1))) + ' ± ' + fmtSF(hr, 1) + ' s.']
      });
    })(q('q2'));

    // 3. uncertainty of a mean → percentage
    (function (r) {
      var db = r.uniform(0.3, 0.55);
      var ds;
      do {
        ds = [0, 1, 2, 3].map(function () { return round(db + r.normal(0, 0.008), 2); });
      } while (Math.max.apply(null, ds) - Math.min.apply(null, ds) < 0.01);
      var mean = ds.reduce(function (a, b) { return a + b; }, 0) / 4;
      var hr = (Math.max.apply(null, ds) - Math.min.apply(null, ds)) / 2;
      var pct = 100 * hr / mean;
      qs.push({
        id: 'q3', kind: 'mean', title: 'Uncertainty in a mean value',
        prompt: ['The diameter d of a wire is measured with a micrometer screw gauge at four places along the wire: ' +
          ds.map(function (x) { return fmtDP(x, 2) + ' mm'; }).join(', ').replace(/, ([^,]*)$/, ' and $1') + '.',
          'Calculate the mean value of d and its percentage uncertainty, taking the absolute uncertainty as half the range.'],
        fields: [
          { key: 'mean', label: 'mean d =', unit: 'mm', answer: mean, relTol: 0.002, minSF: 2 },
          { key: 'pct', label: 'percentage uncertainty in d =', unit: '%', answer: pct, relTol: 0.05, minSF: 1, alternatives: [100 * hr / round(mean, 2)] }
        ],
        explain: ['Mean d = (' + ds.map(function (x) { return fmtDP(x, 2); }).join(' + ') + ') ÷ 4 = ' + show(mean, 4) + ' mm.',
          'Absolute uncertainty = half the range = (' + fmtDP(Math.max.apply(null, ds), 2) + ' − ' + fmtDP(Math.min.apply(null, ds), 2) + ') ÷ 2 = ' + show(hr, 2) + ' mm.',
          'Percentage uncertainty = (' + show(hr, 2) + ' ÷ ' + show(mean, 3) + ') × 100 % = ' + show(pct, 2) + ' %.']
      });
    })(q('q3'));

    // 4. products and quotients with a power
    (function (r) {
      var item;
      if (r.chance(0.5)) {
        var a = round(r.uniform(1.5, 9.5), 2), da = r.pick([0.01, 0.02, 0.05]);
        var b = round(r.uniform(0.8, 3), 2), db = r.pick([0.01, 0.02]);
        var c = round(r.uniform(2, 9), 1), dc = r.pick([0.1, 0.2]);
        var pa = 100 * da / a, pb = 100 * db / b, pc = 100 * dc / c;
        item = {
          prompt: ['A quantity x is calculated using x = ab²/c, where',
            'a = ' + fmtDP(a, 2) + ' ± ' + fmtDP(da, 2) + ',  b = ' + fmtDP(b, 2) + ' ± ' + fmtDP(db, 2) + '  and  c = ' + fmtDP(c, 1) + ' ± ' + fmtDP(dc, 1) + '.',
            'Calculate the percentage uncertainty in x.'],
          answer: pa + 2 * pb + pc,
          explain: ['For products and quotients the percentage uncertainties ADD; a quantity raised to a power n contributes n times its percentage uncertainty.',
            '%a = ' + show(pa, 3) + ' %,  %b = ' + show(pb, 3) + ' %,  %c = ' + show(pc, 3) + ' %.',
            '%x = %a + 2 × %b + %c = ' + show(pa, 3) + ' + ' + show(2 * pb, 3) + ' + ' + show(pc, 3) + ' = ' + show(pa + 2 * pb + pc, 3) + ' %.']
        };
      } else {
        var m = round(r.uniform(20, 60), 1), d = round(r.uniform(1.5, 2.5), 2), h = round(r.uniform(3, 6), 2);
        var pm = 100 * 0.1 / m, pd = 100 * 0.01 / d, ph = 100 * 0.02 / h;
        item = {
          prompt: ['The density ρ of a metal cylinder is found using ρ = 4m / (πd²h).',
            'The measurements are m = ' + fmtDP(m, 1) + ' ± 0.1 g,  d = ' + fmtDP(d, 2) + ' ± 0.01 cm  and  h = ' + fmtDP(h, 2) + ' ± 0.02 cm.',
            'Calculate the percentage uncertainty in ρ.'],
          answer: pm + 2 * pd + ph,
          explain: ['For products and quotients the percentage uncertainties ADD; d is squared, so its percentage uncertainty counts twice. The numbers 4 and π have no uncertainty.',
            '%m = ' + show(pm, 3) + ' %,  %d = ' + show(pd, 3) + ' %,  %h = ' + show(ph, 3) + ' %.',
            '%ρ = %m + 2 × %d + %h = ' + show(pm, 3) + ' + ' + show(2 * pd, 3) + ' + ' + show(ph, 3) + ' = ' + show(pm + 2 * pd + ph, 3) + ' %.']
        };
      }
      qs.push({
        id: 'q4', kind: 'product', title: 'Combining uncertainties: products and quotients',
        prompt: item.prompt,
        fields: [{ key: 'pct', label: 'percentage uncertainty =', unit: '%', answer: item.answer, relTol: 0.04, minSF: 1 }],
        explain: item.explain
      });
    })(q('q4'));

    // 5. powers and roots
    (function (r) {
      var kind = r.pick(['sphere', 'root', 'pendulum']);
      var item;
      if (kind === 'sphere') {
        var rad = round(r.uniform(0.8, 2.5), 2), pr = 100 * 0.01 / rad;
        item = {
          prompt: ['The radius of a ball bearing is measured as r = ' + fmtDP(rad, 2) + ' ± 0.01 cm. Its volume is V = (4/3)πr³.',
            'Calculate the percentage uncertainty in V.'],
          answer: 3 * pr,
          explain: ['%r = (0.01 ÷ ' + fmtDP(rad, 2) + ') × 100 % = ' + show(pr, 3) + ' %.',
            'r is cubed, so %V = 3 × %r = ' + show(3 * pr, 3) + ' %. (4/3 and π have no uncertainty.)']
        };
      } else if (kind === 'root') {
        var hh = round(r.uniform(20, 90), 1), ph = 100 * 0.2 / hh;
        item = {
          prompt: ['A ball falls from rest through a height h = ' + fmtDP(hh, 1) + ' ± 0.2 cm. Its speed at the bottom is v = √(2gh), where g has no uncertainty.',
            'Calculate the percentage uncertainty in v.'],
          answer: ph / 2,
          explain: ['%h = (0.2 ÷ ' + fmtDP(hh, 1) + ') × 100 % = ' + show(ph, 3) + ' %.',
            'A square root is a power of ½, so %v = ½ × %h = ' + show(ph / 2, 3) + ' %.']
        };
      } else {
        var L = round(r.uniform(40, 95), 1), T = round(r.uniform(1.3, 1.9), 2);
        var pL = 100 * 0.1 / L, pT = 100 * 0.02 / T;
        item = {
          prompt: ['A student finds g using g = 4π²L / T², with L = ' + fmtDP(L, 1) + ' ± 0.1 cm and T = ' + fmtDP(T, 2) + ' ± 0.02 s.',
            'Calculate the percentage uncertainty in g.'],
          answer: pL + 2 * pT,
          explain: ['%L = ' + show(pL, 3) + ' %,  %T = ' + show(pT, 3) + ' %.',
            'T is squared, so %g = %L + 2 × %T = ' + show(pL, 3) + ' + ' + show(2 * pT, 3) + ' = ' + show(pL + 2 * pT, 3) + ' %.',
            'Notice that the uncertainty in T dominates: timing more oscillations reduces it.']
        };
      }
      qs.push({
        id: 'q5', kind: 'power', title: 'Powers and roots',
        prompt: item.prompt,
        fields: [{ key: 'pct', label: 'percentage uncertainty =', unit: '%', answer: item.answer, relTol: 0.04, minSF: 1 }],
        explain: item.explain
      });
    })(q('q5'));

    // 6. absolute uncertainty from a percentage
    (function (r) {
      var c = r.pick([
        { name: 'resistance R', sym: 'R', unit: 'Ω', val: round(r.uniform(5, 40), 1), dp: 1, pct: round(r.uniform(2, 6), 1) },
        { name: 'spring constant k', sym: 'k', unit: 'N m⁻¹', val: round(r.uniform(15, 60), 1), dp: 1, pct: round(r.uniform(3, 8), 1) },
        { name: 'acceleration of free fall g', sym: 'g', unit: 'm s⁻²', val: round(r.uniform(9.2, 10.4), 2), dp: 2, pct: round(r.uniform(3, 9), 0) }
      ]);
      var abs = c.val * c.pct / 100;
      qs.push({
        id: 'q6', kind: 'from-percent', title: 'Absolute uncertainty from a percentage',
        prompt: ['A student calculates the ' + c.name + ' as ' + c.sym + ' = ' + fmtDP(c.val, c.dp) + ' ' + c.unit + ' with a percentage uncertainty of ' + c.pct + ' %.',
          'Calculate the absolute uncertainty in ' + c.sym + '.'],
        fields: [{ key: 'abs', label: 'absolute uncertainty = ±', unit: c.unit, answer: abs, relTol: 0.03, minSF: 1 }],
        explain: ['Absolute uncertainty = (percentage uncertainty ÷ 100) × value = (' + c.pct + ' ÷ 100) × ' + fmtDP(c.val, c.dp) + ' = ' + show(abs, 3) + ' ' + c.unit + '.',
          'Give it to 1 (or 2) significant figures: ' + c.sym + ' = ' + fmtDP(c.val, c.dp) + ' ± ' + show(abs, 1) + ' ' + c.unit + '.']
      });
    })(q('q6'));

    // 7. comparing two values of k against a criterion
    (function (r) {
      var crit = r.pick([5, 10]);
      var agree = r.chance(0.5);
      var k1, k2, defs;
      for (var tries = 0; tries < 40; tries++) {
        k1 = Number(fmtSF(r.uniform(2, 6), 3));
        var f = agree ? r.uniform(0.3, crit - 1.5) : r.uniform(crit + 1.5, crit + 12);
        k2 = Number(fmtSF(k1 * (1 + (r.chance(0.5) ? 1 : -1) * f / 100), 3));
        var diff = Math.abs(k1 - k2);
        defs = [100 * diff / ((k1 + k2) / 2), 100 * diff / k1, 100 * diff / k2];
        var sameSide = defs.every(function (d) { return agree ? d <= crit - 0.3 : d >= crit + 0.3; });
        if (sameSide && diff > 0) break;
      }
      var pd = defs[0];
      qs.push({
        id: 'q7', kind: 'compare', title: 'Testing a relationship',
        prompt: ['A student calculates two values of the constant k in a suggested relationship: k₁ = ' + fmtSF(k1, 3) + ' and k₂ = ' + fmtSF(k2, 3) + ' (same unit).',
          'The student decides that the results support the relationship if the two values of k are within ' + crit + ' % of each other.',
          'Calculate the percentage difference between the two values of k, then decide whether the results support the relationship.'],
        fields: [{ key: 'pd', label: 'percentage difference =', unit: '%', answer: pd, alternatives: [defs[1], defs[2]], relTol: 0.03, minSF: 1 }],
        choice: {
          key: 'support', legend: 'Do the results support the relationship?',
          options: [{ value: 'yes', label: 'Yes — the values agree within ' + crit + ' %' }, { value: 'no', label: 'No — the difference is more than ' + crit + ' %' }],
          answer: agree ? 'yes' : 'no'
        },
        explain: ['Percentage difference = (difference ÷ mean value) × 100 % = (' + show(Math.abs(k1 - k2), 2) + ' ÷ ' + show((k1 + k2) / 2, 4) + ') × 100 % = ' + show(pd, 2) + ' %.' +
          ' (Dividing by k₁ or k₂ instead is also accepted: ' + show(defs[1], 2) + ' % or ' + show(defs[2], 2) + ' %.)',
          show(pd, 2) + ' % is ' + (agree ? 'less' : 'more') + ' than ' + crit + ' %, so the results ' + (agree ? 'support' : 'do not support') + ' the relationship.',
          'In an exam, always state your criterion with a number, and make your conclusion consistent with your own values.']
      });
    })(q('q7'));

    // 8. sums and differences
    (function (r) {
      var x1 = round(r.uniform(2, 15), 1), x2 = round(r.uniform(55, 95), 1);
      var thing = r.pick([['the top of a spring', 'its bottom', 'length l of the spring'], ['the upper rubber band on a tube', 'the lower band', 'distance l between the bands']]);
      qs.push({
        id: 'q8', kind: 'difference', title: 'Sums and differences',
        prompt: ['On a vertical metre rule, ' + thing[0] + ' is level with the ' + fmtDP(x1, 1) + ' cm mark and ' + thing[1] + ' with the ' + fmtDP(x2, 1) + ' cm mark. Each reading has an uncertainty of ± 0.1 cm.',
          'Calculate the ' + thing[2] + ' and its absolute uncertainty.'],
        fields: [
          { key: 'l', label: 'l =', unit: 'cm', answer: x2 - x1, relTol: 0.0005, minSF: 3 },
          { key: 'abs', label: 'uncertainty in l = ±', unit: 'cm', answer: 0.2, relTol: 0.03, minSF: 1 }
        ],
        explain: ['l = ' + fmtDP(x2, 1) + ' − ' + fmtDP(x1, 1) + ' = ' + fmtDP(x2 - x1, 1) + ' cm.',
          'When quantities are added or subtracted, their ABSOLUTE uncertainties add: 0.1 + 0.1 = 0.2 cm.',
          'So l = ' + fmtDP(x2 - x1, 1) + ' ± 0.2 cm.']
      });
    })(q('q8'));

    // 9. timing n oscillations
    (function (r) {
      var n = r.pick([10, 20]);
      var t = round(n * r.uniform(0.8, 1.9), 2);
      var dt = r.pick([0.2, 0.3]);
      qs.push({
        id: 'q9', kind: 'oscillations', title: 'Timing many oscillations',
        prompt: ['The time for ' + n + ' oscillations of a pendulum is t = ' + fmtDP(t, 2) + ' s. The uncertainty in t (mostly reaction time) is estimated as ± ' + fmtDP(dt, 1) + ' s.',
          'Calculate the period T and the absolute uncertainty in T.'],
        fields: [
          { key: 'T', label: 'T =', unit: 's', answer: t / n, relTol: 0.001, minSF: 3 },
          { key: 'abs', label: 'uncertainty in T = ±', unit: 's', answer: dt / n, relTol: 0.03, minSF: 1 }
        ],
        explain: ['T = t ÷ ' + n + ' = ' + fmtDP(t, 2) + ' ÷ ' + n + ' = ' + show(t / n, 4) + ' s.',
          'The uncertainty is shared between the ' + n + ' oscillations: ΔT = ' + fmtDP(dt, 1) + ' ÷ ' + n + ' = ' + show(dt / n, 2) + ' s.',
          'This is why you time ' + n + ' oscillations rather than one: the percentage uncertainty is ' + n + ' times smaller.']
      });
    })(q('q9'));

    return qs;
  }

  /* ================================================================== 3. table drill scenarios */

  /** Pick an index for the "exact mark" trap reading. */
  function trapIndex(rng) { return rng.int(1, 4); }

  var TABLE_SCENARIOS = [
    {
      id: 'pendulum',
      make: function (rng) {
        var start = rng.int(20, 28), step = rng.int(11, 13);
        var trap = trapIndex(rng), trap2 = rng.int(0, 5);
        var sets = [], L = [], t = [];
        for (var i = 0; i < 6; i++) {
          var Lv = i === trap ? Math.round(start + i * step) : round(start + i * step + rng.uniform(0.1, 0.9), 1);
          var T = 2 * Math.PI * Math.sqrt((Lv + 1.3) / 981);
          var tv = round(20 * T + noise(rng, 0.05), 2);
          if (i === trap2) tv = round(tv, 1);
          L.push(fmtDP(Lv, 1));
          t.push(fmtDP(tv, 2));
          sets.push([
            i === trap ? 'Metre rule: the length L is exactly at the ' + Lv + ' cm mark.' : 'Metre rule: the length L reads ' + fmtDP(Lv, 1) + ' cm.',
            'Stopwatch (20 oscillations) shows ' + fmtDP(tv, 2) + ' s.'
          ]);
        }
        return {
          title: 'Simple pendulum',
          intro: 'A student measures the length L of a pendulum with a metre rule and the time t for 20 oscillations with a stopwatch, for six different lengths.',
          task: 'Record all the readings in a results table. Include a column for the period T of the pendulum (T = t ÷ 20).',
          sets: sets,
          quantities: [
            { id: 'L', symbols: ['L', 'l'], unit: 'cm', kind: 'raw', label: 'L' },
            { id: 't', symbols: ['t', '20T', 't20', 't_20', 'nT', 't(20)'], unit: 's', kind: 'raw', label: 't' },
            { id: 'T', symbols: ['T'], unit: 's', kind: 'derived', label: 'T' }
          ],
          raw: [{ q: 'L', resSI: 0.001, values: L, unit: 'cm', instrument: 'metre rule (to the nearest mm)' },
            { q: 't', resSI: 0.01, values: t, unit: 's', instrument: 'stopwatch (0.01 s)' }],
          derived: { q: 'T', from: ['t'], name: 'T', compute: function (rv) { return rv.t / 20; } },
          model: {
            headings: ['L / cm', 't / s', 'T / s'],
            rows: L.map(function (l, i) { return [l, t[i], fmtSF(Number(t[i]) / 20, Math.min(5, Math.max(2, VL.sigfig ? VL.sigfig.sf(t[i]) : 4)))]; }),
            notes: ['L is read from a metre rule to the nearest millimetre, so every value has 1 decimal place in cm — including “' + L[trap] + '”, not “' + Math.round(Number(L[trap])) + '”.',
              't is recorded exactly as the stopwatch shows it (2 decimal places), including a final zero such as “' + t[trap2] + '”.',
              'T = t ÷ 20 is given to the same number of significant figures as t (or one more).']
          }
        };
      }
    },
    {
      id: 'resistance',
      make: function (rng) {
        var a = rng.uniform(0.06, 0.1), Rc = rng.uniform(0.1, 0.3), Rs = rng.uniform(1.2, 2);
        var trap = trapIndex(rng);
        var sets = [], L = [], V = [], I = [];
        for (var i = 0; i < 6; i++) {
          var Lv = round(18 + 14 * i + rng.uniform(0.1, 0.9), 1);
          var R = a * Lv + Rc;
          var Iv = round(1.5 / (R + Rs), 2);
          if (i === trap) Iv = round(Iv, 1) || 0.3;
          var Vv = round(Iv * R + noise(rng, 0.005), 2);
          L.push(fmtDP(Lv, 1));
          V.push(fmtDP(Vv, 2));
          I.push(fmtDP(Iv, 2));
          sets.push([
            'Metre rule: the crocodile clip is at the ' + fmtDP(Lv, 1) + ' cm mark (L).',
            'Digital voltmeter shows ' + fmtDP(Vv, 2) + ' V.',
            i === trap ? 'Analogue ammeter (divisions every 0.02 A): the needle is exactly on the ' + fmtDP(Iv, 1) + ' A mark.'
              : 'Analogue ammeter (divisions every 0.02 A): the needle points to ' + fmtDP(Iv, 2) + ' A.'
          ]);
        }
        return {
          title: 'Resistance of a wire',
          intro: 'A student connects different lengths L of a resistance wire into a circuit and records the potential difference V across the wire and the current I in it.',
          task: 'Record all the readings in a results table. Include a column for the resistance R of the wire (R = V ÷ I).',
          sets: sets,
          quantities: [
            { id: 'L', symbols: ['L', 'l'], unit: 'cm', kind: 'raw', label: 'L' },
            { id: 'V', symbols: ['V'], unit: 'V', kind: 'raw', label: 'V' },
            { id: 'I', symbols: ['I'], unit: 'A', kind: 'raw', label: 'I' },
            { id: 'R', symbols: ['R'], unit: 'Ω', kind: 'derived', label: 'R' }
          ],
          raw: [{ q: 'L', resSI: 0.001, values: L, unit: 'cm', instrument: 'metre rule (to the nearest mm)' },
            { q: 'V', resSI: 0.01, values: V, unit: 'V', instrument: 'voltmeter (0.01 V)' },
            { q: 'I', resSI: 0.01, values: I, unit: 'A', instrument: 'ammeter (read to 0.01 A)' }],
          derived: { q: 'R', from: ['V', 'I'], name: 'R', compute: function (rv) { return rv.V / rv.I; } },
          model: {
            headings: ['L / cm', 'V / V', 'I / A', 'R / Ω'],
            rows: L.map(function (l, i) {
              var sf = Math.min(VL.sigfig ? VL.sigfig.sf(V[i]) : 3, VL.sigfig ? VL.sigfig.sf(I[i]) : 2);
              return [l, V[i], I[i], fmtSF(Number(V[i]) / Number(I[i]), sf)];
            }),
            notes: ['A needle exactly on the ' + fmtDP(Number(I[trap]), 1) + ' A mark is still read to 0.01 A, so write ' + I[trap] + ', not ' + fmtDP(Number(I[trap]), 1) + '.',
              'Units go in the column headings (R / Ω), never next to the numbers in the cells.',
              'R = V ÷ I is given to the least number of significant figures in V and I for that row (or one more).']
          }
        };
      }
    },
    {
      id: 'lens',
      make: function (rng) {
        var f = rng.uniform(10, 15);
        var trap = trapIndex(rng);
        var sets = [], u = [], v = [];
        for (var i = 0; i < 6; i++) {
          var uv = round(f * (1.5 + 0.45 * i) + rng.uniform(-0.4, 0.4), 1);
          var vv = round(uv * f / (uv - f) + noise(rng, 0.2), 1);
          if (i === trap) vv = Math.round(vv);
          u.push(fmtDP(uv, 1));
          v.push(fmtDP(vv, 1));
          sets.push([
            'Metre rule: object distance u = ' + fmtDP(uv, 1) + ' cm.',
            i === trap ? 'Metre rule: the sharp image is on the screen exactly at the ' + vv + ' cm mark from the lens (v).'
              : 'Metre rule: the sharp image is at v = ' + fmtDP(vv, 1) + ' cm from the lens.'
          ]);
        }
        return {
          title: 'Converging lens',
          intro: 'A student uses a converging lens to form sharp images of an illuminated object on a screen. For six object distances u the student measures the image distance v.',
          task: 'Record all the readings in a results table. Include a column for 1/v.',
          sets: sets,
          quantities: [
            { id: 'u', symbols: ['u'], unit: 'cm', kind: 'raw', label: 'u' },
            { id: 'v', symbols: ['v'], unit: 'cm', kind: 'raw', label: 'v' },
            { id: 'iv', symbols: ['1/v', 'v^-1'], unit: 'cm⁻¹', kind: 'derived', label: '1/v' },
            { id: 'iu', symbols: ['1/u', 'u^-1'], unit: 'cm⁻¹', kind: 'derived', label: '1/u' }
          ],
          raw: [{ q: 'u', resSI: 0.001, values: u, unit: 'cm', instrument: 'metre rule (to the nearest mm)' },
            { q: 'v', resSI: 0.001, values: v, unit: 'cm', instrument: 'metre rule (to the nearest mm)' }],
          derived: { q: 'iv', from: ['v'], name: '1/v', compute: function (rv) { return 1 / rv.v; } },
          model: {
            headings: ['u / cm', 'v / cm', '1/v / cm⁻¹'],
            rows: u.map(function (x, i) { return [x, v[i], fmtSF(1 / Number(v[i]), VL.sigfig ? VL.sigfig.sf(v[i]) : 3)]; }),
            notes: ['Both distances are read to the nearest millimetre, so “' + v[trap] + '” needs its decimal place.',
              'The heading for the calculated column is 1/v / cm⁻¹ (the unit of 1/v is cm⁻¹).',
              '1/v has the same number of significant figures as v (or one more): leading zeros in 0.0xxx do not count.']
          }
        };
      }
    },
    {
      id: 'density',
      make: function (rng) {
        var rho = rng.uniform(0.79, 1.25);
        var trap = rng.int(0, 5);
        var sets = [], V = [], m = [];
        for (var i = 0; i < 6; i++) {
          var Vv = 15 + 12 * i + rng.int(-2, 2);
          var mv = round(rho * Vv + noise(rng, 0.04), 2);
          if (i === trap) mv = round(mv, 1);
          V.push(String(Vv));
          m.push(fmtDP(mv, 2));
          sets.push([
            'Measuring cylinder (1 cm³ divisions): the bottom of the meniscus is on the ' + Vv + ' cm³ mark (V).',
            'Balance (tared with the empty beaker) shows ' + fmtDP(mv, 2) + ' g (m).'
          ]);
        }
        return {
          title: 'Density of a liquid',
          intro: 'A student measures volumes V of a liquid in a measuring cylinder, pours each into a beaker on a tared balance and records its mass m.',
          task: 'Record all the readings in a results table. Include a column for the density ρ of the liquid (ρ = m ÷ V).',
          sets: sets,
          quantities: [
            { id: 'V', symbols: ['V'], unit: 'cm³', kind: 'raw', label: 'V' },
            { id: 'm', symbols: ['m'], unit: 'g', kind: 'raw', label: 'm' },
            { id: 'rho', symbols: ['ρ', 'rho', 'density', 'm/V', 'd', 'D'], unit: 'g cm⁻³', kind: 'derived', label: 'ρ' }
          ],
          raw: [{ q: 'V', resSI: 1e-6, values: V, unit: 'cm³', instrument: 'measuring cylinder (1 cm³)' },
            { q: 'm', resSI: 1e-5, values: m, unit: 'g', instrument: 'balance (0.01 g)' }],
          derived: { q: 'rho', from: ['m', 'V'], name: 'ρ', compute: function (rv) { return rv.m / rv.V; } },
          model: {
            headings: ['V / cm³', 'm / g', 'ρ / g cm⁻³'],
            rows: V.map(function (x, i) { return [x, m[i], fmtSF(Number(m[i]) / Number(x), VL.sigfig ? VL.sigfig.sf(x) : 2)]; }),
            notes: ['The balance reading “' + m[trap] + '” is recorded exactly as displayed, final zero included.',
              'V is read to the nearest 1 cm³, so it has no decimal places; most values of V have only 2 significant figures.',
              'ρ = m ÷ V is therefore given to 2 significant figures (or 3) — not to the 4 significant figures of m.']
          }
        };
      }
    },
    {
      id: 'fall',
      make: function (rng) {
        var trap = trapIndex(rng), trap2 = rng.int(0, 5);
        var sets = [], hh = [], t = [];
        for (var i = 0; i < 6; i++) {
          var hv = i === trap ? 20 + 13 * i + rng.int(0, 1) * 5 : round(20 + 13 * i + rng.uniform(0.1, 0.9), 1);
          var tv = round(Math.sqrt(2 * hv / 100 / 9.81) + 0.004 + noise(rng, 0.0015), 3);
          if (i === trap2) tv = round(tv, 2);
          hh.push(fmtDP(hv, 1));
          t.push(fmtDP(tv, 3));
          sets.push([
            i === trap ? 'Metre rule: the ball is released with its bottom exactly at the ' + hv + ' cm mark above the light gate (h).'
              : 'Metre rule: the drop height h is ' + fmtDP(hv, 1) + ' cm.',
            'Light-gate timer shows ' + fmtDP(tv, 3) + ' s (t).'
          ]);
        }
        return {
          title: 'Free fall with a light gate',
          intro: 'A student drops a ball from rest through different heights h and an electronic timer with a light gate records the time t of the fall.',
          task: 'Record all the readings in a results table. Include a column for t².',
          sets: sets,
          quantities: [
            { id: 'h', symbols: ['h'], unit: 'cm', kind: 'raw', label: 'h' },
            { id: 't', symbols: ['t'], unit: 's', kind: 'raw', label: 't' },
            { id: 't2', symbols: ['t^2', 't2'], unit: 's²', kind: 'derived', label: 't²' }
          ],
          raw: [{ q: 'h', resSI: 0.001, values: hh, unit: 'cm', instrument: 'metre rule (to the nearest mm)' },
            { q: 't', resSI: 0.001, values: t, unit: 's', instrument: 'light-gate timer (0.001 s)' }],
          derived: { q: 't2', from: ['t'], name: 't²', compute: function (rv) { return rv.t * rv.t; } },
          model: {
            headings: ['h / cm', 't / s', 't² / s²'],
            rows: hh.map(function (x, i) { return [x, t[i], fmtSF(Number(t[i]) * Number(t[i]), VL.sigfig ? VL.sigfig.sf(t[i]) : 3)]; }),
            notes: ['“' + hh[trap] + '” keeps its decimal place because the metre rule reads to the nearest millimetre.',
              'The timer shows 3 decimal places, so “' + t[trap2] + '” keeps its final zero.',
              't² has the same number of significant figures as t (or one more), e.g. 3 s.f.: 0.0xxx.']
          }
        };
      }
    }
  ];

  /**
   * Table-drill scenario for a seed.
   * @returns {object} { seed, id, title, intro, task, sets: [[reading text]], quantities, raw, derived, model }
   */
  function tableScenario(seed) {
    var def = rngFor(seed, 'pick').pick(TABLE_SCENARIOS);
    var sc = def.make(rngFor(seed, 'data'));
    sc.seed = seed;
    sc.id = def.id;
    return sc;
  }

  /* ================================================================== 4. evaluation banks */

  /** Concept with every argument a group of alternatives. */
  function C() {
    return { all: Array.prototype.slice.call(arguments).map(function (g) { return Array.isArray(g) ? g : [g]; }) };
  }
  function bankRow(id, limLabel, limConcepts, impLabel, impConcepts) {
    return { id: id, limitation: { label: limLabel, concepts: limConcepts }, improvement: { label: impLabel, concepts: impConcepts } };
  }

  var DIFFICULT = /(difficult|hard|judg|unsure|uncertain|not sure|tricky|awkward|not easy|problem|tell|decide)/;
  var REACTION_LIM = C(/reaction/, /(large|significant|compar|big|short|percentage|fraction|proportion|affect)/);
  var SHORT_TIME_LIM = C(/\b(time|times|t|period)\b/, /\b(short|small|quick|fast|less than)\b/, /(uncertain|error|difficult|hard|reaction|accura|judg)/);

  /** Shared bank row A: two sets of readings. */
  function rowTwoReadings() {
    return bankRow('A',
      'Two sets of readings are not enough to draw a valid conclusion.',
      [C([/\b(two|2|only one|few)\b/, /too few/],
        /\b(reading|result|set|value|measurement|data|point|trial|length|mass|height|distance|volume|load|stone|ball|lens|wire|k)/,
        /(not enough|insufficient|too few|not sufficient|conclusion|not valid|invalid|can ?not|unreliable|\bonly\b|enough|limited|small number)/)],
      'Take more readings (at least five sets over a wide range) and plot a graph.',
      [C(/\b(more|several|many|five|six|5|6|range|different|further|additional|extra|at least)\b/, /\b(graph|plot)/)]);
  }

  var EVAL_SCENARIOS = [
    {
      id: 'pendulum', title: 'Simple pendulum',
      text: 'A student investigates how the period T of a simple pendulum depends on its length L. The string is held in a split cork in a clamp. The student measures L with a metre rule, displaces the bob, releases it and times 10 oscillations with a stopwatch. This is done for two lengths (about 30 cm and 80 cm), and k = T²/L is calculated for each to test whether T² is proportional to L.',
      bank: [
        rowTwoReadings(),
        bankRow('B', 'Difficult to judge the start and end of an oscillation, or reaction time is large compared with the time measured.',
          [C(/(start|end|begin|stop|complete|finish|when|centre|center|middle|extreme|top)/, /(oscillat|swing|cycle|period)/, DIFFICULT), REACTION_LIM, SHORT_TIME_LIM,
            C(/(bob|pendulum)/, /(fast|quick|speed)/, /(time|judg|difficult|hard|when)/)],
          'Use a fiducial marker at the centre of the swing, time more oscillations (e.g. 20), or use a light gate / video with a timer.',
          [C(/(fiducial|marker|reference (mark|point|line)|pointer|\bpin\b|mark at the (centre|center|middle|bottom))/),
            C(/\b(more|20|twenty|30|thirty|50|larger number|greater number|many)\b/, /(oscillat|swing|cycle)/),
            C(/(light ?gate|motion sensor|photo ?gate)/), C(/(video|film|record|camera|slow ?motion)/, /(timer|clock|stopwatch|frame|time|replay|slow)/)]),
        bankRow('C', 'Difficult to measure L because the bob or cork position is hard to judge against the rule (the rule cannot touch the string).',
          [C([/\b(length|l)\b/, /\bmeasur/], DIFFICULT, /(bob|cork|string|rule|ruler|centre|center|top|pivot|clamp|parallax|far|distance|gap|away|touch|move|swing)/)],
          'Use a set square to line up the bob / cork with the rule, or clamp the rule vertically next to the string.',
          [C(/set ?square/), C(/(clamp|fix|hold|stand|secure)/, /(rule|ruler|metre)/),
            C(/(eye level|level with|perpendicular|at right angles)/, /(rule|ruler|scale|read|bob|eye)/)]),
        bankRow('D', 'The amplitude (release angle) was not kept the same; a large amplitude changes T.',
          [C(/(amplitude|angle|release|displace|pulled? (back|aside)|how far)/, /(not (kept )?(the )?same|different|differ|chang|vari|not constant|inconsistent|large|big|not controlled|not measured|not fixed)/)],
          'Use the protractor to release the bob from the same small angle (10° or less) each time.',
          [C(/(protractor|angle (scale|measurer|meter))/), C(/(same|fixed|constant|small|equal|controlled|consistent)/, /(angle|amplitude|release point|release position|displacement|starting position)/)]),
        bankRow('E', 'The bob did not swing in a single plane (it moved in an ellipse or twisted).',
          [C(/(plane|ellip|circle|circular|sideways|twist|spin|rotat|wobbl|oval|not straight|side to side|conical)/)],
          'Release the bob from a fixed point (e.g. against a card or a release mechanism), or use a bifilar (V-shaped) suspension.',
          [C(/(release mechanism|release device|electromagnet|fixed release|release (it )?from (a )?fixed|bifilar|two strings|v ?shaped)/),
            C(/(release|let go)/, /(card|ruler|board|mechanism|clamp|gate|holder|block)/)]),
        bankRow('F', 'The string may slip in the split cork, so the pivot (and L) is not fixed.',
          [C(/(slip|slid|loose|not fixed|not secure|not tight|moves|moving|wobbl)/, /(cork|string|pivot|clamp|top|support|suspension)/)],
          'Tighten the clamp on the split cork, and check L after each set of oscillations.',
          [C(/(tight|secure|firm|clamp|glue|tape|screw)/, /(cork|string|pivot|clamp|suspension)/), C(/(check|re ?measure|measure (it )?again)/, /\b(length|l)\b/)]),
        bankRow('G', 'The amplitude decreases during timing because of air resistance (damping).',
          [C(/(damp|air resistance|drag|amplitude (decreas|reduc|dies|gets smaller|falls)|slows|dies (down|away)|energy (is )?lost|friction)/)],
          'Use a denser or smaller (more streamlined) bob.',
          [C(/(dens|heavier|massive|smaller|streamlin|metal|steel|lead|iron)/, /(bob|ball|mass|sphere|weight)/)])
      ]
    },
    {
      id: 'spring', title: 'Stretching a spring',
      text: 'A student investigates whether the extension e of a spring is proportional to the load F. The spring hangs from a clamp next to a vertical metre rule. The student reads the position of the bottom of the spring with no load, then with two different loads (1.0 N and 3.0 N of slotted masses), and calculates k = F / e for each load.',
      bank: [
        rowTwoReadings(),
        bankRow('B', 'Difficult to read the position of the bottom of the spring against the rule (the spring is not touching the rule).',
          [C(/(length|extension|position|bottom|end|top|coil|pointer|reading)/, DIFFICULT, /(rule|ruler|scale|spring|coil|hook|hanger|end|bottom|parallax|gap|far|away|touch)/)],
          'Attach a pointer to the bottom of the spring that just touches the rule, or use a set square to transfer the position to the rule.',
          [C(/(pointer|marker|needle|\bpin\b|flag)/), { all: [[/set ?square/]], none: [[/(vertical|plumb)/]] },
            C(/(clamp|fix|place|move|position)/, /(rule|ruler)/, /(close|next to|beside|touch|alongside|behind)/)]),
        bankRow('C', 'The spring oscillates (bounces) after a load is added, so the reading keeps changing.',
          [C(/(oscillat|bounc|vibrat|swing|jump|wobbl|not still|keeps moving|up and down|moving)/, /(spring|mass|load|hanger|reading|pointer)/)],
          'Lower the masses gently and wait for the spring to come to rest before taking the reading.',
          [C(/(wait|until|at rest|still|stops|settle|stationary)/), C(/(gently|slowly|lower)/, /(mass|load|hanger)/)]),
        bankRow('D', 'The rule may not be vertical, so the reading is not the true length.',
          [C(/(rule|ruler|scale|metre)/, /(not vertical|vertical|tilt|angle|slant|lean|not straight|not parallel)/)],
          'Use a set square on the bench (or a plumb line) to check that the rule is vertical.',
          [C(/(plumb|spirit level|set ?square|level)/, /(vertical|rule|ruler|check)/)]),
        bankRow('E', 'Large loads may stretch the spring beyond its limit of proportionality (elastic limit).',
          [C(/(elastic limit|limit of proportionality|permanent|overstretch|over ?stretch|deform|damag|beyond|too (large|heavy|big))/)],
          'Use smaller loads, and check that the spring returns to its original length when the load is removed.',
          [C(/(smaller|lighter|less|lower|small)/, /(load|mass|weight|force)/), C(/(return|go back|original length|unload|remov)/, /(length|spring|original)/)]),
        bankRow('F', 'The slotted masses may not be exactly their stated values.',
          [C(/(mass|masses|weight|load)/, /(not exact|inaccurate|not accurate|vary|actual|labelled|stated|marked|nominal|tolerance)/)],
          'Measure each load on a balance (or with a newton meter).',
          [C(/\b(balance|weigh|weighed|weighing|top ?pan|newton ?meter|force ?meter)\b/)])
      ]
    },
    {
      id: 'ramp', title: 'Ball rolling down a ramp',
      text: 'A student releases a ball from rest near the top of a ramp and uses a stopwatch to time how long it takes to roll a distance of 80.0 cm along the ramp. This is done for two heights h of the raised end of the ramp, and k = t²h is calculated for each to test whether t² is inversely proportional to h.',
      bank: [
        rowTwoReadings(),
        bankRow('B', 'The time is short, so reaction time is large compared with the time measured.',
          [REACTION_LIM, SHORT_TIME_LIM],
          'Use light gates connected to a timer, or film the ball with a timer in view (or use a longer ramp to increase the time).',
          [C(/(light ?gate|photo ?gate|motion sensor)/), C(/(video|film|record|camera|slow ?motion)/), C(/(longer|increase|greater|larger)/, /(ramp|distance|length|track|runway|time)/)]),
        bankRow('C', 'Difficult to release the ball without pushing it, or from exactly the same point each time.',
          [C(/(release|let go|start)/, /(push|force|same (position|place|point)|not from rest|speed|velocity|hand|consistent)/), C(/(push|pushed|initial (speed|velocity))/)],
          'Hold the ball behind a ruler or card at a marked start line and lift it away to release it (or use a release gate).',
          [C(/(ruler|card|block|gate|barrier|mechanism|electromagnet)/, /(release|hold|lift|start|remove|behind)/), C(/(mark|line|fixed)/, /(start|release|position|point)/)]),
        bankRow('D', 'The ball does not roll in a straight line / hits the sides of the ramp.',
          [C(/(straight|sideways|edge|wall|zig|curve|swerve|veer|off (the )?(ramp|track)|wobbl|(hit|hits|hitting|bump|bumps|touch|touches)( against)? the sides?|sides? of the (ramp|track))/)],
          'Use a ramp with a groove (channel) or guide rails so that the ball rolls straight.',
          [C(/(groove|channel|guide|rail|grooved|v ?shaped|gutter)/)]),
        bankRow('E', 'Difficult to judge exactly when the ball crosses the finishing line.',
          [C(/(finish|end|line|mark|bottom|reaches|passes|cross)/, DIFFICULT)],
          'Put a block at the finishing line so that the ball hits it and the sound marks the end of the time.',
          [C(/(barrier|block|stopper|bell|sound|hear|click|wall|buffer)/)]),
        bankRow('F', 'The height h is difficult to measure, or the ramp may slip so that h changes.',
          [C(/\b(height|h|angle|ramp|slope)\b/, /(slip|moves|moving|chang|not fixed|not constant|difficult|hard|unsure|vary|bend|sag|bow)/)],
          'Clamp the ramp in place, and measure h with a vertical rule and a set square.',
          [C(/(clamp|fix|secure|tape)/, /(ramp|track|slope|board|stand)/), C(/(set ?square|spirit level|plumb)/)])
      ]
    },
    {
      id: 'wire', title: 'Resistance of a wire',
      text: 'A student connects a length L of resistance wire into a circuit with an ammeter and a voltmeter, using crocodile clips. The student records V and I for two lengths of wire (about 30 cm and 80 cm) and calculates k = V / (IL) for each to test whether the resistance R is proportional to L.',
      bank: [
        rowTwoReadings(),
        bankRow('B', 'Difficult to measure L because the crocodile clips have wide jaws, so the contact point is uncertain.',
          [C(/(clip|crocodile|contact|jaw|connection)/, /(wide|width|where|position|point|uncertain|difficult|hard|judg|unsure|exact|thick|large)/)],
          'Use a jockey or knife-edge contact (or mark the contact point) so that L is measured to a definite point.',
          [C(/(jockey|knife|sharp|point contact|narrow|sliding contact|thin)/), C(/(mark|tape|label)/, /(contact|clip|point|position)/)]),
        bankRow('C', 'The wire heats up when current flows, so its resistance changes.',
          [C(/(heat|hot|warm|temperature)/)],
          'Switch off between readings, or use a smaller current (e.g. add a series resistor) so the wire does not heat up.',
          [C(/(switch(ed)? off|turn(ed)? off|disconnect|open the switch|between readings)/), C(/(small|lower|reduce|less|decrease)/, /(current|voltage|pd|emf)/),
            C(/(series|variable|rheostat|resistor)/, /(add|use|include|connect)/)]),
        bankRow('D', 'The wire is not straight (it has kinks), so L is not measured accurately.',
          [C(/(kink|bend|bent|straight|curl|loop|slack|taut|wavy)/)],
          'Stretch the wire straight and tape it to the metre rule.',
          [{ all: [[/(stretch|straighten|taut|pull (it )?tight|tape|stick|fix|clamp)/], [/(wire|rule|ruler|straight)/]], none: [[/(clip|clean|contact)/]] }]),
        bankRow('E', 'The meter readings fluctuate, or the contact resistance at the clips varies.',
          [C(/(fluctuat|flicker|chang|vary|unstable|not steady|jump)/, /(reading|meter|ammeter|voltmeter|current|display|digit)/), C(/(contact resistance|(dirty|loose|poor|bad) (contact|connection))/)],
          'Clean the ends of the wire and tighten the clips, then wait for the readings to settle.',
          [C(/(clean|sand|tighten|secure|firm)/, /(contact|clip|connection|wire|end)/), C(/(wait|settle|steady|stable)/)]),
        bankRow('F', 'The diameter of the wire may not be uniform along its length.',
          [C(/(diameter|thickness|cross ?section|area|width)/, /(uniform|vary|vari|differ|not (the )?same|not constant|change)/)],
          'Measure the diameter at several points along the wire with a micrometer and use the mean.',
          [C(/(micrometer|several|different|various|many|along)/, /(diameter|thickness|point|place|position)/)])
      ]
    },
    {
      id: 'lens', title: 'Converging lens',
      text: 'A student places an illuminated object, a converging lens in a holder and a screen on a bench. For two object distances u the student moves the screen to find a sharp image, measures the image distance v with a metre rule and calculates f = uv / (u + v) for each to test whether f is constant.',
      bank: [
        rowTwoReadings(),
        bankRow('B', 'Difficult to judge the position of the sharpest image (it looks sharp over a range of screen positions).',
          [C(/(sharp|focus|clear|blur|fuzzy|focused)/, /(difficult|hard|judg|unsure|uncertain|not sure|range|tell|decide)/)],
          'Move the screen back and forth through the sharp position and use the middle of the range where the image is sharp.',
          [C(/(back and forth|both sides|either side|mid ?point|middle|average of|forwards and backwards)/, /(screen|position|sharp|image|range)/)]),
        bankRow('C', 'Difficult to measure u and v to the centre of the lens, because the lens is in a holder or has thickness.',
          [C(/(centre|center|middle|optical cent|thickness|holder|position of the lens)/, /(lens)/)],
          'Mark the position of the centre of the lens on its holder (or measure to both faces and take the mean).',
          [C(/(mark|line|pointer|scale on)/, /(centre|center|middle|holder|lens)/), C(/(both (faces|sides)|each side)/)]),
        bankRow('D', 'The object, lens and screen may not be in line, or the lens may not be perpendicular to the bench.',
          [C(/(align|in line|straight|perpendicular|tilt|angle|parallel|level|height|centre)/, /(object|lens|screen|bench|rule|axis)/, /(not|mis|out of|difficult|different)/)],
          'Use an optical bench (or a metre rule fixed along the bench), with the lens and screen at right angles to it.',
          [C(/(optical bench|track|rail|fixed rule|along (a|the) (metre )?rule|clamp)/), C(/(set ?square|right angle|perpendicular)/, /(lens|screen|object|perpendicular|right angle)/)]),
        bankRow('E', 'The image is dim, so it is hard to see.',
          [C(/(dim|faint|dark|hard to see|not bright|brightness)/, /(image|screen|light|lamp)/)],
          'Use a brighter lamp, or do the experiment in a darkened room.',
          [C(/(dark|dim the|blackout|curtain|brighter|bright|more powerful|light box)/)]),
        bankRow('F', 'Difficult to measure u and v because the rule is not next to the lens and screen.',
          [C(/\b(u|v|distance|distances|length)\b/, DIFFICULT, /(rule|ruler|screen|object|parallax|far|gap|away|holder)/)],
          'Fix the metre rule along the bench next to the apparatus and use a set square to read the positions.',
          [C(/set ?square/), C(/(fix|clamp|tape|place|lay)/, /(rule|ruler|metre)/, /(bench|along|next to|beside|alongside)/)])
      ]
    },
    {
      id: 'cooling', title: 'Cooling of water',
      text: 'A student pours hot water into a beaker and uses a thermometer and a stopwatch to measure the time t for the water to cool from 70 °C to 60 °C. This is done for two volumes V of water (100 cm³ and 200 cm³), and k = t / V is calculated for each to test whether t is proportional to V.',
      bank: [
        rowTwoReadings(),
        bankRow('B', 'Difficult to read the thermometer at the exact moment, because the temperature is changing all the time.',
          [C(/(thermometer|temperature|reading|scale|mercury|alcohol)/, /(changing|falling|dropping|decreas|moving|exact|same time|at the moment|difficult|hard|judg|fine|division)/)],
          'Use a temperature sensor with a data logger (or a digital thermometer) to record the temperature against time.',
          [C(/(sensor|probe|thermocouple|thermistor|digital thermometer|data ?logg)/)]),
        bankRow('C', 'The water is not all at the same temperature (it was not stirred).',
          [C(/(stir|uniform|mixed|mix|evenly|same temperature throughout|hotter|cooler at|different temperatures)/)],
          'Stir the water gently before each reading.',
          [C(/(stir|mix)/)]),
        bankRow('D', 'Room temperature or draughts may change during the experiment.',
          [C(/(room temperature|surrounding|ambient|draught|draft|air current|wind|fan|window)/)],
          'Do the experiment away from draughts (windows and fans closed or a shield round the beaker), and measure room temperature.',
          [C(/(close|shield|screen|away from|no draught|still air|switch off|enclose|box)/, /(window|door|room|draught|draft|fan|air|beaker)/), C(/(measure|record|monitor)/, /(room|ambient|surrounding)/)]),
        bankRow('E', 'Heat is lost by evaporation from the surface, which does not depend on the volume in the same way.',
          [C(/(evaporat|steam|vapour|vapor|surface area|surface)/)],
          'Cover the beaker with a lid (with a hole for the thermometer).',
          [C(/(lid|cover|cap|seal|cling film|foil)/)]),
        bankRow('F', 'The starting temperature may differ, or the thermometer takes time to respond.',
          [C(/(start|initial|beginning)/, /(temperature|same|different)/), C(/(lag|respond|response|slow to|takes time|bulb)/)],
          'Leave the thermometer in the water for a while and start timing as it passes the same starting temperature each time.',
          [C(/(same|fixed|identical)/, /(start|initial|temperature)/), C(/(leave|wait|before)/, /(thermometer|reading|starting)/)]),
        bankRow('G', 'Heat loss also depends on the beaker (its size, shape and insulation), which may have changed with the volume.',
          [C(/(beaker|container|insulat|lagg|shape|material|bench|base)/, /(heat|loss|lost|different|chang|depend|conduct)/)],
          'Use the same beaker each time, standing on an insulating mat.',
          [C(/(same|identical)/, /(beaker|container)/), C(/(insulat|\bmat\b|lagg|polystyrene|cork|wood)/)])
      ]
    },
    {
      id: 'density', title: 'Density of a stone',
      text: 'A student measures the mass m of an irregular stone on a balance, then lowers it into a measuring cylinder of water and reads the volume before (V₁) and after (V₂). This is repeated with a second stone of the same rock, and ρ = m / (V₂ − V₁) is calculated for each to test whether the two stones have the same density.',
      bank: [
        rowTwoReadings(),
        bankRow('B', 'The change in volume is small compared with the 1 cm³ divisions, so its percentage uncertainty is large.',
          [{ all: [[/(division|scale|cylinder|resolution|precision|change in volume|volume change|volume of the stone|rise)/], [/(small|large|big|coarse|percentage|uncertain)/]],
            none: [[/(absorb|porous|bubble)/]] }],
          'Use a narrower measuring cylinder with finer divisions, or a displacement (eureka) can and a beaker on a balance.',
          [C(/(narrow|smaller|finer|0\.5|thinner)/, /(cylinder|division|scale|measuring)/), C(/(displacement can|eureka|overflow can|burette)/)]),
        bankRow('C', 'Water splashes out (or sticks to the sides) when the stone is dropped in.',
          [C(/(splash|spill|droplet|stick|cling|sides of)/)],
          'Lower the stone gently on a thread (or tilt the cylinder and let the stone slide in).',
          [C(/(thread|string|cotton|tilt|slide|lower)/), C(/(gently|slowly)/, /\b(lower|place|put|drop|slide|insert|into)\b/)]),
        bankRow('D', 'Air bubbles may be trapped on the stone, increasing the volume reading.',
          [C(/(bubble|air)/)],
          'Tap the cylinder or shake the stone gently to remove air bubbles before reading.',
          [C(/(tap|shake|knock|stir|remove|brush)/, /(bubble|air|cylinder|stone)/)]),
        bankRow('E', 'The stone may absorb water (it is porous), so V₂ − V₁ is too small.',
          [C(/(absorb|porous|soak|pores|holes)/)],
          'Soak the stone in water first, or coat it in a thin layer of varnish.',
          [C(/(soak|varnish|coat|seal|wax|wet)/, /(stone|first|before|it)/)]),
        bankRow('F', 'Difficult to read the bottom of the curved meniscus.',
          [C(/(meniscus|curve|curved|bottom of the liquid)/, /(difficult|hard|judg|read|parallax|angle|eye)/)],
          'Read the bottom of the meniscus with the eye level with it, with the cylinder on a level bench.',
          [C(/(eye level|level with|eye at|perpendicular|at the same level|horizontal)/)])
      ]
    },
    {
      id: 'falling', title: 'Ball falling through a liquid',
      text: 'A student drops a steel ball into a tall tube of glycerol and uses a stopwatch to time it as it falls between two rubber bands 30.0 cm apart. This is done for two sizes of ball, and k = v / r² is calculated for each to test whether the terminal velocity v is proportional to r².',
      bank: [
        rowTwoReadings(),
        bankRow('B', 'Difficult to judge when the ball passes each band (the bands are around a wide tube, so the view depends on the eye position).',
          [C(/(band|mark|line|pass|reach|cross|start|stop)/, /(difficult|hard|judg|unsure|uncertain|not sure|see|parallax|tell)/)],
          'View each band at eye level, or film the fall with a timer in view and play it back frame by frame.',
          [C(/(eye level|level with|eye at)/), C(/(video|film|record|camera|slow ?motion)/)]),
        bankRow('C', 'The fall time is short, so reaction time is significant.',
          [REACTION_LIM, SHORT_TIME_LIM],
          'Increase the distance between the bands (use a longer tube), or use light gates.',
          [C([/(longer|increase|greater|larger)/, /further apart/], /(distance|tube|separation|gap|apart)/), C(/(light ?gate|photo ?gate|sensor)/)]),
        bankRow('D', 'The ball may not have reached terminal velocity at the first band.',
          [C(/terminal/), C(/(accelerat|speed(ing)? up|not (yet )?constant|still increas|not reached)/)],
          'Place the first band further below the surface (and check that equal distances take equal times).',
          [C(/(lower|further|below|deeper|move)/, /(band|mark|first|start|top)/), C(/(equal|same) (time|distance)/)]),
        bankRow('E', 'The ball may fall close to the side of the tube, which slows it down.',
          [C(/(side|wall|edge|not (down )?the (centre|center|middle)|off cent)/)],
          'Drop the ball through a guide tube or funnel at the centre of the tube (or use a wider tube).',
          [C(/(guide|funnel|centre|center|middle|wider|larger diameter)/)]),
        bankRow('F', 'The viscosity of the liquid depends on temperature, which may change.',
          [C(/(temperature|viscosity|warm|hot|cold)/)],
          'Measure the temperature of the liquid and keep it constant (e.g. with a water bath).',
          [C(/(thermometer|temperature|water bath|constant)/)]),
        bankRow('G', 'Air bubbles stuck to the ball change its motion.',
          [C(/(bubble|air)/)],
          'Wet the ball in the liquid before releasing it.',
          [C(/(wet|dip|coat|soak)/, /(ball|liquid|first|before|glycerol|oil)/)])
      ]
    }
  ];

  /**
   * Evaluation-drill scenario for a seed (one of the eight experiments).
   * @returns {object} { seed, id, title, text, bank }
   */
  function evaluationScenario(seed) {
    var sc = rngFor(seed, 'pick').pick(EVAL_SCENARIOS);
    return { seed: seed, id: sc.id, title: sc.title, text: sc.text, bank: sc.bank };
  }

  /* ================================================================== marking (pure) */

  /** A minimal experiment object for VL.marking.createContext. */
  function drillExp(id, quantities) {
    return {
      id: id,
      quantities: function () { return quantities || []; },
      sampleParams: function () { return {}; },
      paper: function () { return null; },
      rubric: function () { return []; }
    };
  }

  function emptySkills() { return { MMO: { got: 0, max: 0 }, PDO: { got: 0, max: 0 }, ACE: { got: 0, max: 0 } }; }

  function runPoints(points, ctx) {
    return points.map(function (p) {
      var r;
      try { r = p.check.call(p, ctx) || {}; } catch (e) { r = { awarded: 0, comment: CROSS + ' This point could not be marked.' }; }
      var awarded = Math.max(0, Math.min(p.max, Number(r.awarded) || 0));
      return { id: p.id, label: p.label, skill: p.skill, max: p.max, awarded: awarded, comment: str(r.comment), details: r.details || null };
    });
  }

  function totals(results) {
    var skills = emptySkills(), total = 0, max = 0;
    results.forEach(function (r) {
      total += r.awarded;
      max += r.max;
      if (!skills[r.skill]) skills[r.skill] = { got: 0, max: 0 };
      skills[r.skill].got += r.awarded;
      skills[r.skill].max += r.max;
    });
    return { results: results, total: total, max: max, skills: skills };
  }

  /**
   * Mark the student's graph for the graph drill.
   * @param {object} ds graphDataset()
   * @param {object} graph the student's Graph
   * @param {{gradient?:string, intercept?:string}} answers
   * @returns {{results, total, max, skills}}
   */
  function markGraph(ds, graph, answers) {
    if (!VL.marking || !VL.marking.points) throw new Error('the marking engine is not available');
    var P = VL.marking.points;
    var ctx = VL.marking.createContext(drillExp('drill-graph', []),
      { expId: 'drill-graph', variantId: 'graph', seed: ds.seed, table: ds.table, graph: graph, answers: answers || {} }, {});
    var points = [
      P.axes({ id: 'axes', part: 'graph', skill: 'PDO', label: 'Axes, labels and scales' }),
      P.plotting({ id: 'plotting', part: 'graph', skill: 'PDO', label: 'Plotting of points' }),
      P.bestFit({ id: 'best-fit', part: 'graph', skill: 'PDO', label: 'Line of best fit' }),
      P.gradient({ id: 'gradient', part: 'analysis', skill: 'ACE', label: 'Gradient', sign: ds.sign }),
      P.intercept({ id: 'intercept', part: 'analysis', skill: 'ACE', label: 'y-intercept' })
    ];
    var results = runPoints(points, ctx);
    var g = graph || {};
    var gx = g.x && g.x.colId, gy = g.y && g.y.colId;
    if ((gx || gy) && (gx !== ds.xColId || gy !== ds.yColId)) {
      var head = function (id) {
        for (var i = 0; i < ds.table.columns.length; i++) if (ds.table.columns[i].id === id) return ds.table.columns[i].heading;
        return 'nothing';
      };
      results[0].awarded = 0;
      results[0].comment = CROSS + ' You were asked to plot ' + ds.yName + ' (y-axis) against ' + ds.xName + ' (x-axis), but your graph uses ' +
        head(gy) + ' against ' + head(gx) + '.';
    }
    return totals(results);
  }

  /**
   * Mark the student's table for the table drill.
   * @param {object} sc tableScenario()
   * @param {object} table the student's Table
   * @returns {{results, total, max, skills, notes: string[]}}
   */
  function markTable(sc, table) {
    if (!VL.marking || !VL.marking.points) throw new Error('the marking engine is not available');
    var P = VL.marking.points;
    var quantities = sc.quantities.map(function (q) {
      return { id: q.id, symbols: q.symbols, dims: dimsOf(q.unit), kind: q.kind, label: q.label, unit: q.unit, unitHint: q.unit };
    });
    var ctx = VL.marking.createContext(drillExp('drill-table', quantities),
      { expId: 'drill-table', variantId: sc.id, seed: sc.seed, table: table, graph: null, answers: {} }, {});
    var rawPoints = sc.raw.map(function (r) {
      return P.rawConsistency({ id: 'raw-' + r.q, part: 'table', skill: 'PDO', q: r.q, resolutionSI: r.resSI });
    });
    var rawAll = P.custom({
      id: 'raw', part: 'table', skill: 'PDO', label: 'Raw data: consistent decimal places matching the instruments',
      check: function (c) {
        var subs = rawPoints.map(function (p) { return p.check.call(p, c); });
        var bad = subs.filter(function (s) { return !(s.awarded > 0); });
        if (!bad.length) {
          return { awarded: 1, comment: TICK + ' ' + joinComments(subs) };
        }
        return { awarded: 0, comment: CROSS + ' ' + joinComments(bad) };
      }
    });
    var points = [
      P.headings({ id: 'headings', part: 'table', skill: 'PDO', label: 'Column headings (quantity / unit)' }),
      rawAll,
      P.derivedSF({ id: 'sf', part: 'table', skill: 'PDO', label: 'Significant figures of ' + sc.derived.name, q: sc.derived.q, from: sc.derived.from }),
      P.calc({ id: 'calc', part: 'table', skill: 'PDO', label: 'Calculation of ' + sc.derived.name, q: sc.derived.q, compute: sc.derived.compute })
    ];
    var out = totals(runPoints(points, ctx));
    out.notes = transcriptionNotes(sc, ctx);
    return out;
  }

  /** Join several marker comments into one sentence list: 'A; b; c.' */
  function joinComments(results) {
    return results.map(function (r, i) {
      var c = stripMark(r.comment).replace(/\.$/, '');
      return i && /^[A-Z][a-z]/.test(c) ? c.charAt(0).toLowerCase() + c.slice(1) : c;
    }).join('; ') + '.';
  }

  /** Feedback only (not marked): readings missing from the table or copied wrongly, and the number of sets. */
  function transcriptionNotes(sc, ctx) {
    var notes = [];
    var filled = (ctx.table.rows || []).filter(function (r) {
      return Object.keys(r.cells || {}).some(function (k) { return str(r.cells[k]).trim() !== ''; });
    }).length;
    if (filled && filled !== sc.sets.length) {
      notes.push('Your table has ' + filled + ' rows of readings, but there are ' + sc.sets.length + ' sets of readings.');
    }
    sc.raw.forEach(function (r) {
      var cols = ctx.colsOf(r.q);
      var q = sc.quantities.filter(function (x) { return x.id === r.q; })[0];
      if (!cols.length) {
        notes.push('No column for ' + (q ? q.label : r.q) + ' was recognised: check its heading (for example ' + (q ? q.label : r.q) + ' / ' + r.unit + ').');
        return;
      }
      var got = ctx.values(r.q).filter(function (v) { return v.num.ok && isFinite(v.si); }).map(function (v) { return v.si; });
      var factor = 1;
      try { factor = VL.units.parseUnit(r.unit).factor; } catch (e) { factor = 1; }
      var missing = [];
      r.values.forEach(function (s, i) {
        var si = Number(s) * factor;
        var tol = Math.abs(si) * 1e-6 + r.resSI * 0.01;
        var idx = -1;
        for (var k = 0; k < got.length; k++) if (Math.abs(got[k] - si) <= tol) { idx = k; break; }
        if (idx >= 0) got.splice(idx, 1);
        else missing.push(s + ' ' + r.unit + ' (set ' + (i + 1) + ')');
      });
      if (missing.length) {
        notes.push('These readings of ' + (q ? q.label : r.q) + ' are not in your table (or were copied differently): ' + missing.join(', ') + '.');
      }
    });
    return notes;
  }

  /**
   * Mark limitations and improvements.
   * @param {object} sc evaluationScenario()
   * @param {string[]} lims
   * @param {string[]} imps
   * @returns {{results, total, max, skills, marked}}
   */
  function markEvaluation(sc, lims, imps) {
    if (!VL.textmatch || !VL.textmatch.markLimitationsImprovements) throw new Error('the written-answer marker is not available');
    var clean = function (a) { return (a || []).map(str).filter(function (s) { return s.trim() !== ''; }); };
    var m = VL.textmatch.markLimitationsImprovements(clean(lims), clean(imps), sc.bank, { maxEach: 4 });
    var out = totals([
      { id: 'limitations', label: 'Limitations', skill: 'ACE', max: 4, awarded: m.limitations.awarded, comment: '' },
      { id: 'improvements', label: 'Improvements', skill: 'ACE', max: 4, awarded: m.improvements.awarded, comment: '' }
    ]);
    out.marked = m;
    return out;
  }

  /* ================================================================== UI helpers (browser only) */

  function h() { return ui.h.apply(null, arguments); }

  function skillBadges(skills) {
    return h('span', { class: 'vd-skills' }, skills.map(function (s) {
      return h('abbr', { class: 'vd-skill vd-skill--' + s.toLowerCase(), title: SKILL_NAMES[s] }, s);
    }));
  }

  /** Ask before throwing work away (resolves true when it is fine to continue). */
  function confirmDiscard(hasWork, what) {
    if (!hasWork) return Promise.resolve(true);
    var msg = 'Your work on this set (' + what + ') will be cleared. The seed of this set stays on screen until you continue, so you can note it down.';
    if (ui.dialog && typeof ui.dialog.confirm === 'function') {
      return ui.dialog.confirm({ title: 'Start a new set?', message: msg, confirmLabel: 'Start a new set', danger: true });
    }
    return Promise.resolve(typeof globalThis.confirm === 'function' ? globalThis.confirm('Start a new set? ' + msg) : true);
  }

  function copyText(text) {
    try {
      if (globalThis.navigator && navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    } catch (e) { /* fall through */ }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = h('textarea', { class: 'vd-offscreen', 'aria-hidden': 'true' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /**
   * Seed bar: shows the seed with Copy and New set buttons, and a form to load another seed of the same drill.
   * @returns {{el, setSeed(seed)}}
   */
  function seedBar(drill, opts) {
    var code = h('code', { class: 'vd-seed' });
    var msg = h('p', { class: 'vd-seed-msg', role: 'status', 'aria-live': 'polite' });
    var inputId = 'vd-seed-in-' + drill.id;
    var input = h('input', { id: inputId, class: 'vd-input vd-input--seed', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: drill.prefix + '-XXXX-XXXX', 'aria-describedby': inputId + '-help' });
    var form = h('form', { class: 'vd-seed-form', on: { submit: function (ev) {
      ev.preventDefault();
      var s = VL.rng.normalizeSeed(input.value);
      if (!s) { msg.textContent = 'Type a seed first.'; return; }
      if (!VL.rng.isValidSeed(s)) { msg.textContent = '✗ “' + input.value.trim() + '” is not a valid seed. Seeds look like ' + drill.prefix + '-7K2Q-91C3.'; return; }
      if (s.split('-')[0] !== drill.prefix) { msg.textContent = '✗ That seed is for a different drill: ' + drill.title + ' seeds start with ' + drill.prefix + '.'; return; }
      opts.onLoad(s).then(function (done) {
        if (done) { input.value = ''; msg.textContent = 'Loaded set ' + s + '.'; }
      });
    } } },
    h('label', { for: inputId, class: 'vd-label' }, 'Repeat a set:'), input,
    h('button', { type: 'submit', class: 'vd-btn' }, 'Load'),
    h('span', { id: inputId + '-help', class: 'vd-help' }, 'Type a seed you noted earlier to get exactly the same set again.'));
    var el = h('div', { class: 'vd-seedbar' },
      h('div', { class: 'vd-seed-row' },
        h('span', { class: 'vd-label' }, 'Set seed:'), code,
        h('button', { type: 'button', class: 'vd-btn vd-btn--small', on: { click: function () {
          copyText(code.textContent).then(function (ok) { msg.textContent = ok ? 'Seed copied.' : 'Copy the seed by selecting it.'; });
        } } }, 'Copy seed'),
        h('button', { type: 'button', class: 'vd-btn vd-btn--primary', on: { click: function () { opts.onNew(); } } }, 'New set')),
      form, msg);
    return {
      el: el,
      setSeed: function (s) { code.textContent = s; },
      say: function (t) { msg.textContent = t; }
    };
  }

  /** Render marked results: ✓/✗ + words + comment for every point, and the total. */
  function renderResults(box, res, opts) {
    opts = opts || {};
    ui.clear(box);
    var skillText = ['MMO', 'PDO', 'ACE'].filter(function (k) { return res.skills[k] && res.skills[k].max > 0; })
      .map(function (k) { return k + ' ' + res.skills[k].got + ' / ' + res.skills[k].max; }).join(', ');
    box.appendChild(h('h3', { class: 'vd-h3', tabindex: '-1' }, 'Your mark: ' + res.total + ' / ' + res.max + (skillText ? ' (' + skillText + ')' : '')));
    if (opts.recordNote) box.appendChild(h('p', { class: 'vd-note' }, opts.recordNote));
    if (res.results.some(function (r) { return r.comment; })) {
      box.appendChild(h('ul', { class: 'vd-marks' }, res.results.map(function (r) {
        var ok = r.awarded >= r.max && r.max > 0;
        return h('li', { class: 'vd-mark ' + (ok ? 'vd-mark--ok' : 'vd-mark--bad') },
          h('span', { class: 'vd-mark-icon', 'aria-hidden': 'true' }, ok ? TICK : CROSS),
          h('div', { class: 'vd-mark-body' },
            h('p', { class: 'vd-mark-title' }, h('strong', null, r.label), ' — ' + (ok ? 'mark awarded' : 'no mark') + ' (' + r.awarded + ' / ' + r.max + ', ',
              h('abbr', { title: SKILL_NAMES[r.skill] }, r.skill), ')'),
            r.comment ? h('p', { class: 'vd-mark-comment' }, stripMark(r.comment)) : null));
      })));
    }
  }

  function recordProgress(env, drill, seed, res) {
    var key = drill.id + ':' + seed;
    var recorded = env.store ? (env.store.get('drills:recorded', []) || []) : [];
    if (!Array.isArray(recorded)) recorded = [];
    if (recorded.indexOf(key) >= 0 || env.sessionRecorded[key]) {
      return 'You have already checked this set once, so this check is for practice only and is not recorded again.';
    }
    env.sessionRecorded[key] = true;
    var skills = {};
    ['MMO', 'PDO', 'ACE'].forEach(function (k) { skills[k] = { got: res.skills[k] ? res.skills[k].got : 0, max: res.skills[k] ? res.skills[k].max : 0 }; });
    var ok = false;
    if (env.store && typeof env.store.addProgress === 'function') {
      try {
        ok = env.store.addProgress({ sessionId: 'drill-' + drill.id, date: new Date().toISOString(), mode: 'drill', expId: drill.expId,
          variantId: drill.id, seed: seed, total: res.total, max: res.max, skills: skills }) !== false;
      } catch (e) { ok = false; }
      recorded.push(key);
      try { env.store.set('drills:recorded', recorded.slice(-300)); } catch (e) { /* ignore */ }
    }
    if (ui.bus) ui.bus.emit('progress:changed', { expId: drill.expId });
    return ok ? '✓ Recorded on your Progress page.' : 'This result could not be saved (browser storage is not available).';
  }

  /* ================================================================== drill: graph */

  function graphDrill(panel, drill, env) {
    var state = env.loadState(drill.id) || {};
    var seed = state.seed && VL.rng.isValidSeed(state.seed) ? state.seed : VL.rng.newSeed(drill.prefix);
    var ds, graph, answers, tableView = null, graphView = null, modelView = null, checked = false;
    var hints = !!state.hints;

    var bar = seedBar(drill, { onNew: function () { return startNew(VL.rng.newSeed(drill.prefix)); }, onLoad: function (s) { return startNew(s); } });
    var contextEl = h('div', { class: 'vd-context' });
    var tableBox = h('div', { class: 'vd-table-box' });
    var graphBox = h('div', { class: 'vd-graph-box' });
    var gradId = 'vd-grad-' + drill.id, icptId = 'vd-icpt-' + drill.id;
    var gradIn = h('input', { id: gradId, class: 'vd-input vd-input--num', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
    var icptIn = h('input', { id: icptId, class: 'vd-input vd-input--num', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
    var hintsBox = h('input', { type: 'checkbox', id: 'vd-hints-' + drill.id, class: 'vd-check' });
    hintsBox.checked = hints;
    var resultBox = h('div', { class: 'vd-results', 'aria-live': 'polite' });
    var modelBox = h('div', { class: 'vd-model' });

    panel.appendChild(bar.el);
    panel.appendChild(contextEl);
    panel.appendChild(h('section', { class: 'vd-block', 'aria-labelledby': 'vd-gt-' + drill.id },
      h('h3', { class: 'vd-h3', id: 'vd-gt-' + drill.id }, 'Results'), tableBox));
    panel.appendChild(h('section', { class: 'vd-block', 'aria-labelledby': 'vd-gg-' + drill.id },
      h('h3', { class: 'vd-h3', id: 'vd-gg-' + drill.id }, 'Your graph'),
      h('p', { class: 'vd-help' }, 'Open “Axes and scales” on the graph to choose the columns, label the axes and set your scales. Then plot each point, draw your line of best fit and a large gradient triangle.'),
      h('label', { class: 'vd-checkline', for: hintsBox.id }, hintsBox, ' Show hints while I work (they point out problems, so try without them first)'),
      graphBox));
    panel.appendChild(h('section', { class: 'vd-block vd-answers', 'aria-labelledby': 'vd-ga-' + drill.id },
      h('h3', { class: 'vd-h3', id: 'vd-ga-' + drill.id }, 'Your answers'),
      h('div', { class: 'vd-fields' },
        h('div', { class: 'vd-field' }, h('label', { for: gradId, class: 'vd-label' }, 'gradient ='), gradIn),
        h('div', { class: 'vd-field' }, h('label', { for: icptId, class: 'vd-label' }, 'y-intercept ='), icptIn)),
      h('p', { class: 'vd-help' }, 'Work these out from your own line (the Gradient and Intercept tools on the graph help you). A unit is optional here.'),
      h('div', { class: 'vd-actions' }, h('button', { type: 'button', class: 'vd-btn vd-btn--primary vd-btn--big', on: { click: check } }, 'Check my graph'))));
    panel.appendChild(resultBox);
    panel.appendChild(modelBox);

    gradIn.addEventListener('input', function () { answers.gradient = gradIn.value; save(); });
    icptIn.addEventListener('input', function () { answers.intercept = icptIn.value; save(); });
    hintsBox.addEventListener('change', function () { hints = hintsBox.checked; mountGraph(); save(); });

    function save() {
      env.saveState(drill.id, { seed: seed, graph: graph, answers: answers, checked: checked, hints: hints });
    }

    function hasWork() {
      return !!(graph && (graph.points.length || graph.line || graph.x.colId || graph.y.colId)) || !!(answers && (answers.gradient || answers.intercept));
    }

    function mountGraph() {
      if (graphView) { graphView.destroy(); graphView = null; }
      ui.clear(graphBox);
      graphView = ui.graphView.mount(graphBox, graph, ds.table, { hints: hints, onChange: function (g) { graph = g; save(); } });
    }

    function load(s, saved) {
      seed = s;
      ds = graphDataset(seed);
      graph = saved && saved.graph && VL.graph ? VL.graph.fromJSON(saved.graph) : VL.graph.create();
      answers = saved && saved.answers ? { gradient: str(saved.answers.gradient), intercept: str(saved.answers.intercept) } : { gradient: '', intercept: '' };
      checked = !!(saved && saved.checked);
      bar.setSeed(seed);
      ui.clear(contextEl);
      contextEl.appendChild(h('h3', { class: 'vd-h3' }, ds.title));
      contextEl.appendChild(h('p', null, ds.context));
      contextEl.appendChild(h('p', { class: 'vd-task' }, h('strong', null, 'Task: '), ds.instruction + ' Then determine the gradient and the y-intercept of your line.'));
      if (tableView) tableView.destroy();
      ui.clear(tableBox);
      tableView = ui.tableView.mount(tableBox, ds.table, { readOnly: true });
      mountGraph();
      gradIn.value = answers.gradient;
      icptIn.value = answers.intercept;
      ui.clear(resultBox);
      clearModel();
      save();
    }

    function clearModel() {
      if (modelView) { modelView.destroy(); modelView = null; }
      ui.clear(modelBox);
    }

    function startNew(s) {
      return confirmDiscard(hasWork() && !checked, 'your graph and answers').then(function (ok) {
        if (!ok) return false;
        load(s, null);
        bar.say('New set: ' + s + '.');
        return true;
      });
    }

    function check() {
      var res;
      try { res = markGraph(ds, graph, answers); } catch (e) {
        ui.clear(resultBox);
        resultBox.appendChild(h('p', { class: 'vd-error' }, '⚠ Your graph could not be marked: ' + e.message));
        return;
      }
      var note = recordProgress(env, drill, seed, res);
      checked = true;
      save();
      renderResults(resultBox, res, { recordNote: note });
      showModel();
      var hd = resultBox.querySelector('h3');
      if (hd) hd.focus();
    }

    function showModel() {
      clearModel();
      var mg = null;
      try { mg = VL.graph.modelGraph(ds.table, ds.xColId, ds.yColId); } catch (e) { mg = null; }
      modelBox.appendChild(h('h3', { class: 'vd-h3' }, 'Model graph'));
      modelBox.appendChild(h('p', null, ds.meaning));
      if (mg) {
        var ro = mg.readOffs, m = VL.graph.checkTriangle(mg).gradient;
        modelBox.appendChild(h('ul', { class: 'vd-list' },
          h('li', null, 'Scales: x from ' + minus(mg.x.origin) + ' with ' + mg.x.perLarge + ' per large square; y from ' + minus(mg.y.origin) + ' with ' + mg.y.perLarge + ' per large square (steps of 1, 2, 4 or 5 × 10ⁿ only).'),
          h('li', null, 'Gradient triangle from (' + minus(ro.x1) + ', ' + minus(ro.y1) + ') to (' + minus(ro.x2) + ', ' + minus(ro.y2) + '): gradient = (' + minus(ro.y2) + ' − ' + minus(ro.y1) + ') ÷ (' + minus(ro.x2) + ' − ' + minus(ro.x1) + ') = ' + show(m, 3) + '.'),
          mg.intercept && mg.intercept.value ? h('li', null, 'y-intercept = ' + minus(mg.intercept.value) + (mg.intercept.method === 'direct' ? ' (read where the line crosses x = 0).' : ' (calculated with c = y₁ − m x₁, because the x-axis does not start at zero).')) : null,
          h('li', null, 'For comparison, the true relationship used to make these data has gradient ' + show(ds.truth.gradient, 3) + ' ' + ds.truth.gradientUnit + ' and y-intercept ' + show(ds.truth.intercept, 3) + ' ' + ds.truth.interceptUnit + '. Your values come from your own line, so they will differ slightly.')));
        var holder = h('div', { class: 'vd-model-graph' });
        modelBox.appendChild(holder);
        try { modelView = ui.graphView.mount(holder, mg, ds.table, { readOnly: true }); } catch (e) { modelView = null; }
      }
    }

    load(seed, state.seed === seed ? state : null);
    if (checked) {
      try { renderResults(resultBox, markGraph(ds, graph, answers), { recordNote: 'You checked this set earlier.' }); showModel(); } catch (e) { /* ignore */ }
    }

    return {
      show: function () {
        if (graphView) graphView.refresh();
        if (modelView) modelView.refresh();
      },
      destroy: function () {
        if (graphView) graphView.destroy();
        if (tableView) tableView.destroy();
        clearModel();
      }
    };
  }

  /* ================================================================== drill: uncertainty */

  function uncertaintyDrill(panel, drill, env) {
    var state = env.loadState(drill.id) || {};
    var seed = state.seed && VL.rng.isValidSeed(state.seed) ? state.seed : VL.rng.newSeed(drill.prefix);
    var questions = [], typed = {}, done = {};

    var bar = seedBar(drill, { onNew: function () { return startNew(VL.rng.newSeed(drill.prefix)); }, onLoad: function (s) { return startNew(s); } });
    var scoreEl = h('p', { class: 'vd-score', role: 'status', 'aria-live': 'polite' });
    var list = h('ol', { class: 'vd-questions' });
    var summary = h('div', { class: 'vd-results', 'aria-live': 'polite' });
    panel.appendChild(bar.el);
    panel.appendChild(h('p', { class: 'vd-help' }, 'Type numbers only — the unit is printed after each box. Check each question when you are ready; the worked answer then appears. Each question can be checked once.'));
    panel.appendChild(scoreEl);
    panel.appendChild(list);
    panel.appendChild(summary);

    function save() { env.saveState(drill.id, { seed: seed, typed: typed, done: done }); }

    function hasWork() {
      return Object.keys(typed).some(function (k) { return Object.keys(typed[k] || {}).some(function (f) { return str(typed[k][f]).trim(); }); });
    }

    function updateScore() {
      var n = questions.length, answered = 0, right = 0;
      questions.forEach(function (q) { if (done[q.id]) { answered++; if (done[q.id].correct) right++; } });
      scoreEl.textContent = 'Checked ' + answered + ' of ' + n + ' · correct ' + right + '.';
      return { answered: answered, right: right, n: n };
    }

    function renderQuestion(q, idx) {
      var li = h('li', { class: 'vd-question', id: 'vd-' + q.id });
      var t = typed[q.id] = typed[q.id] || {};
      var inputs = {};
      li.appendChild(h('h3', { class: 'vd-h3' }, 'Question ' + (idx + 1) + ': ' + q.title));
      q.prompt.forEach(function (p) { li.appendChild(h('p', null, p)); });
      var fields = h('div', { class: 'vd-fields' });
      q.fields.forEach(function (f) {
        var id = 'vd-' + q.id + '-' + f.key + '-' + seed.replace(/[^A-Z0-9]/g, '');
        var inp = h('input', { id: id, class: 'vd-input vd-input--num', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
        inp.value = str(t[f.key]);
        inp.addEventListener('input', function () { t[f.key] = inp.value; save(); });
        inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); checkQ(); } });
        inputs[f.key] = inp;
        fields.appendChild(h('div', { class: 'vd-field' }, h('label', { for: id, class: 'vd-label' }, f.label), inp, f.unit ? h('span', { class: 'vd-unit' }, f.unit) : null));
      });
      li.appendChild(fields);
      var radios = [];
      if (q.choice) {
        var name = 'vd-' + q.id + '-' + q.choice.key + '-' + seed.replace(/[^A-Z0-9]/g, '');
        var fs = h('fieldset', { class: 'vd-choice' }, h('legend', null, q.choice.legend));
        q.choice.options.forEach(function (o) {
          var rid = name + '-' + o.value;
          var r = h('input', { type: 'radio', name: name, id: rid, value: o.value, class: 'vd-radio-input' });
          r.checked = t[q.choice.key] === o.value;
          r.addEventListener('change', function () { if (r.checked) { t[q.choice.key] = o.value; save(); } });
          radios.push(r);
          fs.appendChild(h('label', { class: 'vd-radio', for: rid }, r, ' ', o.label));
        });
        li.appendChild(fs);
      }
      var msg = h('p', { class: 'vd-qmsg', role: 'status', 'aria-live': 'polite' });
      var btn = h('button', { type: 'button', class: 'vd-btn vd-btn--primary', on: { click: checkQ } }, 'Check answer');
      var feedback = h('div', { class: 'vd-feedback' });
      li.appendChild(h('div', { class: 'vd-actions' }, btn, msg));
      li.appendChild(feedback);

      function lock() {
        Object.keys(inputs).forEach(function (k) { inputs[k].readOnly = true; });
        radios.forEach(function (r) { r.disabled = true; });
        btn.disabled = true;
        btn.textContent = 'Checked';
      }

      function showFeedback(res) {
        ui.clear(feedback);
        li.classList.toggle('vd-question--ok', res.correct);
        li.classList.toggle('vd-question--bad', !res.correct);
        feedback.appendChild(h('p', { class: 'vd-verdict ' + (res.correct ? 'vd-verdict--ok' : 'vd-verdict--bad') },
          h('span', { 'aria-hidden': 'true' }, res.correct ? TICK + ' ' : CROSS + ' '), res.correct ? 'Correct.' : 'Not quite.'));
        var parts = [];
        q.fields.forEach(function (f) {
          var fr = res.fields[f.key];
          parts.push(h('li', null, (fr.ok ? TICK + ' ' : CROSS + ' ') + f.label + ' ' + (str(t[f.key]).trim() || '(blank)') + (f.unit ? ' ' + f.unit : '') +
            (fr.ok ? ' — accepted.' : ' — expected about ' + show(f.answer, 3) + (f.unit ? ' ' + f.unit : '') + '.')));
        });
        if (q.choice) {
          var cr = res.choice;
          var chosen = q.choice.options.filter(function (o) { return o.value === t[q.choice.key]; })[0];
          var right = q.choice.options.filter(function (o) { return o.value === q.choice.answer; })[0];
          parts.push(h('li', null, (cr ? TICK + ' ' : CROSS + ' ') + q.choice.legend + ' ' + (chosen ? chosen.label : '(no choice)') + (cr ? ' — accepted.' : ' — the answer is: ' + right.label + '.')));
        }
        feedback.appendChild(h('ul', { class: 'vd-list' }, parts));
        feedback.appendChild(h('div', { class: 'vd-worked' }, h('p', { class: 'vd-worked-title' }, 'Worked answer'), q.explain.map(function (e) { return h('p', null, e); })));
      }

      function checkQ() {
        if (done[q.id]) return;
        var res = { correct: true, fields: {}, choice: null };
        for (var i = 0; i < q.fields.length; i++) {
          var f = q.fields[i];
          var c = checkField(f, t[f.key]);
          if (c.error) { msg.textContent = '⚠ ' + f.label + ' ' + c.error; inputs[f.key].focus(); return; }
          res.fields[f.key] = { ok: c.ok };
          if (!c.ok) res.correct = false;
        }
        if (q.choice) {
          if (!t[q.choice.key]) { msg.textContent = '⚠ Choose an answer to “' + q.choice.legend + '”'; if (radios[0]) radios[0].focus(); return; }
          res.choice = t[q.choice.key] === q.choice.answer;
          if (!res.choice) res.correct = false;
        }
        msg.textContent = '';
        done[q.id] = res;
        save();
        lock();
        showFeedback(res);
        var sc = updateScore();
        if (sc.answered === sc.n) finish(true);
      }

      if (done[q.id]) { lock(); showFeedback(done[q.id]); }
      return li;
    }

    function finish(fresh) {
      var sc = updateScore();
      var res = totals([{ id: 'uncertainty', label: 'Uncertainty questions', skill: 'ACE', max: sc.n, awarded: sc.right, comment: '' }]);
      var note = fresh ? recordProgress(env, drill, seed, res) : 'You finished this set earlier.';
      ui.clear(summary);
      summary.appendChild(h('h3', { class: 'vd-h3', tabindex: '-1' }, 'Set complete: ' + sc.right + ' / ' + sc.n + ' correct'));
      summary.appendChild(h('p', { class: 'vd-note' }, note));
      summary.appendChild(h('p', null, sc.right === sc.n ? 'Excellent — every answer was right.' : 'Read the worked answers for the questions marked ✗, then try a new set.'));
      summary.appendChild(h('button', { type: 'button', class: 'vd-btn vd-btn--primary', on: { click: function () { startNew(VL.rng.newSeed(drill.prefix)); } } }, 'Try a new set'));
      if (fresh) { var hd = summary.querySelector('h3'); if (hd) hd.focus(); }
    }

    function load(s, saved) {
      seed = s;
      questions = uncertaintyQuestions(seed);
      typed = saved && saved.typed ? saved.typed : {};
      done = saved && saved.done ? saved.done : {};
      bar.setSeed(seed);
      ui.clear(list);
      ui.clear(summary);
      questions.forEach(function (q, i) { list.appendChild(renderQuestion(q, i)); });
      var sc = updateScore();
      if (sc.answered === sc.n) finish(false);
      save();
    }

    function startNew(s) {
      var complete = questions.length && questions.every(function (q) { return done[q.id]; });
      return confirmDiscard(hasWork() && !complete, 'your answers').then(function (ok) {
        if (!ok) return false;
        load(s, null);
        bar.say('New set: ' + s + '.');
        var first = list.querySelector('input');
        if (first) first.focus();
        return true;
      });
    }

    load(seed, state.seed === seed ? state : null);
    return { show: function () {}, destroy: function () {} };
  }

  /* ================================================================== drill: table */

  function tableDrill(panel, drill, env) {
    var state = env.loadState(drill.id) || {};
    var seed = state.seed && VL.rng.isValidSeed(state.seed) ? state.seed : VL.rng.newSeed(drill.prefix);
    var sc, table, view = null, modelView = null, checked = false;

    var bar = seedBar(drill, { onNew: function () { return startNew(VL.rng.newSeed(drill.prefix)); }, onLoad: function (s) { return startNew(s); } });
    var intro = h('div', { class: 'vd-context' });
    var obs = h('ol', { class: 'vd-obs' });
    var tableBox = h('div', { class: 'vd-table-box' });
    var resultBox = h('div', { class: 'vd-results', 'aria-live': 'polite' });
    var modelBox = h('div', { class: 'vd-model' });
    panel.appendChild(bar.el);
    panel.appendChild(intro);
    panel.appendChild(h('section', { class: 'vd-block', 'aria-labelledby': 'vd-to-' + drill.id },
      h('h3', { class: 'vd-h3', id: 'vd-to-' + drill.id }, 'What the instruments show'), obs));
    panel.appendChild(h('section', { class: 'vd-block', 'aria-labelledby': 'vd-tt-' + drill.id },
      h('h3', { class: 'vd-h3', id: 'vd-tt-' + drill.id }, 'Your results table'),
      h('p', { class: 'vd-help' }, 'Type each heading as quantity / unit in the heading row, then the readings exactly as you would write them in the exam. Add or remove columns and rows as you need.'),
      tableBox,
      h('div', { class: 'vd-actions' }, h('button', { type: 'button', class: 'vd-btn vd-btn--primary vd-btn--big', on: { click: check } }, 'Check my table'))));
    panel.appendChild(resultBox);
    panel.appendChild(modelBox);

    function save() { env.saveState(drill.id, { seed: seed, table: table, checked: checked }); }

    function hasWork() {
      return !!table && (table.columns.some(function (c) { return str(c.heading).trim(); }) ||
        table.rows.some(function (r) { return Object.keys(r.cells || {}).some(function (k) { return str(r.cells[k]).trim(); }); }));
    }

    function load(s, saved) {
      seed = s;
      sc = tableScenario(seed);
      table = saved && saved.table && VL.datatable ? VL.datatable.fromJSON(saved.table) : VL.datatable.create({ columns: 3, rows: sc.sets.length });
      checked = !!(saved && saved.checked);
      bar.setSeed(seed);
      ui.clear(intro);
      intro.appendChild(h('h3', { class: 'vd-h3' }, sc.title));
      intro.appendChild(h('p', null, sc.intro));
      intro.appendChild(h('p', { class: 'vd-task' }, h('strong', null, 'Task: '), sc.task));
      ui.clear(obs);
      sc.sets.forEach(function (set, i) {
        obs.appendChild(h('li', { class: 'vd-obs-set' }, h('span', { class: 'vd-obs-label' }, 'Set ' + (i + 1)),
          h('ul', { class: 'vd-obs-list' }, set.map(function (t) { return h('li', null, t); }))));
      });
      if (view) view.destroy();
      ui.clear(tableBox);
      view = ui.tableView.mount(tableBox, table, { hints: false, onChange: function (t) { table = t; save(); } });
      ui.clear(resultBox);
      clearModel();
      save();
    }

    function clearModel() {
      if (modelView) { modelView.destroy(); modelView = null; }
      ui.clear(modelBox);
    }

    function startNew(s) {
      return confirmDiscard(hasWork() && !checked, 'your table').then(function (ok) {
        if (!ok) return false;
        load(s, null);
        bar.say('New set: ' + s + '.');
        return true;
      });
    }

    function check() {
      var res;
      try { res = markTable(sc, table); } catch (e) {
        ui.clear(resultBox);
        resultBox.appendChild(h('p', { class: 'vd-error' }, '⚠ Your table could not be marked: ' + e.message));
        return;
      }
      var note = recordProgress(env, drill, seed, res);
      checked = true;
      save();
      show(res, note, true);
    }

    function show(res, note, focus) {
      renderResults(resultBox, res, { recordNote: note });
      if (res.notes && res.notes.length) {
        resultBox.appendChild(h('div', { class: 'vd-notes' }, h('p', { class: 'vd-worked-title' }, 'Also check (not marked here):'),
          h('ul', { class: 'vd-list' }, res.notes.map(function (n) { return h('li', null, '⚠ ' + n); }))));
      }
      clearModel();
      modelBox.appendChild(h('h3', { class: 'vd-h3' }, 'Model table'));
      var mt = buildTable(sc.model.headings.map(function (hd, i) {
        return { heading: hd, values: sc.model.rows.map(function (r) { return r[i]; }) };
      }));
      var holder = h('div', { class: 'vd-table-box' });
      modelBox.appendChild(holder);
      try { modelView = ui.tableView.mount(holder, mt, { readOnly: true }); } catch (e) { modelView = null; }
      modelBox.appendChild(h('ul', { class: 'vd-list' }, sc.model.notes.map(function (n) { return h('li', null, n); })));
      if (focus) { var hd = resultBox.querySelector('h3'); if (hd) hd.focus(); }
    }

    load(seed, state.seed === seed ? state : null);
    if (checked) {
      try { show(markTable(sc, table), 'You checked this set earlier.', false); } catch (e) { /* ignore */ }
    }
    return {
      show: function () {},
      destroy: function () { if (view) view.destroy(); clearModel(); }
    };
  }

  /* ================================================================== drill: evaluation */

  function evaluationDrill(panel, drill, env) {
    var state = env.loadState(drill.id) || {};
    var seed = state.seed && VL.rng.isValidSeed(state.seed) ? state.seed : VL.rng.newSeed(drill.prefix);
    var sc, lims = ['', '', '', ''], imps = ['', '', '', ''], checked = false;

    var bar = seedBar(drill, { onNew: function () { return startNew(VL.rng.newSeed(drill.prefix)); }, onLoad: function (s) { return startNew(s); } });
    var intro = h('div', { class: 'vd-context' });
    var limBox = h('div', { class: 'vd-written' });
    var impBox = h('div', { class: 'vd-written' });
    var resultBox = h('div', { class: 'vd-results', 'aria-live': 'polite' });
    panel.appendChild(bar.el);
    panel.appendChild(intro);
    panel.appendChild(h('div', { class: 'vd-two' },
      h('section', { class: 'vd-block', 'aria-labelledby': 'vd-el-' + drill.id },
        h('h3', { class: 'vd-h3', id: 'vd-el-' + drill.id }, 'Limitations'),
        h('p', { class: 'vd-help' }, 'Identify four sources of uncertainty or limitations of the procedure.'), limBox),
      h('section', { class: 'vd-block', 'aria-labelledby': 'vd-ei-' + drill.id },
        h('h3', { class: 'vd-h3', id: 'vd-ei-' + drill.id }, 'Improvements'),
        h('p', { class: 'vd-help' }, 'Suggest an improvement for each limitation. You may suggest other apparatus or different procedures.'), impBox)));
    panel.appendChild(h('div', { class: 'vd-actions' }, h('button', { type: 'button', class: 'vd-btn vd-btn--primary vd-btn--big', on: { click: check } }, 'Check my answers')));
    panel.appendChild(resultBox);

    function save() { env.saveState(drill.id, { seed: seed, lims: lims, imps: imps, checked: checked }); }
    function hasWork() { return lims.concat(imps).some(function (s) { return str(s).trim(); }); }

    function boxes(container, arr, word) {
      ui.clear(container);
      var ol = h('ol', { class: 'vd-written-list' });
      arr.forEach(function (v, i) {
        var id = 'vd-' + word + '-' + i + '-' + drill.id;
        var ta = h('textarea', { id: id, class: 'vd-textarea', rows: '2', spellcheck: 'true' });
        ta.value = str(v);
        ta.addEventListener('input', function () { arr[i] = ta.value; save(); });
        ol.appendChild(h('li', null, h('label', { for: id, class: 'vd-sr' }, word + ' ' + (i + 1)), ta));
      });
      container.appendChild(ol);
    }

    function load(s, saved) {
      seed = s;
      sc = evaluationScenario(seed);
      lims = saved && Array.isArray(saved.lims) ? saved.lims.slice(0, 4) : ['', '', '', ''];
      imps = saved && Array.isArray(saved.imps) ? saved.imps.slice(0, 4) : ['', '', '', ''];
      while (lims.length < 4) lims.push('');
      while (imps.length < 4) imps.push('');
      checked = !!(saved && saved.checked);
      bar.setSeed(seed);
      ui.clear(intro);
      intro.appendChild(h('h3', { class: 'vd-h3' }, sc.title));
      intro.appendChild(h('p', null, sc.text));
      boxes(limBox, lims, 'Limitation');
      boxes(impBox, imps, 'Improvement');
      ui.clear(resultBox);
      save();
    }

    function startNew(s) {
      return confirmDiscard(hasWork() && !checked, 'your limitations and improvements').then(function (ok) {
        if (!ok) return false;
        load(s, null);
        bar.say('New set: ' + s + '.');
        return true;
      });
    }

    function column(title, col, noun) {
      var sec = h('section', { class: 'vd-col' }, h('h4', { class: 'vd-h4' }, title + ': ' + col.awarded + ' / 4'));
      var items = col.items || [];
      if (items.length) {
        sec.appendChild(h('ul', { class: 'vd-marks' }, items.map(function (it) {
          var ok = !!it.id;
          var hit = ok ? col.hits.filter(function (x) { return x.id === it.id; })[0] : null;
          return h('li', { class: 'vd-mark ' + (ok ? 'vd-mark--ok' : 'vd-mark--bad') },
            h('span', { class: 'vd-mark-icon', 'aria-hidden': 'true' }, ok ? TICK : CROSS),
            h('div', { class: 'vd-mark-body' },
              h('p', { class: 'vd-mark-title' }, '“' + it.text + '”'),
              h('p', { class: 'vd-mark-comment' }, ok ? 'Credited (' + it.id + '): ' + (hit ? hit.label : '') : 'Not credited: ' + it.reason)));
        })));
      } else {
        sec.appendChild(h('p', null, 'You did not write any ' + noun + 's.'));
      }
      if (col.misses.length) {
        sec.appendChild(h('details', { class: 'vd-misses' }, h('summary', null, 'Points you could have made (' + col.misses.length + ')'),
          h('ul', { class: 'vd-list' }, col.misses.map(function (m) { return h('li', null, m.id + ': ' + m.label); }))));
      }
      return sec;
    }

    function show(res, note, focus) {
      renderResults(resultBox, res, { recordNote: note });
      resultBox.appendChild(h('div', { class: 'vd-two' },
        column('Limitations', res.marked.limitations, 'limitation'),
        column('Improvements', res.marked.improvements, 'improvement')));
      var table = h('table', { class: 'vd-table' },
        h('caption', null, 'Model answers for this experiment (any four of each would score full marks)'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, ''), h('th', { scope: 'col' }, 'Limitation'), h('th', { scope: 'col' }, 'Improvement'))),
        h('tbody', null, sc.bank.map(function (b) {
          return h('tr', null, h('th', { scope: 'row' }, b.id), h('td', null, b.limitation.label), h('td', null, b.improvement.label));
        })));
      resultBox.appendChild(h('div', { class: 'vd-scroll' }, table));
      resultBox.appendChild(h('p', { class: 'vd-help' }, 'Answers such as “use more accurate equipment”, “human error”, a bare “parallax” or “repeat the readings” score nothing on their own: say exactly what is difficult and exactly what to change.'));
      if (focus) { var hd = resultBox.querySelector('h3'); if (hd) hd.focus(); }
    }

    function check() {
      var res;
      try { res = markEvaluation(sc, lims, imps); } catch (e) {
        ui.clear(resultBox);
        resultBox.appendChild(h('p', { class: 'vd-error' }, '⚠ Your answers could not be marked: ' + e.message));
        return;
      }
      var note = recordProgress(env, drill, seed, res);
      checked = true;
      save();
      show(res, note, true);
    }

    load(seed, state.seed === seed ? state : null);
    if (checked) {
      try { show(markEvaluation(sc, lims, imps), 'You checked this set earlier.', false); } catch (e) { /* ignore */ }
    }
    return { show: function () {}, destroy: function () {} };
  }

  var BUILDERS = { graph: graphDrill, uncertainty: uncertaintyDrill, table: tableDrill, evaluation: evaluationDrill };

  /* ================================================================== mount */

  /**
   * Mount the Skill drills page.
   * @param {HTMLElement} container
   * @param {{storage?: object}} [opts]
   * @returns {{destroy: function, el: HTMLElement}}
   */
  function mount(container, opts) {
    opts = opts || {};
    var store = opts.storage || VL.storage || null;
    var saveTimers = {}, pending = {};
    function flush(id) {
      clearTimeout(saveTimers[id]);
      if (!pending[id]) return;
      try { store.set('drills:state:' + id, pending[id]); } catch (e) { /* ignore */ }
      delete pending[id];
    }
    var env = {
      store: store,
      sessionRecorded: {},
      loadState: function (id) {
        try { var s = store ? store.get('drills:state:' + id, null) : null; return s && typeof s === 'object' ? s : null; } catch (e) { return null; }
      },
      saveState: function (id, s) {
        if (!store) return;
        clearTimeout(saveTimers[id]);
        try { pending[id] = JSON.parse(JSON.stringify(s)); } catch (e) { return; }
        saveTimers[id] = setTimeout(function () { flush(id); }, 300);
      }
    };

    var offUnload = ui.on(globalThis, 'pagehide', function () { Object.keys(pending).forEach(flush); });

    var root = h('div', { class: 'vd-root' });
    container.appendChild(root);
    root.appendChild(h('h1', { class: 'vd-h1' }, 'Skill drills'));
    root.appendChild(h('p', { class: 'vd-intro' }, 'Short exercises, one skill at a time. Every set has a seed: note it down to try exactly the same set again. The first time you check a set, your mark is recorded on the ',
      h('a', { href: '#/progress' }, 'Progress'), ' page.'));
    var persistent = true;
    try { persistent = !!store && store.available(); } catch (e) { persistent = false; }
    if (!persistent) root.appendChild(h('p', { class: 'vd-notice', role: 'note' }, '⚠ This browser is not letting the lab save data, so your drill results will be lost when you close the page.'));

    var tablist = h('div', { class: 'vd-tabs', role: 'tablist', 'aria-label': 'Drills' });
    root.appendChild(tablist);
    var tabs = {}, panels = {}, built = {};
    DRILLS.forEach(function (d) {
      var tab = h('button', { type: 'button', role: 'tab', id: 'vd-tab-' + d.id, class: 'vd-tab', 'aria-controls': 'vd-panel-' + d.id,
        'aria-selected': 'false', tabindex: '-1', on: { click: function () { select(d.id, false); } } },
      h('span', { class: 'vd-tab-label' }, d.tab), h('span', { class: 'vd-tab-skills' }, d.skills.join(' · ')));
      tabs[d.id] = tab;
      tablist.appendChild(tab);
      var panel = h('section', { role: 'tabpanel', id: 'vd-panel-' + d.id, class: 'vd-panel', 'aria-labelledby': 'vd-tab-' + d.id, tabindex: '-1' });
      panel.hidden = true;
      panels[d.id] = panel;
      root.appendChild(panel);
    });

    tablist.addEventListener('keydown', function (ev) {
      var ids = DRILLS.map(function (d) { return d.id; });
      var cur = ids.indexOf((ev.target.id || '').replace('vd-tab-', ''));
      if (cur < 0) return;
      var next = null;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = ids[(cur + 1) % ids.length];
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = ids[(cur + ids.length - 1) % ids.length];
      else if (ev.key === 'Home') next = ids[0];
      else if (ev.key === 'End') next = ids[ids.length - 1];
      if (next) { ev.preventDefault(); select(next, true); }
    });

    function build(d) {
      var panel = panels[d.id];
      panel.appendChild(h('div', { class: 'vd-panel-head' },
        h('h2', { class: 'vd-h2' }, d.title, ' ', skillBadges(d.skills)),
        h('p', null, d.blurb)));
      var body = h('div', { class: 'vd-panel-body' });
      panel.appendChild(body);
      try {
        built[d.id] = BUILDERS[d.id](body, d, env);
      } catch (e) {
        console.error('[drills ' + d.id + ']', e);
        body.appendChild(h('p', { class: 'vd-error' }, '⚠ This drill could not be opened: ' + (e && e.message ? e.message : e)));
        built[d.id] = { show: function () {}, destroy: function () {} };
      }
    }

    function select(id, focusTab) {
      DRILLS.forEach(function (d) {
        var on = d.id === id;
        tabs[d.id].setAttribute('aria-selected', on ? 'true' : 'false');
        tabs[d.id].tabIndex = on ? 0 : -1;
        tabs[d.id].classList.toggle('vd-tab--on', on);
        panels[d.id].hidden = !on;
      });
      var d = DRILLS.filter(function (x) { return x.id === id; })[0];
      if (!built[id]) build(d);
      else if (built[id].show) built[id].show();
      if (focusTab) tabs[id].focus();
      try { if (store) store.set('drills:tab', id); } catch (e) { /* ignore */ }
    }

    var first = 'graph';
    try { var saved = store ? store.get('drills:tab', 'graph') : 'graph'; if (BUILDERS[saved]) first = saved; } catch (e) { /* ignore */ }
    select(first, false);

    return {
      el: root,
      destroy: function () {
        Object.keys(pending).forEach(flush);
        offUnload();
        Object.keys(built).forEach(function (k) { try { built[k].destroy(); } catch (e) { /* ignore */ } });
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  ui.drillsView = {
    mount: mount,
    graphDataset: graphDataset,
    uncertaintyQuestions: uncertaintyQuestions,
    checkField: checkField,
    tableScenario: tableScenario,
    evaluationScenario: evaluationScenario,
    markGraph: markGraph,
    markTable: markTable,
    markEvaluation: markEvaluation,
    DRILLS: DRILLS,
    RELATIONSHIPS: RELATIONSHIPS,
    TABLE_SCENARIOS: TABLE_SCENARIOS,
    EVAL_SCENARIOS: EVAL_SCENARIOS
  };
})(globalThis.VLab = globalThis.VLab || {});
