/**
 * Minimal test harness usable in Node (vm sandbox) and in the browser.
 * Globals: test(name, fn), assert.*, VLabTest.run().
 */
(function (G) {
  'use strict';
  var T = G.VLabTest = G.VLabTest || { tests: [], currentFile: '' };

  G.test = function (name, fn) {
    T.tests.push({ name: name, fn: fn, file: T.currentFile });
  };

  function fmt(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function fail(msg, detail) {
    var e = new Error((msg ? msg + ': ' : '') + detail);
    e.isAssertion = true;
    throw e;
  }
  function deepEq(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !deepEq(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }

  G.assert = {
    ok: function (v, msg) { if (!v) fail(msg, 'expected truthy, got ' + fmt(v)); },
    equal: function (a, b, msg) { if (a !== b) fail(msg, 'expected ' + fmt(b) + ', got ' + fmt(a)); },
    deepEqual: function (a, b, msg) { if (!deepEq(a, b)) fail(msg, 'expected ' + fmt(b) + ', got ' + fmt(a)); },
    close: function (actual, expected, tol, msg) {
      if (typeof actual !== 'number' || !isFinite(actual) || Math.abs(actual - expected) > tol) {
        fail(msg, 'expected ' + expected + ' ± ' + tol + ', got ' + actual);
      }
    },
    throws: function (fn, msg) {
      var threw = false;
      try { fn(); } catch (e) { threw = true; }
      if (!threw) fail(msg, 'expected function to throw');
    },
    match: function (str, re, msg) { if (!re.test(String(str))) fail(msg, fmt(str) + ' does not match ' + re); }
  };

  /** Run all registered tests; returns { passed, failed, results }. */
  T.run = async function (onResult) {
    var results = [], passed = 0, failed = 0;
    for (var i = 0; i < T.tests.length; i++) {
      var t = T.tests[i], r = { name: t.name, file: t.file, ok: true, error: null };
      var savedLevel = G.VLab && G.VLab.noise ? G.VLab.noise.level : undefined;
      try { await t.fn(); passed++; }
      catch (e) { r.ok = false; r.error = (e && e.stack) || String(e); failed++; }
      finally { if (savedLevel !== undefined && G.VLab.noise) G.VLab.noise.level = savedLevel; }
      results.push(r);
      if (onResult) onResult(r);
    }
    return { passed: passed, failed: failed, results: results };
  };
})(globalThis);
