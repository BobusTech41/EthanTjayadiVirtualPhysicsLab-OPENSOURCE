/**
 * Scientific calculator with a SAFE expression parser (no eval, no Function constructor).
 *
 *   VL.ui.calculator.mount(container, { idPrefix? }) -> { el, destroy(), evaluate(expr), clear() }   (browser only)
 *   VL.ui.calculator.evaluate(expr, { ans }) -> number           // throws CalcError { kind: 'syntax'|'maths' }
 *   VL.ui.calculator.tryEvaluate(expr, { ans }) -> { ok, value, error, kind }
 *   VL.ui.calculator.format(x) -> string                         // calculator-style display ('1.234 × 10⁻⁵')
 *
 * Supported: + - × ÷ * / ^ (right-associative), parentheses (missing closing brackets at the end are allowed),
 * unary minus, implicit multiplication before a name or bracket (2π, 3(4+1), 2sin(30) — binds tighter than ÷ as on
 * most scientific calculators, so 1/2π = 1/(2π)), scientific notation (1.2e-3, 1.2E3, 1.2×10^-3),
 * sqrt / √, sin cos tan in DEGREES and their inverses (asin / sin⁻¹ / arcsin …, results in degrees),
 * lg (log₁₀; 'log' is accepted as lg), ln, exp, abs, π / pi, e, Ans, superscripts (x², x³, x⁻¹).
 *
 * No DOM access at load time: the pure parser also runs in Node for tests.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  /* ================================================================== */
  /* Errors                                                              */
  /* ================================================================== */

  /**
   * Calculator error.
   * @param {'syntax'|'maths'} kind
   * @param {string} message
   */
  function CalcError(kind, message) {
    this.name = 'CalcError';
    this.kind = kind;
    this.message = message;
  }
  CalcError.prototype = Object.create(Error.prototype);
  CalcError.prototype.constructor = CalcError;

  function syntax(msg) { return new CalcError('syntax', msg || 'Syntax error'); }
  function maths(msg) { return new CalcError('maths', msg || 'Maths error'); }

  /* ================================================================== */
  /* Normalisation and tokenising                                        */
  /* ================================================================== */

  var SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };

  /**
   * Rewrite typed text into the plain grammar the parser understands.
   * @param {string} src
   * @returns {string}
   */
  function normalise(src) {
    var s = String(src === undefined || src === null ? '' : src);
    s = s.replace(/[−–—]/g, '-')
      .replace(/[×·∙⋅]/g, '*')
      .replace(/÷/g, '/')
      .replace(/π/g, ' pi ')
      .replace(/√/g, ' sqrt ');
    // inverse trig written with a superscript −1 or ^-1: sin⁻¹(x), sin^-1(x), arcsin(x)
    s = s.replace(/\b(sin|cos|tan)\s*(?:⁻¹|\^\s*\(?\s*-\s*1\s*\)?)/gi, function (m, f) { return ' a' + f.toLowerCase() + ' '; });
    s = s.replace(/\barc(sin|cos|tan)\b/gi, function (m, f) { return ' a' + f.toLowerCase() + ' '; });
    // other superscripts → ^(n)
    s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, function (run) {
      return '^(' + run.split('').map(function (c) { return SUP[c]; }).join('') + ')';
    });
    // "1.2x10^3" / "1.2 X 10^3" → multiplication
    s = s.replace(/(\d|\.)\s*[xX]\s*(?=\d)/g, '$1*');
    return s;
  }

  var NAMES = {
    sin: 'fn', cos: 'fn', tan: 'fn', asin: 'fn', acos: 'fn', atan: 'fn',
    sqrt: 'fn', lg: 'fn', log: 'fn', ln: 'fn', exp: 'fn', abs: 'fn',
    pi: 'const', e: 'const', ans: 'const'
  };

  /**
   * Split normalised text into tokens.
   * @returns {{type: string, value?: *}[]}
   */
  function tokenize(src) {
    var s = normalise(src);
    var out = [];
    var i = 0;
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        var m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
        if (!m) throw syntax('Syntax error: misplaced decimal point');
        var str = m[0];
        // A lone 'e' after digits that is not followed by an exponent is the constant e (2e = 2 × e).
        out.push({ type: 'num', value: Number(str), text: str });
        i += str.length;
        if (s[i] === '.') throw syntax('Syntax error: two decimal points in one number');
        continue;
      }
      if (/[a-zA-Z]/.test(c)) {
        var w = /^[a-zA-Z]+/.exec(s.slice(i))[0];
        var name = w.toLowerCase();
        if (w === 'Ans' || name === 'ans') name = 'ans';
        if (!NAMES[name]) throw syntax('Syntax error: unknown name “' + w + '”');
        out.push({ type: NAMES[name], value: name === 'log' ? 'lg' : name });
        i += w.length;
        continue;
      }
      if ('+-*/^'.indexOf(c) !== -1) { out.push({ type: 'op', value: c }); i++; continue; }
      if (c === '(' || c === '[') { out.push({ type: 'lp' }); i++; continue; }
      if (c === ')' || c === ']') { out.push({ type: 'rp' }); i++; continue; }
      if (c === ',') throw syntax('Syntax error: use a decimal point, not a comma');
      throw syntax('Syntax error: unexpected “' + c + '”');
    }
    return out;
  }

  /* ================================================================== */
  /* Maths helpers (degrees)                                             */
  /* ================================================================== */

  var DEG = Math.PI / 180;

  function mod(a, n) { return ((a % n) + n) % n; }
  function isMultiple(x, n) { var r = mod(x, n); return Math.abs(r) < 1e-10 || Math.abs(r - n) < 1e-10; }

  function sinDeg(x) {
    if (isMultiple(x, 180)) return 0;
    if (isMultiple(x - 90, 360)) return 1;
    if (isMultiple(x - 270, 360)) return -1;
    if (isMultiple(x - 30, 360) || isMultiple(x - 150, 360)) return 0.5;
    if (isMultiple(x - 210, 360) || isMultiple(x - 330, 360)) return -0.5;
    return Math.sin(x * DEG);
  }
  function cosDeg(x) { return sinDeg(x + 90); }
  function tanDeg(x) {
    if (isMultiple(x - 90, 180)) throw maths('Maths error: tan 90° is undefined');
    if (isMultiple(x, 180)) return 0;
    if (isMultiple(x - 45, 180)) return 1;
    if (isMultiple(x - 135, 180)) return -1;
    return Math.tan(x * DEG);
  }

  function applyFn(name, x) {
    var r;
    switch (name) {
      case 'sin': r = sinDeg(x); break;
      case 'cos': r = cosDeg(x); break;
      case 'tan': r = tanDeg(x); break;
      case 'asin':
        if (x < -1 || x > 1) throw maths('Maths error: sin⁻¹ needs a value from −1 to 1');
        r = Math.asin(x) / DEG; break;
      case 'acos':
        if (x < -1 || x > 1) throw maths('Maths error: cos⁻¹ needs a value from −1 to 1');
        r = Math.acos(x) / DEG; break;
      case 'atan': r = Math.atan(x) / DEG; break;
      case 'sqrt':
        if (x < 0) throw maths('Maths error: square root of a negative number');
        r = Math.sqrt(x); break;
      case 'lg':
        if (x <= 0) throw maths('Maths error: lg needs a positive number');
        r = Math.log10(x); break;
      case 'ln':
        if (x <= 0) throw maths('Maths error: ln needs a positive number');
        r = Math.log(x); break;
      case 'exp': r = Math.exp(x); break;
      case 'abs': r = Math.abs(x); break;
      default: throw syntax('Syntax error: unknown function ' + name);
    }
    return r;
  }

  function power(a, b) {
    if (a === 0 && b < 0) throw maths('Maths error: division by zero');
    var r = Math.pow(a, b);
    if (isNaN(r)) {
      // negative base with an odd-root exponent such as (−8)^(1/3)
      if (a < 0) {
        var inv = 1 / b, k = Math.round(inv);
        if (Math.abs(inv - k) < 1e-9 && k % 2 !== 0) return -Math.pow(-a, b);
      }
      throw maths('Maths error: negative number to a fractional power');
    }
    return r;
  }

  /* ================================================================== */
  /* Recursive-descent parser that evaluates as it goes                  */
  /* ================================================================== */

  /**
   * Evaluate an expression.
   * @param {string} expr
   * @param {{ans?: number}} [opts]
   * @returns {number}
   * @throws {CalcError}
   */
  function evaluate(expr, opts) {
    opts = opts || {};
    var toks = tokenize(expr);
    if (!toks.length) throw syntax('Nothing to calculate');
    var pos = 0;
    var ans = typeof opts.ans === 'number' && isFinite(opts.ans) ? opts.ans : 0;

    function peek() { return toks[pos]; }
    function isOp(t, v) { return t && t.type === 'op' && t.value === v; }
    function startsOperand(t) { return t && (t.type === 'num' || t.type === 'fn' || t.type === 'const' || t.type === 'lp'); }

    // expr := term (('+'|'-') term)*
    function parseExpr() {
      var v = parseTerm();
      while (isOp(peek(), '+') || isOp(peek(), '-')) {
        var op = toks[pos++].value;
        var r = parseTerm();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    // term := implicit (('*'|'/') implicit)*
    function parseTerm() {
      var v = parseImplicit();
      while (isOp(peek(), '*') || isOp(peek(), '/')) {
        var op = toks[pos++].value;
        var r = parseImplicit();
        if (op === '*') v = v * r;
        else {
          if (r === 0) throw maths('Maths error: division by zero');
          v = v / r;
        }
      }
      return v;
    }
    // implicit := unary ( (name | '(') unary )*      e.g. 2π, 3(4+1), 2sin(30)
    function parseImplicit() {
      var v = parseUnary();
      while (peek() && (peek().type === 'fn' || peek().type === 'const' || peek().type === 'lp')) {
        v = v * parseUnary();
      }
      return v;
    }
    // unary := ('+'|'-') unary | power
    function parseUnary() {
      if (isOp(peek(), '-')) { pos++; return -parseUnary(); }
      if (isOp(peek(), '+')) { pos++; return parseUnary(); }
      return parsePower();
    }
    // power := primary ('^' unary)?     (right-associative because the exponent is a unary expression)
    function parsePower() {
      var base = parsePrimary();
      if (isOp(peek(), '^')) {
        pos++;
        if (!peek()) throw syntax('Syntax error: missing power');
        var ex = parseUnary();
        return power(base, ex);
      }
      return base;
    }
    function parsePrimary() {
      var t = peek();
      if (!t) throw syntax('Syntax error: expression ends too early');
      if (t.type === 'num') {
        pos++;
        if (peek() && peek().type === 'num') throw syntax('Syntax error: two numbers next to each other');
        return t.value;
      }
      if (t.type === 'const') {
        pos++;
        if (t.value === 'pi') return Math.PI;
        if (t.value === 'e') return Math.E;
        return ans;
      }
      if (t.type === 'lp') {
        pos++;
        var v = parseExpr();
        if (peek() && peek().type === 'rp') pos++;
        else if (peek()) throw syntax('Syntax error: missing “)”');
        // a missing ')' at the very end is allowed, as on a calculator
        return v;
      }
      if (t.type === 'fn') {
        pos++;
        var arg;
        if (peek() && peek().type === 'lp') arg = parsePrimary();
        else if (startsOperand(peek()) || isOp(peek(), '-')) arg = parseUnary();
        else throw syntax('Syntax error: ' + t.value + ' needs a value, e.g. ' + t.value + '(30)');
        return applyFn(t.value, arg);
      }
      if (t.type === 'rp') throw syntax('Syntax error: unexpected “)”');
      throw syntax('Syntax error: unexpected “' + t.value + '”');
    }

    var result = parseExpr();
    if (pos < toks.length) {
      var t = toks[pos];
      if (t.type === 'rp') throw syntax('Syntax error: too many “)”');
      throw syntax('Syntax error');
    }
    if (!isFinite(result)) throw maths('Maths error: result too large');
    return result;
  }

  /**
   * Evaluate without throwing.
   * @returns {{ok: boolean, value: number, error: string|null, kind: string|null}}
   */
  function tryEvaluate(expr, opts) {
    try {
      return { ok: true, value: evaluate(expr, opts), error: null, kind: null };
    } catch (e) {
      if (e instanceof CalcError) return { ok: false, value: NaN, error: e.message, kind: e.kind };
      return { ok: false, value: NaN, error: 'Syntax error', kind: 'syntax' };
    }
  }

  var SUP_DIGITS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '' };

  /**
   * Format a result like a scientific calculator (10 significant figures, trailing zeros removed).
   * Plain notation for 1e-4 <= |x| < 1e10, otherwise 'm × 10ⁿ'.
   * @param {number} x
   * @returns {string}
   */
  function format(x) {
    if (typeof x !== 'number' || !isFinite(x)) return 'Error';
    if (x === 0 || Math.abs(x) < 1e-99) return '0';
    var a = Math.abs(x);
    if (a >= 1e-4 && a < 1e10) {
      var s = Number(x.toPrecision(10)).toString();
      if (/e/.test(s)) s = Number(x.toPrecision(10)).toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
      return s.replace(/^-/, '−');
    }
    var parts = x.toExponential(9).split('e');
    var mant = parts[0].replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    var exp = String(Number(parts[1]));
    var supExp = exp.split('').map(function (c) { return SUP_DIGITS[c]; }).join('');
    return (mant + ' × 10' + supExp).replace(/^-/, '−');
  }

  /* ================================================================== */
  /* DOM component (browser only)                                        */
  /* ================================================================== */

  // [label, text to insert | action, aria-label, extra class]
  var KEYS = [
    ['sin', 'sin(', 'sine (degrees)'], ['cos', 'cos(', 'cosine (degrees)'], ['tan', 'tan(', 'tangent (degrees)'],
    ['sin⁻¹', 'sin⁻¹(', 'inverse sine'], ['cos⁻¹', 'cos⁻¹(', 'inverse cosine'],
    ['tan⁻¹', 'tan⁻¹(', 'inverse tangent'], ['√', '√(', 'square root'], ['x²', '²', 'squared'],
    ['xʸ', '^', 'to the power'], ['x⁻¹', '⁻¹', 'reciprocal'],
    ['lg', 'lg(', 'log base 10'], ['ln', 'ln(', 'natural log'], ['eˣ', 'e^(', 'e to the power'],
    ['10ˣ', '10^(', '10 to the power'], ['π', 'π', 'pi'],
    ['(', '(', 'open bracket'], [')', ')', 'close bracket'], ['×10ˣ', '×10^', 'times ten to the power'],
    ['Ans', 'Ans', 'previous answer'], ['e', 'e', 'the constant e'],
    ['7', '7'], ['8', '8'], ['9', '9'], ['DEL', '@del', 'delete', 'vl-calc-key--fn'], ['AC', '@clear', 'all clear', 'vl-calc-key--fn'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['×', '×', 'multiply', 'vl-calc-key--op'], ['÷', '÷', 'divide', 'vl-calc-key--op'],
    ['1', '1'], ['2', '2'], ['3', '3'], ['+', '+', 'plus', 'vl-calc-key--op'], ['−', '−', 'minus', 'vl-calc-key--op'],
    ['0', '0'], ['.', '.', 'decimal point'], ['=', '@eval', 'equals', 'vl-calc-key--eq']
  ];

  var mountCount = 0;

  /**
   * Mount the calculator.
   * @param {HTMLElement} container
   * @param {{title?: string}} [opts]
   * @returns {{el: HTMLElement, destroy: function(), evaluate: function(string): object, clear: function()}}
   */
  function mount(container, opts) {
    opts = opts || {};
    var h = ui.h;
    mountCount++;
    var id = 'vl-calc-' + mountCount;
    var state = { ans: 0, history: [], justEvaluated: false, recall: -1 };

    var input = h('input', {
      class: 'vl-calc-input', id: id + '-in', type: 'text', autocomplete: 'off', spellcheck: 'false',
      autocapitalize: 'off', 'aria-describedby': id + '-res', placeholder: 'Type or tap, e.g. 4π^2/2.47'
    });
    var result = h('output', { class: 'vl-calc-result', id: id + '-res', 'aria-live': 'polite', for: id + '-in' }, '0');
    var historyList = h('ol', { class: 'vl-calc-history-list', reversed: true });
    var historyEmpty = h('p', { class: 'vl-calc-history-empty' }, 'No calculations yet.');

    var keys = h('div', { class: 'vl-calc-keys', role: 'group', 'aria-label': 'Calculator keys' });
    KEYS.forEach(function (k) {
      keys.appendChild(h('button', {
        type: 'button', class: 'vl-calc-key' + (k[3] ? ' ' + k[3] : ''),
        'aria-label': k[2] || k[0], title: k[2] || k[0],
        on: { click: function () { press(k[1]); } }
      }, k[0]));
    });

    var root = h('section', { class: 'vl-calc', 'aria-labelledby': id + '-title' },
      h('div', { class: 'vl-calc-head' },
        h('h3', { class: 'vl-calc-title', id: id + '-title' }, opts.title || 'Calculator'),
        h('span', { class: 'vl-calc-mode', title: 'Angles are in degrees' }, 'DEG')),
      h('div', { class: 'vl-calc-screen' },
        h('label', { class: 'vl-sr-only', for: id + '-in' }, 'Expression'),
        input,
        result),
      keys,
      h('details', { class: 'vl-calc-history' },
        h('summary', null, 'History'),
        historyEmpty,
        historyList),
      h('p', { class: 'vl-calc-help' },
        'Angles in degrees. Enter = calculate, Esc = clear, ↑/↓ = previous calculations. ',
        'Write 1.2×10^-3 or 1.2e-3 for standard form.'));

    container.appendChild(root);

    function setResult(text, isError) {
      result.textContent = text;
      result.classList.toggle('vl-calc-result--error', !!isError);
      input.setAttribute('aria-invalid', isError ? 'true' : 'false');
    }

    function insert(text) {
      var start = input.selectionStart, end = input.selectionEnd;
      if (typeof start !== 'number') { start = end = input.value.length; }
      if (state.justEvaluated) {
        state.justEvaluated = false;
        if (/^[+\-−×÷*/^²⁻]/.test(text)) { input.value = 'Ans'; start = end = 3; }
        else { input.value = ''; start = end = 0; }
      }
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      var caret = start + text.length;
      input.setSelectionRange(caret, caret);
    }

    function press(k) {
      if (k === '@eval') { calc(); return; }
      if (k === '@clear') { clear(); input.focus(); return; }
      if (k === '@del') {
        state.justEvaluated = false;
        var s = input.selectionStart, e = input.selectionEnd;
        if (typeof s !== 'number') s = e = input.value.length;
        if (s === e && s > 0) s--;
        input.value = input.value.slice(0, s) + input.value.slice(e);
        input.setSelectionRange(s, s);
        input.focus();
        return;
      }
      insert(k);
      input.focus();
    }

    function calc() {
      var expr = input.value.trim();
      if (!expr) { input.focus(); return null; }
      var r = tryEvaluate(expr, { ans: state.ans });
      if (r.ok) {
        state.ans = r.value;
        var shown = format(r.value);
        setResult('= ' + shown, false);
        state.history.unshift({ expr: expr, value: r.value, shown: shown });
        if (state.history.length > 30) state.history.pop();
        renderHistory();
        state.justEvaluated = true;
      } else {
        setResult(r.error, true);
        state.justEvaluated = false;
      }
      state.recall = -1;
      input.focus();
      return r;
    }

    function clear() {
      input.value = '';
      setResult('0', false);
      state.justEvaluated = false;
      state.recall = -1;
    }

    function renderHistory() {
      ui.clear(historyList);
      historyEmpty.hidden = state.history.length > 0;
      state.history.forEach(function (item) {
        historyList.appendChild(h('li', null,
          h('button', {
            type: 'button', class: 'vl-calc-hist-btn', title: 'Use this calculation again',
            on: { click: function () { input.value = item.expr; state.justEvaluated = false; input.focus(); } }
          }, h('span', { class: 'vl-calc-hist-expr' }, item.expr), ' ', h('span', { class: 'vl-calc-hist-val' }, '= ' + item.shown))));
      });
    }
    renderHistory();

    function onKeyDown(ev) {
      if (ev.key === 'Enter' || (ev.key === '=' && !ev.shiftKey)) { ev.preventDefault(); calc(); return; }
      if (ev.key === 'Escape') { if (input.value) { ev.preventDefault(); ev.stopPropagation(); clear(); } return; }
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        if (!state.history.length) return;
        ev.preventDefault();
        state.recall += ev.key === 'ArrowUp' ? 1 : -1;
        state.recall = Math.max(-1, Math.min(state.history.length - 1, state.recall));
        input.value = state.recall >= 0 ? state.history[state.recall].expr : '';
        state.justEvaluated = false;
        return;
      }
      if (state.justEvaluated && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1) {
        state.justEvaluated = false;
        if (/[+\-*/^]/.test(ev.key)) { input.value = 'Ans'; input.setSelectionRange(3, 3); }
        else { input.value = ''; }
      } else if (ev.key.length === 1 || ev.key === 'Backspace' || ev.key === 'Delete') {
        state.justEvaluated = false;
      }
    }
    input.addEventListener('keydown', onKeyDown);

    return {
      el: root,
      /** Evaluate an expression as if typed (for tests and other tools). */
      evaluate: function (expr) { input.value = expr; state.justEvaluated = false; return calc(); },
      clear: clear,
      destroy: function () {
        input.removeEventListener('keydown', onKeyDown);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  ui.calculator = {
    mount: mount,
    evaluate: evaluate,
    tryEvaluate: tryEvaluate,
    format: format,
    tokenize: tokenize,
    normalise: normalise,
    CalcError: CalcError
  };
})(globalThis.VLab = globalThis.VLab || {});
