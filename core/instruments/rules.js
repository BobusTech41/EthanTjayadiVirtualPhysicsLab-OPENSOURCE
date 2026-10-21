/**
 * Rules: metreRule, rule30 and setSquare (contract §3.7).
 *
 * place = { x, y, angle = 0, side = 1 }
 *   (x, y)  world position (cm) of the ZERO MARK on the reading edge
 *   angle   direction of increasing scale in rad (0 = to the right, -Math.PI/2 = vertical going up,
 *           Math.PI/2 = vertical going down)
 *   side    +1: the body lies on the side obtained by rotating the scale direction by +90° on screen
 *           (below a horizontal rule); -1: the other side
 *
 * Extra API (rules):
 *   readingAt(place, worldPt)                    -> scale reading (cm) of the projection of a world point
 *   apparentReadingAt(place, worldPt, gap, view) -> reading seen for a point `gap` cm in front of the scale
 *   pointAt(place, reading)                      -> world point on the reading edge at a scale reading
 *   contains(place, worldPt)                     -> true if the point lies on the rule's body (hit test)
 *   apparentShift(gap, view)                     -> world-y shift (cm, + = down) of an object in front of the scale
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;

  var RULES = {
    metreRule: { name: 'Metre rule', length: 100, width: 2.8, thickness: 0.6, zeroInset: 0.5, endInset: 0.5, material: 'wood' },
    rule30: { name: '30 cm rule', length: 30, width: 3.2, thickness: 0.22, zeroInset: 0.6, endInset: 0.8, material: 'plastic' }
  };

  /** Local (u along the scale, v across) -> world. */
  function localToWorld(place, u, v) {
    var a = place.angle || 0, c = Math.cos(a), s = Math.sin(a);
    return { x: (place.x || 0) + u * c - v * s, y: (place.y || 0) + u * s + v * c };
  }
  /** World -> local {u, v}. */
  function worldToLocal(place, pt) {
    var a = place.angle || 0, c = Math.cos(a), s = Math.sin(a);
    var dx = pt.x - (place.x || 0), dy = pt.y - (place.y || 0);
    return { u: dx * c + dy * s, v: -dx * s + dy * c };
  }

  function ruleFactory(type) {
    var cfg = RULES[type];
    return function (inst, opts) {
      inst.name = cfg.name;
      inst.unit = 'cm';
      inst.resolution = 0.1;
      inst.range = [0, cfg.length];
      inst.length = cfg.length;
      inst.width = opts.width || cfg.width;
      inst.thickness = opts.thickness || cfg.thickness;
      inst.zeroInset = typeof opts.zeroInset === 'number' ? opts.zeroInset : cfg.zeroInset;
      inst.endInset = typeof opts.endInset === 'number' ? opts.endInset : cfg.endInset;
      inst.material = opts.material || cfg.material;
      // Rules are read at two points (or from the zero mark), so by default there is no hidden zero error.
      inst.zeroErrorSpec = { resolution: 0.1, chance: 0, maxDivisions: 2 };

      /** Scale reading (cm) of the projection of a world point onto the scale. */
      inst.readingAt = function (place, pt) {
        return U.clean(worldToLocal(place || {}, pt).u + (this.zeroError || 0), 0.1);
      };
      /** Reading seen for a point `gap` cm in front of the scale, with the eye at view.eyeAngle. */
      inst.apparentReadingAt = function (place, pt, gap, view) {
        var dy = this.apparentShift(gap, view);
        return this.readingAt(place, { x: pt.x, y: pt.y + dy });
      };
      /** World point on the reading edge at a given scale reading (cm). */
      inst.pointAt = function (place, reading) {
        return localToWorld(place || {}, reading - (this.zeroError || 0), 0);
      };
      /** Hit test against the rule body. */
      inst.contains = function (place, pt, pad) {
        place = place || {};
        pad = pad || 0;
        var l = worldToLocal(place, pt), side = place.side === -1 ? -1 : 1;
        var v = l.v * side;
        return l.u >= -this.zeroInset - pad && l.u <= this.length + this.endInset + pad && v >= -pad && v <= this.width + pad;
      };
      inst.draw = drawRule;
      inst.describe = type === 'metreRule' ? describeMetre : describe30;
    };
  }

  /**
   * Draw a rule at true size.
   * @this {object} rule instance
   */
  function drawRule(g, place, view) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    var a = place.angle || 0, side = place.side === -1 ? -1 : 1;
    var u0 = -this.zeroInset, u1 = this.length + this.endInset, w = this.width;
    var wood = this.material === 'wood';

    // 1. Edge face (visible only when the eye is not level with the scale): parallax cue.
    var corners = [[u0, 0], [u1, 0], [u1, side * w], [u0, side * w]].map(function (p) {
      return localToWorld(place, p[0], p[1]);
    });
    U.drawEdgeFace(g, corners, this.thickness, view,
      wood ? '#a57a3f' : 'rgba(150,170,190,0.85)', wood ? '#6e4f24' : '#5c6b7a');

    g.save();
    g.translate(place.x || 0, place.y || 0);
    g.rotate(a);

    // 2. Body.
    var vTop = Math.min(0, side * w);
    if (wood) {
      var grad = g.createLinearGradient(0, 0, 0, side * w);
      grad.addColorStop(0, '#f2d9a8');
      grad.addColorStop(1, '#e2c085');
      g.fillStyle = grad;
    } else {
      g.fillStyle = 'rgba(236,244,252,0.82)';
    }
    g.fillRect(u0, vTop, u1 - u0, w);
    if (wood) {
      // Faint grain lines (deterministic).
      g.strokeStyle = 'rgba(140,95,40,0.18)';
      g.lineWidth = U.lineW(view, 0.02);
      g.beginPath();
      for (var gi = 0; gi < 6; gi++) {
        var gv = side * w * (0.15 + 0.13 * gi + 0.04 * U.unitAt(17, gi));
        g.moveTo(u0, gv);
        g.bezierCurveTo(u0 + (u1 - u0) * 0.3, gv + 0.05, u0 + (u1 - u0) * 0.7, gv - 0.05, u1, gv);
      }
      g.stroke();
    }
    g.strokeStyle = wood ? '#7a5a2a' : '#5c6b7a';
    g.lineWidth = U.lineW(view, 0.015);
    g.strokeRect(u0, vTop, u1 - u0, w);

    // 3. Ticks (only those on screen).
    var rect = U.visibleRect(g);
    var n = Math.round(this.length * 10);
    var k0 = 0, k1 = n;
    if (rect) {
      k0 = Math.max(0, Math.floor(rect.x0 * 10) - 1);
      k1 = Math.min(n, Math.ceil(rect.x1 * 10) + 1);
    }
    g.strokeStyle = '#111';
    g.lineWidth = U.lineW(view, 0.012);
    g.beginPath();
    for (var k = k0; k <= k1; k++) {
      var len = k % 10 === 0 ? 0.62 : k % 5 === 0 ? 0.45 : 0.28;
      g.moveTo(k / 10, 0);
      g.lineTo(k / 10, side * len);
    }
    g.stroke();

    // 4. Numbers every centimetre (font in cm: legible only when zoomed in).
    g.fillStyle = '#111';
    var fs = this.length > 50 ? 0.34 : 0.3;
    var vNum = side * 0.95;
    for (var c = Math.ceil(k0 / 10); c * 10 <= k1; c++) {
      U.text(g, String(c), c, vNum, fs, { baseline: 'middle' });
    }
    U.text(g, 'cm', -this.zeroInset * 0.5 + 0.0, side * (w - 0.45), 0.24, { weight: '500' });
    if (this.length > 50) U.text(g, 'METRE RULE', 50, side * (w - 0.6), 0.3, { weight: '500', colour: 'rgba(60,40,10,0.55)' });
    g.restore();
  }

  /* ------------------------------------------------------------------ */

  function describeMetre() {
    return [
      '<h3>Metre rule</h3>',
      '<p><strong>Resolution:</strong> 1 mm (0.1 cm). Every centimetre mark is numbered; the longer mark halfway between is 5 mm.</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Find the last numbered centimetre mark before the point, then count the millimetre marks after it.</li>',
      '<li>Record lengths to the nearest millimetre, e.g. <code>47.3 cm</code> or <code>0.473 m</code> — never <code>47 cm</code>, because the rule can resolve 0.1 cm.</li>',
      '<li>The zero mark may not be at the very end of the rule. Measure from the zero mark, or read <em>both</em> ends of the object and subtract.</li></ul>',
      '<h4>Zero error</h4>',
      '<p>A worn or chipped end makes readings taken from the end of the rule wrong. Avoid it by reading both ends of the length on the scale and subtracting: any offset cancels.</p>',
      '<h4>Parallax</h4>',
      '<p>The rule has a thickness, and the object (for example a pendulum string or bob) is often a little in front of the scale. If your eye is above or below the point being read, the object appears against the wrong mark. Keep your eye level with — and perpendicular to — the mark. For a rule lying horizontally, if you can see the rule\'s edge face, your eye is not level. For a vertical rule the edge face only shows at its ends: put your eye level with the mark you are reading, or use a set square to transfer the level to the scale.</p>',
      '<h4>Good technique</h4>',
      '<ul><li>Hold the rule vertical (check with a set square against the bench) or clamp it so it cannot move.</li>',
      '<li>Bring the scale as close as possible to the object, or use a set square to transfer the position of the object to the scale.</li>',
      '<li>Repeat and average if the end of the object is hard to judge.</li></ul>',
      '<h4>Uncertainty to quote</h4>',
      '<p>Typically ±1 mm (±0.1 cm) for a single length found from two readings. If the ends are hard to judge (a swinging bob, a curved surface) a larger value such as ±2 mm to ±5 mm is realistic — justify it.</p>'
    ].join('');
  }

  function describe30() {
    return [
      '<h3>30 cm rule</h3>',
      '<p><strong>Resolution:</strong> 1 mm (0.1 cm).</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Read the scale at both ends of the object and subtract — the zero mark is set in from the end of the rule.</li>',
      '<li>Record to the nearest millimetre: <code>8.4 cm</code>, not <code>8 cm</code> or <code>8.40 cm</code>.</li></ul>',
      '<h4>Zero error</h4>',
      '<p>Never measure from the physical end of the rule; it may be worn. Reading two points on the scale removes any zero error.</p>',
      '<h4>Parallax</h4>',
      '<p>Place the rule on its edge so the graduations touch the object, and look straight down on each mark. A thick rule lying flat puts the scale a few millimetres from the object, which causes parallax.</p>',
      '<h4>Uncertainty to quote</h4>',
      '<p>±1 mm (±0.1 cm) for a length found from two readings, larger if the ends are not sharp.</p>'
    ].join('');
  }

  I.define('metreRule', ruleFactory('metreRule'), { name: 'Metre rule' });
  I.define('rule30', ruleFactory('rule30'), { name: '30 cm rule' });

  /* ------------------------------------------------------------------ */
  /* Set square (draw only — an alignment aid)                           */
  /* ------------------------------------------------------------------ */

  /**
   * place = { x, y, angle = 0 }: (x, y) is the right-angle corner; one leg runs along +angle (the base) and the
   * other at angle − 90° (upwards on screen for angle 0).
   * opts.kind '45' (default, legs 15 cm) or '60' (30°/60°, base 15 cm, height 26 cm).
   */
  I.define('setSquare', function (inst, opts) {
    var k60 = opts.kind === '60';
    inst.name = 'Set square';
    inst.unit = 'cm';
    inst.resolution = 0.1;
    inst.base = opts.base || 15;
    inst.height = k60 ? inst.base * Math.tan(Math.PI / 3) : inst.base;
    inst.range = [0, inst.base];
    inst.thickness = 0.3;
    inst.zeroErrorSpec = null;

    /** World corners [rightAngle, baseEnd, topEnd]. */
    inst.corners = function (place) {
      place = place || {};
      return [localToWorld(place, 0, 0), localToWorld(place, this.base, 0), localToWorld(place, 0, -this.height)];
    };
    /** Hit test: inside the triangle (with optional padding in cm). */
    inst.contains = function (place, pt, pad) {
      var l = worldToLocal(place || {}, pt);
      pad = pad || 0;
      var u = l.u, v = -l.v;
      return u >= -pad && v >= -pad && (u / this.base + v / this.height) <= 1 + pad / Math.min(this.base, this.height);
    };
    inst.draw = function (g, place, view) {
      place = place || {};
      view = view || { scale: 10, eyeAngle: 0 };
      var b = this.base, h = this.height;
      U.drawEdgeFace(g, this.corners(place), this.thickness, view, 'rgba(120,150,180,0.6)', '#4c6278');
      g.save();
      g.translate(place.x || 0, place.y || 0);
      g.rotate(place.angle || 0);
      g.beginPath();
      g.moveTo(0, 0); g.lineTo(b, 0); g.lineTo(0, -h); g.closePath();
      // Inner cut-out (drawn as a hole with the even-odd rule).
      var m = 2.6, ib = b - m * (1 + b / h + Math.sqrt(1 + (b * b) / (h * h))), ih = ib * h / b;
      if (ib > 1) {
        g.moveTo(m, -m); g.lineTo(m, -m - ih); g.lineTo(m + ib, -m); g.closePath();
      }
      g.fillStyle = 'rgba(205,230,250,0.55)';
      g.fill('evenodd');
      g.strokeStyle = '#3e5873';
      g.lineWidth = U.lineW(view, 0.02);
      g.stroke();
      U.text(g, 'SET SQUARE', b * 0.18, -h * 0.12, 0.3, { colour: 'rgba(30,50,70,0.6)', align: 'left', weight: '500' });
      g.restore();
    };
    inst.describe = function () {
      return [
        '<h3>Set square</h3>',
        '<p>A set square is not used to take readings itself: it helps you line things up.</p>',
        '<ul><li><strong>Checking a rule is vertical:</strong> stand the set square on the bench with one edge against the rule.</li>',
        '<li><strong>Transferring a level to a scale:</strong> slide the set square along the rule until its horizontal edge just touches the top of the object (for example a pendulum bob), then read the rule where that edge meets it. The edge touches the scale, so there is no gap and no parallax.</li>',
        '<li><strong>Drawing normals</strong> in optics experiments: line up one edge with the surface and draw along the other.</li></ul>',
        '<p>Mentioning “use a set square to transfer the position to the rule” is a credited improvement when lengths are hard to judge.</p>'
      ].join('');
    };
  }, { name: 'Set square' });

  I.rulesGeometry = { localToWorld: localToWorld, worldToLocal: worldToLocal };
})(globalThis.VLab = globalThis.VLab || {});
