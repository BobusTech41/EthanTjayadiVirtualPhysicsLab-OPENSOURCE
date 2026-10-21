/**
 * Apparatus panel (browser only for mount; the view maths also runs in Node). Contract §4.1.
 *
 *   VL.ui.apparatusView.mount(container, {
 *     exp, question,                       // experiment definition and the Question being worked on
 *     services: { mode, hints, toast?, log? },   // completed here with now, stopwatch, requestRedraw, focusWorld
 *     params?,                             // hidden parameters (computed from the seed when omitted)
 *     readOnly?,                           // after marking: the reading pad is disabled
 *     readOnlyText?,                       // what the pad says while read-only (default: the question is marked)
 *     onRecord(str, { confirmed }) -> { label } | { needsConfirm: true, old, label } | null,
 *                                          // write to the current record target (null = no target: rough notes;
 *                                          // needsConfirm = the target holds another value, nothing was written)
 *     onChange(kind)                       // something worth autosaving changed ('log'|'view'|'notes'|'state')
 *   }) -> {
 *     el, controller, stopwatch, services, params,
 *     destroy(), record({ confirmed }?), focusPad(), setTargetLabel(label|null), saveState(),
 *     zoomIn(), zoomOut(), zoomReset(), goToTarget(t), eyeLower(), eyeHigher(),
 *     getEye(), setEye(deg), getEyeY(), setEyeY(y), getView(), getZoomMax(),
 *     stopwatchToggle(), stopwatchReset(), hasStopwatch(), reloadApparatus()
 *   }
 *
 * The view owns the canvas, the world→screen transform (fit-to-world, zoom ×0.5…zMax relative to fit about the
 * cursor / pinch centre, pan by dragging empty space or with two fingers), the eye (parallax), the bench-tool strip
 * (shared stopwatch) and the reading pad. The experiment's Controller owns the scene: draw(g, view) receives a
 * context already transformed to world units (1 = 1 cm, y down).
 *
 * Zoom: zMax = max(×40, controller.maxPxPerCm / fit) when the controller sets maxPxPerCm (px per cm needed to read
 * its finest scale), otherwise ×40. It is recomputed whenever the stage is resized.
 *
 * The eye is a WORLD HEIGHT, eyeY (cm, y down), at eyeDist = controller.eyeDistance || 40 cm in front of the
 * apparatus. The angle at which a point at height y is seen is atan((y − eyeY) / eyeDist) (+ = eye above the
 * point), so the cork and the bob, 55 cm apart, are seen at very different angles from one eye position.
 *   - Panning, zooming, Fit and services.focusWorld leave eyeY where it is.
 *   - A zoom-target button (goToTarget) models walking over to look: after the move eyeY is set a seeded
 *     3–9° off level with the target, so each place must be re-levelled.
 *   - The slider, [ and ], and setEye(deg) put the eye at deg relative to the CENTRE of the view.
 * controller.draw gets view.eyeAngle (the angle at the view centre, clamped to ±45°), view.eyeY and view.eyeDist.
 *
 * focusWorld(x, y, zoom) and zoomTargets[].zoom use the SAME zoom factor as the +/− buttons: relative to
 * fit-to-world (1 = whole apparatus visible).
 *
 * Redraws happen only when something changed (dirty), a view animation runs, the controller reports motion
 * (optional controller.isAnimating(); without it the view redraws every frame) or an error banner is showing.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var ZOOM_MIN = 0.5, ZOOM_MAX = 40;
  var EYE_MAX = 15;            // slider range (degrees either side of level with the view centre)
  var EYE_DIST = 40;           // cm from the eye to the apparatus, unless controller.eyeDistance says otherwise
  var EYE_VIEW_MAX = 45;       // view.eyeAngle handed to controller.draw is clamped to this
  var BUTTON_FACTOR = 1.5;
  var CLEAR_AFTER = 30;        // clean frames before a transient error banner is hidden
  var HALT_AFTER = 60;         // consecutive failing frames before the apparatus is stopped
  var DEG = Math.PI / 180;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* ================================================================== */
  /* Pure view maths                                                     */
  /* ================================================================== */

  var viewMath = {
    /** px per cm at zoom 1: the whole world fits with a small margin. */
    fitScale: function (world, W, H) {
      if (!W || !H || !world.width || !world.height) return 1;
      return 0.96 * Math.min(W / world.width, H / world.height);
    },
    /** Screen (css px, origin top-left of the canvas) → world (cm). */
    toWorld: function (view, fit, W, H, sx, sy) {
      var s = fit * view.z;
      return { x: view.cx + (sx - W / 2) / s, y: view.cy + (sy - H / 2) / s };
    },
    /** World (cm) → screen (css px). */
    toScreen: function (view, fit, W, H, wx, wy) {
      var s = fit * view.z;
      return { x: (wx - view.cx) * s + W / 2, y: (wy - view.cy) * s + H / 2 };
    },
    /** New view after zooming by `factor` about the screen point (sx, sy); the world point there stays put. */
    zoomAbout: function (view, fit, W, H, sx, sy, factor, zMax) {
      var w = viewMath.toWorld(view, fit, W, H, sx, sy);
      var z = clamp(view.z * factor, ZOOM_MIN, zMax || ZOOM_MAX);
      var s = fit * z;
      return { cx: w.x - (sx - W / 2) / s, cy: w.y - (sy - H / 2) / s, z: z };
    },
    /** Keep the view centre inside the world so the apparatus can never be lost off-screen. */
    clampView: function (view, world, zMax) {
      return {
        cx: clamp(view.cx, 0, world.width),
        cy: clamp(view.cy, 0, world.height),
        z: clamp(view.z, ZOOM_MIN, zMax || ZOOM_MAX)
      };
    },
    /**
     * Largest zoom factor: ×40, or enough for maxPxPerCm css px per cm when the controller asks for more.
     * @param {number} maxPxPerCm controller.maxPxPerCm (ignored unless a positive number)
     * @param {number} fit px per cm at zoom 1
     */
    maxZoom: function (maxPxPerCm, fit) {
      if (isNum(maxPxPerCm) && maxPxPerCm > 0 && isNum(fit) && fit > 0) return Math.max(ZOOM_MAX, maxPxPerCm / fit);
      return ZOOM_MAX;
    },
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX
  };

  /* ================================================================== */
  /* Pure eye maths (parallax)                                           */
  /* ================================================================== */

  var eyeMath = {
    /** Angle (degrees, + = eye above the point) at which a point at height y is seen from an eye at eyeY. */
    angleAt: function (eyeY, y, dist) { return Math.atan((y - eyeY) / (dist || EYE_DIST)) / DEG; },
    /** The eye height that sees height y at `deg` degrees. */
    eyeYFor: function (y, deg, dist) { return y - (dist || EYE_DIST) * Math.tan(deg * DEG); },
    /**
     * Seeded offset (degrees) of the eye after the n-th jump to a zoom target: ±(3–9)°, so the student looks
     * roughly, but not exactly, level and must re-level the eye at each place.
     */
    jumpOffset: function (seed, n) {
      var r = VL.rng.create(String(seed) + '/eye/' + n);
      var sign = r.next() < 0.5 ? -1 : 1;
      return sign * r.uniform(3, 9);
    },
    EYE_DIST: EYE_DIST,
    EYE_MAX: EYE_MAX
  };

  /** Seeded initial eye angle: params.eyeStart when the experiment defines it, otherwise ±6°. */
  function initialEye(params, seed) {
    if (params && typeof params.eyeStart === 'number' && isFinite(params.eyeStart)) return clamp(params.eyeStart, -EYE_MAX, EYE_MAX);
    if (VL.rng && seed) return VL.rng.create(String(seed)).fork('eye').uniform(-6, 6);
    return 4;
  }

  function prefersReducedMotion() {
    try { return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  function errText(e) { return e && e.message ? e.message : String(e); }

  /* ================================================================== */
  /* Control helpers handed to controller.controls(container, ui)       */
  /* ================================================================== */

  function controlHelpers() {
    var helpers = Object.create(ui);
    var h = ui.h;

    /**
     * A control button. opts.hold = true repeats while held (pointer) — keyboard auto-repeat works natively.
     * @returns {HTMLButtonElement}
     */
    helpers.button = function (label, onClick, opts) {
      opts = opts || {};
      var b = h('button', { type: 'button', class: 'vl-btn vl-ctl-btn' + (opts.className ? ' ' + opts.className : ''), title: opts.title || null }, label);
      if (!opts.hold) {
        b.addEventListener('click', function (ev) { onClick(ev); });
        return b;
      }
      var timer = null, repeating = false, pointerFired = false;
      function stop() { clearTimeout(timer); timer = null; repeating = false; }
      function repeat() { onClick({ repeat: true }); timer = setTimeout(repeat, 110); }
      b.addEventListener('pointerdown', function (ev) {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        pointerFired = true;
        onClick(ev);
        repeating = true;
        timer = setTimeout(repeat, 450);
      });
      ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(function (t) { b.addEventListener(t, stop); });
      b.addEventListener('click', function (ev) {
        if (pointerFired && ev.detail !== 0) { pointerFired = false; return; }
        pointerFired = false;
        onClick(ev);                       // keyboard activation
      });
      b.addEventListener('contextmenu', function (ev) { if (repeating) ev.preventDefault(); });
      return b;
    };

    /** A two-state button (aria-pressed). onChange(newState). */
    helpers.toggle = function (label, initial, onChange, opts) {
      opts = opts || {};
      var state = !!initial;
      var b = h('button', { type: 'button', class: 'vl-btn vl-ctl-btn vl-ctl-toggle', 'aria-pressed': state ? 'true' : 'false', title: opts.title || null },
        h('span', { class: 'vl-ctl-tick', 'aria-hidden': 'true' }, state ? '✓' : ''), ' ', label);
      b.addEventListener('click', function () {
        state = !state;
        b.setAttribute('aria-pressed', state ? 'true' : 'false');
        b.firstChild.textContent = state ? '✓' : '';
        onChange(state);
      });
      b.setPressed = function (v) {
        state = !!v;
        b.setAttribute('aria-pressed', state ? 'true' : 'false');
        b.firstChild.textContent = state ? '✓' : '';
      };
      return b;
    };

    /** A labelled group of controls; append children to the returned element. */
    helpers.group = function (label) {
      var id = 'vl-ctlg-' + (++groupCount);
      return h('div', { class: 'vl-ctl-group', role: 'group', 'aria-labelledby': id },
        h('span', { class: 'vl-ctl-group-label', id: id }, label));
    };

    /** A short explanatory note. */
    helpers.note = function (text) { return h('p', { class: 'vl-ctl-note' }, text); };
    return helpers;
  }
  var groupCount = 0;

  /* ================================================================== */
  /* Mount                                                               */
  /* ================================================================== */

  var mountCount = 0;

  function mount(container, opts) {
    opts = opts || {};
    var h = ui.h;
    var exp = opts.exp;
    var question = opts.question || {};
    var baseServices = opts.services || {};
    var mode = baseServices.mode || 'practice';
    var readOnly = !!opts.readOnly;
    var id = 'vl-app-' + (++mountCount);
    var destroyed = false;
    var offs = [];

    function onChange(kind) {
      if (typeof opts.onChange === 'function') { try { opts.onChange(kind); } catch (e) { console.error('[apparatusView onChange]', e); } }
    }
    function listen(target, type, fn, o) { target.addEventListener(type, fn, o); offs.push(function () { target.removeEventListener(type, fn, o); }); }

    /* ---------------------------------------------------------------- DOM skeleton */

    var zoomLabel = h('span', { class: 'vl-app-zoomlevel', 'aria-live': 'off' }, '×1.0');
    var zoomOutBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--icon', title: 'Zoom out (−)', 'aria-label': 'Zoom out', on: { click: function () { api.zoomOut(); } } }, '−');
    var zoomInBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--icon', title: 'Zoom in (+)', 'aria-label': 'Zoom in', on: { click: function () { api.zoomIn(); } } }, '+');
    var toolbar = h('div', { class: 'vl-app-toolbar', role: 'toolbar', 'aria-label': 'Apparatus view' },
      h('div', { class: 'vl-app-zoom', role: 'group', 'aria-label': 'Zoom' },
        zoomOutBtn, zoomLabel, zoomInBtn,
        h('button', { type: 'button', class: 'vl-btn', title: 'Show the whole apparatus (0)', on: { click: function () { api.zoomReset(); } } }, 'Fit')));
    var targetsBox = h('div', { class: 'vl-app-targets', role: 'group', 'aria-label': 'Zoom to' });
    toolbar.appendChild(targetsBox);

    var canvas = h('canvas', {
      class: 'vl-app-canvas', tabindex: '0', role: 'application',
      'aria-roledescription': 'apparatus',
      'aria-label': 'Apparatus. Drag empty space to move the view, scroll or pinch to zoom, arrow keys to move the view.',
      'aria-describedby': id + '-help'
    });
    var stageMsgText = h('span', { class: 'vl-app-stagemsg-text' });
    var stageMsgBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--small vl-app-reload', hidden: true,
      on: { click: function () { api.reloadApparatus(); } } }, 'Reload apparatus');
    var stageMsg = h('div', { class: 'vl-app-stagemsg', hidden: true, role: 'alert' }, stageMsgText, ' ', stageMsgBtn);
    var hintBox = h('div', { class: 'vl-app-hint', hidden: true, role: 'note' });
    var eye = buildEye();
    var stage = h('div', { class: 'vl-app-stage' }, canvas, stageMsg, hintBox);
    var stageRow = h('div', { class: 'vl-app-stagerow' }, stage, eye.el);
    var help = h('p', { class: 'vl-sr-only', id: id + '-help' },
      'Use the experiment controls below the picture. Read the scales yourself and type what you read in the reading pad.');
    var bench = h('div', { class: 'vl-bench', role: 'group', 'aria-label': 'Bench tools', hidden: true });
    var controlsBox = h('div', { class: 'vl-app-controls', role: 'group', 'aria-label': 'Experiment controls' });
    var pad = buildPad();

    var root = h('div', { class: 'vl-apparatus' }, toolbar, stageRow, help,
      h('div', { class: 'vl-app-lower' }, bench, controlsBox, pad.el));
    container.appendChild(root);

    /* ---------------------------------------------------------------- params, rng, services */

    var params = opts.params;
    var rootRng = VL.rng ? VL.rng.create(String(question.seed || 'LAB-0000-0000')) : null;
    if (!params && exp && typeof exp.sampleParams === 'function' && rootRng) {
      try { params = exp.sampleParams(rootRng.fork('params'), question.variantId); }
      catch (e) { console.error('[apparatusView sampleParams]', e); params = {}; }
    }
    params = params || {};

    var stopwatch = null;
    if (VL.instruments && typeof VL.instruments.create === 'function') {
      try { stopwatch = VL.instruments.create('stopwatch', {}, rootRng ? rootRng.fork('stopwatch') : undefined); }
      catch (e) { console.warn('[apparatusView] stopwatch unavailable', e); }
    }

    var startedMs = Date.parse(question.startedAt || '') || Date.now();
    var view = { cx: 50, cy: 50, z: 1 };
    var anim = null;        // { from, to, t0, dur, done }
    var dirty = true;
    var zMax = ZOOM_MAX;
    var g = null, W = 0, H = 0, fit = 1, firstSize = true;      // canvas context and size (css px), px per cm at ×1
    var raf = 0, lastNow = null;                                 // animation frame
    var MAX_STEP = 0.1, MAX_CATCHUP = 60;
    var msgKind = null;                                          // stage message: null | 'static' | 'transient' | 'fatal'
    var failStreak = 0, okStreak = 0, halted = false;            // error recovery

    var services = {
      mode: mode,
      hints: !!baseServices.hints,
      log: function (event) {
        var e = { t: Math.max(0, Date.now() - startedMs) };
        Object.keys(event || {}).forEach(function (k) { if (k !== 't') e[k] = event[k]; });
        if (typeof baseServices.log === 'function') baseServices.log(e);
        else {
          if (!Array.isArray(question.log)) question.log = [];
          question.log.push(e);
        }
        onChange('log');
        return e;
      },
      now: function () {
        var p = globalThis.performance;
        return p && typeof p.now === 'function' ? p.now() : Date.now();
      },
      stopwatch: stopwatch,
      requestRedraw: function () { invalidate(); },
      /** Pan / zoom the view (used by experiments). The eye stays where it is. */
      focusWorld: function (x, y, zoom) {
        var target = { cx: Number(x), cy: Number(y), z: zoom === undefined || zoom === null ? view.z : Number(zoom) };
        if (!isFinite(target.cx) || !isFinite(target.cy) || !isFinite(target.z)) return;
        animateTo(target);
      },
      toast: function (message) {
        if (mode === 'exam') return;
        if (typeof baseServices.toast === 'function') baseServices.toast(message);
        else if (ui.toast) ui.toast(message);
      }
    };
    // practice cue for the eye (dashed eye-level line, edge tab and note): practice with hints only
    var cueOn = mode === 'practice' && services.hints && !readOnly;

    /* ---------------------------------------------------------------- controller */

    var controller = null;
    var world = { width: 100, height: 100 };

    function createController() {
      controller = null;
      if (!exp || typeof exp.createApparatus !== 'function') {
        showStageMessage('The apparatus for this experiment is not available.', 'static');
        return;
      }
      try {
        controller = exp.createApparatus({
          params: params, variantId: question.variantId,
          rng: rootRng ? rootRng.fork('noise') : null,
          services: services, savedState: question.apparatusState || null
        });
        if (controller && question.apparatusState && typeof controller.setState === 'function') {
          try { controller.setState(question.apparatusState); } catch (e) { console.error('[apparatusView setState]', e); }
        }
      } catch (e) {
        console.error('[apparatusView createApparatus]', e);
        controller = null;
        showStageMessage('The apparatus could not be set up: ' + errText(e), 'static');
      }
      world = { width: 100, height: 100 };
      if (controller && controller.world) {
        world = {
          width: Number(controller.world.width || controller.world.w) || 100,
          height: Number(controller.world.height || controller.world.h) || 100
        };
      }
    }
    createController();

    view = { cx: world.width / 2, cy: world.height / 2, z: 1 };
    var saved = question.viewState;
    var haveSavedView = !!(saved && isNum(saved.cx) && isNum(saved.cy) && isNum(saved.z));
    updateZMax();
    if (haveSavedView) view = viewMath.clampView({ cx: saved.cx, cy: saved.cy, z: saved.z }, world, zMax);

    function eyeDist() {
      var d = controller ? Number(controller.eyeDistance) : NaN;
      return isFinite(d) && d > 0 ? d : EYE_DIST;
    }
    var eyeY, eyeJumps = 0;
    if (saved && isNum(saved.eyeY)) eyeY = saved.eyeY;
    else if (saved && isNum(saved.eye)) eyeY = eyeMath.eyeYFor(isNum(saved.cy) ? saved.cy : view.cy, saved.eye, eyeDist());
    else eyeY = eyeMath.eyeYFor(view.cy, initialEye(params, question.seed), eyeDist());
    if (saved && isNum(saved.eyeJumps) && saved.eyeJumps > 0) eyeJumps = Math.floor(saved.eyeJumps);

    /** Angle (degrees, + = eye above) at which height y is seen. */
    function angleAt(y) { return eyeMath.angleAt(eyeY, y, eyeDist()); }
    /** Angle at the centre of the view: what the slider shows. */
    function centreAngle() { return angleAt(view.cy); }
    eye.render();

    /* ---------------------------------------------------------------- experiment controls, zoom targets, bench */

    var helpers = controlHelpers();
    function renderControls() {
      ui.clear(controlsBox);
      if (controller && typeof controller.controls === 'function') {
        try { controller.controls(controlsBox, helpers); }
        catch (e) { console.error('[apparatusView controls]', e); controlsBox.appendChild(h('p', { class: 'vl-error' }, 'The experiment controls could not be shown.')); }
      }
      controlsBox.hidden = !controlsBox.childNodes.length;
    }
    renderControls();
    // safety net: any control press redraws at once even if the controller forgets to request it
    listen(controlsBox, 'click', function () { invalidate(); });
    listen(controlsBox, 'pointerdown', function () { invalidate(); });

    function targetList() {
      var list = controller && controller.zoomTargets;
      if (typeof list === 'function') { try { list = list(); } catch (e) { list = null; } }
      return Array.isArray(list) ? list : [];
    }
    function renderTargets() {
      ui.clear(targetsBox);
      var list = targetList();
      if (!list.length) { targetsBox.hidden = true; return; }
      targetsBox.hidden = false;
      targetsBox.appendChild(h('span', { class: 'vl-app-targets-label', 'aria-hidden': 'true' }, 'Zoom to:'));
      list.forEach(function (t) {
        targetsBox.appendChild(h('button', {
          type: 'button', class: 'vl-btn vl-btn--chip', title: 'Zoom to ' + t.label,
          'aria-label': 'Zoom to ' + t.label,
          on: { click: function () { goToTarget(t); canvas.focus({ preventScroll: true }); } }
        }, t.label));
      });
    }
    renderTargets();

    var widget = null;
    var uses = controller && Array.isArray(controller.uses) ? controller.uses : [];
    if (uses.indexOf('stopwatch') !== -1) {
      if (stopwatch && typeof VL.instruments.stopwatchWidget === 'function') {
        bench.hidden = false;
        restoreStopwatch(question.stopwatchState);
        try {
          widget = VL.instruments.stopwatchWidget(bench, stopwatch, {
            now: services.now,
            label: 'Stopwatch',
            onEvent: function (kind, info) {
              var extra = null;
              if (controller && typeof controller.onStopwatchEvent === 'function') {
                try { extra = controller.onStopwatchEvent(kind, info); } catch (e) { console.error('[onStopwatchEvent]', e); }
              }
              var entry = { type: 'stopwatch-' + kind, shown: info ? info.display : undefined };
              if (extra && typeof extra === 'object') Object.keys(extra).forEach(function (k) { if (k !== 'type' && k !== 't') entry[k] = extra[k]; });
              services.log(entry);
            }
          });
        } catch (e) {
          console.error('[apparatusView stopwatch widget]', e);
          bench.appendChild(h('p', { class: 'vl-error' }, 'The stopwatch could not be shown.'));
        }
      } else {
        bench.hidden = false;
        bench.appendChild(h('p', { class: 'vl-placeholder' }, 'The stopwatch is not available in this build.'));
      }
    }

    /** Stopwatch reading to keep with the question ({ elapsed, running }). */
    function stopwatchState() {
      if (!stopwatch) return null;
      var t = services.now();
      if (typeof stopwatch.getState === 'function') {
        try { return stopwatch.getState(t); } catch (e) { /* fall back */ }
      }
      return { elapsed: stopwatch.elapsed(t), running: !!stopwatch.running };
    }
    /** Put a saved reading back on the watch, stopped (the performance.now() time base changes after a reload). */
    function restoreStopwatch(st) {
      if (!stopwatch || !st || !isNum(st.elapsed) || st.elapsed <= 0) return;
      if (typeof stopwatch.setState === 'function') {
        try { stopwatch.setState({ elapsed: st.elapsed }); return; } catch (e) { /* fall back */ }
      }
      stopwatch.reset();
      stopwatch.accMs = st.elapsed * 1000;
    }

    /* ---------------------------------------------------------------- first-time hint (practice) */

    var HINT_KEY = 'hint.zoomEye';
    if (mode === 'practice' && controller && !storageGet(HINT_KEY)) {
      hintBox.hidden = false;
      hintBox.appendChild(h('p', null, h('strong', null, 'Tip: '),
        'Zoom in on the scale to read it. Your eye stays where it is when you move the view: put it level with each mark before you read it.'));
      hintBox.appendChild(h('button', {
        type: 'button', class: 'vl-btn vl-btn--small', on: { click: function () {
          hintBox.hidden = true;
          storageSet(HINT_KEY, true);
          canvas.focus({ preventScroll: true });
        } }
      }, 'Got it'));
    }

    function storageGet(k) { try { return VL.storage ? VL.storage.get(k, null) : null; } catch (e) { return null; } }
    function storageSet(k, v) { try { if (VL.storage) VL.storage.set(k, v); } catch (e) { /* ignore */ } }

    /* ---------------------------------------------------------------- canvas sizing & drawing */

    // The scene is drawn in physical colours (dark string, black scale marks), so it needs a light background in
    // both themes: the light theme uses --bench, the dark theme a dimmer light "lab wall" to reduce glare.
    var SCENE_LIGHT = '#dfe6ee', SCENE_DARK = '#b4bec9';
    var bench_colour = SCENE_LIGHT;

    function readColours() {
      try {
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var cs = globalThis.getComputedStyle(root);
        bench_colour = dark ? SCENE_DARK : ((cs.getPropertyValue('--bench') || '').trim() || SCENE_LIGHT);
      } catch (e) { /* ignore */ }
      invalidate();
    }

    function updateZMax() {
      zMax = viewMath.maxZoom(controller ? controller.maxPxPerCm : null, fit);
      if (view.z > zMax) view = viewMath.clampView(view, world, zMax);
      updateZoomLabel();
    }

    function resize() {
      var w = stage.clientWidth, hgt = stage.clientHeight;
      if (!w || !hgt) { W = H = 0; return; }
      if (w === W && hgt === H && g) return;
      W = w; H = hgt;
      g = ui.fitCanvas(canvas, W, H);
      fit = viewMath.fitScale(world, W, H);
      if (firstSize) {
        firstSize = false;
        if (!haveSavedView) view = { cx: world.width / 2, cy: world.height / 2, z: 1 };
      }
      updateZMax();
      eye.render();
      invalidate();
      frameResult(null, draw(services.now()));
    }

    var ro = null;
    if (typeof globalThis.ResizeObserver === 'function') {
      ro = new globalThis.ResizeObserver(function () { resize(); });
      ro.observe(stage);
    } else {
      listen(globalThis, 'resize', resize);
    }
    var mo = null;
    if (typeof globalThis.MutationObserver === 'function') {
      mo = new globalThis.MutationObserver(readColours);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    function scale() { return fit * view.z; }

    /**
     * Draw one frame. @returns {Error|null} the error thrown by controller.draw, if any.
     */
    function draw(now) {
      if (!g || !W || !H) return null;
      var dpr = globalThis.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr)) { g = ui.fitCanvas(canvas, W, H); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = bench_colour;
      g.fillRect(0, 0, W, H);
      dirty = false;
      if (!controller || typeof controller.draw !== 'function' || halted) return null;
      var s = scale();
      var rect = { x: view.cx - W / 2 / s, y: view.cy - H / 2 / s, width: W / s, height: H / s };
      rect.w = rect.width; rect.h = rect.height;
      var err = null;
      g.save();
      g.setTransform(dpr * s, 0, 0, dpr * s, dpr * (W / 2 - view.cx * s), dpr * (H / 2 - view.cy * s));
      try {
        controller.draw(g, {
          scale: s, eyeAngle: clamp(centreAngle(), -EYE_VIEW_MAX, EYE_VIEW_MAX), eyeY: eyeY, eyeDist: eyeDist(),
          rect: rect, now: now, dpr: dpr, zoom: view.z
        });
      } catch (e) { err = e || new Error('draw failed'); }
      g.restore();
      drawEyeCue(dpr, s);
      return err;
    }

    /* ---------------------------------------------------------------- practice cue: where the eye is */

    var lastCue = null;
    function setCueState(v) {
      if (v === lastCue) return;
      lastCue = v;
      stage.setAttribute('data-eye-cue', v);
    }
    /** Dashed "your eye level" line across the stage, or an edge tab when the eye is above / below the view. */
    function drawEyeCue(dpr, s) {
      if (!cueOn) { setCueState('none'); return; }
      var sy = (eyeY - view.cy) * s + H / 2;
      var ink = '#0b4fb3';
      g.save();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = '13px Arial, Helvetica, sans-serif';
      g.textBaseline = 'middle';
      if (sy >= 0 && sy <= H) {
        sy = Math.round(sy * dpr) / dpr;             // crisp: whole device pixels
        g.strokeStyle = ink;
        g.lineWidth = 2;
        g.setLineDash([8, 6]);
        g.beginPath();
        g.moveTo(30, sy); g.lineTo(W, sy);
        g.stroke();
        g.setLineDash([]);
        drawEyeGlyph(14, sy, ink);
        var label = 'your eye level';
        var tw = g.measureText(label).width;
        var ly = sy - 12 < 10 ? sy + 13 : sy - 12;
        g.fillStyle = 'rgba(255, 255, 255, 0.85)';
        g.fillRect(30, ly - 9, tw + 10, 18);
        g.fillStyle = ink;
        g.fillText(label, 35, ly);
        setCueState('line');
      } else {
        var above = sy < 0;
        var text = above ? 'Eye above ↑' : 'Eye below ↓';
        var w = g.measureText(text).width + 40, hh = 26;
        var y0 = above ? 6 : H - hh - 6;
        g.fillStyle = 'rgba(255, 255, 255, 0.92)';
        g.strokeStyle = ink;
        g.lineWidth = 2;
        g.beginPath();
        g.rect(6, y0, w, hh);
        g.fill();
        g.stroke();
        drawEyeGlyph(20, y0 + hh / 2, ink);
        g.fillStyle = ink;
        g.fillText(text, 34, y0 + hh / 2);
        setCueState(above ? 'above' : 'below');
      }
      g.restore();
    }
    function drawEyeGlyph(x, y, ink) {
      g.save();
      g.strokeStyle = ink;
      g.fillStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x - 9, y);
      g.quadraticCurveTo(x, y - 8, x + 9, y);
      g.quadraticCurveTo(x, y + 8, x - 9, y);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = ink;
      g.beginPath();
      g.arc(x, y, 2.6, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    /* ---------------------------------------------------------------- stage messages and error recovery */

    function showStageMessage(msg, kind) {
      stageMsgText.textContent = msg;
      stageMsg.hidden = false;
      msgKind = kind || 'static';
      stageMsgBtn.hidden = msgKind !== 'fatal';
    }
    function hideStageMessage() {
      stageMsg.hidden = true;
      stageMsgText.textContent = '';
      stageMsgBtn.hidden = true;
      msgKind = null;
    }

    /** Count clean / failing frames: hide a transient banner after 30 clean frames, stop after 60 failures. */
    function frameResult(updErr, drawErr) {
      var e = updErr || drawErr;
      if (e) {
        okStreak = 0;
        failStreak++;
        if (failStreak === 1) console.error(updErr ? '[apparatusView update]' : '[apparatusView draw]', e);
        var msg = updErr ? 'The apparatus stopped responding: ' + errText(updErr)
          : 'Part of the apparatus could not be drawn: ' + errText(drawErr);
        if (failStreak >= HALT_AFTER) halt(msg);
        else if (msgKind !== 'static') showStageMessage(msg, 'transient');
        return;
      }
      failStreak = 0;
      if (msgKind === 'transient') {
        okStreak++;
        if (okStreak >= CLEAR_AFTER) { okStreak = 0; hideStageMessage(); }
      }
    }

    function halt(msg) {
      halted = true;
      showStageMessage(msg + ' The apparatus has been stopped.', 'fatal');
      if (raf) { globalThis.cancelAnimationFrame(raf); raf = 0; }
      invalidate();   // one last frame clears the picture to the background
    }

    /* ---------------------------------------------------------------- animation loop */

    function controllerMoving() {
      if (!controller || halted) return false;
      if (typeof controller.isAnimating !== 'function') return true;
      try { return !!controller.isAnimating(); } catch (e) { return true; }
    }

    function frame() {
      raf = 0;
      if (destroyed) return;
      var now = services.now();
      var updErr = null, ran = false;
      if (!halted && controller && typeof controller.update === 'function') {
        var total = lastNow === null ? 0 : Math.max(0, (now - lastNow) / 1000);
        if (total > MAX_CATCHUP) total = MAX_CATCHUP;
        // Sub-step so that integrating controllers stay stable; analytic ones simply use nowMs.
        var steps = Math.max(1, Math.ceil(total / MAX_STEP));
        var dt = total / steps;
        ran = true;
        try {
          for (var i = steps - 1; i >= 0; i--) controller.update(dt, now - i * dt * 1000);
        } catch (e) { updErr = e || new Error('update failed'); }
      }
      lastNow = now;
      stepAnimation(now);
      var moving = controllerMoving();
      var watching = msgKind === 'transient';
      var drawErr = null;
      if (dirty || anim || moving || watching) { drawErr = draw(now); ran = true; }
      if (ran && !halted) frameResult(updErr, drawErr);
      if (anim || dirty || (!halted && (controllerMoving() || msgKind === 'transient'))) schedule();
      else lastNow = null;        // idle: the next frame starts afresh (dt = 0)
    }
    function schedule() {
      if (raf || destroyed) return;
      if (globalThis.document && document.hidden) return;
      if (typeof globalThis.requestAnimationFrame !== 'function') return;
      raf = globalThis.requestAnimationFrame(frame);
    }
    /** Something changed: draw it on the next frame. */
    function invalidate() {
      dirty = true;
      schedule();
    }
    function onVisibility() {
      if (document.hidden) {
        if (raf) { globalThis.cancelAnimationFrame(raf); raf = 0; }
        lastNow = null;
      } else invalidate();
    }
    listen(document, 'visibilitychange', onVisibility);

    /* ---------------------------------------------------------------- view changes */

    function setView(v, silent) {
      view = viewMath.clampView(v, world, zMax);
      updateZoomLabel();
      eye.render();
      invalidate();
      if (!silent) onChange('view');
    }

    function updateZoomLabel() {
      zoomLabel.textContent = '×' + (view.z < 10 ? view.z.toFixed(1) : Math.round(view.z));
      zoomInBtn.disabled = view.z >= zMax - 1e-9;
      zoomOutBtn.disabled = view.z <= ZOOM_MIN + 1e-9;
    }

    function animateTo(target, done) {
      target = viewMath.clampView(target, world, zMax);
      if (prefersReducedMotion() || !W || !H) {
        anim = null;
        setView(target);
        if (done) done();
        return;
      }
      anim = { from: { cx: view.cx, cy: view.cy, z: view.z }, to: target, t0: services.now(), dur: 320, done: done || null };
      invalidate();
    }
    function stepAnimation(now) {
      if (!anim) return;
      var k = clamp((now - anim.t0) / anim.dur, 0, 1);
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      // interpolate zoom geometrically so that it feels uniform
      var z = anim.from.z * Math.pow(anim.to.z / anim.from.z, e);
      var a = anim;
      setView({ cx: a.from.cx + (a.to.cx - a.from.cx) * e, cy: a.from.cy + (a.to.cy - a.from.cy) * e, z: z }, k < 1);
      if (k >= 1) {
        anim = null;
        if (a.done) a.done();
      }
    }

    /**
     * Go to a zoom target (toolbar buttons and any shortcut). This models walking over to look: once there,
     * the eye is put a seeded 3–9° off level with the target, so it has to be levelled again before reading.
     */
    function goToTarget(t) {
      if (!t) return;
      var tx = Number(t.x), ty = Number(t.y);
      var tz = t.zoom === undefined || t.zoom === null ? view.z : Number(t.zoom);
      if (!isFinite(tx) || !isFinite(ty) || !isFinite(tz)) return;
      animateTo({ cx: tx, cy: ty, z: tz }, function () {
        var off = VL.rng ? eyeMath.jumpOffset(question.seed || 'LAB-0000-0000', eyeJumps) : 5;
        eyeJumps++;
        eyeY = eyeMath.eyeYFor(ty, off, eyeDist());
        eye.render();
        invalidate();
        onChange('view');
      });
    }

    function zoomBy(factor, sx, sy) {
      anim = null;
      if (!W || !H) { setView({ cx: view.cx, cy: view.cy, z: view.z * factor }); return; }
      if (sx === undefined) { sx = W / 2; sy = H / 2; }
      setView(viewMath.zoomAbout(view, fit, W, H, sx, sy, factor, zMax));
    }

    /* ---------------------------------------------------------------- pointer: experiment capture, pan, pinch */

    var pointers = {};        // id -> { x, y }
    var gesture = null;       // { mode: 'exp'|'pan'|'pinch', id, last, dist, mid }

    function localPoint(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
    function worldPoint(lp) { return viewMath.toWorld(view, fit, W, H, lp.x, lp.y); }
    function pointerIds() { return Object.keys(pointers); }
    function pinchInfo() {
      var ids = pointerIds();
      var a = pointers[ids[0]], b = pointers[ids[1]];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }

    function onPointerDown(ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      var lp = localPoint(ev);
      pointers[ev.pointerId] = lp;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      if (globalThis.document && document.activeElement !== canvas) {
        try { canvas.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
      anim = null;
      var n = pointerIds().length;
      if (n === 1) {
        var captured = false;
        if (controller && !halted && controller.pointer && typeof controller.pointer.down === 'function') {
          try { captured = !!controller.pointer.down(worldPoint(lp), ev); } catch (e) { console.error('[pointer.down]', e); }
        }
        gesture = captured ? { mode: 'exp', id: ev.pointerId } : { mode: 'pan', id: ev.pointerId, last: lp };
        canvas.classList.toggle('vl-app-canvas--panning', !captured);
      } else if (n === 2) {
        if (gesture && gesture.mode === 'exp') endExperimentGesture(ev, lp);
        var p = pinchInfo();
        gesture = { mode: 'pinch', dist: p.dist, mid: p.mid };
      }
      invalidate();
      ev.preventDefault();
    }

    function endExperimentGesture(ev, lp) {
      if (controller && !halted && controller.pointer && typeof controller.pointer.up === 'function') {
        try { controller.pointer.up(worldPoint(lp || localPoint(ev)), ev); } catch (e) { console.error('[pointer.up]', e); }
      }
      invalidate();
      onChange('state');
    }

    function onPointerMove(ev) {
      var lp = localPoint(ev);
      if (!pointers[ev.pointerId]) {
        // hover (no button pressed): optional controller.pointer.hover(p) -> bool to show a hand cursor
        if (controller && !halted && controller.pointer && typeof controller.pointer.hover === 'function' && W) {
          var over = false;
          try { over = !!controller.pointer.hover(worldPoint(lp), ev); } catch (e) { over = false; }
          canvas.classList.toggle('vl-app-canvas--grab-item', over);
        }
        return;
      }
      pointers[ev.pointerId] = lp;
      if (!gesture) return;
      if (gesture.mode === 'exp' && ev.pointerId === gesture.id) {
        if (controller && !halted && controller.pointer && typeof controller.pointer.move === 'function') {
          try { controller.pointer.move(worldPoint(lp), ev); } catch (e) { console.error('[pointer.move]', e); }
        }
        invalidate();
      } else if (gesture.mode === 'pan' && ev.pointerId === gesture.id) {
        var s = scale();
        setView({ cx: view.cx - (lp.x - gesture.last.x) / s, cy: view.cy - (lp.y - gesture.last.y) / s, z: view.z });
        gesture.last = lp;
      } else if (gesture.mode === 'pinch' && pointerIds().length >= 2) {
        var p = pinchInfo();
        var v = viewMath.zoomAbout(view, fit, W, H, p.mid.x, p.mid.y, p.dist / gesture.dist, zMax);
        var s2 = fit * v.z;
        v.cx -= (p.mid.x - gesture.mid.x) / s2;
        v.cy -= (p.mid.y - gesture.mid.y) / s2;
        setView(v);
        gesture.dist = p.dist;
        gesture.mid = p.mid;
      }
      ev.preventDefault();
    }

    function onPointerUp(ev) {
      if (!pointers[ev.pointerId]) return;
      var lp = localPoint(ev);
      delete pointers[ev.pointerId];
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      if (gesture && gesture.mode === 'exp' && ev.pointerId === gesture.id) {
        endExperimentGesture(ev, lp);
        gesture = null;
      } else if (gesture && gesture.mode === 'pinch') {
        var rest = pointerIds();
        gesture = rest.length === 1 ? { mode: 'pan', id: Number(rest[0]), last: pointers[rest[0]] } : null;
      } else if (!pointerIds().length) {
        gesture = null;
      }
      if (!pointerIds().length) canvas.classList.remove('vl-app-canvas--panning');
      invalidate();
    }

    function onWheel(ev) {
      ev.preventDefault();
      var dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1);
      var factor = Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0015));
      factor = clamp(factor, 0.5, 2);
      var lp = localPoint(ev);
      zoomBy(factor, lp.x, lp.y);
    }

    function onCanvasKey(ev) {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      var step = (ev.shiftKey ? 0.3 : 0.1);
      var s = scale();
      var dx = 0, dy = 0;
      if (ev.key === 'ArrowLeft') dx = -W * step;
      else if (ev.key === 'ArrowRight') dx = W * step;
      else if (ev.key === 'ArrowUp') dy = -H * step;
      else if (ev.key === 'ArrowDown') dy = H * step;
      else return;
      ev.preventDefault();
      anim = null;
      setView({ cx: view.cx + dx / s, cy: view.cy + dy / s, z: view.z });
    }

    listen(canvas, 'pointerdown', onPointerDown);
    listen(canvas, 'pointermove', onPointerMove);
    listen(canvas, 'pointerup', onPointerUp);
    listen(canvas, 'pointercancel', onPointerUp);
    listen(canvas, 'lostpointercapture', function (ev) { if (pointers[ev.pointerId]) onPointerUp(ev); });
    listen(canvas, 'wheel', onWheel, { passive: false });
    listen(canvas, 'keydown', onCanvasKey);
    listen(canvas, 'contextmenu', function (ev) { ev.preventDefault(); });

    /* ---------------------------------------------------------------- eye-level control */

    function buildEye() {
      var DEFAULT_TEXT = 'Move your eye up or down; judge from the view whether it is level with the scale';
      var thumb = h('span', { class: 'vl-eye-thumb', 'aria-hidden': 'true' },
        h('span', { class: 'vl-eye-icon' }));
      var level = h('span', { class: 'vl-eye-level', title: 'The middle of the slider is level with the centre of the view' });
      var track = h('div', { class: 'vl-eye-track' }, h('span', { class: 'vl-eye-rail', 'aria-hidden': 'true' }), level, thumb);
      var slider = h('div', {
        class: 'vl-eye-slider', role: 'slider', tabindex: '0',
        'aria-label': 'Eye position', 'aria-orientation': 'vertical',
        'aria-valuemin': String(-EYE_MAX), 'aria-valuemax': String(EYE_MAX),
        'aria-valuetext': DEFAULT_TEXT,
        title: 'Eye position — drag up or down ([ and ] keys)'
      }, track);
      var note = h('p', { class: 'vl-eye-note', role: 'status', hidden: true }, 'Your eye is not level with the middle of the view.');
      var el = h('div', { class: 'vl-eye' },
        h('span', { class: 'vl-eye-label' }, 'Eye position'),
        h('span', { class: 'vl-eye-end', 'aria-hidden': 'true' }, 'Higher'),
        slider,
        h('span', { class: 'vl-eye-end', 'aria-hidden': 'true' }, 'Lower'),
        note);

      var dragging = null;
      function setFromY(clientY) {
        var r = track.getBoundingClientRect();
        if (!r.height) return;
        var k = clamp((clientY - r.top) / r.height, 0, 1);
        api.setEye(EYE_MAX - k * 2 * EYE_MAX);
      }
      slider.addEventListener('pointerdown', function (ev) {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        dragging = ev.pointerId;
        try { slider.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        slider.focus({ preventScroll: true });
        setFromY(ev.clientY);
        ev.preventDefault();
      });
      slider.addEventListener('pointermove', function (ev) { if (dragging === ev.pointerId) setFromY(ev.clientY); });
      function end(ev) { if (dragging === ev.pointerId) { dragging = null; onChange('view'); } }
      slider.addEventListener('pointerup', end);
      slider.addEventListener('pointercancel', end);
      slider.addEventListener('keydown', function (ev) {
        var d = 0, big = ev.shiftKey ? 2 : 0.5;
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') d = big;
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') d = -big;
        else if (ev.key === 'PageUp') d = 3;
        else if (ev.key === 'PageDown') d = -3;
        else if (ev.key === 'Home') d = EYE_MAX * 2;
        else if (ev.key === 'End') d = -EYE_MAX * 2;
        else return;
        ev.preventDefault();
        eyeStep(d);
        onChange('view');
      });
      return {
        el: el,
        render: function () {
          if (eyeY === undefined) return;
          var a = centreAngle();
          var shown = clamp(a, -EYE_MAX, EYE_MAX);
          thumb.style.top = ((EYE_MAX - shown) / (2 * EYE_MAX) * 100) + '%';
          slider.setAttribute('aria-valuenow', String(Math.round(shown)));
          slider.setAttribute('aria-valuetext', a > EYE_MAX ? 'Eye well above the middle of the view'
            : a < -EYE_MAX ? 'Eye well below the middle of the view' : DEFAULT_TEXT);
          slider.classList.toggle('vl-eye-slider--pinned', Math.abs(a) > EYE_MAX);
          note.hidden = !(cueOn && Math.abs(a) > 1);
        }
      };
    }

    /**
     * Move the eye by d degrees as the slider shows it. A slider pinned at an end (eye far above / below the view)
     * only moves back into range: pressing "higher" never moves an eye that is already above the range lower.
     */
    function eyeStep(d) {
      var cur = centreAngle();
      var next = clamp(clamp(cur, -EYE_MAX, EYE_MAX) + d, -EYE_MAX, EYE_MAX);
      if ((d > 0 && next <= cur) || (d < 0 && next >= cur)) { eye.render(); return; }
      api.setEye(next);
    }

    /* ---------------------------------------------------------------- reading pad */

    function buildPad() {
      var inputId = id + '-pad';
      var input = h('input', {
        class: 'vl-pad-input', id: inputId, type: 'text', autocomplete: 'off', spellcheck: 'false',
        autocapitalize: 'off', placeholder: 'Type what you read', 'aria-describedby': id + '-target'
      });
      var btn = h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-pad-record', 'aria-keyshortcuts': 'R', title: 'Record (Enter, or R)' }, 'Record');
      var target = h('p', { class: 'vl-pad-target', id: id + '-target' });
      var status = h('p', { class: 'vl-sr-only', role: 'status', 'aria-live': 'polite' });
      var confirmText = h('span', { class: 'vl-pad-confirm-text' });
      var replaceBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--small vl-btn--primary vl-pad-replace' }, 'Replace');
      var cancelBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--small vl-pad-cancel' }, 'Cancel');
      var confirmRow = h('div', { class: 'vl-pad-confirm', role: 'group', 'aria-label': 'Replace the value already there?', hidden: true },
        confirmText, replaceBtn, cancelBtn);
      var notesList = h('ol', { class: 'vl-rough-list' });
      var notesCount = h('span', { class: 'vl-rough-count' }, '');
      var clearBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--small vl-btn--ghost' }, 'Clear rough notes');
      var notes = h('details', { class: 'vl-rough' },
        h('summary', null, 'Rough notes ', notesCount, h('span', { class: 'vl-rough-note' }, ' — not marked')),
        h('p', { class: 'vl-rough-help' }, 'Readings recorded with no table cell or answer line selected are kept here. Copy them into your table yourself.'),
        notesList, clearBtn);
      var el = h('div', { class: 'vl-pad', role: 'group', 'aria-label': 'Reading pad' },
        h('div', { class: 'vl-pad-row' },
          h('label', { class: 'vl-pad-label', for: inputId }, 'Reading'),
          input, btn),
        confirmRow, target, status, notes);

      input.addEventListener('keydown', function (ev) {
        if (ev.isComposing) return;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          api.record(confirmRow.hidden ? undefined : { confirmed: true });
        } else if (ev.key === 'Escape' && !confirmRow.hidden) {
          ev.preventDefault();
          ev.stopPropagation();
          cancelConfirm();
        }
      });
      input.addEventListener('input', function () { if (!confirmRow.hidden) hideConfirm(); });
      btn.addEventListener('click', function () { api.record(); });
      replaceBtn.addEventListener('click', function () { api.record({ confirmed: true }); });
      cancelBtn.addEventListener('click', function () { cancelConfirm(); });
      confirmRow.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelConfirm(); }
      });
      clearBtn.addEventListener('click', function () {
        question.roughNotes = [];
        renderNotes();
        onChange('notes');
      });

      function renderNotes() {
        var list = Array.isArray(question.roughNotes) ? question.roughNotes : [];
        ui.clear(notesList);
        list.forEach(function (n) { notesList.appendChild(h('li', null, n)); });
        notesCount.textContent = list.length ? '(' + list.length + ')' : '';
        clearBtn.hidden = !list.length;
      }
      function say(msg) { status.textContent = ''; setTimeout(function () { status.textContent = msg; }, 30); }
      function showConfirm(str, res) {
        confirmText.textContent = '“' + (res.old === undefined ? '' : res.old) + '” is already in ' + (res.label || 'that box') + '. Replace it?';
        confirmRow.hidden = false;
        say(confirmText.textContent + ' Press Enter to replace it, or Escape to keep it.');
        if (document.activeElement !== input) { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }
      }
      function hideConfirm() { confirmRow.hidden = true; confirmText.textContent = ''; }
      function cancelConfirm() {
        hideConfirm();
        say('Not replaced. Your reading is still in the pad.');
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
      }

      return {
        el: el, input: input, button: btn, target: target, status: status, notes: notes, confirmRow: confirmRow,
        renderNotes: renderNotes, say: say, showConfirm: showConfirm, hideConfirm: hideConfirm
      };
    }

    function setTargetText(label) {
      ui.clear(pad.target);
      if (readOnly) {
        pad.target.appendChild(document.createTextNode(opts.readOnlyText || 'This question has been marked; readings can no longer be recorded.'));
        return;
      }
      if (label) {
        pad.target.appendChild(document.createTextNode('Records to: '));
        pad.target.appendChild(h('strong', { class: 'vl-pad-target-label' }, label));
      } else {
        pad.target.appendChild(document.createTextNode('No box selected — click a table cell or an answer line first. Otherwise the reading goes to Rough notes.'));
      }
      pad.target.classList.toggle('vl-pad-target--none', !label);
    }
    var currentTargetLabel = null;
    setTargetText(null);
    pad.renderNotes();
    if (readOnly) { pad.input.disabled = true; pad.button.disabled = true; }

    /* ---------------------------------------------------------------- API */

    var api = {
      el: root,
      controller: controller,
      stopwatch: stopwatch,
      services: services,
      params: params,

      /**
       * Record the reading pad's text to the current target (or rough notes).
       * When the target already holds another value nothing is written and an inline "Replace it?" row is shown;
       * Enter / Replace calls record({ confirmed: true }). After a successful record the pad is cleared and the
       * focus goes back to the apparatus, so Space and X work the stopwatch straight away.
       * @param {{confirmed?: boolean}} [o]
       * @returns {boolean} true when the reading was recorded
       */
      record: function (o) {
        if (readOnly) return false;
        var str = pad.input.value.trim();
        if (!str) { pad.hideConfirm(); pad.input.focus(); pad.say('Type the reading first, then press Enter.'); return false; }
        var confirmed = !!(o && o.confirmed);
        var res = null;
        if (typeof opts.onRecord === 'function') {
          try { res = opts.onRecord(str, { confirmed: confirmed }); } catch (e) { console.error('[apparatusView onRecord]', e); res = null; }
        }
        if (res && res.needsConfirm) { pad.showConfirm(str, res); return false; }
        pad.hideConfirm();
        var label = res && res.label ? res.label : null;
        var snapshot = null;
        if (controller && !halted && typeof controller.snapshot === 'function') {
          try { snapshot = controller.snapshot(); } catch (e) { console.error('[snapshot]', e); }
        }
        services.log({ type: 'record', typed: str, target: label || 'Rough notes', snapshot: snapshot });
        if (!label) {
          if (!Array.isArray(question.roughNotes)) question.roughNotes = [];
          question.roughNotes.push(str);
          pad.renderNotes();
          pad.notes.open = true;
          onChange('notes');
        }
        pad.say('Recorded to ' + (label || 'Rough notes') + ': “' + str + '”.');
        pad.input.value = '';
        pad.input.blur();
        try { canvas.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        return true;
      },
      /** Put the keyboard focus in the reading pad. */
      focusPad: function () { pad.input.focus(); },
      /** Show where the next Record goes (a pending "Replace it?" question is dropped). */
      setTargetLabel: function (label) {
        currentTargetLabel = label || null;
        pad.hideConfirm();
        setTargetText(currentTargetLabel);
      },
      /** Copy the controller state, the view, the eye and the stopwatch into the question (before every save). */
      saveState: function () {
        if (controller && !halted && typeof controller.getState === 'function') {
          try { question.apparatusState = controller.getState(); } catch (e) { console.error('[getState]', e); }
        }
        question.viewState = { cx: view.cx, cy: view.cy, z: view.z, eye: centreAngle(), eyeY: eyeY, eyeJumps: eyeJumps };
        var sw = stopwatchState();
        if (sw) question.stopwatchState = sw;
      },
      zoomIn: function () { zoomBy(BUTTON_FACTOR); },
      zoomOut: function () { zoomBy(1 / BUTTON_FACTOR); },
      zoomReset: function () { animateTo({ cx: world.width / 2, cy: world.height / 2, z: 1 }); },
      /** Go to a zoom target { x, y, zoom } (re-places the eye; see goToTarget above). */
      goToTarget: function (t) { goToTarget(t); },
      eyeLower: function () { eyeStep(-1); onChange('view'); },
      eyeHigher: function () { eyeStep(1); onChange('view'); },
      /** Angle (degrees, + = eye above) at which the centre of the view is seen. */
      getEye: function () { return centreAngle(); },
      /** Put the eye `deg` degrees (clamped to ±15°) above the level of the centre of the view. */
      setEye: function (deg) {
        if (!isFinite(deg)) return;
        eyeY = eyeMath.eyeYFor(view.cy, clamp(Number(deg), -EYE_MAX, EYE_MAX), eyeDist());
        eye.render();
        invalidate();
      },
      /** World height of the eye (cm, y down). */
      getEyeY: function () { return eyeY; },
      setEyeY: function (y) {
        if (!isFinite(y)) return;
        eyeY = Number(y);
        eye.render();
        invalidate();
      },
      hasStopwatch: function () { return !!widget; },
      stopwatchToggle: function () { if (!widget) return false; widget.toggle(); return true; },
      stopwatchReset: function () { if (!widget) return false; widget.reset(); return true; },
      /** The current view (for tests). */
      getView: function () { return { cx: view.cx, cy: view.cy, z: view.z, fit: fit, width: W, height: H, zMax: zMax }; },
      /** Largest zoom factor for this stage size. */
      getZoomMax: function () { return zMax; },
      /** Set the view directly (tests); the eye stays where it is. */
      setView: function (v) { anim = null; setView({ cx: Number(v.cx), cy: Number(v.cy), z: v.z === undefined ? view.z : Number(v.z) }); },
      /**
       * Throw the controller away and build it again from the last saved state (after it stopped working).
       */
      reloadApparatus: function () {
        if (destroyed) return;
        if (controller && typeof controller.destroy === 'function') {
          try { controller.destroy(); } catch (e) { console.error('[controller.destroy]', e); }
        }
        hideStageMessage();
        halted = false;
        failStreak = okStreak = 0;
        pointers = {};
        gesture = null;
        createController();
        api.controller = controller;
        renderControls();
        renderTargets();
        if (W && H) fit = viewMath.fitScale(world, W, H);
        updateZMax();
        view = viewMath.clampView(view, world, zMax);
        eye.render();
        lastNow = null;
        invalidate();
        onChange('state');
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (raf) { globalThis.cancelAnimationFrame(raf); raf = 0; }
        if (ro) ro.disconnect();
        if (mo) mo.disconnect();
        offs.forEach(function (off) { off(); });
        offs = [];
        if (widget) { try { widget.destroy(); } catch (e) { /* ignore */ } }
        if (controller && typeof controller.destroy === 'function') {
          try { controller.destroy(); } catch (e) { console.error('[controller.destroy]', e); }
        }
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };

    readColours();
    resize();
    invalidate();
    return api;
  }

  ui.apparatusView = { mount: mount, viewMath: viewMath, eyeMath: eyeMath, initialEye: initialEye };
})(globalThis.VLab = globalThis.VLab || {});
