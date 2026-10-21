/**
 * Electrical meters (contract §3.7): analogueMeter (arc scale, needle, mirror strip) and digitalMeter (LCD).
 *
 * analogueMeter
 *   opts.kind 'A' (default) | 'V'; opts.range = { max, minor } (default A: {max: 1, minor: 0.02}; V: {max: 5, minor: 0.1});
 *   opts.unit overrides the unit symbol (e.g. 'mA'). resolution = minor, tolerance = minor / 2.
 *   Hidden zero offset (needle not on 0 when no current flows), ±1 minor division with chance 0.3.
 *   place = { x, y }: world position (cm) of the centre of the meter case.
 *   state = { value? }: needle position in scale units (default: the damped needle, this.needle).
 *   Extra API: update(dt, trueValue) (damped needle, slight overshoot), settle(trueValue), needle,
 *              apparentValue(value, view), needleGap, scaleRadius, sweepDeg.
 *   Parallax: the needle is needleGap cm in front of the dial. Only the component of the eye's offset
 *   perpendicular to the needle matters, so view.eyeAngle is applied in that direction: positive = the needle
 *   appears displaced towards higher readings, and its image in the mirror strip separates from it.
 *
 * digitalMeter
 *   opts.range: '200 mV' | '2 V' | '20 V' (default for V) | '200 V' | '2 mA' | '20 mA' | '200 mA' | '2 A' (default for A)
 *               | '20 A' | '200 Ω' | '2 kΩ' | '20 kΩ' | '200 kΩ'; opts.kind 'V' | 'A' | 'Ω' picks the default range.
 *   unit = the range's unit (values passed to indicate() are in that unit). 3½ digits (1999 counts); 'OL' when over range.
 *   Extra API: setRange(name), display(value, now?), indicateSI(valueSI, now?), siFactor, ranges.
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;

  /* ------------------------------------------------------------------ */
  /* Analogue meter                                                      */
  /* ------------------------------------------------------------------ */

  var PIVOT_V = 2.4, SCALE_R = 5.6, SWEEP = 90, NEEDLE_GAP = 0.3;

  I.define('analogueMeter', function (inst, opts) {
    var kind = opts.kind === 'V' ? 'V' : 'A';
    var rng = opts.range || {};
    var max = rng.max || opts.max || (kind === 'A' ? 1 : 5);
    var minor = rng.minor || opts.minor || (kind === 'A' ? 0.02 : 0.1);
    inst.kind = kind;
    inst.name = kind === 'A' ? 'Analogue ammeter' : 'Analogue voltmeter';
    inst.unit = opts.unit || kind;
    inst.max = max;
    inst.minor = minor;
    inst.resolution = minor;
    inst.tolerance = minor / 2;
    inst.range = [0, max];
    inst.overRange = 0.04 * max;
    inst.divisions = Math.round(max / minor);
    inst.scaleRadius = SCALE_R;
    inst.sweepDeg = SWEEP;
    inst.needleGap = NEEDLE_GAP;
    inst.zeroErrorSpec = { resolution: minor, chance: 0.3, maxDivisions: 1 };
    inst.needle = 0;
    inst.needleVel = 0;
    inst.omega = 14;      // rad/s natural frequency of the movement
    inst.zeta = 0.7;      // damping ratio (slightly under-damped: ~5 % overshoot)

    inst.init = function () { this.needle = this.indicate(0); };
    inst.settle = function (trueValue) { this.needle = this.indicate(trueValue); this.needleVel = 0; return this.needle; };
    inst.update = function (dt, trueValue) {
      var target = this.indicate(trueValue);
      var steps = Math.max(1, Math.ceil(Math.min(dt, 0.5) / 0.004));
      var h = Math.min(dt, 0.5) / steps;
      for (var i = 0; i < steps; i++) {
        var acc = this.omega * this.omega * (target - this.needle) - 2 * this.zeta * this.omega * this.needleVel;
        this.needleVel += acc * h;
        this.needle += this.needleVel * h;
      }
      var lo = this.range[0] - this.overRange, hi = this.range[1] + this.overRange;
      if (this.needle < lo) { this.needle = lo; this.needleVel = 0; }
      if (this.needle > hi) { this.needle = hi; this.needleVel = 0; }
      return this.needle;
    };
    /** Needle angle from the vertical (rad, clockwise positive) for a scale value. */
    inst.angleFor = function (value) {
      return (-SWEEP / 2 + SWEEP * value / this.max) * Math.PI / 180;
    };
    inst.apparentValue = function (value, view) {
      var shift = this.apparentShift(NEEDLE_GAP, view);              // tangential displacement (cm)
      var dTheta = shift / SCALE_R;                                  // rad
      return U.clean(value + dTheta / (SWEEP * Math.PI / 180) * this.max, 1e-6);
    };
    inst.draw = drawAnalogue;
    inst.describe = describeAnalogue;
  }, { name: 'Analogue meter' });

  function niceLabel(v) {
    return String(Number(v.toFixed(6)));
  }

  /** @this {object} analogue meter */
  function drawAnalogue(g, place, view, state) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    state = state || {};
    var self = this;
    var value = typeof state.value === 'number' ? state.value : this.needle;
    var lw = U.lineW(view, 0.015);
    var n = this.divisions;
    var labelEvery = n >= 20 ? (n % 10 === 0 ? 10 : 5) : 5;
    var midEvery = labelEvery === 10 ? 5 : 1;

    g.save();
    g.translate(place.x || 0, place.y || 0);
    // Case.
    U.roundRect(g, -6.2, -5.2, 12.4, 10.4, 0.6);
    var cg = g.createLinearGradient(0, -5.2, 0, 5.2);
    cg.addColorStop(0, '#3a4450'); cg.addColorStop(1, '#1d242b');
    g.fillStyle = cg; g.fill();
    g.strokeStyle = '#11161b'; g.lineWidth = lw; g.stroke();
    // Dial.
    U.roundRect(g, -5.6, -4.7, 11.2, 6.6, 0.3);
    g.fillStyle = '#fbfaf4'; g.fill();

    // Scale arc and ticks (centre = pivot).
    g.save();
    g.translate(0, PIVOT_V);
    var a0 = -Math.PI / 2 - SWEEP / 2 * Math.PI / 180, a1 = -Math.PI / 2 + SWEEP / 2 * Math.PI / 180;
    // Mirror strip.
    g.beginPath();
    g.arc(0, 0, SCALE_R - 0.18, a0 - 0.02, a1 + 0.02);
    g.arc(0, 0, SCALE_R - 0.62, a1 + 0.02, a0 - 0.02, true);
    g.closePath();
    var mg = g.createLinearGradient(-SCALE_R, -SCALE_R, SCALE_R, -SCALE_R * 0.6);
    mg.addColorStop(0, '#c3ccd5'); mg.addColorStop(0.45, '#eef3f7'); mg.addColorStop(1, '#aeb9c4');
    g.fillStyle = mg; g.fill();
    g.strokeStyle = '#7e8a96'; g.lineWidth = U.lineW(view, 0.006); g.stroke();
    // Arc line.
    g.beginPath();
    g.arc(0, 0, SCALE_R, a0, a1);
    g.strokeStyle = '#111'; g.lineWidth = U.lineW(view, 0.012); g.stroke();
    g.beginPath();
    for (var k = 0; k <= n; k++) {
      var th = this.angleFor(k * this.minor);
      var len = k % labelEvery === 0 ? 0.5 : k % midEvery === 0 && midEvery > 1 ? 0.36 : 0.24;
      var s = Math.sin(th), c = -Math.cos(th);
      g.moveTo(s * SCALE_R, c * SCALE_R);
      g.lineTo(s * (SCALE_R + len), c * (SCALE_R + len));
    }
    g.lineWidth = U.lineW(view, 0.01);
    g.stroke();
    g.fillStyle = '#111';
    for (var kk = 0; kk <= n; kk += labelEvery) {
      var t2 = this.angleFor(kk * this.minor);
      U.text(g, niceLabel(kk * this.minor), Math.sin(t2) * (SCALE_R + 0.9), -Math.cos(t2) * (SCALE_R + 0.9), 0.36, { rotate: t2 });
    }

    // Needle, its mirror image, parallax.
    var app = this.apparentValue(value, view);
    var mirrorVal = U.clean(2 * value - app, 1e-6);
    var tipR = SCALE_R + 0.42;
    // Mirror image (visible only inside the strip).
    g.save();
    g.beginPath();
    g.arc(0, 0, SCALE_R - 0.18, a0 - 0.05, a1 + 0.05);
    g.arc(0, 0, SCALE_R - 0.62, a1 + 0.05, a0 - 0.05, true);
    g.closePath();
    g.clip();
    var tm = this.angleFor(mirrorVal);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.sin(tm) * tipR, -Math.cos(tm) * tipR);
    g.strokeStyle = 'rgba(30,30,30,0.55)';
    g.lineWidth = U.lineW(view, 0.02);
    g.stroke();
    g.restore();
    var tn = this.angleFor(app);
    g.save();
    g.beginPath();
    g.rect(-5.6, -4.7 - PIVOT_V, 11.2, 5.85);   // the needle is only visible above the cover plate
    g.clip();
    g.beginPath();
    g.moveTo(-Math.sin(tn) * 0.9, Math.cos(tn) * 0.9);
    g.lineTo(Math.sin(tn) * (SCALE_R - 1.0), -Math.cos(tn) * (SCALE_R - 1.0));
    g.strokeStyle = '#141414';
    g.lineWidth = U.lineW(view, 0.05);
    g.stroke();
    g.beginPath();   // knife-edge tip
    g.moveTo(Math.sin(tn) * (SCALE_R - 1.0), -Math.cos(tn) * (SCALE_R - 1.0));
    g.lineTo(Math.sin(tn) * tipR, -Math.cos(tn) * tipR);
    g.lineWidth = U.lineW(view, 0.012);
    g.stroke();
    g.restore();
    g.restore();

    // Cover plate over the pivot, unit symbol, zero-adjust screw, terminals.
    g.fillStyle = '#20272e';
    g.fillRect(-5.6, 1.15, 11.2, 0.75);
    U.text(g, this.unit, 0, -0.25, 1.0, { colour: '#111', weight: '700' });
    g.beginPath();
    g.arc(0, 3.0, 0.42, 0, Math.PI * 2);
    g.fillStyle = '#8b96a1'; g.fill();
    g.strokeStyle = '#11161b'; g.stroke();
    g.beginPath(); g.moveTo(-0.3, 3.0); g.lineTo(0.3, 3.0);
    g.lineWidth = U.lineW(view, 0.06); g.stroke();
    [['+', -3.6, '#c0392b'], ['−', 3.6, '#1b1f23']].forEach(function (tp) {
      g.beginPath();
      g.arc(tp[1], 3.6, 0.65, 0, Math.PI * 2);
      g.fillStyle = tp[2]; g.fill();
      g.strokeStyle = '#0d1114'; g.lineWidth = lw; g.stroke();
      U.text(g, tp[0], tp[1], 3.6, 0.7, { colour: '#ffffff', weight: '700' });
    });
    U.text(g, '0–' + niceLabel(self.max) + ' ' + self.unit, 0, 4.6, 0.34, { colour: '#dfe5ea', weight: '600' });
    g.restore();
  }

  function describeAnalogue() {
    var m = this.minor, u = this.unit;
    return [
      '<h3>' + this.name + '</h3>',
      '<p><strong>Resolution:</strong> one small division = ' + niceLabel(m) + ' ' + u + ' (full scale ' + niceLabel(this.max) + ' ' + u + '). Work out the value of a division from two numbered marks before reading.</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Read where the needle tip crosses the scale. You can usually estimate to half a division.</li>',
      '<li>Record to the precision of the scale, e.g. <code>' + U.fixed(0.5 * m * Math.round(0.62 * this.max / (0.5 * m)), U.decimalsOf(m / 2)) + ' ' + u + '</code>.</li>',
      '<li>Choose a range so that the needle is in the upper part of the scale — the percentage uncertainty is then smallest.</li></ul>',
      '<h4>Zero error</h4>',
      '<p>Before connecting (no current), check that the needle rests exactly on zero. If not, turn the zero-adjust screw, or note the offset and subtract it from every reading. (Corrected reading = reading − zero error.)</p>',
      '<h4>Parallax — use the mirror</h4>',
      '<p>The needle is a few millimetres in front of the scale. Move your head until the needle hides its own reflection in the mirror strip: your eye is then directly in front of the needle and the reading has no parallax error.</p>',
      '<h4>Good technique</h4>',
      '<ul><li>Tap the meter gently and wait for the needle to settle (it overshoots slightly).</li>',
      '<li>Connect ammeters in series and voltmeters in parallel; + terminal towards the positive of the supply.</li>',
      '<li>Switch off between readings so that the wire does not heat up.</li></ul>',
      '<h4>Uncertainty to quote</h4>',
      '<p>± half a division (±' + niceLabel(m / 2) + ' ' + u + ') to ± one division, depending on how clearly the needle can be judged.</p>'
    ].join('');
  }

  /* ------------------------------------------------------------------ */
  /* Digital multimeter                                                  */
  /* ------------------------------------------------------------------ */

  var RANGES = {
    '200 mV': { max: 199.9, resolution: 0.1, unit: 'mV', si: 1e-3, kind: 'V' },
    '2 V': { max: 1.999, resolution: 0.001, unit: 'V', si: 1, kind: 'V' },
    '20 V': { max: 19.99, resolution: 0.01, unit: 'V', si: 1, kind: 'V' },
    '200 V': { max: 199.9, resolution: 0.1, unit: 'V', si: 1, kind: 'V' },
    '2 mA': { max: 1.999, resolution: 0.001, unit: 'mA', si: 1e-3, kind: 'A' },
    '20 mA': { max: 19.99, resolution: 0.01, unit: 'mA', si: 1e-3, kind: 'A' },
    '200 mA': { max: 199.9, resolution: 0.1, unit: 'mA', si: 1e-3, kind: 'A' },
    '2 A': { max: 1.999, resolution: 0.001, unit: 'A', si: 1, kind: 'A' },
    '20 A': { max: 19.99, resolution: 0.01, unit: 'A', si: 1, kind: 'A' },
    '200 Ω': { max: 199.9, resolution: 0.1, unit: 'Ω', si: 1, kind: 'Ω' },
    '2 kΩ': { max: 1.999, resolution: 0.001, unit: 'kΩ', si: 1e3, kind: 'Ω' },
    '20 kΩ': { max: 19.99, resolution: 0.01, unit: 'kΩ', si: 1e3, kind: 'Ω' },
    '200 kΩ': { max: 199.9, resolution: 0.1, unit: 'kΩ', si: 1e3, kind: 'Ω' }
  };
  var DEFAULT_RANGE = { V: '20 V', A: '2 A', 'Ω': '2 kΩ' };

  I.define('digitalMeter', function (inst, opts) {
    var rangeName = typeof opts.range === 'string' && RANGES[opts.range] ? opts.range
      : DEFAULT_RANGE[opts.kind] || DEFAULT_RANGE.V;
    inst.name = 'Digital multimeter';
    inst.digital = true;
    inst.ranges = Object.keys(RANGES);
    inst.flickerMs = 500;
    inst.zeroDigits = 0;

    /** Switch range; the zero offset keeps the same number of digits. */
    inst.setRange = function (name) {
      var r = RANGES[name];
      if (!r) throw new Error('digitalMeter: unknown range ' + name);
      this.rangeName = name;
      this.kind = r.kind;
      this.unit = r.unit;
      this.resolution = r.resolution;
      this.tolerance = r.resolution;
      this.max = r.max;
      this.range = [-r.max, r.max];
      this.siFactor = r.si;
      this.decimals = U.decimalsOf(r.resolution);
      this.flickerSd = 0.35 * r.resolution;
      this.zeroError = U.roundTo(this.zeroDigits * r.resolution, r.resolution);
      return this;
    };
    inst.setRange(rangeName);
    inst.zeroErrorSpec = { resolution: inst.resolution, chance: 0.3, maxDivisions: 2 };
    inst.init = function () {
      this.zeroDigits = Math.round(this.zeroError / this.resolution);
      this.flickerSd = 0.35 * this.resolution;
    };
    inst.indicate = function (value, now) {
      var v = value + this.zeroError + U.flicker(this, now);
      if (Math.abs(v) > this.max + this.resolution / 2) return NaN;
      return U.quantize(v, this.resolution);
    };
    inst.indicateSI = function (valueSI, now) { return this.indicate(valueSI / this.siFactor, now); };
    inst.display = function (value, now) {
      var v = this.indicate(value, now);
      if (isNaN(v)) return 'OL';
      return U.fixed(v, this.decimals);
    };
    inst.draw = drawDigital;
    inst.describe = describeDigital;
  }, { name: 'Digital multimeter' });

  /** @this {object} digital meter. place = { x, y } centre of the meter; state = { value, now?, on = true } */
  function drawDigital(g, place, view, state) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    state = state || {};
    var now = state.now !== undefined ? state.now : view.now;
    var lw = U.lineW(view, 0.015);
    g.save();
    g.translate(place.x || 0, place.y || 0);
    // Rubber holster and body.
    U.roundRect(g, -4.3, -7.8, 8.6, 15.6, 0.9);
    g.fillStyle = '#e8b81e'; g.fill();
    g.strokeStyle = '#6b520a'; g.lineWidth = lw; g.stroke();
    U.roundRect(g, -3.8, -7.3, 7.6, 14.6, 0.5);
    g.fillStyle = '#2b3036'; g.fill();
    // LCD.
    U.roundRect(g, -3.3, -6.7, 6.6, 3.1, 0.2);
    g.fillStyle = '#c9d6b6'; g.fill();
    var str = state.on === false ? '' : this.display(state.value || 0, now);
    if (str) {
      U.sevenSeg(g, str, 2.0, -6.2, 1.9, { on: '#15191c', off: 'rgba(20,25,28,0.05)', digits: 4 });
      U.text(g, this.unit, 2.65, -4.2, 0.45, { colour: '#15191c', weight: '700' });
      if (this.kind !== 'Ω') U.text(g, 'DC', -2.8, -6.3, 0.3, { colour: '#15191c', weight: '700', align: 'left' });
    }
    // Range dial.
    g.beginPath();
    g.arc(0, 0.6, 2.3, 0, Math.PI * 2);
    g.fillStyle = '#1a1e22'; g.fill();
    g.strokeStyle = '#555f69'; g.stroke();
    var idx = this.ranges.indexOf(this.rangeName);
    var ang = -Math.PI * 0.9 + (idx / (this.ranges.length - 1)) * Math.PI * 1.8;
    g.beginPath();
    g.moveTo(0, 0.6);
    g.lineTo(Math.sin(ang) * 2.0, 0.6 - Math.cos(ang) * 2.0);
    g.strokeStyle = '#f2f2f2'; g.lineWidth = U.lineW(view, 0.18); g.stroke();
    U.text(g, 'RANGE  ' + this.rangeName, 0, -2.8, 0.42, { colour: '#f2f2f2', weight: '700' });
    // Sockets.
    [['COM', -2.4, '#111'], ['VΩmA', 0, '#b3261e'], ['20A', 2.4, '#b3261e']].forEach(function (s) {
      g.beginPath();
      g.arc(s[1], 5.4, 0.55, 0, Math.PI * 2);
      g.fillStyle = s[2]; g.fill();
      g.strokeStyle = '#999'; g.lineWidth = U.lineW(view, 0.05); g.stroke();
      U.text(g, s[0], s[1], 6.45, 0.32, { colour: '#f2f2f2', weight: '600' });
    });
    g.restore();
  }

  function describeDigital() {
    return [
      '<h3>Digital multimeter</h3>',
      '<p><strong>Resolution:</strong> one unit in the last digit, which depends on the range: 2 V → 0.001 V, 20 V → 0.01 V, 200 mA → 0.1 mA, 2 A → 0.001 A. Current range: ' + this.rangeName + ' (' + this.resolution + ' ' + this.unit + ').</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Record every digit shown, including trailing zeros, with the unit shown on the display: <code>1.250 V</code>, not <code>1.25</code>.</li>',
      '<li><code>OL</code> means the value is larger than the range: switch to a higher range.</li>',
      '<li>Use the lowest range that does not overload — this gives the most digits.</li>',
      '<li>If the last digit fluctuates, record the value it shows most often (or the middle value) and say so.</li></ul>',
      '<h4>Zero error</h4>',
      '<p>With the leads joined together (voltmeter or ohmmeter) or the circuit switched off (ammeter), the display should read zero. A small non-zero value is a zero error: subtract it from your readings.</p>',
      '<h4>Good technique</h4>',
      '<ul><li>Ammeter in series, voltmeter in parallel; use the correct sockets (COM and V/mA, or the high-current socket).</li>',
      '<li>Switch off between readings so that components do not heat up and change resistance.</li></ul>',
      '<h4>Uncertainty to quote</h4>',
      '<p>± one unit in the last digit (±' + this.resolution + ' ' + this.unit + ' on this range), or half the range of the fluctuation if it is larger.</p>'
    ].join('');
  }

  I.meterRanges = RANGES;
})(globalThis.VLab = globalThis.VLab || {});
