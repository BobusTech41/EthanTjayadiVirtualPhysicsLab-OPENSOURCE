/**
 * Significant figures and decimal places of the strings a student types.
 *
 * The lab always keeps the exact typed string, because "0.50" and "0.5" mean different things to an
 * examiner: the first claims 2 s.f. / 2 d.p., the second 1 s.f. / 1 d.p.
 */
(function (VL) {
  'use strict';

  var SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };

  /** Replace runs of superscript characters with '^' + plain characters ('10⁻³' → '10^-3'). */
  function desuperscript(s) {
    return s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, function (run, offset, whole) {
      var plain = run.split('').map(function (c) { return SUP[c]; }).join('');
      return (offset > 0 && whole[offset - 1] === '^') ? plain : '^' + plain;
    });
  }

  var NUM_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+)|[x×*]10\^?([+-]?\d+))?$/;

  /**
   * Parse a typed number.
   * @param {string} str
   * @returns {{ok:boolean, value:number, str:string, sf:number, sfMin:number, sfMax:number, dp:number,
   *            mantissa:number, exponent:number, problems:string[]}}
   */
  function parse(str) {
    var raw = String(str === undefined || str === null ? '' : str).trim();
    var res = { ok: false, value: NaN, str: raw, sf: NaN, sfMin: NaN, sfMax: NaN, dp: NaN, mantissa: NaN, exponent: 0, problems: [] };
    if (!raw) { res.problems.push('empty'); return res; }
    if (/^\s*[+-−]?\d+,\d+/.test(raw)) {
      res.problems.push('comma used as decimal separator — use a decimal point');
      return res;
    }
    var s = desuperscript(raw.replace(/[−–]/g, '-')).replace(/\s+/g, '');
    var m = NUM_RE.exec(s);
    if (!m) { res.problems.push('not a number'); return res; }
    var sign = m[1] || '', intPart = m[2] || '', frac = m[3];
    var hasPoint = s.indexOf('.') !== -1;
    if (intPart === '' && (frac === undefined || frac === '')) { res.problems.push('not a number'); return res; }
    var exp = m[4] !== undefined ? parseInt(m[4], 10) : (m[5] !== undefined ? parseInt(m[5], 10) : 0);
    if (intPart === '') res.problems.push('leading decimal point — write 0.5, not .5');
    frac = frac || '';

    var mantStr = sign + (intPart || '0') + (frac ? '.' + frac : '');
    res.mantissa = Number(mantStr);
    res.exponent = exp;
    res.value = Number(mantStr + 'e' + exp);
    res.dp = frac.length - exp;

    var digits = (intPart + frac).replace(/^0+/, '');
    if (digits === '' || /^0*$/.test(digits)) {
      res.sf = res.sfMin = res.sfMax = 1; // a zero value
    } else if (hasPoint) {
      res.sf = res.sfMin = res.sfMax = digits.length;
    } else {
      var stripped = intPart.replace(/^0+/, '');
      res.sfMax = stripped.length;
      res.sfMin = stripped.replace(/0+$/, '').length;
      res.sf = res.sfMax;
    }
    res.ok = isFinite(res.value);
    if (!res.ok) res.problems.push('not a finite number');
    return res;
  }

  /** @returns {number} significant figures (NaN if unparseable) */
  function sf(str) { return parse(str).sf; }

  /** @returns {number} decimal places (NaN if unparseable; negative for e.g. 1.2e3) */
  function dp(str) { return parse(str).dp; }

  /** Round to n significant figures (returns a number). */
  function roundSF(x, n) {
    if (!isFinite(x) || x === 0) return x;
    return Number(Number(x).toPrecision(Math.max(1, Math.min(21, n))));
  }

  /**
   * Format to n s.f., keeping trailing zeros ('2.00'). Plain notation for 1e-4 <= |x| < 1e6.
   * @returns {string}
   */
  function formatSF(x, n) {
    if (!isFinite(x)) return String(x);
    n = Math.max(1, Math.min(21, Math.round(n)));
    if (x === 0) return n > 1 ? '0.' + new Array(n).join('0') : '0';
    var r = Number(x.toPrecision(n));
    var a = Math.abs(r);
    if (a >= 1e-4 && a < 1e6) {
      var e = Math.floor(Math.log10(a) + 1e-12);
      var decimals = Math.max(0, n - 1 - e);
      return r.toFixed(Math.min(decimals, 20));
    }
    return r.toExponential(n - 1).replace('e+', 'e');
  }

  /** Format to n decimal places (negative n rounds to tens, hundreds...). */
  function formatDP(x, n) {
    if (!isFinite(x)) return String(x);
    if (n >= 0) return Number(x).toFixed(Math.min(n, 20));
    var f = Math.pow(10, -n);
    return String(Math.round(x / f) * f);
  }

  /**
   * Does the typed string agree with trueValue to within half a unit in its last place
   * (or within relTol × |trueValue|)?
   */
  function agreesWithin(str, trueValue, relTol) {
    var p = parse(str);
    if (!p.ok || !isFinite(trueValue)) return false;
    var halfUnit = 0.5 * Math.pow(10, -p.dp);
    var diff = Math.abs(p.value - trueValue);
    if (diff <= halfUnit * (1 + 1e-9) + 1e-12 * Math.abs(trueValue)) return true;
    return !!relTol && diff <= relTol * Math.abs(trueValue);
  }

  /** Least s.f. among the parseable strings (NaN if none). */
  function leastSF(strs) {
    var best = NaN;
    (strs || []).forEach(function (s) {
      var p = parse(s);
      if (p.ok && (isNaN(best) || p.sf < best)) best = p.sf;
    });
    return best;
  }

  VL.sigfig = {
    parse: parse,
    sf: sf,
    dp: dp,
    roundSF: roundSF,
    formatSF: formatSF,
    formatDP: formatDP,
    agreesWithin: agreesWithin,
    leastSF: leastSF,
    desuperscript: desuperscript
  };
})(globalThis.VLab = globalThis.VLab || {});
