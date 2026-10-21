/**
 * Instrument engine — shared base (contract §3.7).
 *
 * VL.instruments = { types, define(type, factory), create(type, opts, rng), list(), util, ... }
 *
 * Every instrument instance has:
 *   type, name, unit, resolution, range: [min, max], zeroError (hidden), tolerance, digital,
 *   indicate(trueValue, now?)   -> what the instrument physically shows
 *   draw(g, place, view, state) -> draws at TRUE physical size on a context already in WORLD units (1 = 1 cm, y down)
 *   describe()                  -> tutorial HTML (trusted, authored here)
 *   apparentShift(gap, view)    -> world-y shift (cm, + = down) of an object `gap` cm IN FRONT of the scale plane
 *                                  as seen by an eye that is view.eyeAngle degrees above the normal (parallax)
 *   format(value)               -> value as a string to the instrument's resolution
 *
 * Factories are registered with define(type, factory(inst, opts, rng)) and fill in `inst`.
 * A factory may set inst.zeroErrorSpec = { resolution, chance, maxDivisions } (or null); create() then draws the
 * hidden zero error with VL.noise.zeroError(rng, spec) unless opts.zeroError is given explicitly.
 *
 * No DOM access at load time; drawing helpers only run in the browser.
 */
(function (VL) {
  'use strict';

  var I = VL.instruments = VL.instruments || {};
  I.types = I.types || {};

  /* ------------------------------------------------------------------ */
  /* Numeric helpers                                                     */
  /* ------------------------------------------------------------------ */

  /** Current global noise level (1 when VL.noise has not loaded). */
  function noiseLevel() {
    var n = VL.noise;
    return n && typeof n.level === 'number' ? n.level : 1;
  }

  /** Number of decimal places needed to show a resolution (0.02 -> 2, 0.5 -> 1, 2 -> 0). */
  function decimalsOf(resolution) {
    for (var d = 0; d <= 10; d++) {
      var s = resolution * Math.pow(10, d);
      if (Math.abs(Math.round(s) - s) < 1e-9 * Math.max(1, Math.abs(s))) return d;
    }
    return 10;
  }

  /** Round to the nearest multiple of `step`, removing binary noise (and negative zero). */
  function roundTo(value, step) {
    if (!isFinite(value)) return value;
    if (!step) return value;
    var q = Math.round(value / step) * step;
    var r = Number(q.toFixed(Math.min(12, decimalsOf(step) + 2)));
    return r === 0 ? 0 : r;
  }

  /** Remove floating-point noise from a value, keeping `dp` decimals beyond the step precision. */
  function clean(value, step) {
    if (!isFinite(value)) return value;
    var r = Number(value.toFixed(Math.min(12, decimalsOf(step || 1e-6) + 4)));
    return r === 0 ? 0 : r;
  }

  /** Quantize to a resolution (uses VL.noise.quantize when available). */
  function quantize(value, resolution) {
    var q = VL.noise && typeof VL.noise.quantize === 'function'
      ? VL.noise.quantize(value, resolution) : Math.round(value / resolution) * resolution;
    return roundTo(q, resolution);
  }

  /** Truncate towards −∞ to a resolution (stopwatch-style display). */
  function truncate(value, resolution) {
    var q = Math.floor(value / resolution + 1e-9) * resolution;
    return roundTo(q, resolution);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Format a number with fixed decimals, never showing "-0.00". */
  function fixed(value, decimals) {
    var s = Number(value).toFixed(decimals);
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
    return s;
  }

  /**
   * Hidden zero error for an instrument.
   * Uses VL.noise.zeroError(rng, spec) when available; otherwise a contract-compatible fallback.
   * Always 0 without an rng, with chance 0, or when VL.noise.level === 0 (rng draws are still consumed).
   * @param {object} rng  VL.rng Rng
   * @param {{resolution:number, chance?:number, maxDivisions?:number}} spec
   */
  function zeroError(rng, spec) {
    if (!rng || !spec || !spec.resolution) return 0;
    var chance = spec.chance === undefined ? 0.3 : spec.chance;
    var z;
    if (VL.noise && typeof VL.noise.zeroError === 'function') {
      // VL.noise.zeroError always consumes the same number of draws, so other streams stay reproducible
      // whatever the noise level or chance.
      z = VL.noise.zeroError(rng, { resolution: spec.resolution, chance: chance, maxDivisions: spec.maxDivisions || 3 });
    } else {
      if (chance <= 0 || noiseLevel() === 0) return 0;
      if (rng.next() >= chance) return 0;
      var k = 1 + Math.floor(rng.next() * (spec.maxDivisions || 3));
      z = (rng.next() < 0.5 ? -1 : 1) * k * spec.resolution;
    }
    return roundTo(z, spec.resolution);
  }

  /** Apparent shift of something `gap` cm in front of a scale for an eye `eyeAngleDeg` above the normal. */
  function parallaxShift(gap, eyeAngleDeg) {
    if (!gap || !eyeAngleDeg) return 0;
    if (VL.noise && typeof VL.noise.parallaxShift === 'function') return VL.noise.parallaxShift(gap, eyeAngleDeg);
    return gap * Math.tan(eyeAngleDeg * Math.PI / 180);
  }

  /* Deterministic, stateless pseudo-noise (for last-digit flicker): a pure function of (seed, slot). */

  /** FNV-1a 32-bit string hash. */
  function hashString(str) {
    var h = 0x811c9dc5;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function mix32(x) {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  }
  /** Uniform (0, 1) for an integer slot. */
  function unitAt(seed, k) {
    return (mix32((seed ^ mix32((k | 0) + 0x9e3779b9)) >>> 0) + 0.5) / 4294967296;
  }
  /** Standard normal for an integer slot. */
  function normalAt(seed, k) {
    var u1 = unitAt(seed, 2 * k), u2 = unitAt(seed + 0x6d2b79f5, 2 * k + 1);
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Flicker of a digital display at time `now` (ms), in display units. 0 when now is undefined
   * or VL.noise.level === 0. The value changes every inst.flickerMs milliseconds.
   */
  function flicker(inst, now) {
    if (now === undefined || now === null || !isFinite(now)) return 0;
    var level = noiseLevel();
    if (!level || !inst.flickerSd) return 0;
    var slot = Math.floor(now / (inst.flickerMs || 400));
    return normalAt(inst.flickerSeed >>> 0, slot) * inst.flickerSd * level;
  }

  /* ------------------------------------------------------------------ */
  /* Drawing helpers (browser only — called from draw())                */
  /* ------------------------------------------------------------------ */

  /** Line width in world cm: the physical width, but never thinner than one CSS pixel. */
  function lineW(view, physicalCm) {
    var s = view && view.scale > 0 ? view.scale : 10;
    return Math.max(physicalCm, 1 / s);
  }

  var FONT = 'Arial, Helvetica, "Liberation Sans", sans-serif';

  /**
   * Draw text whose size is given in world cm (so it is only legible when zoomed in).
   * @param {CanvasRenderingContext2D} g
   * @param {string} str
   * @param {number} x
   * @param {number} y
   * @param {number} sizeCm   cap height-ish font size in cm
   * @param {{align?:string, baseline?:string, rotate?:number, weight?:string, colour?:string,
   *          family?:string, scaleY?:number}} [o]
   */
  function text(g, str, x, y, sizeCm, o) {
    o = o || {};
    var k = sizeCm / 10;
    g.save();
    g.translate(x, y);
    if (o.rotate) g.rotate(o.rotate);
    g.scale(k, k * (o.scaleY === undefined ? 1 : o.scaleY));
    g.font = '10px ' + FONT;          // plain Arial everywhere: no weight or family overrides
    g.textAlign = o.align || 'center';
    g.textBaseline = o.baseline || 'middle';
    if (o.colour) g.fillStyle = o.colour;
    g.fillText(str, 0, 0);
    g.restore();
  }

  /**
   * The visible canvas area expressed in the CURRENT local coordinates of g (after any translate/rotate),
   * as an axis-aligned box { x0, y0, x1, y1 }. Used to skip drawing off-screen ticks. null if unknown.
   */
  function visibleRect(g) {
    if (!g || typeof g.getTransform !== 'function' || !g.canvas) return null;
    var inv;
    try { inv = g.getTransform().inverse(); } catch (e) { return null; }
    if (!inv || !isFinite(inv.a)) return null;
    var w = g.canvas.width, h = g.canvas.height;
    var pts = [[0, 0], [w, 0], [0, h], [w, h]];
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) {
      var x = inv.a * p[0] + inv.c * p[1] + inv.e;
      var y = inv.b * p[0] + inv.d * p[1] + inv.f;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    });
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /** Trace a rounded rectangle path. */
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r);
    g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h);
    g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    g.closePath();
  }

  /** Convex hull (monotone chain) of [{x, y}] points. */
  function hull(points) {
    var p = points.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    if (p.length < 3) return p;
    function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
    var lower = [], upper = [], i;
    for (i = 0; i < p.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
      lower.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  /**
   * Draw the side faces of a flat object of thickness `thickness` that become visible when the eye is not
   * level (parallax cue). `corners` are the WORLD corners of the front face (the scale plane). The back face
   * appears displaced by −thickness·tan(eyeAngle) in world y; the region between is filled with `colour`.
   */
  function drawEdgeFace(g, corners, thickness, view, colour, stroke) {
    var eye = view && view.eyeAngle ? view.eyeAngle : 0;
    var dy = -parallaxShift(thickness, eye);
    if (Math.abs(dy) < 1e-5) return;
    var pts = corners.concat(corners.map(function (c) { return { x: c.x, y: c.y + dy }; }));
    var h = hull(pts);
    g.save();
    g.beginPath();
    h.forEach(function (p, i) { if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); });
    g.closePath();
    g.fillStyle = colour;
    g.fill();
    if (stroke) {
      g.lineWidth = lineW(view, 0.01);
      g.strokeStyle = stroke;
      g.stroke();
    }
    g.restore();
  }

  /** Transform local points (after translate(x,y) + rotate(a)) to world points. */
  function toWorld(place, a, pts) {
    var c = Math.cos(a), s = Math.sin(a);
    return pts.map(function (p) {
      return { x: place.x + p[0] * c - p[1] * s, y: place.y + p[0] * s + p[1] * c };
    });
  }

  /*
   * Seven-segment LCD renderer (balance, stopwatch, timers, multimeter).
   * Segments: a top, b upper right, c lower right, d bottom, e lower left, f upper left, g middle.
   */
  var SEG = {
    '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg',
    '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '', 'E': 'adefg', 'r': 'eg', 'o': 'cdeg',
    'O': 'abcdef', 'L': 'def', 'P': 'abefg', 'H': 'bcefg', 'n': 'ceg', 'd': 'bcdeg', 'u': 'cde', 'b': 'cdefg',
    'C': 'adef', 'A': 'abcefg', 'F': 'aefg', 't': 'defg'
  };

  /**
   * Draw a seven-segment string. '.' and ':' attach to the previous digit.
   * @param {CanvasRenderingContext2D} g
   * @param {string} str
   * @param {number} xRight  right edge of the last digit (right-aligned like a real LCD)
   * @param {number} yTop
   * @param {number} h       digit height in cm
   * @param {{on:string, off?:string, digits?:number, view?:object, italic?:number}} o
   *        digits: total digit cells (unlit cells drawn with `off` colour as "ghost" 8s)
   */
  function sevenSeg(g, str, xRight, yTop, h, o) {
    o = o || {};
    var w = h * 0.55, gap = h * 0.22, t = h * 0.11, skew = o.italic === undefined ? 0.1 : o.italic;
    var cells = [];
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if ((ch === '.' || ch === ':') && cells.length) { cells[cells.length - 1][ch === '.' ? 'dot' : 'colon'] = true; continue; }
      if (ch === ':' || ch === '.') { cells.push({ ch: ' ', dot: ch === '.', colon: ch === ':' }); continue; }
      cells.push({ ch: ch });
    }
    var n = Math.max(cells.length, o.digits || 0);
    while (cells.length < n) cells.unshift({ ch: ' ', ghost: true });
    var pitch = w + gap;
    var x0 = xRight - n * pitch + gap;
    g.save();
    for (var c = 0; c < n; c++) {
      var cell = cells[c];
      var lit = SEG[cell.ch] !== undefined ? SEG[cell.ch] : '';
      var x = x0 + c * pitch;
      'abcdefg'.split('').forEach(function (s) {
        var on = lit.indexOf(s) >= 0;
        if (!on && !o.off) return;
        g.fillStyle = on ? o.on : o.off;
        seg(g, s, x, yTop, w, h, t, skew);
      });
      if (cell.dot || o.off) {
        g.fillStyle = cell.dot ? o.on : o.off;
        g.beginPath();
        g.arc(x + w + gap * 0.45 - skew * 0, yTop + h - t * 0.5, t * 0.6, 0, Math.PI * 2);
        g.fill();
      }
      if (cell.colon) {
        g.fillStyle = o.on;
        [0.3, 0.72].forEach(function (f) {
          g.beginPath();
          g.arc(x + w + gap * 0.45 + skew * h * (0.5 - f), yTop + h * f, t * 0.55, 0, Math.PI * 2);
          g.fill();
        });
      }
    }
    g.restore();
    return { width: n * pitch - gap, pitch: pitch };
  }

  function seg(g, s, x, y, w, h, t, skew) {
    var hh = h / 2, k = skew * h;
    // skew: shift x by k * (0.5 - yFraction)
    function P(px, py) { return [x + px + k * (0.5 - py / h), y + py]; }
    var pts;
    var e = t * 0.5;
    switch (s) {
      case 'a': pts = [P(e, 0), P(w - e, 0), P(w - t, t), P(t, t)]; break;
      case 'd': pts = [P(t, h - t), P(w - t, h - t), P(w - e, h), P(e, h)]; break;
      case 'g': pts = [P(t, hh - t / 2), P(w - t, hh - t / 2), P(w - e, hh), P(w - t, hh + t / 2), P(t, hh + t / 2), P(e, hh)]; break;
      case 'f': pts = [P(0, e), P(t, t), P(t, hh - t / 2), P(0, hh - e * 0.2)]; break;
      case 'e': pts = [P(0, hh + e * 0.2), P(t, hh + t / 2), P(t, h - t), P(0, h - e)]; break;
      case 'b': pts = [P(w, e), P(w, hh - e * 0.2), P(w - t, hh - t / 2), P(w - t, t)]; break;
      case 'c': pts = [P(w, hh + e * 0.2), P(w, h - e), P(w - t, h - t), P(w - t, hh + t / 2)]; break;
      default: return;
    }
    g.beginPath();
    pts.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); });
    g.closePath();
    g.fill();
  }

  /* ------------------------------------------------------------------ */
  /* Instance prototype                                                  */
  /* ------------------------------------------------------------------ */

  var proto = {
    digital: false,
    zeroError: 0,

    /**
     * What the instrument shows for a true value: true + zeroError (+ flicker for digital displays when `now`
     * is given), clamped to the range, quantized to the resolution for digital instruments.
     * @param {number} trueValue  in the display unit
     * @param {number} [now]      ms (performance.now()); omit for a steady (flicker-free) value
     */
    indicate: function (trueValue, now) {
      var v = trueValue + (this.zeroError || 0);
      if (this.digital) v += flicker(this, now);
      v = clamp(v, this.range[0] - this.overRange, this.range[1] + this.overRange);
      return this.digital ? quantize(v, this.resolution) : clean(v, this.resolution);
    },

    /** Parallax: world-y shift (+ = down) of an object `gap` cm in front of this scale. See base docs. */
    apparentShift: function (gap, view) {
      return parallaxShift(gap, view && view.eyeAngle ? view.eyeAngle : 0);
    },

    /** Format a value to the instrument's resolution (e.g. 12.30 for 0.01). */
    format: function (value) { return fixed(value, this.decimals); },

    draw: function () {},
    describe: function () { return '<p>No tutorial available.</p>'; }
  };

  /**
   * Register an instrument type.
   * @param {string} type
   * @param {function(object, object, object)} factory  factory(inst, opts, rng) fills in `inst`
   * @param {{name?: string, order?: number}} [meta]
   */
  I.define = function (type, factory, meta) {
    if (typeof factory !== 'function') throw new Error('instruments.define(' + type + '): factory required');
    I.types[type] = { type: type, factory: factory, meta: meta || {} };
    return I.types[type];
  };

  /**
   * Create an instrument instance.
   * @param {string} type   e.g. 'metreRule'
   * @param {object} [opts] type-specific options; opts.zeroError (number) forces a zero error;
   *                        opts.zeroErrorChance overrides the chance of a random zero error
   * @param {object} [rng]  VL.rng Rng used ONLY to draw the hidden zero error (one call to VL.noise.zeroError)
   */
  I.create = function (type, opts, rng) {
    var def = I.types[type];
    if (!def) throw new Error('Unknown instrument type: ' + type);
    opts = opts || {};
    var inst = Object.create(proto);
    inst.type = type;
    inst.opts = opts;
    inst.overRange = 0;
    def.factory(inst, opts, rng);
    if (!inst.name) inst.name = (def.meta && def.meta.name) || type;
    if (!inst.range) inst.range = [0, Infinity];
    inst.decimals = decimalsOf(inst.resolution || 1);
    if (inst.tolerance === undefined) inst.tolerance = inst.digital ? inst.resolution : inst.resolution / 2;

    // Hidden zero error.
    if (typeof opts.zeroError === 'number') {
      inst.zeroError = clean(opts.zeroError, inst.resolution);
    } else if (inst.zeroErrorSpec) {
      var spec = Object.assign({}, inst.zeroErrorSpec);
      if (typeof opts.zeroErrorChance === 'number') spec.chance = opts.zeroErrorChance;
      inst.zeroError = zeroError(rng, spec);
    } else {
      inst.zeroError = 0;
    }

    // Flicker seed: derived from the rng's seed string so no rng state is consumed.
    var seedStr = (rng && rng.seed ? String(rng.seed) : 'no-seed') + '/' + type + '/flicker';
    inst.flickerSeed = VL.rng && typeof VL.rng.hash === 'function'
      ? (VL.rng.hash(seedStr)[0] >>> 0) : hashString(seedStr);
    if (inst.digital && inst.flickerSd === undefined) inst.flickerSd = 0.3 * inst.resolution;

    if (typeof inst.init === 'function') inst.init();
    return inst;
  };

  /** @returns {{type:string, name:string}[]} the registered instrument types, in registration order */
  I.list = function () {
    return Object.keys(I.types).map(function (t) {
      return { type: t, name: (I.types[t].meta && I.types[t].meta.name) || t };
    });
  };

  /** Convenience: parallax shift of an object `gap` cm in front of any scale for a view. */
  I.apparentShift = function (gap, view) {
    return parallaxShift(gap, view && view.eyeAngle ? view.eyeAngle : 0);
  };

  /** Helpers shared by the instrument files (not part of the student-facing API). */
  I.util = {
    noiseLevel: noiseLevel, decimalsOf: decimalsOf, roundTo: roundTo, clean: clean, quantize: quantize,
    truncate: truncate, clamp: clamp, fixed: fixed, zeroError: zeroError, parallaxShift: parallaxShift,
    hashString: hashString, unitAt: unitAt, normalAt: normalAt, flicker: flicker,
    lineW: lineW, text: text, visibleRect: visibleRect, roundRect: roundRect, hull: hull,
    drawEdgeFace: drawEdgeFace, toWorld: toWorld, sevenSeg: sevenSeg, FONT: FONT
  };
  I.proto = proto;
})(globalThis.VLab = globalThis.VLab || {});
