/*
 * Tests for core/storage.js (VL.storage). In Node there is no localStorage, so the in-memory fallback is used.
 * In a browser (tests/index.html) the tests must never touch the real localStorage: on file:// the test page shares
 * its storage with the app, so a reset would expose a student's saved sessions and progress to the tests. There the
 * "fresh" state is an isolated memory backend, and the two tests that replace globalThis.localStorage run in Node only.
 */
(function () {
  'use strict';
  var VL = globalThis.VLab;
  var S = VL.storage;
  var IN_NODE = typeof globalThis.document === 'undefined';

  /** A test that can only run in the Node sandbox (it replaces globalThis.localStorage). */
  function nodeOnly(name, fn) {
    if (IN_NODE) test(name, fn);
    else test(name + ' — skipped in the browser (Node only)', function () { assert.ok(true); });
  }

  /** A Storage-like object backed by a plain map, optionally failing on writes. */
  function fakeLocalStorage(opts) {
    opts = opts || {};
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) {
        if (opts.failWrites) { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
        if (opts.maxChars && String(v).length > opts.maxChars) throw new Error('QuotaExceededError');
        data[k] = String(v);
      },
      removeItem: function (k) { delete data[k]; },
      key: function (i) { return Object.keys(data)[i] || null; },
      get length() { return Object.keys(data).length; },
      _data: data
    };
  }

  function fresh() { S._setBackend(IN_NODE ? null : S.createMemoryBackend()); }

  function sampleSession(id, extra) {
    var s = {
      id: id, mode: 'practice', created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:30:00.000Z',
      title: 'Simple pendulum — practice', elapsedMs: 1234, finished: false,
      questions: [{ qid: 'q1', expId: 'pendulum', variantId: 'graph', seed: 'PEN-7K2Q-91C3',
        table: { columns: [{ id: 'c1', heading: 'L / cm' }], rows: [{ id: 'r1', cells: { c1: '50.0' } }], nextId: 2 },
        answers: { d: '2.34 cm' }, log: [], submitted: false, report: null }]
    };
    Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; });
    return s;
  }

  test('storage: memory fallback when localStorage is missing (Node)', function () {
    fresh();
    assert.equal(S.available(), false, 'no localStorage in the Node sandbox');
    assert.ok(S.set('x', { a: 1 }), 'set works in memory');
    assert.deepEqual(S.get('x'), { a: 1 });
    assert.equal(S.get('missing', 'fb'), 'fb', 'fallback for missing keys');
    assert.equal(S.get('missing'), undefined);
    S.remove('x');
    assert.equal(S.get('x', null), null);
  });

  test('storage: get/set keep JSON types and never throw on bad data', function () {
    fresh();
    S.set('n', 0); S.set('b', false); S.set('s', '0.50'); S.set('arr', [1, '2']);
    assert.equal(S.get('n'), 0);
    assert.equal(S.get('b', true), false);
    assert.equal(S.get('s'), '0.50', 'strings stored exactly');
    assert.deepEqual(S.get('arr'), [1, '2']);
    var circ = {}; circ.self = circ;
    assert.equal(S.set('circ', circ), false, 'circular value is refused, not thrown');
    var fake = fakeLocalStorage();
    S._setBackend(fake);
    fake.setItem('vlab1:broken', '{not json');
    assert.equal(S.get('broken', 'fb'), 'fb', 'corrupt JSON returns the fallback');
    assert.ok(S.available(), 'an injected real-like backend counts as available');
    fresh();
  });

  test('storage: keys are prefixed vlab1:', function () {
    var fake = fakeLocalStorage();
    S._setBackend(fake);
    S.set('drills:tab', 'graph');
    assert.equal(fake.getItem('vlab1:drills:tab'), '"graph"');
    fresh();
  });

  test('storage: a throwing backend never makes the API throw', function () {
    var bad = {
      getItem: function () { throw new Error('SecurityError'); },
      setItem: function () { throw new Error('SecurityError'); },
      removeItem: function () { throw new Error('SecurityError'); },
      key: function () { throw new Error('SecurityError'); },
      get length() { throw new Error('SecurityError'); }
    };
    S._setBackend(bad);
    assert.equal(S.get('a', 7), 7);
    assert.equal(S.set('a', 1), false);
    assert.equal(S.remove('a'), false);
    assert.equal(S.saveSession(sampleSession('s1')), false);
    assert.equal(S.loadSession('s1'), null);
    assert.deepEqual(S.listSessions(), []);
    assert.equal(S.addProgress({ total: 1, max: 2 }), false);
    assert.deepEqual(S.getProgress(), []);
    assert.equal(S.getSettings().examMinutes, 120);
    assert.equal(S.setSettings({ theme: 'dark' }).theme, 'light', 'write failed so the stored theme is unchanged');
    fresh();
  });

  nodeOnly('storage: probing a localStorage that throws on setItem falls back to memory', function () {
    var saved = globalThis.localStorage;
    globalThis.localStorage = fakeLocalStorage({ failWrites: true });
    S._setBackend(null);
    try {
      assert.equal(S.available(), false, 'private-mode style storage is reported unavailable');
      assert.ok(S.set('k', 1), 'memory fallback still stores the value for this page');
      assert.equal(S.get('k'), 1);
    } finally {
      if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
      S._setBackend(null);
    }
  });

  nodeOnly('storage: probing a working localStorage uses it', function () {
    var saved = globalThis.localStorage;
    var ls = fakeLocalStorage();
    globalThis.localStorage = ls;
    S._setBackend(null);
    try {
      assert.equal(S.available(), true);
      S.set('k', { v: 2 });
      assert.equal(ls.getItem('vlab1:k'), '{"v":2}');
      assert.equal(ls.getItem('vlab1:__probe__'), null, 'probe key cleaned up');
    } finally {
      if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
      S._setBackend(null);
    }
  });

  test('storage: sessions round-trip, stored individually with an index', function () {
    var fake = fakeLocalStorage();
    S._setBackend(fake);
    var s1 = sampleSession('abc');
    var s2 = sampleSession('def', { mode: 'exam', examMinutes: 120, updated: '2026-10-02T09:00:00.000Z', title: 'Exam' });
    assert.ok(S.saveSession(s1));
    assert.ok(S.saveSession(s2));
    assert.ok(fake.getItem('vlab1:session:abc'), 'session stored under its own key');
    assert.ok(fake.getItem('vlab1:session:def'));
    assert.deepEqual(S.loadSession('abc'), s1, 'full round trip');
    assert.equal(S.loadSession('abc').questions[0].table.rows[0].cells.c1, '50.0', 'typed strings preserved');
    assert.equal(S.loadSession('nope'), null);

    var list = S.listSessions();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'def', 'most recently updated first');
    assert.equal(list[0].mode, 'exam');
    assert.equal(list[0].examMinutes, 120);
    assert.equal(list[1].title, 'Simple pendulum — practice');
    assert.equal(list[1].finished, false);
    assert.deepEqual(list[1].expIds, ['pendulum']);
    assert.equal(list[1].questions, undefined, 'summaries have no questions array');
    assert.equal(list[1].total, undefined, 'no total before marking');

    // update in place: marked + finished
    s1.finished = true;
    s1.updated = '2026-10-03T08:00:00.000Z';
    s1.questions[0].report = { total: 15, max: 20, skills: {} };
    assert.ok(S.saveSession(s1));
    list = S.listSessions();
    assert.equal(list.length, 2, 'no duplicate index entries');
    assert.equal(list[0].id, 'abc');
    assert.equal(list[0].finished, true);
    assert.equal(list[0].total, 15);
    assert.equal(list[0].max, 20);
    assert.equal(list[0].marked, 1);

    assert.ok(S.deleteSession('abc'));
    assert.equal(S.loadSession('abc'), null);
    assert.deepEqual(S.listSessions().map(function (x) { return x.id; }), ['def']);
    fresh();
  });

  test('storage: sessions need an id; the index is rebuilt when missing or damaged', function () {
    var fake = fakeLocalStorage();
    S._setBackend(fake);
    assert.equal(S.saveSession({ mode: 'practice' }), false, 'no id');
    assert.equal(S.saveSession(null), false);
    S.saveSession(sampleSession('one'));
    S.saveSession(sampleSession('two', { updated: '2026-10-05T00:00:00.000Z' }));
    fake.removeItem('vlab1:sessions:index');
    assert.deepEqual(S.listSessions().map(function (x) { return x.id; }), ['two', 'one'], 'rebuilt from the session keys');
    fake.setItem('vlab1:sessions:index', 'garbage');
    assert.equal(S.listSessions().length, 2, 'rebuilt after corruption');
    // a session written without its index entry is picked up again
    fake.setItem('vlab1:session:three', JSON.stringify(sampleSession('three', { updated: '2026-10-09T00:00:00.000Z' })));
    assert.equal(S.listSessions()[0].id, 'three');
    fresh();
  });

  test('storage: saveSession reports false when the storage is full', function () {
    var fake = fakeLocalStorage({ maxChars: 200 });
    S._setBackend(fake);
    assert.equal(S.saveSession(sampleSession('big')), false, 'quota exceeded');
    assert.equal(S.loadSession('big'), null);
    fresh();
  });

  test('storage: saveSessionChecked refuses to overwrite a copy changed or deleted in another tab', function () {
    S._setBackend(S.createMemoryBackend());
    assert.ok(S.saveSession(sampleSession('two')));
    var A = S.loadSession('two'), B = S.loadSession('two');
    assert.ok(A !== B, 'two tabs, two copies');
    A.questions[0].answers.d = '2.35 cm';
    assert.deepEqual(S.saveSessionChecked(A), { ok: true, conflict: null, rev: 1 });
    assert.equal(A.rev, 1, 'rev incremented in place');
    B.questions[0].table.columns[0].heading = 'L / m';
    var rb = S.saveSessionChecked(B);
    assert.deepEqual(rb, { ok: false, conflict: 'changed', rev: 1 });
    assert.equal(B.rev, undefined, 'the refused copy is unchanged');
    assert.equal(S.loadSession('two').questions[0].answers.d, '2.35 cm', 'tab A\'s save kept');
    assert.equal(S.loadSession('two').questions[0].table.columns[0].heading, 'L / cm', 'tab B did not overwrite it');
    assert.deepEqual(S.saveSessionChecked(A), { ok: true, conflict: null, rev: 2 }, 'the up-to-date tab keeps saving');
    assert.equal(S.listSessions()[0].id, 'two', 'index summary written');
    // deleted in another tab: never re-created
    assert.ok(S.deleteSession('two'));
    assert.deepEqual(S.saveSessionChecked(A), { ok: false, conflict: 'deleted', rev: 2 });
    assert.equal(S.loadSession('two'), null, 'still deleted');
    assert.equal(S.listSessions().length, 0);
    // a new session (no rev) saves with rev 1; saveSession still works as before
    var n = sampleSession('new');
    assert.deepEqual(S.saveSessionChecked(n), { ok: true, conflict: null, rev: 1 });
    assert.equal(S.loadSession('new').rev, 1);
    assert.equal(S.saveSession(sampleSession('plain')), true);
    // storage full: not a conflict, and the copy keeps its revision
    S._setBackend(fakeLocalStorage({ maxChars: 200 }));
    var big = sampleSession('big');
    assert.deepEqual(S.saveSessionChecked(big), { ok: false, conflict: null, rev: 0 });
    assert.ok(!('rev' in big), 'rev not bumped when nothing was stored');
    assert.equal(S.saveSessionChecked(null).ok, false);
    fresh();
  });

  test('storage: addProgress is idempotent per session question (re-submitting replaces the entry)', function () {
    S._setBackend(S.createMemoryBackend());
    var e = { sessionId: 's1', qIndex: 0, date: '2026-10-01T10:00:00.000Z', mode: 'practice', expId: 'pendulum',
      variantId: 'graph', seed: 'PEN-7K2Q-91C3', total: 12, max: 20,
      skills: { MMO: { got: 5, max: 8 }, PDO: { got: 4, max: 7 }, ACE: { got: 3, max: 5 } } };
    assert.ok(S.addProgress(e));
    assert.ok(S.addProgress(Object.assign({}, e, { total: 14, date: '2026-10-01T11:00:00.000Z' })));
    var p = S.getProgress();
    assert.equal(p.length, 1, 'the same attempt is stored once');
    assert.equal(p[0].total, 14, 'the second entry replaces the first');
    assert.equal(p[0].qIndex, 0, 'qIndex kept');
    S.addProgress(Object.assign({}, e, { qIndex: 1, variantId: 'twopoint', total: 9 }));
    assert.equal(S.getProgress().length, 2, 'another question of the session is a new entry');
    S.addProgress(Object.assign({}, e, { qIndex: 1, total: 10 }));
    assert.equal(S.getProgress().length, 3, 'a different qIndex is a different entry');
    S.addProgress({ mode: 'drill', total: 3, max: 5 });
    S.addProgress({ mode: 'drill', total: 3, max: 5 });
    assert.equal(S.getProgress().length, 5, 'entries without a sessionId are appended');
    fresh();
  });

  test('storage: memory fallback round-trips sessions, progress and settings', function () {
    fresh();
    assert.equal(S.available(), false);
    S.saveSession(sampleSession('m1'));
    assert.equal(S.listSessions().length, 1);
    assert.equal(S.loadSession('m1').questions[0].answers.d, '2.34 cm');
    S.addProgress({ sessionId: 'm1', date: '2026-10-01T10:00:00.000Z', mode: 'practice', expId: 'pendulum',
      variantId: 'graph', seed: 'PEN-7K2Q-91C3', total: 15, max: 20,
      skills: { MMO: { got: 6, max: 8 }, PDO: { got: 6, max: 7 }, ACE: { got: 3, max: 5 } } });
    assert.equal(S.getProgress().length, 1);
    S.setSettings({ examMinutes: 75 });
    assert.equal(S.getSettings().examMinutes, 75);
    fresh();
    assert.equal(S.getProgress().length, 0, 'reset gives a fresh memory store');
  });

  test('storage: progress entries are normalised, kept in order and capped', function () {
    S._setBackend(fakeLocalStorage());
    assert.equal(S.addProgress(null), false);
    assert.ok(S.addProgress({ sessionId: 's', date: '2026-10-01T10:00:00.000Z', mode: 'drill', expId: 'drill-graph',
      seed: 'GRD-0000-0000', total: '4', max: 5, skills: { PDO: { got: 2, max: 3 }, ACE: { got: 2, max: 2 } }, extra: 'kept' }));
    assert.ok(S.addProgress({ mode: 'exam', total: 30, max: 40 }));
    var p = S.getProgress();
    assert.equal(p.length, 2);
    assert.equal(p[0].expId, 'drill-graph', 'oldest first');
    assert.equal(p[0].total, 4, 'numeric total');
    assert.deepEqual(p[0].skills.MMO, { got: 0, max: 0 }, 'missing skills filled in');
    assert.deepEqual(p[0].skills.PDO, { got: 2, max: 3 });
    assert.equal(p[0].extra, 'kept', 'extra fields kept');
    assert.match(p[1].date, /^\d{4}-\d{2}-\d{2}T/, 'date defaulted to an ISO string');
    p[0].total = 99;
    assert.equal(S.getProgress()[0].total, 4, 'getProgress returns a copy');
    assert.ok(S.clearProgress());
    assert.deepEqual(S.getProgress(), []);
    for (var i = 0; i < S.MAX_PROGRESS + 5; i++) S.addProgress({ total: i, max: 10 });
    p = S.getProgress();
    assert.equal(p.length, S.MAX_PROGRESS, 'capped');
    assert.equal(p[p.length - 1].total, S.MAX_PROGRESS + 4, 'newest kept');
    fresh();
  });

  test('storage: settings defaults, merge and repair', function () {
    var fake = fakeLocalStorage();
    S._setBackend(fake);
    assert.deepEqual(S.getSettings(), { examMinutes: 120, theme: 'light', hintsInPractice: true });
    var s = S.setSettings({ theme: 'dark' });
    assert.equal(s.theme, 'dark');
    assert.equal(s.examMinutes, 120, 'other settings kept');
    S.setSettings({ hintsInPractice: false, custom: 'x' });
    s = S.getSettings();
    assert.equal(s.theme, 'dark');
    assert.equal(s.hintsInPractice, false);
    assert.equal(s.custom, 'x', 'unknown settings kept');
    fake.setItem('vlab1:settings', JSON.stringify({ examMinutes: -5, theme: 'purple', hintsInPractice: 'yes' }));
    assert.deepEqual(S.getSettings(), { examMinutes: 120, theme: 'light', hintsInPractice: true }, 'invalid values repaired');
    var d = S.getSettings();
    d.examMinutes = 1;
    assert.equal(S.getSettings().examMinutes, 120, 'returns a copy');
    fresh();
  });

  test('storage: summarizeSession is pure and totals marked questions', function () {
    var s = sampleSession('x', { mode: 'exam', finished: true });
    s.questions.push({ qid: 'q2', expId: 'spring', report: { total: 12, max: 20 } });
    s.questions[0].report = { total: 14, max: 20 };
    var sum = S.summarizeSession(s);
    assert.equal(sum.total, 26);
    assert.equal(sum.max, 40);
    assert.equal(sum.marked, 2);
    assert.equal(sum.questionCount, 2);
    assert.deepEqual(sum.expIds, ['pendulum', 'spring']);
    assert.equal(s.questions.length, 2, 'input untouched');
  });
})();
