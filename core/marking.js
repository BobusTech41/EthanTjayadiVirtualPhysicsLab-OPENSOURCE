/**
 * Marking engine: rubric runner + library of generic Cambridge Paper 3 mark points (docs/ARCHITECTURE.md §3.11, §7).
 *
 * The marker only ever looks at what the STUDENT produced (table strings exactly as typed, graph, answers) plus the
 * hidden parameters rebuilt from the seed. Calculations are checked with error carried forward: derived values are
 * recomputed from the student's own raw readings, never from the hidden truth.
 *
 *   MarkPoint = { id, part, skill: 'MMO'|'PDO'|'ACE', max, label, check(ctx) -> { awarded, comment, details? } }
 *
 * Public API (VL.marking):
 *   run(exp, question) -> Report
 *   createContext(exp, question, params?) -> ctx              (additive: run() uses it; handy for tests / hints)
 *   identifyColumns(table, quantities) -> { map, unknown, details }
 *   points.<factory>(spec) -> MarkPoint   (limitationsImprovements -> [MarkPoint, MarkPoint])
 *   parseConclusion(text) -> { claim, criteria, differences, unknown, ratioCriteria, mentionsUncertainty }
 *   util -> helpers for experiment authors writing points.custom checks (see bottom of file)
 *
 * Quantity references used by the factories: a quantity id ('T') means the ordinary (non-log) columns of that
 * quantity; 'lg(T)' / 'ln(T)' (or 'lg:T') means its lg / ln columns.
 *
 * Units: every value handed to experiment code is in SI, converted with the unit in the student's own column
 * heading (L / cm → metres). calc() compute functions receive SI values and return SI; quality() tolY is in SI units
 * of the y quantity (lg/ln columns: lg/ln units); range/answerValue/percentUncertainty ranges are SI. Comments
 * quote values back in the student's own units.
 *
 * Spec values documented as "number | fn(ctx)" may be functions of the marking context, so tolerances can depend on
 * the hidden parameters (ctx.params), e.g. range: (ctx) => [0.97 * ctx.params.T, 1.03 * ctx.params.T].
 *
 * Optional, additive Quantity fields understood by identifyColumns:
 *   label   — display name used in comments (default: first symbol, prettified)
 *   unit    — unit string assumed when a heading has no readable unit (default: SI)
 *   meanOf  — id of a raw repeat quantity this derived quantity is the mean of (enables 'mean t / s', 't̄ / s',
 *             '<t> / s' and a third plain 't / s' column holding the means)
 *   symbols — may also contain '/regex/' strings, tested (case-sensitively unless flagged) on the normalised symbol
 *   names   — word forms of the quantity in lower case ('length', 'length of string', 'period^2') or '/regex/'
 *             strings, matched after the symbol stages against the heading quantity in lower case with ² and
 *             ' squared' written as '^2' (also after stripping 'for N oscillations' and repeat markers)
 */
