/**
 * Micrometer screw gauge (contract §3.7). Display unit: mm. Range 0–25 mm.
 *
 * Sleeve: millimetre marks ABOVE the datum line (numbered every 5 mm), half-millimetre marks BELOW it.
 * Thimble: 50 divisions (0.01 mm each, numbered every 5); one turn = 0.50 mm.
 *
 * place = { x, y }: world position (cm) of the centre of the ANVIL FACE; the spindle and thimble extend to the right.
 * state = { gap }:  true gap between anvil and spindle in mm.
 *
 * Extra API:
 *   readingFor(gap)          -> gap + zeroError (mm, exact)
 *   scaleReading(gap)        -> readingFor(gap) rounded to 0.01 mm
 *   decompose(gap)           -> decomposeReading(readingFor(gap))   (gap is PHYSICAL: the zero error is included)
 *   decomposeReading(r)      -> { reading, sleeve (mm, last visible sleeve mark (multiple of 0.5)),
 *                                 thimble (divisions at the datum, 0 ≤ t < 50, fractional),
 *                                 thimbleDivision (nearest whole division, 0–49), value (sleeve + 0.01·division) }
 *   anvilX(place), spindleX(place, state), thimbleEdgeX(place, state)  world x coordinates
 *   thimbleContains(place, state, pt)  hit test for dragging/turning the thimble
 *   apparentThimble(gap, view)         thimble reading seen with the eye at view.eyeAngle (parallax)
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;

  var R_SPINDLE = 0.32, R_SLEEVE = 0.48, R_THIMBLE = 0.8;
  var SLEEVE_START = 3.7, SLEEVE_ZERO = 4.0, SLEEVE_END = 6.85, THIMBLE_LEN = 2.6;
  /** Depth of the thimble graduations in front of the sleeve datum line (cm). */
  var THIMBLE_GAP = R_THIMBLE - R_SLEEVE;
  var DIV_CM = 2 * Math.PI * R_THIMBLE / 50;   // arc length of one thimble division at the front (cm)

  I.define('micrometer', function (inst) {
    inst.name = 'Micrometer screw gauge';
    inst.unit = 'mm';
    inst.resolution = 0.01;
    inst.range = [0, 25];
    inst.pitch = 0.5;
    inst.thimbleDivisions = 50;
    inst.thimbleRadius = R_THIMBLE;
    inst.zeroErrorSpec = { resolution: 0.01, chance: 0.4, maxDivisions: 3 };

    inst.readingFor = function (gap) { return U.clean(gap + this.zeroError, 0.01); };
    inst.scaleReading = function (gap) { return U.quantize(this.readingFor(gap), 0.01); };
    inst.decomposeReading = function (r) {
      var sleeve = U.roundTo(Math.floor(r / 0.5 + 1e-9) * 0.5, 0.5);
      var thimble = U.clean((r - sleeve) / 0.01, 0.01);
      var div = Math.round(thimble);
      return { reading: U.clean(r, 0.01), sleeve: sleeve, thimble: thimble, thimbleDivision: div % 50,
        value: U.roundTo(sleeve + div * 0.01, 0.01) };
    };
    inst.decompose = function (gap) { return this.decomposeReading(this.readingFor(gap)); };
    inst.anvilX = function (place) { return place.x || 0; };
    inst.spindleX = function (place, state) { return (place.x || 0) + gapOf(state) / 10; };
    inst.thimbleEdgeX = function (place, state) {
      return (place.x || 0) + SLEEVE_ZERO + this.readingFor(gapOf(state)) / 10;
    };
    inst.thimbleContains = function (place, state, pt) {
      var x0 = this.thimbleEdgeX(place, state);
      var dy = pt.y - (place.y || 0);
      return pt.x >= x0 - 0.1 && pt.x <= x0 + THIMBLE_LEN + 1.1 && Math.abs(dy) <= R_THIMBLE + 0.15;
    };
    inst.apparentThimble = function (gap, view) {
      var shift = this.apparentShift(THIMBLE_GAP, view);     // + = graduations appear lower
      return U.clean(this.readingFor(gap) + (shift / DIV_CM) * 0.01, 0.0001);
    };
    inst.draw = drawMicrometer;
    inst.describe = describeMicrometer;
  }, { name: 'Micrometer screw gauge' });

  function gapOf(state) {
    return state && typeof state.gap === 'number' ? U.clamp(state.gap, 0, 25) : 0;
  }

  function metal(g, y0, y1) {
    var grad = g.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, '#f4f6f8');
    grad.addColorStop(0.35, '#d5dbe1');
    grad.addColorStop(1, '#8d97a1');
    return grad;
  }

  /** @this {object} micrometer instance */
  function drawMicrometer(g, place, view, state) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    var gap = gapOf(state);
    var r = this.readingFor(gap);
    var uT = SLEEVE_ZERO + r / 10;                 // thimble edge
    var lw = U.lineW(view, 0.008);
    var edge = '#4b555f';

    g.save();
    g.translate(place.x || 0, place.y || 0);
    g.lineWidth = lw;
    g.strokeStyle = edge;

    // Frame (enamelled C-frame below the measuring axis).
    g.beginPath();
    g.moveTo(-1.6, -0.75); g.lineTo(-0.6, -0.75); g.lineTo(-0.6, 0.55);
    g.quadraticCurveTo(1.3, 2.7, 3.0, 0.55);
    g.lineTo(3.0, -0.8); g.lineTo(SLEEVE_START, -0.8); g.lineTo(SLEEVE_START, 0.95);
    g.quadraticCurveTo(1.3, 4.3, -1.6, 0.95);
    g.closePath();
    var fg = g.createLinearGradient(0, -0.8, 0, 3.5);
    fg.addColorStop(0, '#5a6b7c'); fg.addColorStop(1, '#2f3b47');
    g.fillStyle = fg;
    g.fill(); g.stroke();
    // Label plate on the frame.
    g.fillStyle = '#c9d1d9';
    U.roundRect(g, 0.3, 1.95, 2.0, 0.55, 0.12);
    g.fill();
    U.text(g, '0–25 mm  0.01 mm', 1.3, 2.23, 0.16, { colour: '#1d2329', weight: '600' });

    // Anvil.
    g.fillStyle = metal(g, -R_SPINDLE, R_SPINDLE);
    g.fillRect(-0.6, -R_SPINDLE, 0.6, 2 * R_SPINDLE);
    g.strokeRect(-0.6, -R_SPINDLE, 0.6, 2 * R_SPINDLE);
    // Spindle.
    g.fillRect(gap / 10, -R_SPINDLE, SLEEVE_START - gap / 10, 2 * R_SPINDLE);
    g.strokeRect(gap / 10, -R_SPINDLE, SLEEVE_START - gap / 10, 2 * R_SPINDLE);
    // Lock lever.
    g.fillStyle = '#9aa3ac';
    g.fillRect(3.05, -1.25, 0.3, 0.5);
    g.strokeRect(3.05, -1.25, 0.3, 0.5);

    // Sleeve with datum line and scales.
    g.fillStyle = metal(g, -R_SLEEVE, R_SLEEVE);
    g.fillRect(SLEEVE_START, -R_SLEEVE, SLEEVE_END - SLEEVE_START, 2 * R_SLEEVE);
    g.strokeRect(SLEEVE_START, -R_SLEEVE, SLEEVE_END - SLEEVE_START, 2 * R_SLEEVE);
    g.strokeStyle = '#111';
    g.lineWidth = U.lineW(view, 0.006);
    g.beginPath();
    g.moveTo(SLEEVE_START + 0.1, 0); g.lineTo(SLEEVE_END, 0);
    for (var m = 0; m <= 25; m++) {
      var u = SLEEVE_ZERO + m / 10;
      g.moveTo(u, 0); g.lineTo(u, m % 5 === 0 ? -0.26 : -0.19);
      if (m < 25) { g.moveTo(u + 0.05, 0); g.lineTo(u + 0.05, 0.17); }
    }
    g.stroke();
    g.fillStyle = '#111';
    for (var m5 = 0; m5 <= 25; m5 += 5) U.text(g, String(m5), SLEEVE_ZERO + m5 / 10, -0.36, 0.13);

    // Thimble (covers the sleeve marks beyond its edge).
    var tg = g.createLinearGradient(0, -R_THIMBLE, 0, R_THIMBLE);
    tg.addColorStop(0, '#9da7b1'); tg.addColorStop(0.3, '#eef1f4'); tg.addColorStop(0.55, '#d3d9df'); tg.addColorStop(1, '#7c8791');
    g.fillStyle = tg;
    g.strokeStyle = edge;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(uT, -R_THIMBLE * 0.8); g.lineTo(uT + 0.25, -R_THIMBLE); g.lineTo(uT + THIMBLE_LEN, -R_THIMBLE);
    g.lineTo(uT + THIMBLE_LEN, R_THIMBLE); g.lineTo(uT + 0.25, R_THIMBLE); g.lineTo(uT, R_THIMBLE * 0.8);
    g.closePath();
    g.fill(); g.stroke();
    // Knurled grip.
    g.beginPath();
    for (var kq = 0; kq < 22; kq++) { var ku = uT + 1.35 + kq * 0.055; g.moveTo(ku, -R_THIMBLE + 0.05); g.lineTo(ku, R_THIMBLE - 0.05); }
    g.strokeStyle = 'rgba(40,50,60,0.45)';
    g.stroke();
    // Ratchet.
    g.fillStyle = metal(g, -0.42, 0.42);
    g.strokeStyle = edge;
    g.fillRect(uT + THIMBLE_LEN, -0.42, 1.0, 0.84);
    g.strokeRect(uT + THIMBLE_LEN, -0.42, 1.0, 0.84);
    g.beginPath();
    for (var rq = 0; rq < 12; rq++) { var ru = uT + THIMBLE_LEN + 0.2 + rq * 0.055; g.moveTo(ru, -0.38); g.lineTo(ru, 0.38); }
    g.strokeStyle = 'rgba(40,50,60,0.45)';
    g.stroke();

    // Thimble graduations (rotating with the reading; numbers increase upwards).
    var d = this.decomposeReading(r);
    var t = d.thimble;
    var shift = this.apparentShift(THIMBLE_GAP, view);   // parallax of the graduations relative to the datum
    g.strokeStyle = '#111';
    g.lineWidth = U.lineW(view, 0.006);
    g.beginPath();
    var labels = [];
    for (var j = 0; j < 50; j++) {
      var delta = j - t;
      delta = ((delta % 50) + 75) % 50 - 25;           // shortest way round: (−25, 25]
      var phi = delta * 2 * Math.PI / 50;
      if (Math.abs(phi) > Math.PI / 2 * 0.97) continue;
      var vj = -R_THIMBLE * Math.sin(phi) + shift;
      if (Math.abs(vj) > R_THIMBLE - 0.02) continue;
      var len = j % 5 === 0 ? 0.42 : 0.26;
      // Start on the bevel outline (it narrows to 0.8·R at the edge).
      var start = Math.max(0.02, 0.25 * (Math.abs(vj) - R_THIMBLE * 0.8) / (R_THIMBLE * 0.2) + 0.02);
      g.moveTo(uT + start, vj); g.lineTo(uT + Math.max(len, start + 0.05), vj);
      if (j % 5 === 0) labels.push({ j: j, v: vj, c: Math.cos(phi) });
    }
    g.stroke();
    g.fillStyle = '#111';
    labels.forEach(function (L) {
      if (L.c < 0.25) return;
      U.text(g, String(L.j), uT + 0.62, L.v, 0.15, { scaleY: L.c, align: 'center' });
    });
    g.restore();
  }

  function describeMicrometer() {
    return [
      '<h3>Micrometer screw gauge</h3>',
      '<p><strong>Resolution:</strong> 0.01 mm. One full turn of the thimble moves the spindle 0.50 mm; the thimble has 50 divisions, so each is 0.01 mm.</p>',
      '<h4>How to read it</h4>',
      '<ol><li><strong>Sleeve:</strong> read the last mark uncovered by the thimble. Marks above the datum line are whole millimetres; a mark below the line adds 0.5 mm.</li>',
      '<li><strong>Thimble:</strong> read the division in line with the datum line (numbers every 5 divisions) and multiply by 0.01 mm.</li>',
      '<li>Add them: e.g. sleeve 6.5 mm + thimble 23 × 0.01 mm = 6.73 mm.</li></ol>',
      '<p>Take care near a half-millimetre mark: if the thimble reads a high number (45–49), the next sleeve mark may seem to be showing although the thimble zero has not yet reached the datum line. The sleeve reading is the last mark that the thimble edge has completely passed.</p>',
      '<p>Record to two decimal places in mm, e.g. <code>0.38 mm</code> for a wire (or <code>0.038 cm</code>).</p>',
      '<h4>Zero error</h4>',
      '<p>Clean the faces, then close the micrometer using the <em>ratchet</em> and read it. If the thimble zero has gone <em>past</em> the datum line (it is below the line and the datum reads, say, 3) the zero error is positive, +0.03 mm; if the zero has not reached the datum line (it is above the line and the datum reads, say, 47) the zero error is negative, −0.03 mm. <strong>Corrected reading = reading − zero error.</strong></p>',
      '<h4>Parallax</h4>',
      '<p>The thimble graduations stand above the datum line on the sleeve. Look along the datum line at right angles to the axis; with your eye above or below, a different thimble division seems to line up.</p>',
      '<h4>Good technique</h4>',
      '<ul><li>Always turn the ratchet, not the thimble, for the final approach: it slips at the correct pressure so you do not squash the wire.</li>',
      '<li>Measure a wire\'s diameter at several points along it and in two perpendicular directions, then average.</li></ul>',
      '<h4>Uncertainty to quote</h4>',
      '<p>±0.01 mm (one thimble division), or half the range of repeated readings if larger. For a thin wire this can be a large percentage uncertainty — show it.</p>'
    ].join('');
  }
})(globalThis.VLab = globalThis.VLab || {});
