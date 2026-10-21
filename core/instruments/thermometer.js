/**
 * Liquid-in-glass thermometer (contract §3.7): −10 °C to 110 °C, 1 °C divisions, 0.2 cm per °C.
 * The bulb lags behind its surroundings with time constant tau ≈ 5 s.
 *
 * place = { x, y }: world position (cm) of the bottom tip of the bulb; the thermometer is drawn vertically.
 * state = { value? }: the temperature the column shows (°C). Default: this.indicate() (bulb temperature + zero error).
 *
 * Extra API:
 *   temperature               current bulb temperature (°C, true)
 *   tau                       time constant (s)
 *   update(dt, envTemp)       advance the bulb towards envTemp; returns the new bulb temperature
 *   setTemperature(t)         set the bulb temperature immediately
 *   indicate(bulbTemp?)       bulbTemp (default this.temperature) + zeroError, clamped to the scale
 *   apparentReading(value, view)  column reading seen with the eye at view.eyeAngle
 *   yFor(place, temp)         world y of a scale mark
 *   tempAtY(place, y)         scale value at a world y
 *   boreGap                   depth of the capillary behind the scale (cm)
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;
  var K = 0.2;            // cm per °C
  var Y_MINUS10 = 2.3;    // cm above the bulb tip of the −10 °C mark
  var BORE_GAP = 0.35;    // capillary behind the engraved scale
  var STEM_W = 0.9;

  I.define('thermometer', function (inst, opts) {
    inst.name = 'Thermometer';
    inst.unit = '°C';
    inst.resolution = 1;
    inst.range = [-10, 110];
    inst.overRange = 3;
    inst.tau = opts.tau || 5;
    inst.temperature = typeof opts.initial === 'number' ? opts.initial : 25;
    inst.boreGap = BORE_GAP;
    inst.liquid = opts.liquid === 'mercury' ? 'mercury' : 'alcohol';
    inst.zeroErrorSpec = { resolution: 1, chance: 0.15, maxDivisions: 1 };

    inst.update = function (dt, envTemp) {
      if (dt > 0 && isFinite(envTemp)) {
        this.temperature = envTemp + (this.temperature - envTemp) * Math.exp(-dt / this.tau);
      }
      return this.temperature;
    };
    inst.setTemperature = function (t) { this.temperature = t; };
    var baseIndicate = I.proto.indicate;
    inst.indicate = function (bulbTemp, now) {
      return baseIndicate.call(this, bulbTemp === undefined ? this.temperature : bulbTemp, now);
    };
    inst.apparentReading = function (value, view) {
      var dy = this.apparentShift(-BORE_GAP, view);      // negative when the eye is above: column looks higher
      return U.clean(value - dy / K, 1e-4);
    };
    inst.yFor = function (place, t) { return (place.y || 0) - Y_MINUS10 - (t + 10) * K; };
    inst.tempAtY = function (place, y) { return ((place.y || 0) - Y_MINUS10 - y) / K - 10; };
    inst.draw = drawThermometer;
    inst.describe = describeThermometer;
  }, { name: 'Thermometer' });

  /** @this {object} thermometer instance */
  function drawThermometer(g, place, view, state) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    state = state || {};
    var value = typeof state.value === 'number' ? state.value : this.indicate();
    var x0 = place.x || 0, y0 = place.y || 0;
    var self = this;
    function Y(t) { return self.yFor(place, t); }
    var yTop = Y(110) - 2.2;
    var hw = STEM_W / 2;
    var lw = U.lineW(view, 0.012);
    var col = this.liquid === 'mercury' ? '#8e959c' : '#c8281e';

    g.save();
    g.translate(x0, 0);
    // Stem.
    var sg = g.createLinearGradient(-hw, 0, hw, 0);
    sg.addColorStop(0, 'rgba(200,220,235,0.85)'); sg.addColorStop(0.5, 'rgba(250,252,255,0.95)'); sg.addColorStop(1, 'rgba(190,210,228,0.85)');
    g.fillStyle = sg;
    U.roundRect(g, -hw, yTop, STEM_W, y0 - 1.2 - yTop, 0.35);
    g.fill();
    g.strokeStyle = '#6c8399'; g.lineWidth = lw; g.stroke();
    // Bulb.
    g.beginPath();
    g.ellipse(-0.08, y0 - 0.75, 0.3, 0.75, 0, 0, Math.PI * 2);
    g.fillStyle = col; g.fill();
    g.strokeStyle = '#6c8399'; g.stroke();
    // Capillary bore and liquid column (the column top is behind the scale, so it shifts with parallax).
    var shift = this.apparentShift(-BORE_GAP, view);
    var yCol = Y(U.clamp(value, -13, 113)) + shift;
    g.fillStyle = 'rgba(230,236,242,0.9)';
    g.fillRect(-0.105, yTop + 0.4, 0.05, y0 - 1.3 - yTop - 0.4);
    g.fillStyle = col;
    g.fillRect(-0.105, yCol, 0.05, y0 - 1.3 - yCol);

    // Scale (engraved on the front): ticks on the left of the bore, numbers on the right.
    var rect = U.visibleRect(g);
    g.strokeStyle = '#111';
    g.lineWidth = U.lineW(view, 0.008);
    g.beginPath();
    for (var t = -10; t <= 110; t++) {
      var y = Y(t);
      if (rect && (y < rect.y0 - 1 || y > rect.y1 + 1)) continue;
      var len = t % 10 === 0 ? 0.3 : t % 5 === 0 ? 0.22 : 0.14;
      g.moveTo(-hw + 0.04, y); g.lineTo(-hw + 0.04 + len, y);
    }
    g.stroke();
    g.fillStyle = '#111';
    for (var n = -10; n <= 110; n += 10) U.text(g, String(n), 0.2, Y(n), 0.2, { align: 'center' });
    U.text(g, '°C', 0.05, yTop + 0.8, 0.22);
    g.restore();
  }

  function describeThermometer() {
    return [
      '<h3>Liquid-in-glass thermometer</h3>',
      '<p><strong>Resolution:</strong> 1 °C (range −10 °C to 110 °C). Numbers every 10 °C, longer marks every 5 °C.</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Read the top of the liquid column against the scale; record to the nearest degree, e.g. <code>63 °C</code> (or to 0.5 °C if you can clearly judge half a division).</li>',
      '<li>Keep the bulb fully immersed and away from the bottom and sides of the container.</li></ul>',
      '<h4>Response time</h4>',
      '<p>The bulb takes time to reach the temperature of its surroundings (about ' + this.tau + ' s time constant here). After moving it, <strong>wait until the reading stops changing</strong>. Stir the liquid so its temperature is uniform.</p>',
      '<h4>Zero error</h4>',
      '<p>Put the bulb in a mixture of pure melting ice and water: it should read 0 °C. If it reads, say, 1 °C, every reading is 1 °C too high — subtract 1 °C. (Corrected reading = reading − zero error.)</p>',
      '<h4>Parallax</h4>',
      '<p>The liquid column is inside the glass, behind the engraved scale. Keep your eye level with the top of the column: from above you read too high, from below too low.</p>',
      '<h4>Uncertainty to quote</h4>',
      '<p>±1 °C (or ±0.5 °C). For a temperature <em>change</em> found from two readings, add the two uncertainties.</p>'
    ].join('');
  }
})(globalThis.VLab = globalThis.VLab || {});
