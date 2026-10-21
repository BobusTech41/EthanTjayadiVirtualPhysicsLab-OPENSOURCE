/**
 * Exam countdown (browser only for mount; pure helpers also run in Node).
 *
 *   VL.ui.timer.mount(container, {
 *     durationMs,                 // total exam time
 *     elapsedMs = 0,              // time already used (resumed sessions)
 *     warnAt = [15, 5],           // minutes remaining at which to warn
 *     onWarn(minutesLeft),        // called once per threshold when it is crossed while running
 *     onEnd(),                    // called once when the time reaches zero
 *     onTick(elapsedMs),          // called on every tick (about 4 times a second)
 *     now = Date.now,             // clock (injectable for tests)
 *     autoStart = true
 *   }) -> { el, start(), pause(), running(), elapsed(), remaining(), destroy() }
 *
 *   VL.ui.timer.format(ms) -> 'h:mm:ss' (or 'm:ss' under an hour)
 *   VL.ui.timer.crossed(prevRemainingMs, remainingMs, warnAtMinutes) -> minutes[] whose threshold was crossed
 *   VL.ui.timer.describe(ms) -> '1 hour 5 minutes' (spoken form)
 *
 * The visible clock is not announced continuously (role="timer", aria-live off); a separate polite live region
 * announces "15 minutes remaining", "5 minutes remaining" and "Time is up". Warnings are shown with an icon and
 * words as well as colour.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  /**
   * Format a duration as h:mm:ss (or m:ss below one hour). Rounds UP to whole seconds so that the clock shows
   * 0:00 only when the time has really run out.
   * @param {number} ms
   * @returns {string}
   */
  function format(ms) {
    var s = Math.max(0, Math.ceil((ms || 0) / 1000 - 1e-9));
    var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return hh ? hh + ':' + pad(mm) + ':' + pad(ss) : mm + ':' + pad(ss);
  }

  /**
   * Human-readable duration for announcements: '1 hour 15 minutes', '5 minutes', '30 seconds'.
   * @param {number} ms
   */
  function describe(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000));
    var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    var parts = [];
    if (hh) parts.push(hh + (hh === 1 ? ' hour' : ' hours'));
    if (mm) parts.push(mm + (mm === 1 ? ' minute' : ' minutes'));
    if (!hh && !mm) parts.push(ss + (ss === 1 ? ' second' : ' seconds'));
    return parts.join(' ');
  }

  /**
   * Which warning thresholds (in minutes) lie in (remainingMs, prevRemainingMs]? i.e. were crossed by this tick.
   * @param {number} prevRemainingMs
   * @param {number} remainingMs
   * @param {number[]} warnAt minutes
   * @returns {number[]}
   */
  function crossed(prevRemainingMs, remainingMs, warnAt) {
    return (warnAt || []).filter(function (min) {
      var t = min * 60000;
      return prevRemainingMs > t && remainingMs <= t;
    }).sort(function (a, b) { return b - a; });
  }

  /**
   * Mount a countdown.
   * @param {HTMLElement} container
   * @param {object} opts see file header
   */
  function mount(container, opts) {
    opts = opts || {};
    var h = ui.h;
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var duration = Math.max(0, Number(opts.durationMs) || 0);
    var warnAt = opts.warnAt || [15, 5];
    var base = Math.max(0, Number(opts.elapsedMs) || 0);   // elapsed before the current run
    var runStart = null;                                    // wall-clock start of the current run
    var interval = null;
    var ended = false;
    var lastRemaining = duration - base;
    var hiddenClock = false;

    var clock = h('span', { class: 'vl-timer-clock', role: 'timer', 'aria-live': 'off', 'aria-atomic': 'true' });
    var badge = h('span', { class: 'vl-timer-badge' });
    var live = h('span', { class: 'vl-sr-only', 'aria-live': 'polite', role: 'status' });
    var hideBtn = h('button', {
      type: 'button', class: 'vl-timer-hide', 'aria-pressed': 'false',
      title: 'Hide or show the countdown (warnings are still given)',
      on: { click: function () { setHidden(!hiddenClock); } }
    }, 'Hide');
    var el = h('div', { class: 'vl-timer', role: 'group', 'aria-label': 'Time remaining' },
      h('span', { class: 'vl-timer-label', 'aria-hidden': 'true' }, 'Time left'),
      clock, badge, hideBtn, live);
    container.appendChild(el);

    function setHidden(v) {
      hiddenClock = v;
      el.classList.toggle('vl-timer--hidden', v);
      hideBtn.textContent = v ? 'Show' : 'Hide';
      hideBtn.setAttribute('aria-pressed', v ? 'true' : 'false');
      render();
    }

    function elapsed() {
      return base + (runStart === null ? 0 : Math.max(0, now() - runStart));
    }
    function remaining() { return Math.max(0, duration - elapsed()); }

    function announce(msg) {
      live.textContent = '';
      setTimeout(function () { live.textContent = msg; }, 50);
    }

    function render() {
      var rem = remaining();
      clock.textContent = hiddenClock ? '–:––' : format(rem);
      clock.setAttribute('aria-label', hiddenClock ? 'Countdown hidden' : describe(rem) + ' remaining');
      var urgent = rem <= 5 * 60000, warn = rem <= 15 * 60000;
      el.classList.toggle('vl-timer--warn', warn && !urgent);
      el.classList.toggle('vl-timer--urgent', urgent);
      el.classList.toggle('vl-timer--ended', rem <= 0);
      badge.textContent = rem <= 0 ? '⏹ Time is up' : urgent ? '⚠ Under 5 min' : warn ? '⚠ Under 15 min' : '';
    }

    function tick() {
      var el2 = elapsed();
      var rem = Math.max(0, duration - el2);
      var due = crossed(lastRemaining, rem, warnAt);
      lastRemaining = rem;
      render();
      if (typeof opts.onTick === 'function') { try { opts.onTick(el2); } catch (e) { console.error('[timer onTick]', e); } }
      if (due.length && rem > 0) {
        var min = due[due.length - 1];
        announce(min + (min === 1 ? ' minute' : ' minutes') + ' remaining');
        if (typeof opts.onWarn === 'function') {
          due.forEach(function (m) { try { opts.onWarn(m); } catch (e) { console.error('[timer onWarn]', e); } });
        }
      }
      if (rem <= 0 && !ended) {
        ended = true;
        pause();
        base = duration;
        render();
        announce('Time is up');
        if (typeof opts.onEnd === 'function') { try { opts.onEnd(); } catch (e) { console.error('[timer onEnd]', e); } }
      }
    }

    function start() {
      if (runStart !== null || ended) return;
      runStart = now();
      interval = setInterval(tick, 250);
      setTimeout(tick, 0);   // asynchronous, so onEnd never fires before mount() has returned
    }
    function pause() {
      if (runStart !== null) { base = elapsed(); runStart = null; }
      if (interval) { clearInterval(interval); interval = null; }
    }

    render();
    if (opts.autoStart !== false) start();

    return {
      el: el,
      start: start,
      pause: pause,
      running: function () { return runStart !== null; },
      elapsed: elapsed,
      remaining: remaining,
      /** Re-evaluate immediately (e.g. after the tab becomes visible again). */
      tick: tick,
      destroy: function () {
        pause();
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
  }

  ui.timer = { mount: mount, format: format, describe: describe, crossed: crossed };
})(globalThis.VLab = globalThis.VLab || {});
