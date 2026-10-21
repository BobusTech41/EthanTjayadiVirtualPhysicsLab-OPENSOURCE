/**
 * Protractor (contract §3.7): 180°, 1° divisions, outer radius 7.5 cm, two scales running in opposite directions.
 *
 * place = { x, y, rotation = 0 }: (x, y) is the CENTRE point on the baseline; rotation in rad (as g.rotate, i.e.
 *         positive = clockwise on screen). With rotation 0 the baseline is horizontal and the arc is above it.
 *
 * Extra API:
 *   angleReading(place, rayAngle)  -> OUTER-scale reading in degrees of a ray from the centre whose world direction
 *                                     is rayAngle (rad, Math.atan2(dy, dx) in world coordinates, y down).
 *                                     The outer scale reads 0 at the right-hand end of the baseline and increases
 *                                     anticlockwise on screen. Result in (−180, 180].
 *   angleReadings(place, rayAngle) -> { outer, inner }   (inner = 180 − outer)
 *   rayAngleFor(place, outerDeg)   -> world direction (rad) of the ray that reads outerDeg on the outer scale
 *   contains(place, pt)            -> hit test of the protractor body
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;
  var R = 7.5;

  function norm180(deg) {
    var d = ((deg % 360) + 360) % 360;
    return d > 180 ? d - 360 : d;
  }

  I.define('protractor', function (inst) {
    inst.name = 'Protractor';
    inst.unit = '°';
    inst.resolution = 1;
    inst.range = [0, 180];
    inst.radius = R;
    inst.thickness = 0.2;
    inst.zeroErrorSpec = null;

    inst.angleReading = function (place, rayAngle) {
      var rot = (place && place.rotation) || 0;
      return U.clean(norm180((rot - rayAngle) * 180 / Math.PI) + (this.zeroError || 0), 1e-6);
    };
    inst.angleReadings = function (place, rayAngle) {
      var outer = this.angleReading(place, rayAngle);
      return { outer: outer, inner: U.clean(180 - outer, 1e-6) };
    };
    inst.rayAngleFor = function (place, outerDeg) {
      var rot = (place && place.rotation) || 0;
      return rot - (outerDeg - (this.zeroError || 0)) * Math.PI / 180;
    };
    inst.contains = function (place, pt) {
      place = place || {};
      var rot = place.rotation || 0, c = Math.cos(rot), s = Math.sin(rot);
      var dx = pt.x - (place.x || 0), dy = pt.y - (place.y || 0);
      var u = dx * c + dy * s, v = -dx * s + dy * c;
      if (v > 0.65 || u < -R - 0.2 || u > R + 0.2) return false;
      return v >= 0 || u * u + v * v <= (R + 0.15) * (R + 0.15);
    };
    inst.draw = drawProtractor;
    inst.describe = describeProtractor;
  }, { name: 'Protractor' });

  /** @this {object} protractor instance */
  function drawProtractor(g, place, view) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    g.save();
    g.translate(place.x || 0, place.y || 0);
    g.rotate(place.rotation || 0);

    // Body: semicircle plus the straight strip below the baseline.
    g.beginPath();
    g.moveTo(-R - 0.1, 0.6);
    g.lineTo(-R - 0.1, 0);
    g.arc(0, 0, R + 0.1, Math.PI, 2 * Math.PI);
    g.lineTo(R + 0.1, 0.6);
    g.closePath();
    g.fillStyle = 'rgba(225,238,250,0.72)';
    g.fill();
    g.strokeStyle = '#3e5873';
    g.lineWidth = U.lineW(view, 0.02);
    g.stroke();
    // Inner plain window.
    g.beginPath();
    g.arc(0, -0.4, R - 3.1, Math.PI, 2 * Math.PI);
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fill();
    g.lineWidth = U.lineW(view, 0.008);
    g.strokeStyle = 'rgba(62,88,115,0.6)';
    g.stroke();

    // Ticks.
    g.strokeStyle = '#111';
    g.lineWidth = U.lineW(view, 0.008);
    g.beginPath();
    for (var d = 0; d <= 180; d++) {
      var th = d * Math.PI / 180, c = Math.cos(th), s = -Math.sin(th);
      var len = d % 10 === 0 ? 0.65 : d % 5 === 0 ? 0.45 : 0.3;
      g.moveTo(c * (R - 0.02), s * (R - 0.02));
      g.lineTo(c * (R - len), s * (R - len));
      if (d % 10 === 0) {            // short inner ticks for the inner scale
        g.moveTo(c * (R - 1.85), s * (R - 1.85));
        g.lineTo(c * (R - 2.1), s * (R - 2.1));
      }
    }
    g.stroke();

    // Numbers: outer scale anticlockwise from the right, inner scale the other way.
    g.fillStyle = '#111';
    for (var n = 0; n <= 180; n += 10) {
      var t = n * Math.PI / 180, rot = Math.PI / 2 - t;
      U.text(g, String(n), Math.cos(t) * (R - 0.98), -Math.sin(t) * (R - 0.98), 0.3, { rotate: rot });
      U.text(g, String(180 - n), Math.cos(t) * (R - 1.55), -Math.sin(t) * (R - 1.55), 0.24, { rotate: rot, weight: '500' });
    }

    // Baseline and centre mark.
    g.lineWidth = U.lineW(view, 0.008);
    g.beginPath();
    g.moveTo(-R + 0.05, 0); g.lineTo(R - 0.05, 0);
    g.moveTo(0, -0.35); g.lineTo(0, 0.35);
    g.stroke();
    g.beginPath();
    g.arc(0, 0, 0.12, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  function describeProtractor() {
    return [
      '<h3>Protractor</h3>',
      '<p><strong>Resolution:</strong> 1°. Long marks every 10°, medium marks every 5°.</p>',
      '<h4>How to read it</h4>',
      '<ol><li>Put the centre mark exactly on the vertex (the point where the lines meet, or the pivot of a pendulum).</li>',
      '<li>Line up the baseline (the 0°–180° line) with one arm of the angle.</li>',
      '<li>Start from the 0 on that arm and read the <em>same</em> scale (inner or outer) round to the other arm.</li></ol>',
      '<p>Check your answer is sensible: an acute angle must be less than 90°. Reading the wrong scale gives 180° minus the angle.</p>',
      '<h4>Protractor fixed below a pivot (pendulum)</h4>',
      '<p>A protractor fixed upside down with its centre at the pivot cannot be lined up with the string, so its baseline is horizontal and the reference line is the vertical, which lies along the 90° mark. A string hanging at rest reads 90°. The angle of the string from the vertical is the difference between the reading and 90°: a reading of 82° or 98° means 8° from the vertical.</p>',
      '<h4>Zero error</h4>',
      '<p>There is no adjustable zero, but a misplaced centre or baseline acts like one. Check that the other arm of the baseline reads 0° before you read.</p>',
      '<h4>Parallax</h4>',
      '<p>Look straight down on the scale where the arm crosses it. A thread or string a little in front of the protractor appears against a different mark if your eye is to one side.</p>',
      '<h4>Good technique</h4>',
      '<ul><li>Extend short lines with a rule so they cross the scale.</li>',
      '<li>For a pendulum, use a fixed protractor behind the thread and release from the same small angle (10° or less) each time.</li></ul>',
      '<h4>Uncertainty to quote</h4>',
      '<p>±1°; ±2° is realistic when lines are thick or the vertex is hard to position.</p>'
    ].join('');
  }
})(globalThis.VLab = globalThis.VLab || {});
