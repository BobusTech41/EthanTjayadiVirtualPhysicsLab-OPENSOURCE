/* Tests for experiments/pendulum.js (spec: docs/experiments/pendulum.md). Runs in Node (vm, no DOM) and in the browser. */
(function () {
  'use strict';
  var VL = globalThis.VLab;
  var VARIANTS = ['graph', 'twopoint'];
  var SEEDS = ['PEN-AAAA-BBBB', 'PEN-1234-5678', 'PEN-ZZZZ-0000', 'PEN-7K2Q-91C3', 'PEN-QQQQ-RRRR', 'PEN-0000-0001'];

  /** Spec tables: marks per part and per skill. */
  var PART_MARKS = {
    graph: { a: 1, b: 1, c: 1, d: 8, 'e-i': 3, 'e-ii': 1, 'e-iii': 2, f: 2, g: 1 },
    twopoint: { a: 1, b: 1, 'c-i': 1, 'c-ii': 2, d: 3, 'e-i': 1, 'e-ii': 1, f: 1, g: 1, 'h-i': 4, 'h-ii': 4 }
  };
  var SKILLS = {
    graph: { MMO: 8, PDO: 7, ACE: 5 },
    twopoint: { MMO: 7, PDO: 2, ACE: 11 }
  };
  /** Answer keys the rubric reads. */
  var RUBRIC_KEYS = {
    graph: ['d', 'L', 'T', 'gradient', 'intercept', 'a', 'b', 'g'],
    twopoint: ['d', 'dAbs', 'dPct', 'L1', 'n1', 't1a', 't1b', 'T1', 'L2', 'n2', 't2a', 't2b', 'T2', 'k1', 'k2',
      'sfJust', 'conclusion', 'g', 'limitations', 'improvements']
  };

  function exp() { return VL.getExperiment('pendulum'); }
  function canMark() { return !!(VL.marking && VL.marking.run && VL.graph && VL.datatable && VL.textmatch && VL.units && VL.sigfig); }

  function flatParts(paper) {
    var out = [];
    (paper.parts || []).forEach(function (p) {
      out.push(p);
      (p.subparts || []).forEach(function (s) { out.push(s); });
    });
    return out;
  }

  function paperKeys(paper) {
    var keys = {};
    flatParts(paper).forEach(function (p) {
      (p.answers || []).forEach(function (a) {
        if (!a.key) return;
        keys[a.key] = true;
        if (a.type === 'working') keys[a.key + '_working'] = true;
      });
    });
    return keys;
  }

  function flatRubric(list, out) {
    out = out || [];
    list.forEach(function (x) { if (Array.isArray(x)) flatRubric(x, out); else out.push(x); });
    return out;
  }

  function paramsFor(seed, v) { return exp().sampleParams(VL.rng.create(seed).fork('params'), v); }

  /** A Question built from the model answer (deep-copied so tests can edit it). */
  function modelQuestion(seed, v) {
    var ma = exp().modelAnswer(paramsFor(seed, v), v, VL.rng.create(seed).fork('model'));
    var copy = JSON.parse(JSON.stringify({ table: ma.table, graph: ma.graph, answers: ma.answers, log: ma.log }));
    return { qid: 'q1', expId: 'pendulum', variantId: v, seed: seed, table: copy.table, graph: copy.graph,
      answers: copy.answers, log: copy.log, markedAt: '2026-01-01T00:00:00.000Z' };
  }

  function mark(q) { return VL.marking.run(exp(), q); }
  function point(rep, id) { return rep.points.filter(function (p) { return p.id === id; })[0]; }

  /* ------------------------------------------------------------------ registration and physics */

  test('pendulum: registered with id, seed prefix and both variants', function () {
    var e = exp();
    assert.ok(e, 'experiment registered');
    assert.equal(e.seedPrefix, 'PEN');
    assert.deepEqual(e.variants.map(function (v) { return v.id + ':' + v.style; }), ['graph:Q1', 'twopoint:Q2']);
    assert.ok(e.apparatusList('graph').length >= 6);
    assert.equal(typeof e.createApparatus, 'function');
  });

  test('pendulum: knownValues pass with noise level 0', function () {
    VL.noise.level = 0;
    var kv = exp().knownValues;
    assert.ok(kv.length >= 4);
    kv.forEach(function (k) { assert.close(k.actual(VL), k.expected, k.tol, k.name); });
  });

  test('pendulum: model — Leff, amplitude dependence and g from a gradient in either unit', function () {
    var m = exp().model;
    assert.close(m.Leff(50, 2.4, 0.2), 51.4, 1e-12);
    assert.close(m.period(50, 2.4, 0.2, 0), 2 * Math.PI * Math.sqrt(0.514 / 9.81), 1e-12);
    assert.ok(m.period(50, 2, 0, 20) > m.period(50, 2, 0, 5), 'larger amplitude, longer period');
    assert.close(m.period(50, 2, 0, 20) / m.period(50, 2, 0, 0), 1 + Math.pow(20 * Math.PI / 180, 2) / 16, 1e-12);
    assert.close(m.gFromGradient(4.024, 's² m⁻¹'), 9.81, 0.01);
    assert.close(m.gFromGradient(0.04024, 's^2 cm^-1'), 9.81, 0.01);
    assert.close(m.gFromGradient(0.04024, 's2/cm'), 9.81, 0.01);
  });

  test('pendulum: swing kinematics — released from rest, oscillations follow the amplitude-dependent period', function () {
    var m = exp().model;
    var th0 = 10 * Math.PI / 180, T0 = m.period(60, 2, 0.2, 0), tau = 100;
    assert.close(m.swingAngle(0, th0, T0, tau), th0, 1e-12, 'starts at the release angle');
    assert.close(m.swingAngle(T0 * m.amplitudeFactor(10), th0, T0, tau) / th0, Math.exp(-T0 / tau), 0.002, 'back after one period');
    var n = m.oscillationsBetween(0, 30, th0, T0, tau);
    assert.ok(n < 30 / T0 && n > 30 / (T0 * m.amplitudeFactor(10)), 'count lies between the small- and full-amplitude values');
  });

  test('pendulum: sampleParams is deterministic for a seed and within the specified ranges', function () {
    SEEDS.forEach(function (seed) {
      var a = paramsFor(seed, 'graph'), b = paramsFor(seed, 'graph'), c = paramsFor(seed, 'twopoint');
      assert.deepEqual(a, b, 'same seed, same params');
      assert.deepEqual(a, c, 'variant does not change the apparatus');
      assert.ok(a.d >= 1.8 && a.d <= 2.6, 'd range');
      assert.close(a.d * 1000, Math.round(a.d * 1000), 1e-6, 'd to 0.001 cm');
      assert.ok(a.delta >= 0 && a.delta <= 0.4, 'delta range');
      assert.ok(a.tau >= 60 && a.tau <= 150, 'tau range');
      assert.ok(a.vernierRes === 0.1 || a.vernierRes === 0.02, 'vernier type');
      assert.ok(Math.abs(a.eyeStart) >= 3 && Math.abs(a.eyeStart) <= 9, 'eye start');
      assert.ok(Math.abs(a.vernierZero) <= 3 * a.vernierRes + 1e-9, 'zero error within 3 divisions');
      assert.ok(a.L0 >= 10 && a.L0 <= 100, 'initial length');
    });
    assert.ok(JSON.stringify(paramsFor(SEEDS[0], 'graph')) !== JSON.stringify(paramsFor(SEEDS[1], 'graph')), 'different seeds differ');
    var types = {};
    for (var i = 0; i < 40; i++) types[paramsFor('PEN-AAAA-' + (1000 + i), 'graph').vernierRes] = true;
    assert.ok(types['0.1'] && types['0.02'], 'both vernier types occur');
    VL.noise.level = 0;
    for (var j = 0; j < 20; j++) assert.equal(paramsFor('PEN-BBBB-' + (1000 + j), 'graph').vernierZero, 0, 'no zero error at noise level 0');
  });

  /* ------------------------------------------------------------------ paper / rubric consistency */

  VARIANTS.forEach(function (v) {
    test('pendulum ' + v + ': paper marks total 20 and match the rubric part by part', function () {
      var paper = exp().paper(v, paramsFor(SEEDS[0], v));
      var parts = flatParts(paper);
      var paperTotal = parts.reduce(function (s, p) { return s + (typeof p.marks === 'number' ? p.marks : 0); }, 0);
      assert.equal(paperTotal, 20, 'Σ part marks');
      assert.equal(paper.totalMarks, 20);
      assert.equal(paper.apparatusNote, 'You may not need to use all of the apparatus provided.');
      var byPart = {};
      parts.forEach(function (p) { if (typeof p.marks === 'number') byPart[p.id] = p.marks; });
      assert.deepEqual(byPart, PART_MARKS[v], 'part marks as in the spec table');
      if (!VL.marking) return;
      var rubric = flatRubric(exp().rubric(v));
      var ids = {};
      parts.forEach(function (p) { ids[p.id] = true; });
      var rubricByPart = {}, total = 0, pointIds = {};
      rubric.forEach(function (mp) {
        assert.ok(ids[mp.part], 'rubric part "' + mp.part + '" (' + mp.id + ') exists in the paper');
        assert.ok(!pointIds[mp.id], 'mark point ids are unique: ' + mp.id);
        pointIds[mp.id] = true;
        rubricByPart[mp.part] = (rubricByPart[mp.part] || 0) + mp.max;
        total += mp.max;
      });
      assert.equal(total, 20, 'Σ rubric max');
      assert.deepEqual(rubricByPart, PART_MARKS[v], 'rubric marks per part equal paper marks');
    });

    test('pendulum ' + v + ': skill totals match the spec', function () {
      if (!VL.marking) return;
      var skills = { MMO: 0, PDO: 0, ACE: 0 };
      flatRubric(exp().rubric(v)).forEach(function (mp) { skills[mp.skill] += mp.max; });
      assert.deepEqual(skills, SKILLS[v]);
    });

    test('pendulum ' + v + ': answer keys read by the rubric and given by the model answer exist in the paper', function () {
      var keys = paperKeys(exp().paper(v));
      RUBRIC_KEYS[v].forEach(function (k) { assert.ok(keys[k], 'paper has answer key ' + k); });
      if (!VL.datatable) return;
      var ma = exp().modelAnswer(paramsFor(SEEDS[0], v), v, VL.rng.create(SEEDS[0]).fork('model'));
      Object.keys(ma.answers).forEach(function (k) { assert.ok(keys[k], 'model answer key ' + k + ' is on the paper'); });
      assert.ok(Array.isArray(ma.notes) && ma.notes.length >= 4, 'model answer notes');
    });

    test('pendulum ' + v + ': hints and common mistakes', function () {
      var hints = exp().hints[v];
      assert.ok(hints && typeof hints === 'object');
      flatParts(exp().paper(v)).forEach(function (p) {
        if (typeof p.marks === 'number') assert.ok(typeof hints[p.id] === 'string' && hints[p.id].length > 20, 'hint for ' + p.id);
      });
      var cm = exp().commonMistakes(v);
      assert.ok(Array.isArray(cm) && cm.length >= 6);
      assert.ok(cm.some(function (s) { return /one oscillation/i.test(s); }));
    });
  });

  test('pendulum: the paper uses original Cambridge-style wording', function () {
    var g = exp().paper('graph'), t = exp().paper('twopoint');
    assert.match(g.intro, /In this experiment, you will investigate how the period/);
    assert.match(flatParts(g).map(function (p) { return p.html || ''; }).join(' '), /six sets of values/);
    assert.match(flatParts(t).map(function (p) { return p.html || ''; }).join(' '), /four sources of uncertainty or limitations/);
  });

  /* ------------------------------------------------------------------ marking the model answer */

  test('pendulum: model answers score ≥ 17/20 (graph) and ≥ 15/20 (twopoint), noise level 1 and 0', function () {
    if (!canMark()) return;
    [1, 0].forEach(function (level) {
      VL.noise.level = level;
      SEEDS.forEach(function (seed) {
        var rg = mark(modelQuestion(seed, 'graph'));
        assert.ok(rg.total >= 17, 'graph ' + seed + ' level ' + level + ': ' + rg.total + ' ' +
          JSON.stringify(rg.points.filter(function (p) { return p.awarded < p.max; }).map(function (p) { return p.comment; })));
        assert.equal(rg.max, 20);
        var rt = mark(modelQuestion(seed, 'twopoint'));
        assert.ok(rt.total >= 15, 'twopoint ' + seed + ' level ' + level + ': ' + rt.total + ' ' +
          JSON.stringify(rt.points.filter(function (p) { return p.awarded < p.max; }).map(function (p) { return p.comment; })));
        assert.equal(rt.max, 20);
      });
    });
  });

  test('pendulum: an empty attempt marks without errors and scores 0', function () {
    if (!canMark()) return;
    VARIANTS.forEach(function (v) {
      var rep = mark({ expId: 'pendulum', variantId: v, seed: SEEDS[0], table: null, graph: null, answers: {}, log: [] });
      assert.equal(rep.total, 0, v);
      rep.points.forEach(function (p) {
        assert.ok(!/could not be marked/.test(p.comment), v + ' ' + p.id + ' threw: ' + JSON.stringify(p.details));
        assert.match(p.comment, /^✗ /);
      });
    });
  });

  test('pendulum graph: d needs the zero-error correction and the vernier resolution', function () {
    if (!canMark()) return;
    var q = modelQuestion(SEEDS[3], 'graph');
    var p = paramsFor(SEEDS[3], 'graph');
    q.answers.d = (p.d + 0.06).toFixed(p.vernierRes === 0.02 ? 3 : 2) + ' cm';
    assert.equal(point(mark(q), 'd').awarded, 0, 'more than 0.03 cm out');
    q.answers.d = (p.d).toFixed(1) + ' cm';
    assert.equal(point(mark(q), 'd').awarded, 0, 'too few decimal places');
    q.answers.d = (p.d * 10).toFixed(p.vernierRes === 0.02 ? 2 : 1) + ' mm';
    assert.equal(point(mark(q), 'd').awarded, 1, 'mm accepted');
  });

  test('pendulum: d must be corrected for the hidden zero error (both resolutions, both variants)', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var covered = { 0.1: 0, 0.02: 0 }, zeroFree = 0, ambiguous = 0, checked = 0;
    function mm2cm(mm, res) { return (mm / 10).toFixed(res === 0.02 ? 3 : 2) + ' cm'; }
    function markD(seed, v, d) {
      return point(mark({ expId: 'pendulum', variantId: v, seed: seed, table: null, graph: null, answers: { d: d }, log: [] }), 'd');
    }
    for (var i = 0; i < 80; i++) {
      var seed = 'PEN-ZERO-' + i;
      var p = paramsFor(seed, 'graph'), res = p.vernierRes, z = p.vernierZero;
      var trueMm = p.d * 10, R = Math.round(trueMm / res) * res;   // a careful reading, corrected
      var v = i % 2 ? 'twopoint' : 'graph';
      if (!z) {
        if (zeroFree++ < 3) {
          assert.equal(markD(seed, v, mm2cm(R, res)).awarded, 1, seed + ' (no zero error): corrected');
          assert.equal(markD(seed, v, mm2cm(R + res, res)).awarded, 1, seed + ' (no zero error): one division out is within tolerance');
        }
        continue;
      }
      checked++;
      covered[res]++;
      var c = markD(seed, v, mm2cm(R, res));
      assert.equal(c.awarded, 1, seed + ' corrected: ' + c.comment);
      var added = markD(seed, v, mm2cm(R + 2 * z, res));
      assert.equal(added.awarded, 0, seed + ' zero error added: ' + added.comment);
      // the uncorrected scale reading: refused unless it could also be a careful corrected reading (less than half a
      // division + the 0.01 mm squeeze from the true diameter), where ties favour the student
      var U = R + z;
      if (Math.abs(U - trueMm) < res / 2 + 0.01 - 1e-6) { ambiguous++; continue; }
      var u = markD(seed, v, mm2cm(U, res));
      assert.equal(u.awarded, 0, seed + ' uncorrected: ' + u.comment);
      assert.match(u.comment, /this is the scale reading: the callipers have a zero error of [+−]\d\.\d+ mm, so subtract it \(corrected reading = reading − zero error\)/);
    }
    assert.ok(covered[0.1] >= 3 && covered[0.02] >= 3, 'seeds with a zero error for both resolutions: ' + JSON.stringify(covered));
    assert.ok(ambiguous <= checked / 4, 'only a few uncorrected readings are indistinguishable (' + ambiguous + ' of ' + checked + ')');
    var r = mark(modelQuestion('PEN-AAAA-BBBB', 'graph'));
    assert.equal(r.total, 20);
    assert.equal(mark(modelQuestion('PEN-AAAA-BBBB', 'twopoint')).total, 20);
  });

  test('pendulum graph: L must be to the nearest mm and match the pendulum at the time', function () {
    if (!canMark()) return;
    var q = modelQuestion(SEEDS[0], 'graph');
    assert.equal(point(mark(q), 'L').awarded, 1);
    q.answers.L = '50 cm';
    assert.equal(point(mark(q), 'L').awarded, 0, 'no mm precision');
    q.answers.L = '500 mm';
    assert.equal(point(mark(q), 'L').awarded, 1, '500 mm is to the nearest mm');
    q.answers.L = '0.500 m';
    assert.equal(point(mark(q), 'L').awarded, 1);
    q.answers.L = '50.0';
    assert.equal(point(mark(q), 'L').awarded, 0, 'no unit');
    q.answers.L = '50.0 cm';
    q.log = q.log.map(function (e) { var c = Object.assign({}, e); if (c.L === 50) c.L = 50.45; return c; });
    var rep = mark(q);
    var L0 = paramsFor(SEEDS[0], 'graph').L0;      // the starting length is also a length "at some time"
    var nearestTrue = Math.abs(L0 - 50) < 0.45 ? L0 : 50.45;
    assert.equal(point(rep, 'L').awarded, Math.abs(nearestTrue - 50) <= 0.3 ? 1 : 0, 'misread by more than 3 mm');
    assert.match(point(rep, 'L').comment, new RegExp('length at the time was ' + nearestTrue.toFixed(1).replace('.', '\\.') + ' cm'));
  });

  test('pendulum: lengths must be near the length the question asks for (Q1 about 50 cm; Q2 about 30 cm, then 80 cm)', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var q = modelQuestion('PEN-AAAA-BBBB', 'graph');
    assert.equal(mark(q).total, 20, 'graph model answer');
    ['95.0 cm', '20.0 cm'].forEach(function (L) {
      var w = JSON.parse(JSON.stringify(q));
      w.answers.L = L;
      var r = point(mark(w), 'L');
      assert.equal(r.awarded, 0, L);
      assert.equal(r.comment, '✗ L = ' + L + ': the question asks you to set L to about 50 cm.');
    });
    var near = JSON.parse(JSON.stringify(q));
    near.answers.L = '52.3 cm';
    near.log.push({ t: 9e6, type: 'length-set', L: 52.3 });
    assert.equal(point(mark(near), 'L').awarded, 1, '52.3 cm with a matching lab record');
    var t = modelQuestion('PEN-AAAA-BBBB', 'twopoint');
    assert.equal(mark(t).total, 20, 'twopoint model answer');
    var sw = JSON.parse(JSON.stringify(t));
    ['L', 'n', 't?a', 't?b', 'T'].forEach(function (k) {
      var k1 = k.indexOf('?') >= 0 ? k.replace('?', '1') : k + '1', k2 = k.indexOf('?') >= 0 ? k.replace('?', '2') : k + '2';
      var tmp = sw.answers[k1]; sw.answers[k1] = sw.answers[k2]; sw.answers[k2] = tmp;
    });
    var rs = mark(sw);
    assert.equal(point(rs, 'L1').awarded, 0, 'L₁ = 80.0 cm');
    assert.match(point(rs, 'L1').comment, /asks you to set L₁ to about 30 cm/);
    assert.equal(point(rs, 'set-2').awarded, 0, 'L₂ = 30.0 cm');
    assert.match(point(rs, 'set-2').comment, /L₂ = 30\.0 cm: the question asks you to set L₂ to about 80 cm/);
  });

  test('pendulum graph: T needs two timings of at least 10 oscillations and must be within 3 %', function () {
    if (!canMark()) return;
    var q = modelQuestion(SEEDS[1], 'graph');
    assert.equal(point(mark(q), 'T').awarded, 1);
    var at50 = function (e) { return e.type === 'stopwatch-stop' && e.L === 50; };
    var one = JSON.parse(JSON.stringify(q));
    var seen = 0;
    one.log = one.log.filter(function (e) { return !at50(e) || seen++ === 0; });
    assert.equal(point(mark(one), 'T').awarded, 0, 'one timing only');
    var few = JSON.parse(JSON.stringify(q));
    few.log.forEach(function (e) { if (at50(e)) e.oscillationsTrue = 5.02; });
    var rf = mark(few);
    assert.equal(point(rf, 'T').awarded, 0, 'only 5 oscillations timed');
    assert.match(point(rf, 'T').comment, /about 5 oscillations/);
    var none = JSON.parse(JSON.stringify(q));
    none.log = [];
    assert.equal(point(mark(none), 'T').awarded, 0, 'no timings in the lab record');
    var off = JSON.parse(JSON.stringify(q));
    off.answers.T = (parseFloat(q.answers.T) * 1.05).toFixed(3) + ' s';
    assert.equal(point(mark(off), 'T').awarded, 0, '5 % out');
  });

  test('pendulum graph: repeat timings are counted per stopwatch reset, not per stop', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var q = modelQuestion('PEN-AAAA-BBBB', 'graph');
    assert.equal(point(mark(q), 'T').awarded, 1, 'model answer');
    var T = paramsFor('PEN-AAAA-BBBB', 'graph');
    var Tp = VL.getExperiment('pendulum').model.period(50, T.d, T.delta, 5);
    function ev(t, type, osc) {
      var e = { t: t, type: type };
      if (type !== 'stopwatch-reset') { e.L = 50; e.T = Tp; e.amplitudeDeg = 5; e.swinging = true; }
      if (type === 'stopwatch-stop') { e.oscillationsTrue = osc; e.elapsedTrue = osc * Tp; }
      return e;
    }
    function withTimings(events) {
      var c = JSON.parse(JSON.stringify(q));
      c.log = c.log.filter(function (e) { return !(e.L === 50 && /^stopwatch/.test(e.type)) && !(e.type === 'stopwatch-reset'); })
        .concat([{ t: 1e7, type: 'length-set', L: 50 }]).concat(events);
      return point(mark(c), 'T');
    }
    // one timing of 20, then an accidental start/stop 0.1 oscillation later without a reset
    var dbl = withTimings([ev(1e7 + 1, 'stopwatch-start'), ev(1e7 + 2, 'stopwatch-stop', 20.0),
      ev(1e7 + 3, 'stopwatch-start'), ev(1e7 + 4, 'stopwatch-stop', 20.1)]);
    assert.equal(dbl.awarded, 0, dbl.comment);
    assert.match(dbl.comment, /Only one timing of 10 or more oscillations/i);
    // two genuine timings of 20 separated by a reset
    var two = withTimings([ev(1e7 + 1, 'stopwatch-start'), ev(1e7 + 2, 'stopwatch-stop', 20.0), ev(1e7 + 3, 'stopwatch-reset'),
      ev(1e7 + 4, 'stopwatch-start'), ev(1e7 + 5, 'stopwatch-stop', 20.02), ev(1e7 + 6, 'stopwatch-reset')]);
    assert.equal(two.awarded, 1, two.comment);
    // two segments of 10 without a reset (cumulative 20) are ONE timing
    var seg = withTimings([ev(1e7 + 1, 'stopwatch-start'), ev(1e7 + 2, 'stopwatch-stop', 10.0),
      ev(1e7 + 3, 'stopwatch-start'), ev(1e7 + 4, 'stopwatch-stop', 20.0), ev(1e7 + 5, 'stopwatch-reset')]);
    assert.equal(seg.awarded, 0, seg.comment);
    assert.equal(seg.details.timings, 1);
  });

  test('pendulum graph: a and b follow the gradient and intercept (ECF, unit conversion); g follows a', function () {
    if (!canMark()) return;
    var q = modelQuestion(SEEDS[2], 'graph');
    var grad = parseFloat(q.answers.gradient);
    q.answers.a = VL.sigfig.formatSF(grad * 100, 3) + ' s² m⁻¹';
    var rep = mark(q);
    assert.equal(point(rep, 'ab-values').awarded, 1, 'a converted to s² m⁻¹');
    assert.equal(point(rep, 'ab-units').awarded, 1);
    q.answers.a = q.answers.gradient + ' s';
    rep = mark(q);
    assert.equal(point(rep, 'ab-units').awarded, 0, 'wrong unit for a');
    q.answers.a = (grad * 1.2).toPrecision(3) + ' s² cm⁻¹';
    assert.equal(point(mark(q), 'ab-values').awarded, 0, 'a is not the gradient');
    var gq = modelQuestion(SEEDS[2], 'graph');
    var gv = 4 * Math.PI * Math.PI / (parseFloat(gq.answers.a) * 100);
    gq.answers.g = gv.toFixed(1) + ' m s⁻²';
    assert.equal(point(mark(gq), 'g').awarded, 1, '2 s.f. accepted');
    gq.answers.g = gv.toFixed(2);
    assert.equal(point(mark(gq), 'g').awarded, 0, 'no unit');
    gq.answers.g = gv.toFixed(4) + ' m s⁻²';
    assert.equal(point(mark(gq), 'g').awarded, 0, 'too many s.f.');
    gq.answers.g = (gv / 100).toFixed(3) + ' m s⁻²';
    assert.equal(point(mark(gq), 'g').awarded, 0, 'cm not converted');
  });

  test('pendulum graph: the unit of a must suit its value (axis units); g then carries forward from the gradient', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var base = modelQuestion('PEN-AAAA-BBBB', 'graph');
    assert.equal(base.graph.x.colId, base.table.columns[0].id);
    assert.match(base.table.columns[0].heading, /\/ cm$/, 'L axis in cm');
    var grad = base.answers.gradient;
    function with_(a) {
      var q = JSON.parse(JSON.stringify(base));
      q.answers.a = a;
      return mark(q);
    }
    var r = with_(grad + ' s² m⁻¹');
    assert.equal(point(r, 'ab-values').awarded, 1, 'the number was copied from the gradient');
    assert.equal(point(r, 'ab-units').awarded, 0, 'but s² m⁻¹ contradicts a gradient from an L axis in cm');
    assert.equal(point(r, 'ab-units').comment, '✗ a = ' + grad + ' s² m⁻¹: your gradient ' + grad + ' is in s² cm⁻¹ because L is plotted in cm, ' +
      'so with the unit s² m⁻¹ a would be ' + VL.sigfig.formatSF(parseFloat(grad) * 100, 3) + '.');
    assert.equal(point(r, 'g').awarded, 1, 'g = 9.80 m s⁻² follows from the gradient (ECF): ' + point(r, 'g').comment);
    assert.equal(r.total, 19);
    assert.equal(with_(VL.sigfig.formatSF(parseFloat(grad) * 100, 3) + ' s² m⁻¹').total, 20, 'converted to s² m⁻¹');
    assert.equal(with_(grad + ' s² cm⁻¹').total, 20, 'in the axis units');
    var bare = with_(grad);
    assert.equal(point(bare, 'ab-units').awarded, 0, 'no unit');
    assert.equal(point(bare, 'g').awarded, 1);
    // the reverse case: L plotted in m, a quoted in s² cm⁻¹ with the same number
    var qm = JSON.parse(JSON.stringify(base));
    var c1 = qm.table.columns[0].id, c5 = qm.table.columns[4].id;
    qm.table.columns[0].heading = 'L / m';
    qm.table.rows.forEach(function (row) { row.cells[c1] = (parseFloat(row.cells[c1]) / 100).toFixed(3); });
    qm.graph = VL.graph.modelGraph(VL.datatable.fromJSON(qm.table), c1, c5, { xLabel: 'L / m', yLabel: 'T² / s²' });
    var ro = qm.graph.readOffs;
    qm.answers.gradient = VL.sigfig.formatSF((parseFloat(ro.y2) - parseFloat(ro.y1)) / (parseFloat(ro.x2) - parseFloat(ro.x1)), 3);
    qm.answers.intercept = qm.graph.intercept.value;
    qm.answers.b = qm.answers.intercept + ' s²';
    qm.answers.a = qm.answers.gradient + ' s² cm⁻¹';
    var rm = mark(qm);
    assert.equal(point(rm, 'ab-units').awarded, 0, 'L in m, a in s² cm⁻¹');
    assert.match(point(rm, 'ab-units').comment, /is in s² m⁻¹ because L is plotted in m, so with the unit s² cm⁻¹ a would be/);
    qm.answers.a = qm.answers.gradient + ' s² m⁻¹';
    assert.equal(point(mark(qm), 'ab-units').awarded, 1);
  });

  test('pendulum graph: table marks respond to typical mistakes', function () {
    if (!canMark()) return;
    var q = modelQuestion(SEEDS[0], 'graph');
    var t = q.table;
    t.columns[4].heading = 'T²';
    assert.equal(point(mark(q), 'headings').awarded, 0, 'T² without a unit');
    t.columns[4].heading = 'T² / s²';
    t.rows[2].cells[t.columns[0].id] = '50';
    assert.equal(point(mark(q), 'raw-L').awarded, 0, 'inconsistent d.p. in L');
    t.rows[2].cells[t.columns[0].id] = '50.0';
    t.rows[0].cells[t.columns[4].id] = VL.sigfig.formatSF(parseFloat(t.rows[0].cells[t.columns[4].id]), 2);
    assert.equal(point(mark(q), 'sf-T2').awarded, 0, 'T² to 2 s.f.');
    var q2 = modelQuestion(SEEDS[0], 'graph');
    q2.table.rows = q2.table.rows.slice(0, 4);
    var rep = mark(q2);
    assert.equal(point(rep, 'readings').awarded, 1, 'four sets → 1 of 3');
  });

  test('pendulum graph: T² is checked from t and n when the table has no T column', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var q = modelQuestion('PEN-AAAA-BBBB', 'graph');
    var cT = q.table.columns[3];
    assert.equal(cT.heading, 'T / s');
    cT.heading = 'n';
    q.table.rows.forEach(function (row) { row.cells[cT.id] = '20'; });
    var r = point(mark(q), 'calc-T2');
    assert.equal(r.awarded, 1, r.comment);
    q.table.rows[2].cells[q.table.columns[4].id] = (parseFloat(q.table.rows[2].cells[q.table.columns[4].id]) * 1.05).toFixed(3);
    assert.equal(point(mark(q), 'calc-T2').awarded, 0, 'a wrong T² is still found');
  });

  test('pendulum graph: a heading unit that is not a length is described in the unit actually assumed (m)', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    ['L / s', 'L / cm²'].forEach(function (hd) {
      var q = modelQuestion('PEN-AAAA-BBBB', 'graph');
      q.table.columns[0].heading = hd;
      var r = point(mark(q), 'raw-L');
      assert.equal(r.awarded, 0, hd);
      assert.match(r.comment, /should be recorded to the nearest 0\.001 m \(the resolution of the instrument\)/, r.comment);
      assert.match(r.comment, /\(the unit in the heading is not a length, so the values were taken to be in m\)/, r.comment);
      assert.ok(r.comment.indexOf('cm or m') < 0, r.comment);
    });
  });

  test('pendulum graph: word headings (any name or symbol plus a unit) still score 20/20', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var base = modelQuestion('PEN-AAAA-BBBB', 'graph');
    assert.equal(mark(base).total, 20, 'model answer');
    [
      [0, ['length / cm']], [0, ['Length L / cm']], [0, ['length of string / cm']],
      [1, ['time t₁ / s', 'time t₂ / s']], [1, ['Time for 20 oscillations / s', 'Time for 20 oscillations / s']],
      [1, ['t₁ for 20 oscillations / s', 't₂ for 20 oscillations / s']], [1, ['1st t / s', '2nd t / s']],
      [3, ['period T / s']], [4, ['T squared / s²']], [4, ['Period² / s²']], [0, ['Length / cm']],
      [1, ['t1 (s)', 't2 (s)']], [1, ['t_1 / s', 't_2 / s']], [4, ['T² / s^2']], [3, ['Period / s']], [1, ['t / s', 't / s']]
    ].forEach(function (c) {
      var q = JSON.parse(JSON.stringify(base));
      c[1].forEach(function (h, k) { q.table.columns[c[0] + k].heading = h; });
      var rep = mark(q);
      assert.equal(rep.total, 20, c[1].join(', ') + ': ' + JSON.stringify(rep.points.filter(function (p) { return p.awarded < p.max; })
        .map(function (p) { return p.id + ' ' + p.comment; })));
    });
    var bad = JSON.parse(JSON.stringify(base));
    bad.table.columns[0].heading = 'banana / cm';
    var rb = mark(bad);
    assert.equal(point(rb, 'readings').awarded, 0);
    assert.match(point(rb, 'readings').comment, /The column headed “banana \/ cm” could not be matched to a quantity in this experiment, so it was not marked; use the symbol from the question, e\.g\. L \/ cm\./);
    assert.match(point(rb, 'headings').comment, /“banana \/ cm” could not be matched/);
  });

  test('pendulum graph: the graph must be T² against L, with every row plotted, for the graph marks', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var base = modelQuestion('PEN-AAAA-BBBB', 'graph');
    assert.equal(mark(base).total, 20, 'model answer');
    assert.equal(mark(modelQuestion('PEN-AAAA-BBBB', 'twopoint')).total, 20, 'twopoint model answer');
    var cols = base.table.columns;
    // empty graph
    var empty = JSON.parse(JSON.stringify(base));
    empty.graph = VL.graph.create();
    var re = mark(empty);
    assert.equal(point(re, 'quality').awarded, 0, 'no graph, no quality mark');
    assert.equal(point(re, 'quality').comment, '✗ No graph drawn.');
    // only 3 of the 6 rows plotted
    var three = JSON.parse(JSON.stringify(base));
    three.graph.points = three.graph.points.slice(0, 3);
    var r3 = mark(three);
    assert.equal(point(r3, 'quality').awarded, 0, '3 of 6 rows plotted');
    assert.match(point(r3, 'quality').comment, /All the points in the table \(at least 5\) must be plotted on your graph of T² against L/);
    // T plotted against L: a and b taken from that line
    var tl = JSON.parse(JSON.stringify(base));
    tl.graph = VL.graph.modelGraph(VL.datatable.fromJSON(tl.table), cols[0].id, cols[3].id, { xLabel: 'L / cm', yLabel: 'T / s' });
    var ro = tl.graph.readOffs;
    var m = (parseFloat(ro.y2) - parseFloat(ro.y1)) / (parseFloat(ro.x2) - parseFloat(ro.x1));
    tl.answers.gradient = VL.sigfig.formatSF(m, 3);
    tl.answers.intercept = tl.graph.intercept.value;
    tl.answers.a = tl.answers.gradient + ' s² cm⁻¹';
    tl.answers.b = tl.answers.intercept + ' s²';
    var rt = mark(tl);
    ['axes', 'quality', 'gradient', 'intercept', 'ab-values'].forEach(function (id) {
      assert.equal(point(rt, id).awarded, 0, id + ': ' + point(rt, id).comment);
      assert.equal(point(rt, id).comment, '✗ The question asks for a graph of T² (y-axis) against L (x-axis); your graph shows T against L.', id);
    });
    assert.equal(point(rt, 'plotting').awarded, 1, 'plotting is judged on what was plotted');
    // axes swapped
    var sw = JSON.parse(JSON.stringify(base));
    sw.graph = VL.graph.modelGraph(VL.datatable.fromJSON(sw.table), cols[4].id, cols[0].id, { xLabel: 'T² / s²', yLabel: 'L / cm' });
    var rs = mark(sw);
    assert.equal(point(rs, 'axes').awarded, 0);
    assert.equal(point(rs, 'axes').comment, '✗ The axes are the wrong way round: T² should be on the y-axis and L on the x-axis.');
    assert.equal(point(rs, 'plotting').awarded, 1, 'plotting is judged on what was plotted');
  });

  test('pendulum twopoint: raw timings, trend, k, conclusion and g', function () {
    if (!canMark()) return;
    var q = modelQuestion(SEEDS[4], 'twopoint');
    var rep = mark(q);
    assert.equal(rep.total, 20, JSON.stringify(rep.points.filter(function (p) { return p.awarded < p.max; })));
    var a = JSON.parse(JSON.stringify(q));
    a.answers.n1 = '5';
    a.answers.t1a = (parseFloat(q.answers.t1a) / 4).toFixed(2) + ' s';
    a.answers.t1b = (parseFloat(q.answers.t1b) / 4).toFixed(2) + ' s';
    assert.equal(point(mark(a), 'raw-times-1').awarded, 0, 'fewer than 10 oscillations');
    var b = JSON.parse(JSON.stringify(q));
    b.answers.t1b = '';
    assert.equal(point(mark(b), 'raw-times-1').awarded, 0, 'not repeated');
    var c = JSON.parse(JSON.stringify(q));
    c.answers.n1 = '20';
    c.answers.t1a = (parseFloat(q.answers.t1a) / 2).toFixed(2) + ' s';
    assert.equal(point(mark(c), 'raw-times-1').awarded, 0, 'times inconsistent with 20 oscillations');
    var d = JSON.parse(JSON.stringify(q));
    d.answers.T2 = (parseFloat(q.answers.T1) * 0.9).toFixed(3) + ' s';
    var rd = mark(d);
    assert.equal(point(rd, 'trend').awarded, 0, 'T₂ < T₁');
    assert.equal(point(rd, 'T2').awarded, 0);
    var e = JSON.parse(JSON.stringify(q));
    e.answers.k1 = (parseFloat(q.answers.k1) * 1.1).toPrecision(3) + ' s² m⁻¹';
    assert.equal(point(mark(e), 'k-values').awarded, 0, 'k₁ wrong');
    var f = JSON.parse(JSON.stringify(q));
    f.answers.conclusion = 'The two values of k are close, so the relationship is supported.';
    assert.equal(point(mark(f), 'conclusion').awarded, 0, 'no numerical criterion');
    f.answers.conclusion = 'The values of k differ by less than my criterion of 1 %, so the results support the relationship.';
    var kd = Math.abs(parseFloat(q.answers.k1) - parseFloat(q.answers.k2)) / ((parseFloat(q.answers.k1) + parseFloat(q.answers.k2)) / 2) * 100;
    if (kd > 1.1) assert.equal(point(mark(f), 'conclusion').awarded, 0, 'claim inconsistent with own values');
    var g = JSON.parse(JSON.stringify(q));
    g.answers.sfJust = 'Because the raw readings were recorded to 1 decimal place.';
    assert.equal(point(mark(g), 'sf-justification').awarded, 0, 'decimal places, not s.f.');
    g.answers.g = '9.7';
    assert.equal(point(mark(g), 'g').awarded, 0, 'g without a unit');
  });

  test('pendulum: uncertainties written with ± are read (percentage uncertainty, x ± Δx values)', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var q = modelQuestion('PEN-AAAA-BBBB', 'twopoint');
    q.answers.d = '2.45 cm';
    [['±0.01 cm', '±0.41 %'], ['± 0.01 cm', '± 0.41 %'], ['+/- 0.01 cm', '0.41 %'], ['0.01 cm', '±0.41']].forEach(function (c) {
      q.answers.dAbs = c[0];
      q.answers.dPct = c[1];
      var r = point(mark(q), 'd-uncertainty');
      assert.equal(r.awarded, 1, c.join(', ') + ': ' + r.comment);
    });
    q.answers.d = '2.45 ± 0.01 cm';
    q.answers.dAbs = '';
    q.answers.dPct = '0.41 %';
    assert.equal(point(mark(q), 'd-uncertainty').awarded, 1, 'd written as x ± Δx');
    // (a) d = x ± Δx is marked as x
    var g = modelQuestion('PEN-AAAA-BBBB', 'graph');
    var plain = point(mark(g), 'd');
    assert.equal(plain.awarded, 1, plain.comment);
    var dStr = g.answers.d.replace(/ cm$/, '');
    var res = paramsFor('PEN-AAAA-BBBB', 'graph').vernierRes === 0.02 ? '0.002' : '0.01';
    [dStr + ' ± ' + res + ' cm', '(' + dStr + ' ± ' + res + ') cm', dStr + ' cm ± ' + res + ' cm'].forEach(function (s) {
      g.answers.d = s;
      assert.equal(point(mark(g), 'd').awarded, plain.awarded, s);
    });
    g.answers.d = (parseFloat(dStr) + 0.1).toFixed(dStr.split('.')[1].length) + ' ± ' + res + ' cm';
    assert.equal(point(mark(g), 'd').awarded, 0, 'x is still checked');
    g.answers.d = '±' + dStr + ' cm';
    assert.equal(point(mark(g), 'd').awarded, 0, 'a leading ± is not a value');
    g.answers.L = '50.0 ± 0.1 cm';
    assert.equal(point(mark(g), 'L').awarded, 1, 'L = x ± Δx');
  });

  test('pendulum twopoint: k with a wrong-dimension unit still carries forward to g; expected k quoted in s² m⁻¹', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var q = modelQuestion('PEN-AAAA-BBBB', 'twopoint');
    q.answers.k1 = '4.08 s m⁻¹';
    q.answers.k2 = '4.05 s m⁻¹';
    q.answers.g = '9.71 m s⁻²';                       // 4π² / 4.065
    var r = point(mark(q), 'g');
    assert.equal(r.awarded, 1, r.comment);
    q.answers.g = '8.50 m s⁻²';
    r = point(mark(q), 'g');
    assert.equal(r.awarded, 0);
    assert.match(r.comment, /the unit of k is wrong \(it should be s² m⁻¹\)/);
    assert.ok(!/missing or unreadable/.test(r.comment), r.comment);
    var w = modelQuestion('PEN-AAAA-BBBB', 'twopoint');
    w.answers.k1 = '3.62 s m⁻¹';
    var kv = point(mark(w), 'k-values');
    assert.equal(kv.awarded, 0);
    assert.match(kv.comment, /expected [\d.]+ s² m⁻¹\)/, kv.comment);
  });

  test('pendulum: g needs 2–3 s.f. in Q1 (the paper asks for it) but not in Q2 (a unit only)', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var t = modelQuestion('PEN-AAAA-BBBB', 'twopoint');
    var kMean = (parseFloat(t.answers.k1) + parseFloat(t.answers.k2)) / 2;
    t.answers.g = (4 * Math.PI * Math.PI / kMean).toFixed(3) + ' m s⁻²';
    assert.equal(VL.sigfig.sf(t.answers.g.split(' ')[0]), 4);
    var rt = point(mark(t), 'g');
    assert.equal(rt.awarded, 1, rt.comment);
    assert.equal(rt.label, 'g = 4π²/k̄ with a unit');
    var g = modelQuestion('PEN-AAAA-BBBB', 'graph');
    g.answers.g = (4 * Math.PI * Math.PI / (parseFloat(g.answers.gradient) * 100)).toFixed(3) + ' m s⁻²';
    var rg = point(mark(g), 'g');
    assert.equal(rg.awarded, 0, 'Q1: 4 s.f.');
    assert.match(rg.comment, /2 or 3 significant figures/);
  });

  test('pendulum twopoint: generic limitations and improvements score nothing', function () {
    if (!canMark()) return;
    var q = modelQuestion(SEEDS[5], 'twopoint');
    q.answers.limitations = ['human error', 'parallax error', 'reaction time', 'random errors'];
    q.answers.improvements = ['Use a more accurate stopwatch', 'Repeat the readings and take an average', 'be more careful', 'Use a computer'];
    var rep = mark(q);
    assert.equal(point(rep, 'evaluation-lim').awarded, 0);
    assert.equal(point(rep, 'evaluation-imp').awarded, 0);
    assert.equal(rep.total, 12);
  });

  test('pendulum: the bank credits specific limitations and improvements (rows A–G)', function () {
    if (!VL.textmatch) return;
    var bank = exp().bank;
    function credited(text, side) {
      var r = VL.textmatch.markLimitationsImprovements(side === 'lim' ? [text] : [], side === 'imp' ? [text] : [], bank, { maxEach: 4 });
      var col = side === 'lim' ? r.limitations : r.improvements;
      return col.hits.length ? col.hits[0].id : null;
    }
    [
      ['A', 'Two readings are not enough to draw a conclusion'],
      ['B', 'Hard to judge when an oscillation is complete'],
      ['B', 'Reaction time is large compared to the time measured'],
      ['B', 'the time for one oscillation is too short so the percentage uncertainty is large'],
      ['C', 'Difficult to measure L because the rule is not touching the string'],
      ['C', 'Parallax error when reading the position of the top of the bob on the metre rule'],
      ['D', 'The amplitude was not kept constant'],
      ['E', 'the pendulum moved in an elliptical path'],
      ['F', 'The string slipped in the cork'],
      ['G', 'The amplitude decreased during the timing']
    ].forEach(function (c) { assert.equal(credited(c[1], 'lim'), c[0], c[1]); });
    [
      ['A', 'Take more readings and plot a graph'],
      ['B', 'Use a fiducial marker at the centre of the oscillation'],
      ['B', 'Time 20 oscillations'],
      ['B', 'use light gates connected to a timer'],
      ['C', 'Use a set square to line up the top of the bob with the rule'],
      ['C', 'Clamp the metre rule vertically next to the string'],
      ['D', 'Use a protractor to release from the same angle each time'],
      ['E', 'Use a bifilar suspension'],
      ['F', 'Tighten the clamp so the string cannot slip'],
      ['F', 'Measure L again after each set of oscillations'],
      ['G', 'Use a denser bob to reduce air resistance']
    ].forEach(function (c) { assert.equal(credited(c[1], 'imp'), c[0], c[1]); });
    ['human error', 'parallax error', 'reaction time', 'It was difficult to measure L accurately', 'The two values of k are different']
      .forEach(function (t) { assert.equal(credited(t, 'lim'), null, t); });
    ['Use a more accurate stopwatch', 'Repeat the readings and take an average', 'be more careful', 'Use better equipment', 'avoid parallax']
      .forEach(function (t) { assert.equal(credited(t, 'imp'), null, t); });
  });

  test('pendulum graph: the model line reaches x = 0 where its intercept is read; mean time to 2 d.p.', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    var q = modelQuestion('PEN-AB12-CD34', 'graph');
    assert.equal(q.graph.x.origin, 0);
    assert.equal(q.graph.intercept.method, 'direct');
    assert.close(Math.min(q.graph.line.a.gx, q.graph.line.b.gx), 0, 1e-6, 'line drawn down to x = 0');
    assert.equal(mark(q).total, 20);
    var ma = exp().modelAnswer(paramsFor('PEN-AB12-CD34', 'graph'), 'graph', VL.rng.create('PEN-AB12-CD34').fork('model'));
    assert.match(ma.answers.T_working, /Mean time = \d+\.\d\d s,/, ma.answers.T_working);
  });

  test('pendulum: bank fixes — no credit for fewer oscillations, normal side-to-side swing or clamping the stand', function () {
    if (!VL.textmatch) return;
    var bank = exp().bank;
    function credited(text, side) {
      var r = VL.textmatch.markLimitationsImprovements(side === 'lim' ? [text] : [], side === 'imp' ? [text] : [], bank, { maxEach: 4 });
      var col = side === 'lim' ? r.limitations : r.improvements;
      return col.hits.length ? col.hits[0].id : null;
    }
    assert.equal(credited('Time fewer oscillations.', 'imp'), null, 'wrong physics: raises the % reaction-time uncertainty');
    assert.equal(credited('Use a denser bob', 'imp'), 'G');
    assert.equal(bank.filter(function (r) { return r.id === 'G'; })[0].improvement.label, 'Use a denser or smaller bob to reduce air resistance');
    assert.equal(credited('The point of suspension is not clearly defined.', 'lim'), 'F');
    assert.equal(credited('The pivot is not well defined.', 'lim'), 'F');
    assert.equal(credited('Timings are short so the percentage uncertainty is large.', 'lim'), 'B');
    assert.equal(credited('The bob swings from side to side.', 'lim'), null, 'the normal swing');
    assert.equal(credited('The bob moves from side to side as well as backwards and forwards', 'lim'), 'E');
    assert.equal(credited('Clamp the stand firmly to the bench.', 'imp'), null, 'a wobbling stand is not the string slipping');
    assert.equal(credited('Clamp the cork more tightly', 'imp'), 'F');
    assert.equal(credited('Clamp the string firmly in the cork so the stand does not matter', 'imp'), 'F', 'cork mentioned');
    var q = modelQuestion('PEN-AAAA-BBBB', 'twopoint');
    assert.equal(mark(q).total, 20, 'Q2 model answer');
  });

  test('pendulum: practice hints and model notes explain the inverted protractor (angle = difference from 90°)', function () {
    var h = exp().hints;
    assert.match(h.graph.c, /difference from 90° \(a reading of 82° or 98° means 8°\)/);
    assert.match(h.twopoint['c-ii'], /hangs upside down with its centre at the cork/);
    var notes = exp().modelAnswer(paramsFor('PEN-AAAA-BBBB', 'graph'), 'graph', VL.rng.create('PEN-AAAA-BBBB').fork('model')).notes;
    assert.ok(notes.some(function (n) { return /about 5° from the vertical \(a protractor reading of about 85° or 95°\)/.test(n); }));
    if (VL.instruments && VL.instruments.create) {
      assert.match(VL.instruments.create('protractor', {}, null).describe(), /Protractor fixed below a pivot \(pendulum\)/);
    }
  });

  test('pendulum twopoint: the model s.f. justification states the real s.f. of d (4 s.f. with the 0.02 mm vernier)', function () {
    if (!canMark()) return;
    VL.noise.level = 1;
    function model(seed) { return exp().modelAnswer(paramsFor(seed, 'twopoint'), 'twopoint', VL.rng.create(seed).fork('model')); }
    var fineSeed = 'PEN-0000-1111';
    assert.equal(paramsFor(fineSeed, 'twopoint').vernierRes, 0.02);
    var coarseSeed = null;
    for (var i = 0; i < 40 && !coarseSeed; i++) if (paramsFor('PEN-SFSF-' + i, 'twopoint').vernierRes === 0.1) coarseSeed = 'PEN-SFSF-' + i;
    [[fineSeed, 4], [coarseSeed, 3]].forEach(function (c) {
      var ma = model(c[0]);
      assert.equal(VL.sigfig.sf(ma.answers.d.split(' ')[0]), c[1], c[0] + ' d = ' + ma.answers.d);
      assert.match(ma.answers.sfJust, new RegExp('d to ' + c[1] + ' s\\.f\\.'), ma.answers.sfJust);
      assert.match(ma.answers.sfJust, /L was measured to 3 s\.f\..*so k is given to 3 s\.f\./);
      var noteE = ma.notes.filter(function (n) { return /^\(e\)/.test(n); })[0];
      assert.match(noteE, new RegExp('d to ' + c[1] + ' s\\.f\\.'), noteE);
      assert.ok(!/L and d have 3 s\.f\./.test(noteE));
      assert.equal(mark(modelQuestion(c[0], 'twopoint')).total, 20, c[0] + ' twopoint model answer');
      assert.equal(mark(modelQuestion(c[0], 'graph')).total, 20, c[0] + ' graph model answer');
    });
  });

  /* ------------------------------------------------------------------ apparatus controller (no DOM) */

  /** Fake services with a controllable clock and a log. */
  function rig(seed, patch) {
    var clock = { t: 1000 };
    var logs = [];
    var toasts = [];
    var params = Object.assign(paramsFor(seed, 'graph'), patch || {});
    var services = {
      mode: 'practice', hints: false,
      log: function (e) { logs.push(e); return e; },
      now: function () { return clock.t; },
      stopwatch: null, requestRedraw: function () {}, focusWorld: function () {}, toast: function (m) { toasts.push(m); }
    };
    var c = exp().createApparatus({ params: params, variantId: 'graph', rng: VL.rng.create(seed).fork('noise'), services: services, savedState: null });
    return { c: c, clock: clock, logs: logs, params: params, services: services, toasts: toasts };
  }

  /** A stub CanvasRenderingContext2D that accepts every call. */
  function stubContext() {
    var noop = function () {};
    var grad = { addColorStop: noop };
    var target = {
      canvas: { width: 800, height: 600 },
      getTransform: function () { return { inverse: function () { return { a: 0.2, b: 0, c: 0, d: 0.2, e: 0, f: 0 }; } }; },
      createLinearGradient: function () { return grad; },
      createRadialGradient: function () { return grad; },
      measureText: function () { return { width: 10 }; }
    };
    return new Proxy(target, {
      get: function (t, k) { return k in t ? t[k] : noop; },
      set: function (t, k, v) { t[k] = v; return true; }
    });
  }

  function bobRest(r) { var s = r.c.snapshot(); return { x: 52, y: 10 + s.L + r.params.d / 2 }; }
  function pointAtAngle(r, deg) {
    var s = r.c.snapshot(), th = deg * Math.PI / 180, Le = s.Leff;
    return { x: 52 + Le * Math.sin(th), y: 10 - r.params.delta + Le * Math.cos(th) };
  }

  test('pendulum apparatus: controller shape, setup log and snapshot fields (no DOM needed)', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0001');
    var c = r.c;
    assert.deepEqual(c.world, { width: 110, height: 130 });
    assert.ok(c.uses.indexOf('stopwatch') >= 0);
    ['draw', 'update', 'controls', 'snapshot', 'onStopwatchEvent', 'getState', 'setState', 'destroy'].forEach(function (k) {
      assert.equal(typeof c[k], 'function', k);
    });
    assert.equal(c.zoomTargets.length, 4);
    var setup = r.logs.filter(function (e) { return e.type === 'setup'; })[0];
    assert.ok(setup && setup.vernierZeroErrorMm === r.params.vernierZero, 'zero error logged for the marker');
    var s = c.snapshot();
    ['L', 'd', 'delta', 'Leff', 'T', 'amplitudeDeg', 'swinging', 'ruleOffset', 'vernierOpening', 'vernierZeroError', 'eyeAngle']
      .forEach(function (k) { assert.ok(k in s, 'snapshot has ' + k); });
    assert.close(s.L, r.params.L0, 1e-9);
    assert.close(s.T, exp().model.period(s.L, r.params.d, r.params.delta, 0), 1e-4);
    assert.equal(s.swinging, false);
    var bobTarget = c.zoomTargets.filter(function (t) { return t.id === 'bob'; })[0];
    assert.close(bobTarget.y, 10 + s.L, 1e-9, 'zoom target follows the bob');
  });

  test('pendulum apparatus: drag and release swings the bob; stopwatch truth counts the oscillations', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0002', { slipChance: 0 });
    var c = r.c;
    assert.ok(c.pointer.down(bobRest(r)), 'bob grabbed');
    c.pointer.move(pointAtAngle(r, -8));
    var held = c.snapshot();
    assert.close(held.amplitudeDeg, 8, 0.05, 'held at 8°');
    assert.equal(held.swinging, false);
    c.pointer.up(pointAtAngle(r, -8));
    var s = c.snapshot();
    assert.equal(s.swinging, true);
    var rel = r.logs.filter(function (e) { return e.type === 'release'; })[0];
    assert.close(rel.amplitudeDeg, 8, 0.05);
    r.clock.t += 3000;
    var T = c.snapshot().T;
    var start = c.onStopwatchEvent('start', { nowMs: r.clock.t, elapsed: 0 });
    assert.equal(start.swinging, true);
    var dur = 20 * T;
    r.clock.t += dur * 1000;
    c.update(0.016, r.clock.t);
    var stop = c.onStopwatchEvent('stop', { nowMs: r.clock.t, elapsed: dur });
    assert.close(stop.elapsedTrue, dur, 1e-3);
    assert.close(stop.oscillationsTrue, dur / stop.T, 0.05, 'oscillations ≈ elapsed / T');
    assert.close(stop.oscillationsTrue, 20, 0.1);
    assert.close(stop.L, s.L, 1e-9);
    assert.ok(stop.amplitudeDeg < 8 && stop.amplitudeDeg > 4, 'amplitude decays (damping)');
    assert.equal(c.onStopwatchEvent('reset', { nowMs: r.clock.t, elapsed: 0 }), null);
    c.actions.stopBob();
    assert.equal(c.snapshot().swinging, false);
  });

  test('pendulum apparatus: length steps and limits (10.0–100.0 cm), amplitude ≤ 30°', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0003', { slipChance: 0 });
    var c = r.c;
    var L0 = c.snapshot().L;
    VL.noise.level = 0;
    c.actions.lengthen();
    assert.close(c.snapshot().L, L0 + 0.5, 1e-9, 'coarse step 0.5 cm');
    c.actions.shorten(0.1);
    assert.close(c.snapshot().L, L0 + 0.4, 1e-9, 'fine step 1 mm');
    for (var i = 0; i < 300; i++) c.actions.shorten();
    assert.close(c.snapshot().L, 10, 1e-9, 'shortest 10.0 cm');
    assert.equal(c.actions.shorten(), false);
    for (var j = 0; j < 400; j++) c.actions.lengthen();
    assert.close(c.snapshot().L, 100, 1e-9, 'longest 100.0 cm');
    c.actions.holdAt(-45);
    assert.close(c.snapshot().amplitudeDeg, 30, 1e-6, 'amplitude limited to 30°');
    c.actions.release();
    c.actions.lengthen(0.1);
    assert.equal(c.snapshot().swinging, false, 'adjusting the string stops the bob');
    r.clock.t += 2000;
    c.update(0.016, r.clock.t);
    assert.ok(r.logs.some(function (e) { return e.type === 'length-set' && Math.abs(e.L - 100) < 1e-6; }), 'settled length logged');
  });

  test('pendulum apparatus: string slip anomaly on the first release after a length change', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    VL.noise.level = 1;
    var r = rig('PEN-TEST-0004', { slipChance: 1 });
    var c = r.c;
    c.actions.holdAt(-6);
    c.actions.release();
    assert.ok(!r.logs.some(function (e) { return e.type === 'anomaly'; }), 'no slip without a length change');
    c.actions.lengthen();
    var before = c.snapshot().L;
    c.actions.holdAt(-6);
    c.actions.release();
    var an = r.logs.filter(function (e) { return e.type === 'anomaly'; });
    assert.equal(an.length, 1);
    assert.equal(an[0].kind, 'slip');
    assert.ok(an[0].amount >= 0.3 && an[0].amount <= 0.8, 'slip 0.3–0.8 cm');
    assert.close(c.snapshot().L, before + an[0].amount, 1e-6);
    c.actions.holdAt(-6);
    c.actions.release();
    assert.equal(r.logs.filter(function (e) { return e.type === 'anomaly'; }).length, 1, 'only on the first release');
    VL.noise.level = 0;
    var q = rig('PEN-TEST-0004', { slipChance: 1 });
    q.c.actions.lengthen();
    q.c.actions.holdAt(-6);
    q.c.actions.release();
    assert.ok(!q.logs.some(function (e) { return e.type === 'anomaly'; }), 'no anomalies at noise level 0');
  });

  test('pendulum apparatus: vernier jaw stops at contact; closing the jaws shows the zero error', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0005', { vernierZero: 0.2, vernierRes: 0.1 });
    var c = r.c;
    c.actions.setVernierOpening(5);
    var s = c.snapshot();
    assert.close(s.vernierOpening, r.params.d * 10, 0.0101, 'stops at the bob (± 0.01 mm squeeze)');
    assert.close(s.vernierReading, s.vernierOpening + 0.2, 1e-6, 'reading includes the zero error');
    c.actions.closeJawsZero();
    s = c.snapshot();
    assert.equal(s.vernierOpening, 0);
    assert.close(s.vernierReading, 0.2, 1e-9);
    assert.ok(r.logs.some(function (e) { return e.type === 'zero-check'; }));
    c.actions.gripBob();
    assert.close(c.snapshot().vernierOpening, r.params.d * 10, 0.0101);
    c.actions.openJaws();
    assert.equal(c.snapshot().vernierOpening, 40);
  });

  test('pendulum apparatus: the metre rule can be dragged; parallax shifts what is seen against the scale', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0006');
    var c = r.c;
    c.draw(stubContext(), { scale: 5, eyeAngle: 6, now: r.clock.t });
    assert.ok(c.pointer.down({ x: 62.4, y: 50 }), 'rule grabbed');
    c.pointer.move({ x: 54.9, y: 45 });
    c.pointer.up({ x: 54.9, y: 45 });
    var s = c.snapshot();
    assert.close(s.ruleGapX, 61 - 7.5 - 52, 1e-6);
    assert.close(s.ruleOffset, r.params.ruleStartY - 5 - 10, 1e-6);
    assert.close(s.eyeAngle, 6, 1e-9);
    assert.close(s.ruleReadings.bobTop - s.ruleReadings.cork, s.L, 1e-6, 'true readings differ by L');
    assert.close(s.ruleReadings.corkSeen - s.ruleReadings.cork, 1.5 * Math.tan(6 * Math.PI / 180), 1e-3, 'parallax shift');
    assert.ok(!c.pointer.down({ x: 5, y: 60 }), 'empty space is left for panning');
  });

  test('pendulum apparatus: the eye is a height (view.eyeY in the snapshot); hints describe re-levelling at each end', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0007');
    var c = r.c;
    assert.equal(c.snapshot().eyeY, null, 'no eye height before the view has drawn');
    c.draw(stubContext(), { scale: 5, eyeAngle: 5, eyeY: 20, eyeDist: 40, now: r.clock.t });
    var s = c.snapshot();
    assert.equal(s.eyeY, 20);
    assert.close(s.eyeAngle, 5, 1e-9);
    assert.close(s.ruleReadings.corkSeen - s.ruleReadings.cork, VL.noise.parallaxShift(1.5, 5), 1e-3);
    c.draw(stubContext(), { scale: 5, eyeAngle: 0, now: r.clock.t });
    assert.equal(c.snapshot().eyeY, 20, 'a view without eyeY keeps the last eye height');
    // the vertical rule's edge face is not a level-eye cue at the bob: no text may rely on it
    var texts = [];
    ['graph', 'twopoint'].forEach(function (v) {
      var h = exp().hints[v];
      Object.keys(h).forEach(function (k) { texts.push(h[k]); });
      texts = texts.concat(exp().commonMistakes(v));
      var ma = exp().modelAnswer(paramsFor('PEN-AAAA-BBBB', v), v, VL.rng.create('PEN-AAAA-BBBB').fork('model'));
      texts = texts.concat(ma.notes);
    });
    texts.forEach(function (t) {
      assert.ok(!/edge of the rule|keep (your|the) eye level/i.test(t), 'stale parallax advice: ' + t);
    });
    assert.match(exp().hints.graph.b, /re-level it at each end/);
    assert.match(exp().hints.twopoint['c-i'], /level with the top of the bob/);
  });

  test('pendulum apparatus: the view may zoom far enough to read the 0.02 mm vernier (maxPxPerCm)', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var c = rig('PEN-0000-1111').c;
    assert.ok(c.maxPxPerCm >= 750, 'maxPxPerCm ' + c.maxPxPerCm);
    assert.ok(0.002 * c.maxPxPerCm >= 1.5, '0.02 mm is at least 1.5 css px at the maximum zoom');
  });

  test('pendulum apparatus: the rule starts with its zero 1–3 cm above the cork, in view of the "Cork and rule" target', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    // ruleStartY is the LAST parameter drawn, so every other parameter of a seed is unchanged
    var p = paramsFor('PEN-AAAA-BBBB', 'graph');
    assert.deepEqual([p.d, p.delta, p.tau, p.vernierRes, p.vernierZero, p.eyeStart, p.L0], [2.454, 0.157, 111.7, 0.1, 0, 6.88, 49.64]);
    ['PEN-AAAA-BBBB', 'PEN-7K2Q-91C3', 'PEN-0000-1111'].forEach(function (seed) {
      var r = rig(seed);
      assert.ok(r.params.ruleStartY >= 7 && r.params.ruleStartY <= 9, seed + ' ruleStartY ' + r.params.ruleStartY);
      var cork = r.c.snapshot().ruleReadings.cork;     // the scale reads downwards from the zero, which is above the cork
      assert.ok(cork >= 1 && cork <= 3, seed + ': the cork is at ' + cork + ' cm on the rule');
      r.c.actions.ruleNextToString();
      var t = r.c.zoomTargets.filter(function (z) { return z.id === 'cork'; })[0];
      var halfH = r.c.world.height / t.zoom / 2;          // at least this much of the world is visible above and below
      assert.ok(Math.abs(r.params.ruleStartY - t.y) + 0.5 <= halfH, seed + ': rule zero in view at the cork target');
      assert.ok(Math.abs(10 - t.y) + 0.5 <= halfH, seed + ': cork in view');
    });
    var old = rig('PEN-AAAA-BBBB', { ruleStartY: undefined });
    assert.close(old.c.snapshot().ruleReadings.cork, 2, 1e-9, 'sessions from before ruleStartY: zero 2 cm above the cork');
  });

  test('pendulum apparatus: getState / setState round trip (resume)', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0007', { slipChance: 0 });
    var c = r.c;
    c.actions.lengthen();
    c.actions.moveRule(-3, -2);
    c.actions.setVernierOpening(30);
    c.actions.setFiducial(true);
    c.actions.holdAt(-10);
    c.actions.release();
    r.clock.t += 1500;
    var st = JSON.parse(JSON.stringify(c.getState()));
    var r2 = rig('PEN-TEST-0007', { slipChance: 0 });
    r2.clock.t = 99999;
    r2.c.setState(st);
    var a = c.snapshot(), b = r2.c.snapshot();
    assert.close(b.L, a.L, 1e-3);
    assert.close(b.ruleOffset, a.ruleOffset, 1e-6);
    assert.close(b.ruleGapX, a.ruleGapX, 1e-6);
    assert.close(b.vernierOpening, a.vernierOpening, 1e-3);
    assert.equal(b.swinging, true);
    assert.close(b.amplitudeDeg, a.amplitudeDeg, 0.01);
    assert.equal(b.fiducial, true);
    var r3 = rig('PEN-TEST-0007');
    r3.c.setState({ L: 500, rule: { x: -100, y: 400 }, vernier: { opening: -3, bobIn: false } });
    var s3 = r3.c.snapshot();
    assert.ok(s3.L <= 101.5 && s3.ruleOffset <= 7 && s3.vernierOpening === 0, 'clamped on restore');
  });

  test('pendulum apparatus: the stopwatch oscillation count survives getState / setState', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0008', { slipChance: 0 });
    var c = r.c;
    c.actions.holdAt(-4);
    c.actions.release();
    var T = c.snapshot().T;
    c.onStopwatchEvent('start', { nowMs: r.clock.t, elapsed: 0 });
    r.clock.t += 20 * T * 1000;
    var stop1 = c.onStopwatchEvent('stop', { nowMs: r.clock.t, elapsed: 20 * T });
    assert.close(stop1.oscillationsTrue, 20, 0.05);
    var st = JSON.parse(JSON.stringify(c.getState()));
    assert.close(st.sw.osc, stop1.oscillationsTrue, 1e-3, 'sw.osc in the state');
    var r2 = rig('PEN-TEST-0008', { slipChance: 0 });
    r2.clock.t = r.clock.t;
    r2.c.setState(st);
    r2.c.setState(st);                                 // idempotent (the view calls it twice)
    r2.c.onStopwatchEvent('start', { nowMs: r2.clock.t, elapsed: 20 * T });
    r2.clock.t += 5 * r2.c.snapshot().T * 1000;
    var stop2 = r2.c.onStopwatchEvent('stop', { nowMs: r2.clock.t, elapsed: 25 * T });
    assert.close(stop2.oscillationsTrue, 25, 0.1, 'cumulative count continues after the reload');
    r2.c.onStopwatchEvent('reset', {});
    assert.equal(r2.c.getState().sw.osc, 0, 'reset clears it');
  });

  test('pendulum apparatus: isAnimating() is true only while something moves on its own', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0009', { slipChance: 0 });
    var c = r.c;
    assert.equal(c.isAnimating(), false, 'at rest after creation');
    c.actions.holdAt(-6);
    assert.equal(c.isAnimating(), true, 'held aside');
    c.actions.release();
    assert.equal(c.isAnimating(), true, 'swinging');
    r.clock.t += 3000;
    c.update(0.1, r.clock.t);
    assert.equal(c.isAnimating(), true, 'still swinging');
    c.actions.stopBob();
    assert.equal(c.isAnimating(), false, 'after "Stop the bob"');
    c.actions.lengthen();
    assert.equal(c.isAnimating(), true, 'a length change waits to settle (and be logged)');
    r.clock.t += 1300;
    c.update(0.1, r.clock.t);
    assert.equal(c.isAnimating(), false, 'settled');
    c.actions.moveRule(1, 0);
    c.actions.setFiducial(true);
    assert.equal(c.isAnimating(), false, 'instant changes only need a redraw');
    assert.ok(c.pointer.down({ x: 52, y: 10 + c.snapshot().L + r.params.d / 2 }), 'bob grabbed');
    assert.equal(c.isAnimating(), true, 'dragging');
    c.pointer.up({ x: 52, y: 60 });
    assert.equal(c.isAnimating(), false, 'released at rest');
  });

  test('pendulum apparatus: draw() runs on a stub 2D context in every state', function () {
    if (!VL.instruments || !VL.instruments.create) return;
    var r = rig('PEN-TEST-0008');
    var c = r.c, g = stubContext();
    c.draw(g, { scale: 4.4, eyeAngle: -5, now: r.clock.t });
    c.actions.setFiducial(true);
    c.actions.holdAt(12);
    c.actions.release();
    for (var i = 0; i < 5; i++) { r.clock.t += 137; c.update(0.137, r.clock.t); c.draw(g, { scale: 60, eyeAngle: 0, now: r.clock.t }); }
    c.actions.closeJawsZero();
    c.draw(g, { scale: 200, eyeAngle: 3 });
    assert.ok(true);
  });
})();
