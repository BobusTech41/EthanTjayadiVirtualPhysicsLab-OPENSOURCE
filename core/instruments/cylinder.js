/**
 * Measuring cylinder (contract §3.7). Display unit: cm³.
 *
 * opts.capacity 100 (default; 1 cm³ divisions) or 250 (2 cm³ divisions).
 * The scale is printed on the FRONT of the glass; the bottom of the meniscus is on the axis, a distance
 * (inner radius + wall) BEHIND the scale, so an eye above the level reads too high and an eye below too low.
 *
 * place = { x, y }: world position (cm) of the bottom centre of the foot (where it stands on the bench).
 * state = { volume (true cm³ of liquid), colour? (CSS colour of the liquid) }
 *
 * Extra API:
 *   readingFor(volume)          -> volume + zeroError (cm³; zeroError is 0 unless forced)
 *   apparentReading(volume, view) -> what an eye at view.eyeAngle reads at the bottom of the meniscus
 *   levelY(place, volume)       -> world y of the bottom of the meniscus for a volume
 *   volumeAtY(place, y)         -> volume whose level is at world y
 *   innerRadius, area (cm²), meniscusGap (cm behind the scale), meniscusRise (cm)
 *   topY(place)                 -> world y of the rim
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;
  var WALL = 0.15, BASE_H = 1.2, MENISCUS_RISE = 0.13;

  I.define('cylinder', function (inst, opts) {
    var big = opts.capacity === 250;
    inst.name = 'Measuring cylinder';
    inst.unit = 'cm³';
    inst.capacity = big ? 250 : 100;
    inst.resolution = big ? 2 : 1;
    inst.range = [0, inst.capacity];
    inst.innerRadius = big ? 1.9 : 1.4;
    inst.area = Math.PI * inst.innerRadius * inst.innerRadius;
    inst.meniscusGap = inst.innerRadius + WALL;
    inst.meniscusRise = MENISCUS_RISE;
    inst.firstMark = big ? 20 : 10;
    inst.zeroErrorSpec = null;

    inst.readingFor = function (volume) { return U.clean(volume + this.zeroError, this.resolution); };
    inst.levelY = function (place, volume) { return (place.y || 0) - BASE_H - volume / this.area; };
    inst.volumeAtY = function (place, y) { return ((place.y || 0) - BASE_H - y) * this.area; };
    inst.topY = function (place) { return this.levelY(place, this.capacity) - 2.4; };
    inst.apparentReading = function (volume, view) {
      // The meniscus is meniscusGap BEHIND the scale: shift = parallaxShift(−gap) (negative = appears higher).
      var dy = this.apparentShift(-this.meniscusGap, view);
      return U.clean(this.readingFor(volume) - dy * this.area, 1e-4);
    };
    inst.draw = drawCylinder;
    inst.describe = describeCylinder;
  }, { name: 'Measuring cylinder' });

  /** @this {object} cylinder instance */
  function drawCylinder(g, place, view, state) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    state = state || {};
    var r = this.innerRadius, ro = r + WALL;
    var vol = U.clamp(state.volume || 0, 0, this.capacity * 1.08);
    var x0 = place.x || 0, y0 = place.y || 0;
    var yBottom = y0 - BASE_H;
    var yTop = this.topY(place);
    var lw = U.lineW(view, 0.015);
    var eye = view.eyeAngle || 0;

    g.save();
    g.translate(x0, 0);

    // Foot.
    g.beginPath();
    g.moveTo(-ro - 1.6, y0); g.lineTo(ro + 1.6, y0); g.lineTo(ro + 1.2, y0 - 0.5); g.lineTo(-ro - 1.2, y0 - 0.5); g.closePath();
    g.fillStyle = 'rgba(190,215,235,0.7)'; g.fill();
    g.strokeStyle = '#5d7790'; g.lineWidth = lw; g.stroke();

    // Glass body (back wall tint).
    g.fillStyle = 'rgba(215,232,245,0.45)';
    g.fillRect(-ro, yTop, 2 * ro, y0 - 0.5 - yTop);
    // Thick glass base.
    g.fillStyle = 'rgba(175,205,228,0.65)';
    g.fillRect(-ro, yBottom, 2 * ro, BASE_H - 0.5);

    // Liquid with meniscus (bottom of meniscus at yLevel on the axis; it appears shifted by parallax).
    if (vol > 0) {
      var yLevel = this.levelY(place, vol);
      var shiftAxis = this.apparentShift(-this.meniscusGap, view);   // axis of the cylinder
      var yApp = yLevel + shiftAxis;
      var colour = state.colour || 'rgba(70,140,220,0.38)';
      g.beginPath();
      g.moveTo(-r, yBottom);
      g.lineTo(-r, yApp - MENISCUS_RISE);
      for (var i = 0; i <= 40; i++) {
        var xx = -r + 2 * r * i / 40;
        g.lineTo(xx, yApp - MENISCUS_RISE * Math.exp(-(r - Math.abs(xx)) / 0.09));
      }
      g.lineTo(r, yBottom);
      g.closePath();
      g.fillStyle = colour;
      g.fill();
      // Surface seen obliquely when the eye is not level: an ellipse (top surface from above, silvery from below).
      if (Math.abs(eye) > 0.3) {
        var ry = r * Math.abs(Math.sin(eye * Math.PI / 180));
        g.beginPath();
        g.ellipse(0, yApp, r, Math.max(ry, 0.005), 0, 0, Math.PI * 2);
        g.fillStyle = eye > 0 ? 'rgba(120,180,240,0.35)' : 'rgba(235,240,245,0.75)';
        g.fill();
        g.strokeStyle = 'rgba(20,50,90,0.35)';
        g.lineWidth = U.lineW(view, 0.008);
        g.stroke();
      }
      // The dark meniscus band: its lower edge is the reading line.
      g.beginPath();
      for (var j = 0; j <= 40; j++) {
        var xm = -r + 2 * r * j / 40;
        var ym = yApp - MENISCUS_RISE * Math.exp(-(r - Math.abs(xm)) / 0.09);
        if (j) g.lineTo(xm, ym); else g.moveTo(xm, ym);
      }
      g.strokeStyle = 'rgba(15,40,80,0.85)';
      g.lineWidth = U.lineW(view, 0.03);
      g.stroke();
    }

    // Walls.
    g.strokeStyle = '#5d7790';
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(-ro, y0 - 0.5); g.lineTo(-ro, yTop); g.lineTo(-ro - 0.35, yTop - 0.3);   // spout on the left
    g.moveTo(ro, y0 - 0.5); g.lineTo(ro, yTop);
    g.moveTo(-r, yBottom); g.lineTo(-r, yTop); g.moveTo(r, yBottom); g.lineTo(r, yTop);
    g.moveTo(-r, yBottom); g.lineTo(r, yBottom);
    g.stroke();
    // Highlight on the glass.
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(r * 0.55, yTop + 0.5, 0.18, yBottom - yTop - 1);

    // Scale on the front surface.
    var res = this.resolution, cap = this.capacity;
    var big = cap === 250;
    var xL = -ro * 0.62;
    g.strokeStyle = '#111';
    g.lineWidth = U.lineW(view, 0.012);
    g.beginPath();
    var nums = [];
    for (var v = this.firstMark; v <= cap + 1e-9; v += res) {
      var yv = this.levelY(place, v);
      var idx = Math.round(v / res);
      var major = big ? idx % 10 === 0 || v === cap : idx % 10 === 0;
      var mid = idx % 5 === 0;
      var len = major ? ro * 1.05 : mid ? ro * 0.75 : ro * 0.48;
      g.moveTo(xL, yv); g.lineTo(xL + len, yv);
      if (major) nums.push({ v: Math.round(v), y: yv });
    }
    g.stroke();
    g.fillStyle = '#111';
    nums.forEach(function (n) { U.text(g, String(n.v), xL + ro * 1.15, n.y - 0.02, 0.3, { align: 'left' }); });
    U.text(g, 'cm³', 0, yTop + 0.9, 0.32, { weight: '600' });
    U.text(g, cap + ' cm³  20 °C', 0, yTop + 1.4, 0.2, { weight: '500', colour: '#333' });
    g.restore();
  }

  function describeCylinder() {
    var r = this.resolution;
    return [
      '<h3>Measuring cylinder</h3>',
      '<p><strong>Resolution:</strong> ' + r + ' cm³ per division (' + this.capacity + ' cm³ cylinder). Count the divisions between two numbered marks to find the value of one division before you read.</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Stand the cylinder on a level bench.</li>',
      '<li>Water forms a curved surface (meniscus). Read the <strong>bottom of the meniscus</strong>, not the line where the liquid touches the glass.</li>',
      '<li>Record to the resolution, e.g. <code>' + (r === 1 ? '64 cm³' : '138 cm³') + '</code>; you may estimate to half a division if the marks are far apart.</li></ul>',
      '<h4>Parallax</h4>',
      '<p>The scale is on the front of the glass but the bottom of the meniscus is in the middle of the liquid, ' + (this.meniscusGap).toFixed(1) + ' cm behind it. Crouch until your eye is level with the meniscus: from above the reading is too high, from below too low. If you can see the liquid surface as an ellipse, your eye is not level.</p>',
      '<h4>Zero error</h4>',
      '<p>A measuring cylinder has no zero to check, but its first marks start above the base. To find the volume of a solid, use the <em>difference</em> of two readings (displacement), which removes any offset.</p>',
      '<h4>Uncertainty to quote</h4>',
      '<p>±' + r + ' cm³ (one division), or ±' + (r / 2) + ' cm³ if you read to half a division. For a volume found from two readings, add the uncertainties.</p>'
    ].join('');
  }
})(globalThis.VLab = globalThis.VLab || {});
