/* Tests for core/textmatch.js (VL.textmatch). */
(function () {
  'use strict';
  var VL = globalThis.VLab;
  var TM = VL.textmatch;

  /* A pendulum-style limitations / improvements bank (original wording, written for these tests). */
  var BANK = [
    { id: 'A',
      limitation: { label: 'two sets of readings are not enough to draw a valid conclusion',
        concepts: [{ all: [['two', '2', 'only', 'few'], ['/reading|result|set|value|measurement/'], ['/not enough|insufficient|too few|conclusion|unreliable|cannot conclude/']] }] },
      improvement: { label: 'take more readings and plot a graph',
        concepts: [{ all: [['/\\bmore\\b|several|at least (five|six|5|6)/'], ['/length|reading|value|set|result/'], ['/graph|plot/']] }] } },
    { id: 'B',
      limitation: { label: 'difficult to judge the start and end of an oscillation / reaction time large compared with the time measured',
        concepts: [
          { all: [['/difficult|hard|not easy|uncertain/'], ['/start|end|begin|stop|when/'], ['/oscillation|swing|bob/']] },
          { all: [['/reaction ?time/'], ['/large|significant|compared|short|relative/']] }
        ] },
      improvement: { label: 'use a fiducial marker, time more oscillations, or use a light gate / video',
        concepts: [
          { all: [['/fiducial|marker|pointer/']] },
          { all: [['/\\bmore\\b|\\b(20|30|50)\\b|twenty|thirty|larger number/'], ['/oscillation|swing/']] },
          { all: [['/light gate|video|slow motion/']] }
        ] } },
    { id: 'C',
      limitation: { label: 'difficult to measure L because the rule is not next to the string / bob position hard to judge',
        concepts: [{ all: [['/difficult|hard|not easy/'], ['/length|\\bl\\b|rule|ruler|string/'], ['/rule|bob|cork|centre|top|touch|judge|far|gap/']], none: [['/oscillation|swing/']] }] },
      improvement: { label: 'use a set square, or clamp the rule vertically next to the string',
        concepts: [{ all: [['/set ?square/']] }, { all: [['/clamp|fix|hold/'], ['/rule|ruler/'], ['/vertical|next to|beside|close/']] }] } },
    { id: 'D',
      limitation: { label: 'amplitude not kept constant',
        concepts: [{ all: [['/amplitude|angle|release/'], ['/not (the )?same|not constant|vary|varies|varied|different|changes?|changed/']] }] },
      improvement: { label: 'use the protractor to release from the same small angle each time',
        concepts: [{ all: [['/protractor|same angle|fixed angle|same amplitude|measure the angle/']] }] } }
  ];

  test('normalize: lower case, punctuation removed, plurals and verb endings stemmed consistently', function () {
    assert.equal(TM.normalize('Readings!'), TM.normalize('reading'));
    assert.equal(TM.normalize('timed'), TM.normalize('time'));
    assert.equal(TM.normalize('timing'), TM.normalize('times'));
    assert.equal(TM.normalize('Uncertainties'), TM.normalize('uncertainty'));
    assert.equal(TM.normalize('stopped'), TM.normalize('stop'));
    assert.equal(TM.normalize('swinging'), TM.normalize('swing'));
    assert.equal(TM.normalize('String'), 'string', 'non-verb -ing word kept');
  });

  test('plain: unicode quotes, dashes, superscripts, abbreviations and contractions', function () {
    assert.equal(TM.plain('The bob’s swing isn’t in “one” plane'), 'the bobs swing is not in one plane');
    assert.equal(TM.plain('T² against L'), 't2 against l');
    assert.equal(TM.plain('T^2'), 't2');
    assert.equal(TM.plain('to 3 s.f. and 2 d.p.'), 'to 3 sf and 2 dp');
    assert.equal(TM.plain('It doesn\'t; we can\'t; cannot'), 'it does not we can not can not');
    assert.equal(TM.plain('within 10%'), 'within 10 %');
    assert.equal(TM.plain('10 per cent'), '10 %');
    assert.equal(TM.plain('10–20 oscillations'), '10 to 20 oscillations');
    assert.equal(TM.plain('set-square & rule'), 'set square and rule');
    assert.equal(TM.plain('values 0.5, .25 and −3.1'), 'values 0.5 0.25 and -3.1');
    assert.equal(TM.plain(''), '');
    assert.equal(TM.plain(null), '');
  });

  test('clauses: split at sentences, commas and joining words, not at decimal points or s.f.', function () {
    var c = TM.clauses('k is to 3 s.f. because L was to 1 d.p.; but t was 12.34 s, so it is not supported. Yes');
    assert.deepEqual(c, ['k is to 3 sf', 'l was to 1 dp', 't was 12.34 s', 'it is not supported', 'yes']);
  });

  test('clauses / plain: s.f., d.p. and sig. fig. after a digit or with spaces do not end a clause', function () {
    assert.deepEqual(TM.clauses('k is 3s.f. because L is 3s.f.'), ['k is 3sf', 'l is 3sf']);
    assert.deepEqual(TM.clauses('L was 3 sig. fig. so k 3 sig. fig.'), ['l was 3 sig fig', 'k 3 sig fig']);
    assert.deepEqual(TM.clauses('k to 3 s. f. as L has 3 S.F.; next'), ['k to 3 sf as l has 3 sf', 'next']);
    assert.deepEqual(TM.clauses('Same 2d.p. as t. Done'), ['same 2dp as t', 'done']);
    assert.equal(TM.plain('k is 3s.f. because L is 3s.f.'), 'k is 3sf because l is 3sf');
    assert.equal(TM.plain('3 sig. figs. like t'), '3 sig figs like t');
    assert.deepEqual(TM.clauses('The time is in s. Further work is needed.'), ['the time is in s', 'further work is needed'],
      'an ordinary full stop after a single letter still ends the sentence');
  });

  test('matches: plain phrases match whole words after stemming', function () {
    assert.ok(TM.matches('Time more oscillations', [['timing more oscillation']]));
    assert.ok(!TM.matches('timetable', [['time']]), 'no partial-word match');
    assert.ok(TM.matches('The readings were few', 'reading'));
  });

  test('matches: regex strings are tested before and after stemming', function () {
    assert.ok(TM.matches('Reaction times are large', { all: [['/reaction ?time/'], ['large']] }));
    assert.ok(TM.matches('the reactiontime', '/reaction ?time/'));
    assert.ok(TM.matches('Use a LIGHT GATE', [['/light gate/']]), 'case-insensitive');
    assert.ok(TM.matches('abc', /ABC/i), 'RegExp objects accepted');
    assert.ok(!TM.matches('anything', '/(unclosed/'), 'bad regex never matches and never throws');
  });

  test('matches: every all-group must match; any none-group vetoes', function () {
    var c = { all: [['difficult', 'hard'], ['/length|rule/']], none: [['oscillation']] };
    assert.ok(TM.matches('It is hard to read the length', c));
    assert.ok(!TM.matches('It is hard to read', c));
    assert.ok(!TM.matches('Hard to judge the length of an oscillation', c));
    assert.ok(!TM.matches('', c));
    assert.ok(!TM.matches('text', { all: [] }), 'empty concept never matches');
    assert.ok(TM.matchesAny('use a set square', [{ all: [['protractor']] }, { all: [['set square']] }]));
  });

  test('splitItems: numbered and bulleted lines, continuations, inline numbering, arrays', function () {
    assert.deepEqual(TM.splitItems('1. Two readings are not enough\n2. Reaction time\ncontinued here\n3) parallax'),
      ['Two readings are not enough', 'Reaction time continued here', 'parallax']);
    assert.deepEqual(TM.splitItems('Two readings are not enough\nReaction time is large'),
      ['Two readings are not enough', 'Reaction time is large']);
    assert.deepEqual(TM.splitItems('1. Two readings 2. Reaction time 3. Bob swings'), ['Two readings', 'Reaction time', 'Bob swings']);
    assert.deepEqual(TM.splitItems('• one\n• two\n(a) three\nb) four\n(ii) five\n- six'), ['one', 'two', 'three', 'four', 'five', 'six']);
    assert.deepEqual(TM.splitItems(['(i) a', '- b\n- c', '', null, '1.5 cm is too short']), ['a', 'b', 'c', '1.5 cm is too short']);
    assert.deepEqual(TM.splitItems(['A long answer\nthat wraps onto a second line']), ['A long answer that wraps onto a second line']);
    assert.deepEqual(TM.splitItems(''), []);
    assert.deepEqual(TM.splitItems(undefined), []);
  });

  test('GENERIC_REJECTS: the classic generic answers are recognised, with reasons', function () {
    var generic = ['Use more accurate equipment', 'use a more accurate stopwatch', 'Repeat the experiment',
      'repeat readings and take an average', 'Human error', 'parallax error', 'Use a computer',
      'Be more careful', 'reaction time', 'random error', 'The stopwatch was faulty'];
    generic.forEach(function (g) {
      var r = TM.genericReject(g);
      assert.ok(r && r.reason && r.reason.length > 20, 'generic: ' + g);
    });
    ['Use a set square to line up the bob with the rule', 'Use a fiducial marker at the centre of the swing']
      .forEach(function (s) { assert.equal(TM.genericReject(s), null, 'specific: ' + s); });
    assert.ok(Array.isArray(TM.GENERIC_REJECTS) && TM.GENERIC_REJECTS.length >= 7);
  });

  test('markWritten: hits, misses, max and generic rejects', function () {
    var specs = [
      { id: 'p1', label: 'mentions fiducial marker', concepts: [[['fiducial marker']]] },
      { id: 'p2', label: 'times many oscillations', concepts: [{ all: [['/20|twenty|many/'], ['oscillation']] }] },
      { id: 'p3', label: 'repeats', concepts: [[['/repeat/']]] }
    ];
    var r = TM.markWritten('1. I used a fiducial marker\n2. I timed 20 oscillations\n3. Human error', specs, { max: 2 });
    assert.equal(r.awarded, 2);
    assert.deepEqual(r.hits.map(function (h) { return h.id; }), ['p1', 'p2']);
    assert.deepEqual(r.misses.map(function (h) { return h.id; }), ['p3']);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].text, 'Human error');
    var e = TM.markWritten('', specs);
    assert.equal(e.awarded, 0);
    assert.equal(e.misses.length, 3);
  });

  test('markLimitationsImprovements: typical credited answers', function () {
    var r = TM.markLimitationsImprovements(
      ['Two readings are not enough to draw a conclusion',
        'It is difficult to judge the end of an oscillation',
        'The amplitude was not the same for each length'],
      ['Take more readings for different lengths and plot a graph of T² against L',
        'Use a fiducial marker at the centre of the swing',
        'Release the bob from the same angle using a protractor'],
      BANK);
    assert.equal(r.limitations.awarded, 3);
    assert.deepEqual(r.limitations.hits.map(function (h) { return h.id; }), ['A', 'B', 'D']);
    assert.equal(r.improvements.awarded, 3);
    assert.deepEqual(r.improvements.hits.map(function (h) { return h.id; }), ['A', 'B', 'D']);
    assert.deepEqual(r.limitations.misses.map(function (h) { return h.id; }), ['C']);
    assert.equal(r.limitations.rejected.length, 0);
  });

  test('markLimitationsImprovements: each bank row once per column, generic answers rejected with reasons', function () {
    var r = TM.markLimitationsImprovements(
      '1. Reaction time is large compared with the time for one swing\n2. Hard to judge when the bob starts an oscillation\n3. Human error\n4. Parallax',
      '1. Use a more accurate stopwatch\n2. Repeat the experiment\n3. Use a light gate\n4. Time 20 oscillations',
      BANK);
    assert.equal(r.limitations.awarded, 1, 'two answers for row B earn one mark');
    assert.equal(r.limitations.rejected.length, 3);
    assert.match(r.limitations.rejected[0].reason, /once/);
    assert.match(r.limitations.rejected[1].reason, /Human error/);
    assert.match(r.limitations.rejected[2].reason, /Parallax/);
    assert.equal(r.improvements.awarded, 1, 'light gate and 20 oscillations are both row B');
    assert.match(r.improvements.rejected[0].reason, /vague/);
    assert.match(r.improvements.rejected[1].reason, /Repeating/);
    assert.equal(r.improvements.items.length, 4);
    assert.equal(r.improvements.items[2].id, 'B');
  });

  test('markLimitationsImprovements: an item credits at most one row; best overall assignment is used', function () {
    // item 1 matches B (reaction time) and D? no — build a bank where item 1 matches rows X and Y, item 2 only X
    var bank = [
      { id: 'X', limitation: { label: 'x', concepts: [[['/alpha/']]] }, improvement: null },
      { id: 'Y', limitation: { label: 'y', concepts: [[['/beta/']]] }, improvement: null }
    ];
    var r = TM.markLimitationsImprovements(['alpha and beta', 'alpha'], [], bank);
    assert.equal(r.limitations.awarded, 2, 'item 1 → Y, item 2 → X');
    var ids = r.limitations.hits.map(function (h) { return h.id; }).sort();
    assert.deepEqual(ids, ['X', 'Y']);
    var one = TM.markLimitationsImprovements(['alpha and beta'], [], bank);
    assert.equal(one.limitations.awarded, 1, 'one item cannot earn two marks');
  });

  test('markLimitationsImprovements: limitations and improvements are independent; maximum 4 each', function () {
    var r = TM.markLimitationsImprovements([], ['Use a set square to line up the top of the bob with the rule'], BANK);
    assert.equal(r.limitations.awarded, 0);
    assert.equal(r.improvements.awarded, 1);
    assert.equal(r.improvements.hits[0].id, 'C');
    var many = [];
    for (var i = 0; i < 6; i++) many.push({ id: 'R' + i, limitation: { label: 'r' + i, concepts: [[['word' + i]]] }, improvement: null });
    var m = TM.markLimitationsImprovements(['word0', 'word1', 'word2', 'word3', 'word4', 'word5'], '', many);
    assert.equal(m.limitations.awarded, 4);
    assert.equal(m.limitations.rejected.length, 2);
    assert.match(m.limitations.rejected[0].reason, /Maximum of 4/);
    var custom = TM.markLimitationsImprovements(['word0', 'word1'], '', many, { maxEach: 1 });
    assert.equal(custom.limitations.awarded, 1);
  });

  test('markLimitationsImprovements: unrecognised specific answers get a helpful reason', function () {
    var r = TM.markLimitationsImprovements(['The room was warm'], ['Do it at night'], BANK);
    assert.equal(r.limitations.awarded, 0);
    assert.match(r.limitations.rejected[0].reason, /Not a recognised limitation/);
    assert.match(r.improvements.rejected[0].reason, /Not a recognised improvement/);
  });
})();
