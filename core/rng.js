/**
 * Seeded random numbers.
 *
 * Every session has a human-readable seed such as "PEN-7K2Q-91C3". The same seed always rebuilds the same
 * hidden parameters and the same noise sequence, so a student can retry exactly the same set-up.
 * Generator: sfc32 seeded from a cyrb128 hash of the seed string.
 */
(function (VL) {
  'use strict';

  // Crockford base32 alphabet (no I, L, O, U) — easy to read aloud and type.
  var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var SEED_RE = /^[A-Z]{2,4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

  /**
   * cyrb128 string hash → four 32-bit unsigned integers.
   * @param {string} str
   * @returns {number[]}
   */
  function hash(str) {
    str = String(str);
    var h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (var i = 0, k; i < str.length; i++) {
      k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }

  /** sfc32 generator returning floats in [0, 1). */
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      var t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  /**
   * Create a seeded generator.
   * @param {string} seedStr
   * @returns {Rng}
   */
  function create(seedStr) {
    var seed = String(seedStr);
    var h = hash(seed);
    var gen = sfc32(h[0], h[1], h[2], h[3]);
    for (var i = 0; i < 12; i++) gen(); // warm up
    var spare = null; // cached second Box–Muller value

    var rng = {
      seed: seed,
      next: gen,
      uniform: function (a, b) { return a + (b - a) * gen(); },
      int: function (a, b) {
        a = Math.ceil(a); b = Math.floor(b);
        return a + Math.floor(gen() * (b - a + 1));
      },
      normal: function (mean, sd) {
        if (mean === undefined) mean = 0;
        if (sd === undefined) sd = 1;
        var z;
        if (spare !== null) { z = spare; spare = null; }
        else {
          var u = 0, v = 0;
          while (u === 0) u = gen();
          v = gen();
          var r = Math.sqrt(-2 * Math.log(u));
          z = r * Math.cos(2 * Math.PI * v);
          spare = r * Math.sin(2 * Math.PI * v);
        }
        return mean + sd * z;
      },
      pick: function (arr) { return arr[Math.floor(gen() * arr.length)]; },
      chance: function (p) { return gen() < p; },
      shuffle: function (arr) {
        var a = arr.slice();
        for (var i = a.length - 1; i > 0; i--) {
          var j = Math.floor(gen() * (i + 1));
          var t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
      },
      fork: function (name) { return create(seed + '/' + name); }
    };
    return rng;
  }

  /**
   * Make a new random readable seed, e.g. newSeed('PEN') → 'PEN-7K2Q-91C3'.
   * This is the only place in the app allowed to use non-seeded randomness.
   * @param {string} [prefix='LAB']
   */
  function newSeed(prefix) {
    prefix = String(prefix || 'LAB').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (prefix.length < 2) prefix = (prefix + 'LAB').slice(0, 3);
    var bytes = new Uint8Array(8);
    var c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (var i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
    var s = '';
    for (var j = 0; j < 8; j++) s += ALPHABET[bytes[j] & 31];
    return prefix + '-' + s.slice(0, 4) + '-' + s.slice(4);
  }

  /** Trim and upper-case a typed seed; common look-alikes are mapped (O→0, I/L→1). */
  function normalizeSeed(str) {
    var s = String(str || '').trim().toUpperCase().replace(/\s+/g, '');
    var parts = s.split('-');
    if (parts.length === 3) {
      parts[1] = parts[1].replace(/O/g, '0').replace(/[IL]/g, '1');
      parts[2] = parts[2].replace(/O/g, '0').replace(/[IL]/g, '1');
      s = parts.join('-');
    }
    return s;
  }

  /** @returns {boolean} */
  function isValidSeed(str) {
    return SEED_RE.test(normalizeSeed(str));
  }

  VL.rng = {
    hash: hash,
    create: create,
    newSeed: newSeed,
    normalizeSeed: normalizeSeed,
    isValidSeed: isValidSeed,
    ALPHABET: ALPHABET
  };
})(globalThis.VLab = globalThis.VLab || {});
