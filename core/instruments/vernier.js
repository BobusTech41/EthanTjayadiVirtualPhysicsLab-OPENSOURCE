/**
 * Vernier callipers (contract §3.7). Display unit: mm.
 *
 * opts.resolution: 0.1 (default; vernier of 10 divisions spanning 9 mm) or 0.02 (50 divisions spanning 49 mm).
 * place = { x, y }: world position (cm) of the MAIN-SCALE ZERO MARK on the edge where the main scale meets the
 *                   vernier scale. The callipers are drawn horizontally, fixed jaw on the left, jaws pointing down.
 * state = { opening }: true separation of the outside jaws in mm.
 *
 * Extra API:
 *   readingFor(opening)            -> opening + zeroError (mm, exact, what the scales indicate)
 *   scaleReading(opening)          -> readingFor(opening) rounded to the resolution (the reading a careful student takes)
 *   decompose(opening)             -> { reading, main, division } (main-scale mm before the vernier zero, aligned division)
 *   alignedDivision(reading)       -> vernier division that lines up with a main-scale mark
 *   vernierZeroX(place, state)     -> world x of the vernier zero mark
 *   jawFaces(place, state)         -> { fixed, moving, top, bottom } world coordinates of the outside-jaw faces
 *   sliderContains(place, state, pt) -> hit test of the sliding jaw / vernier plate (for dragging)
 *   openingForX(place, worldX)     -> opening (mm) that puts the moving jaw face at worldX
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;

  var JAW_TOP = 0.55, JAW_FACE_BOTTOM = 4.2;

  I.define('vernier', function (inst, opts) {
    var fine = opts.resolution === 0.02;
    inst.name = 'Vernier callipers';
    inst.unit = 'mm';
    inst.resolution = fine ? 0.02 : 0.1;
    inst.divisions = fine ? 50 : 10;
    /** Length of the whole vernier scale in mm (9 or 49). */
    inst.vernierLength = inst.divisions - 1;
    /** Spacing of vernier divisions in mm (0.9 or 0.98). */
    inst.vernierSpacing = (inst.divisions - 1) / inst.divisions;
    inst.range = [0, 150];
    inst.thickness = 0.35;
    inst.zeroErrorSpec = { resolution: inst.resolution, chance: 0.3, maxDivisions: 3 };

    inst.readingFor = function (opening) {
      return U.clean(opening + this.zeroError, this.resolution);
    };
    inst.scaleReading = function (opening) {
      return U.quantize(this.readingFor(opening), this.resolution);
    };
    inst.alignedDivision = function (reading) {
      var q = U.quantize(reading, this.resolution);
      var main = Math.floor(q + 1e-9);
      var d = Math.round((q - main) / this.resolution);
      return d >= this.divisions ? d - this.divisions : d;
    };
    inst.decompose = function (opening) {
      var r = this.scaleReading(opening);
      var main = Math.floor(r + 1e-9);
      var d = Math.round((r - main) / this.resolution);
      if (d >= this.divisions) { main += 1; d -= this.divisions; }
      return { reading: r, main: main, division: d };
    };
    inst.vernierZeroX = function (place, state) {
      return (place.x || 0) + this.readingFor(openingOf(state)) / 10;
    };
    inst.jawFaces = function (place, state) {
      var x = place.x || 0, y = place.y || 0;
      return { fixed: x, moving: x + openingOf(state) / 10, top: y + JAW_TOP, bottom: y + JAW_FACE_BOTTOM };
    };
    inst.openingForX = function (place, worldX) {
      return U.clamp((worldX - (place.x || 0)) * 10, 0, this.range[1]);
    };
    inst.sliderContains = function (place, state, pt) {
      var s = openingOf(state) / 10, V = this.vernierLength / 10;
      var u = pt.x - (place.x || 0), v = pt.y - (place.y || 0);
      var inPlate = u >= s - 0.5 && u <= s + V + 1.6 && v >= -1.3 && v <= 1.15;
      var inJaw = u >= s && u <= s + 2.0 && v >= 1.0 && v <= 4.8;
      var inUpper = u >= s && u <= s + 1.0 && v >= -2.5 && v <= -1.2;
      return inPlate || inJaw || inUpper;
    };
    inst.draw = drawVernier;
    inst.describe = describeVernier;
  }, { name: 'Vernier callipers' });

  function openingOf(state) {
    return state && typeof state.opening === 'number' ? state.opening : 0;
  }

  function poly(g, pts) {
    g.beginPath();
    pts.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); });
    g.closePath();
  }

  function steel(g, y0, y1, light) {
    var grad = g.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, light ? '#eef1f4' : '#dfe4e9');
    grad.addColorStop(0.5, light ? '#d3d9df' : '#c3cad1');
    grad.addColorStop(1, light ? '#b9c1c9' : '#a5aeb7');
    return grad;
  }

  /** @this {object} vernier instance */
  function drawVernier(g, place, view, state) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    var s = openingOf(state) / 10;                      // jaw separation in cm
    var z = this.readingFor(openingOf(state)) / 10;     // vernier zero position in cm
    var V = this.vernierLength / 10;
    var uEnd = Math.max(18.5, 15 + V + 2.4);
    var lw = U.lineW(view, 0.01);
    var edge = '#59636d';
    // Graduations: 0.004 cm wide on the 0.02 mm vernier, so that at the fine zoom it needs (about 800 px per cm,
    // where 0.02 mm is 1.6 px) the lines are about 3 px wide and a 1.6 px step between them can be seen.
    var gradMain = this.resolution === 0.02 ? 0.004 : 0.006;
    var gradVernier = this.resolution === 0.02 ? 0.004 : 0.005;

    // Parallax cue: the slider stands proud of the beam by its thickness.
    var px = place.x || 0, py = place.y || 0;
    U.drawEdgeFace(g, [
      { x: px + s - 0.5, y: py - 1.25 }, { x: px + s + V + 1.4, y: py - 1.25 },
      { x: px + s + V + 1.4, y: py + 1.05 }, { x: px + s - 0.5, y: py + 1.05 }
    ], this.thickness, view, '#8b949d', edge);

    g.save();
    g.translate(px, py);

    // Fixed jaws.
    g.lineWidth = lw;
    g.strokeStyle = edge;
    g.fillStyle = steel(g, 0, 4.7, false);
    poly(g, [[-2.0, JAW_TOP], [0, JAW_TOP], [0, JAW_FACE_BOTTOM], [-0.3, 4.7], [-1.1, 3.3], [-2.0, 1.6]]);
    g.fill(); g.stroke();
    g.fillStyle = steel(g, -2.5, -1, false);
    poly(g, [[-0.9, -1.05], [0, -1.05], [0, -2.3], [-0.15, -2.45], [-0.9, -1.5]]);
    g.fill(); g.stroke();

    // Beam.
    g.fillStyle = steel(g, -1.05, 0.55, true);
    g.fillRect(-2.0, -1.05, uEnd + 2.0, 1.6);
    g.strokeRect(-2.0, -1.05, uEnd + 2.0, 1.6);

    // Depth rod protruding from the end of the beam.
    if (s > 0) {
      g.fillStyle = '#b8c0c8';
      g.fillRect(uEnd, -0.55, s, 0.18);
      g.strokeRect(uEnd, -0.55, s, 0.18);
    }

    // Main scale: mm ticks upwards from the edge (v = 0), numbered every cm.
    var rect = U.visibleRect(g);
    var kMax = Math.floor((uEnd - 0.6) * 10);
    var k0 = 0, k1 = kMax;
    if (rect) { k0 = Math.max(0, Math.floor(rect.x0 * 10) - 1); k1 = Math.min(kMax, Math.ceil(rect.x1 * 10) + 1); }
    g.strokeStyle = '#111';
    g.lineWidth = U.lineW(view, gradMain);
    g.beginPath();
    for (var k = k0; k <= k1; k++) {
      var len = k % 10 === 0 ? 0.42 : k % 5 === 0 ? 0.3 : 0.2;
      g.moveTo(k / 10, 0); g.lineTo(k / 10, -len);
    }
    g.stroke();
    g.fillStyle = '#111';
    for (var c = Math.ceil(k0 / 10); c * 10 <= k1; c++) U.text(g, String(c), c, -0.66, 0.24);
    U.text(g, 'cm', 0.55, -0.88, 0.16, { weight: '500', align: 'left' });

    // Sliding part: top lip, vernier plate, moving jaws.
    g.strokeStyle = edge;
    g.lineWidth = lw;
    g.fillStyle = steel(g, -1.3, -1.05, false);
    g.fillRect(s - 0.5, -1.25, V + 1.9, 0.22);
    g.strokeRect(s - 0.5, -1.25, V + 1.9, 0.22);
    // Locking screw.
    g.beginPath();
    g.arc(s + V + 0.7, -1.42, 0.2, Math.PI, 0);
    g.closePath();
    g.fillStyle = '#9aa3ac'; g.fill(); g.stroke();
    // Plate.
    g.fillStyle = steel(g, 0, 1.05, true);
    g.fillRect(s - 0.5, 0, V + 1.9, 1.05);
    g.strokeRect(s - 0.5, 0, V + 1.9, 1.05);
    // Moving jaws.
    g.fillStyle = steel(g, 1, 4.7, false);
    poly(g, [[s, 1.05], [s, JAW_FACE_BOTTOM], [s + 0.3, 4.7], [s + 1.1, 3.3], [s + 2.0, 1.6], [s + 2.0, 1.05]]);
    g.fill(); g.stroke();
    g.fillStyle = steel(g, -2.5, -1.2, false);
    poly(g, [[s, -1.25], [s, -2.3], [s + 0.15, -2.45], [s + 0.9, -1.5], [s + 0.9, -1.25]]);
    g.fill(); g.stroke();
    // Thumb grip (knurled).
    g.beginPath();
    for (var t = 0; t < 7; t++) { g.moveTo(s + V + 0.95 + t * 0.06, 0.62); g.lineTo(s + V + 0.95 + t * 0.06, 0.98); }
    g.strokeStyle = 'rgba(40,50,60,0.6)';
    g.stroke();

    // Vernier scale: ticks downwards from the edge, starting at the vernier zero.
    var n = this.divisions, sp = this.vernierSpacing / 10;
    g.strokeStyle = '#111';
    g.lineWidth = U.lineW(view, gradVernier);
    g.beginPath();
    for (var d = 0; d <= n; d++) {
      var major = n === 10 ? d % 5 === 0 : d % 5 === 0;
      var ln = major ? 0.3 : 0.2;
      g.moveTo(z + d * sp, 0); g.lineTo(z + d * sp, ln);
    }
    g.stroke();
    g.fillStyle = '#111';
    if (n === 10) {
      [0, 5, 10].forEach(function (d2) { U.text(g, String(d2), z + d2 * sp, 0.48, 0.17); });
    } else {
      for (var j = 0; j <= 10; j++) U.text(g, String(j), z + j * 5 * sp, 0.48, 0.15);
    }
    U.text(g, this.resolution === 0.02 ? '0.02 mm' : '0.1 mm', z + V / 2, 0.82, 0.14, { weight: '500', colour: '#333' });
    g.restore();
  }

  function describeVernier() {
    var fine = this.resolution === 0.02;
    return [
      '<h3>Vernier callipers</h3>',
      '<p><strong>Resolution:</strong> ' + (fine ? '0.02 mm — the vernier has 50 divisions spanning 49 mm.'
        : '0.1 mm — the vernier has 10 divisions spanning 9 mm.') + '</p>',
      '<h4>How to read it</h4>',
      '<ol><li>Close the jaws gently on the object. Do not squeeze: the object must just be held.</li>',
      '<li><strong>Main scale:</strong> read the last millimetre mark <em>before</em> the vernier zero (the numbers on the main scale are centimetres).</li>',
      '<li><strong>Vernier scale:</strong> find the one vernier mark that lines up exactly with <em>any</em> main-scale mark. Multiply its number of divisions by ' + (fine ? '0.02 mm' : '0.1 mm') + '.</li>',
      '<li>Add the two: e.g. main 23 mm + ' + (fine ? '17 × 0.02 mm = 23.34 mm' : '4 × 0.1 mm = 23.4 mm') + '.</li></ol>',
      '<p>Record the reading to ' + (fine ? 'two decimal places in mm (e.g. <code>23.34 mm</code>, or <code>2.334 cm</code>)'
        : 'one decimal place in mm (e.g. <code>23.4 mm</code>, or <code>2.34 cm</code>)') + '.</p>',
      '<h4>Zero error</h4>',
      '<p>Before measuring, close the jaws completely and read the scale. If the vernier zero is to the <em>right</em> of the main zero the zero error is positive; to the left it is negative (count the vernier divisions back from the end of the vernier). Then: <strong>corrected reading = reading − zero error</strong>. For example a zero error of +0.2 mm and a reading of 23.6 mm give 23.4 mm.</p>',
      '<h4>Parallax</h4>',
      '<p>Look straight at the scales, with your eye level with the coinciding marks. The vernier plate stands slightly proud of the main scale; if you can see its edge, your eye is not perpendicular.</p>',
      '<h4>Good technique</h4>',
      '<ul><li>Measure a diameter at several positions and orientations and average (wires and bobs are not perfectly round).</li>',
      '<li>Use the flat parts of the jaws, not the tips, and keep the object square to the jaws.</li></ul>',
      '<h4>Uncertainty to quote</h4>',
      '<p>±' + (fine ? '0.02 mm' : '0.1 mm') + ' (one division of the vernier). If repeated readings vary more than this, use half the range.</p>'
    ].join('');
  }
})(globalThis.VLab = globalThis.VLab || {});
