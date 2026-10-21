/**
 * Units, dimensions and Cambridge-style column headings ("quantity / unit").
 *
 * parseUnit('m s⁻²') → { dims: { m: 1, s: -2 }, factor: 1 }
 * parseHeading('T² / s²') → { quantity: 'T²', symbol: 'T^2', unit: {...}, style: 'slash' }
 */
(function (VL) {
  'use strict';

  var BASE = ['kg', 'm', 's', 'A', 'K', 'mol', 'cd'];

  // symbol → definition. dims use base SI; factor converts the unit to SI.
  var UNITS = {
    'm': { dims: { m: 1 }, factor: 1, prefix: true },
    'g': { dims: { kg: 1 }, factor: 1e-3, prefix: true },
    's': { dims: { s: 1 }, factor: 1, prefix: true },
    'A': { dims: { A: 1 }, factor: 1, prefix: true },
    'K': { dims: { K: 1 }, factor: 1, prefix: true },
    'mol': { dims: { mol: 1 }, factor: 1, prefix: true },
    'cd': { dims: { cd: 1 }, factor: 1 },
    'N': { dims: { kg: 1, m: 1, s: -2 }, factor: 1, prefix: true },
    'J': { dims: { kg: 1, m: 2, s: -2 }, factor: 1, prefix: true },
    'W': { dims: { kg: 1, m: 2, s: -3 }, factor: 1, prefix: true },
    'Pa': { dims: { kg: 1, m: -1, s: -2 }, factor: 1, prefix: true },
    'Hz': { dims: { s: -1 }, factor: 1, prefix: true },
    'C': { dims: { A: 1, s: 1 }, factor: 1, prefix: true },
    'V': { dims: { kg: 1, m: 2, s: -3, A: -1 }, factor: 1, prefix: true },
    'Ω': { dims: { kg: 1, m: 2, s: -3, A: -2 }, factor: 1, prefix: true },
    'T': { dims: { kg: 1, s: -2, A: -1 }, factor: 1, prefix: true },
    'eV': { dims: { kg: 1, m: 2, s: -2 }, factor: 1.602176634e-19, prefix: true },
    'L': { dims: { m: 3 }, factor: 1e-3, prefix: true },
    'min': { dims: { s: 1 }, factor: 60 },
    'h': { dims: { s: 1 }, factor: 3600 },
    '°C': { dims: { K: 1 }, factor: 1, offset: 273.15 },
    '°': { dims: {}, factor: Math.PI / 180, angle: true },
    'rad': { dims: {}, factor: 1, angle: true },
    '%': { dims: {}, factor: 0.01 }
  };
  var ALIASES = {
    'ohm': 'Ω', 'ohms': 'Ω', 'Ohm': 'Ω', 'Ohms': 'Ω', 'Ω': 'Ω', 'kohm': 'kΩ', 'Mohm': 'MΩ',
    'degC': '°C', '℃': '°C', 'oC': '°C', 'deg': '°', 'degree': '°', 'degrees': '°', 'º': '°',
    'sec': 's', 'secs': 's', 'l': 'L'
  };
  var PREFIXES = { 'p': 1e-12, 'n': 1e-9, 'µ': 1e-6, 'μ': 1e-6, 'u': 1e-6, 'm': 1e-3, 'c': 1e-2, 'd': 1e-1, 'k': 1e3, 'M': 1e6, 'G': 1e9 };

  var SUP_TO = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '⁺' };
  var SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };

  function desup(s) {
    return VL.sigfig && VL.sigfig.desuperscript ? VL.sigfig.desuperscript(s) : s;
  }
  function supStr(n) {
    return String(n).split('').map(function (c) { return SUP_TO[c] || c; }).join('');
  }
  function addDims(target, dims, power) {
    Object.keys(dims).forEach(function (k) {
      target[k] = (target[k] || 0) + dims[k] * power;
      if (target[k] === 0) delete target[k];
    });
  }

  /** Look up a single unit symbol (with optional prefix). */
  function lookupSymbol(sym) {
    if (ALIASES[sym]) sym = ALIASES[sym];
    if (UNITS[sym]) return { def: UNITS[sym], prefixFactor: 1, name: sym };
    // prefix + symbol (try the longest base symbol first)
    var first = sym.charAt(0), rest = sym.slice(1);
    if (rest && PREFIXES[first] !== undefined) {
      var base = ALIASES[rest] || rest;
      if (UNITS[base] && UNITS[base].prefix) {
        return { def: UNITS[base], prefixFactor: PREFIXES[first], name: (first === 'u' ? 'µ' : first) + base };
      }
    }
    return null;
  }

  /**
   * Parse a unit expression.
   * @param {string} str e.g. 'm s^-2', 'm/s²', 'kg m s-2', 'cm³', 'Ω', '°C', '%'
   */
  function parseUnit(str) {
    var res = { ok: false, dims: {}, factor: 1, str: String(str === undefined || str === null ? '' : str).trim(), canonical: '', angle: false, offset: 0, problems: [] };
    var s = res.str;
    if (!s) { res.problems.push('empty unit'); return res; }
    s = desup(s.replace(/[−–]/g, '-')).replace(/[()]/g, ' ').replace(/[·⋅*]/g, ' ');
    // '.' as a separator only when between letters (m.s-1)
    s = s.replace(/([A-Za-zΩ°µμ])\.(?=[A-Za-zΩ°µμ])/g, '$1 ');
    var segs = s.split('/');
    var tokens = [];
    segs.forEach(function (seg, i) {
      seg.trim().split(/\s+/).filter(Boolean).forEach(function (t) { tokens.push({ t: t, sign: i === 0 ? 1 : -1 }); });
    });
    if (!tokens.length) { res.problems.push('empty unit'); return res; }
    var canon = [], offsetCandidate = null;
    for (var i = 0; i < tokens.length; i++) {
      var m = /^([^\^\d+-]+)(?:\^?([+-]?\d+))?$/.exec(tokens[i].t);
      if (!m) { res.problems.push('cannot read unit "' + tokens[i].t + '"'); return res; }
      var found = lookupSymbol(m[1]);
      if (!found) { res.problems.push('unknown unit "' + m[1] + '"'); return res; }
      var p = (m[2] !== undefined ? parseInt(m[2], 10) : 1) * tokens[i].sign;
      if (p === 0) { res.problems.push('zero power in unit'); return res; }
      addDims(res.dims, found.def.dims, p);
      res.factor *= Math.pow(found.def.factor * found.prefixFactor, p);
      if (found.def.angle) res.angle = true;
      if (found.def.offset) offsetCandidate = { offset: found.def.offset, p: p };
      canon.push(found.name + (p === 1 ? '' : supStr(p)));
    }
    if (offsetCandidate && tokens.length === 1 && offsetCandidate.p === 1) res.offset = offsetCandidate.offset;
    res.canonical = canon.join(' ');
    res.ok = true;
    return res;
  }

  /** Canonical symbol for matching: no spaces, superscripts → ^n, subscripts → _n, unicode minus → '-'. */
  function normalizeSymbol(sym) {
    var s = String(sym === undefined || sym === null ? '' : sym).replace(/[−–]/g, '-');
    s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, function (run) {
      return '_' + run.split('').map(function (c) { return SUB[c]; }).join('');
    });
    s = desup(s);
    return s.replace(/\s+/g, '');
  }

  var COMMON_TAIL_UNITS = /^(s|ms|m|cm|mm|km|kg|g|mg|A|mA|µA|V|mV|kV|Ω|kΩ|ohms?|°C|°|N|Hz|J|W|cm3|cm³|m3|m³|cm\^3|m\^3)$/;

  function splitPlain(s) {
    // 1. a '/' with whitespace on at least one side
    var re = /\s\/|\/\s/g, m;
    while ((m = re.exec(s)) !== null) {
      var idx = s.indexOf('/', m.index);
      var left = s.slice(0, idx).trim(), right = s.slice(idx + 1).trim();
      if (left && !/^[\d.]+$/.test(left) && right && parseUnit(right).ok) {
        return { style: 'slash', quantity: left, unitStr: right };
      }
    }
    // 2. brackets: 'T (s)'
    var b = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(s);
    if (b && parseUnit(b[2]).ok) return { style: 'brackets', quantity: b[1].trim(), unitStr: b[2].trim() };
    // 3. unspaced slash, last one first: 'T/s', '1/u/m^-1'
    for (var i = s.length - 1; i >= 0; i--) {
      if (s[i] !== '/') continue;
      var l = s.slice(0, i).trim(), r = s.slice(i + 1).trim();
      if (l && !/^[\d.]+$/.test(l) && r && parseUnit(r).ok) return { style: 'slash', quantity: l, unitStr: r };
    }
    // 4. badly separated unit: 'T in s', 'T, s', 'T: s', 'T - s', 'T s'
    var bad = /^(.+?)\s*(?:,|:|\s-\s|\s–\s|\sin\s)\s*(\S+)$/.exec(s);
    if (bad && parseUnit(bad[2]).ok) return { style: 'bad', quantity: bad[1].trim(), unitStr: bad[2].trim() };
    var sp = /^(\S{1,3})\s+(\S+)$/.exec(s);
    if (sp && COMMON_TAIL_UNITS.test(sp[2])) return { style: 'bad', quantity: sp[1], unitStr: sp[2] };
    return { style: 'none', quantity: s.trim(), unitStr: '' };
  }

  /**
   * Parse a column heading.
   * @param {string} str e.g. 'L / cm', 'T (s)', 'T² / s²', '1/u / m⁻¹', 'lg (T / s)'
   */
  function parseHeading(str) {
    var s = String(str === undefined || str === null ? '' : str).trim();
    var res = { ok: false, style: 'none', quantity: '', symbol: '', unitStr: '', unit: null, log: null, inner: null, problems: [] };
    if (!s) { res.problems.push('empty heading'); return res; }

    var lg = /^(lg|log10|log|ln)(?=[\s(])\s*(.*)$/i.exec(s);
    if (lg) {
      res.log = lg[1].toLowerCase() === 'ln' ? 'ln' : 'lg';
      if (lg[1].toLowerCase() !== 'lg' && res.log === 'lg') res.problems.push('Cambridge uses "lg" for log₁₀');
      var rest = lg[2].trim(), innerStr = rest, outerUnit = null;
      var br = /^\((.*)\)$/.exec(rest);
      if (br) innerStr = br[1];
      else {
        var outer = splitPlain(rest);
        if (outer.style === 'slash' || outer.style === 'brackets') {
          outerUnit = outer.unitStr;
          res.problems.push('the unit belongs inside the brackets, e.g. ' + res.log + ' (' + outer.quantity + ' / ' + outer.unitStr + ')');
          innerStr = outer.quantity + ' / ' + outer.unitStr;
        }
      }
      var inner = splitPlain(innerStr.trim());
      if (inner.style === 'bad') res.problems.push('separate the quantity from its unit with "/"');
      res.inner = {
        quantity: inner.quantity,
        symbol: normalizeSymbol(inner.quantity),
        unitStr: inner.unitStr,
        unit: inner.unitStr ? parseUnit(inner.unitStr) : null
      };
      if (!inner.unitStr) res.problems.push('unit inside ' + res.log + ' ( ) missing');
      res.quantity = res.log + ' (' + inner.quantity + (inner.unitStr ? ' / ' + inner.unitStr : '') + ')';
      res.symbol = res.log + '(' + res.inner.symbol + ')';
      res.style = 'none';
      res.ok = !!inner.quantity && !outerUnit;
      return res;
    }

    var sp = splitPlain(s);
    res.quantity = sp.quantity;
    res.symbol = normalizeSymbol(sp.quantity);
    res.unitStr = sp.unitStr;
    res.unit = sp.unitStr ? parseUnit(sp.unitStr) : null;
    if (sp.style === 'bad') {
      res.style = 'none';
      res.problems.push('separate the quantity and unit as "quantity / unit", e.g. ' + sp.quantity + ' / ' + sp.unitStr);
      res.ok = false;
      return res;
    }
    res.style = sp.style;
    if (!res.quantity) { res.problems.push('no quantity given'); return res; }
    if (sp.style === 'none') res.problems.push('no unit given');
    res.ok = true;
    return res;
  }

  var PLUS_MINUS = '(?:±|\\+\\s*\\/\\s*-|\\+\\s*-)';
  var LEAD_PM_RE = new RegExp('^' + PLUS_MINUS + '\\s*');
  var BRACKET_PM_RE = new RegExp('^\\(\\s*([^()]+?)\\s*' + PLUS_MINUS + '\\s*([^()]+?)\\s*\\)\\s*(.*)$');
  var INFIX_PM_RE = new RegExp('^(.+?)\\s*' + PLUS_MINUS + '\\s*(.+)$');

  /**
   * Parse an answer such as '9.79 m s^-2', 'g = 9.8 m/s²', '0.52 s2', '12 %'.
   * @param {string} str
   * @param {{allowPlusMinus?: boolean, allowUncertainty?: boolean}} [opts]
   *   allowPlusMinus: accept a leading '±', '+/-' or '+-' (an absolute uncertainty, e.g. '±0.01 cm') → plusMinus: true
   *   allowUncertainty: accept 'x ± Δx unit', '(x ± Δx) unit' and 'x unit ± Δx unit'; the result describes x as
   *   usual (valueStr, num, unit, si) plus uncertainty: { valueStr, num, si } for Δx (si without any offset)
   *   Without these options the behaviour is unchanged ('±0.01 cm' → ok: false).
   */
  function parseValueWithUnit(str, opts) {
    opts = opts || {};
    var raw = String(str === undefined || str === null ? '' : str).trim();
    if (raw.indexOf('=') !== -1) raw = raw.slice(raw.lastIndexOf('=') + 1).trim();
    var plusMinus = false;
    if (opts.allowPlusMinus) {
      var lead = LEAD_PM_RE.exec(raw);
      if (lead) { raw = raw.slice(lead[0].length).trim(); plusMinus = true; }
    }
    if (opts.allowUncertainty) {
      var withU = parseWithUncertainty(raw);
      if (withU) return withU;
    }
    var res = parseValueCore(raw);
    if (plusMinus) res.plusMinus = true;
    return res;
  }

  /** 'x ± Δx unit', '(x ± Δx) unit', 'x unit ± Δx unit' → parse of x with `uncertainty`; null if not that form. */
  function parseWithUncertainty(raw) {
    var valueStr, uncStr;
    var br = BRACKET_PM_RE.exec(raw);
    if (br) {
      valueStr = br[1] + (br[3] ? ' ' + br[3] : '');
      uncStr = br[2] + (br[3] ? ' ' + br[3] : '');
    } else {
      var inf = INFIX_PM_RE.exec(raw);
      if (!inf) return null;
      valueStr = inf[1];
      uncStr = inf[2];
    }
    var x = parseValueCore(valueStr), dx = parseValueCore(uncStr);
    if (!dx.ok) return null;
    if (x.ok && !x.unitStr && dx.unitStr) x = parseValueCore(valueStr + ' ' + dx.unitStr);       // 'x ± Δx unit'
    else if (x.ok && x.unitStr && !dx.unitStr) dx = parseValueCore(uncStr + ' ' + x.unitStr);   // 'x unit ± Δx'
    if (!x.ok || !dx.ok || dx.num.value < 0) return null;
    x.uncertainty = { valueStr: dx.valueStr, num: dx.num, si: dx.unit && dx.unit.ok ? dx.num.value * dx.unit.factor : dx.num.value };
    return x;
  }

  function parseValueCore(raw) {
    raw = String(raw).trim();
    var res = { ok: false, valueStr: '', num: null, unitStr: '', unit: null, si: NaN, problems: [] };
    if (!raw) { res.problems.push('no answer'); return res; }
    var s = desup(raw.replace(/[−–]/g, '-'));
    var m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*[eE][+-]?\d+|\s*[x×*]\s*10\s*\^\s*[+-]?\d+)?)\s*(.*)$/.exec(s);
    if (!m) { res.problems.push('no number found'); return res; }
    res.valueStr = m[1].replace(/\s+/g, '');
    res.num = VL.sigfig ? VL.sigfig.parse(res.valueStr) : { ok: isFinite(Number(res.valueStr)), value: Number(res.valueStr) };
    res.unitStr = m[2].trim();
    if (!res.num.ok) { res.problems.push('number not readable'); return res; }
    if (res.unitStr) {
      res.unit = parseUnit(res.unitStr);
      if (!res.unit.ok) { res.problems.push('unit not recognised: ' + res.unitStr); return res; }
      res.si = res.num.value * res.unit.factor + (res.unit.offset || 0);
    } else {
      res.problems.push('no unit');
      res.si = res.num.value;
    }
    res.ok = true;
    return res;
  }

  /** Equal dimensions? (missing keys count as 0) */
  function dimsEqual(a, b) {
    a = a || {}; b = b || {};
    var keys = {};
    Object.keys(a).forEach(function (k) { keys[k] = 1; });
    Object.keys(b).forEach(function (k) { keys[k] = 1; });
    return Object.keys(keys).every(function (k) { return (a[k] || 0) === (b[k] || 0); });
  }

  /** e.g. { kg: 1, m: 1, s: -2 } → 'kg m s⁻²' ('' for dimensionless) */
  function formatDims(d) {
    d = d || {};
    return BASE.filter(function (k) { return d[k]; })
      .map(function (k) { return k + (d[k] === 1 ? '' : supStr(d[k])); }).join(' ');
  }

  /** Convert a value from one unit to another with the same dimensions (NaN if incompatible). */
  function convert(value, fromUnit, toUnit) {
    var a = typeof fromUnit === 'string' ? parseUnit(fromUnit) : fromUnit;
    var b = typeof toUnit === 'string' ? parseUnit(toUnit) : toUnit;
    if (!a || !b || !a.ok || !b.ok || !dimsEqual(a.dims, b.dims)) return NaN;
    return (value * a.factor + (a.offset || 0) - (b.offset || 0)) / b.factor;
  }

  VL.units = {
    parseUnit: parseUnit,
    parseHeading: parseHeading,
    parseValueWithUnit: parseValueWithUnit,
    dimsEqual: dimsEqual,
    formatDims: formatDims,
    normalizeSymbol: normalizeSymbol,
    convert: convert,
    BASE: BASE
  };
})(globalThis.VLab = globalThis.VLab || {});
