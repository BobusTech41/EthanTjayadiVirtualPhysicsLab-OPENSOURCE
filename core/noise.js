/**
 * Measurement noise: random error, zero errors, parallax and rare anomalies.
 * VL.noise.level is a global multiplier — unit tests set it to 0 to check the pure physics.
 */
(function (VL) {
  'use strict';

  var noise = {
    /** Global noise multiplier (1 = realistic, 0 = exact physics). */
    level: 1,
    /** Probability of an anomalous result per opportunity. */
    anomalyRate: 0.03,

    /** Gaussian random error with standard deviation sd (scaled by level). */
    gauss: function (rng, sd) {
      if (!noise.level || !sd) return 0;
      return sd * noise.level * rng.normal();
    },

    /** Round to the nearest multiple of the resolution. */
    quantize: function (value, resolution) {
      if (!resolution || !isFinite(value)) return value;
      var q = Math.round(value / resolution) * resolution;
      // remove floating-point dust (e.g. 0.30000000000000004)
      var decimals = Math.max(0, Math.ceil(-Math.log10(resolution)) + 2);
      return Number(q.toFixed(Math.min(decimals, 15)));
    },

    /** True occasionally (never when level is 0). */
    maybeAnomaly: function (rng, rate) {
      if (!noise.level) return false;
      return rng.chance(rate === undefined ? noise.anomalyRate : rate);
    },

    /**
     * A hidden zero error: 0 with probability (1 − chance), otherwise ±k × resolution, k = 1..maxDivisions.
     * @param {object} rng
     * @param {{resolution:number, chance?:number, maxDivisions?:number}} opts
     */
    zeroError: function (rng, opts) {
      opts = opts || {};
      var chance = opts.chance === undefined ? 0.3 : opts.chance;
      var maxDiv = opts.maxDivisions === undefined ? 3 : opts.maxDivisions;
      // always consume the same number of random draws so other streams stay reproducible
      var hit = rng.chance(chance), k = rng.int(1, Math.max(1, maxDiv)), sign = rng.chance(0.5) ? 1 : -1;
      if (!noise.level || !hit) return 0;
      return noise.quantize(sign * k * (opts.resolution || 0), opts.resolution);
    },

    /**
     * Apparent shift of an indicator that sits a distance `gap` in front of a scale, seen from an eye
     * displaced by eyeAngleDeg from the perpendicular (positive = eye above).
     */
    parallaxShift: function (gap, eyeAngleDeg) {
      return gap * Math.tan((eyeAngleDeg || 0) * Math.PI / 180);
    }
  };

  VL.noise = noise;
})(globalThis.VLab = globalThis.VLab || {});
