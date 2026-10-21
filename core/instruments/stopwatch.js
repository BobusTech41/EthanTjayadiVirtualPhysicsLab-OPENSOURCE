/**
 * Stopwatch, light-gate timer and the stopwatch DOM widget (contract §3.7).
 *
 * stopwatch: 0.01 s, REAL time — the student's own reaction time is the timing error.
 *   start(nowMs), stop(nowMs), toggle(nowMs), reset(), running, elapsed(nowMs) -> s (exact),
 *   reading(nowMs) -> s truncated to 0.01 s (what the display shows), display(nowMs) -> '12.34' | '1:02.35'
 *   Start/stop cycles accumulate, like a real stopwatch. reset() stops and zeroes it.
 *   getState(nowMs) -> { elapsed (s, exact), running }; setState({ elapsed }) leaves it STOPPED showing that time
 *   (a later start() keeps accumulating). The light-gate timer has the same two methods.
 *   When nowMs is omitted, performance.now() is used.
 *
 * lightGateTimer: 0.001 s digital timer triggered by the experiment (no reaction time).
 *   trigger(nowMs) (first call starts, second stops), start/stop/reset/elapsed/display as above (3 d.p.),
 *   measure(intervalSeconds) -> sets and returns a completed interval (truncated to 0.001 s).
 *
 * VL.instruments.formatTime(seconds, decimals = 2) -> '12.34', '1:02.35', '1:00:05.00' (truncated, never rounded up)
 *
 * VL.instruments.stopwatchWidget(container, sw, { onEvent(kind, info), now?() , label? })
 *   -> { el, destroy(), toggle(), reset() }   (browser only)
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;

  function perfNow() {
    var p = globalThis.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }

  /**
   * Format a time like a digital stopwatch (truncated to the given number of decimals).
   * @param {number} seconds
   * @param {number} [decimals=2]
   */
  function formatTime(seconds, decimals) {
    if (decimals === undefined) decimals = 2;
    var unit = Math.pow(10, decimals);
    var ticks = Math.floor(Math.max(0, seconds) * unit + 1e-6);
    var whole = Math.floor(ticks / unit), frac = ticks % unit;
    var fracStr = decimals ? '.' + String(frac).padStart(decimals, '0') : '';
    if (whole < 60) return whole + fracStr;
    var h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
    var ss = String(s).padStart(2, '0');
    if (h) return h + ':' + String(m).padStart(2, '0') + ':' + ss + fracStr;
    return m + ':' + ss + fracStr;
  }
  I.formatTime = formatTime;

  /** Shared timer logic for the stopwatch and the light-gate timer. */
  function timerLogic(inst, decimals) {
    inst.running = false;
    inst.accMs = 0;
    inst.t0 = null;
    inst.start = function (nowMs) {
      if (this.running) return false;
      this.t0 = nowMs === undefined ? perfNow() : nowMs;
      this.running = true;
      return true;
    };
    inst.stop = function (nowMs) {
      if (!this.running) return false;
      var t = nowMs === undefined ? perfNow() : nowMs;
      this.accMs += Math.max(0, t - this.t0);
      this.running = false;
      this.t0 = null;
      return true;
    };
    inst.toggle = function (nowMs) {
      return this.running ? (this.stop(nowMs), 'stop') : (this.start(nowMs), 'start');
    };
    inst.reset = function () {
      this.running = false;
      this.accMs = 0;
      this.t0 = null;
    };
    inst.elapsed = function (nowMs) {
      var ms = this.accMs;
      if (this.running) ms += Math.max(0, (nowMs === undefined ? perfNow() : nowMs) - this.t0);
      return ms / 1000;
    };
    /**
     * State to keep across a reload or a question switch.
     * @param {number} [nowMs]
     * @returns {{elapsed: number, running: boolean}} elapsed in s (exact, not truncated)
     */
    inst.getState = function (nowMs) { return { elapsed: this.elapsed(nowMs), running: this.running }; };
    /**
     * Restore an accumulated time. The watch is left STOPPED showing it (the time base of a running watch does not
     * survive a reload); a later start() continues accumulating from it.
     * @param {{elapsed: number}} st elapsed in s
     */
    inst.setState = function (st) {
      var e = Number(st && st.elapsed);
      this.running = false;
      this.t0 = null;
      this.accMs = isFinite(e) && e > 0 ? e * 1000 : 0;
    };
    inst.reading = function (nowMs) { return U.truncate(this.elapsed(nowMs), this.resolution); };
    inst.display = function (nowMs) { return formatTime(this.elapsed(nowMs), decimals); };
    inst.indicate = function (trueSeconds) { return U.truncate(Math.max(0, trueSeconds), this.resolution); };
  }

  /* ------------------------------------------------------------------ */

  I.define('stopwatch', function (inst) {
    inst.name = 'Stopwatch';
    inst.unit = 's';
    inst.digital = true;
    inst.resolution = 0.01;
    inst.tolerance = 0.01;
    inst.range = [0, 35999.99];
    inst.zeroErrorSpec = null;
    timerLogic(inst, 2);
    inst.draw = function (g, place, view, state) {
      drawTimerBox(g, place, view, this.display(state && state.now !== undefined ? state.now : view && view.now),
        { title: 'STOPWATCH', w: 6.5, h: 7.5, round: true, running: this.running });
    };
    inst.describe = describeStopwatch;
  }, { name: 'Stopwatch' });

  I.define('lightGateTimer', function (inst) {
    inst.name = 'Light-gate timer';
    inst.unit = 's';
    inst.digital = true;
    inst.resolution = 0.001;
    inst.tolerance = 0.001;
    inst.range = [0, 3599.999];
    inst.zeroErrorSpec = null;
    timerLogic(inst, 3);
    /** First trigger starts the timer, the next stops it. Returns 'start' or 'stop'. */
    inst.trigger = function (nowMs) {
      if (this.running) { this.stop(nowMs); return 'stop'; }
      this.reset();
      this.start(nowMs);
      return 'start';
    };
    /** Record a completed interval computed by the experiment (s). Returns the displayed (truncated) value. */
    inst.measure = function (intervalSeconds) {
      this.running = false;
      this.t0 = null;
      this.accMs = Math.max(0, intervalSeconds) * 1000;
      return this.reading();
    };
    inst.draw = function (g, place, view, state) {
      drawTimerBox(g, place, view, this.display(state && state.now !== undefined ? state.now : view && view.now),
        { title: 'LIGHT-GATE TIMER', w: 12, h: 6, round: false, running: this.running });
    };
    inst.describe = describeLightGate;
  }, { name: 'Light-gate timer' });

  /** Draw a digital timer with a seven-segment display. place = { x, y } is the centre. */
  function drawTimerBox(g, place, view, str, o) {
    place = place || {};
    view = view || { scale: 10 };
    var w = o.w, h = o.h;
    g.save();
    g.translate(place.x || 0, place.y || 0);
    g.lineWidth = U.lineW(view, 0.02);
    g.strokeStyle = '#1f252b';
    U.roundRect(g, -w / 2, -h / 2, w, h, o.round ? w * 0.3 : 0.4);
    g.fillStyle = o.round ? '#2d3a48' : '#e2e6ea';
    g.fill(); g.stroke();
    if (o.round) {   // crown button
      g.fillStyle = '#9aa3ac';
      g.fillRect(-0.5, -h / 2 - 0.6, 1, 0.6);
    }
    U.roundRect(g, -w / 2 + 0.5, -h / 2 + (o.round ? 1.8 : 1.2), w - 1, 2.1, 0.2);
    g.fillStyle = '#c9d6b6';
    g.fill();
    var digitH = 1.4;
    U.sevenSeg(g, str, w / 2 - 0.8, -h / 2 + (o.round ? 2.15 : 1.55), digitH * (str.length > 6 ? 0.8 : 1),
      { on: '#15191c', off: 'rgba(20,25,28,0.05)' });
    U.text(g, o.title, 0, -h / 2 + (o.round ? 1.2 : 0.6), 0.32, { colour: o.round ? '#e8edf2' : '#1f252b', weight: '700' });
    if (o.running) U.text(g, 'RUN', -w / 2 + 0.9, -h / 2 + (o.round ? 2.2 : 1.6), 0.22, { colour: '#15191c', weight: '700' });
    g.restore();
  }

  function describeStopwatch() {
    return [
      '<h3>Stopwatch</h3>',
      '<p><strong>Resolution:</strong> 0.01 s — but this is <em>not</em> the uncertainty. Your reaction time when starting and stopping is about 0.1–0.2 s, so timing errors are much larger than the display resolution.</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Below one minute the display shows seconds, e.g. <code>12.34</code> = 12.34 s. From one minute it shows minutes:seconds, e.g. <code>1:02.35</code> = 62.35 s. Convert to seconds before calculating.</li>',
      '<li>Record raw times to 0.01 s (two decimal places), consistently.</li></ul>',
      '<h4>Reducing the timing uncertainty</h4>',
      '<ul><li>Time <strong>many oscillations</strong> (at least 10, preferably 20) and divide: the reaction-time error is shared between all of them, so the percentage uncertainty in the period is much smaller.</li>',
      '<li>Start and stop as the object passes a <strong>fiducial marker</strong> at the centre of the swing, where it moves fastest and the instant is easiest to judge.</li>',
      '<li><strong>Repeat</strong> the timing and average; use half the range of the repeats as the uncertainty.</li>',
      '<li>Count “zero” as you start the watch, not “one”.</li></ul>',
      '<h4>Zero error</h4>',
      '<p>Always reset the stopwatch to <code>0.00</code> before starting a new timing.</p>',
      '<h4>Uncertainty to quote</h4>',
      '<p>Typically ±0.1 s to ±0.2 s for a single human-timed interval (reaction time), or half the range of repeated readings. For the period from n oscillations, divide by n.</p>'
    ].join('');
  }

  function describeLightGate() {
    return [
      '<h3>Light-gate timer</h3>',
      '<p><strong>Resolution:</strong> 0.001 s. The timer starts and stops automatically when an object interrupts the light beam, so there is no reaction-time error.</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Record all the digits shown, e.g. <code>0.452 s</code>.</li>',
      '<li>Reset the timer before each run.</li></ul>',
      '<h4>Good technique</h4>',
      '<ul><li>Measure the length of the card that interrupts the beam carefully (vernier callipers): speed = card length ÷ time.</li>',
      '<li>Make sure the card passes squarely through the beam.</li></ul>',
      '<h4>Uncertainty to quote</h4>',
      '<p>±0.001 s from the display, but repeated runs usually vary more — use half the range of repeats.</p>',
      '<p>Suggesting a light gate connected to a timer instead of a hand-held stopwatch is a credited improvement when reaction time is a problem.</p>'
    ].join('');
  }

  /* ------------------------------------------------------------------ */
  /* DOM widget (browser only)                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Render a stopwatch with a live LCD display and large Start/Stop and Reset buttons.
   * Space / X keyboard shortcuts are handled elsewhere (ui/shortcuts.js) through toggle() / reset().
   * The live display is not announced; the final time is announced (aria-live) when the watch is stopped.
   *
   * @param {HTMLElement} container
   * @param {object} sw  a stopwatch instance (VL.instruments.create('stopwatch'))
   * @param {{onEvent?: function(string, object), now?: function(): number, label?: string}} [opts]
   * @returns {{el: HTMLElement, destroy: function(), toggle: function(), reset: function()}}
   */
  I.stopwatchWidget = function (container, sw, opts) {
    opts = opts || {};
    var doc = container.ownerDocument || globalThis.document;
    var now = typeof opts.now === 'function' ? opts.now : perfNow;
    var raf = null;
    var listeners = [];

    function el(tag, cls, text) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }
    function on(target, type, fn) {
      target.addEventListener(type, fn);
      listeners.push(function () { target.removeEventListener(type, fn); });
    }

    var root = el('div', 'vi-sw');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', opts.label || 'Stopwatch');
    var lcd = el('div', 'vi-sw-lcd');
    lcd.setAttribute('role', 'timer');
    lcd.setAttribute('aria-live', 'off');
    var status = el('span', 'vi-sw-run', '');
    status.setAttribute('aria-hidden', 'true');
    var digits = el('span', 'vi-sw-digits', sw.display(now()));
    lcd.appendChild(status);
    lcd.appendChild(digits);
    var buttons = el('div', 'vi-sw-buttons');
    var startBtn = el('button', 'vi-sw-btn vi-sw-start', 'Start');
    startBtn.type = 'button';
    startBtn.setAttribute('aria-keyshortcuts', 'Space');
    var resetBtn = el('button', 'vi-sw-btn vi-sw-reset', 'Reset');
    resetBtn.type = 'button';
    resetBtn.setAttribute('aria-keyshortcuts', 'X');
    buttons.appendChild(startBtn);
    buttons.appendChild(resetBtn);
    var live = el('div', 'vi-sr-only');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    root.appendChild(lcd);
    root.appendChild(buttons);
    root.appendChild(live);
    container.appendChild(root);

    function announce(msg) {
      live.textContent = '';
      // Re-set on the next frame so identical messages are announced again.
      setTimeout(function () { live.textContent = msg; }, 30);
    }

    function render() {
      var t = now();
      digits.textContent = sw.display(t);
      var running = !!sw.running;
      root.classList.toggle('vi-sw--running', running);
      status.textContent = running ? 'RUN' : '';
      startBtn.textContent = running ? 'Stop' : 'Start';
      startBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
      startBtn.classList.toggle('vi-sw-btn--stop', running);
    }

    function loop() {
      render();
      raf = sw.running ? globalThis.requestAnimationFrame(loop) : null;
    }
    function ensureLoop() {
      if (!raf && sw.running && typeof globalThis.requestAnimationFrame === 'function') raf = globalThis.requestAnimationFrame(loop);
    }

    function info(t) {
      return { nowMs: t, elapsed: sw.elapsed(t), display: sw.display(t), reading: sw.reading(t) };
    }

    function toggle() {
      var t = now();
      var kind = sw.running ? 'stop' : 'start';
      if (kind === 'stop') sw.stop(t); else sw.start(t);
      render();
      ensureLoop();
      if (kind === 'stop') announce('Stopped at ' + spoken(sw.display(t)));
      else announce('Stopwatch running');
      if (opts.onEvent) opts.onEvent(kind, info(t));
      return kind;
    }

    function reset() {
      var t = now();
      sw.reset();
      render();
      announce('Stopwatch reset to zero');
      if (opts.onEvent) opts.onEvent('reset', info(t));
    }

    // Pointer presses act immediately (like a real button); keyboard/programmatic clicks have detail === 0.
    on(startBtn, 'pointerdown', function (ev) {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      startBtn.dataset.pointerHandled = '1';
      toggle();
    });
    var keyPending = false;
    on(startBtn, 'click', function (ev) {
      if (keyPending) return;
      if (startBtn.dataset.pointerHandled === '1' && ev.detail !== 0) { startBtn.dataset.pointerHandled = ''; return; }
      startBtn.dataset.pointerHandled = '';
      toggle();
    });
    // Keyboard on the focused Start/Stop button: act on key DOWN (a real button triggers when pressed, and
    // native Space activation would wait for key-up), suppress the native click, and stop the global Space
    // shortcut (ui/shortcuts.js) from toggling a second time.
    function isActivationKey(ev) { return ev.key === ' ' || ev.key === 'Spacebar' || ev.key === 'Enter'; }
    on(startBtn, 'keydown', function (ev) {
      if (!isActivationKey(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.repeat) return;
      keyPending = true;
      toggle();
    });
    on(startBtn, 'keyup', function (ev) {
      if (!isActivationKey(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      setTimeout(function () { keyPending = false; }, 50);
    });
    on(resetBtn, 'click', function () { reset(); });
    on(resetBtn, 'keydown', function (ev) { if (isActivationKey(ev)) ev.stopPropagation(); });

    render();
    ensureLoop();

    return {
      el: root,
      toggle: toggle,
      reset: reset,
      refresh: function () { render(); ensureLoop(); },
      destroy: function () {
        if (raf && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(raf);
        raf = null;
        listeners.forEach(function (off) { off(); });
        listeners = [];
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  };

  /** '1:02.35' -> '1 minute 2.35 seconds' for screen readers. */
  function spoken(display) {
    var parts = display.split(':');
    if (parts.length === 1) return display + ' seconds';
    if (parts.length === 2) return parts[0] + (parts[0] === '1' ? ' minute ' : ' minutes ') + Number(parts[1]) + ' seconds';
    return parts[0] + ' hours ' + Number(parts[1]) + ' minutes ' + Number(parts[2]) + ' seconds';
  }
})(globalThis.VLab = globalThis.VLab || {});