(function (VL) {
  'use strict';

  var SKILLS = ['MMO', 'PDO', 'ACE'];
  var TICK = '✓ ';
  var CROSS = '✗ ';
  var WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  var SUPERS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
  var SUBS = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
  var MACRON = String.fromCharCode(0x304);   // combining bar, as in t̄
  var LG_SLOPE = 0.4343;                      // d(lg x) = 0.4343 dx / x

  /* ================================================================== small helpers */

  function str(v) { return v === undefined || v === null ? '' : String(v); }

  /** Answer value (string or string[]) as one string. */
  function answerText(v) { return Array.isArray(v) ? v.map(str).join('\n') : str(v); }

  /** First non-empty entry of an answer (for value answers given as a list by mistake). */
  function firstAnswer(v) {
    if (!Array.isArray(v)) return str(v).trim();
    for (var i = 0; i < v.length; i++) if (str(v[i]).trim()) return str(v[i]).trim();
    return '';
  }

  /** Spec values may be constants or functions of the marking context. */
  function resolve(v, ctx, extra) { return typeof v === 'function' ? v(ctx, extra) : v; }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function countWord(n) { return n >= 0 && n < WORDS.length ? WORDS[n] : String(n); }
  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }
  function quote(s) { return '“' + s + '”'; }
  function supStr(s) { return String(s).split('').map(function (c) { return SUPERS[c] || c; }).join(''); }
  function subStr(s) { return String(s).split('').map(function (c) { return SUBS[c] || c; }).join(''); }

  /** Number to n s.f. for comments, with a proper minus sign and × 10ⁿ for very large/small values. */
  function fmt(x, n) {
    if (typeof x !== 'number' || !isFinite(x)) return '—';
    n = n || 3;
    var s = VL.sigfig && VL.sigfig.formatSF ? VL.sigfig.formatSF(x, n) : String(Number(x.toPrecision(n)));
    var m = /^(-?[\d.]+)e([+-]?\d+)$/.exec(s);
    if (m) s = m[1] + ' × 10' + supStr(String(parseInt(m[2], 10)));
    return s.replace(/^-/, '−');
  }

  /** Decimal places needed to write x exactly, but no more than 3 s.f. need. */
  function dpFor(x) {
    if (x === 0) return 0;
    var cap = 2 - Math.floor(Math.log10(Math.abs(x)));
    for (var d = Math.min(0, cap); d <= cap; d++) {
      var f = Math.pow(10, d);
      if (Math.abs(Math.round(x * f) / f - x) <= 1e-9 * Math.abs(x)) return d;
    }
    return cap;
  }

  /** 'lo–hi' written with the same number of d.p. at both ends (e.g. 0.01–0.05, 2.30–2.36, 8.83–10.79). */
  function fmtRange(lo, hi) {
    if (!isFinite(lo) || !isFinite(hi)) return fmt(lo) + '–' + fmt(hi);
    var big = Math.max(Math.abs(lo), Math.abs(hi));
    if (big !== 0 && (big >= 1e6 || big < 1e-4)) {
      var n = 3;
      while (n < 6 && fmt(lo, n) === fmt(hi, n)) n++;
      return fmt(lo, n) + '–' + fmt(hi, n);
    }
    var d = Math.max(0, dpFor(lo), dpFor(hi));
    while (d < 12 && lo.toFixed(d) === hi.toFixed(d)) d++;
    return (lo.toFixed(d) + '–' + hi.toFixed(d)).replace(/-/g, '−');
  }

  /** A number as a person would write it: up to 3 s.f., no trailing zeros (2 → '2', 2.50 → '2.5'). */
  function fmtPlain(x) {
    if (typeof x !== 'number' || !isFinite(x)) return '—';
    return String(Number(x.toPrecision(3))).replace(/^-/, '−');
  }

  /** Answer key as a symbol: 'k1' → 'k₁', 'T_2' → 'T₂', 'dd' unchanged. */
  function prettyKey(k) {
    var m = /^([A-Za-z\u0370-\u03ff]+)_?(\d+)$/.exec(str(k));
    return m ? m[1] + subStr(m[2]) : prettySymbol(k);
  }

  /** 'row 3' / 'rows 2 and 5' / 'rows 1, 2 and 6'. */
  function listRows(nums) {
    if (!nums.length) return '';
    if (nums.length === 1) return 'row ' + nums[0];
    return 'rows ' + nums.slice(0, -1).join(', ') + ' and ' + nums[nums.length - 1];
  }

  /** 'T^2' → 'T²', 't_1' → 't₁'. */
  function prettySymbol(sym) {
    return str(sym).replace(/\^\(?(-?\d+)\)?/g, function (m, d) { return supStr(d); })
      .replace(/_(\d+)/g, function (m, d) { return subStr(d); });
  }

  function formatDims(dims) {
    return VL.units && VL.units.formatDims ? VL.units.formatDims(dims || {}) : '';
  }

  function dimsEqual(a, b) {
    return VL.units && VL.units.dimsEqual ? VL.units.dimsEqual(a || {}, b || {}) : false;
  }

  function isDimensionless(dims) { return !!dims && Object.keys(dims).length === 0; }

  function parseNum(s) {
    if (VL.sigfig && VL.sigfig.parse) return VL.sigfig.parse(str(s));
    var v = Number(str(s).trim());
    return { ok: str(s).trim() !== '' && isFinite(v), value: v, sf: NaN, dp: NaN, str: str(s).trim(), problems: [] };
  }

  /** VL.units.parseValueWithUnit; opts: { allowPlusMinus, allowUncertainty } (see core/units.js). */
  function parseVU(s, opts) {
    if (VL.units && VL.units.parseValueWithUnit) return VL.units.parseValueWithUnit(str(s), opts);
    var n = parseNum(s);
    return { ok: n.ok, valueStr: n.str, num: n, unitStr: '', unit: null, si: n.value, problems: n.ok ? ['no unit'] : ['no number found'] };
  }

  function parseUnitStr(s) {
    return VL.units && VL.units.parseUnit ? VL.units.parseUnit(s) : { ok: false, dims: {}, factor: 1, offset: 0 };
  }

  function agrees(s, value, relTol) {
    return !!(VL.sigfig && VL.sigfig.agreesWithin && VL.sigfig.agreesWithin(s, value, relTol));
  }

  /** Smallest number of d.p. (may be negative) that writes a resolution exactly: 0.1 → 1, 0.02 → 2, 10 → −1. */
  function requiredDp(res) {
    if (!(res > 0) || !isFinite(res)) return NaN;
    for (var d = -6; d <= 12; d++) {
      var v = res * Math.pow(10, d);
      if (v >= 1 - 1e-9 && Math.abs(v - Math.round(v)) < 1e-6 * Math.max(1, v)) return d;
    }
    return NaN;
  }

  function asArray(v) {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
  }

  function mean(a) {
    var n = a.filter(function (x) { return typeof x === 'number' && isFinite(x); });
    return n.length ? n.reduce(function (s, x) { return s + x; }, 0) / n.length : NaN;
  }

  function linearFit(xs, ys) {
    if (VL.stats && VL.stats.linearFit) return VL.stats.linearFit(xs, ys);
    var n = xs.length, mx = mean(xs), my = mean(ys), sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
    if (n < 2 || sxx === 0) return { m: NaN, c: NaN, n: n };
    return { m: sxy / sxx, c: my - sxy / sxx * mx, n: n };
  }

  function result(awarded, comment, details) {
    return { awarded: awarded, comment: str(comment).replace(/\.\.$/, '.'), details: details || null };
  }

  /* ================================================================== quantities and columns */

  function normSym(s) {
    return VL.units && VL.units.normalizeSymbol ? VL.units.normalizeSymbol(s) : str(s).replace(/\s+/g, '');
  }

  function isRegexStr(s) { return typeof s === 'string' && /^\/.+\/[a-z]*$/.test(s); }

  var reCache = {};
  function toRe(s) {
    if (s instanceof RegExp) return s;
    if (reCache[s] !== undefined) return reCache[s];
    var m = /^\/(.+)\/([a-z]*)$/.exec(s), re = null;
    if (m) { try { re = new RegExp(m[1], m[2].replace(/[gy]/g, '')); } catch (e) { re = null; } }
    reCache[s] = re;
    return re;
  }

  function symbolsOf(q) { return (q.symbols && q.symbols.length ? q.symbols : [q.id]); }

  function exactMatch(sym, q) {
    return symbolsOf(q).some(function (s) { return !(s instanceof RegExp) && !isRegexStr(s) && normSym(s) === sym; });
  }

  function patternMatch(sym, q) {
    return symbolsOf(q).some(function (s) {
      var re = (s instanceof RegExp || isRegexStr(s)) ? toRe(s) : null;
      return !!re && re.test(sym);
    });
  }

  function caseInsensitiveMatch(sym, q) {
    if (sym.length < 3) return false;
    var low = sym.toLowerCase();
    return symbolsOf(q).some(function (s) {
      return !(s instanceof RegExp) && !isRegexStr(s) && normSym(s).toLowerCase() === low;
    });
  }

  /** 't_1' → 't', 't1' → 't', 't(2)' → 't', '20T_1' → '20T'; null when there is no repeat index. */
  function stripIndex(sym) {
    var m = /^(.*[^\^_\d(-])(?:_?\d+|\(\d+\)|_\(\d+\))$/.exec(sym);
    return m && /[A-Za-z\u0370-\u03ff]/.test(m[1]) ? m[1] : null;
  }

  /** If a heading quantity denotes a mean ('mean t', 'average t', 't̄', '<t>', 't_mean', 't_av'), its base symbol. */
  function meanBase(text) {
    var t = str(text).trim(), had = false;
    if (t.indexOf(MACRON) >= 0) { t = t.split(MACRON).join(''); had = true; }
    var br = /^[<⟨](.+)[>⟩]$/.exec(t);
    if (br) { t = br[1]; had = true; }
    var words = /\b(mean|average|avg|ave|av)\b/i;
    if (words.test(t)) { t = t.replace(/\b(mean|average|avg|ave|av)\b(\s+of)?/gi, ' '); had = true; }
    var suf = /[_\s](mean|average|avg|ave|av)$/i;
    if (suf.test(t)) { t = t.replace(suf, ''); had = true; }
    t = t.trim();
    return had && t ? normSym(t) : null;
  }

  /** Does a heading unit suit a quantity? null when the quantity declares no dims. */
  function dimsOkFor(q, unit) {
    if (!q || !q.dims) return null;
    if (isDimensionless(q.dims)) return !unit || (unit.ok && dimsEqual(unit.dims, {}));
    return !!(unit && unit.ok && dimsEqual(unit.dims, q.dims));
  }

  /* --- word headings ('length / cm', 'time for 20 oscillations / s', 'period T / s', 'T squared / s²') --- */

  var SUB_DIGITS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
  /** Trailing 'for 20 oscillations', 'for n complete swings', 'for one oscillation' ... */
  var FOR_OSC_RE = /\s+for\s+(?:\d+|n|one|ten|twenty)\s+(?:complete\s+)?(?:oscillations?|swings?)$/i;
  /** Leading repeat marker: '1st t', 'second t'. */
  var LEAD_REPEAT_RE = /^(?:1st|2nd|3rd|first|second|third)\s+/i;
  /** Trailing repeat marker: 't1', 't 1', 't_1', 't(1)', 't_(1)' (not '^2'). */
  var TRAIL_REPEAT_RE = /^(.*[^\^_\d(\s-])\s*(?:_?\d+|\(\d+\)|_\(\d+\))$/;
  /** Words ignored when single tokens of a heading are tried as symbols ('Length L', 'time t₁', 'period T'). */
  var FILLER_RE = /^(the|of|for|a|an|time|length|period|mean|average|squared|string|pendulum|oscillations?|swings?|\d+(\.\d+)?)$/;

  /** Word form of a heading quantity for comparison with Quantity.names: lower case, ² and ' squared' → '^2'. */
  function normName(s) {
    return str(s).replace(/[−–]/g, '-').replace(/²/g, '^2').replace(/\s+squared\b/gi, '^2')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** Does a normalised word form match one of the quantity's `names` (plain word forms or '/regex/' strings)? */
  function nameMatch(text, q) {
    if (!text || !Array.isArray(q.names)) return false;
    return q.names.some(function (n) {
      if (n instanceof RegExp || isRegexStr(n)) {
        var re = toRe(n);
        return !!re && re.test(text);
      }
      return normName(n) === text;
    });
  }

  /**
   * Forms of a heading quantity used by the 'name' stage of matchQuantity.
   * @returns {{unstripped: string, low: string, sym: string, marker: boolean}}
   *   unstripped: normalised word form before stripping; low / sym: after stripping a 'for N oscillations' phrase
   *   and a repeat marker (lower case / case-preserved symbol); marker: a repeat marker was stripped
   */
  function nameForms(qText) {
    var t = str(qText).replace(/[−–]/g, '-').replace(/²/g, '^2').replace(/\s+squared\b/gi, '^2')
      .replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, function (run) {
        return '_' + run.split('').map(function (c) { return SUB_DIGITS[c]; }).join('');
      })
      .replace(/\s+/g, ' ').trim();
    var unstripped = normName(qText);
    var s = t.replace(FOR_OSC_RE, '').trim(), marker = false;
    var lead = LEAD_REPEAT_RE.exec(s);
    if (lead) { s = s.slice(lead[0].length); marker = true; }
    var trail = TRAIL_REPEAT_RE.exec(s);
    if (trail && /[A-Za-zͰ-Ͽ]/.test(trail[1])) { s = trail[1]; marker = true; }
    s = s.replace(/\s+/g, ' ').trim();
    return { unstripped: unstripped, low: s.toLowerCase(), sym: normSym(s), marker: marker };
  }

  /** Quantities matching one heading token as a symbol: exact, then /regex/, then with a repeat index stripped. */
  function tokenCandidates(tok, quantities) {
    var sym = normSym(tok);
    if (!sym) return [];
    var c = quantities.filter(function (q) { return exactMatch(sym, q); });
    if (!c.length) c = quantities.filter(function (q) { return patternMatch(sym, q); });
    if (!c.length) {
      var base = stripIndex(sym);
      if (base) c = quantities.filter(function (q) { return q.repeat && (exactMatch(base, q) || patternMatch(base, q)); });
    }
    return c;
  }

  /**
   * Find the quantity a (normalised) heading symbol refers to.
   * Stages: exact symbol → /regex/ symbol → repeat index stripped (raw repeat quantities only) → mean of a raw
   * repeat quantity (quantity with meanOf) → case-insensitive for symbols of 3+ characters → 'name' (word forms:
   * Quantity.names, also after stripping 'for N oscillations' and repeat markers such as '1st' or '₁') → 'token'
   * (single words of the heading tried as symbols, e.g. 'Length L', 'time t₁', 'period T'; tokens pointing to
   * different quantities give no match). Within a stage a quantity whose dims match the heading unit is preferred.
   * @returns {{q:object, via:string}|null}
   */
  function matchQuantity(sym, unit, qText, quantities) {
    if (!sym) return null;
    var stages = [
      ['symbol', function () { return quantities.filter(function (q) { return exactMatch(sym, q); }); }],
      ['pattern', function () { return quantities.filter(function (q) { return patternMatch(sym, q); }); }],
      ['repeat', function () {
        var base = stripIndex(sym);
        return base ? quantities.filter(function (q) { return q.repeat && (exactMatch(base, q) || patternMatch(base, q)); }) : [];
      }],
      ['mean', function () {
        var base = meanBase(qText);
        if (!base) return [];
        var raws = quantities.filter(function (q) {
          return exactMatch(base, q) || patternMatch(base, q) || (q.repeat && stripIndex(base) && exactMatch(stripIndex(base), q));
        });
        return quantities.filter(function (q) {
          return q.meanOf && raws.some(function (r) { return r.id === q.meanOf; });
        });
      }],
      ['case', function () { return quantities.filter(function (q) { return caseInsensitiveMatch(sym, q); }); }],
      ['name', function () {
        var nf = nameForms(qText);
        var c = quantities.filter(function (q) { return nameMatch(nf.unstripped, q); });
        if (c.length) return c;
        // a repeat marker ('1st', '₁', '(2)') only suits a raw quantity that is repeated
        var pool = nf.marker ? quantities.filter(function (q) { return q.repeat; }) : quantities;
        c = pool.filter(function (q) { return exactMatch(nf.sym, q); });
        if (!c.length) c = pool.filter(function (q) { return patternMatch(nf.sym, q); });
        if (!c.length) c = pool.filter(function (q) { return nameMatch(nf.low, q); });
        return c;
      }],
      ['token', function () {
        var toks = str(qText).split(/\s+/).map(function (t) { return t.replace(/^[,;:]+|[,;:]+$/g, ''); })
          .filter(function (t) { return t && !FILLER_RE.test(t.toLowerCase()); });
        var found = null, ids = {};
        for (var k = toks.length - 1; k >= 0; k--) {        // the last token is preferred
          var c = tokenCandidates(toks[k], quantities);
          if (!c.length) continue;
          var good = c.filter(function (q) { return dimsOkFor(q, unit) === true; });
          var q = good.length ? good[0] : c[0];
          ids[q.id] = true;
          if (!found) found = q;
        }
        return found && Object.keys(ids).length === 1 ? [found] : [];
      }]
    ];
    for (var i = 0; i < stages.length; i++) {
      var cands = stages[i][1]();
      if (!cands.length) continue;
      var good = cands.filter(function (q) { return dimsOkFor(q, unit) === true; });
      return { q: good.length ? good[0] : cands[0], via: stages[i][0] };
    }
    return null;
  }

  function fallbackFactor(q) {
    if (q && q.unit) {
      var u = parseUnitStr(q.unit);
      if (u.ok) return { factor: u.factor, offset: u.offset || 0 };
    }
    return { factor: 1, offset: 0 };
  }

  function cellOf(row, colId) {
    var v = row && row.cells ? row.cells[colId] : undefined;
    return v === undefined || v === null ? '' : String(v);
  }

  /**
   * Work out which table column holds which quantity.
   * Matches the normalised heading symbol (case-sensitive) and checks the unit's dimensions; a raw quantity with
   * repeat:true may map to several columns ('t₁ / s', 't₂ / s'); 'lg (T / s)' maps to T with log 'lg' (unless a
   * quantity lists the symbol 'lg(T)' itself). Unmatched columns are reported in `unknown`, never fatal.
   * @param {object} table
   * @param {Array<{id, symbols, dims, kind, repeat?, label?, unit?, meanOf?}>} quantities
   * @returns {{map: Object<string,string[]>, unknown: string[], details: Object<string,object>}}
   *   details[colId] = { heading, parsed, qId, log: null|'lg'|'ln', headingLog, symbol, unit, dimsOk, factor,
   *                      offset, via, hasData }
   */
  function identifyColumns(table, quantities) {
    quantities = Array.isArray(quantities) ? quantities.filter(function (q) { return q && q.id; }) : [];
    var res = { map: {}, unknown: [], details: {} };
    quantities.forEach(function (q) { res.map[q.id] = []; });
    var columns = table && Array.isArray(table.columns) ? table.columns : [];
    var rows = table && Array.isArray(table.rows) ? table.rows : [];

    columns.forEach(function (col) {
      var heading = str(col.heading).trim();
      var hasData = rows.some(function (r) { return cellOf(r, col.id).trim() !== ''; });
      var d = { heading: heading, parsed: null, qId: null, log: null, headingLog: null, symbol: '', unit: null,
        dimsOk: null, factor: 1, offset: 0, via: null, hasData: hasData };
      res.details[col.id] = d;
      if (!heading) {
        if (hasData) res.unknown.push(col.id);
        return;
      }
      var h = VL.units && VL.units.parseHeading ? VL.units.parseHeading(heading)
        : { ok: true, quantity: heading, symbol: normSym(heading), unit: null, log: null, inner: null, problems: [] };
      d.parsed = h;
      d.headingLog = h.log || null;
      var found = null, unit = h.unit, log = null;
      if (h.log && h.inner) {
        // a quantity defined as the logarithm itself ('lg(T)') wins; otherwise map to the inner quantity
        found = matchQuantity(h.symbol, null, h.quantity, quantities.filter(function (q) { return exactMatch(h.symbol, q); }));
        if (found) {
          unit = null;
        } else {
          found = matchQuantity(h.inner.symbol, h.inner.unit, h.inner.quantity, quantities);
          unit = h.inner.unit;
          log = h.log;
        }
        d.symbol = found && !log ? h.symbol : h.inner.symbol;
      } else {
        d.symbol = h.symbol;
        found = matchQuantity(h.symbol, h.unit, h.quantity, quantities);
      }
      d.unit = unit && unit.ok ? unit : null;
      if (!found) {
        res.unknown.push(col.id);
        if (d.unit) { d.factor = d.unit.factor; d.offset = d.unit.offset || 0; }
        return;
      }
      d.qId = found.q.id;
      d.via = found.via;
      d.log = log;
      d.dimsOk = log || !h.log ? dimsOkFor(found.q, unit) : true;
      // a unit with the wrong dimensions cannot be used to convert the values: fall back to the quantity's unit
      var f = d.unit && d.dimsOk !== false ? { factor: d.unit.factor, offset: d.unit.offset || 0 } : fallbackFactor(found.q);
      d.factor = f.factor;
      d.offset = f.offset;
      res.map[found.q.id].push(col.id);
    });

    // A third plain 't / s' column after 't₁ / s', 't₂ / s' usually holds the means: move it to the mean quantity
    quantities.forEach(function (Q) {
      if (!Q.meanOf || !res.map[Q.id] || res.map[Q.id].length || !res.map[Q.meanOf]) return;
      var raw = res.map[Q.meanOf].filter(function (c) { return !res.details[c].log; });
      if (raw.length < 3) return;
      var cand = null;
      for (var i = raw.length - 1; i >= 0; i--) {
        if (!stripIndex(res.details[raw[i]].symbol)) { cand = raw[i]; break; }
      }
      if (!cand) return;
      var others = raw.filter(function (c) { return c !== cand; });
      var checked = 0, ok = true;
      rows.forEach(function (r) {
        var p = parseNum(cellOf(r, cand));
        if (!p.ok) return;
        var vals = others.map(function (c) { return parseNum(cellOf(r, c)); }).filter(function (x) { return x.ok; })
          .map(function (x) { return x.value; });
        if (vals.length < 2) return;
        checked++;
        if (!agrees(p.str, mean(vals), 0.005)) ok = false;
      });
      if (checked && ok) {
        res.map[Q.meanOf] = others.concat(res.map[Q.meanOf].filter(function (c) { return raw.indexOf(c) < 0; }));
        res.map[Q.id].push(cand);
        res.details[cand].qId = Q.id;
        res.details[cand].via = 'mean';
        res.details[cand].dimsOk = dimsOkFor(Q, res.details[cand].unit);
      }
    });
    // keep table order inside each list
    var order = {};
    columns.forEach(function (c, i) { order[c.id] = i; });
    Object.keys(res.map).forEach(function (k) {
      res.map[k].sort(function (a, b) { return order[a] - order[b]; });
    });
    return res;
  }

  /* ================================================================== context helpers */

  /** 'T' → { id: 'T', log: null }; 'lg(T)' / 'lg:T' / 'ln (θ)' → { id, log }. */
  function parseRef(ref) {
    var m = /^(lg|ln)\s*(?:\(\s*(.+?)\s*\)|:\s*(.+))$/.exec(str(ref).trim());
    return m ? { id: m[2] || m[3], log: m[1] } : { id: str(ref), log: null };
  }

  function quantityOf(ctx, id) {
    var qs = ctx.quantities || [];
    for (var i = 0; i < qs.length; i++) if (qs[i].id === id) return qs[i];
    return null;
  }

  /** Display name of a quantity reference for comments: label, else prettified first symbol. */
  function nameOf(ctx, ref) {
    var r = parseRef(ref);
    var q = quantityOf(ctx, r.id);
    var base = q ? (q.label || q.name || prettySymbol(symbolsOf(q).filter(function (s) {
      return typeof s === 'string' && !isRegexStr(s);
    })[0] || q.id))
      : prettySymbol(r.id);
    return r.log ? r.log + ' ' + base : base;
  }

  /** Columns holding a quantity reference (log flag must match). */
  function colsOf(ctx, ref) {
    var r = parseRef(ref);
    var info = ctx.colInfo || { map: {}, details: {} };
    return (info.map[r.id] || []).filter(function (c) {
      var d = info.details[c];
      return (d && d.log ? d.log : null) === r.log;
    });
  }

  function detailOf(ctx, colId) {
    return (ctx.colInfo && ctx.colInfo.details[colId]) || { factor: 1, offset: 0, log: null };
  }

  /** Value of a parsed cell in SI (log columns: the lg/ln value itself). */
  function cellSI(ctx, colId, num) {
    if (!num || !num.ok) return NaN;
    var d = detailOf(ctx, colId);
    if (d.log) return num.value;
    return num.value * (d.factor || 1) + (d.offset || 0);
  }

  /**
   * Unit of a column's values for comments: the student's unit when it suits the quantity; otherwise the unit the
   * values were taken to be in (the quantity's `unit`, or SI when the heading's unit had the wrong dimensions);
   * '' for a heading without a unit or an lg/ln column.
   */
  function unitTextOf(ctx, colId, ref) {
    var d = detailOf(ctx, colId);
    if (d.log) return '';
    var q = d.qId ? quantityOf(ctx, d.qId) : (ref ? quantityOf(ctx, parseRef(ref).id) : null);
    if (d.unit && d.unit.ok && d.dimsOk !== false) return d.unit.canonical || (d.parsed && d.parsed.unitStr) || '';
    if (q && q.unit) return q.unit;
    // a heading unit with the wrong dimensions (or unreadable): the values were converted as SI (fallbackFactor),
    // so describe them in the SI unit, not in the quantity's unitHint ('cm or m')
    if (d.unit && q && q.dims) return formatDims(q.dims);
    return '';
  }

  var DIMS_WORDS = { m: 'a length', s: 'a time', kg: 'a mass', K: 'a temperature', A: 'a current' };

  /**
   * ' (the unit in the heading is not a length, so the values were taken to be in m)' when the column's heading
   * unit could not be used to convert its values; '' otherwise.
   */
  function wrongUnitNote(ctx, colId, ref) {
    var d = detailOf(ctx, colId);
    if (d.log || !d.unit || (d.unit.ok && d.dimsOk !== false)) return '';
    var q = d.qId ? quantityOf(ctx, d.qId) : (ref ? quantityOf(ctx, parseRef(ref).id) : null);
    if (!q || !q.dims) return '';
    var keys = Object.keys(q.dims);
    var what = keys.length === 1 && q.dims[keys[0]] === 1 && DIMS_WORDS[keys[0]] ? DIMS_WORDS[keys[0]] : 'a unit of ' + nameOf(ctx, q.id);
    return ' (the unit in the heading is not ' + what + ', so the values were taken to be in ' + unitTextOf(ctx, colId, ref) + ')';
  }

  function rowsOf(ctx) { return ctx.table && Array.isArray(ctx.table.rows) ? ctx.table.rows : []; }

  function rowNumberOf(ctx, rowId) {
    var rows = rowsOf(ctx);
    for (var i = 0; i < rows.length; i++) if (rows[i].id === rowId) return i + 1;
    return 0;
  }

  /**
   * Non-empty cells of a quantity reference: [{ rowId, rowNumber, colId, str, num, si }] in row order.
   */
  function valuesOf(ctx, ref) {
    var cols = colsOf(ctx, ref), out = [];
    rowsOf(ctx).forEach(function (row, i) {
      cols.forEach(function (c) {
        var s = cellOf(row, c).trim();
        if (!s) return;
        var num = parseNum(s);
        out.push({ rowId: row.id, rowNumber: i + 1, colId: c, str: s, num: num, si: cellSI(ctx, c, num) });
      });
    });
    return out;
  }

  /** Cells of a quantity reference in one row (non-empty only). */
  function cellsInRow(ctx, row, ref) {
    return colsOf(ctx, ref).map(function (c) {
      var s = cellOf(row, c).trim();
      if (!s) return null;
      var num = parseNum(s);
      return { colId: c, str: s, num: num, si: cellSI(ctx, c, num) };
    }).filter(Boolean);
  }

  /**
   * Values of every identified quantity in one row (SI; repeat columns averaged), for calc() compute functions.
   * rowValues[qId] = mean SI value (undefined if none); rowValues._all[qId] = [SI values];
   * rowValues._str[qId] = [strings]; rowValues._log['lg(T)'] = value; rowValues._row, _rowNumber.
   */
  function rowValues(ctx, row) {
    var rv = { _all: {}, _str: {}, _log: {}, _row: row, _rowNumber: rowNumberOf(ctx, row.id) };
    (ctx.quantities || []).forEach(function (q) {
      var cells = cellsInRow(ctx, row, q.id).filter(function (c) { return c.num.ok; });
      rv._all[q.id] = cells.map(function (c) { return c.si; });
      rv._str[q.id] = cells.map(function (c) { return c.str; });
      rv[q.id] = cells.length ? mean(rv._all[q.id]) : undefined;
      ['lg', 'ln'].forEach(function (lg) {
        var lc = cellsInRow(ctx, row, lg + '(' + q.id + ')').filter(function (c) { return c.num.ok; });
        if (lc.length) rv._log[lg + '(' + q.id + ')'] = lc[0].si;
      });
    });
    return rv;
  }

  /** An example heading for a quantity, e.g. 'L / cm' (first unit of unitHint, else unit, else SI). */
  function exampleHeading(ctx, q) {
    if (!q) return '';
    var hint = str(q.unitHint).split(/\s+or\s+|,\s*/)[0].trim();
    var unit = hint || q.unit || formatDims(q.dims);
    return nameOf(ctx, q.id) + (unit ? ' / ' + unit : '');
  }

  /**
   * Note naming the table columns that hold values but whose heading matched no quantity ('' if there are none).
   * The example heading is for `ref` when given, else for a quantity whose dims suit the first such column's unit
   * (one with no column yet preferred), else for the first quantity.
   */
  function unknownColumnsNote(ctx, ref) {
    var info = ctx.colInfo || { unknown: [], details: {} };
    var cols = (info.unknown || []).filter(function (c) {
      var d = info.details[c];
      return d && d.hasData && d.heading;
    });
    if (!cols.length) return '';
    var heads = cols.map(function (c) { return quote(info.details[c].heading); });
    var unit = info.details[cols[0]].unit;
    var qs = ctx.quantities || [];
    var q = ref ? quantityOf(ctx, parseRef(ref).id) : null;
    if (!q && unit) {
      var suits = qs.filter(function (x) { return x.dims && !isDimensionless(x.dims) && dimsEqual(x.dims, unit.dims); });
      q = suits.filter(function (x) { return !(info.map && info.map[x.id] && info.map[x.id].length); })[0] || suits[0];
    }
    if (!q) q = qs[0];
    var ex = exampleHeading(ctx, q);
    var many = cols.length > 1;
    return ' The column' + (many ? 's' : '') + ' headed ' +
      (many ? heads.slice(0, -1).join(', ') + ' and ' + heads[heads.length - 1] : heads[0]) +
      ' could not be matched to ' + (many ? 'quantities' : 'a quantity') + ' in this experiment, so ' +
      (many ? 'they were' : 'it was') + ' not marked; use the symbol from the question' + (ex ? ', e.g. ' + ex : '') + '.';
  }

  function hasGraphContent(g) {
    return !!g && ((g.points && g.points.length) || g.line || (g.x && (g.x.colId || str(g.x.label).trim())) ||
      (g.y && (g.y.colId || str(g.y.label).trim())));
  }

  /* ================================================================== mark-point construction */

  /**
   * Build a MarkPoint from a factory spec (spec overrides the defaults).
   */
  function makePoint(spec, defaults, impl) {
    spec = spec || {};
    var point = {
      id: spec.id || defaults.id,
      part: spec.part,
      skill: spec.skill || defaults.skill,
      max: spec.max !== undefined ? spec.max : (defaults.max !== undefined ? defaults.max : 1),
      label: spec.label || defaults.label,
      /** @param {object} ctx marking context @returns {{awarded:number, comment:string, details:*}} */
      check: function (ctx) { return impl.call(point, ctx); }
    };
    return point;
  }

  /* ------------------------------------------------------------------ answerValue */

  /**
   * A single value answer with a unit, e.g. d = 2.34 cm or g = 9.79 m s⁻².
   * spec: { key, name?, dims?, range? ([lo, hi] SI or fn(ctx)), requireUnit = true, sf? ([min, max]),
   *         dpOf? (instrument resolution in SI, number | number[] | fn(ctx)), assumeUnit? (unit string used when
   *         no unit is typed and requireUnit is false), unitHint? (e.g. 'm s⁻²'),
   *         reject? (fn(ctx, { si, vu, raw }) -> string|null: an experiment-specific objection to the value, e.g. a
   *         vernier reading that was not corrected for the zero error; a returned string is added to the problems
   *         and the mark is withheld. Called only when the unit is acceptable, so si is meaningful) }
   * Values written 'x ± Δx unit' are marked as x.
   */
  function answerValue(spec) {
    var name = spec.name || prettyKey(spec.key);
    return makePoint(spec, { id: 'value-' + spec.key, skill: 'ACE', label: 'Value of ' + name }, function (ctx) {
      var raw = firstAnswer(ctx.answer(spec.key));
      if (!raw) return result(0, CROSS + 'No value given for ' + name + '.');
      var vu = parseVU(raw, { allowUncertainty: true });   // 'x ± Δx unit' is marked as x (Δx is ignored)
      if (!vu.ok) {
        var bad = vu.problems.filter(function (p) { return /unit not recognised/.test(p); })[0];
        return result(0, CROSS + (bad ? quote(raw) + ': ' + bad + '.' : quote(raw) + ' could not be read as a number with a unit.'), { parsed: vu });
      }
      var dims = resolve(spec.dims, ctx);
      var requireUnit = spec.requireUnit !== false;
      var problems = [], good = [];
      var hasUnit = !!vu.unitStr && vu.unit && vu.unit.ok;
      var factor = 1, offset = 0;
      if (hasUnit) {
        factor = vu.unit.factor; offset = vu.unit.offset || 0;
        if (dims && !dimsEqual(vu.unit.dims, dims)) {
          problems.push('the unit ' + (vu.unit.canonical || vu.unitStr) + ' is not a unit of ' + name + ' (expected ' +
            (spec.unitHint || formatDims(dims) || 'no unit') + ')');
        } else if (dims) good.push('correct unit');
      } else if (requireUnit && !(dims && isDimensionless(dims))) {
        problems.push('no unit given');
      } else if (spec.assumeUnit) {
        var au = parseUnitStr(spec.assumeUnit);
        if (au.ok) { factor = au.factor; offset = au.offset || 0; }
      }
      var si = vu.num.value * factor + offset;
      var unitShown = hasUnit ? (vu.unit.canonical || vu.unitStr) : (spec.assumeUnit || formatDims(dims));
      var unitOk = !problems.length;
      var range = resolve(spec.range, ctx);
      if (range && unitOk) {
        var lo = Math.min(range[0], range[1]), hi = Math.max(range[0], range[1]);
        if (!(si >= lo * (1 - 1e-12) - 1e-15 && si <= hi * (1 + 1e-12) + 1e-15) && !(si >= lo && si <= hi)) {
          problems.push('not within the accepted range (' + fmtRange((lo - offset) / factor, (hi - offset) / factor) +
            (unitShown ? ' ' + unitShown : '') + ')');
        } else good.push('value within the accepted range');
      }
      var sfr = resolve(spec.sf, ctx);
      if (sfr) {
        var lo2 = sfr[0], hi2 = sfr[1] === undefined ? sfr[0] : sfr[1];
        var okSf = false;
        for (var s = vu.num.sfMin || vu.num.sf; s <= vu.num.sf; s++) if (s >= lo2 && s <= hi2) okSf = true;
        if (!okSf) {
          problems.push('give ' + name + ' to ' + (lo2 === hi2 ? lo2 : lo2 + ' or ' + hi2) + ' s.f. (you gave ' +
            vu.num.sf + ' s.f.)');
        } else good.push(vu.num.sf + ' s.f.');
      }
      var dpOf = asArray(resolve(spec.dpOf, ctx));
      if (dpOf.length && unitOk) {
        var allowed = dpOf.map(function (r) { return requiredDp(r / factor); });
        if (allowed.indexOf(vu.num.dp) < 0) {
          var resU = dpOf[0] / factor;
          problems.push(name + ' should be recorded to ' + fmt(resU, 2) + (unitShown ? ' ' + unitShown : '') +
            ' (the resolution of the instrument), i.e. to ' + allowed[0] + ' d.p.' + (unitShown ? ' in ' + unitShown : ''));
        } else good.push('recorded to the resolution of the instrument');
      }
      if (typeof spec.reject === 'function' && unitOk) {
        var objection = spec.reject(ctx, { si: si, vu: vu, raw: raw });
        if (objection) problems.push(String(objection));
      }
      var details = { value: raw, si: si, unit: vu.unitStr, range: range || null };
      if (problems.length) return result(0, CROSS + name + ' = ' + raw + ': ' + problems.join('; ') + '.', details);
      return result(this.max, TICK + name + ' = ' + raw + (good.length ? ': ' + good.join(', ') : '') + '.', details);
    });
  }

  /* ------------------------------------------------------------------ readingsCount */

  /**
   * Number of sets of readings and their trend: full sets → max, each missing set −1, wrong trend → 0.
   * spec: { xQ, yQs = [], full = 6, max = 3, trend: 'increasing'|'decreasing'|fn(sets, ctx) -> bool, trendQ }
   * Each entry of yQs is a quantity reference, or an array of alternatives of which any one completes the set
   * (e.g. [['t', 'T']]: raw times or periods).
   */
  function readingsCount(spec) {
    var full = spec.full || 6;
    var yQs = asArray(spec.yQs);
    return makePoint(spec, { id: 'readings', skill: 'MMO', max: 3, label: cap(countWord(full)) + ' sets of readings' }, function (ctx) {
      var max = this.max;
      var xName = nameOf(ctx, spec.xQ);
      if (!colsOf(ctx, spec.xQ).length) {
        return result(0, CROSS + 'No column of ' + xName + ' found in the table, so no sets of readings can be counted (0 of ' + max + ').' +
          unknownColumnsNote(ctx, spec.xQ));
      }
      function numericIn(row, ref) { return cellsInRow(ctx, row, ref).filter(function (c) { return c.num.ok; }); }
      /** The first alternative of a yQs entry having a number in this row (or null). */
      function presentRef(row, entry) {
        var alts = asArray(entry);
        for (var k = 0; k < alts.length; k++) if (numericIn(row, alts[k]).length) return alts[k];
        return null;
      }
      var trendQ = spec.trendQ || yQs[0];
      var sets = [], incomplete = [];
      rowsOf(ctx).forEach(function (row, i) {
        var xs = numericIn(row, spec.xQ);
        var anyY = yQs.some(function (q) { return asArray(q).some(function (a) { return cellsInRow(ctx, row, a).length; }); });
        if (!xs.length) { if (anyY) incomplete.push(i + 1); return; }
        var complete = yQs.every(function (q) { return presentRef(row, q) !== null; });
        if (!complete) { incomplete.push(i + 1); return; }
        var tRef = trendQ ? presentRef(row, trendQ) : null;
        var ty = tRef ? mean(numericIn(row, tRef).map(function (c) { return c.si; })) : NaN;
        sets.push({ rowNumber: i + 1, x: xs[0].si, y: ty });
      });
      // distinct values of x count as separate sets
      var distinct = [];
      sets.forEach(function (s) {
        if (!distinct.some(function (d) { return Math.abs(d.x - s.x) <= 1e-9 * Math.max(Math.abs(s.x), 1e-300); })) distinct.push(s);
      });
      var n = distinct.length;
      var awarded = Math.max(0, Math.min(max, max - (full - n)));
      var trendOk = true, trendWord = '';
      if (spec.trend && n >= 2) {
        if (typeof spec.trend === 'function') {
          trendOk = !!spec.trend(distinct, ctx);
        } else {
          var pts = distinct.filter(function (s) { return isFinite(s.y); });
          if (pts.length >= 2) {
            var f = linearFit(pts.map(function (s) { return s.x; }), pts.map(function (s) { return s.y; }));
            trendOk = spec.trend === 'decreasing' ? f.m < 0 : f.m > 0;
          }
          trendWord = spec.trend === 'decreasing' ? 'decrease' : 'increase';
        }
      }
      var details = { sets: n, rows: sets.map(function (s) { return s.rowNumber; }), incomplete: incomplete, trendOk: trendOk };
      var note = incomplete.length ? ' (' + listRows(incomplete) + ' incomplete)' : '';
      if (sets.length > n) note += ' (repeated values of ' + xName + ' count once)';
      if (!trendOk) {
        var yName = trendQ ? nameOf(ctx, asArray(trendQ)[0]) : 'the dependent variable';
        return result(0, CROSS + cap(countWord(n)) + ' sets of readings, but the trend is wrong' +
          (trendWord ? ': ' + yName + ' should ' + trendWord + ' as ' + xName + ' increases' : '') + ' (0 of ' + max + ')' + note + '.', details);
      }
      if (n === 0) return result(0, CROSS + 'No complete sets of readings (0 of ' + max + ')' + note + '.', details);
      if (awarded >= max) {
        return result(awarded, TICK + cap(countWord(n)) + ' sets of readings' + (spec.trend ? ' with correct trend' : '') + note, details);
      }
      return result(awarded, CROSS + 'Only ' + countWord(n) + ' ' + plural(n, 'set') + ' of readings (' + awarded + ' of ' + max + ')' + note, details);
    });
  }

  /* ------------------------------------------------------------------ range */

  /**
   * Range of the independent variable. spec: { xQ, minSpanSI (number | fn), lowSI?, highSI? }
   * (lowSI: smallest value must be ≤ lowSI; highSI: largest value must be ≥ highSI)
   */
  function range(spec) {
    return makePoint(spec, { id: 'range-' + spec.xQ, skill: 'MMO', label: 'Range of ' + spec.xQ }, function (ctx) {
      var name = nameOf(ctx, spec.xQ);
      var vals = valuesOf(ctx, spec.xQ).filter(function (v) { return v.num.ok && isFinite(v.si); });
      if (vals.length < 2) return result(0, CROSS + 'Not enough values of ' + name + ' to judge the range.');
      var lo = vals[0], hi = vals[0];
      vals.forEach(function (v) { if (v.si < lo.si) lo = v; if (v.si > hi.si) hi = v; });
      var span = hi.si - lo.si;
      var col = lo.colId, d = detailOf(ctx, col), factor = d.log ? 1 : (d.factor || 1);
      var unit = d.log ? '' : unitTextOf(ctx, col, spec.xQ);
      var u = unit ? ' ' + unit : '';
      var minSpan = resolve(spec.minSpanSI, ctx);
      var problems = [];
      if (isFinite(minSpan) && span < minSpan * (1 - 1e-9)) {
        problems.push('span ' + fmt(span / factor) + u + '; at least ' + fmt(minSpan / factor, 2) + u + ' needed');
      }
      var lowSI = resolve(spec.lowSI, ctx), highSI = resolve(spec.highSI, ctx);
      if (isFinite(lowSI) && lo.si > lowSI * (1 + 1e-9)) problems.push('smallest value should be ' + fmt((lowSI - d.offset) / factor, 2) + u + ' or less');
      if (isFinite(highSI) && hi.si < highSI * (1 - 1e-9)) problems.push('largest value should be ' + fmt((highSI - d.offset) / factor, 2) + u + ' or more');
      var details = { min: lo.str, max: hi.str, spanSI: span };
      var span$ = lo.str + u + ' to ' + hi.str + u;
      if (problems.length) return result(0, CROSS + 'Range of ' + name + ' too small: ' + span$ + ' (' + problems.join('; ') + ').', details);
      return result(this.max, TICK + 'Range of ' + name + ': ' + span$ + '.', details);
    });
  }

  /* ------------------------------------------------------------------ repeats */

  /**
   * Repeated raw readings. spec: { q, min = 2, xQ? } — every set (row, or group of rows with the same x when xQ
   * is given) has at least `min` readings of q.
   */
  function repeats(spec) {
    var min = spec.min || 2;
    return makePoint(spec, { id: 'repeats-' + spec.q, skill: 'MMO', label: 'Repeated readings of ' + spec.q }, function (ctx) {
      var name = nameOf(ctx, spec.q);
      var cols = colsOf(ctx, spec.q);
      if (!cols.length) return result(0, CROSS + 'No readings of ' + name + ' found in the table.');
      var groups = [], byKey = {};
      rowsOf(ctx).forEach(function (row, i) {
        var n = cellsInRow(ctx, row, spec.q).filter(function (c) { return c.num.ok; }).length;
        var xs = spec.xQ ? cellsInRow(ctx, row, spec.xQ).filter(function (c) { return c.num.ok; }) : [];
        if (!n && !xs.length) return;
        var key = xs.length ? 'x' + xs[0].si.toPrecision(9) : 'r' + i;
        if (!byKey[key]) { byKey[key] = { rows: [], n: 0 }; groups.push(byKey[key]); }
        byKey[key].rows.push(i + 1);
        byKey[key].n += n;
      });
      if (!groups.length) return result(0, CROSS + 'No readings of ' + name + ' found in the table.');
      var short = [];
      groups.forEach(function (g) { if (g.n < min) short.push(g.rows[0]); });
      var details = { columns: cols.length, sets: groups.length, missing: short };
      if (short.length === groups.length) {
        return result(0, CROSS + 'No repeated readings of ' + name + (cols.length < 2 ? ' (only one column of ' + name + ')' : '') + '.', details);
      }
      if (short.length) return result(0, CROSS + 'Repeat readings of ' + name + ' missing for ' + listRows(short) + '.', details);
      return result(this.max, TICK + 'Repeated readings of ' + name + ' for every set.', details);
    });
  }

  /* ------------------------------------------------------------------ headings */

  /**
   * Column headings: every column with a heading or values has a quantity and a correctly separated unit whose
   * dimensions match the identified quantity (no unit for dimensionless quantities; lg (x / unit) for logs).
   * A column with values whose heading matches no quantity does not cost the mark, but the comment names it.
   * spec: { exampleQ? (quantity used for the example heading in that note, e.g. 'L' → 'L / cm') }
   */
  function headings(spec) {
    spec = spec || {};
    return makePoint(spec, { id: 'headings', skill: 'PDO', label: 'Column headings' }, function (ctx) {
      var cols = ctx.table && Array.isArray(ctx.table.columns) ? ctx.table.columns : [];
      var problems = [], checked = 0;
      cols.forEach(function (col, i) {
        var d = detailOf(ctx, col.id);
        var heading = str(col.heading).trim();
        if (!heading) {
          if (d.hasData) problems.push('column ' + (i + 1) + ' has values but no heading');
          return;
        }
        checked++;
        var h = d.parsed || {};
        var q = d.qId ? quantityOf(ctx, d.qId) : null;
        var label = 'heading ' + quote(heading);
        if (h.log) {
          var innerDimless = q && d.log && isDimensionless(q.dims);
          var probs = (h.problems || []).filter(function (p) {
            return !(innerDimless && /unit inside/.test(p)) && !/Cambridge uses/.test(p);
          });
          if (probs.length) { problems.push(label + ': ' + probs[0]); return; }
          if (q && d.log && q.dims && !innerDimless && d.dimsOk === false) {
            problems.push(label + ': the unit inside the brackets does not match ' + nameOf(ctx, q.id) + ' (expected ' + (q.unitHint || formatDims(q.dims)) + ')');
          }
          return;
        }
        if (h.ok === false) {
          problems.push(label + ': ' + ((h.problems || [])[0] || 'write it as quantity / unit'));
          return;
        }
        if (!q || !q.dims) {
          return; // not identified: the form is fine, the unit cannot be judged
        }
        var dimless = isDimensionless(q.dims);
        if (!d.unit) {
          if (!dimless) problems.push(label + ': no unit given (expected ' + (q.unitHint || formatDims(q.dims)) + ')');
          return;
        }
        if (d.dimsOk === false) {
          problems.push(dimless ? label + ': ' + nameOf(ctx, q.id) + ' has no unit'
            : label + ': the unit ' + (h.unitStr || d.unit.canonical) + ' does not match ' + nameOf(ctx, q.id) +
              ' (expected ' + (q.unitHint || formatDims(q.dims)) + ')');
        }
      });
      if (!checked) return result(0, CROSS + 'The table has no column headings.');
      var details = { problems: problems };
      var note = unknownColumnsNote(ctx, spec.exampleQ);
      if (problems.length) {
        return result(0, CROSS + cap(problems.slice(0, 3).join('; ')) + (problems.length > 3 ? ' (and ' + (problems.length - 3) + ' more)' : '') + '.' + note, details);
      }
      return result(this.max, TICK + 'Every column heading has a quantity and a correct unit, separated by a solidus or brackets.' + note, details);
    });
  }

  /* ------------------------------------------------------------------ rawConsistency */

  /**
   * Raw values of q all to the same precision (same d.p. in the same unit), optionally matching the instrument.
   * spec: { q, resolutionSI?: number | number[] | fn(ctx) }
   */
  function rawConsistency(spec) {
    return makePoint(spec, { id: 'raw-' + spec.q, skill: 'PDO', label: 'Consistent raw ' + spec.q }, function (ctx) {
      var name = nameOf(ctx, spec.q);
      var vals = valuesOf(ctx, spec.q);
      if (!vals.length) return result(0, CROSS + 'No values of ' + name + ' recorded.');
      var bad = vals.filter(function (v) { return !v.num.ok; });
      if (bad.length) {
        return result(0, CROSS + quote(bad[0].str) + ' (row ' + bad[0].rowNumber + ') is not a number' +
          (/[a-zA-Zµ°Ω]/.test(bad[0].str) ? ': units belong in the heading, not in the cells' : '') + '.');
      }
      var stepOf = function (v) { return Math.pow(10, -v.num.dp) * (detailOf(ctx, v.colId).factor || 1); };
      var step0 = stepOf(vals[0]);
      var odd = vals.filter(function (v) { return Math.abs(stepOf(v) - step0) > 1e-9 * step0; });
      var details = { dp: vals.map(function (v) { return v.num.dp; }) };
      if (odd.length) {
        var examples = [vals[0]].concat(odd).slice(0, 3).map(function (v) { return v.str; });
        return result(0, CROSS + 'Raw values of ' + name + ' are not all given to the same number of decimal places (' +
          examples.join(', ') + ').', details);
      }
      var res = asArray(resolve(spec.resolutionSI, ctx));
      var d0 = detailOf(ctx, vals[0].colId);
      var unit = unitTextOf(ctx, vals[0].colId, spec.q), assumed = wrongUnitNote(ctx, vals[0].colId, spec.q);
      if (!unit && !d0.log) {
        // no unit in the heading: the values are taken to be in SI units, so say so rather than print a bare number
        var q0 = quantityOf(ctx, d0.qId || parseRef(spec.q).id);
        if (q0 && q0.dims && Object.keys(q0.dims).length) {
          unit = formatDims(q0.dims);
          assumed = ' (there is no unit in the heading, so the values are taken to be in ' + unit + ')';
        }
      }
      var u = unit ? ' ' + unit : '';
      var factor = d0.factor || 1;
      if (res.length) {
        var allowed = res.map(function (r) { return requiredDp(r / factor); });
        if (allowed.indexOf(vals[0].num.dp) < 0) {
          var given = Math.pow(10, -vals[0].num.dp);
          return result(0, CROSS + name + ' should be recorded to the nearest ' + fmt(res[0] / factor, 1) + u +
            ' (the resolution of the instrument), but ' + quote(vals[0].str) + ' is given to the nearest ' + fmt(given, 1) + u + assumed + '.', details);
        }
      }
      return result(this.max, TICK + 'All raw values of ' + name + ' given to ' + vals[0].num.dp + ' d.p.' +
        (res.length ? ', matching the resolution of the instrument (' + fmt(res[0] / factor, 1) + u + ')' : '') + '.', details);
    });
  }

  /* ------------------------------------------------------------------ derivedSF */

  /**
   * Significant figures of a calculated quantity: same as the least s.f. of the raw data used, or one more
   * (lg/ln columns: d.p. equal to the s.f. of the raw data, or one more). Judged row by row.
   * spec: { q, from: [qIds], fromAnswers?: [answer keys], extra = 1, rawName? (e.g. 'raw times') }
   */
  function derivedSF(spec) {
    var from = asArray(spec.from);
    var extra = spec.extra === undefined ? 1 : spec.extra;
    return makePoint(spec, { id: 'sf-' + spec.q, skill: 'PDO', label: 'Significant figures of ' + spec.q }, function (ctx) {
      var ref = parseRef(spec.q);
      var name = nameOf(ctx, spec.q);
      var rawName = spec.rawName || (from.length ? 'the raw data (' + from.map(function (f) { return nameOf(ctx, f); }).join(', ') + ')'
        : (ref.log ? nameOf(ctx, ref.id) : 'the raw data'));
      var have = spec.rawName ? (/s$|data/.test(rawName) ? 'have' : 'has') : (from.length || !ref.log ? 'have' : 'has');
      var cols = colsOf(ctx, spec.q);
      if (!cols.length) return result(0, CROSS + 'No column of ' + name + ' found in the table.');
      var answerStrs = asArray(spec.fromAnswers).map(function (k) {
        var vu = parseVU(firstAnswer(ctx.answer(k)));
        return vu.ok ? vu.valueStr : '';
      }).filter(Boolean);
      var sources = from.length ? from : (ref.log ? [ref.id] : []);
      var judged = [], bad = [], unparseable = [];
      rowsOf(ctx).forEach(function (row, i) {
        var cells = cellsInRow(ctx, row, spec.q);
        if (!cells.length) return;
        var raws = answerStrs.slice();
        sources.forEach(function (f) { cellsInRow(ctx, row, f).forEach(function (c) { raws.push(c.str); }); });
        var least = VL.sigfig ? VL.sigfig.leastSF(raws) : NaN;
        cells.forEach(function (c) {
          if (!c.num.ok) { unparseable.push({ row: i + 1, str: c.str }); return; }
          if (!isFinite(least)) return;
          var ok;
          if (ref.log) ok = c.num.dp >= least && c.num.dp <= least + extra;
          else {
            ok = false;
            for (var s = c.num.sfMin; s <= c.num.sfMax; s++) if (s >= least && s <= least + extra) ok = true;
          }
          var entry = { row: i + 1, str: c.str, sf: c.num.sf, sfMin: c.num.sfMin, dp: c.num.dp, least: least, ok: ok };
          judged.push(entry);
          if (!ok) bad.push(entry);
        });
      });
      var details = { rows: judged };
      if (unparseable.length) return result(0, CROSS + quote(unparseable[0].str) + ' (row ' + unparseable[0].row + ') is not a number.', details);
      if (!judged.length) return result(0, CROSS + 'The s.f. of ' + name + ' cannot be checked: no raw values found in the same rows.', details);
      var leasts = judged.map(function (j) { return j.least; });
      var sameLeast = leasts.every(function (l) { return l === leasts[0]; });
      if (bad.length) {
        var b = bad[0];
        var where = judged.length > 1 && bad.length < judged.length ? ' (' + listRows(bad.map(function (x) { return x.row; })) + ')' : '';
        if (ref.log) {
          return result(0, CROSS + name + ' values given to ' + b.dp + ' d.p. but ' + rawName + ' ' + have + ' ' + b.least +
            ' s.f.: lg/ln values need ' + b.least + ' or ' + (b.least + extra) + ' d.p.' + where + '.', details);
        }
        var given = b.sfMin !== b.sf ? b.sfMin + '–' + b.sf : String(b.sf);
        return result(0, CROSS + name + ' values given to ' + given + ' s.f. but ' + rawName + ' ' + have + ' ' + b.least + ' s.f.' + (where ? where + '.' : ''), details);
      }
      var rng = sameLeast ? leasts[0] + (extra ? '–' + (leasts[0] + extra) : '') : null;
      return result(this.max, TICK + name + ' values given to ' + (ref.log ? 'a suitable number of d.p.' : 'a suitable number of s.f.') +
        (rng ? ' (' + rng + (ref.log ? ' d.p.' : ' s.f.') + ', ' + rawName + ' ' + have + ' ' + leasts[0] + ' s.f.)' : ', consistent with ' + rawName) + '.', details);
    });
  }

  /* ------------------------------------------------------------------ calc */

  function expectedInColumn(ctx, colId, ref, expectedSI) {
    var d = detailOf(ctx, colId);
    var x = (expectedSI - (d.offset || 0)) / (d.factor || 1);
    if (ref.log === 'lg') return x > 0 ? Math.log(x) / Math.LN10 : NaN;
    if (ref.log === 'ln') return x > 0 ? Math.log(x) : NaN;
    return x;
  }

  function agreesCalc(s, expected, ref, relTol) {
    if (!isFinite(expected)) return false;
    if (ref.log) {
      var p = parseNum(s);
      if (!p.ok) return false;
      var tol = Math.max(0.5 * Math.pow(10, -p.dp), (ref.log === 'lg' ? LG_SLOPE : 1) * relTol);
      return Math.abs(p.value - expected) <= tol * (1 + 1e-9);
    }
    return agrees(s, expected, relTol);
  }

  /**
   * Calculated values agree with a computation from the student's OWN raw values in the same row (error carried
   * forward), within half a unit in the last place or relTol (default 0.5 %), whichever is larger.
   * spec: { q, compute(rowValues, ctx) -> SI value (for 'lg(T)': the value of T in SI), relTol = 0.005 }
   */
  function calc(spec) {
    var relTol = spec.relTol === undefined ? 0.005 : spec.relTol;
    return makePoint(spec, { id: 'calc-' + spec.q, skill: 'PDO', label: 'Calculation of ' + spec.q }, function (ctx) {
      var ref = parseRef(spec.q);
      var name = nameOf(ctx, spec.q);
      var cols = colsOf(ctx, spec.q);
      if (!cols.length) return result(0, CROSS + 'No column of ' + name + ' found in the table.');
      var checked = 0, wrong = [], missing = [], rowsChecked = [];
      rowsOf(ctx).forEach(function (row, i) {
        var cells = cellsInRow(ctx, row, spec.q);
        var expectedSI = NaN;
        try { expectedSI = Number(spec.compute(rowValues(ctx, row), ctx)); } catch (e) { expectedSI = NaN; }
        if (!cells.length) {
          if (isFinite(expectedSI)) missing.push(i + 1);
          return;
        }
        if (!isFinite(expectedSI)) return;
        cells.forEach(function (c) {
          var exp = expectedInColumn(ctx, c.colId, ref, expectedSI);
          checked++;
          rowsChecked.push(i + 1);
          if (!agreesCalc(c.str, exp, ref, relTol)) wrong.push({ row: i + 1, str: c.str, expected: exp, sf: c.num.ok ? c.num.sf : 3 });
        });
      });
      var details = { checked: checked, wrong: wrong, missing: missing };
      if (!checked) {
        return result(0, CROSS + name + ' could not be checked: no rows contain both ' + name + ' and the values it is calculated from.', details);
      }
      if (wrong.length) {
        var w = wrong[0];
        return result(0, CROSS + name + ' incorrect in ' + listRows(wrong.map(function (x) { return x.row; })) + ' (' + quote(w.str) +
          '; from your own values it should be ' + fmt(w.expected, Math.max(3, Math.min(6, w.sf + 1))) + ').', details);
      }
      if (missing.length) return result(0, CROSS + name + ' not calculated for ' + listRows(missing) + '.', details);
      return result(this.max, TICK + name + ' calculated correctly from your own readings in ' + (checked === 1 ? 'the only row' : 'all ' + checked + ' rows') + '.', details);
    });
  }

  /* ------------------------------------------------------------------ answerCalc (additive) */

  /**
   * Calculated ANSWER values (not table cells) agree with a computation from the student's own readings, e.g. both
   * values of k in a Q2-style question. spec: { keys: [..], compute(ctx, key) -> SI value, relTol = 0.005, names?,
   *         dims?, unitHint? (e.g. 's² m⁻¹') }
   * A value typed without a unit is compared with the SI value and with common decimal multiples of it (the
   * unit itself is judged by a separate mark point). When the typed unit has the wrong dimensions (spec.dims), the
   * expected value is quoted in the quantity's proper unit (unitHint, else SI), not in the student's unit.
   */
  function answerCalc(spec) {
    var keys = asArray(spec.keys || spec.key);
    var relTol = spec.relTol === undefined ? 0.005 : spec.relTol;
    /** An SI value in the quantity's proper unit: the first unit of unitHint when it suits spec.dims, else SI. */
    function properUnitValue(si) {
      var hint = str(spec.unitHint).split(/\s+or\s+|,\s*/)[0].trim();
      var u = hint ? parseUnitStr(hint) : null;
      if (u && u.ok && (!spec.dims || dimsEqual(u.dims, spec.dims))) return fmt((si - (u.offset || 0)) / u.factor) + ' ' + hint;
      var d = spec.dims ? formatDims(spec.dims) : '';
      return fmt(si) + (d ? ' ' + d : ' in SI units');
    }
    return makePoint(spec, { id: 'calc-' + keys.join('-'), skill: 'PDO', label: 'Calculation of ' + keys.join(' and ') }, function (ctx) {
      var problems = [], details = {};
      keys.forEach(function (k, i) {
        var nm = (spec.names && spec.names[i]) || prettyKey(k);
        var raw = firstAnswer(ctx.answer(k));
        if (!raw) { problems.push('No value given for ' + nm); return; }
        var vu = parseVU(raw);
        if (!vu.ok) { problems.push(quote(raw) + ' could not be read as a number'); return; }
        var exp = NaN;
        try { exp = Number(spec.compute(ctx, k)); } catch (e) { exp = NaN; }
        details[k] = { typed: raw, expectedSI: exp };
        if (!isFinite(exp)) { problems.push(nm + ' cannot be checked because the readings it is calculated from are missing'); return; }
        var ok;
        if (vu.unit && vu.unit.ok) ok = agrees(vu.valueStr, (exp - (vu.unit.offset || 0)) / vu.unit.factor, relTol);
        else ok = [1, 1e-2, 1e-3, 1e2, 1e3, 1e-6, 1e6].some(function (f) { return agrees(vu.valueStr, exp / f, relTol); });
        if (!ok) {
          var wrongDims = spec.dims && vu.unit && vu.unit.ok && !dimsEqual(vu.unit.dims, spec.dims);
          var shown = wrongDims ? properUnitValue(exp)
            : vu.unit && vu.unit.ok ? fmt((exp - (vu.unit.offset || 0)) / vu.unit.factor) + ' ' + (vu.unit.canonical || vu.unitStr)
              : fmt(exp) + ' in SI units';
          problems.push(nm + ' = ' + raw + ' does not follow from your readings (expected ' + shown + ')');
        }
      });
      if (problems.length) return result(0, CROSS + problems.join('; ') + '.', details);
      return result(this.max, TICK + (keys.length > 1 ? 'Values calculated' : 'Value calculated') + ' correctly from your own readings.', details);
    });
  }

  /* ------------------------------------------------------------------ graph marks */

  function graphOf(ctx) { return ctx.graph; }

  /**
   * Quantities plotted on the graph, from the columns chosen for its axes.
   * @returns {{x: string|null, y: string|null, xHeading: string, yHeading: string}} x / y: quantity reference of
   *   the plotted column ('L', or 'lg(T)' for an lg column), null when no column is chosen or it is not identified
   */
  function graphQuantities(ctx) {
    var g = graphOf(ctx) || {};
    var info = ctx.colInfo || { details: {} };
    var out = { x: null, y: null, xHeading: '', yHeading: '' };
    ['x', 'y'].forEach(function (a) {
      var colId = g[a] && g[a].colId;
      var d = colId ? info.details[colId] : null;
      if (!d) return;
      out[a + 'Heading'] = d.heading || '';
      if (d.qId) out[a] = d.log ? d.log + '(' + d.qId + ')' : d.qId;
    });
    return out;
  }

  function sameRef(a, b) {
    if (!a || !b) return false;
    var ra = parseRef(a), rb = parseRef(b);
    return ra.id === rb.id && ra.log === rb.log;
  }

  /**
   * '' when the graph plots spec.yQ against spec.xQ (or neither is given); otherwise a comment explaining which
   * graph the question asks for and what was plotted instead (axes swapped, wrong quantity, no column chosen).
   */
  function wrongGraphComment(ctx, spec) {
    if (!spec || (!spec.xQ && !spec.yQ)) return '';
    var gq = graphQuantities(ctx);
    var xOk = !spec.xQ || sameRef(gq.x, spec.xQ), yOk = !spec.yQ || sameRef(gq.y, spec.yQ);
    if (xOk && yOk) return '';
    var xN = spec.xQ ? nameOf(ctx, spec.xQ) : '', yN = spec.yQ ? nameOf(ctx, spec.yQ) : '';
    if (spec.xQ && spec.yQ && sameRef(gq.x, spec.yQ) && sameRef(gq.y, spec.xQ)) {
      return CROSS + 'The axes are the wrong way round: ' + yN + ' should be on the y-axis and ' + xN + ' on the x-axis.';
    }
    var asks = spec.xQ && spec.yQ ? 'The question asks for a graph of ' + yN + ' (y-axis) against ' + xN + ' (x-axis)'
      : 'The question asks for ' + (spec.yQ ? yN + ' on the y-axis' : xN + ' on the x-axis');
    var g = graphOf(ctx) || {};
    var axesNeeded = (spec.xQ ? ['x'] : []).concat(spec.yQ ? ['y'] : []);
    var unchosen = axesNeeded.filter(function (a) { return !(g[a] && g[a].colId); });
    if (unchosen.length) {
      return CROSS + asks + '; choose the column of your table to plot on ' +
        (unchosen.length > 1 ? 'each axis' : 'the ' + unchosen[0] + '-axis') + '.';
    }
    function shown(a) { return gq[a] ? nameOf(ctx, gq[a]) : (gq[a + 'Heading'] ? quote(gq[a + 'Heading']) : 'an unlabelled column'); }
    var shows = spec.xQ && spec.yQ ? shown('y') + ' against ' + shown('x') : shown(spec.yQ ? 'y' : 'x');
    return CROSS + asks + '; your graph shows ' + shows + '.';
  }

  function axisValues(ctx, axisName) {
    var g = graphOf(ctx), axis = g[axisName];
    if (axis.colId && ctx.table && (ctx.table.columns || []).some(function (c) { return c.id === axis.colId; })) {
      return rowsOf(ctx).map(function (r) { return cellOf(r, axis.colId); }).filter(function (s) { return parseNum(s).ok; });
    }
    var small = (g.grid && g.grid.small) || 10;
    return (g.points || []).map(function (p) {
      return VL.graph.gridToValue(axis, axisName === 'x' ? p.gx : p.gy, small);
    }).filter(function (v) { return isFinite(v); });
  }

  /**
   * Axes: both labelled with a quantity, scales not awkward (1, 2, 4, 5 × 10ⁿ per large square), points fill at
   * least half the grid in both directions, scale markings no more than 3 large squares apart.
   * spec: { xQ?, yQ? } — when given, the graph must plot yQ (y-axis) against xQ (x-axis) (see graphQuantities).
   */
  function axes(spec) {
    spec = spec || {};
    return makePoint(spec, { id: 'axes', skill: 'PDO', label: 'Axes and scales' }, function (ctx) {
      var g = graphOf(ctx);
      if (!hasGraphContent(g)) return result(0, CROSS + 'No graph drawn.');
      var wrong = wrongGraphComment(ctx, spec);
      if (wrong) return result(0, wrong, { graphQuantities: graphQuantities(ctx) });
      var sx = VL.graph.checkScale(g, 'x', axisValues(ctx, 'x'));
      var sy = VL.graph.checkScale(g, 'y', axisValues(ctx, 'y'));
      var problems = sx.problems.concat(sy.problems);
      var details = { x: sx, y: sy };
      if (sx.ok && sy.ok) {
        return result(this.max, TICK + 'Axes labelled, sensible scales, and the points fill more than half the grid in both directions (x ' +
          Math.round(sx.fill * 100) + ' %, y ' + Math.round(sy.fill * 100) + ' %).', details);
      }
      return result(0, CROSS + problems.slice(0, 3).join(' ') + (problems.length > 3 ? ' (and ' + (problems.length - 3) + ' more)' : ''), details);
    });
  }

  /**
   * Plotting: every row of the table that has numbers in both plotted columns is plotted within half a small square,
   * no extra points, all points on the grid. spec: { minPoints = 2 }
   */
  function plotting(spec) {
    spec = spec || {};
    var minPoints = spec.minPoints === undefined ? 2 : spec.minPoints;
    return makePoint(spec, { id: 'plotting', skill: 'PDO', label: 'Plotting of points' }, function (ctx) {
      var g = graphOf(ctx);
      if (!g || !g.points || !g.points.length) return result(0, CROSS + 'No points plotted.');
      var cp = VL.graph.checkPlotting(g, ctx.table);
      var small = (g.grid && g.grid.small) || 10;
      var W = g.grid.cols * small, H = g.grid.rows * small;
      var off = g.points.filter(function (p) { return p.gx < -1e-6 || p.gy < -1e-6 || p.gx > W + 1e-6 || p.gy > H + 1e-6; });
      var problems = cp.problems.slice();
      if (off.length) problems.push(off.length === 1 ? 'One point is plotted off the grid.' : off.length + ' points are plotted off the grid.');
      if (cp.expected < minPoints) problems.push('Too few points to credit the plotting (at least ' + minPoints + ' needed).');
      var ok = cp.ok && cp.allPlotted && !off.length && cp.expected >= minPoints;
      var details = cp;
      if (ok) return result(this.max, TICK + 'All ' + cp.expected + ' points plotted correctly (within half a small square).', details);
      return result(0, CROSS + problems.slice(0, 2).join(' '), details);
    });
  }

  /**
   * Quality of the data: every point (one circled anomaly allowed) within tolY of the least-squares straight line
   * through the student's own table values.
   * spec: { tolY: number | fn(ctx, { xs, ys, rows }) -> tolerance in SI units of the y quantity (for an lg/ln
   *         column: in lg/ln units), xQ?, yQ? (default: the plotted columns), minPoints = 5, maxAnomalies = 1,
   *         requirePlotted = true }
   * requirePlotted: the mark also needs a graph of yQ against xQ on which every row of the table with numbers in
   * both columns is plotted (circled anomalies count as plotted), at least minPoints of them. The scatter itself
   * is judged from the table values (SI).
   */
  function quality(spec) {
    var minPoints = spec.minPoints === undefined ? 5 : spec.minPoints;
    var maxAnom = spec.maxAnomalies === undefined ? 1 : spec.maxAnomalies;
    var requirePlotted = spec.requirePlotted !== false;
    return makePoint(spec, { id: 'quality', skill: 'MMO', label: 'Quality of results' }, function (ctx) {
      var g = graphOf(ctx);
      var xCol = spec.xQ ? colsOf(ctx, spec.xQ)[0] : (g && g.x.colId);
      var yCol = spec.yQ ? colsOf(ctx, spec.yQ)[0] : (g && g.y.colId);
      // a graph of the right quantities may plot another column of the same quantity: judge that one
      if (requirePlotted && g && !wrongGraphComment(ctx, spec)) {
        if (spec.xQ && g.x.colId) xCol = g.x.colId;
        if (spec.yQ && g.y.colId) yCol = g.y.colId;
      }
      if (!xCol || !yCol) {
        return result(0, CROSS + 'The quality of the results cannot be judged: ' +
          (spec.xQ || spec.yQ ? 'the columns needed (' + [spec.xQ, spec.yQ].filter(Boolean).map(function (q) { return nameOf(ctx, q); }).join(' and ') + ') were not found in the table.' : 'no graph columns chosen.'));
      }
      var circled = {};
      ((g && g.points) || []).forEach(function (p) { if (p.anomaly && p.rowId) circled[p.rowId] = true; });
      var pts = [];
      rowsOf(ctx).forEach(function (row, i) {
        var nx = parseNum(cellOf(row, xCol)), ny = parseNum(cellOf(row, yCol));
        if (!nx.ok || !ny.ok) return;
        pts.push({ rowId: row.id, rowNumber: i + 1, x: cellSI(ctx, xCol, nx), y: cellSI(ctx, yCol, ny) });
      });
      if (pts.length < minPoints) {
        return result(0, CROSS + 'Too few results to judge the quality (' + pts.length + '; at least ' + minPoints + ' needed).');
      }
      if (requirePlotted) {
        if (!hasGraphContent(g)) return result(0, CROSS + 'No graph drawn.');
        var wrong = wrongGraphComment(ctx, spec);
        if (wrong) return result(0, wrong, { graphQuantities: graphQuantities(ctx) });
        var cp = g.x.colId && g.y.colId ? VL.graph.checkPlotting(g, ctx.table) : null;
        if (!cp || !cp.allPlotted || cp.points.length < minPoints) {
          var gx = spec.xQ ? nameOf(ctx, spec.xQ) : nameOf(ctx, graphQuantities(ctx).x || 'x');
          var gy = spec.yQ ? nameOf(ctx, spec.yQ) : nameOf(ctx, graphQuantities(ctx).y || 'y');
          return result(0, CROSS + 'All the points in the table (at least ' + minPoints + ') must be plotted on your graph of ' +
            gy + ' against ' + gx + ' for this mark.', { plotting: cp });
        }
      }
      var excluded = [];
      var used = pts.filter(function (p) {
        if (circled[p.rowId] && excluded.length < maxAnom) { excluded.push(p.rowNumber); return false; }
        return true;
      });
      var xs = used.map(function (p) { return p.x; }), ys = used.map(function (p) { return p.y; });
      var f = linearFit(xs, ys);
      if (!isFinite(f.m)) return result(0, CROSS + 'The quality of the results cannot be judged (all values of x are the same).');
      var tol = Number(resolve(spec.tolY, ctx, { xs: xs, ys: ys, rows: used }));
      var worst = null;
      used.forEach(function (p) {
        p.dev = Math.abs(p.y - (f.m * p.x + f.c));
        if (!worst || p.dev > worst.dev) worst = p;
      });
      var d = detailOf(ctx, yCol), factor = d.log ? 1 : (d.factor || 1);
      var unit = d.log ? '' : unitTextOf(ctx, yCol, spec.yQ), u = unit ? ' ' + unit : '';
      var anomNote = excluded.length ? ' (circled anomaly in ' + listRows(excluded) + ' ignored)' : '';
      var details = { tolSI: tol, fit: { m: f.m, c: f.c }, maxDevSI: worst.dev, excluded: excluded };
      if (!isFinite(tol)) return result(0, CROSS + 'The quality of the results could not be judged.', details);
      var bad = used.filter(function (p) { return p.dev > tol * (1 + 1e-9); });
      if (bad.length) {
        return result(0, CROSS + 'Scatter too large: the point in row ' + worst.rowNumber + ' is ' + fmt(worst.dev / factor, 2) + u +
          ' from the best straight line (allowed ' + fmt(tol / factor, 2) + u + ')' +
          (bad.length > 1 ? '; ' + bad.length + ' points are outside the tolerance' : '') + anomNote + '.', details);
      }
      return result(this.max, TICK + 'All points lie within ' + fmt(tol / factor, 2) + u + ' of a straight line' + anomNote + '.', details);
    });
  }

  /** Line of best fit: VL.graph.checkLine ok (balanced, ≥ 5 points, spans the data, only a circled anomaly ignored). */
  function bestFit(spec) {
    spec = spec || {};
    return makePoint(spec, { id: 'best-fit', skill: 'PDO', label: 'Line of best fit' }, function (ctx) {
      var g = graphOf(ctx);
      if (!g || !g.line) return result(0, CROSS + 'No line of best fit drawn.');
      var cl = VL.graph.checkLine(g, ctx.table);
      if (cl.ok) {
        return result(this.max, TICK + 'Line of best fit balanced about the ' + cl.usedPoints + ' points' +
          (cl.anomalies ? ' (one circled anomaly ignored)' : '') + '.', cl);
      }
      return result(0, CROSS + cl.problems.slice(0, 2).join(' '), cl);
    });
  }

  /** Factor converting a graph-axis value to SI (from the plotted column's heading unit). */
  function axisFactor(ctx, axisName) {
    var g = graphOf(ctx), colId = g && g[axisName] && g[axisName].colId;
    if (!colId) return NaN;
    var d = detailOf(ctx, colId);
    if (d.log) return 1;
    return d.unit && d.unit.ok ? d.unit.factor : NaN;
  }

  /**
   * Gradient: triangle present, hypotenuse ≥ half the drawn line, vertices on the line, read-offs within half a
   * small square, and the gradient answer = Δy/Δx from the read-offs (sign right).
   * spec: { sign?: +1|-1, key = 'gradient', relTol = 0.01, xQ?, yQ? (the graph must plot yQ against xQ) }
   */
  function gradient(spec) {
    spec = spec || {};
    var key = spec.key || 'gradient';
    var relTol = spec.relTol === undefined ? 0.01 : spec.relTol;
    return makePoint(spec, { id: 'gradient', skill: 'ACE', label: 'Gradient' }, function (ctx) {
      var g = graphOf(ctx);
      if (!g || !g.line) return result(0, CROSS + 'No line drawn, so the gradient cannot be credited.');
      var wrong = wrongGraphComment(ctx, spec);
      if (wrong) return result(0, wrong, { graphQuantities: graphQuantities(ctx) });
      var ct = VL.graph.checkTriangle(g);
      var problems = [];
      if (!ct.present) problems.push('No gradient triangle drawn.');
      else {
        ct.problems.forEach(function (p) { problems.push(p); });
      }
      if (ct.present && ct.gradient === null && !ct.problems.length) problems.push('Δy/Δx cannot be found from your read-offs.');
      var raw = firstAnswer(ctx.answer(key));
      var vu = raw ? parseVU(raw) : null;
      if (!raw) problems.push('No value given for the gradient.');
      else if (!vu.ok) problems.push(quote(raw) + ' could not be read as a number.');
      else if (ct.gradient !== null && isFinite(ct.gradient)) {
        var val = vu.num.value;
        var ok = agrees(vu.valueStr, ct.gradient, relTol);
        if (!ok && vu.unit && vu.unit.ok) {
          // the student may have converted units (e.g. read-offs in cm, gradient quoted per m)
          var fx = axisFactor(ctx, 'x'), fy = axisFactor(ctx, 'y');
          var gSI = ct.gradient * fy / fx;
          if (isFinite(gSI) && gSI !== 0) ok = Math.abs(vu.si - gSI) <= relTol * Math.abs(gSI) + 0.5 * Math.pow(10, -vu.num.dp) * vu.unit.factor;
        }
        if (!ok) {
          if (ct.gradient !== 0 && agrees(vu.valueStr, 1 / ct.gradient, relTol)) problems.push('The gradient has been calculated as Δx/Δy instead of Δy/Δx.');
          else problems.push('The gradient ' + raw + ' does not equal Δy/Δx from your read-offs (' + fmt(ct.gradient) + ').');
        } else if (spec.sign && val !== 0 && (val > 0 ? 1 : -1) !== (spec.sign > 0 ? 1 : -1)) {
          problems.push('The gradient should be ' + (spec.sign > 0 ? 'positive' : 'negative') + '.');
        }
      }
      var details = ct;
      if (problems.length) return result(0, CROSS + problems.slice(0, 2).join(' '), details);
      return result(this.max, TICK + 'Large triangle (hypotenuse ' + Math.round(ct.hypFraction * 100) +
        ' % of the line) with read-offs on the line, and Δy/Δx calculated correctly.', details);
    });
  }

  /**
   * y-intercept: read directly at x = 0 (within half a small square) or found by substituting a point on the line
   * into y = mx + c. spec: { key = 'intercept', gradientKey = 'gradient', xQ?, yQ? (the graph must plot yQ
   * against xQ) }. Falls back to graph.intercept.value.
   */
  function intercept(spec) {
    spec = spec || {};
    var key = spec.key || 'intercept', gKey = spec.gradientKey || 'gradient';
    return makePoint(spec, { id: 'intercept', skill: 'ACE', label: 'y-intercept' }, function (ctx) {
      var g = graphOf(ctx);
      var raw = firstAnswer(ctx.answer(key)) || str(g && g.intercept && g.intercept.value).trim();
      if (!raw) return result(0, CROSS + 'No value given for the y-intercept.');
      var vu = parseVU(raw);
      if (!vu.ok) return result(0, CROSS + quote(raw) + ' could not be read as a number.');
      if (!g || !g.line) return result(0, CROSS + 'No line drawn, so the y-intercept cannot be credited.');
      var wrong = wrongGraphComment(ctx, spec);
      if (wrong) return result(0, wrong, { graphQuantities: graphQuantities(ctx) });
      var gv = parseVU(firstAnswer(ctx.answer(gKey)));
      var ci = VL.graph.checkIntercept(g, vu.valueStr, gv.ok ? { gradient: gv.valueStr } : {});
      if (ci.ok) {
        return result(this.max, TICK + (ci.method === 'direct' ? 'y-intercept read correctly where the line crosses x = 0.'
          : 'y-intercept calculated correctly by substituting a point on the line into y = mx + c.'), ci);
      }
      return result(0, CROSS + (ci.problems[0] || 'The y-intercept does not match your line.'), ci);
    });
  }

  /** Anything experiment-specific: spec.check(ctx) -> { awarded, comment, details }. */
  function custom(spec) {
    return makePoint(spec, { id: 'custom', skill: 'ACE', label: 'Mark point' }, function (ctx) {
      var r = spec.check.call(this, ctx) || {};
      return { awarded: r.awarded || 0, comment: r.comment || '', details: r.details || null };
    });
  }

  /* ------------------------------------------------------------------ sfJustification */

  // Tested on textmatch clauses (already plain()). A digit may come straight before the abbreviation: '3sf', '3dp'.
  var SF_RE = /(?:\b|(?<=\d))(s ?\.? ?f\.?s?|sig\.? ?figs?\.?|sig(nificant)?s? ?fig\w*|significant\w*)(?![a-z])/;
  var DP_RE = /(?:\b|(?<=\d))(d ?\.? ?p\.?s?|decimal\w*)(?![a-z])/;
  var RAW_DEFAULT = ['/\\braw\\b/', '/\\breading/', '/\\bmeasure(d|ment|ments)?\\b/', '/\\bdata\\b/', '/\\brecorded\\b/'];

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /**
   * Justification of the number of s.f.: mentions significant figures AND links them to the raw data (any of
   * rawWords, or "raw data / readings / measurements"). An answer that only talks about decimal places — or ties
   * the raw data to decimal places — is not credited.
   * spec: { key, rawWords: ['L', 't', 'd'] }
   */
  function sfJustification(spec) {
    var rawWords = asArray(spec.rawWords);
    return makePoint(spec, { id: 'sf-justification', skill: 'PDO', label: 'Justification of s.f.' }, function (ctx) {
      var text = answerText(ctx.answer(spec.key)).trim();
      if (!text) return result(0, CROSS + 'No justification given.');
      var TM = VL.textmatch;
      var alts = RAW_DEFAULT.slice();
      rawWords.forEach(function (w) {
        var p = TM.plain(w);
        if (!p) return;
        if (p.length <= 2) alts.push('/\\b' + escapeRe(p) + '[0-9]*\\b/');
        else alts.push(w);
      });
      var rawConcept = [alts];
      var clauses = TM.clauses(text);
      var good = false, badLink = false, anySF = false, anyDP = false, anyRaw = false;
      clauses.forEach(function (c) {
        var sf = SF_RE.test(c), dp = DP_RE.test(c), raw = TM.matches(c, rawConcept);
        anySF = anySF || sf; anyDP = anyDP || dp; anyRaw = anyRaw || raw;
        if (sf && raw) good = true;
        if (dp && raw && !sf) badLink = true;
      });
      var details = { mentionsSF: anySF, mentionsDP: anyDP, mentionsRaw: anyRaw };
      var rawList = rawWords.length ? rawWords.join(', ') : 'the raw data';
      if (good || (anySF && anyRaw && !badLink)) {
        return result(this.max, TICK + 'Links the number of s.f. in the answer to the s.f. of the raw data.', details);
      }
      if (badLink || (anyDP && !anySF)) {
        return result(0, CROSS + 'Refers to decimal places: the number of s.f. should be justified by the number of significant figures (not d.p.) in the raw data (' + rawList + ').', details);
      }
      if (!anySF) return result(0, CROSS + 'Does not mention significant figures.', details);
      return result(0, CROSS + 'Mentions s.f. but does not link them to the raw data (' + rawList + ').', details);
    });
  }

  /* ------------------------------------------------------------------ percentUncertainty */

  /**
   * Absolute uncertainty realistic (within absRangeSI) and percentage uncertainty = abs / value × 100 within rounding.
   * spec: { absKey, pctKey, valueKey, absRangeSI: [lo, hi] | fn(ctx), relTol = 0.01, name? }
   * An absolute uncertainty typed without a unit is taken to be in the unit of the value. If only the percentage
   * is given, the absolute uncertainty it implies is checked instead. Both may be written with a leading ±
   * ('±0.01 cm', '+/- 0.01 cm', '±0.41 %'), and the value may be written 'x ± Δx unit' (x is used).
   */
  function percentUncertainty(spec) {
    var relTol = spec.relTol === undefined ? 0.01 : spec.relTol;
    var name = spec.name || prettyKey(spec.valueKey);
    return makePoint(spec, { id: 'pct-uncertainty', skill: 'ACE', label: 'Percentage uncertainty in ' + name }, function (ctx) {
      var valRaw = firstAnswer(ctx.answer(spec.valueKey));
      var absRaw = firstAnswer(ctx.answer(spec.absKey));
      var pctRaw = firstAnswer(ctx.answer(spec.pctKey));
      if (!absRaw && !pctRaw) return result(0, CROSS + 'No uncertainty given.');
      var val = parseVU(valRaw, { allowUncertainty: true });   // '2.45 ± 0.01 cm' is the value 2.45 cm
      if (!valRaw || !val.ok || !val.num.value) return result(0, CROSS + 'The value of ' + name + ' is needed to check the percentage uncertainty.');
      var vFactor = val.unit && val.unit.ok ? val.unit.factor : 1;
      var vUnit = val.unit && val.unit.ok ? (val.unit.canonical || val.unitStr) : '';
      var valueSI = val.num.value * vFactor;          // no offset: percentage of the value as measured
      var problems = [], absSI = NaN, derived = false;
      if (absRaw) {
        var a = parseVU(absRaw, { allowPlusMinus: true });
        if (!a.ok) return result(0, CROSS + quote(absRaw) + ' could not be read as an uncertainty.');
        if (a.unit && a.unit.ok) {
          if (val.unit && val.unit.ok && !dimsEqual(a.unit.dims, val.unit.dims)) problems.push('the unit of the absolute uncertainty does not match the unit of ' + name);
          absSI = Math.abs(a.num.value) * a.unit.factor;
        } else {
          absSI = Math.abs(a.num.value) * vFactor;
        }
      }
      var pct = NaN, pctStr = '';
      if (pctRaw) {
        var pv = parseVU(pctRaw, { allowPlusMinus: true });
        if (!pv.ok) problems.push(quote(pctRaw) + ' could not be read as a percentage');
        else if (pv.unitStr && pv.unitStr !== '%') problems.push('the percentage uncertainty should have no unit other than %');
        else { pct = pv.num.value; pctStr = pv.valueStr; }
      } else {
        problems.push('no percentage uncertainty given');
      }
      if (!absRaw && isFinite(pct)) { absSI = pct / 100 * Math.abs(valueSI); derived = true; }
      var rng = resolve(spec.absRangeSI, ctx);
      if (rng && isFinite(absSI)) {
        var lo = Math.min(rng[0], rng[1]), hi = Math.max(rng[0], rng[1]);
        if (absSI < lo * (1 - 1e-9) || absSI > hi * (1 + 1e-9)) {
          problems.push((derived ? 'your percentage implies an absolute uncertainty of ' + fmt(absSI / vFactor, 2) + (vUnit ? ' ' + vUnit : '') + ', which'
            : 'the absolute uncertainty ' + absRaw) + ' is not realistic for this measurement (expected ' + fmtRange(lo / vFactor, hi / vFactor) + (vUnit ? ' ' + vUnit : '') + ')');
        }
      }
      var expected = isFinite(absSI) ? absSI / Math.abs(valueSI) * 100 : NaN;
      if (!derived && isFinite(pct) && isFinite(expected) && !agrees(pctStr, expected, relTol)) {
        problems.push('the percentage uncertainty should be ' + absRaw + ' / ' + valRaw + ' × 100 = ' + fmt(expected) + ' %, not ' + pctRaw);
      }
      var details = { absSI: absSI, expectedPercent: expected, typedPercent: pct };
      if (problems.length) return result(0, CROSS + cap(problems.join('; ')) + '.', details);
      return result(this.max, TICK + (derived ? 'Percentage uncertainty (' + pctRaw + ') realistic for this measurement.'
        : 'Absolute uncertainty ' + absRaw + ' is realistic and the percentage uncertainty (' + pctRaw + ') is calculated correctly.'), details);
    });
  }

  /* ------------------------------------------------------------------ conclusion */

  var CRIT_CUES = /\b(within|less|lower|below|under|smaller|up to|at most|no more|not more|maximum|max|limit|criterion|criteria|tolerance|threshold|acceptable|accepted|allowed|allowance|uncertainty|uncertainties|margin|than|exceed\w*|if|should|must|considered|range)\b/g;
  var DIFF_CUES = /\b(difference|different|differ|differs|differed|apart|discrepancy|deviation|deviate\w*|deviates|varies|vary|variation|change|by|gives|giving|calculated|equals)\b/g;
  var STRONG_POS = /\b(support|supports|supported|supporting|consistent|agree|agrees|agreed|agreement|valid|validates|validated|confirm|confirms|confirmed|verif\w*|true|prove|proves|proved|proven)\b/g;
  var STRONG_NEG = /\b(inconsistent|disagree\w*|invalid|untrue|false|incorrect|wrong|refute\w*|contradict\w*|reject\w*|disprove\w*|unsupported)\b/g;
  var WEAK_POS = /\b(proportional|proportionality|equal|same|constant|correct|holds?|satisf\w*|accept\w*|similar|close)\b/g;
  var NEGATORS = /\b(not|never|neither|nor|no|fail|fails|failed|hardly|without)\b/;
  var CONDITIONAL = /\b(if|would|should|must|expect\w*|predict\w*|hypothes\w*|whether)\b/;
  /** A clause about the suggestion itself (the verdict), rather than about the k values. */
  var VERDICT_RE = /\b(support\w*|unsupported|valid\w*|invalid|relationship|suggest\w*|hypothes\w*|proportional\w*|results?|data|confirm\w*|prove\w*|disprove\w*|refute\w*|contradict\w*)\b/;

  /** Last cue word (and its distance in words) found in a word window. */
  function lastCue(words, re) {
    for (var i = words.length - 1; i >= 0; i--) {
      re.lastIndex = 0;
      if (re.test(words[i]) || (i > 0 && (re.lastIndex = 0, re.test(words[i - 1] + ' ' + words[i])))) return words.length - 1 - i;
    }
    return Infinity;
  }

  /** Polarity of a clause from cue words: 'supports' | 'not' | null (with negation handling). */
  function clausePolarity(clause, cueRe) {
    var words = clause.split(' '), pol = null;
    for (var i = 0; i < words.length; i++) {
      cueRe.lastIndex = 0;
      if (!cueRe.test(words[i])) continue;
      var negated = false;
      for (var k = Math.max(0, i - 3); k < i; k++) if (NEGATORS.test(words[k])) negated = true;
      pol = negated ? 'not' : 'supports';
    }
    return pol;
  }

  function strongPolarity(clause) {
    var pos = clausePolarity(clause, STRONG_POS);
    var neg = clausePolarity(clause, STRONG_NEG);
    if (neg) return neg === 'supports' ? 'not' : 'supports';   // "not inconsistent" → supports
    return pos;
  }

  /**
   * Parse a written conclusion.
   * @param {string} text
   * The claim comes from the VERDICT clauses (about the suggestion: support, valid, relationship, results,
   * proportional ...), so a subordinate clause about the k values ("although the k values agree within 10 %") cannot
   * override it. Verdict clauses that disagree give claim null with conflict: true. Only when there is no verdict
   * clause does the claim come from the other clauses (the values agree / are within / differ).
   * @returns {{claim: 'supports'|'not'|null, claimText: string, conflict: boolean, criteria: number[],
   *            differences: number[], unknown: number[], ratioCriteria: number[], mentionsUncertainty: boolean}}
   *            (all numbers in %; claimText: the clause the claim was taken from, normalised)
   */
  function parseConclusion(text) {
    var TM = VL.textmatch;
    var res = { claim: null, claimText: '', conflict: false, criteria: [], differences: [], unknown: [], ratioCriteria: [],
      mentionsUncertainty: false };
    var src = String(text === undefined || text === null ? '' : text)
      .replace(/<=|≤|⩽/g, ' less than or equal to ').replace(/>=|≥|⩾/g, ' greater than or equal to ')
      .replace(/</g, ' less than ').replace(/>/g, ' greater than ').replace(/≈|~/g, ' approximately ')
      .replace(/±/g, ' within ');
    var p = TM.plain(src);
    if (!p) return res;
    res.mentionsUncertainty = /\buncertaint/.test(p);
    // percentages and the words around them
    var words = p.split(' ');
    for (var i = 0; i < words.length; i++) {
      if (words[i] !== '%' || i === 0 || !/^-?\d+(\.\d+)?$/.test(words[i - 1])) continue;
      var val = Math.abs(parseFloat(words[i - 1]));
      var left = words.slice(Math.max(0, i - 7), i - 1);
      var right = words.slice(i + 1, i + 3).join(' ');
      var dc = lastCue(left, CRIT_CUES), dd = lastCue(left, DIFF_CUES);
      if (dc < dd) res.criteria.push(val);
      else if (dd < dc) res.differences.push(val);
      else if (/\b(criterion|limit|tolerance|margin)\b/.test(right)) res.criteria.push(val);
      else if (/\b(differ\w*|apart|off|discrepanc\w*)\b/.test(right)) res.differences.push(val);
      else res.unknown.push(val);
    }
    // ratio criteria such as "between 0.9 and 1.1"
    var re = /\b(\d+(?:\.\d+)?)\s+(?:and|to)\s+(\d+(?:\.\d+)?)\b(?!\s*%)/g, m;
    while ((m = re.exec(p)) !== null) {
      var a = parseFloat(m[1]), b = parseFloat(m[2]);
      if (a > 0.5 && a < 1 && b > 1 && b < 2) res.ratioCriteria.push(Math.max(1 - a, b - 1) * 100);
    }
    // the claim
    var cl = TM.clauses(src);
    var verdicts = [];                                     // { pol, text } of the verdict clauses
    var strong = [], strongCond = [], weak = [], within = [];
    cl.forEach(function (c) {
      if (c === 'yes' || /^yes\b/.test(c)) { verdicts.push({ pol: 'supports', text: c }); strong.push({ pol: 'supports', text: c }); return; }
      if (c === 'no') { verdicts.push({ pol: 'not', text: c }); strong.push({ pol: 'not', text: c }); return; }
      var cond = CONDITIONAL.test(c);
      var sp = strongPolarity(c), wp = null;
      if (sp) (cond ? strongCond : strong).push({ pol: sp, text: c });
      if (!cond && !/\bsuggest/.test(c)) {
        wp = clausePolarity(c, WEAK_POS);
        if (wp) weak.push({ pol: wp, text: c });
      }
      if (!cond && /\bwithin\b/.test(c)) within.push({ pol: /\bnot\b[^%]*\bwithin\b|\boutside\b/.test(c) ? 'not' : 'supports', text: c });
      if (!cond && VERDICT_RE.test(c) && (sp || wp)) verdicts.push({ pol: sp || wp, text: c });
    });
    function take(pick) { res.claim = pick.pol; res.claimText = pick.text; }
    if (verdicts.length) {
      if (verdicts.every(function (v) { return v.pol === verdicts[0].pol; })) take(verdicts[verdicts.length - 1]);
      else res.conflict = true;                            // the student's verdicts contradict each other
    } else if (strong.length) {
      // no verdict clause: the clauses about the k values decide (the last one when they disagree)
      var allSame = strong.every(function (x) { return x.pol === strong[0].pol; });
      take(allSame ? strong[0] : strong[strong.length - 1]);
    } else if (weak.length) take(weak[weak.length - 1]);
    else if (within.length) take(within[within.length - 1]);
    return res;
  }

  /**
   * Conclusion: states a numerical criterion and a claim (supports / does not support) consistent with the
   * student's own % difference between k1 and k2 (|k1 − k2| / mean × 100; ratio forms also accepted).
   * spec: { k1Key, k2Key, key = 'conclusion', pctUncertaintyKey? (lets "within the percentage uncertainty"
   *         refer to the student's own value), maxCriterion = 50 (%) }
   */
  function conclusion(spec) {
    var key = spec.key || 'conclusion';
    var maxCrit = spec.maxCriterion === undefined ? 50 : spec.maxCriterion;
    return makePoint(spec, { id: 'conclusion', skill: 'ACE', label: 'Conclusion with criterion' }, function (ctx) {
      var text = answerText(ctx.answer(key)).trim();
      if (!text) return result(0, CROSS + 'No conclusion given.');
      var k1 = parseVU(firstAnswer(ctx.answer(spec.k1Key))), k2 = parseVU(firstAnswer(ctx.answer(spec.k2Key)));
      if (!k1.ok || !k2.ok) return result(0, CROSS + 'Both values of k are needed to judge the conclusion.');
      var bothUnits = k1.unit && k1.unit.ok && k2.unit && k2.unit.ok && dimsEqual(k1.unit.dims, k2.unit.dims);
      var v1 = bothUnits ? k1.si : k1.num.value, v2 = bothUnits ? k2.si : k2.num.value;
      var diff = Math.abs(v1 - v2);
      var meanV = Math.abs(v1 + v2) / 2;
      if (!(meanV > 0)) return result(0, CROSS + 'The values of k cannot be compared.');
      var measures = [diff / meanV * 100, diff / Math.min(Math.abs(v1), Math.abs(v2)) * 100, diff / Math.max(Math.abs(v1), Math.abs(v2)) * 100];
      var pc = parseConclusion(text);
      var crits = pc.criteria.concat(pc.ratioCriteria);
      if (!crits.length && pc.unknown.length) {
        crits = pc.unknown.filter(function (u) {
          return !measures.some(function (d) { return Math.abs(u - d) <= Math.max(0.15 * d, 0.2); });
        });
      }
      if (!crits.length && pc.mentionsUncertainty && spec.pctUncertaintyKey) {
        var pu = parseVU(firstAnswer(ctx.answer(spec.pctUncertaintyKey)));
        if (pu.ok) crits = [Math.abs(pu.num.value)];
      }
      var d0 = measures[0];
      var details = { k1: v1, k2: v2, percentDifference: d0, parsed: pc, criterion: crits[0] };
      if (!crits.length) {
        return result(0, CROSS + 'No numerical criterion stated (e.g. “the values of k should agree within 10 %”). Your values differ by ' + fmt(d0, 2) + ' %.', details);
      }
      var crit = crits[0];
      details.criterion = crit;
      if (!(crit > 0) || crit > maxCrit) {
        return result(0, CROSS + 'A criterion of ' + fmtPlain(crit) + ' % is not a meaningful test of the suggestion.', details);
      }
      if (pc.conflict) return result(0, CROSS + 'Your conclusion does not make a clear statement of whether the results support the suggestion.', details);
      if (!pc.claim) return result(0, CROSS + 'No clear statement of whether your results support the suggestion.', details);
      var slack = function (c) { return c * 0.005 + 0.05; };
      var canSupport = measures.some(function (d) { return d <= crit + slack(crit); });
      var canReject = measures.some(function (d) { return d > crit - slack(crit); });
      var consistent = pc.claim === 'supports' ? canSupport : canReject;
      var dTxt = fmt(d0, 2) + ' %', cTxt = fmtPlain(crit) + ' %';
      if (consistent) {
        return result(this.max, TICK + 'Criterion stated (' + cTxt + '); your values of k differ by ' + dTxt + ', so “' +
          (pc.claim === 'supports' ? 'supports' : 'does not support') + '” is consistent with your results.', details);
      }
      return result(0, CROSS + 'Your values of k differ by ' + dTxt + ', which is ' + (d0 > crit ? 'more' : 'less') + ' than your criterion of ' + cTxt +
        ', so your results ' + (d0 > crit ? 'do not support' : 'support') + ' the suggestion, but your conclusion says they ' +
        (pc.claim === 'supports' ? 'do' : 'do not') + (pc.claimText ? ' (“' + pc.claimText + '”)' : '') + '.', details);
    });
  }

  /* ------------------------------------------------------------------ limitations & improvements */

  /**
   * Short comment for a limitations / improvements column. The credited and rejected answers (with reasons) are in
   * the point's details { hits, misses, rejected, items }, which the report lists separately.
   */
  function liComment(col, max, noun) {
    var n = col.rejected.length;
    var c = (col.awarded >= max ? TICK : CROSS) + col.awarded + ' of ' + max + ' ' + noun + 's credited';
    if (col.hits.length) c += ': ' + col.hits.map(function (h) { return h.label; }).join('; ');
    if (n) c += ' (' + n + ' ' + plural(n, 'answer') + ' not credited)';
    return c + '.';
  }

  /**
   * Limitations and improvements, marked independently against a bank (max 4 each, skill ACE).
   * spec: { id?, limKey, impKey, bank, part, limPart?, impPart?, maxEach = 4, skill = 'ACE' }
   * @returns {MarkPoint[]} [limitations, improvements]
   */
  function limitationsImprovements(spec) {
    var maxEach = spec.maxEach || spec.max || 4;
    var base = spec.id || 'evaluation';
    function marked(ctx) {
      return VL.textmatch.markLimitationsImprovements(ctx.answer(spec.limKey), ctx.answer(spec.impKey), spec.bank || [], { maxEach: maxEach });
    }
    var lim = makePoint({ id: base + '-lim', part: spec.limPart || spec.part, skill: spec.skill, max: maxEach,
      label: spec.limLabel || 'Limitations' }, { skill: 'ACE' }, function (ctx) {
      var col = marked(ctx).limitations;
      if (!col.items.length) return result(0, CROSS + 'No limitations given.', col);
      return result(Math.min(this.max, col.awarded), liComment(col, this.max, 'limitation'), col);
    });
    var imp = makePoint({ id: base + '-imp', part: spec.impPart || spec.part, skill: spec.skill, max: maxEach,
      label: spec.impLabel || 'Improvements' }, { skill: 'ACE' }, function (ctx) {
      var col = marked(ctx).improvements;
      if (!col.items.length) return result(0, CROSS + 'No improvements given.', col);
      return result(Math.min(this.max, col.awarded), liComment(col, this.max, 'improvement'), col);
    });
    return [lim, imp];
  }

  /* ================================================================== runner */

  function emptyTable() {
    return VL.datatable && VL.datatable.create ? VL.datatable.create({ columns: 0, rows: 0 }) : { columns: [], rows: [], nextId: 1 };
  }

  function emptyGraph() {
    return VL.graph && VL.graph.create ? VL.graph.create() : null;
  }

  /**
   * Build the marking context for a question.
   * @param {object} exp experiment definition
   * @param {object} question { expId, variantId, seed, table, graph, answers, log }
   * @param {object} [params] hidden parameters (default: rebuilt from the seed)
   * @returns {object} ctx
   */
  function createContext(exp, question, params) {
    question = question || {};
    var variantId = question.variantId;
    if (params === undefined) params = exp.sampleParams(VL.rng.create(question.seed).fork('params'), variantId);
    var table = question.table && typeof question.table === 'object'
      ? (VL.datatable && VL.datatable.fromJSON ? VL.datatable.fromJSON(question.table) : question.table) : emptyTable();
    var graph = question.graph && typeof question.graph === 'object'
      ? (VL.graph && VL.graph.fromJSON ? VL.graph.fromJSON(question.graph) : question.graph) : emptyGraph();
    var quantities = [];
    try { quantities = typeof exp.quantities === 'function' ? (exp.quantities(variantId) || []) : (exp.quantities || []); } catch (e) { quantities = []; }
    var colInfo = identifyColumns(table, quantities);
    var answers = question.answers || {};
    var ctx = {
      exp: exp, variantId: variantId, params: params, question: question,
      table: table, graph: graph, answers: answers, log: question.log || [],
      quantities: quantities, colInfo: colInfo, cols: colInfo.map,
      answer: function (key) {
        var v = answers[key];
        return v === undefined || v === null ? '' : v;
      },
      num: function (s) { return parseNum(s); },
      vu: function (s, opts) { return parseVU(s, opts); },
      colsOf: function (ref) { return colsOf(ctx, ref); },
      values: function (ref) { return valuesOf(ctx, ref); },
      rowValues: function (row) { return rowValues(ctx, typeof row === 'string' ? rowsOf(ctx).filter(function (r) { return r.id === row; })[0] : row); }
    };
    return ctx;
  }

  /** Flatten paper parts (and subparts) to [{ id, label }] in paper order. */
  function paperParts(paper) {
    var out = [];
    ((paper && paper.parts) || []).forEach(function (p) {
      out.push({ id: p.id, label: p.label || p.id });
      (p.subparts || []).forEach(function (s) {
        var lab = s.label || s.id;
        if (p.label && lab.indexOf(p.label) !== 0) lab = p.label + lab;
        out.push({ id: s.id, label: lab });
      });
    });
    return out;
  }

  function flatten(list, out) {
    out = out || [];
    (list || []).forEach(function (x) {
      if (Array.isArray(x)) flatten(x, out);
      else if (x) out.push(x);
    });
    return out;
  }

  /**
   * Mark a question.
   * @param {object} exp experiment definition
   * @param {object} question Question (see contract §5); question.markedAt is used if given
   * @returns {object} Report
   */
  function run(exp, question) {
    question = question || {};
    var variantId = question.variantId;
    var params = exp.sampleParams(VL.rng.create(question.seed).fork('params'), variantId);
    var ctx = createContext(exp, question, params);
    var paper = null;
    try { paper = exp.paper(variantId, params); } catch (e) { paper = null; }
    ctx.paper = paper;
    var rubric = flatten(exp.rubric(variantId));

    var report = {
      expId: question.expId || exp.id, variantId: variantId, seed: question.seed,
      total: 0, max: 0, skills: {}, parts: [], points: [],
      modelAnswer: null, commonMistakes: [],
      markedAt: question.markedAt || new Date().toISOString()
    };
    SKILLS.forEach(function (s) { report.skills[s] = { got: 0, max: 0 }; });

    rubric.forEach(function (mp) {
      var max = Number(mp.max);
      if (!isFinite(max) || max < 0) max = 1;
      var r;
      try {
        r = mp.check.call(mp, ctx) || {};
      } catch (e) {
        r = { awarded: 0, comment: CROSS + 'This point could not be marked.', details: { error: String(e && e.message || e) } };
      }
      var awarded = Number(r.awarded);
      if (!isFinite(awarded)) awarded = 0;
      awarded = Math.max(0, Math.min(max, awarded));
      report.points.push({ id: mp.id, part: mp.part, skill: mp.skill, label: mp.label, max: max, awarded: awarded,
        comment: r.comment || '', details: r.details === undefined ? null : r.details });
      report.total += awarded;
      report.max += max;
      if (!report.skills[mp.skill]) report.skills[mp.skill] = { got: 0, max: 0 };
      report.skills[mp.skill].got += awarded;
      report.skills[mp.skill].max += max;
    });

    // per-part totals in paper order (parts with no paper entry are appended)
    var byPart = {};
    report.points.forEach(function (p) {
      if (!byPart[p.part]) byPart[p.part] = { got: 0, max: 0 };
      byPart[p.part].got += p.awarded;
      byPart[p.part].max += p.max;
    });
    var seen = {};
    paperParts(paper).forEach(function (pp) {
      if (!byPart[pp.id] || seen[pp.id]) return;
      seen[pp.id] = true;
      report.parts.push({ part: pp.id, label: pp.label, got: byPart[pp.id].got, max: byPart[pp.id].max });
    });
    report.points.forEach(function (p) {
      if (seen[p.part]) return;
      seen[p.part] = true;
      report.parts.push({ part: p.part, label: p.part === undefined ? '' : '(' + p.part + ')', got: byPart[p.part].got, max: byPart[p.part].max });
    });

    try {
      report.modelAnswer = exp.modelAnswer(params, variantId, VL.rng.create(question.seed).fork('model'));
    } catch (e) {
      report.modelAnswer = null;
    }
    try {
      var cm = typeof exp.commonMistakes === 'function' ? exp.commonMistakes(variantId) : exp.commonMistakes;
      report.commonMistakes = Array.isArray(cm) ? cm.slice() : [];
    } catch (e) {
      report.commonMistakes = [];
    }
    return report;
  }

  VL.marking = {
    run: run,
    createContext: createContext,
    identifyColumns: identifyColumns,
    parseConclusion: parseConclusion,
    points: {
      answerValue: answerValue,
      readingsCount: readingsCount,
      range: range,
      repeats: repeats,
      headings: headings,
      rawConsistency: rawConsistency,
      derivedSF: derivedSF,
      calc: calc,
      answerCalc: answerCalc,
      axes: axes,
      plotting: plotting,
      quality: quality,
      bestFit: bestFit,
      gradient: gradient,
      intercept: intercept,
      custom: custom,
      sfJustification: sfJustification,
      percentUncertainty: percentUncertainty,
      conclusion: conclusion,
      limitationsImprovements: limitationsImprovements
    },
    /** Helpers for experiment authors writing points.custom checks. */
    util: {
      resolve: resolve,
      graphQuantities: graphQuantities,
      wrongGraphComment: wrongGraphComment,
      parseRef: parseRef,
      colsOf: colsOf,
      valuesOf: valuesOf,
      cellsInRow: cellsInRow,
      rowValues: rowValues,
      nameOf: nameOf,
      unitTextOf: unitTextOf,
      cellSI: cellSI,
      fmt: fmt,
      fmtRange: fmtRange,
      fmtPlain: fmtPlain,
      prettyKey: prettyKey,
      listRows: listRows,
      prettySymbol: prettySymbol,
      requiredDp: requiredDp,
      answerText: answerText,
      firstAnswer: firstAnswer,
      TICK: TICK,
      CROSS: CROSS
    }
  };
})(globalThis.VLab = globalThis.VLab || {});
