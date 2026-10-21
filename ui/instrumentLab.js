/**
 * Instrument Lab — tutorial page with an interactive sandbox for every instrument (browser only).
 *
 *   VL.ui.instrumentLab.mount(container) -> { destroy(), select(id), seed() }
 *
 * Left: list of instruments. Right: the instrument's tutorial (instrument.describe()) and a canvas sandbox with its
 * own viewport (wheel / buttons / pinch zoom, drag to pan, dpr-aware, ResizeObserver), an eye-level slider for
 * parallax, a hidden seeded object or quantity to measure ('New object' changes the seed), an answer box and a
 * 'Check my reading' button that gives specific feedback. Nothing is ever filled in for the student.
 *
 * Each sandbox is created by a factory in SANDBOXES below: factory(env) -> Sandbox where
 *   env = { rng, seed, now() }
 *   Sandbox = {
 *     world: { w, h }, eye: 'vertical' | 'meter' | null, eyeNote?, task (HTML), answer?: { label, example },
 *     zoomTargets?: [{ label, x, y, scale }] or function returning that list,
 *     draw(g, view), update?(dt, nowMs), pointer?: { down(p) -> bool, move(p), up(p), hover?(p) -> bool },
 *     controls?(el, api), customAnswer?(el, api), check?(str, ctx) -> Feedback, reveal?() -> HTML,
 *     onKey?(ev) -> bool, destroy?()
 *   }
 *   Feedback = { status: 'ok' | 'close' | 'bad', title, lines: [HTML] }
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  /* ================================================================== */
  /* Small helpers                                                      */
  /* ================================================================== */

  function INS() { return VL.instruments; }
  function U() { return VL.instruments.util; }
  function h() { return ui.h.apply(null, arguments); }
  function esc(s) { return ui.esc ? ui.esc(s) : String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function perfNow() { return globalThis.performance ? globalThis.performance.now() : Date.now(); }
  function lw(view, w) { return U().lineW(view, w); }
  function fmt(v, step) { return U().fixed(v, U().decimalsOf(step)); }
  function num(v) { return String(Number(Number(v).toFixed(6))); }

  /** Seeded rng (VL.rng; small fallback only if core/rng.js is missing). */
  function makeRng(seed) {
    if (VL.rng && VL.rng.create) return VL.rng.create(seed);
    var s = U().hashString(seed);
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
      shuffle: function (a) { return a.slice(); },
      fork: function (n) { return makeRng(seed + '/' + n); }
    };
  }
  var seedCounter = 0;
  function freshSeed() {
    if (VL.rng && VL.rng.newSeed) return VL.rng.newSeed('LAB');
    seedCounter++;
    return 'LAB-' + (Date.now() % 1679616).toString(36).toUpperCase().padStart(4, '0') + '-' + String(1000 + seedCounter);
  }

  /** Parse what the student typed. Returns { ok, value, dp, str, problem }. */
  function parseTyped(str) {
    var raw = String(str || '').trim();
    if (!raw) return { ok: false, problem: 'empty' };
    if (/^[+\-−]?\d+,\d+$/.test(raw)) return { ok: false, problem: 'comma' };
    if (/[a-zA-Zµ°³²Ω%]/.test(raw.replace(/[eE][+\-]?\d+$/, '').replace(/[x×]10/, ''))) return { ok: false, problem: 'unit' };
    if (VL.sigfig && VL.sigfig.parse) {
      var p = VL.sigfig.parse(raw);
      if (!p.ok) return { ok: false, problem: 'nan' };
      return { ok: true, value: p.value, dp: p.dp, str: p.str };
    }
    var s = raw.replace('−', '-');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, problem: 'nan' };
    var i = s.indexOf('.');
    return { ok: true, value: parseFloat(s), dp: i >= 0 ? s.length - i - 1 : 0, str: s };
  }

  function parseProblem(p, example) {
    var msg = {
      empty: 'Type your reading in the box first.',
      comma: 'Use a decimal point, not a comma (write ' + esc(example || '12.3') + ').',
      unit: 'Type only the number — the unit is already given in the label.',
      nan: 'That is not a number. Type it like this: ' + esc(example || '12.3') + '.'
    }[p.problem] || 'Type a number.';
    return { status: 'bad', title: 'Check what you typed', lines: [msg] };
  }

  function dpOk(dp, want) {
    if (want === null || want === undefined) return true;
    return Array.isArray(want) ? want.indexOf(dp) >= 0 : dp === want;
  }
  function dpText(want) {
    var list = Array.isArray(want) ? want : [want];
    return list.map(function (d) { return d + ' decimal place' + (d === 1 ? '' : 's'); }).join(' or ');
  }

  /**
   * Generic reading judge.
   * @param {string} str  what the student typed
   * @param {object} o    { truth, res, tol, unit, dp, close, alts: [{value, tol?, title, msg, strict?}], hints: [], example,
   *                        okExtra: [] }
   */
  function judge(str, o) {
    var p = parseTyped(str);
    if (!p.ok) return parseProblem(p, o.example);
    var x = p.value, err = x - o.truth, u = o.unit ? ' ' + o.unit : '';
    var tol = o.tol + 1e-9;
    // 'strict' alternatives (e.g. an uncorrected offset of one digit) win when the typed value is nearer to them
    // than to the true value, even inside the tolerance.
    var strict = (o.alts || []).filter(function (a) { return a && a.strict && isFinite(a.value); });
    for (var si = 0; si < strict.length; si++) {
      var sa = strict[si], sat = (sa.tol !== undefined ? sa.tol : o.tol) + 1e-9;
      if (Math.abs(x - sa.value) <= sat && Math.abs(x - sa.value) + 1e-9 < Math.abs(err) && Math.abs(sa.value - o.truth) > 1e-9) {
        return { status: sa.status || 'bad', title: sa.title, lines: [sa.msg] };
      }
    }
    if (Math.abs(err) <= tol) {
      if (!dpOk(p.dp, o.dp)) {
        return { status: 'close', title: 'right value, wrong precision', lines: [
          'Your value is within the reading tolerance, but it is written to ' + dpText(p.dp) + '. Readings from this instrument should be recorded to ' + dpText(o.dp) + ' (resolution ' + num(o.res) + u + ').'
        ] };
      }
      return { status: 'ok', title: 'Correct', lines: [
        '<strong>' + esc(p.str) + u + '</strong> agrees with the true value to within ±' + num(o.tol) + u + '.'
      ].concat(o.okExtra || []) };
    }
    var alts = o.alts || [];
    for (var i = 0; i < alts.length; i++) {
      var a = alts[i];
      if (!a || !isFinite(a.value)) continue;
      var at = (a.tol !== undefined ? a.tol : o.tol) + 1e-9;
      if (Math.abs(a.value - o.truth) > tol && Math.abs(x - a.value) <= at) {
        return { status: a.status || 'bad', title: a.title, lines: [a.msg] };
      }
    }
    var n = Math.round(Math.abs(err) / o.res);
    var dir = err > 0 ? 'too high' : 'too low';
    if (Math.abs(err) <= (o.close !== undefined ? o.close : 1.5 * o.res) + 1e-9) {
      return { status: 'close', title: 'about one division ' + dir, lines: ['You are about one division ' + dir + '. ' + (o.closeHint || 'Look again carefully at the scale.')] };
    }
    return { status: 'bad', title: 'reading ' + dir, lines: [
      'Your reading is about ' + n + ' division' + (n === 1 ? '' : 's') + ' ' + dir + ' (one division is ' + num(o.res) + u + ').'
    ].concat(o.hints || []) };
  }

  function eyeWords(eye, kind) {
    var a = Math.abs(Math.round(eye));
    if (!a) return kind === 'meter' ? 'directly in front of the needle' : 'level with the reading';
    if (kind === 'meter') return a + '° to the ' + (eye > 0 ? 'left' : 'right') + ' of the needle';
    return a + '° ' + (eye > 0 ? 'above' : 'below') + ' the reading';
  }
  function parallaxMsg(view, extra) {
    return 'Your eye is ' + eyeWords(view.eyeAngle) + ', so parallax shifted your reading. Move the eye-level slider to 0° (eye level with the mark) and read again.' + (extra ? ' ' + extra : '');
  }

  /* ---------------- shared scenery ---------------- */

  function drawBench(g, x0, x1, y, view) {
    var gr = g.createLinearGradient(0, y, 0, y + 4);
    gr.addColorStop(0, '#c49a66'); gr.addColorStop(1, '#8a6238');
    g.fillStyle = gr;
    g.fillRect(x0, y, x1 - x0, 4);
    g.strokeStyle = '#5e3f1f';
    g.lineWidth = lw(view, 0.03);
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
  }
  function drawStand(g, x, benchY, topY, view) {
    g.fillStyle = '#2f3740';
    g.fillRect(x - 4, benchY - 0.9, 10, 0.9);
    var gr = g.createLinearGradient(x - 0.5, 0, x + 0.5, 0);
    gr.addColorStop(0, '#8d97a1'); gr.addColorStop(0.5, '#e6eaee'); gr.addColorStop(1, '#7c8791');
    g.fillStyle = gr;
    g.fillRect(x - 0.5, topY, 1.0, benchY - 0.9 - topY);
    g.strokeStyle = '#4b555f'; g.lineWidth = lw(view, 0.02);
    g.strokeRect(x - 0.5, topY, 1.0, benchY - 0.9 - topY);
  }
  function drawBoss(g, x, y, view) {
    g.fillStyle = '#55606b';
    g.fillRect(x - 1.0, y - 0.9, 2.0, 1.8);
    g.strokeStyle = '#2a3036'; g.lineWidth = lw(view, 0.02);
    g.strokeRect(x - 1.0, y - 0.9, 2.0, 1.8);
  }
  function sphere(g, x, y, r, base, view) {
    var gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, base); gr.addColorStop(1, '#2a2f35');
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = gr; g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = lw(view, 0.01); g.stroke();
  }
  function beaker(g, cx, bottom, w, hgt, waterTop, view, opts) {
    opts = opts || {};
    g.fillStyle = 'rgba(215,232,245,0.35)';
    g.fillRect(cx - w / 2, bottom - hgt, w, hgt);
    if (waterTop !== null) {
      g.fillStyle = opts.water || 'rgba(80,150,230,0.30)';
      g.fillRect(cx - w / 2 + 0.15, waterTop, w - 0.3, bottom - 0.15 - waterTop);
    }
    g.strokeStyle = '#5d7790'; g.lineWidth = lw(view, 0.03);
    g.beginPath();
    g.moveTo(cx - w / 2 - 0.3, bottom - hgt - 0.2); g.lineTo(cx - w / 2, bottom - hgt);
    g.lineTo(cx - w / 2, bottom); g.lineTo(cx + w / 2, bottom); g.lineTo(cx + w / 2, bottom - hgt);
    g.stroke();
  }

  /* ================================================================== */
  /* Sandboxes                                                          */
  /* ================================================================== */

  var SANDBOXES = [];
  function sandbox(id, label, group, factory) { SANDBOXES.push({ id: id, label: label, group: group, factory: factory }); }

  /* ---------- Metre rule: height of a pointer ---------- */
  sandbox('metreRule', 'Metre rule', 'Length', function (env) {
    var rule = INS().create('metreRule', { zeroInset: 0 }, env.rng.fork('instrument'));
    var o = env.rng.fork('object');
    var hTrue = U().roundTo(o.uniform(18, 92), 0.001);
    var benchY = 108, gap = 2.0;
    var place = { x: 14, y: benchY, angle: -Math.PI / 2, side: 1 };
    var pointerY = benchY - hTrue;
    return {
      world: { w: 40, h: 115 }, eye: 'vertical', instrument: rule,
      task: 'A pointer is clamped <strong>2.0 cm in front of</strong> a vertical metre rule whose zero mark is on the bench. Zoom in and find the height <em>h</em> of the pointer tip above the bench.',
      answer: { label: 'h / cm', example: '45.3' },
      zoomTargets: [{ label: 'Zoom to the pointer tip', x: 14.5, y: pointerY, scale: 110 }],
      draw: function (g, view) {
        drawBench(g, 0, 40, benchY, view);
        drawStand(g, 5, benchY, 10, view);
        drawStand(g, 30, benchY, 6, view);
        // Clamp holding the rule upright.
        g.fillStyle = '#55606b';
        g.fillRect(16.8, 11.6, 13.2, 0.8);
        drawBoss(g, 30, 12, view);
        g.fillRect(16.4, 10.9, 1.4, 2.2);
        rule.draw(g, place, view);
        // Pointer (in front of the scale -> parallax).
        var y = pointerY + rule.apparentShift(gap, view);
        drawBoss(g, 5, y, view);
        g.beginPath();
        g.moveTo(5.9, y - 0.08); g.lineTo(13.4, y - 0.08); g.lineTo(14.55, y); g.lineTo(13.4, y + 0.08); g.lineTo(5.9, y + 0.08);
        g.closePath();
        g.fillStyle = '#20262c'; g.fill();
      },
      check: function (str, ctx) {
        var app = rule.apparentReadingAt(place, { x: 14, y: pointerY }, gap, ctx.view);
        return judge(str, { truth: hTrue, res: 0.1, tol: 0.05, unit: 'cm', dp: 1, example: '45.3',
          alts: [{ value: app, title: 'Parallax error', msg: parallaxMsg(ctx.view, 'With the eye above the pointer, the pointer (in front of the scale) appears lower against the rule.') }],
          hints: ['Count the centimetre numbers first, then the millimetre marks above the last number.'] });
      },
      reveal: function () { return 'h = <strong>' + fmt(hTrue, 0.1) + ' cm</strong> (true height ' + hTrue.toFixed(2) + ' cm).'; }
    };
  });

  /* ---------- 30 cm rule: length of a pencil ---------- */
  sandbox('rule30', '30 cm rule', 'Length', function (env) {
    var rule = INS().create('rule30', {}, env.rng.fork('instrument'));
    var o = env.rng.fork('object');
    var L = U().roundTo(o.uniform(7, 18.5), 0.001);
    var place = { x: 4, y: 6, angle: 0, side: 1 };
    var left = 4 + U().roundTo(o.uniform(1.2, 30 - L - 0.5), 0.001);
    var drag = null;
    function inPencil(p) { return p.x >= left - 0.2 && p.x <= left + L + 0.2 && p.y >= 4.9 && p.y <= 6.1; }
    return {
      world: { w: 38, h: 12 }, eye: null, instrument: rule,
      eyeNote: 'The rule is on its edge and you look straight down at it, so there is no parallax here.',
      task: 'Find the length <em>L</em> of the pencil. You may drag the pencil along the rule.',
      answer: { label: 'L / cm', example: '12.4' },
      zoomTargets: function () {
        return [{ label: 'Zoom to the left end', x: left, y: 6.2, scale: 90 }, { label: 'Zoom to the tip', x: left + L, y: 6.2, scale: 90 }];
      },
      draw: function (g, view) {
        g.fillStyle = '#fbfbf7';
        g.fillRect(1, 1, 36, 10);
        rule.draw(g, place, view);
        var x0 = left, x1 = left + L, y0 = 5.2, y1 = 5.95, ym = (y0 + y1) / 2;
        g.fillStyle = '#f2c230';
        g.fillRect(x0, y0, Math.max(0, L - 1.8), y1 - y0);
        g.fillStyle = 'rgba(120,80,0,0.25)';
        g.fillRect(x0, y0 + 0.25, Math.max(0, L - 1.8), 0.08);
        g.beginPath();
        g.moveTo(x1 - 1.8, y0); g.lineTo(x1 - 0.32, ym - 0.06); g.lineTo(x1 - 0.32, ym + 0.06); g.lineTo(x1 - 1.8, y1);
        g.closePath();
        g.fillStyle = '#e9c99a'; g.fill();
        g.beginPath();
        g.moveTo(x1 - 0.32, ym - 0.07); g.lineTo(x1, ym); g.lineTo(x1 - 0.32, ym + 0.07); g.closePath();
        g.fillStyle = '#2b2b2b'; g.fill();
        g.strokeStyle = '#6b5313'; g.lineWidth = lw(view, 0.01);
        g.strokeRect(x0, y0, Math.max(0, L - 1.8), y1 - y0);
      },
      pointer: {
        hover: inPencil,
        down: function (p) { if (!inPencil(p)) return false; drag = p.x - left; return true; },
        move: function (p) { if (drag !== null) left = clamp(p.x - drag, 1.2, 36.5 - L); },
        up: function () { drag = null; }
      },
      check: function (str) {
        var tipReading = rule.readingAt(place, { x: left + L, y: 6 });
        var endReading = rule.readingAt(place, { x: left, y: 6 });
        return judge(str, { truth: L, res: 0.1, tol: 0.1, unit: 'cm', dp: 1, example: '12.4',
          alts: Math.abs(endReading) > 0.1 ? [{ value: tipReading, title: 'Read both ends', msg: 'That is the reading at the tip only. The pencil does not start at the zero mark: read the scale at both ends and subtract (or drag the pencil so its end is exactly on the zero mark).' },
            { value: tipReading + rule.zeroInset, title: 'Measured from the end of the rule?', msg: 'The zero mark is not at the end of the rule. Read both ends of the pencil on the scale and subtract.' }] : [],
          hints: ['Read the scale at each end of the pencil to the nearest millimetre, then subtract.'] });
      },
      reveal: function () { return 'L = <strong>' + fmt(L, 0.1) + ' cm</strong> (true length ' + L.toFixed(2) + ' cm).'; }
    };
  });

  /* ---------- Set square: height of the top of a ball ---------- */
  sandbox('setSquare', 'Set square', 'Length', function (env) {
    var rule = INS().create('rule30', { zeroInset: 0 }, env.rng.fork('instrument'));
    var sq = INS().create('setSquare', { base: 12 });
    var o = env.rng.fork('object');
    var D = U().roundTo(o.uniform(3, 7.5), 0.001);
    var benchY = 36, ballX = 11.5;
    var rulePlace = { x: 18, y: benchY, angle: -Math.PI / 2, side: 1 };
    var sqY = benchY - 22;
    var drag = null;
    function sqPlace() { return { x: 18, y: sqY, angle: -Math.PI / 2 }; }
    function contactY() { return benchY - D; }
    function move(dy) { sqY = clamp(sqY + dy, 8, contactY()); }
    return {
      world: { w: 30, h: 40 }, eye: null, instrument: sq,
      eyeNote: 'The edge of the set square touches the scale, so there is no gap and no parallax.',
      task: 'A ball rests on the bench next to a vertical 30 cm rule whose zero is on the bench. Slide the set square down the rule until its lower edge just touches the top of the ball, then read the height <em>H</em> of the top of the ball.',
      answer: { label: 'H / cm', example: '5.6' },
      zoomTargets: function () { return [{ label: 'Zoom to the set-square corner', x: 18.4, y: sqY, scale: 110 }]; },
      draw: function (g, view) {
        drawBench(g, 0, 30, benchY, view);
        rule.draw(g, rulePlace, view);
        sphere(g, ballX, benchY - D / 2, D / 2, '#9aa7b5', view);
        sq.draw(g, sqPlace(), view);
      },
      controls: function (el, api) {
        el.appendChild(api.row(
          api.hold('▲ Slide up', function () { move(-0.05); }),
          api.hold('▼ Slide down', function () { move(0.05); if (sqY >= contactY()) api.announce('The set square is touching the ball.'); })
        ));
      },
      pointer: {
        hover: function (p) { return sq.contains(sqPlace(), p); },
        down: function (p) { if (!sq.contains(sqPlace(), p)) return false; drag = p.y - sqY; return true; },
        move: function (p) { if (drag !== null) sqY = clamp(p.y - drag, 8, contactY()); },
        up: function () { drag = null; }
      },
      check: function (str) {
        var touching = sqY >= contactY() - 0.02;
        var edgeReading = benchY - sqY;
        return judge(str, { truth: D, res: 0.1, tol: 0.05, unit: 'cm', dp: 1, example: '5.6',
          alts: touching ? [] : [{ value: edgeReading, title: 'Not touching yet', msg: 'You read the rule at the edge of the set square, but the set square is not touching the ball. Slide it down until it stops on the ball.' }] });
      },
      reveal: function () { return 'H = <strong>' + fmt(D, 0.1) + ' cm</strong> (true value ' + D.toFixed(2) + ' cm — this is also the diameter of the ball).'; }
    };
  });

  /* ---------- Vernier callipers ---------- */
  sandbox('vernier', 'Vernier callipers', 'Length', function (env) {
    var o = env.rng.fork('object');
    var fine = o.chance(0.5);
    var v = INS().create('vernier', { resolution: fine ? 0.02 : 0.1, zeroErrorChance: 0.5 }, env.rng.fork('instrument'));
    var res = v.resolution;
    var d = U().roundTo(o.uniform(9, 29), 0.0001);
    var present = true;
    var opening = U().roundTo(d + o.uniform(8, 20), 0.01);
    var place = { x: 2.5, y: 2.5 };
    var drag = null, api = null;
    function minOpening() { return present ? d : 0; }
    function setOpening(x) {
      var before = opening;
      opening = clamp(x, minOpening(), 150);
      if (present && opening <= d + 1e-9 && before > d + 1e-9 && api) api.announce('The jaws are touching the object.');
    }
    return {
      world: { w: 26, h: 9 }, eye: null, instrument: v,
      eyeNote: 'The vernier scale lies almost in the plane of the main scale, so parallax is small: look straight at the marks that coincide.',
      task: 'Measure the diameter <em>d</em> of the ball with these ' + (fine ? '0.02 mm' : '0.1 mm') + ' vernier callipers. Drag the sliding jaw (or use the buttons) until it touches the ball. Check the zero first!',
      answer: { label: 'd / mm', example: fine ? '18.36' : '18.4' },
      zoomTargets: function () {
        return [{ label: 'Zoom to the scales', x: v.vernierZeroX(place, { opening: opening }) + v.vernierLength / 20, y: place.y, scale: fine ? 160 : 120 },
          { label: 'Zoom to the jaws', x: place.x + opening / 20, y: place.y + 2.5, scale: 40 }];
      },
      draw: function (g, view) {
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(0, 0, 26, 9);
        if (present) sphere(g, place.x + d / 20, place.y + 2.4, d / 20, '#b7a26a', view);
        v.draw(g, place, view, { opening: opening });
      },
      controls: function (el, a) {
        api = a;
        el.appendChild(a.row(
          a.hold('◀ Close', function (n) { setOpening(opening - (n > 20 ? 1 : n > 6 ? 0.3 : 0.05)); }),
          a.hold('Open ▶', function (n) { setOpening(opening + (n > 20 ? 1 : n > 6 ? 0.3 : 0.05)); }),
          a.button('Close the jaws fully', function () { setOpening(0); })
        ));
        el.appendChild(a.row(a.toggle('Remove the ball (to check the zero)', 'Put the ball back', function (pressed) {
          present = !pressed;
          if (present && opening < d) opening = U().roundTo(d + 5, 0.01);
          a.announce(present ? 'The ball is back between the jaws.' : 'The ball has been removed.');
        })));
      },
      pointer: {
        hover: function (p) { return v.sliderContains(place, { opening: opening }, p); },
        down: function (p) {
          if (!v.sliderContains(place, { opening: opening }, p)) return false;
          drag = p.x - v.jawFaces(place, { opening: opening }).moving;
          return true;
        },
        move: function (p) { if (drag !== null) setOpening(v.openingForX(place, p.x - drag)); },
        up: function () { drag = null; }
      },
      check: function (str, ctx) {
        if (!present) return { status: 'bad', title: 'Put the ball back', lines: ['Measure the ball: put it back between the jaws and close them onto it.'] };
        var e = v.zeroError;
        var touching = opening <= d + res / 2;
        var alts = [];
        if (Math.abs(e) >= res / 2) {
          alts.push({ value: v.scaleReading(d), title: 'Zero error not corrected', msg: 'That is what the scales show, but these callipers have a zero error. Remove the ball, close the jaws fully and read the scale: subtract that zero reading from your reading.' });
          alts.push({ value: U().roundTo(d + 2 * e, res), title: 'Zero error added instead of subtracted', msg: 'Corrected reading = reading − zero error. Check the sign of the zero error (vernier zero to the left of the main zero means a negative zero error).' });
        }
        if (!touching) {
          alts.push({ value: v.scaleReading(opening), title: 'The jaws are not touching the ball', msg: 'Close the sliding jaw until it touches the ball before reading.' });
          alts.push({ value: U().roundTo(opening, res), title: 'The jaws are not touching the ball', msg: 'Close the sliding jaw until it touches the ball before reading.' });
        }
        alts.push({ value: d / 10, tol: res / 20, title: 'Units', msg: 'That looks like centimetres. The box asks for millimetres (mm).' });
        return judge(str, { truth: d, res: res, tol: res / 2, unit: 'mm', dp: U().decimalsOf(res), example: fine ? '18.36' : '18.4', alts: alts,
          closeHint: 'Find the vernier mark that lines up best with a main-scale mark.',
          hints: ['Main scale: last millimetre mark before the vernier zero. Vernier: the mark that lines up exactly × ' + num(res) + ' mm.'] });
      },
      reveal: function () {
        var dc = v.decompose(d);
        return 'd = <strong>' + fmt(U().quantize(d, res), res) + ' mm</strong>. The scales read ' + fmt(dc.reading, res) + ' mm (main ' + dc.main + ' mm, vernier division ' + dc.division + ') and the zero error is ' + (v.zeroError > 0 ? '+' : '') + fmt(v.zeroError, res) + ' mm. True diameter ' + d.toFixed(3) + ' mm.';
      }
    };
  });

  /* ---------- Micrometer ---------- */
  sandbox('micrometer', 'Micrometer screw gauge', 'Length', function (env) {
    var o = env.rng.fork('object');
    var m = INS().create('micrometer', { zeroErrorChance: 0.6 }, env.rng.fork('instrument'));
    var wire = o.chance(0.5);
    var d = U().roundTo(wire ? o.uniform(0.22, 0.95) : o.uniform(2.0, 9.5), 0.0001);
    var present = true;
    var gap = U().roundTo(d + o.uniform(1.5, 4), 0.001);
    var place = { x: 2.5, y: 2.8 };
    var drag = null, api = null;
    function setGap(x) {
      var before = gap;
      gap = clamp(x, present ? d : 0, 25);
      if (present && gap <= d + 1e-9 && before > d + 1e-9 && api) api.announce('The ratchet clicks: the spindle is touching the ' + (wire ? 'wire' : 'ball bearing') + '.');
    }
    return {
      world: { w: 13.5, h: 7 }, eye: 'vertical', instrument: m,
      task: 'Measure the diameter <em>d</em> of the ' + (wire ? 'wire' : 'ball bearing') + '. Drag the thimble (up/down turns it, left/right slides it) or use the buttons; the ratchet stops it on contact. Check the zero first.',
      answer: { label: 'd / mm', example: '0.47' },
      zoomTargets: function () { return [{ label: 'Zoom to the sleeve and thimble', x: m.thimbleEdgeX(place, { gap: gap }) + 0.1, y: place.y, scale: 200 }]; },
      draw: function (g, view) {
        g.fillStyle = 'rgba(255,255,255,0.3)';
        g.fillRect(0, 0, 13.5, 7);
        if (present) {
          if (wire) {
            g.fillStyle = '#b8733a';
            g.fillRect(place.x, 0.1, d / 10, place.y + 0.5);
            g.fillStyle = 'rgba(255,255,255,0.35)';
            g.fillRect(place.x + d / 40, 0.1, d / 60, place.y + 0.5);
          } else {
            sphere(g, place.x + d / 20, place.y, d / 20, '#c0c6cc', view);
          }
        }
        m.draw(g, place, view, { gap: gap });
      },
      controls: function (el, a) {
        api = a;
        el.appendChild(a.row(
          a.hold('Close ½ turn', function () { setGap(gap - 0.5); }),
          a.hold('Close 1 div', function () { setGap(gap - 0.01); }),
          a.hold('Open 1 div', function () { setGap(gap + 0.01); }),
          a.hold('Open ½ turn', function () { setGap(gap + 0.5); })
        ));
        el.appendChild(a.row(
          a.button('Close with the ratchet', function () { setGap(0); }),
          a.toggle('Remove the ' + (wire ? 'wire' : 'ball') + ' (to check the zero)', 'Put it back', function (pressed) {
            present = !pressed;
            if (present && gap < d) gap = U().roundTo(d + 1, 0.001);
            a.announce(present ? 'Object replaced.' : 'Object removed.');
          })
        ));
      },
      pointer: {
        hover: function (p) { return m.thimbleContains(place, { gap: gap }, p); },
        down: function (p) { if (!m.thimbleContains(place, { gap: gap }, p)) return false; drag = { x: p.x, y: p.y }; return true; },
        move: function (p) {
          if (!drag) return;
          var dx = p.x - drag.x, dy = p.y - drag.y;
          drag = { x: p.x, y: p.y };
          setGap(gap + dx * 10 + dy / (2 * Math.PI * m.thimbleRadius) * 0.5);
        },
        up: function () { drag = null; }
      },
      check: function (str, ctx) {
        if (!present) return { status: 'bad', title: 'Put the object back', lines: ['Put the object back and close the micrometer on it with the ratchet.'] };
        var e = m.zeroError, alts = [];
        if (Math.abs(e) >= 0.005) {
          alts.push({ value: m.scaleReading(d), title: 'Zero error not corrected', msg: 'That is what the scales show, but this micrometer has a zero error. Remove the object, close it with the ratchet and read it: subtract that zero reading.' });
          alts.push({ value: U().roundTo(d + 2 * e, 0.01), title: 'Zero error added instead of subtracted', msg: 'Corrected reading = reading − zero error. If the thimble zero has not reached the datum line, the zero error is negative.' });
        }
        if (gap > d + 0.005) alts.push({ value: m.scaleReading(gap), title: 'Not touching', msg: 'Close the micrometer on the object with the ratchet before reading.' });
        alts.push({ value: d + 0.5, tol: 0.015, title: 'Half-millimetre scale', msg: 'You are 0.50 mm out: check whether the last half-millimetre mark below the datum line is really uncovered.' });
        alts.push({ value: d - 0.5, tol: 0.015, title: 'Half-millimetre scale', msg: 'You are 0.50 mm out: you missed a half-millimetre mark below the datum line.' });
        alts.push({ value: m.apparentThimble(gap <= d + 0.005 ? d : gap, ctx.view) - e, tol: 0.006, title: 'Parallax error', msg: parallaxMsg(ctx.view, 'Look along the datum line at right angles.') });
        return judge(str, { truth: d, res: 0.01, tol: 0.005, unit: 'mm', dp: 2, example: '0.47', alts: alts,
          hints: ['Sleeve: last mark showing (lower marks add 0.5 mm). Thimble: division on the datum line × 0.01 mm.'] });
      },
      reveal: function () {
        var dc = m.decompose(d);
        return 'd = <strong>' + U().quantize(d, 0.01).toFixed(2) + ' mm</strong>. The gauge reads ' + dc.reading.toFixed(2) + ' mm (sleeve ' + dc.sleeve.toFixed(1) + ' mm + thimble ' + dc.thimbleDivision + ' × 0.01 mm); zero error ' + (m.zeroError > 0 ? '+' : '') + m.zeroError.toFixed(2) + ' mm. True diameter ' + d.toFixed(3) + ' mm.';
      }
    };
  });

  /* ---------- Protractor ---------- */
  sandbox('protractor', 'Protractor', 'Angle', function (env) {
    var p = INS().create('protractor');
    var o = env.rng.fork('object');
    var a1 = o.uniform(-0.3, 0.3);
    var theta = U().roundTo(o.uniform(15, 165), 0.001);
    var a2 = a1 - theta * Math.PI / 180;
    var V = { x: 12, y: 11 };
    var place = { x: 6.5, y: 13.8, rotation: U().roundTo(o.uniform(-0.35, 0.35), 0.001) };
    var drag = null;
    function handle() {
      var r = p.radius + 0.9, a = place.rotation - Math.PI / 2;
      return { x: place.x + r * Math.cos(a), y: place.y + r * Math.sin(a) };
    }
    function nearHandle(q) { var hd = handle(); return Math.hypot(q.x - hd.x, q.y - hd.y) < 0.7; }
    function rot(deg) { place.rotation += deg * Math.PI / 180; }
    return {
      world: { w: 24, h: 17 }, eye: null, instrument: p,
      eyeNote: 'The lines are on the paper under the protractor; look straight down to read it.',
      task: 'Measure the angle <em>θ</em> between the two pencil lines. Drag the protractor to move it; drag the round handle (or use the buttons) to rotate it.',
      answer: { label: 'θ / °', example: '57' },
      zoomTargets: function () { return [{ label: 'Zoom to the vertex', x: V.x, y: V.y - 3, scale: 45 }]; },
      draw: function (g, view) {
        g.fillStyle = '#fbfbf7';
        g.fillRect(0.5, 0.5, 23, 16);
        g.strokeStyle = '#3a3a3a';
        g.lineWidth = lw(view, 0.025);
        g.beginPath();
        g.moveTo(V.x, V.y); g.lineTo(V.x + 10.5 * Math.cos(a1), V.y + 10.5 * Math.sin(a1));
        g.moveTo(V.x, V.y); g.lineTo(V.x + 10.5 * Math.cos(a2), V.y + 10.5 * Math.sin(a2));
        g.stroke();
        p.draw(g, place, view);
        var hd = handle();
        g.beginPath(); g.arc(hd.x, hd.y, 0.45, 0, Math.PI * 2);
        g.fillStyle = 'rgba(11,79,179,0.85)'; g.fill();
        g.strokeStyle = '#ffffff'; g.lineWidth = lw(view, 0.04); g.stroke();
      },
      controls: function (el, a) {
        el.appendChild(a.row(
          a.hold('↺ 1°', function () { rot(-1); }), a.hold('↺ 0.1°', function () { rot(-0.1); }),
          a.hold('↻ 0.1°', function () { rot(0.1); }), a.hold('↻ 1°', function () { rot(1); })
        ));
      },
      pointer: {
        hover: function (q) { return nearHandle(q) || p.contains(place, q); },
        down: function (q) {
          if (nearHandle(q)) { drag = { mode: 'rotate' }; return true; }
          if (p.contains(place, q)) { drag = { mode: 'move', dx: q.x - place.x, dy: q.y - place.y }; return true; }
          return false;
        },
        move: function (q) {
          if (!drag) return;
          if (drag.mode === 'rotate') place.rotation = Math.atan2(q.y - place.y, q.x - place.x) + Math.PI / 2;
          else { place.x = q.x - drag.dx; place.y = q.y - drag.dy; }
        },
        up: function () { drag = null; }
      },
      check: function (str) {
        return judge(str, { truth: theta, res: 1, tol: 0.5, close: 1.5, unit: '°', dp: 0, example: '57',
          alts: [{ value: 180 - theta, title: 'Wrong scale', msg: 'You read the other scale, giving 180° minus the angle. Start from the 0 that lies on one line and follow that same scale round.' }],
          hints: ['Put the centre mark on the vertex and the baseline along one line before reading.'] });
      },
      reveal: function () { return 'θ = <strong>' + Math.round(theta) + '°</strong> (true angle ' + theta.toFixed(1) + '°).'; }
    };
  });

  /* ---------- Balance ---------- */
  sandbox('balance', 'Top-pan balance', 'Mass', function (env) {
    var o = env.rng.fork('object');
    var fine = o.chance(0.5);
    var b = INS().create('balance', { resolution: fine ? 0.01 : 0.1, zeroErrorChance: 0.8 }, env.rng.fork('instrument'));
    var res = b.resolution;
    var mTrue = U().roundTo(fine ? o.uniform(5, 180) : o.uniform(20, 450), 0.0001);
    var onPan = false, power = true;
    var place = { x: 12, y: 6 };
    var benchY = 13.55, api = null;
    function load() { return onPan ? mTrue : 0; }
    function tare() { if (!power) return; b.tare(load()); if (api) api.announce('Balance tared.'); }
    function stone(g, x, y, view) {
      var w = 2.4 + Math.cbrt(mTrue) * 0.45;
      g.beginPath();
      g.moveTo(x - w / 2, y); g.quadraticCurveTo(x - w / 2 - 0.3, y - w * 0.45, x - w * 0.1, y - w * 0.55);
      g.quadraticCurveTo(x + w * 0.45, y - w * 0.6, x + w / 2, y - w * 0.15); g.lineTo(x + w / 2, y); g.closePath();
      g.fillStyle = '#7d7468'; g.fill();
      g.strokeStyle = '#3e3933'; g.lineWidth = lw(view, 0.02); g.stroke();
    }
    function inTare(p) { return p.x >= place.x + 1.6 && p.x <= place.x + 4.4 && p.y >= place.y + 5.1 && p.y <= place.y + 6.2; }
    return {
      world: { w: 30, h: 16 }, eye: null, instrument: b, animated: true,
      eyeNote: 'A digital display has no parallax.',
      task: 'Find the mass <em>m</em> of the stone. Make sure the balance reads zero before you use it.',
      answer: { label: 'm / g', example: fine ? '25.40' : '125.4' },
      zoomTargets: [{ label: 'Zoom to the display', x: place.x, y: place.y + 3.3, scale: 45 }],
      draw: function (g, view) {
        drawBench(g, 0, 30, benchY, view);
        b.draw(g, place, view, { load: load(), now: view.now, on: power });
        if (onPan) stone(g, place.x, place.y, view); else stone(g, 26.5, benchY, view);
      },
      controls: function (el, a) {
        api = a;
        el.appendChild(a.row(
          a.toggle('Put the stone on the pan', 'Take the stone off', function (pressed) { onPan = pressed; a.announce(pressed ? 'Stone on the pan.' : 'Stone removed.'); }),
          a.button('TARE (zero)', tare),
          a.button('Switch off and on again', function () { b.untare(); a.announce('The balance restarted (not tared).'); })
        ));
      },
      pointer: { hover: inTare, down: function (p) { if (inTare(p)) { tare(); return true; } return false; }, move: function () {}, up: function () {} },
      check: function (str) {
        if (!onPan) return { status: 'bad', title: 'Nothing on the pan', lines: ['Put the stone on the pan, wait for the reading to settle, then record it.'] };
        var alts = [];
        if (Math.abs(b.tareRef - (mTrue + b.zeroError)) < 1e-9) {
          alts.push({ value: 0, title: 'Tared with the stone on the pan', msg: 'Pressing TARE with the stone on the pan makes it read zero. Take the stone off, tare the empty balance, then put the stone back.' });
        } else if (Math.abs(b.tareRef - b.zeroError) > 1e-9) {
          alts.push({ value: mTrue + b.zeroError - b.tareRef, strict: true, title: 'Balance not zeroed', msg: 'The balance did not read zero with an empty pan. Take the stone off, press TARE, then weigh the stone again.' });
        }
        return judge(str, { truth: mTrue, res: res, tol: res, close: 2.5 * res, unit: 'g', dp: U().decimalsOf(res), example: fine ? '25.40' : '125.4', alts: alts });
      },
      reveal: function () { return 'm = <strong>' + fmt(U().quantize(mTrue, res), res) + ' g</strong> (true mass ' + mTrue.toFixed(3) + ' g; the untared offset was ' + fmt(b.zeroError, res) + ' g).'; }
    };
  });

  /* ---------- Measuring cylinder ---------- */
  sandbox('cylinder', 'Measuring cylinder', 'Volume', function (env) {
    var o = env.rng.fork('object');
    var pour = env.rng.fork('pour');
    var big = o.chance(0.4);
    var c = INS().create('cylinder', { capacity: big ? 250 : 100 }, env.rng.fork('instrument'));
    var res = c.resolution;
    var V = U().roundTo(o.uniform(0.2, 0.9) * c.capacity, 0.001);
    var place = big ? { x: 8, y: 28.5 } : { x: 7, y: 23.5 };
    var api = null;
    function add(dv) {
      V = U().roundTo(clamp(V + dv, 3, c.capacity * 1.02), 0.001);
      if (api) api.announce(dv > 0 ? 'Liquid poured in.' : 'Some liquid poured out.');
    }
    return {
      world: big ? { w: 16, h: 30 } : { w: 14, h: 25 }, eye: 'vertical', instrument: c,
      task: 'Read the volume <em>V</em> of liquid in the ' + c.capacity + ' cm³ measuring cylinder. Pour some in or out to practise more readings.',
      answer: { label: 'V / cm³', example: big ? '136' : '64' },
      zoomTargets: function () { return [{ label: 'Zoom to the meniscus', x: place.x, y: c.levelY(place, V), scale: 90 }]; },
      draw: function (g, view) {
        drawBench(g, 0, big ? 16 : 14, place.y, view);
        c.draw(g, place, view, { volume: V });
      },
      controls: function (el, a) {
        api = a;
        var step = big ? 2 : 1;
        el.appendChild(a.row(
          a.button('Pour in a little', function () { add(pour.uniform(1.5, 5) * step); }),
          a.button('Pour in more', function () { add(pour.uniform(8, 20) * step); }),
          a.button('Pour some out', function () { add(-pour.uniform(3, 15) * step); })
        ));
      },
      check: function (str, ctx) {
        return judge(str, { truth: V, res: res, tol: res / 2, close: 1.5 * res, unit: 'cm³', dp: [0, 1], example: big ? '136' : '64',
          alts: [{ value: c.apparentReading(V, ctx.view), title: 'Parallax error', msg: parallaxMsg(ctx.view, 'The bottom of the meniscus is in the middle of the liquid, behind the scale.') },
            { value: V + c.meniscusRise * c.area, title: 'Top of the meniscus', msg: 'You read where the liquid touches the glass. Read the bottom of the curved meniscus.' }],
          hints: ['First work out the value of one division: count the marks between two numbered marks.'] });
      },
      reveal: function () { return 'V = <strong>' + num(U().quantize(V, res)) + ' cm³</strong> (true volume ' + V.toFixed(1) + ' cm³).'; }
    };
  });

  /* ---------- Thermometer ---------- */
  sandbox('thermometer', 'Thermometer', 'Temperature', function (env) {
    var o = env.rng.fork('object');
    var th = INS().create('thermometer', { initial: 24, zeroErrorChance: 0.45 }, env.rng.fork('instrument'));
    var Tw = U().roundTo(o.uniform(16, 88), 0.001);
    var room = 24, where = 'air';
    var benchY = 34, api = null, buttons = {};
    function place() {
      if (where === 'water') return { x: 8.6, y: 32.6 };
      if (where === 'ice') return { x: 20, y: 32.6 };
      return { x: 1.8, y: 31.5 };
    }
    function env2() { return where === 'water' ? Tw : where === 'ice' ? 0 : room; }
    function go(w) {
      where = w;
      Object.keys(buttons).forEach(function (k) { buttons[k].setAttribute('aria-pressed', k === w ? 'true' : 'false'); });
      if (api) api.announce(w === 'water' ? 'Thermometer in the water. Wait for the reading to settle.' : w === 'ice' ? 'Thermometer in melting ice.' : 'Thermometer in the air.');
    }
    return {
      world: { w: 26, h: 38 }, eye: 'vertical', animated: true, instrument: th,
      task: 'Find the temperature <em>θ</em> of the water in the beaker. The thermometer takes time to respond. You can check its zero in a beaker of melting ice.',
      answer: { label: 'θ / °C', example: '57' },
      zoomTargets: function () { var pl = place(); return [{ label: 'Zoom to the top of the column', x: pl.x, y: th.yFor(pl, th.indicate()), scale: 80 }]; },
      update: function (dt) { th.update(dt, env2()); },
      draw: function (g, view) {
        drawBench(g, 0, 26, benchY, view);
        beaker(g, 8.5, benchY, 9, 9.5, 27, view);
        beaker(g, 20, benchY, 6, 5.5, 29.6, view, { water: 'rgba(170,205,235,0.45)' });
        g.fillStyle = 'rgba(240,248,255,0.9)';
        [[18.0, 29.8], [20.6, 30.4], [19.2, 31.6], [21.2, 32.2]].forEach(function (q) { g.fillRect(q[0], q[1], 1.1, 0.9); });
        th.draw(g, place(), view);
        g.fillStyle = 'rgba(80,150,230,0.12)';
        g.fillRect(4.15, 27, 8.7, benchY - 27.15);
        U().text(g, 'water', 8.5, 33.2, 0.5, { colour: '#1b3a5c', weight: '600' });
        U().text(g, 'melting ice', 20, 33.4, 0.42, { colour: '#1b3a5c', weight: '600' });
      },
      controls: function (el, a) {
        api = a;
        buttons.water = a.button('Put it in the water', function () { go('water'); });
        buttons.ice = a.button('Put it in melting ice', function () { go('ice'); });
        buttons.air = a.button('Take it out', function () { go('air'); });
        Object.keys(buttons).forEach(function (k) { buttons[k].setAttribute('aria-pressed', k === where ? 'true' : 'false'); });
        el.appendChild(a.row(buttons.water, buttons.ice, buttons.air));
      },
      check: function (str, ctx) {
        if (where !== 'water') return { status: 'bad', title: 'Thermometer not in the water', lines: ['Put the thermometer in the water and wait for the reading to stop changing.'] };
        var e = th.zeroError, alts = [];
        var steady = Math.abs(th.temperature - Tw) < 0.4;
        if (!steady) alts.push({ value: th.indicate() - e, tol: 1.5, title: 'Reading still changing', msg: 'The bulb has not yet reached the temperature of the water. Wait until the column stops moving, then read it.' });
        if (Math.abs(e) >= 0.5) alts.push({ value: Tw + e, title: 'Zero error not corrected', msg: 'Your reading matches the scale, but this thermometer does not read 0 °C in melting ice. Subtract its zero error.' });
        alts.push({ value: th.apparentReading(Tw + e, ctx.view) - e, title: 'Parallax error', msg: parallaxMsg(ctx.view, 'The column is inside the glass, behind the scale.') });
        alts.push({ value: th.apparentReading(Tw + e, ctx.view), title: 'Parallax and zero error', msg: parallaxMsg(ctx.view, 'Also correct for the zero error found in melting ice.') });
        return judge(str, { truth: Tw, res: 1, tol: 0.5, close: 1.5, unit: '°C', dp: [0, 1], example: '57', alts: alts });
      },
      reveal: function () { return 'θ = <strong>' + Math.round(Tw) + ' °C</strong> (true ' + Tw.toFixed(1) + ' °C; zero error ' + (th.zeroError > 0 ? '+' : '') + th.zeroError + ' °C).'; }
    };
  });

  /* ---------- Stopwatch: timing oscillations ---------- */
  sandbox('stopwatch', 'Stopwatch', 'Time', function (env) {
    var o = env.rng.fork('object');
    var T = U().roundTo(o.uniform(1.05, 1.95), 0.0001);
    var Tlamp = U().roundTo(o.uniform(0.6, 1.5), 0.0001);
    var mode = 'pendulum', fiducial = true;
    var sw = INS().create('stopwatch');
    var widget = null, attemptsBody = null, stops = [];
    var t0 = env.now();
    var theta0 = 9 * Math.PI / 180, tau = 220;
    var Leff = 981 * T * T / (4 * Math.PI * Math.PI);
    var pivot = { x: 30, y: 6 };
    var worldH = Math.ceil(Leff + 16);
    var attempts = [];
    function period() { return mode === 'pendulum' ? T : Tlamp; }
    return {
      world: { w: 60, h: worldH }, eye: null, instrument: sw,
      eyeNote: 'Here the uncertainty comes from your reaction time, not from reading a scale.',
      task: 'Use the stopwatch to find the period <em>T</em>. Time one oscillation, then time 10 or 20 and divide — compare the percentage errors. (Space starts/stops, X resets when the sandbox has focus.)',
      animated: true,
      draw: function (g, view) {
        var t = (view.now - t0) / 1000;
        if (mode === 'pendulum') {
          drawBench(g, 0, 60, worldH - 3, view);
          drawStand(g, 12, worldH - 3, 2, view);
          g.fillStyle = '#55606b';
          g.fillRect(12, pivot.y - 0.6, pivot.x - 12, 1.2);
          g.fillStyle = '#b08a5a';
          g.fillRect(pivot.x - 0.8, pivot.y - 1.6, 1.6, 1.6);
          var th = theta0 * Math.exp(-t / tau) * Math.cos(2 * Math.PI * t / T);
          var bx = pivot.x + Leff * Math.sin(th), by = pivot.y + Leff * Math.cos(th);
          g.strokeStyle = '#222'; g.lineWidth = lw(view, 0.05);
          g.beginPath(); g.moveTo(pivot.x, pivot.y); g.lineTo(bx, by); g.stroke();
          sphere(g, bx, by, 1.3, '#9aa7b5', view);
          if (fiducial) {
            g.fillStyle = '#c0392b';
            g.beginPath();
            g.moveTo(pivot.x, pivot.y + Leff + 2.0); g.lineTo(pivot.x - 0.5, pivot.y + Leff + 4.5); g.lineTo(pivot.x + 0.5, pivot.y + Leff + 4.5);
            g.closePath(); g.fill();
            g.fillRect(pivot.x - 0.1, pivot.y + Leff + 4.5, 0.2, worldH - 3 - (pivot.y + Leff + 4.5));
          }
        } else {
          var on = ((t % Tlamp) + Tlamp) % Tlamp < 0.12;
          g.fillStyle = '#2f3740';
          g.fillRect(27, worldH * 0.5 + 3, 6, 4);
          g.beginPath(); g.arc(30, worldH * 0.5, 3, 0, Math.PI * 2);
          g.fillStyle = on ? '#ffd23f' : '#5c5a4c'; g.fill();
          g.strokeStyle = '#222'; g.lineWidth = lw(view, 0.08); g.stroke();
          if (on) {
            g.strokeStyle = 'rgba(255,200,0,0.7)'; g.lineWidth = lw(view, 0.3);
            for (var k = 0; k < 8; k++) {
              var a = k * Math.PI / 4;
              g.beginPath(); g.moveTo(30 + 4 * Math.cos(a), worldH * 0.5 + 4 * Math.sin(a)); g.lineTo(30 + 6 * Math.cos(a), worldH * 0.5 + 6 * Math.sin(a)); g.stroke();
            }
          }
          U().text(g, on ? 'FLASH' : '', 30, worldH * 0.5 + 9, 1.2, { colour: '#7a4b00' });
        }
      },
      controls: function (el, a) {
        var pend = a.button('Swinging pendulum', function () { mode = 'pendulum'; pend.setAttribute('aria-pressed', 'true'); lamp.setAttribute('aria-pressed', 'false'); a.refit(); });
        var lamp = a.button('Flashing lamp', function () { mode = 'lamp'; lamp.setAttribute('aria-pressed', 'true'); pend.setAttribute('aria-pressed', 'false'); a.refit(); });
        pend.setAttribute('aria-pressed', 'true'); lamp.setAttribute('aria-pressed', 'false');
        el.appendChild(a.row(pend, lamp,
          a.button('Release the bob again', function () { t0 = env.now(); a.announce('Bob released.'); }),
          a.toggle('Hide the fiducial marker', 'Show the fiducial marker', function (pressed) { fiducial = !pressed; })));
        var swBox = h('div', { class: 'vi-swbox' });
        el.appendChild(swBox);
        widget = INS().stopwatchWidget(swBox, sw, {
          now: env.now,
          onEvent: function (kind, info) { if (kind === 'stop') stops.push(info.display); }
        });
      },
      customAnswer: function (el, a) {
        var nIn = h('input', { class: 'vi-input vi-input--short', id: a.uid('n'), inputmode: 'numeric', autocomplete: 'off' });
        var tIn = h('input', { class: 'vi-input', id: a.uid('t'), inputmode: 'decimal', autocomplete: 'off' });
        var fb = h('div', { class: 'vi-feedback', role: 'status', 'aria-live': 'polite' });
        var form = h('form', { class: 'vi-answer', novalidate: true },
          h('div', { class: 'vi-field' }, h('label', { for: nIn.id }, 'number of ' + (mode === 'lamp' ? 'intervals' : 'oscillations') + ' timed, n'), nIn),
          h('div', { class: 'vi-field' }, h('label', { for: tIn.id }, 'total time t / s'), tIn),
          h('button', { type: 'submit', class: 'vi-btn vi-btn--primary' }, 'Check my timing'));
        attemptsBody = h('tbody');
        var table = h('table', { class: 'vi-attempts' },
          h('caption', {}, 'Your timings (true period hidden)'),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'n'), h('th', { scope: 'col' }, 't / s'), h('th', { scope: 'col' }, 'T = t/n / s'), h('th', { scope: 'col' }, 'error / %'))),
          attemptsBody);
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var n = parseInt(nIn.value, 10);
          var tp = parseTyped(tIn.value);
          var res;
          if (!(n >= 1 && n <= 200) || String(n) !== nIn.value.trim()) res = { status: 'bad', title: 'Number of oscillations', lines: ['Type n as a whole number, e.g. 20.'] };
          else if (!tp.ok) res = parseProblem(tp, '31.42');
          else {
            var Ts = tp.value / n, P = period();
            var pct = (Ts - P) / P * 100;
            var matched = stops.some(function (s) { return Math.abs(stopSeconds(s) - tp.value) < 0.006; });
            var lines = ['Your period T = ' + esc(tp.str) + ' s ÷ ' + n + ' = <strong>' + Ts.toFixed(3) + ' s</strong>, which is <strong>' + Math.abs(pct).toFixed(1) + ' %</strong> ' + (pct >= 0 ? 'above' : 'below') + ' the true period.'];
            if (!matched) lines.push('Note: that is not a time your stopwatch showed when you stopped it. Record exactly what the display shows (convert 1:02.35 to 62.35 s).');
            if (tp.dp !== 2) lines.push('Record stopwatch times to 0.01 s (two decimal places), as displayed.');
            if (n < 10) lines.push('With only ' + n + ' oscillation' + (n === 1 ? '' : 's') + ', your reaction time (about 0.1–0.2 s) is a large fraction of the time measured. Time at least 10, preferably 20, and divide.');
            else lines.push('Timing ' + n + ' oscillations shares your reaction-time error between all of them, so the error in T is small. Repeat and average for an even better value.');
            res = { status: Math.abs(pct) < 1 ? 'ok' : Math.abs(pct) < 3 ? 'close' : 'bad', title: Math.abs(pct) < 1 ? 'Good timing' : Math.abs(pct) < 3 ? 'Fair timing' : 'Large timing error', lines: lines };
            attempts.push({ n: n, t: tp.str, T: Ts, pct: pct });
            attemptsBody.appendChild(h('tr', {}, h('td', {}, String(n)), h('td', {}, tp.str), h('td', {}, Ts.toFixed(3)), h('td', {}, (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(1))));
          }
          a.renderFeedback(fb, res);
        });
        el.appendChild(form);
        el.appendChild(fb);
        el.appendChild(table);
      },
      onKey: function (ev) {
        if (!widget) return false;
        if (ev.key === ' ' || ev.key === 'Spacebar') { widget.toggle(); return true; }
        if (ev.key === 'x' || ev.key === 'X') { widget.reset(); return true; }
        return false;
      },
      reveal: function () { return 'True period: pendulum T = <strong>' + T.toFixed(3) + ' s</strong>; lamp interval = <strong>' + Tlamp.toFixed(3) + ' s</strong>.'; },
      destroy: function () { if (widget) widget.destroy(); }
    };
  });

  function stopSeconds(display) {
    var parts = String(display).split(':').map(Number);
    return parts.reduce(function (acc, v) { return acc * 60 + v; }, 0);
  }

  /* ---------- Light-gate timer ---------- */
  sandbox('lightGateTimer', 'Light-gate timer', 'Time', function (env) {
    var lg = INS().create('lightGateTimer');
    var speeds = env.rng.fork('object');
    var card = U().roundTo(speeds.uniform(4, 10), 0.01);
    var run = null, measured = false, api = null;
    var gateX = 40, trackY = 20, startLead = 4 + card + 2;
    return {
      world: { w: 70, h: 26 }, eye: null, animated: true, instrument: lg,
      eyeNote: 'A digital display has no parallax.',
      task: 'Release the trolley. The card on top of it interrupts the light beam and the timer records how long the beam is blocked. Read the time <em>t</em>.',
      answer: { label: 't / s', example: '0.125' },
      zoomTargets: [{ label: 'Zoom to the timer display', x: 14, y: 8, scale: 40 }],
      update: function (dt, now) {
        if (!run) return;
        var tEnter = (gateX - run.lead0) / run.v, tExit = tEnter + card / run.v;
        if (!run.started && now >= run.t0 + tEnter * 1000) { lg.reset(); lg.start(run.t0 + tEnter * 1000); run.started = true; }
        if (run.started && !run.stopped && now >= run.t0 + tExit * 1000) { lg.stop(run.t0 + tExit * 1000); run.stopped = true; measured = true; if (api) api.announce('The timer has stopped.'); }
      },
      draw: function (g, view) {
        drawBench(g, 0, 70, trackY + 3.2, view);
        g.fillStyle = '#8d97a1';
        g.fillRect(1, trackY + 2.4, 68, 0.8);
        var lead = run ? Math.min(run.lead0 + run.v * (view.now - run.t0) / 1000, 90) : startLead;
        var tb = lead - card - 2;
        g.fillStyle = '#2f6db5';
        g.fillRect(tb, trackY - 0.6, card + 4, 2.4);
        g.fillStyle = '#1b1f23';
        [tb + 1, tb + card + 3].forEach(function (wx) { g.beginPath(); g.arc(wx, trackY + 2.0, 0.55, 0, Math.PI * 2); g.fill(); });
        g.fillStyle = '#222';
        g.fillRect(lead - card, trackY - 6.5, card, 5.9);
        // Light gate (U-shaped) with its beam.
        g.fillStyle = '#3d4650';
        g.fillRect(gateX - 1.2, trackY - 9, 2.4, 1.2);
        g.fillRect(gateX - 1.2, trackY - 9, 0.5, 9.5);
        g.fillRect(gateX + 0.7, trackY - 9, 0.5, 9.5);
        var blocked = lead >= gateX && lead - card <= gateX;
        g.strokeStyle = blocked ? 'rgba(200,0,0,0.25)' : 'rgba(220,0,0,0.85)';
        g.lineWidth = lw(view, 0.08);
        g.setLineDash([0.3, 0.2]);
        g.beginPath(); g.moveTo(gateX - 0.7, trackY - 3.5); g.lineTo(gateX + 0.7, trackY - 3.5); g.stroke();
        g.setLineDash([]);
        g.strokeStyle = '#222'; g.lineWidth = lw(view, 0.06);
        g.beginPath(); g.moveTo(gateX, trackY - 9); g.quadraticCurveTo(gateX - 8, trackY - 16, 14, 11); g.stroke();
        lg.draw(g, { x: 14, y: 8 }, view, { now: view.now });
      },
      controls: function (el, a) {
        api = a;
        el.appendChild(a.row(
          a.button('Release the trolley', function () {
            if (run && !run.stopped) return;
            lg.reset(); measured = false;
            run = { t0: env.now(), v: U().roundTo(speeds.uniform(18, 75), 0.01), lead0: startLead, started: false, stopped: false };
            a.announce('Trolley released.');
          }),
          a.button('Reset the timer', function () { lg.reset(); measured = false; })
        ));
      },
      check: function (str) {
        if (!measured) return { status: 'bad', title: 'No time recorded yet', lines: ['Release the trolley and wait for the timer to stop.'] };
        return judge(str, { truth: lg.reading(), res: 0.001, tol: 0.0005, unit: 's', dp: 3, example: '0.125',
          alts: [{ value: U().roundTo(lg.reading(), 0.01), tol: 0.0051, title: 'Record all the digits', msg: 'The timer resolves 0.001 s: record all three decimal places shown.' }] });
      },
      reveal: function () { return measured ? 't = <strong>' + lg.display() + ' s</strong>.' : 'Release the trolley first.'; }
    };
  });

  /* ---------- Analogue meter ---------- */
  sandbox('analogueMeter', 'Analogue meter', 'Electrical', function (env) {
    var o = env.rng.fork('object');
    var kind = o.chance(0.5) ? 'A' : 'V';
    var cfg = kind === 'A' ? (o.chance(0.5) ? { max: 1, minor: 0.02 } : { max: 0.5, minor: 0.01 })
      : (o.chance(0.5) ? { max: 5, minor: 0.1 } : { max: 3, minor: 0.1 });
    var m = INS().create('analogueMeter', { kind: kind, range: cfg, zeroErrorChance: 0.5 }, env.rng.fork('instrument'));
    var adj = env.rng.fork('adjust');
    function newValue() { return U().roundTo(adj.uniform(0.12, 0.95) * cfg.max, 0.00001); }
    var value = newValue(), on = true, api = null;
    m.settle(value);
    var place = { x: 8, y: 6.4 };
    var q = kind === 'A' ? 'I' : 'V';
    return {
      world: { w: 16, h: 13 }, eye: 'meter', animated: true, instrument: m,
      task: 'Read the ' + (kind === 'A' ? 'current <em>I</em>' : 'potential difference <em>V</em>') + ' shown by the meter. Check the needle with the circuit switched off first, and use the mirror strip.',
      answer: { label: q + ' / ' + m.unit, example: kind === 'A' ? '0.62' : '2.35' },
      zoomTargets: function () {
        var th = m.angleFor(m.needle);
        return [{ label: 'Zoom to the needle tip', x: place.x + Math.sin(th) * 5.6, y: place.y + 2.4 - Math.cos(th) * 5.6, scale: 110 }];
      },
      update: function (dt) { m.update(dt, on ? value : 0); },
      draw: function (g, view) {
        g.strokeStyle = '#c0392b'; g.lineWidth = lw(view, 0.15);
        g.beginPath(); g.moveTo(place.x - 3.6, place.y + 3.6); g.lineTo(place.x - 3.6, 12.8); g.stroke();
        g.strokeStyle = '#1b1f23';
        g.beginPath(); g.moveTo(place.x + 3.6, place.y + 3.6); g.lineTo(place.x + 3.6, 12.8); g.stroke();
        m.draw(g, place, view);
      },
      controls: function (el, a) {
        api = a;
        el.appendChild(a.row(
          a.toggle('Switch off (check the zero)', 'Switch on', function (pressed) { on = !pressed; a.announce(on ? 'Circuit on.' : 'Circuit off.'); }),
          a.button('Change the ' + (kind === 'A' ? 'current' : 'voltage'), function () { value = newValue(); a.announce('Value changed.'); })
        ));
      },
      check: function (str, ctx) {
        if (!on) return { status: 'bad', title: 'Circuit switched off', lines: ['Switch the circuit on to take a reading.'] };
        var e = m.zeroError, res = cfg.minor, alts = [];
        if (Math.abs(m.needle - m.indicate(value)) > res / 4) return { status: 'bad', title: 'Wait for the needle', lines: ['The needle is still moving: wait for it to settle, then read it.'] };
        if (Math.abs(e) >= res / 2) alts.push({ value: value + e, title: 'Zero error not corrected', msg: 'With the circuit switched off the needle does not rest on zero. Subtract that zero reading from your reading.' });
        var app = m.apparentValue(value + e, ctx.view);
        alts.push({ value: app - e, title: 'Parallax error', msg: 'Your eye was ' + eyeWords(ctx.view.eyeAngle, 'meter') + '. Move until the needle hides its own reflection in the mirror strip, then read.' });
        alts.push({ value: app, title: 'Parallax and zero error', msg: 'Line the needle up with its reflection in the mirror, and subtract the zero reading.' });
        return judge(str, { truth: value, res: res, tol: res / 2, close: 1.5 * res, unit: m.unit, dp: [U().decimalsOf(res), U().decimalsOf(res / 2)], example: kind === 'A' ? '0.62' : '2.35', alts: alts,
          hints: ['Find the value of one small division from two numbered marks first.'] });
      },
      reveal: function () { return q + ' = <strong>' + fmt(U().quantize(value, res2()), res2()) + ' ' + m.unit + '</strong> (true ' + value.toFixed(4) + ' ' + m.unit + '; zero error ' + num(m.zeroError) + ' ' + m.unit + ').'; }
    };
    function res2() { return cfg.minor / 2; }
  });

  /* ---------- Digital multimeter ---------- */
  sandbox('digitalMeter', 'Digital multimeter', 'Electrical', function (env) {
    var o = env.rng.fork('object');
    var kind = o.chance(0.5) ? 'V' : 'A';
    var ranges = kind === 'V' ? ['200 mV', '2 V', '20 V', '200 V'] : ['20 mA', '200 mA', '2 A', '20 A'];
    var m = INS().create('digitalMeter', { range: ranges[ranges.length - 1], zeroErrorChance: 0.5 }, env.rng.fork('instrument'));
    var adj = env.rng.fork('adjust');
    var ansUnit = kind === 'V' ? 'V' : 'mA', ansSI = kind === 'V' ? 1 : 1e-3;
    function newValue() {
      var lo = kind === 'V' ? Math.log(0.05) : Math.log(0.004), hi = kind === 'V' ? Math.log(15) : Math.log(1.6);
      return Math.exp(adj.uniform(lo, hi));
    }
    var valueSI = newValue(), shorted = false;
    var place = { x: 6, y: 9 };
    function shown(now) { return shorted ? m.display(0, now) : m.display(valueSI / m.siFactor, now); }
    function bestRange() {
      for (var i = 0; i < ranges.length; i++) {
        var r = VL.instruments.meterRanges[ranges[i]];
        if (Math.abs(valueSI / r.si + m.zeroDigits * r.resolution) <= r.max) return ranges[i];
      }
      return ranges[ranges.length - 1];
    }
    return {
      world: { w: 12, h: 18 }, eye: null, instrument: m,
      eyeNote: 'A digital display has no parallax.',
      task: 'Read the ' + (kind === 'V' ? 'potential difference <em>V</em> in volts' : 'current <em>I</em> in milliamps') + '. Choose the most sensitive range that does not overload. Join the leads to check the zero.',
      answer: { label: (kind === 'V' ? 'V / V' : 'I / mA'), example: kind === 'V' ? '1.254' : '45.6' },
      zoomTargets: [{ label: 'Zoom to the display', x: place.x, y: place.y - 5, scale: 45 }],
      draw: function (g, view) {
        m.draw(g, place, view, { value: shorted ? 0 : valueSI / m.siFactor, now: view.now });
      },
      animated: true,
      controls: function (el, a) {
        var sel = h('select', { class: 'vi-select', id: a.uid('range') });
        ranges.forEach(function (r) { sel.appendChild(h('option', { value: r }, r)); });
        sel.value = m.rangeName;
        sel.addEventListener('change', function () { m.setRange(sel.value); a.announce('Range ' + sel.value); });
        el.appendChild(a.row(
          h('label', { class: 'vi-field vi-field--inline', for: sel.id }, 'Range ', sel),
          a.toggle('Join the leads (check zero)', 'Reconnect the leads', function (pressed) { shorted = pressed; }),
          a.button('Change the value', function () { valueSI = newValue(); a.announce('Value changed.'); })
        ));
      },
      check: function (str, ctx) {
        if (shorted) return { status: 'bad', title: 'Leads joined', lines: ['Reconnect the leads to the circuit to take a reading.'] };
        if (shown(ctx.view.now) === 'OL') return { status: 'bad', title: 'Overload', lines: ['The display shows OL: the value is larger than this range. Choose a higher range.'] };
        var truth = valueSI / ansSI;
        var digit = m.resolution * m.siFactor / ansSI;
        var e = m.zeroError * m.siFactor / ansSI;
        var alts = [];
        if (Math.abs(m.zeroDigits) >= 2) alts.push({ value: truth + e, strict: true, title: 'Zero offset not subtracted', msg: 'With the leads joined the meter does not read zero. Subtract that zero reading from your reading.' });
        alts.push({ value: truth * 1000, tol: digit * 1000, title: 'Units', msg: 'Check the unit on the display (' + m.unit + ') and convert to ' + ansUnit + '.' });
        alts.push({ value: truth / 1000, tol: digit / 1000, title: 'Units', msg: 'Check the unit on the display (' + m.unit + ') and convert to ' + ansUnit + '.' });
        var fb = judge(str, { truth: truth, res: digit, tol: digit * 1.5, close: digit * 3, unit: ansUnit, dp: U().decimalsOf(digit), example: kind === 'V' ? '1.254' : '45.6', alts: alts });
        var best = bestRange();
        if (fb.status === 'ok' && best !== m.rangeName) {
          fb = { status: 'close', title: 'Correct for this range — use a better one', lines: fb.lines.concat(['The ' + best + ' range would not overload and gives more significant figures. Always use the most sensitive range possible.']) };
        }
        return fb;
      },
      reveal: function () { return 'True value: <strong>' + (valueSI / ansSI).toPrecision(5) + ' ' + ansUnit + '</strong>; best range ' + bestRange() + '; zero offset ' + m.zeroDigits + ' digit(s).'; }
    };
  });

  /* ================================================================== */
  /* Viewport                                                            */
  /* ================================================================== */

  /**
   * Pan/zoom viewport for a canvas. Scale is CSS pixels per world cm.
   * @constructor
   */
  function Viewport() {
    this.cssW = 300; this.cssH = 200; this.dpr = 1;
    this.scale = 10; this.cx = 0; this.cy = 0;
    this.fitScale = 10; this.maxScale = 1500;
    this.world = { w: 10, h: 10 };
  }
  Viewport.prototype.setSize = function (w, h, dpr) { this.cssW = w; this.cssH = h; this.dpr = dpr; };
  Viewport.prototype.fit = function (world) {
    if (world) this.world = world;
    var s = Math.min(this.cssW / this.world.w, this.cssH / this.world.h) * 0.96;
    this.fitScale = this.scale = Math.max(0.5, s);
    this.cx = this.world.w / 2; this.cy = this.world.h / 2;
  };
  Viewport.prototype.toWorld = function (sx, sy) {
    return { x: this.cx + (sx - this.cssW / 2) / this.scale, y: this.cy + (sy - this.cssH / 2) / this.scale };
  };
  Viewport.prototype.zoomAt = function (factor, sx, sy) {
    if (sx === undefined) { sx = this.cssW / 2; sy = this.cssH / 2; }
    var w = this.toWorld(sx, sy);
    this.scale = clamp(this.scale * factor, this.fitScale * 0.5, this.maxScale);
    this.cx = w.x - (sx - this.cssW / 2) / this.scale;
    this.cy = w.y - (sy - this.cssH / 2) / this.scale;
    this.constrain();
  };
  Viewport.prototype.pan = function (dx, dy) { this.cx -= dx / this.scale; this.cy -= dy / this.scale; this.constrain(); };
  Viewport.prototype.focus = function (x, y, scale) {
    this.scale = clamp(scale || this.scale, this.fitScale * 0.5, this.maxScale);
    this.cx = x; this.cy = y; this.constrain();
  };
  Viewport.prototype.constrain = function () {
    this.cx = clamp(this.cx, -this.world.w * 0.1, this.world.w * 1.1);
    this.cy = clamp(this.cy, -this.world.h * 0.1, this.world.h * 1.1);
  };
  Viewport.prototype.apply = function (g) {
    var k = this.dpr * this.scale;
    g.setTransform(k, 0, 0, k, this.dpr * (this.cssW / 2 - this.cx * this.scale), this.dpr * (this.cssH / 2 - this.cy * this.scale));
  };

  /* ================================================================== */
  /* Mount                                                               */
  /* ================================================================== */

  var uidCounter = 0;

  /**
   * Mount the Instrument Lab.
   * @param {HTMLElement} container
   * @param {{initial?: string, seed?: string}} [opts]
   * @returns {{destroy: function(), select: function(string), seed: function(): string}}
   */
  function mount(container, opts) {
    opts = opts || {};
    var cleanups = [];
    function on(t, ev, fn, o) { t.addEventListener(ev, fn, o); cleanups.push(function () { t.removeEventListener(ev, fn, o); }); }
    var labId = 'vi' + (++uidCounter);
    var seed = opts.seed || freshSeed();
    var currentId = null, sb = null, sbCleanups = [];
    var eyeAngle = 0, raf = null, lastT = null, destroyed = false;
    var vp = new Viewport();
    var benchColour = '#dfe6ee', inkColour = '#111418';

    /* ---- DOM ---- */
    var navList = h('ul', { class: 'vi-navlist' });
    var navButtons = {};
    var groups = {};
    SANDBOXES.forEach(function (s) {
      if (!INS() || !INS().types[s.id]) return;
      if (!groups[s.group]) {
        groups[s.group] = h('ul', { class: 'vi-navgroup-list' });
        navList.appendChild(h('li', { class: 'vi-navgroup' }, h('span', { class: 'vi-navgroup-title' }, s.group), groups[s.group]));
      }
      var b = h('button', { type: 'button', class: 'vi-navbtn', 'data-id': s.id }, s.label);
      on(b, 'click', function () { select(s.id); });
      navButtons[s.id] = b;
      groups[s.group].appendChild(h('li', {}, b));
    });
    var nav = h('nav', { class: 'vi-nav', 'aria-label': 'Instruments' }, h('h2', { class: 'vi-nav-title' }, 'Instruments'), navList);

    var titleEl = h('h2', { class: 'vi-title', id: labId + '-title', tabindex: '-1' }, '');
    var seedCode = h('code', { class: 'vi-seed-code' }, seed);
    var newBtn = h('button', { type: 'button', class: 'vi-btn' }, 'New object');
    on(newBtn, 'click', function () { seed = freshSeed(); seedCode.textContent = seed; build(currentId, true); });
    var head = h('header', { class: 'vi-head' }, titleEl,
      h('p', { class: 'vi-seed' }, h('span', {}, 'Sandbox seed '), seedCode, newBtn));

    var tutorial = h('article', { class: 'vi-tutorial', 'aria-labelledby': labId + '-title' });
    var taskEl = h('p', { class: 'vi-task' });
    var canvas = h('canvas', { class: 'vi-canvas', tabindex: '0', role: 'img' });
    var zoomOut = h('button', { type: 'button', class: 'vi-btn vi-btn--icon', 'aria-label': 'Zoom out', title: 'Zoom out (−)' }, '−');
    var zoomIn = h('button', { type: 'button', class: 'vi-btn vi-btn--icon', 'aria-label': 'Zoom in', title: 'Zoom in (+)' }, '+');
    var zoomFit = h('button', { type: 'button', class: 'vi-btn', title: 'Show everything (0)' }, 'Fit');
    var zoomLabel = h('span', { class: 'vi-zoomlabel', 'aria-live': 'off' }, '×1');
    var targetsEl = h('span', { class: 'vi-targets' });
    var stage = h('div', { class: 'vi-stage' }, canvas);
    var zoombar = h('div', { class: 'vi-zoombar', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomIn, zoomFit, zoomLabel, targetsEl);
    var eyeInput = h('input', { type: 'range', min: '-12', max: '12', step: '1', value: '0', id: labId + '-eye', class: 'vi-range' });
    var eyeOut = h('output', { class: 'vi-eye-out', for: eyeInput.id }, '');
    var eyeLabel = h('label', { for: eyeInput.id, class: 'vi-eye-label' }, 'Eye level');
    var eyeRow = h('div', { class: 'vi-eye' }, eyeLabel, eyeInput, eyeOut);
    var eyeNote = h('p', { class: 'vi-eye-note' });
    var controlsEl = h('div', { class: 'vi-controls' });
    var answerEl = h('div', { class: 'vi-answerbox' });
    var srLive = h('div', { class: 'vi-sr-only', role: 'status', 'aria-live': 'polite' });
    var sandboxEl = h('section', { class: 'vi-sandbox', 'aria-label': 'Practice sandbox' },
      h('h3', { class: 'vi-sandbox-title' }, 'Practise'), taskEl, h('div', { class: 'vi-stagewrap' }, stage, zoombar),
      eyeRow, eyeNote, controlsEl, answerEl, srLive);
    var main = h('div', { class: 'vi-main' }, head, h('div', { class: 'vi-body' }, sandboxEl, tutorial));
    // the page heading (h1): the router names the browser tab after it and moves the focus to it
    var pageTitle = h('h1', { class: 'vi-page-title' }, 'Instrument lab');
    var root = h('div', { class: 'vi-lab' }, nav, main);
    container.appendChild(pageTitle);
    container.appendChild(root);

    function announce(msg) {
      srLive.textContent = '';
      setTimeout(function () { srLive.textContent = msg; }, 30);
    }

    /* ---- colours from tokens ---- */
    function readColours() {
      try {
        var cs = globalThis.getComputedStyle(root);
        benchColour = cs.getPropertyValue('--bench').trim() || benchColour;
        inkColour = cs.getPropertyValue('--ink').trim() || inkColour;
      } catch (e) { /* keep defaults */ }
    }

    /* ---- sizing ---- */
    var fitted = false;
    function resize() {
      var w = Math.max(200, Math.floor(stage.clientWidth));
      var hh = Math.max(220, Math.floor(stage.clientHeight));
      var dpr = globalThis.devicePixelRatio || 1;
      var oldFit = vp.fitScale, rel = vp.scale / oldFit;
      vp.setSize(w, hh, dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = hh + 'px';
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(hh * dpr));
      if (!fitted && sb) { vp.fit(sb.world); fitted = true; }
      else if (sb) {
        var cx = vp.cx, cy = vp.cy;
        vp.fit(sb.world);
        vp.focus(cx, cy, vp.fitScale * rel);
      }
      readColours();
      requestDraw();
    }
    var ro = null;
    if (typeof globalThis.ResizeObserver === 'function') {
      ro = new globalThis.ResizeObserver(function () { resize(); });
      ro.observe(stage);
    } else {
      on(globalThis, 'resize', resize);
    }

    /* ---- drawing loop ---- */
    var dirty = true;
    /** Schedule a redraw on the next animation frame (static scenes are only drawn when something changes). */
    function requestDraw() { dirty = true; if (!raf && !destroyed) raf = globalThis.requestAnimationFrame(frame); }
    function currentView(now) {
      return { scale: vp.scale, eyeAngle: sb && sb.eye ? eyeAngle : 0, now: now,
        rect: { x: vp.cx - vp.cssW / 2 / vp.scale, y: vp.cy - vp.cssH / 2 / vp.scale, w: vp.cssW / vp.scale, h: vp.cssH / vp.scale } };
    }
    function frame(t) {
      raf = null;
      if (destroyed) return;
      var now = perfNow();
      var dt = lastT === null ? 0 : Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      if (sb && sb.update) sb.update(dt, now);
      var g = canvas.getContext('2d');
      g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
      g.fillStyle = benchColour;
      g.fillRect(0, 0, vp.cssW, vp.cssH);
      if (sb) {
        vp.apply(g);
        try { sb.draw(g, currentView(now)); } catch (e) { if (globalThis.console) console.error('[instrumentLab draw]', e); }
        g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
        drawScaleBar(g);
      }
      zoomLabel.textContent = '×' + (vp.scale / vp.fitScale).toFixed(vp.scale / vp.fitScale < 10 ? 1 : 0);
      dirty = false;
      // Animated sandboxes (flicker, needle, pendulum, bulb lag) redraw every frame; static ones only on demand.
      if (sb && sb.animated) raf = globalThis.requestAnimationFrame(frame);
      else lastT = null;
    }
    function drawScaleBar(g) {
      var cands = [[100, '1 m'], [10, '10 cm'], [1, '1 cm'], [0.1, '1 mm']];
      var pick = null;
      for (var i = 0; i < cands.length; i++) {
        var px = cands[i][0] * vp.scale;
        if (px <= 160) { pick = [px, cands[i][1]]; break; }
      }
      if (!pick || pick[0] < 12) return;
      var x = 12, y = vp.cssH - 14;
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.fillRect(x - 6, y - 20, pick[0] + 12, 28);
      g.strokeStyle = '#111418'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x, y); g.lineTo(x + pick[0], y); g.lineTo(x + pick[0], y - 4); g.stroke();
      g.fillStyle = '#111418'; g.font = '12px Arial, Helvetica, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillText(pick[1], x, y - 7);
    }

    /* ---- pointer interaction: sandbox drag, pan, pinch, wheel ---- */
    var pointers = {}, mode = null, last = null, pinch = null;
    function local(ev) { var r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
    on(canvas, 'pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      canvas.focus({ preventScroll: true });
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      var p = local(ev);
      pointers[ev.pointerId] = p;
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        if (mode === 'sandbox' && sb.pointer) sb.pointer.up(vp.toWorld(p.x, p.y));
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        mode = 'pinch';
        return;
      }
      var w = vp.toWorld(p.x, p.y);
      if (sb && sb.pointer && sb.pointer.down(w, ev)) { mode = 'sandbox'; canvas.classList.add('vi-canvas--grabbing'); }
      else { mode = 'pan'; canvas.classList.add('vi-canvas--panning'); }
      last = p;
      ev.preventDefault();
    });
    on(canvas, 'pointermove', function (ev) {
      var p = local(ev);
      if (!(ev.pointerId in pointers)) {
        if (sb && sb.pointer && sb.pointer.hover) canvas.classList.toggle('vi-canvas--grab', !!sb.pointer.hover(vp.toWorld(p.x, p.y)));
        return;
      }
      pointers[ev.pointerId] = p;
      if (mode === 'pinch') {
        var ids = Object.keys(pointers);
        if (ids.length < 2) return;
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (pinch.d > 0) vp.zoomAt(d / pinch.d, mx, my);
        vp.pan(mx - pinch.mx, my - pinch.my);
        pinch = { d: d, mx: mx, my: my };
      } else if (mode === 'sandbox') {
        sb.pointer.move(vp.toWorld(p.x, p.y), ev);
      } else if (mode === 'pan' && last) {
        vp.pan(p.x - last.x, p.y - last.y);
      }
      last = p;
      requestDraw();
    });
    function endPointer(ev) {
      if (!(ev.pointerId in pointers)) return;
      var p = local(ev);
      delete pointers[ev.pointerId];
      if (mode === 'sandbox' && sb && sb.pointer) sb.pointer.up(vp.toWorld(p.x, p.y), ev);
      if (Object.keys(pointers).length === 0) { mode = null; pinch = null; }
      else if (mode === 'pinch') { mode = 'pan'; last = pointers[Object.keys(pointers)[0]]; }
      canvas.classList.remove('vi-canvas--grabbing', 'vi-canvas--panning');
    }
    on(canvas, 'pointerup', endPointer);
    on(canvas, 'pointercancel', endPointer);
    on(canvas, 'wheel', function (ev) {
      ev.preventDefault();
      var p = local(ev);
      var dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * 400 : ev.deltaY;
      vp.zoomAt(Math.exp(-dy * 0.0016), p.x, p.y);
      requestDraw();
    }, { passive: false });
    on(canvas, 'keydown', function (ev) {
      var k = ev.key, done = true;
      if (k === '+' || k === '=') vp.zoomAt(1.25);
      else if (k === '-' || k === '_') vp.zoomAt(0.8);
      else if (k === '0') vp.fit();
      else if (k === 'ArrowLeft') vp.pan(40, 0);
      else if (k === 'ArrowRight') vp.pan(-40, 0);
      else if (k === 'ArrowUp') vp.pan(0, 40);
      else if (k === 'ArrowDown') vp.pan(0, -40);
      else if ((k === '[' || k === ']') && sb && sb.eye) setEye(eyeAngle + (k === ']' ? 1 : -1));
      else done = false;
      if (done) { ev.preventDefault(); requestDraw(); }
    });
    on(zoomIn, 'click', function () { vp.zoomAt(1.5); requestDraw(); });
    on(zoomOut, 'click', function () { vp.zoomAt(1 / 1.5); requestDraw(); });
    on(zoomFit, 'click', function () { vp.fit(); requestDraw(); });

    // Lab-level keys (stopwatch Space / X) when focus is inside the sandbox but not typing.
    on(sandboxEl, 'keydown', function (ev) {
      if (!sb || !sb.onKey || (ui.isTyping && ui.isTyping(ev))) return;
      if (ev.target && ev.target.tagName === 'BUTTON' && (ev.key === ' ' || ev.key === 'Enter')) return;
      if (sb.onKey(ev)) { ev.preventDefault(); ev.stopPropagation(); }
    });

    /* ---- eye level ---- */
    function setEye(v) {
      eyeAngle = clamp(Math.round(v), -12, 12);
      eyeInput.value = String(eyeAngle);
      var words = eyeWords(eyeAngle, sb && sb.eye);
      eyeOut.textContent = (eyeAngle === 0 ? '0° — ' : '') + words;
      eyeInput.setAttribute('aria-valuetext', words);
      requestDraw();
    }
    on(eyeInput, 'input', function () { setEye(Number(eyeInput.value)); });

    /* ---- controls API for sandboxes ---- */
    function makeApi() {
      return {
        h: h,
        uid: function (s) { return labId + '-' + s + '-' + (++uidCounter); },
        announce: announce,
        refit: function () { if (sb) { vp.fit(sb.world); requestDraw(); } },
        focus: function (x, y, s) { vp.focus(x, y, s); requestDraw(); },
        renderFeedback: renderFeedback,
        row: function () {
          var r = h('div', { class: 'vi-row' });
          for (var i = 0; i < arguments.length; i++) if (arguments[i]) r.appendChild(arguments[i]);
          return r;
        },
        button: function (label, fn) {
          var b = h('button', { type: 'button', class: 'vi-btn' }, label);
          b.addEventListener('click', function () { fn(); requestDraw(); });
          return b;
        },
        toggle: function (label, pressedLabel, fn) {
          var pressed = false;
          var b = h('button', { type: 'button', class: 'vi-btn vi-btn--toggle', 'aria-pressed': 'false' }, label);
          b.addEventListener('click', function () {
            pressed = !pressed;
            b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
            b.textContent = pressed ? pressedLabel : label;
            fn(pressed);
            requestDraw();
          });
          return b;
        },
        hold: function (label, fn) {
          var b = h('button', { type: 'button', class: 'vi-btn vi-btn--hold' }, label);
          var delay = null, timer = null, count = 0, fromPointer = false;
          function stop() { clearTimeout(delay); clearInterval(timer); delay = timer = null; }
          b.addEventListener('pointerdown', function (ev) {
            if (ev.pointerType === 'mouse' && ev.button !== 0) return;
            fromPointer = true; count = 1; fn(count); requestDraw();
            delay = setTimeout(function () { timer = setInterval(function () { count++; fn(count); requestDraw(); }, 60); }, 380);
          });
          ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(function (e) { b.addEventListener(e, stop); });
          b.addEventListener('click', function (ev) {
            if (fromPointer && ev.detail !== 0) { fromPointer = false; return; }
            fromPointer = false; fn(1); requestDraw();
          });
          sbCleanups.push(stop);
          return b;
        }
      };
    }

    /* ---- feedback ---- */
    function statusWord(fb) { return fb.status === 'ok' ? 'Correct' : fb.status === 'close' ? 'Nearly' : 'Not right'; }
    function renderFeedback(el, fb) {
      ui.clear(el);
      if (!fb) return;
      var icon = fb.status === 'ok' ? '✓' : fb.status === 'close' ? '≈' : '✗';
      var box = h('div', { class: 'vi-fb vi-fb--' + fb.status },
        h('p', { class: 'vi-fb-title' }, h('span', { class: 'vi-fb-icon', 'aria-hidden': 'true' }, icon), ' ',
          h('strong', {}, statusWord(fb) + (fb.title && fb.title !== statusWord(fb) ? ': ' + fb.title : ''))));
      (fb.lines || []).forEach(function (l) { box.appendChild(h('p', { html: l })); });
      el.appendChild(box);
    }

    /* ---- build a sandbox ---- */
    function teardown() {
      sbCleanups.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
      sbCleanups = [];
      if (sb && sb.destroy) { try { sb.destroy(); } catch (e) { /* ignore */ } }
      sb = null;
    }

    function build(id, keepView) {
      var def = null;
      SANDBOXES.forEach(function (s) { if (s.id === id) def = s; });
      if (!def) return;
      teardown();
      currentId = id;
      var rng = makeRng(seed + '/' + id);
      var env = { rng: rng, seed: seed, now: perfNow };
      sb = def.factory(env);
      var inst = sb.instrument || INS().create(id);
      titleEl.textContent = def.label;
      tutorial.innerHTML = inst.describe();
      taskEl.innerHTML = sb.task || '';
      canvas.setAttribute('aria-label', def.label + ' sandbox. Drag to pan, use the mouse wheel, pinch or the + and − keys to zoom. ' +
        (sb.eye ? 'Use [ and ] or the eye-level slider to move your eye. ' : '') + 'Readings must be taken from the picture.');
      // Eye level.
      if (sb.eye) {
        var er = rng.fork('eye');
        var start = (er.chance(0.5) ? 1 : -1) * Math.round(er.uniform(3, 9));
        eyeRow.hidden = false;
        eyeLabel.textContent = sb.eye === 'meter' ? 'Eye position' : 'Eye level';
        eyeNote.textContent = sb.eye === 'meter' ? 'Move your eye until the needle hides its reflection in the mirror strip.' : 'Drag the slider (or press [ and ]) until your eye is level with the reading.';
        setEye(start);
      } else {
        eyeRow.hidden = true;
        eyeAngle = 0;
        eyeNote.textContent = sb.eyeNote || '';
      }
      // Controls.
      ui.clear(controlsEl);
      var api = makeApi();
      if (sb.controls) sb.controls(controlsEl, api);
      // Zoom targets.
      ui.clear(targetsEl);
      var zt = typeof sb.zoomTargets === 'function' ? sb.zoomTargets() : sb.zoomTargets || [];
      zt.forEach(function (t, i) {
        var b = h('button', { type: 'button', class: 'vi-btn vi-btn--small' }, t.label);
        b.addEventListener('click', function () {
          var list = typeof sb.zoomTargets === 'function' ? sb.zoomTargets() : sb.zoomTargets;
          var tt = list[i] || t;
          vp.focus(tt.x, tt.y, tt.scale);
          requestDraw();
        });
        targetsEl.appendChild(b);
      });
      // Answer.
      ui.clear(answerEl);
      if (sb.customAnswer) sb.customAnswer(answerEl, api);
      else if (sb.answer) buildAnswer(api);
      // View.
      if (!keepView || !fitted) { vp.fit(sb.world); fitted = vp.cssW > 0; }
      else vp.fit(sb.world);
      Object.keys(navButtons).forEach(function (k) {
        if (k === id) navButtons[k].setAttribute('aria-current', 'true'); else navButtons[k].removeAttribute('aria-current');
      });
      lastT = null;
      requestDraw();
    }

    function buildAnswer(api) {
      var input = h('input', { class: 'vi-input', id: api.uid('ans'), inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
      var fb = h('div', { class: 'vi-feedback', role: 'status', 'aria-live': 'polite' });
      var revealBtn = h('button', { type: 'button', class: 'vi-btn vi-btn--quiet', hidden: true }, 'Show the correct reading');
      var revealEl = h('p', { class: 'vi-reveal', hidden: true });
      var form = h('form', { class: 'vi-answer', novalidate: true },
        h('div', { class: 'vi-field' }, h('label', { for: input.id }, sb.answer.label), input),
        h('button', { type: 'submit', class: 'vi-btn vi-btn--primary' }, 'Check my reading'));
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var res = sb.check(input.value, { view: currentView(perfNow()) });
        renderFeedback(fb, res);
        revealBtn.hidden = false;
      });
      revealBtn.addEventListener('click', function () {
        revealEl.innerHTML = sb.reveal ? sb.reveal() : '';
        revealEl.hidden = false;
      });
      answerEl.appendChild(form);
      answerEl.appendChild(fb);
      answerEl.appendChild(h('div', { class: 'vi-row' }, revealBtn));
      answerEl.appendChild(revealEl);
    }

    function select(id) {
      build(id, false);
      try { titleEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }

    readColours();
    var first = opts.initial && navButtons[opts.initial] ? opts.initial : SANDBOXES[0].id;
    build(first, false);
    resize();

    return {
      destroy: function () {
        destroyed = true;
        if (raf) globalThis.cancelAnimationFrame(raf);
        raf = null;
        teardown();
        if (ro) ro.disconnect();
        cleanups.forEach(function (f) { f(); });
        cleanups = [];
        if (root.parentNode) root.parentNode.removeChild(root);
        if (pageTitle.parentNode) pageTitle.parentNode.removeChild(pageTitle);
      },
      select: select,
      seed: function () { return seed; },
      /** For tests: current sandbox id and viewport. */
      _state: function () {
        return { id: currentId, scale: vp.scale, fitScale: vp.fitScale, cx: vp.cx, cy: vp.cy, cssW: vp.cssW, cssH: vp.cssH, eyeAngle: eyeAngle };
      }
    };
  }

  ui.instrumentLab = { mount: mount, sandboxes: SANDBOXES.map(function (s) { return s.id; }), _judge: judge };
})(globalThis.VLab = globalThis.VLab || {});
