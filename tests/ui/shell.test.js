/**
 * Tests for the pure parts of the application shell: routing, seeds, exam question choice, sessions, timer maths,
 * shortcut resolution, apparatus view maths, tools computations and report summaries.
 * Needs ui/dom.js, ui/timer.js, ui/shortcuts.js, ui/apparatusView.js, ui/paperView.js, ui/uncertaintyView.js,
 * ui/reportView.js and ui/app.js in the manifest sources (none of them touches the DOM at load time).
 */
(function () {
  'use strict';
  var VL = globalThis.VLab || {};
  var UI = VL.ui || {};

  function fakeExp(id, prefix, variants) {
    return {
      id: id, title: id.charAt(0).toUpperCase() + id.slice(1), seedPrefix: prefix,
      variants: variants.map(function (v) { return { id: v[0], style: v[1], title: v[0] }; })
    };
  }

  /* ------------------------------------------------------------------ app helpers */
  if (UI.app && VL.rng) {
    var A = UI.app;

    test('app: parseRoute', function () {
      assert.deepEqual(A.parseRoute(''), { name: 'home', query: {} });
      assert.deepEqual(A.parseRoute('#/'), { name: 'home', query: {} });
      assert.equal(A.parseRoute('#/practice').name, 'practice');
      assert.equal(A.parseRoute('#/exam').name, 'exam');
      assert.equal(A.parseRoute('#/drills').name, 'drills');
      assert.equal(A.parseRoute('#/progress').name, 'progress');
      assert.equal(A.parseRoute('#/instruments').name, 'instruments');
      assert.equal(A.parseRoute('#/sessions').name, 'sessions');
      var s = A.parseRoute('#/s/abc%2D1');
      assert.equal(s.name, 'session');
      assert.equal(s.id, 'abc-1');
      var p = A.parseRoute('#/practice?exp=pendulum&variant=graph');
      assert.equal(p.name, 'practice');
      assert.deepEqual(p.query, { exp: 'pendulum', variant: 'graph' });
      assert.equal(A.parseRoute('#/nowhere').name, 'notfound');
      assert.equal(A.parseRoute('#/s').name, 'notfound');
    });

    test('app: deriveSeed gives valid, deterministic seeds', function () {
      var a = A.deriveSeed(VL.rng.create('X'), 'PEN');
      var b = A.deriveSeed(VL.rng.create('X'), 'PEN');
      assert.equal(a, b);
      assert.ok(VL.rng.isValidSeed(a), a + ' is valid');
      assert.match(a, /^PEN-/);
      assert.match(A.deriveSeed(VL.rng.create('Y'), 'p'), /^PLA-|^P[A-Z]{1,3}-/);
      assert.ok(VL.rng.isValidSeed(A.deriveSeed(VL.rng.create('Y'), 'p')));
    });

    test('app: exam with only the pendulum = pendulum graph (Q1) + pendulum twopoint (Q2)', function () {
      var pen = fakeExp('pendulum', 'PEN', [['graph', 'Q1'], ['twopoint', 'Q2']]);
      var qs = A.chooseExamQuestions([pen], 'EXM-AAAA-BBBB');
      assert.equal(qs.length, 2);
      assert.equal(qs[0].expId, 'pendulum'); assert.equal(qs[0].variantId, 'graph');
      assert.equal(qs[1].expId, 'pendulum'); assert.equal(qs[1].variantId, 'twopoint');
      assert.ok(VL.rng.isValidSeed(qs[0].seed) && VL.rng.isValidSeed(qs[1].seed));
      assert.match(qs[0].seed, /^PEN-/);
      assert.ok(qs[0].seed !== qs[1].seed, 'different question seeds');
      assert.deepEqual(A.chooseExamQuestions([pen], 'EXM-AAAA-BBBB'), qs, 'deterministic for a seed');
    });

    test('app: exam prefers two different experiments', function () {
      var exps = [
        fakeExp('pendulum', 'PEN', [['graph', 'Q1'], ['twopoint', 'Q2']]),
        fakeExp('lens', 'LEN', [['graph', 'Q1']]),
        fakeExp('wire', 'WIR', [['graph', 'Q1'], ['compare', 'Q2']])
      ];
      for (var i = 0; i < 40; i++) {
        var qs = A.chooseExamQuestions(exps, 'EXM-' + 'ABCDEFGHJK'.charAt(i % 10) + '000-' + String(1000 + i));
        assert.equal(qs.length, 2);
        assert.ok(qs[0].expId !== qs[1].expId, 'different experiments (' + qs[0].expId + ', ' + qs[1].expId + ')');
        assert.equal(qs[0].style, 'Q1');
        assert.equal(qs[1].style, 'Q2');
      }
    });

    test('app: exam with one style only still gives questions', function () {
      var exps = [fakeExp('a', 'AAA', [['g', 'Q1']]), fakeExp('b', 'BBB', [['g', 'Q1']])];
      var qs = A.chooseExamQuestions(exps, 'EXM-1111-2222');
      assert.equal(qs.length, 2);
      assert.ok(qs[0].expId !== qs[1].expId);
      assert.equal(A.chooseExamQuestions([fakeExp('a', 'AAA', [['g', 'Q1']])], 'EXM-1111-2222').length, 1);
      assert.equal(A.chooseExamQuestions([], 'EXM-1111-2222').length, 0);
    });

    test('app: practice and exam sessions follow the session data model', function () {
      var pen = fakeExp('pendulum', 'PEN', [['graph', 'Q1'], ['twopoint', 'Q2']]);
      var s = A.createPracticeSession({ exp: pen, variantId: 'graph', seed: 'PEN-7K2Q-91C3', hints: true, nowIso: '2026-01-02T03:04:05.000Z' });
      assert.equal(s.mode, 'practice');
      assert.equal(s.finished, false);
      assert.equal(s.questions.length, 1);
      var q = s.questions[0];
      assert.equal(q.qid, 'q1'); assert.equal(q.expId, 'pendulum'); assert.equal(q.variantId, 'graph');
      assert.equal(q.seed, 'PEN-7K2Q-91C3');
      assert.equal(q.submitted, false); assert.equal(q.report, null);
      assert.deepEqual(q.answers, {}); assert.deepEqual(q.log, []);
      assert.equal(q.startedAt, '2026-01-02T03:04:05.000Z');
      if (VL.datatable) assert.ok(Array.isArray(q.table.columns) && q.table.columns.length > 0, 'empty table');
      var e = A.createExamSession({ experiments: [pen], seed: 'EXM-AAAA-BBBB', minutes: 120 });
      assert.equal(e.mode, 'exam');
      assert.equal(e.examMinutes, 120);
      assert.equal(e.elapsedMs, 0);
      assert.equal(e.questions.length, 2);
      assert.equal(e.questions[1].qid, 'q2');
      assert.ok(e.id !== s.id, 'unique ids');
    });

    test('app: progress entry', function () {
      var s = { id: 's1', mode: 'practice' };
      var q = { expId: 'pendulum', variantId: 'graph', seed: 'PEN-7K2Q-91C3' };
      var r = { total: 14, max: 20, markedAt: '2026-01-01T00:00:00.000Z', skills: { MMO: { got: 6, max: 8 }, PDO: { got: 5, max: 7 }, ACE: { got: 3, max: 5 } } };
      var p = A.progressEntry(s, q, r);
      assert.deepEqual(p, { sessionId: 's1', date: '2026-01-01T00:00:00.000Z', mode: 'practice', expId: 'pendulum', variantId: 'graph',
        seed: 'PEN-7K2Q-91C3', total: 14, max: 20, skills: { MMO: { got: 6, max: 8 }, PDO: { got: 5, max: 7 }, ACE: { got: 3, max: 5 } } });
      // with the question index (stored so that progress for one question of a session is recorded once)
      assert.equal(A.progressEntry(s, q, r, 1).qIndex, 1);
      assert.ok(!('qIndex' in p), 'no qIndex unless given');
    });

    test('app: hintsFor handles maps, per-variant maps and functions', function () {
      assert.deepEqual(A.hintsFor({ hints: { a: 'x' } }, 'graph'), { a: 'x' });
      assert.deepEqual(A.hintsFor({ hints: { graph: { a: 'y' }, twopoint: { a: 'z' } } }, 'graph'), { a: 'y' });
      assert.deepEqual(A.hintsFor({ hints: function (v) { return { a: v }; } }, 'twopoint'), { a: 'twopoint' });
      assert.equal(A.hintsFor({}, 'graph'), null);
    });
  } else {
    test('app helpers: skipped (ui/app.js or core/rng.js not loaded)', function () { assert.ok(true); });
  }

  /* ------------------------------------------------------------------ timer */
  if (UI.timer) {
    test('timer: format and describe', function () {
      assert.equal(UI.timer.format(2 * 3600000), '2:00:00');
      assert.equal(UI.timer.format(75 * 60000), '1:15:00');
      assert.equal(UI.timer.format(59 * 60000 + 59000), '59:59');
      assert.equal(UI.timer.format(500), '0:01', 'rounds up so 0:00 means time is up');
      assert.equal(UI.timer.format(0), '0:00');
      assert.equal(UI.timer.format(-10), '0:00');
      assert.equal(UI.timer.describe(15 * 60000), '15 minutes');
      assert.equal(UI.timer.describe(3600000 + 60000), '1 hour 1 minute');
      assert.equal(UI.timer.describe(30000), '30 seconds');
    });
    test('timer: warnings fire once when 15 and 5 minutes are crossed', function () {
      var c = UI.timer.crossed;
      assert.deepEqual(c(15 * 60000 + 100, 15 * 60000 - 100, [15, 5]), [15]);
      assert.deepEqual(c(15 * 60000 - 100, 15 * 60000 - 400, [15, 5]), []);
      assert.deepEqual(c(5 * 60000 + 1, 5 * 60000, [15, 5]), [5]);
      assert.deepEqual(c(20 * 60000, 4 * 60000, [15, 5]), [15, 5], 'a long jump crosses both');
    });
  }

  /* ------------------------------------------------------------------ shortcuts */
  if (UI.shortcuts) {
    test('shortcuts: key resolution', function () {
      var r = UI.shortcuts.resolve;
      assert.equal(r({ key: ' ' }), 'stopwatchToggle');
      assert.equal(r({ key: ' ' }, { focusVisibleControl: true }), null, 'Space keeps its meaning on a keyboard-focused button');
      assert.equal(r({ key: 'x' }), 'stopwatchReset');
      assert.equal(r({ key: 'R' }), 'record');
      assert.equal(r({ key: 'r' }, { typing: true }), null, 'ignored while typing');
      assert.equal(r({ key: 'z', ctrlKey: true }), 'undo');
      assert.equal(r({ key: 'Z', metaKey: true, shiftKey: true }), 'redo');
      assert.equal(r({ key: 'y', ctrlKey: true }), 'redo');
      assert.equal(r({ key: 'z', ctrlKey: true }, { typing: true }), null, 'native undo inside text boxes');
      assert.equal(r({ key: '+' }), 'zoomIn');
      assert.equal(r({ key: '=' }), 'zoomIn');
      assert.equal(r({ key: '-' }), 'zoomOut');
      assert.equal(r({ key: '0' }), 'zoomReset');
      assert.equal(r({ key: '[' }), 'eyeLower');
      assert.equal(r({ key: ']' }), 'eyeHigher');
      assert.equal(r({ key: '?' }), 'help');
      assert.equal(r({ key: '1', code: 'Digit1', altKey: true }), 'tab:0');
      assert.equal(r({ key: '¡', code: 'Digit1', altKey: true }), 'tab:0', 'Mac Option+1');
      assert.equal(r({ key: '5', code: 'Digit5', altKey: true }, { typing: true }), 'tab:4', 'Alt+n works while typing');
      assert.equal(r({ key: '6', code: 'Digit6', altKey: true }), null);
      assert.equal(r({ key: 'a' }), null);
    });
  }

  /* ------------------------------------------------------------------ apparatus view maths */
  if (UI.apparatusView && UI.apparatusView.viewMath) {
    var M = UI.apparatusView.viewMath;
    test('apparatusView: fit, round trip and zoom about a point', function () {
      var world = { width: 110, height: 130 };
      var fit = M.fitScale(world, 600, 650);
      assert.close(fit, 0.96 * Math.min(600 / 110, 650 / 130), 1e-12);
      var view = { cx: 55, cy: 65, z: 1 };
      var s = M.toScreen(view, fit, 600, 650, 55, 65);
      assert.close(s.x, 300, 1e-9); assert.close(s.y, 325, 1e-9);
      var w = M.toWorld(view, fit, 600, 650, 123, 456);
      var back = M.toScreen(view, fit, 600, 650, w.x, w.y);
      assert.close(back.x, 123, 1e-9); assert.close(back.y, 456, 1e-9);
      var before = M.toWorld(view, fit, 600, 650, 100, 200);
      var v2 = M.zoomAbout(view, fit, 600, 650, 100, 200, 3);
      var after = M.toWorld(v2, fit, 600, 650, 100, 200);
      assert.close(after.x, before.x, 1e-9, 'the point under the cursor stays put');
      assert.close(after.y, before.y, 1e-9);
      assert.close(v2.z, 3, 1e-12);
    });
    test('apparatusView: zoom limited to ×0.5 … ×40 and the view stays on the apparatus', function () {
      var v = M.zoomAbout({ cx: 10, cy: 10, z: 30 }, 5, 400, 400, 200, 200, 10);
      assert.equal(v.z, 40);
      v = M.zoomAbout({ cx: 10, cy: 10, z: 1 }, 5, 400, 400, 200, 200, 0.01);
      assert.equal(v.z, 0.5);
      var c = M.clampView({ cx: -50, cy: 500, z: 100 }, { width: 110, height: 130 });
      assert.deepEqual(c, { cx: 0, cy: 130, z: 40 });
    });
    test('apparatusView: initial eye angle', function () {
      assert.equal(UI.apparatusView.initialEye({ eyeStart: -7.5 }, 'PEN-AAAA-BBBB'), -7.5);
      if (VL.rng) {
        var a = UI.apparatusView.initialEye({}, 'PEN-AAAA-BBBB');
        assert.equal(a, UI.apparatusView.initialEye({}, 'PEN-AAAA-BBBB'), 'seeded');
        assert.ok(a >= -6 && a <= 6, 'within ±6°');
      }
    });
    test('apparatusView: maximum zoom follows controller.maxPxPerCm', function () {
      assert.equal(M.maxZoom(undefined, 3), 40, 'no request: ×40');
      assert.equal(M.maxZoom(-5, 3), 40, 'nonsense ignored');
      assert.equal(M.maxZoom(60, 3), 40, 'never below ×40');
      assert.close(M.maxZoom(800, 3.013), 800 / 3.013, 1e-9, '800 px per cm at the stage fit');
      var v = M.zoomAbout({ cx: 10, cy: 10, z: 200 }, 4, 400, 400, 200, 200, 10, 250);
      assert.equal(v.z, 250, 'zoomAbout clamps to the zMax given');
      assert.equal(M.clampView({ cx: 1, cy: 1, z: 900 }, { width: 110, height: 130 }, 300).z, 300, 'clampView too');
      assert.equal(M.clampView({ cx: 1, cy: 1, z: 900 }, { width: 110, height: 130 }).z, 40, 'default ×40');
    });
  }
  if (UI.apparatusView && UI.apparatusView.eyeMath) {
    var E = UI.apparatusView.eyeMath;
    test('apparatusView: the eye is a height; the angle depends on the point looked at', function () {
      assert.close(E.angleAt(20, 20, 40), 0, 1e-12, 'level');
      assert.close(E.angleAt(20, 60, 40), 45, 1e-9, 'a point 40 cm below an eye 40 cm away: 45° (eye above)');
      assert.ok(E.angleAt(20, 10, 40) < 0, 'eye below a point above it');
      var y = E.eyeYFor(75, 6, 40);
      assert.close(E.angleAt(y, 75, 40), 6, 1e-9, 'eyeYFor inverts angleAt');
      // the cork (y 12) and the bob (y 67), 55 cm apart, are seen at very different angles from one eye position
      var eyeY = E.eyeYFor(12, 0, 40);
      assert.ok(Math.abs(E.angleAt(eyeY, 67, 40) - E.angleAt(eyeY, 12, 40)) > 50);
    });
    if (VL.rng) {
      test('apparatusView: seeded eye offset after a jump to a zoom target is ±(3–9)°', function () {
        var seen = { neg: 0, pos: 0 };
        for (var n = 0; n < 40; n++) {
          var off = E.jumpOffset('PEN-7K2Q-91C3', n);
          assert.ok(Math.abs(off) >= 3 && Math.abs(off) <= 9, 'jump ' + n + ': ' + off);
          assert.equal(off, E.jumpOffset('PEN-7K2Q-91C3', n), 'repeatable');
          seen[off < 0 ? 'neg' : 'pos']++;
        }
        assert.ok(seen.neg > 5 && seen.pos > 5, 'both signs occur');
        assert.ok(E.jumpOffset('PEN-7K2Q-91C3', 0) !== E.jumpOffset('PEN-7K2Q-91C3', 1), 'each jump differs');
      });
    }
  }

  /* ------------------------------------------------------------------ tools */
  if (UI.uncertaintyView) {
    var T = UI.uncertaintyView.compute;
    test('tools: repeated readings', function () {
      var l = T.parseList('31.62 31.85\n31.70; 1,2');
      assert.deepEqual(l.values, [31.62, 31.85, 31.70]);
      assert.deepEqual(l.bad, ['1,2']);
      var r = T.repeated(l.values);
      assert.equal(r.n, 3);
      assert.close(r.mean, (31.62 + 31.85 + 31.70) / 3, 1e-9);
      assert.close(r.abs, 0.115, 1e-9);
      assert.close(r.percent, 100 * 0.115 / r.mean, 1e-9);
      assert.equal(T.repeated([]), null);
    });
    test('tools: combining uncertainties', function () {
      var p = T.combineProduct([{ value: 2.0, abs: 0.1, power: 2 }, { value: 50, abs: 1, power: -1 }]);
      assert.close(p.percent, 12, 1e-9, '2 × 5 % + 2 %');
      assert.close(p.rows[0].percent, 10, 1e-9);
      var s = T.combineSum([{ abs: 0.1 }, { abs: 0.05 }]);
      assert.close(s.abs, 0.15, 1e-12);
      assert.equal(T.combineProduct([{ value: 0, abs: 1 }]), null);
    });
    test('tools: worst lines (Paper 5 extension)', function () {
      var w = T.worst({ x: 0, y: 0, ey: 1 }, { x: 10, y: 10, ey: 1 });
      assert.close(w.best.m, 1, 1e-12);
      assert.close(w.steep.m, 1.2, 1e-12);
      assert.close(w.shallow.m, 0.8, 1e-12);
      assert.close(w.dm, 0.2, 1e-12);
      assert.equal(T.worst({ x: 1, y: 0 }, { x: 1, y: 3 }), null);
    });
  }

  /* ------------------------------------------------------------------ paper / report */
  if (UI.paperView) {
    test('paperView: total marks and labels', function () {
      var paper = { parts: [{ id: 'a', marks: 1 }, { id: 'b', subparts: [{ id: 'b-i', marks: 2 }, { id: 'b-ii', marks: 3 }] }, { id: 'c', marks: 4 }] };
      assert.equal(UI.paperView.totalMarks(paper), 10);
      assert.equal(UI.paperView.joinLabels('(b)', '(i)'), '(b)(i)');
      assert.equal(UI.paperView.joinLabels('(e)', '(e)(ii)'), '(e)(ii)');
      assert.equal(UI.paperView.joinLabels('', '(a)'), '(a)');
    });
  }
  if (UI.reportView) {
    test('reportView: exam summary over two questions', function () {
      var mk = function (t, m, mmo, pdo, ace) {
        return { total: t, max: m, skills: { MMO: { got: mmo[0], max: mmo[1] }, PDO: { got: pdo[0], max: pdo[1] }, ACE: { got: ace[0], max: ace[1] } } };
      };
      var session = { questions: [
        { qid: 'q1', expId: 'x', report: mk(14, 20, [6, 8], [5, 7], [3, 5]) },
        { qid: 'q2', expId: 'y', report: mk(11, 20, [5, 7], [1, 2], [5, 11]) }
      ] };
      var s = UI.reportView.summarize(session);
      assert.equal(s.total, 25); assert.equal(s.max, 40); assert.equal(s.complete, true);
      assert.deepEqual(s.skills, { MMO: { got: 11, max: 15 }, PDO: { got: 6, max: 9 }, ACE: { got: 8, max: 16 } });
      session.questions[1].report = null;
      var s2 = UI.reportView.summarize(session);
      assert.equal(s2.complete, false); assert.equal(s2.total, 14);
    });
    test('reportView: answer labels from the paper', function () {
      var paper = { parts: [
        { id: 'a', label: '(a)', answers: [{ key: 'd', type: 'value', prefix: 'd =' }] },
        { id: 'e', label: '(e)', subparts: [{ id: 'e-i', label: '(i)', answers: [{ key: 'k', type: 'working', prefix: 'k =' }] }] }
      ] };
      var m = UI.reportView.answerLabels(paper);
      assert.equal(m.d, '(a) d =');
      assert.equal(m.k, '(e)(i) k =');
      assert.equal(m.k_working, '(e)(i) working');
    });
  }
})();
