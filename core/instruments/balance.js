/**
 * Digital top-pan balance (contract §3.7). Display unit: g.
 *
 * opts.resolution 0.1 (default, capacity 600 g) or 0.01 (capacity 200 g); opts.max overrides the capacity.
 * When switched on without being tared, the balance shows a hidden offset (its zeroError, the "untared offset").
 * tare(load) zeroes it with `load` grams on the pan. The last digit flickers when `now` is given.
 *
 * place = { x, y }: world position (cm) of the centre of the TOP of the pan (objects stand on y).
 * state = { load (true grams on the pan), now (ms, optional (else view.now)), on = true }
 *
 * Extra API:
 *   tare(load = 0)          zero the display with `load` g on the pan
 *   untare()                forget the tare (shows the raw offset again)
 *   tared                   boolean
 *   indicate(load, now?)    number shown (g), quantized; NaN when overloaded
 *   display(load, now?)     the display string, e.g. '12.34', '-0.03' or 'Err' when overloaded
 *   panHalfWidth            half-width of the pan in cm (for drawing objects on it)
 */
(function (VL) {
  'use strict';
  var I = VL.instruments, U = I.util;

  I.define('balance', function (inst, opts) {
    var fine = opts.resolution === 0.01;
    inst.name = 'Top-pan balance';
    inst.unit = 'g';
    inst.digital = true;
    inst.resolution = fine ? 0.01 : 0.1;
    inst.max = opts.max || (fine ? 200 : 600);
    inst.range = [0, inst.max];
    inst.panHalfWidth = 6;
    inst.flickerSd = 0.35 * inst.resolution;
    inst.flickerMs = 450;
    inst.zeroErrorSpec = { resolution: inst.resolution, chance: 0.7, maxDivisions: fine ? 25 : 4 };
    inst.tareRef = 0;
    inst.tared = false;

    inst.tare = function (load) {
      this.tareRef = (load || 0) + this.zeroError;
      this.tared = true;
    };
    inst.untare = function () { this.tareRef = 0; this.tared = false; };
    inst.isOverloaded = function (load) { return load > this.max + 9 * this.resolution; };
    inst.indicate = function (load, now) {
      if (this.isOverloaded(load)) return NaN;
      var v = load + this.zeroError - this.tareRef + U.flicker(this, now);
      return U.quantize(v, this.resolution);
    };
    inst.display = function (load, now) {
      var v = this.indicate(load, now);
      return isNaN(v) ? 'Err' : U.fixed(v, this.decimals);
    };
    inst.draw = drawBalance;
    inst.describe = describeBalance;
  }, { name: 'Top-pan balance' });

  /** @this {object} balance instance */
  function drawBalance(g, place, view, state) {
    place = place || {};
    view = view || { scale: 10, eyeAngle: 0 };
    state = state || {};
    var now = state.now !== undefined ? state.now : view.now;
    var on = state.on !== false;
    var load = state.load || 0;
    var lw = U.lineW(view, 0.015);
    var W = 10.5;

    g.save();
    g.translate(place.x || 0, place.y || 0);
    g.lineWidth = lw;
    g.strokeStyle = '#3d4650';

    // Body.
    g.beginPath();
    g.moveTo(-W + 0.4, 1.0); g.lineTo(W - 0.4, 1.0); g.lineTo(W, 7.2); g.lineTo(-W, 7.2); g.closePath();
    var bg = g.createLinearGradient(0, 1, 0, 7.2);
    bg.addColorStop(0, '#f1f3f5'); bg.addColorStop(1, '#c9cfd5');
    g.fillStyle = bg; g.fill(); g.stroke();
    // Feet.
    g.fillStyle = '#2b3138';
    g.fillRect(-W + 0.8, 7.2, 1.4, 0.35); g.fillRect(W - 2.2, 7.2, 1.4, 0.35);
    // Pan support and pan (a disc seen almost edge-on).
    g.fillStyle = '#9aa3ac';
    g.fillRect(-0.6, 0.3, 1.2, 0.75);
    var pg = g.createLinearGradient(0, -0.1, 0, 0.35);
    pg.addColorStop(0, '#f8fafb'); pg.addColorStop(1, '#a3adb7');
    g.fillStyle = pg;
    U.roundRect(g, -6, 0, 12, 0.32, 0.12);
    g.fill(); g.stroke();
    g.beginPath();
    g.ellipse(0, 0, 6, 0.18, 0, Math.PI, 2 * Math.PI);
    g.fillStyle = '#e4e8ec'; g.fill(); g.stroke();

    // Display window.
    U.roundRect(g, -5.2, 2.0, 10.4, 2.5, 0.25);
    g.fillStyle = '#20262c'; g.fill();
    U.roundRect(g, -4.9, 2.25, 9.8, 2.0, 0.15);
    g.fillStyle = on ? '#c9d6b6' : '#8f9a84'; g.fill();
    if (on) {
      var str = this.display(load, now);
      U.sevenSeg(g, str, 3.6, 2.6, 1.3, { on: '#15191c', off: 'rgba(20,25,28,0.06)', digits: 6 });
      U.text(g, 'g', 4.2, 3.7, 0.6, { colour: '#15191c', weight: '700' });
      if (this.tared) U.text(g, '→0←', -4.1, 2.62, 0.32, { colour: '#15191c', weight: '700' });
    }
    // Buttons.
    [['ON/OFF', -3.0], ['TARE', 3.0]].forEach(function (b) {
      U.roundRect(g, b[1] - 1.4, 5.1, 2.8, 1.1, 0.35);
      g.fillStyle = b[0] === 'TARE' ? '#2f6db5' : '#59636d';
      g.fill();
      U.text(g, b[0], b[1], 5.65, 0.42, { colour: '#ffffff', weight: '700' });
    });
    U.text(g, 'Max ' + this.max + ' g   d = ' + this.resolution + ' g', 0, 6.75, 0.32, { colour: '#3d4650', weight: '500' });
    g.restore();
  }

  function describeBalance() {
    var r = this.resolution;
    return [
      '<h3>Top-pan balance</h3>',
      '<p><strong>Resolution:</strong> ' + r + ' g (the value “d” printed on the balance). Capacity ' + this.max + ' g.</p>',
      '<h4>How to read it</h4>',
      '<ul><li>Write down <em>every</em> digit shown, including trailing zeros: <code>' + (r === 0.01 ? '25.40 g' : '25.4 g') + '</code>, not <code>25.4</code> or <code>25 g</code>.</li>',
      '<li>If the last digit flickers between two values, wait for it to settle or record the value it shows most often.</li></ul>',
      '<h4>Zero error (tare)</h4>',
      '<p>With nothing on the pan the display should read zero. If it does not, press <strong>TARE</strong> before you put the object on. Forgetting this adds the offset to every reading. You can also tare with a container on the pan to measure only what you add to it.</p>',
      '<h4>Good technique</h4>',
      '<ul><li>Place the balance on a level, still bench away from draughts.</li>',
      '<li>Put the object in the centre of the pan and wait for the reading to settle.</li>',
      '<li>Do not lean on the bench while reading.</li></ul>',
      '<h4>Uncertainty to quote</h4>',
      '<p>±' + r + ' g (one unit in the last digit), or more if the reading drifts.</p>'
    ].join('');
  }
})(globalThis.VLab = globalThis.VLab || {});
