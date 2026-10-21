/**
 * Question paper (browser only). Contract §6 and §9.
 *
 *   VL.ui.paperView.mount(container, {
 *     paper,                      // Paper (see docs/ARCHITECTURE.md §6); intro / part html are trusted (authored by us)
 *     answers,                    // { key: string | string[] } — read only here; changes go through onAnswer
 *     readOnly,                   // after marking
 *     hints,                      // practice only: an object { partId: html } (or true together with hintTexts)
 *     hintTexts?,                 // alternative place for the hint map
 *     apparatusList?,             // string[] for "You are provided with …"
 *     title?,                     // overrides paper.title (e.g. 'Question 2' in an exam)
 *     onAnswer(key, value),       // value: exact string typed, or string[] for 'list'
 *     onFocusAnswer(target),      // record target { kind: 'answer', tab: 'paper', label, key, write(str), current(),
 *                                 //   appends? } — current() is the box's present text; appends = true for text boxes,
 *                                 //   whose write() adds a line instead of replacing what is there
 *     onGoto(tab),                // 'table' | 'graph' | 'tools'
 *     statusFor(type)             // 'table' | 'graph' -> short status line (e.g. '6 rows with data')
 *   }) -> { el, destroy(), refreshStatus(), setReadOnly(bool), focusAnswer(key) }
 *
 * Laid out like an exam paper: serif type, part labels on the left, [marks] right-aligned in the margin,
 * dotted answer lines, "[Total: n]" at the end.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var mountCount = 0;

  /** Sum of marks over parts and subparts (used when paper.totalMarks is missing). */
  function totalMarks(paper) {
    var sum = 0;
    (paper && paper.parts || []).forEach(function walk(p) {
      if (typeof p.marks === 'number') sum += p.marks;
      (p.subparts || []).forEach(walk);
    });
    return sum;
  }

  /** "(c)" + "(ii)" -> "(c)(ii)"; avoids doubling when the subpart label already includes the parent. */
  function joinLabels(parent, own) {
    if (!parent) return own || '';
    if (!own) return parent;
    if (own.indexOf(parent) === 0) return own;
    return parent + own;
  }

  function mount(container, opts) {
    opts = opts || {};
    var h = ui.h;
    var paper = opts.paper || { parts: [] };
    var answers = opts.answers || {};
    var readOnly = !!opts.readOnly;
    var idBase = 'vl-paper-' + (++mountCount);
    var hintMap = opts.hints && typeof opts.hints === 'object' ? opts.hints
      : (opts.hints && opts.hintTexts && typeof opts.hintTexts === 'object' ? opts.hintTexts : null);
    var fields = [];          // { el, key, index? }
    var statusEls = [];       // { el, type }
    var inputsByKey = {};
    var counter = 0;

    function emit(key, value) {
      if (readOnly) return;
      if (typeof opts.onAnswer === 'function') {
        try { opts.onAnswer(key, value); } catch (e) { console.error('[paperView onAnswer]', e); }
      }
    }

    function focusTarget(target) {
      if (readOnly) return;
      if (typeof opts.onFocusAnswer === 'function') {
        try { opts.onFocusAnswer(target); } catch (e) { console.error('[paperView onFocusAnswer]', e); }
      }
    }

    function flash(el) {
      el.classList.remove('vl-ans--flash');
      void el.offsetWidth;
      el.classList.add('vl-ans--flash');
      setTimeout(function () { el.classList.remove('vl-ans--flash'); }, 1200);
    }

    function goto(tab) {
      if (typeof opts.onGoto === 'function') opts.onGoto(tab);
    }

    /* ---------------------------------------------------------------- answer widgets */

    function valueLine(key, prefix, suffix, pathLabel, extraClass) {
      var inputId = idBase + '-a' + (++counter);
      var input = h('input', {
        class: 'vl-ans-line', id: inputId, type: 'text', autocomplete: 'off', spellcheck: 'false',
        autocapitalize: 'off', readOnly: readOnly, 'aria-readonly': readOnly ? 'true' : null,
        dataset: { key: key }
      });
      input.value = typeof answers[key] === 'string' ? answers[key] : '';
      if (!prefix) input.setAttribute('aria-label', 'Answer to ' + pathLabel);
      var label = (pathLabel + ' ' + (prefix || 'answer')).trim();
      input.addEventListener('input', function () { emit(key, input.value); });
      input.addEventListener('focus', function () {
        focusTarget({
          kind: 'answer', tab: 'paper', key: key, label: label,
          current: function () { return input.value; },
          write: function (str) {
            if (readOnly || !input.isConnected) return false;
            input.value = String(str);
            emit(key, input.value);
            flash(input);
            return true;
          }
        });
      });
      fields.push({ el: input, key: key });
      inputsByKey[key] = inputsByKey[key] || input;
      return h('div', { class: 'vl-ans vl-ans--value' + (extraClass ? ' ' + extraClass : '') },
        prefix ? h('label', { class: 'vl-ans-prefix', for: inputId }, prefix) : null,
        input,
        suffix ? h('span', { class: 'vl-ans-suffix' }, suffix) : null);
    }

    function textArea(key, rows, caption, pathLabel, ariaLabel) {
      var inputId = idBase + '-a' + (++counter);
      var ta = h('textarea', {
        class: 'vl-ans-text', id: inputId, rows: String(rows || 3), spellcheck: 'true',
        readOnly: readOnly, 'aria-readonly': readOnly ? 'true' : null,
        dataset: { key: key }
      });
      ta.value = typeof answers[key] === 'string' ? answers[key] : '';
      if (!caption) ta.setAttribute('aria-label', ariaLabel || ('Answer to ' + pathLabel));
      ta.addEventListener('input', function () { emit(key, ta.value); });
      ta.addEventListener('focus', function () {
        focusTarget({
          kind: 'answer', tab: 'paper', key: key, label: (pathLabel + ' ' + (caption || 'answer')).trim(), appends: true,
          current: function () { return ta.value; },
          write: function (str) {
            if (readOnly || !ta.isConnected) return false;
            ta.value = ta.value ? ta.value.replace(/\s+$/, '') + '\n' + str : String(str);
            emit(key, ta.value);
            flash(ta);
            return true;
          }
        });
      });
      fields.push({ el: ta, key: key });
      inputsByKey[key] = inputsByKey[key] || ta;
      return h('div', { class: 'vl-ans vl-ans--text' },
        caption ? h('label', { class: 'vl-ans-caption', for: inputId }, caption) : null, ta);
    }

    function listBoxes(key, count, pathLabel) {
      var n = Math.max(1, Number(count) || 4);
      var current = Array.isArray(answers[key]) ? answers[key].slice() : (typeof answers[key] === 'string' && answers[key] ? [answers[key]] : []);
      while (current.length < n) current.push('');
      current = current.slice(0, n);
      var ol = h('ol', { class: 'vl-ans-list' });
      current.forEach(function (val, i) {
        var inputId = idBase + '-a' + (++counter);
        var ta = h('textarea', {
          class: 'vl-ans-text vl-ans-text--item', id: inputId, rows: '2', spellcheck: 'true',
          readOnly: readOnly, 'aria-readonly': readOnly ? 'true' : null,
          'aria-label': pathLabel + ' point ' + (i + 1),
          dataset: { key: key, index: String(i) }
        });
        ta.value = val;
        ta.addEventListener('input', function () {
          current[i] = ta.value;
          emit(key, current.slice());
        });
        ta.addEventListener('focus', function () {
          focusTarget({
            kind: 'answer', tab: 'paper', key: key, index: i, label: pathLabel + ' point ' + (i + 1), appends: true,
            current: function () { return ta.value; },
            write: function (str) {
              if (readOnly || !ta.isConnected) return false;
              ta.value = ta.value ? ta.value.replace(/\s+$/, '') + ' ' + str : String(str);
              current[i] = ta.value;
              emit(key, current.slice());
              flash(ta);
              return true;
            }
          });
        });
        fields.push({ el: ta, key: key, index: i });
        if (i === 0) inputsByKey[key] = inputsByKey[key] || ta;
        ol.appendChild(h('li', { class: 'vl-ans-item' }, h('span', { class: 'vl-ans-num', 'aria-hidden': 'true' }, (i + 1) + '.'), ta));
      });
      return h('div', { class: 'vl-ans vl-ans--list' }, ol);
    }

    function linkBox(type, text) {
      var status = h('p', { class: 'vl-ans-status', role: 'status' });
      statusEls.push({ el: status, type: type });
      var btnLabel = type === 'table' ? 'Open the Table tab' : 'Open the Graph tab';
      return h('div', { class: 'vl-ans vl-ans--link' },
        h('p', { class: 'vl-ans-linktext' }, text),
        h('button', { type: 'button', class: 'vl-btn vl-btn--ui', on: { click: function () { goto(type); } } }, btnLabel),
        status);
    }

    function renderAnswer(ans, pathLabel) {
      var key = ans.key;
      switch (ans.type) {
        case 'value':
          return valueLine(key, ans.prefix, ans.suffix, pathLabel);
        case 'text':
          return textArea(key, ans.rows || 3, ans.label || ans.prefix, pathLabel);
        case 'list':
          return h('div', null,
            ans.label ? h('p', { class: 'vl-ans-caption' }, ans.label) : null,
            listBoxes(key, ans.count, pathLabel));
        case 'working':
          return h('div', { class: 'vl-ans vl-ans--working' },
            textArea(key + '_working', ans.rows || 4, 'Working', pathLabel),
            valueLine(key, ans.prefix, ans.suffix, pathLabel));
        case 'table':
          return linkBox('table', ans.label || 'Record all your measurements, and any calculated values, in a table on the Table tab.');
        case 'graph':
          return linkBox('graph', ans.label || 'Draw your graph on the graph paper on the Graph tab.');
        default:
          return h('p', { class: 'vl-error' }, 'Unknown answer type: ' + ans.type);
      }
    }

    function toolsNote(tools) {
      var names = { gradient: 'Gradient', intercept: 'Intercept', line: 'Line', plot: 'Plot', anomaly: 'Anomaly' };
      var list = tools.map(function (t) { return names[t] || t; }).join(' and ');
      return h('p', { class: 'vl-ans-tools' },
        'Use the ' + list + ' tool' + (tools.length > 1 ? 's' : '') + ' on the Graph tab, then write your answer here. ',
        h('button', { type: 'button', class: 'vl-btn vl-btn--ui vl-btn--small', on: { click: function () { goto('graph'); } } }, 'Open the Graph tab'));
    }

    function hintFor(partId) {
      if (!hintMap || readOnly) return null;
      var text = hintMap[partId];
      if (!text) return null;
      var body = h('div', { class: 'vl-hint-body' });
      body.innerHTML = String(text);   // trusted, authored with the experiment
      return h('details', { class: 'vl-hint' }, h('summary', null, 'Hint'), body);
    }

    function marksEl(n) {
      if (typeof n !== 'number') return h('span', { class: 'vl-part-marks', 'aria-hidden': 'true' });
      return h('span', { class: 'vl-part-marks' },
        h('span', { 'aria-hidden': 'true' }, '[' + n + ']'),
        h('span', { class: 'vl-sr-only' }, n === 1 ? '1 mark' : n + ' marks'));
    }

    /* ---------------------------------------------------------------- parts */

    function renderPart(part, parentPath, depth) {
      var path = joinLabels(parentPath, part.label || '');
      var labelId = idBase + '-l' + (++counter);
      var body = h('div', { class: 'vl-part-body' });
      if (part.html) {
        var stem = h('div', { class: 'vl-part-stem' });
        stem.innerHTML = part.html;
        body.appendChild(stem);
      }
      (part.answers || []).forEach(function (a) { body.appendChild(renderAnswer(a, path)); });
      if (Array.isArray(part.tools) && part.tools.length) body.appendChild(toolsNote(part.tools));
      var hint = hintFor(part.id);
      if (hint) body.appendChild(hint);
      (part.subparts || []).forEach(function (sp) { body.appendChild(renderPart(sp, path, depth + 1)); });
      var hasOwnMarks = typeof part.marks === 'number';
      return h('section', {
        class: 'vl-part vl-part--d' + depth, id: idBase + '-part-' + part.id, 'aria-labelledby': labelId,
        dataset: { part: part.id }
      },
      h('div', { class: 'vl-part-row' },
        h('span', { class: 'vl-part-label', id: labelId }, h('span', { class: 'vl-sr-only' }, 'Part '), part.label || ''),
        body,
        hasOwnMarks ? marksEl(part.marks) : h('span', { class: 'vl-part-marks', 'aria-hidden': 'true' })));
    }

    /* ---------------------------------------------------------------- whole paper */

    var total = typeof paper.totalMarks === 'number' ? paper.totalMarks : totalMarks(paper);
    var titleId = idBase + '-title';
    var root = h('article', { class: 'vl-paper' + (readOnly ? ' vl-paper--readonly' : ''), 'aria-labelledby': titleId });
    var banner = h('p', { class: 'vl-paper-banner', role: 'status', hidden: !readOnly },
      h('strong', null, 'Submitted. '), 'Your answers can no longer be changed.');
    root.appendChild(banner);
    root.appendChild(h('header', { class: 'vl-paper-head' },
      h('h2', { class: 'vl-paper-title', id: titleId }, opts.title || paper.title || 'Question'),
      h('p', { class: 'vl-paper-total-top' }, 'Total: ' + total + ' marks')));

    if (paper.intro) {
      var intro = h('div', { class: 'vl-paper-intro' });
      intro.innerHTML = paper.intro;
      root.appendChild(intro);
    }

    var appList = Array.isArray(opts.apparatusList) ? opts.apparatusList : (Array.isArray(paper.apparatus) ? paper.apparatus : null);
    if ((appList && appList.length) || paper.apparatusNote) {
      root.appendChild(h('section', { class: 'vl-paper-apparatus', 'aria-label': 'Apparatus provided' },
        appList && appList.length ? h('p', { class: 'vl-paper-apparatus-head' }, 'You have been provided with:') : null,
        appList && appList.length ? h('ul', null, appList.map(function (a) { return h('li', null, a); })) : null,
        paper.apparatusNote ? h('p', { class: 'vl-paper-note' }, paper.apparatusNote) : null));
    }

    if (hintMap && !readOnly) {
      root.appendChild(h('p', { class: 'vl-paper-hintnote' },
        'Practice mode: hints are available under some parts. They are never shown in exam mode.'));
    }

    var partsBox = h('div', { class: 'vl-paper-parts' });
    (paper.parts || []).forEach(function (p) { partsBox.appendChild(renderPart(p, '', 0)); });
    root.appendChild(partsBox);
    root.appendChild(h('p', { class: 'vl-paper-total' },
      h('span', { 'aria-hidden': 'true' }, '[Total: ' + total + ']'),
      h('span', { class: 'vl-sr-only' }, 'Total ' + total + ' marks')));
    container.appendChild(root);

    function refreshStatus() {
      statusEls.forEach(function (s) {
        var txt = '';
        if (typeof opts.statusFor === 'function') {
          try { txt = opts.statusFor(s.type) || ''; } catch (e) { txt = ''; }
        }
        s.el.textContent = txt;
        s.el.hidden = !txt;
      });
    }
    refreshStatus();

    return {
      el: root,
      refreshStatus: refreshStatus,
      /** Lock (or unlock) every answer box. */
      setReadOnly: function (v) {
        readOnly = !!v;
        root.classList.toggle('vl-paper--readonly', readOnly);
        banner.hidden = !readOnly;
        fields.forEach(function (f) {
          f.el.readOnly = readOnly;
          if (readOnly) f.el.setAttribute('aria-readonly', 'true'); else f.el.removeAttribute('aria-readonly');
        });
        Array.prototype.forEach.call(root.querySelectorAll('.vl-hint'), function (d) { d.hidden = readOnly; });
      },
      /** Move the focus to the first box of an answer key. @returns {boolean} */
      focusAnswer: function (key) {
        var el = inputsByKey[key];
        if (!el) return false;
        el.focus();
        return true;
      },
      destroy: function () {
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  ui.paperView = { mount: mount, totalMarks: totalMarks, joinLabels: joinLabels };
})(globalThis.VLab = globalThis.VLab || {});
