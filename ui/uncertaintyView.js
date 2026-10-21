/**
 * Tools tab (browser only for mounting; the computations are pure and also run in Node).
 *
 *   VL.ui.uncertaintyView.mount(container, { graph, table, extension, mode }) -> { el, destroy(), calculator }
 *
 * Exam mode shows only the calculator (as in a real exam). Practice mode adds:
 *   - repeated readings: mean, half-range absolute uncertainty, percentage uncertainty;
 *   - combining uncertainties: products / quotients / powers (percentage uncertainties add, × |power|) and a separate
 *     sum / difference mode (absolute uncertainties add);
 *   - gradient uncertainty from worst acceptable lines, labelled "Paper 5 extension".
 * The tools only calculate; the student still decides what to write and how to round it.
 *
 *   VL.ui.uncertaintyView.compute = { parseList(text), repeated(values), combineProduct(rows), combineSum(rows), worst(p1, p2) }
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  /* ================================================================== */
  /* Pure computations                                                   */
  /* ================================================================== */

  function parseNumber(str) {
    var s = String(str === undefined || str === null ? '' : str).trim();
    if (!s) return { ok: false, empty: true, value: NaN, dp: NaN, problem: null };
    if (VL.sigfig && typeof VL.sigfig.parse === 'function') {
      var p = VL.sigfig.parse(s);
      return { ok: p.ok, empty: false, value: p.value, dp: p.dp, problem: p.ok ? null : (p.problems[0] || 'not a number') };
    }
    var v = Number(s.replace(/[−–]/g, '-'));
    return { ok: isFinite(v), empty: false, value: v, dp: (s.split('.')[1] || '').length, problem: isFinite(v) ? null : 'not a number' };
  }

  /**
   * Split a typed list of readings (spaces, new lines or semicolons between readings).
   * @returns {{values: number[], strs: string[], bad: string[], dps: number[]}}
   */
  function parseList(text) {
    var out = { values: [], strs: [], bad: [], dps: [] };
    String(text || '').split(/[\s;]+/).forEach(function (tok) {
      if (!tok) return;
      var p = parseNumber(tok);
      if (p.ok) { out.values.push(p.value); out.strs.push(tok); out.dps.push(p.dp); }
      else out.bad.push(tok);
    });
    return out;
  }

  /** Mean, half-range and percentage uncertainty of repeated readings. */
  function repeated(values) {
    var v = (values || []).filter(function (x) { return isFinite(x); });
    if (!v.length) return null;
    if (VL.uncertainty && typeof VL.uncertainty.meanWithUncertainty === 'function') {
      var r = VL.uncertainty.meanWithUncertainty(v);
      return { n: v.length, mean: r.mean, abs: r.abs, percent: r.percent, min: Math.min.apply(null, v), max: Math.max.apply(null, v) };
    }
    var mean = v.reduce(function (s, x) { return s + x; }, 0) / v.length;
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    var abs = (hi - lo) / 2;
    return { n: v.length, mean: mean, abs: abs, percent: mean ? 100 * Math.abs(abs / mean) : NaN, min: lo, max: hi };
  }

  /**
   * Products, quotients and powers: total % uncertainty = Σ |power| × (Δx / x) × 100.
   * @param {{value:number, abs:number, power?:number}[]} rows
   * @returns {{rows: {percent:number}[], percent:number}|null}
   */
  function combineProduct(rows) {
    var good = (rows || []).filter(function (r) { return isFinite(r.value) && r.value !== 0 && isFinite(r.abs); });
    if (!good.length) return null;
    var each = good.map(function (r) {
      var p = r.power === undefined || !isFinite(r.power) ? 1 : r.power;
      return { percent: 100 * Math.abs(p) * Math.abs(r.abs / r.value) };
    });
    var total;
    if (VL.uncertainty && typeof VL.uncertainty.product === 'function') total = VL.uncertainty.product(good.map(function (r) {
      return { value: r.value, abs: r.abs, power: r.power === undefined || !isFinite(r.power) ? 1 : r.power };
    })).percent;
    else total = each.reduce(function (s, e) { return s + e.percent; }, 0);
    return { rows: each, percent: total };
  }

  /** Sums and differences: total absolute uncertainty = Σ Δx. */
  function combineSum(rows) {
    var good = (rows || []).filter(function (r) { return isFinite(r.abs); });
    if (!good.length) return null;
    var abs = VL.uncertainty && typeof VL.uncertainty.sum === 'function'
      ? VL.uncertainty.sum(good.map(function (r) { return { abs: r.abs }; }))
      : good.reduce(function (s, r) { return s + Math.abs(r.abs); }, 0);
    return { abs: abs };
  }

  /** Worst acceptable lines through the error-bar corners of the first and last points (Paper 5 extension). */
  function worst(p1, p2) {
    var pts = [p1, p2];
    if (!pts.every(function (p) { return p && isFinite(p.x) && isFinite(p.y); })) return null;
    if (p1.x === p2.x) return null;
    if (VL.uncertainty && typeof VL.uncertainty.worstLine === 'function') return VL.uncertainty.worstLine(pts);
    var m = (p2.y - p1.y) / (p2.x - p1.x);
    var s = m >= 0 ? 1 : -1;
    function line(a, b) { var mm = (b.y - a.y) / (b.x - a.x); return { m: mm, c: a.y - mm * a.x }; }
    var steep = line({ x: p1.x + (p1.ex || 0), y: p1.y - s * (p1.ey || 0) }, { x: p2.x - (p2.ex || 0), y: p2.y + s * (p2.ey || 0) });
    var shallow = line({ x: p1.x - (p1.ex || 0), y: p1.y + s * (p1.ey || 0) }, { x: p2.x + (p2.ex || 0), y: p2.y - s * (p2.ey || 0) });
    var best = line(p1, p2);
    return { best: best, steep: steep, shallow: shallow, dm: Math.max(Math.abs(steep.m - best.m), Math.abs(best.m - shallow.m)) };
  }

  /** Format a computed value to n significant figures (unrounded working values are shown to 5 s.f.). */
  function fmt(x, n) {
    if (!isFinite(x)) return '—';
    n = n || 5;
    var s = VL.sigfig && VL.sigfig.formatSF ? VL.sigfig.formatSF(x, n) : String(Number(x.toPrecision(n)));
    return s.replace(/^-/, '−');
  }

  /* ================================================================== */
  /* DOM                                                                 */
  /* ================================================================== */

  var mountCount = 0;

  function mount(container, opts) {
    opts = opts || {};
    var h = ui.h;
    var exam = opts.mode === 'exam';
    var idBase = 'vl-tools-' + (++mountCount);
    var cleanups = [];
    var root = h('div', { class: 'vl-tools' });
    container.appendChild(root);

    /* ---------------------------------------------------------------- calculator */
    var calcBox = h('div', { class: 'vl-tools-calc' });
    root.appendChild(calcBox);
    var calc = null;
    if (ui.calculator && typeof ui.calculator.mount === 'function') {
      calc = ui.calculator.mount(calcBox, { title: 'Calculator' });
      cleanups.push(function () { calc.destroy(); });
    } else {
      calcBox.appendChild(h('p', { class: 'vl-placeholder' }, 'The calculator is not available.'));
    }

    if (exam) {
      root.appendChild(h('p', { class: 'vl-tools-note' },
        'Exam mode: only a calculator is available, as in the real examination. The uncertainty tools are in practice mode.'));
      return finish();
    }

    root.appendChild(h('p', { class: 'vl-tools-note' },
      'These tools only do the arithmetic. You still decide which readings to use, and you round and record the results yourself.'));

    /* ---------------------------------------------------------------- repeated readings */
    (function () {
      var taId = idBase + '-rep';
      var ta = h('textarea', { class: 'vl-input vl-tools-ta', id: taId, rows: '3', spellcheck: 'false',
        placeholder: 'e.g. 31.62 31.85 31.70', 'aria-describedby': taId + '-help' });
      var out = h('dl', { class: 'vl-tools-out' });
      var warn = h('p', { class: 'vl-tools-warn', role: 'status' });
      function update() {
        var list = parseList(ta.value);
        var r = repeated(list.values);
        ui.clear(out);
        warn.textContent = '';
        if (list.bad.length) warn.textContent = '⚠ Not understood: ' + list.bad.join(', ') + ' (use a decimal point; separate readings with spaces).';
        else if (list.dps.length > 1 && list.dps.some(function (d) { return d !== list.dps[0]; })) {
          warn.textContent = '⚠ Your readings have different numbers of decimal places. Raw readings of one quantity should all be recorded to the same precision.';
        }
        if (!r) return;
        addOut(out, 'Number of readings', String(r.n));
        addOut(out, 'Mean (unrounded)', fmt(r.mean, 6));
        var hiStr = list.strs[list.values.indexOf(r.max)], loStr = list.strs[list.values.indexOf(r.min)];
        addOut(out, 'Absolute uncertainty = ½ × range', r.n > 1 ? fmt(r.abs, 3) + '  (½ × (' + hiStr + ' − ' + loStr + '))' : 'needs at least two readings');
        addOut(out, 'Percentage uncertainty', r.n > 1 && isFinite(r.percent) ? fmt(r.percent, 3) + ' %' : '—');
      }
      ta.addEventListener('input', update);
      root.appendChild(section('Repeated readings', [
        h('label', { class: 'vl-label', for: taId }, 'Your repeated readings of one quantity'),
        h('p', { class: 'vl-help', id: taId + '-help' }, 'One reading per line, or separated by spaces.'),
        ta, warn, out,
        h('p', { class: 'vl-help' }, 'Usually quote the absolute uncertainty to 1 significant figure (2 at most) and the mean to the same number of decimal places as the uncertainty.')
      ]));
    })();

    /* ---------------------------------------------------------------- combining */
    (function () {
      var mode = 'product';
      var rows = [];
      var tbody = h('tbody');
      var out = h('dl', { class: 'vl-tools-out' });
      var resultId = idBase + '-cres';
      var resultInput = h('input', { class: 'vl-input vl-input--num', id: resultId, type: 'text', autocomplete: 'off', placeholder: 'optional' });
      var powerHead = h('th', { scope: 'col' }, 'Power');
      var resultRow = h('div', { class: 'vl-field vl-field--inline' },
        h('label', { class: 'vl-label', for: resultId }, 'Value of the final result (to find its absolute uncertainty)'), resultInput);
      var explain = h('p', { class: 'vl-help' });

      function addRow() {
        var r = { name: inp('quantity', 'e.g. L'), value: inp('value', ''), abs: inp('absolute uncertainty', ''), power: inp('power', '1') };
        r.power.value = '1';
        r.pctCell = h('td', { class: 'vl-num vl-tools-pct' });
        r.powerCell = h('td', null, r.power);
        r.tr = h('tr', null, h('td', null, r.name), h('td', null, r.value), h('td', null, r.abs), r.powerCell, r.pctCell,
          h('td', null, h('button', { type: 'button', class: 'vl-btn vl-btn--small vl-btn--ghost', 'aria-label': 'Remove this row',
            on: { click: function () { rows = rows.filter(function (x) { return x !== r; }); r.tr.remove(); update(); } } }, '✕')));
        rows.push(r);
        tbody.appendChild(r.tr);
        [r.name, r.value, r.abs, r.power].forEach(function (el) { el.addEventListener('input', update); });
        update();
        return r;
      }
      function inp(label, ph) {
        return h('input', { class: 'vl-input vl-input--cell', type: 'text', autocomplete: 'off', 'aria-label': label, placeholder: ph });
      }
      function update() {
        powerHead.hidden = mode !== 'product';
        resultRow.hidden = mode !== 'product';
        rows.forEach(function (r) { r.powerCell.hidden = mode !== 'product'; });
        explain.textContent = mode === 'product'
          ? 'For y = k × a^p × b^q (k exact): %Δy = |p| × %Δa + |q| × %Δb. Dividing by b is the same as a power of −1.'
          : 'For y = a + b or y = a − b: Δy = Δa + Δb (absolute uncertainties always add, even when subtracting).';
        ui.clear(out);
        var parsed = rows.map(function (r) {
          return { value: parseNumber(r.value.value).value, abs: parseNumber(r.abs.value).value, power: parseNumber(r.power.value).ok ? parseNumber(r.power.value).value : 1, r: r };
        });
        if (mode === 'product') {
          parsed.forEach(function (p) {
            p.r.pctCell.textContent = isFinite(p.value) && p.value !== 0 && isFinite(p.abs)
              ? fmt(100 * Math.abs(p.power) * Math.abs(p.abs / p.value), 3) + ' %' : '';
          });
          var res = combineProduct(parsed);
          if (!res) return;
          addOut(out, 'Total percentage uncertainty', fmt(res.percent, 3) + ' %');
          var y = parseNumber(resultInput.value);
          if (y.ok) addOut(out, 'Absolute uncertainty of the result', fmt(Math.abs(y.value) * res.percent / 100, 3));
        } else {
          parsed.forEach(function (p) { p.r.pctCell.textContent = ''; });
          var s = combineSum(parsed);
          if (s) addOut(out, 'Total absolute uncertainty', fmt(s.abs, 3));
        }
      }
      resultInput.addEventListener('input', update);
      var name = idBase + '-mode';
      var modes = h('fieldset', { class: 'vl-radios' },
        h('legend', { class: 'vl-label' }, 'The result is calculated by'),
        radio(name, 'product', 'multiplying, dividing or raising to powers', true),
        radio(name, 'sum', 'adding or subtracting', false));
      modes.addEventListener('change', function (ev) { if (ev.target.name === name) { mode = ev.target.value; update(); } });
      function radio(nm, value, label, checked) {
        var id = nm + '-' + value;
        return h('div', { class: 'vl-radio' },
          h('input', { type: 'radio', name: nm, id: id, value: value, checked: checked }),
          h('label', { for: id }, label));
      }
      var table = h('table', { class: 'vl-tools-table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Quantity'), h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'Absolute uncertainty'),
          powerHead, h('th', { scope: 'col' }, '% contribution'), h('th', { scope: 'col' }, h('span', { class: 'vl-sr-only' }, 'Remove')))),
        tbody);
      root.appendChild(section('Combining uncertainties', [
        modes, explain,
        h('div', { class: 'vl-tools-scroll' }, table),
        h('button', { type: 'button', class: 'vl-btn vl-btn--small', on: { click: function () { addRow().name.focus(); } } }, '+ Add a quantity'),
        resultRow, out
      ]));
      addRow(); addRow();
    })();

    /* ---------------------------------------------------------------- worst line (Paper 5 extension) */
    (function () {
      var f = {};
      function field(key, label) {
        var id = idBase + '-w-' + key;
        f[key] = h('input', { class: 'vl-input vl-input--num', id: id, type: 'text', autocomplete: 'off' });
        f[key].addEventListener('input', update);
        return h('div', { class: 'vl-field vl-field--inline' }, h('label', { class: 'vl-label', for: id }, label), f[key]);
      }
      var out = h('dl', { class: 'vl-tools-out' });
      function val(k) { var p = parseNumber(f[k].value); return p.ok ? p.value : (p.empty ? 0 : NaN); }
      function req(k) { var p = parseNumber(f[k].value); return p.ok ? p.value : NaN; }
      function update() {
        ui.clear(out);
        var p1 = { x: req('x1'), y: req('y1'), ex: val('ex1'), ey: val('ey1') };
        var p2 = { x: req('x2'), y: req('y2'), ex: val('ex2'), ey: val('ey2') };
        var r = worst(p1, p2);
        if (!r) return;
        addOut(out, 'Gradient of the line through the two points', fmt(r.best.m, 4));
        addOut(out, 'Steepest worst acceptable line', fmt(r.steep.m, 4));
        addOut(out, 'Shallowest worst acceptable line', fmt(r.shallow.m, 4));
        addOut(out, 'Uncertainty in the gradient', fmt(r.dm, 2) + (r.best.m ? '  (' + fmt(100 * r.dm / Math.abs(r.best.m), 2) + ' %)' : ''));
      }
      var details = h('details', { class: 'vl-tools-ext' },
        h('summary', null, 'Gradient uncertainty from worst lines ', h('span', { class: 'vl-tag vl-tag--ext' }, 'extension')),
        h('p', { class: 'vl-help' }, 'Extension (not marked). Enter the first and last plotted points and the half-lengths of their error bars. The worst acceptable lines join opposite corners of the error bars.'),
        h('div', { class: 'vl-tools-grid' },
          h('fieldset', { class: 'vl-fieldset' }, h('legend', null, 'First point'), field('x1', 'x'), field('y1', 'y'), field('ex1', 'error bar ±x (optional)'), field('ey1', 'error bar ±y')),
          h('fieldset', { class: 'vl-fieldset' }, h('legend', null, 'Last point'), field('x2', 'x'), field('y2', 'y'), field('ex2', 'error bar ±x (optional)'), field('ey2', 'error bar ±y'))),
        out);
      root.appendChild(h('section', { class: 'vl-tools-section' }, details));
    })();

    function section(title, children) {
      var id = idBase + '-s' + (++mountCount);
      return h('section', { class: 'vl-tools-section', 'aria-labelledby': id },
        h('h3', { class: 'vl-tools-title', id: id }, title), children);
    }
    function addOut(dl, term, value) {
      dl.appendChild(h('div', { class: 'vl-tools-outrow' }, h('dt', null, term), h('dd', null, value)));
    }

    return finish();

    function finish() {
      return {
        el: root,
        calculator: calc,
        destroy: function () {
          cleanups.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
          if (root.parentNode) root.parentNode.removeChild(root);
        }
      };
    }
  }

  ui.uncertaintyView = {
    mount: mount,
    compute: { parseList: parseList, repeated: repeated, combineProduct: combineProduct, combineSum: combineSum, worst: worst, parseNumber: parseNumber }
  };
})(globalThis.VLab = globalThis.VLab || {});
