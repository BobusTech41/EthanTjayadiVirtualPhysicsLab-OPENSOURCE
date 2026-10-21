/**
 * Global keyboard shortcuts (contract §8) and the "?" help overlay (browser only for install/showHelp).
 *
 *   VL.ui.shortcuts.install()             // idempotent; one keydown listener on document
 *   VL.ui.shortcuts.setContext(ctx)       // handlers of the current page; returns a function that removes it
 *   VL.ui.shortcuts.clearContext(ctx?)
 *   VL.ui.shortcuts.showHelp()
 *   VL.ui.shortcuts.resolve(ev, { typing, focusVisibleControl }) -> action name | null   (pure, for tests)
 *   VL.ui.shortcuts.LIST                  // [{ keys, action }] shown in the help overlay
 *
 * ctx = { stopwatchToggle(), stopwatchReset(), record(), undo(), redo(), zoomIn(), zoomOut(), zoomReset(),
 *         eyeLower(), eyeHigher(), switchTab(index 0..4) }  — every handler is optional.
 *
 * Keys are ignored while the student is typing in a text box (VL.ui.isTyping), except Alt+1…Alt+5, which switch
 * the right-hand tab from anywhere. Space on a button, link, checkbox or slider that the student reached with the
 * KEYBOARD keeps its normal meaning; otherwise Space starts / stops the stopwatch, so a button that was just clicked
 * with the mouse or a finger (e.g. "Lengthen string") is never pressed again by Space.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var LIST = [
    { keys: ['Space'], action: 'Start / stop the stopwatch' },
    { keys: ['X'], action: 'Reset the stopwatch' },
    { keys: ['R'], action: 'Record the reading in the reading pad (Enter also works inside the pad)' },
    { keys: ['Ctrl', 'Z'], action: 'Undo (table or graph, whichever tab is open). Cmd on a Mac.' },
    { keys: ['Ctrl', 'Shift', 'Z'], alt: ['Ctrl', 'Y'], action: 'Redo' },
    { keys: ['+'], alt: ['−'], action: 'Zoom the apparatus in / out' },
    { keys: ['0'], action: 'Fit the whole apparatus in view' },
    { keys: ['['], alt: [']'], action: 'Move your eye lower / higher (parallax)' },
    { keys: ['Alt', '1…5'], action: 'Switch tab: Paper, Table, Graph, Tools, Report' },
    { keys: ['?'], action: 'Show this list' },
    { keys: ['Esc'], action: 'Close a dialog' }
  ];

  var contexts = [];
  var installed = false;
  var helpOpen = false;
  var lastPointerDown = 0;
  var pointerFocused = null;    // element that received focus from a mouse / touch press

  function current() { return contexts.length ? contexts[contexts.length - 1] : null; }

  /**
   * Decide which action a key event maps to.
   * @param {{key: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean}} ev
   * @param {{typing?: boolean, focusVisibleControl?: boolean}} [env]
   * @returns {string|null} action name, or 'tab:N' for Alt+digit
   */
  function resolve(ev, env) {
    env = env || {};
    var mod = !!(ev.ctrlKey || ev.metaKey);
    var key = ev.key || '';
    var code = ev.code || '';
    if (ev.altKey && !mod) {
      var m = /^Digit([1-5])$/.exec(code) || /^([1-5])$/.exec(key);
      if (m) return 'tab:' + (Number(m[1]) - 1);
      return null;
    }
    if (env.typing) return null;
    if (mod && !ev.altKey) {
      var k = key.toLowerCase();
      if (k === 'z') return ev.shiftKey ? 'redo' : 'undo';
      if (k === 'y') return 'redo';
      return null;
    }
    if (ev.altKey || mod) return null;
    switch (key) {
      case ' ': case 'Spacebar':
        return env.focusVisibleControl ? null : 'stopwatchToggle';
      case 'x': case 'X': return 'stopwatchReset';
      case 'r': case 'R': return 'record';
      case '+': case '=': return 'zoomIn';
      case '-': case '_': case '−': return 'zoomOut';
      case '0': return 'zoomReset';
      case '[': return 'eyeLower';
      case ']': return 'eyeHigher';
      case '?': return 'help';
      default: return null;
    }
  }

  var CONTROL_SELECTOR = 'button, a[href], summary, input[type=checkbox], input[type=radio], input[type=range], ' +
    '[role=button], [role=tab], [role=slider], [role=checkbox], [role=menuitem], [role=switch], [role=menuitemcheckbox]';

  /**
   * Is the focused element a control that Space should activate, because the student reached it with the keyboard?
   * (:focus-visible cannot be used: browsers switch it on as soon as any key is pressed.)
   */
  function focusVisibleControl(target) {
    if (!target || !target.matches || !target.matches(CONTROL_SELECTOR)) return false;
    return target !== pointerFocused;
  }

  function onPointerDown(ev) {
    lastPointerDown = Date.now();
    var active = document.activeElement;
    // pressing an element that already has the focus makes it pointer-focused too
    if (active && active !== document.body && ev.target && active.contains && active.contains(ev.target)) pointerFocused = active;
  }
  function onFocusIn(ev) {
    pointerFocused = Date.now() - lastPointerDown < 800 ? ev.target : null;
  }

  function modalOpen() {
    var root = globalThis.document && document.getElementById('modal-root');
    return !!(root && root.children.length);
  }

  function onKeyDown(ev) {
    if (ev.defaultPrevented || ev.isComposing) return;
    var typing = ui.isTyping ? ui.isTyping(ev) : false;
    var action = resolve(ev, { typing: typing, focusVisibleControl: focusVisibleControl(ev.target) });
    if (!action) return;
    if (action === 'help') {
      if (modalOpen()) return;
      ev.preventDefault();
      showHelp();
      return;
    }
    if (modalOpen()) return;   // never act behind a dialog
    var ctx = current();
    if (!ctx) return;
    var fn, arg;
    if (action.indexOf('tab:') === 0) { fn = ctx.switchTab; arg = Number(action.slice(4)); }
    else fn = ctx[action];
    if (typeof fn !== 'function') return;
    var res;
    try { res = fn(arg); } catch (e) { console.error('[shortcuts ' + action + ']', e); }
    if (res !== false) ev.preventDefault();
  }

  /** Attach the global listener once. */
  function install() {
    if (installed || !globalThis.document) return;
    installed = true;
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    // a focus change that follows a key press (Tab, arrow keys in a tab list…) is keyboard focus
    document.addEventListener('keydown', function () { lastPointerDown = 0; }, true);
  }

  /**
   * Make ctx the active set of handlers (the most recent context wins).
   * @returns {function()} remove this context
   */
  function setContext(ctx) {
    contexts.push(ctx);
    return function () { clearContext(ctx); };
  }

  /** Remove a context (or all of them when called without an argument). */
  function clearContext(ctx) {
    if (!ctx) { contexts = []; return; }
    contexts = contexts.filter(function (c) { return c !== ctx; });
  }

  function kbd(h, keys) {
    var out = [];
    keys.forEach(function (k, i) {
      if (i) out.push(' + ');
      out.push(h('kbd', { class: 'vl-kbd' }, k));
    });
    return out;
  }

  /** Show the shortcut list in a dialog. */
  function showHelp() {
    if (helpOpen || !globalThis.document) return;
    var h = ui.h;
    var table = h('table', { class: 'vl-shortcuts' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Key'), h('th', { scope: 'col' }, 'Action'))),
      h('tbody', null, LIST.map(function (row) {
        return h('tr', null,
          h('td', null, kbd(h, row.keys), row.alt ? [' or ', kbd(h, row.alt)] : null),
          h('td', null, row.action));
      })));
    var body = h('div', null,
      h('p', null, 'Shortcuts do not work while you are typing in a box, except Alt + number.'),
      table);
    helpOpen = true;
    var done = function () { helpOpen = false; };
    if (ui.dialog && typeof ui.dialog.open === 'function') {
      ui.dialog.open({ title: 'Keyboard shortcuts', body: body, actions: [{ label: 'Close', value: true, primary: true }] })
        .then(done, done);
    } else {
      // Minimal fallback overlay (ui/app.js normally provides ui.dialog).
      var root = document.getElementById('modal-root') || document.body;
      var prev = document.activeElement;
      var close = h('button', { type: 'button', class: 'vl-btn vl-btn--primary' }, 'Close');
      var box = h('div', { class: 'vl-modal-backdrop' },
        h('div', { class: 'vl-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' },
          h('h2', { class: 'vl-modal-title' }, 'Keyboard shortcuts'), body, h('div', { class: 'vl-modal-actions' }, close)));
      var shut = function () {
        if (box.parentNode) box.parentNode.removeChild(box);
        done();
        if (prev && prev.focus) prev.focus();
      };
      close.addEventListener('click', shut);
      box.addEventListener('keydown', function (e) { if (e.key === 'Escape') shut(); });
      root.appendChild(box);
      close.focus();
    }
  }

  ui.shortcuts = {
    install: install,
    setContext: setContext,
    clearContext: clearContext,
    showHelp: showHelp,
    resolve: resolve,
    LIST: LIST
  };
})(globalThis.VLab = globalThis.VLab || {});
