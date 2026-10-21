/**
 * Marking report (browser only for mounting; summarize() is pure). Contract §3.11 and §9.
 *
 *   VL.ui.reportView.mount(container, {
 *     exp, question, report,          // report = VL.marking.run(...) result (also stored in question.report)
 *     session?, paper?                // paper is used to label the model answers ('(b) L =')
 *   }) -> { el, destroy() }
 *   The exported graph (PNG, PDF) is always drawn off-screen at a fixed size (892 × 692 css px, 2 device px each).
 *
 *   VL.ui.reportView.mountExamSummary(container, { session, onOpen(questionIndex) }) -> { el, destroy() }
 *   VL.ui.reportView.summarize(session) -> { total, max, skills: { MMO: {got,max}, ... }, questions: [...], complete }
 *
 * Shows the total and percentage, three skill bars (MMO / PDO / ACE, colour + text), a per-part breakdown,
 * every mark point with ✓ / ✗ and the words "awarded" / "not awarded" for screen readers, the examiner
 * comment, credited / missed written points, the model answer (read-only table and graph), common mistakes,
 * and export buttons (CSV of the table, PNG of the graph, PDF report).
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var SKILLS = [
    { id: 'MMO', name: 'Manipulation, measurement and observation', css: '--skill-mmo' },
    { id: 'PDO', name: 'Presentation of data and observations', css: '--skill-pdo' },
    { id: 'ACE', name: 'Analysis, conclusions and evaluation', css: '--skill-ace' }
  ];

  var EXPORT_DPR = 2;          // device px per css px of exported graph images (print quality)

  function pct(got, max) { return max > 0 ? Math.round(100 * got / max) : 0; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function fmtMarks(v) { return Math.round(v * 10) / 10; }

  /** Remove a leading ✓ / ✗ from an examiner comment (the report shows its own icon). */
  function cleanComment(c) {
    return String(c || '').replace(/^\s*[✓✗✔✘]\s*/, '');
  }

  /**
   * Totals over the marked questions of a session.
   * @param {object} session
   * @returns {{total:number, max:number, skills:object, questions:object[], complete:boolean}}
   */
  function summarize(session) {
    var out = { total: 0, max: 0, skills: {}, questions: [], complete: true };
    SKILLS.forEach(function (s) { out.skills[s.id] = { got: 0, max: 0 }; });
    ((session && session.questions) || []).forEach(function (q, i) {
      var r = q.report;
      var exp = VL.getExperiment ? VL.getExperiment(q.expId) : null;
      var variant = exp && VL.getVariant ? VL.getVariant(exp, q.variantId) : null;
      var entry = {
        index: i, qid: q.qid, expId: q.expId, variantId: q.variantId, seed: q.seed,
        title: exp ? exp.title + (variant && variant.title ? ' — ' + variant.title : '') : q.expId,
        marked: !!r, total: r ? num(r.total) : 0, max: r ? num(r.max) : 0
      };
      out.questions.push(entry);
      if (!r) { out.complete = false; return; }
      out.total += num(r.total);
      out.max += num(r.max);
      Object.keys(r.skills || {}).forEach(function (k) {
        if (!out.skills[k]) out.skills[k] = { got: 0, max: 0 };
        out.skills[k].got += num(r.skills[k].got);
        out.skills[k].max += num(r.skills[k].max);
      });
    });
    return out;
  }

  /* ================================================================== */
  /* Shared pieces                                                       */
  /* ================================================================== */

  function skillBars(h, skills) {
    return h('div', { class: 'vl-skillbars' }, SKILLS.map(function (s) {
      var v = (skills && skills[s.id]) || { got: 0, max: 0 };
      var p = pct(v.got, v.max);
      return h('div', { class: 'vl-skillbar' },
        h('div', { class: 'vl-skillbar-head' },
          h('span', { class: 'vl-skillbar-name' }, h('abbr', { title: s.name }, s.id), ' ', h('span', { class: 'vl-skillbar-long' }, s.name)),
          h('span', { class: 'vl-skillbar-val' }, fmtMarks(v.got) + ' / ' + fmtMarks(v.max), h('span', { class: 'vl-skillbar-pct' }, ' (' + p + ' %)'))),
        h('div', {
          class: 'vl-skillbar-track', role: 'img',
          'aria-label': s.name + ': ' + fmtMarks(v.got) + ' out of ' + fmtMarks(v.max) + ' marks'
        }, h('span', { class: 'vl-skillbar-fill vl-skillbar-fill--' + s.id.toLowerCase(), style: { width: p + '%' } })));
    }));
  }

  function weakestSkill(skills) {
    var worst = null;
    SKILLS.forEach(function (s) {
      var v = skills && skills[s.id];
      if (!v || !v.max) return;
      var r = v.got / v.max;
      if (!worst || r < worst.r) worst = { id: s.id, name: s.name, r: r };
    });
    return worst;
  }

  function dateText(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return d.toISOString(); }
  }

  /* ================================================================== */
  /* Exam summary card                                                   */
  /* ================================================================== */

  function mountExamSummary(container, opts) {
    opts = opts || {};
    var h = ui.h;
    var sum = summarize(opts.session);
    var p = pct(sum.total, sum.max);
    var el = h('section', { class: 'vl-report-card vl-report-exam', 'aria-labelledby': 'vl-exam-sum-title' },
      h('h2', { id: 'vl-exam-sum-title', class: 'vl-report-title' }, 'Exam report'),
      h('p', { class: 'vl-report-total' },
        h('span', { class: 'vl-report-total-num' }, fmtMarks(sum.total) + ' / ' + fmtMarks(sum.max || 40)),
        h('span', { class: 'vl-report-total-pct' }, ' (' + p + ' %)'),
        h('span', { class: 'vl-report-total-label' }, ' paper total')),
      sum.complete ? null : h('p', { class: 'vl-warn-text' }, '⚠ Not every question has been marked yet.'),
      skillBars(h, sum.skills),
      h('table', { class: 'vl-report-table' },
        h('caption', { class: 'vl-sr-only' }, 'Marks for each question'),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Question'), h('th', { scope: 'col' }, 'Experiment'),
          h('th', { scope: 'col', class: 'vl-num' }, 'Marks'), h('th', { scope: 'col' }, h('span', { class: 'vl-sr-only' }, 'Open')))),
        h('tbody', null, sum.questions.map(function (q) {
          return h('tr', null,
            h('th', { scope: 'row' }, 'Question ' + (q.index + 1)),
            h('td', null, q.title),
            h('td', { class: 'vl-num' }, q.marked ? fmtMarks(q.total) + ' / ' + fmtMarks(q.max) : 'not marked'),
            h('td', null, typeof opts.onOpen === 'function'
              ? h('button', { type: 'button', class: 'vl-btn vl-btn--small', 'aria-label': 'View the Question ' + (q.index + 1) + ' report',
                on: { click: function () { opts.onOpen(q.index); } } }, 'View report') : null));
        }))));
    var weak = weakestSkill(sum.skills);
    if (weak && sum.max) {
      el.appendChild(h('p', { class: 'vl-report-advice' },
        'Weakest skill in this paper: ', h('strong', null, weak.id + ' (' + weak.name + ')'),
        '. Look at the ✗ mark points below and try a skill drill.'));
    }
    container.appendChild(el);
    return { el: el, destroy: function () { if (el.parentNode) el.parentNode.removeChild(el); } };
  }

  /* ================================================================== */
  /* Question report                                                     */
  /* ================================================================== */

  /** key -> '(b) L =' using the paper's answer prefixes. */
  function answerLabels(paper) {
    var map = {};
    function join(parent, own) { return ui.paperView && ui.paperView.joinLabels ? ui.paperView.joinLabels(parent, own) : (parent || '') + (own || ''); }
    (paper && paper.parts || []).forEach(function walk(p, _, __, parentPath) {
      var path = join(parentPath || '', p.label || '');
      (p.answers || []).forEach(function (a) {
        if (!a.key) return;
        map[a.key] = (path + ' ' + (a.prefix || '')).trim();
        if (a.type === 'working') map[a.key + '_working'] = (path + ' working').trim();
      });
      (p.subparts || []).forEach(function (sp) { walk(sp, 0, null, path); });
    });
    return map;
  }

  /** Render written-answer details { hits, misses, rejected } (possibly nested) as lists. */
  function writtenDetails(h, d) {
    if (!d || typeof d !== 'object') return null;
    var hasLists = Array.isArray(d.hits) || Array.isArray(d.misses) || Array.isArray(d.rejected);
    if (!hasLists) {
      var nested = ['limitations', 'improvements'].filter(function (k) { return d[k] && typeof d[k] === 'object'; });
      if (!nested.length) return null;
      return h('div', null, nested.map(function (k) {
        return h('div', null, h('h5', { class: 'vl-mp-subhead' }, k === 'limitations' ? 'Limitations' : 'Improvements'), writtenDetails(h, d[k]));
      }));
    }
    var box = h('div', { class: 'vl-written' });
    if (d.hits && d.hits.length) {
      box.appendChild(h('p', { class: 'vl-written-head' }, 'Credited:'));
      box.appendChild(h('ul', { class: 'vl-written-list vl-written-list--hit' }, d.hits.map(function (x) {
        return h('li', null, h('span', { class: 'vl-icon vl-icon--ok', 'aria-hidden': 'true' }, '✓'),
          h('span', { class: 'vl-sr-only' }, 'credited: '), x.label || x.id || '',
          x.text ? h('span', { class: 'vl-written-yours' }, ' — you wrote “' + x.text + '”') : null);
      })));
    }
    if (d.rejected && d.rejected.length) {
      box.appendChild(h('p', { class: 'vl-written-head' }, 'Not credited:'));
      box.appendChild(h('ul', { class: 'vl-written-list vl-written-list--miss' }, d.rejected.map(function (x) {
        return h('li', null, h('span', { class: 'vl-icon vl-icon--bad', 'aria-hidden': 'true' }, '✗'),
          h('span', { class: 'vl-sr-only' }, 'not credited: '), '“' + (x.text || '') + '”',
          x.reason ? h('span', { class: 'vl-written-reason' }, ' — ' + x.reason) : null);
      })));
    }
    if (d.misses && d.misses.length) {
      box.appendChild(h('p', { class: 'vl-written-head' }, 'Points you could also have made:'));
      box.appendChild(h('ul', { class: 'vl-written-list' }, d.misses.map(function (x) {
        return h('li', null, h('span', { class: 'vl-icon', 'aria-hidden': 'true' }, '•'), ' ', x.label || x.id || '');
      })));
    }
    return box.childNodes.length ? box : null;
  }

  function markPoint(h, p) {
    var full = p.awarded >= p.max && p.max > 0, none = p.awarded <= 0;
    var state = full ? 'ok' : none ? 'bad' : 'part';
    var icon = full ? '✓' : none ? '✗' : '◐';
    var srWord = full ? 'awarded' : none ? 'not awarded' : 'partly awarded';
    return h('li', { class: 'vl-mp vl-mp--' + state },
      h('div', { class: 'vl-mp-head' },
        h('span', { class: 'vl-mp-icon', 'aria-hidden': 'true' }, icon),
        h('span', { class: 'vl-sr-only' }, srWord + ': '),
        h('span', { class: 'vl-mp-label' }, p.label || p.id),
        h('span', { class: 'vl-mp-skill vl-mp-skill--' + String(p.skill || '').toLowerCase(), title: skillName(p.skill) }, p.skill || ''),
        h('span', { class: 'vl-mp-marks' }, fmtMarks(p.awarded) + ' / ' + fmtMarks(p.max),
          h('span', { class: 'vl-sr-only' }, p.max === 1 ? ' mark' : ' marks'))),
      p.comment ? h('p', { class: 'vl-mp-comment' }, cleanComment(p.comment)) : null,
      writtenDetails(h, p.details));
  }

  function skillName(id) {
    for (var i = 0; i < SKILLS.length; i++) if (SKILLS[i].id === id) return SKILLS[i].name;
    return id || '';
  }

  function safeName(s) { return String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''); }

  function mount(container, opts) {
    opts = opts || {};
    var h = ui.h;
    var exp = opts.exp || {};
    var q = opts.question || {};
    var report = opts.report || q.report;
    var cleanups = [];
    var root = h('div', { class: 'vl-report' });
    container.appendChild(root);

    if (!report) {
      root.appendChild(h('p', { class: 'vl-placeholder' }, 'This question has not been marked yet.'));
      return { el: root, destroy: function () { if (root.parentNode) root.parentNode.removeChild(root); } };
    }

    var variant = VL.getVariant ? VL.getVariant(exp, q.variantId) : null;
    var p = pct(num(report.total), num(report.max));

    /* ---------------------------------------------------------------- summary card */
    var titleId = 'vl-rep-' + safeName(q.qid || 'q') + '-title';
    root.appendChild(h('section', { class: 'vl-report-card', 'aria-labelledby': titleId },
      h('h2', { class: 'vl-report-title', id: titleId }, 'Report: ' + (exp.title || q.expId || 'Question') +
        (variant && variant.title ? ' — ' + variant.title : '')),
      h('p', { class: 'vl-report-meta' },
        'Seed ', h('code', { class: 'vl-seed-code' }, String(report.seed || q.seed || '')),
        report.markedAt ? ' · marked ' + dateText(report.markedAt) : ''),
      h('p', { class: 'vl-report-total' },
        h('span', { class: 'vl-report-total-num' }, fmtMarks(num(report.total)) + ' / ' + fmtMarks(num(report.max))),
        h('span', { class: 'vl-report-total-pct' }, ' (' + p + ' %)')),
      skillBars(h, report.skills)));

    /* ---------------------------------------------------------------- export */
    root.appendChild(exportBox());

    /* ---------------------------------------------------------------- per-part table */
    var parts = Array.isArray(report.parts) ? report.parts : [];
    if (parts.length) {
      root.appendChild(h('section', { class: 'vl-report-section', 'aria-labelledby': titleId + '-parts' },
        h('h3', { id: titleId + '-parts' }, 'Marks by part'),
        h('table', { class: 'vl-report-table' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Part'), h('th', { scope: 'col', class: 'vl-num' }, 'Marks'),
            h('th', { scope: 'col' }, 'Result'))),
          h('tbody', null, parts.map(function (pt) {
            var full = pt.got >= pt.max, none = pt.got <= 0;
            return h('tr', null,
              // a button rather than an in-page link: the app uses the URL hash for routing
              h('th', { scope: 'row' }, h('button', {
                type: 'button', class: 'vl-linkbtn', title: 'Show the mark points for this part',
                on: { click: function () {
                  var target = root.querySelector('[data-part-anchor="' + safeName(pt.part) + '"]');
                  if (target) { target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }); }
                } }
              }, pt.label || pt.part)),
              h('td', { class: 'vl-num' }, fmtMarks(pt.got) + ' / ' + fmtMarks(pt.max)),
              h('td', { class: full ? 'vl-ok-text' : none ? 'vl-bad-text' : 'vl-warn-text' },
                full ? '✓ full marks' : none ? '✗ no marks' : '◐ some marks'));
          })))));
    }

    /* ---------------------------------------------------------------- mark points by part */
    var points = Array.isArray(report.points) ? report.points : [];
    var order = parts.map(function (pt) { return pt.part; });
    points.forEach(function (pt) { if (order.indexOf(pt.part) === -1) order.push(pt.part); });
    var pointsSec = h('section', { class: 'vl-report-section', 'aria-labelledby': titleId + '-points' },
      h('h3', { id: titleId + '-points' }, 'Mark points and examiner comments'));
    order.forEach(function (partId) {
      var list = points.filter(function (pt) { return pt.part === partId; });
      if (!list.length) return;
      var info = parts.filter(function (pt) { return pt.part === partId; })[0];
      pointsSec.appendChild(h('div', { class: 'vl-report-part', tabindex: '-1', dataset: { partAnchor: safeName(partId) } },
        h('h4', { class: 'vl-report-parthead' }, (info && info.label) || ('(' + partId + ')'),
          info ? h('span', { class: 'vl-report-partmarks' }, ' ' + fmtMarks(info.got) + ' / ' + fmtMarks(info.max)) : null),
        h('ul', { class: 'vl-mp-list' }, list.map(function (pt) { return markPoint(h, pt); }))));
    });
    root.appendChild(pointsSec);

    /* ---------------------------------------------------------------- model answer */
    var model = report.modelAnswer;
    if (model) root.appendChild(modelSection(model));

    /* ---------------------------------------------------------------- common mistakes */
    var cm = Array.isArray(report.commonMistakes) ? report.commonMistakes : [];
    if (cm.length) {
      root.appendChild(h('section', { class: 'vl-report-section', 'aria-labelledby': titleId + '-cm' },
        h('h3', { id: titleId + '-cm' }, 'Common mistakes in this experiment'),
        h('ul', { class: 'vl-report-mistakes' }, cm.map(function (m) { return h('li', null, m); }))));
    }

    function modelSection(model) {
      var sec = h('section', { class: 'vl-report-section vl-model', 'aria-labelledby': titleId + '-model' },
        h('h3', { id: titleId + '-model' }, 'Model answer'),
        h('p', { class: 'vl-muted' }, 'Results a careful student could have obtained with the same hidden set-up (same seed), with realistic random errors.'));
      if (model.table) {
        sec.appendChild(h('h4', null, 'Results table'));
        var tbox = h('div', { class: 'vl-model-table' });
        sec.appendChild(tbox);
        if (ui.tableView && typeof ui.tableView.mount === 'function') {
          try { var tv = ui.tableView.mount(tbox, model.table, { readOnly: true }); cleanups.push(function () { tv.destroy(); }); }
          catch (e) { console.error('[reportView model table]', e); tbox.appendChild(h('p', { class: 'vl-placeholder' }, 'The model table could not be shown.')); }
        } else tbox.appendChild(h('p', { class: 'vl-placeholder' }, 'The table component is not available.'));
      }
      if (model.graph) {
        sec.appendChild(h('h4', null, 'Graph'));
        var gbox = h('div', { class: 'vl-model-graph' });
        sec.appendChild(gbox);
        if (ui.graphView && typeof ui.graphView.mount === 'function') {
          try { var gv = ui.graphView.mount(gbox, model.graph, model.table || { columns: [], rows: [] }, { readOnly: true }); cleanups.push(function () { gv.destroy(); }); }
          catch (e) { console.error('[reportView model graph]', e); gbox.appendChild(h('p', { class: 'vl-placeholder' }, 'The model graph could not be shown.')); }
        } else gbox.appendChild(h('p', { class: 'vl-placeholder' }, 'The graph component is not available.'));
      }
      var ans = model.answers || {};
      var keys = Object.keys(ans);
      if (keys.length) {
        var labels = answerLabels(opts.paper);
        sec.appendChild(h('h4', null, 'Answers'));
        sec.appendChild(h('dl', { class: 'vl-model-answers' }, keys.map(function (k) {
          var v = ans[k];
          return [h('dt', null, labels[k] || k),
            h('dd', null, Array.isArray(v) ? h('ol', null, v.map(function (x) { return h('li', null, String(x)); })) : String(v))];
        })));
      }
      if (Array.isArray(model.notes) && model.notes.length) {
        sec.appendChild(h('h4', null, 'How it was done'));
        sec.appendChild(h('ul', { class: 'vl-model-notes' }, model.notes.map(function (n) { return h('li', null, String(n)); })));
      }
      return sec;
    }

    function exportBox() {
      var E = VL.export;
      var status = h('p', { class: 'vl-export-status', role: 'status', 'aria-live': 'polite' });
      var base = safeName([q.expId, q.variantId, q.seed || report.seed].join('-'));
      function say(msg) { status.textContent = msg; }

      /**
       * The student's graph drawn for export: always a fresh read-only mount in a fixed-size off-screen holder
       * (never the live Graph tab, which may show the magnifier, a selection or the hover cross-hair, and whose
       * size follows the panel), at 2 device px per css px so that it prints sharply.
       */
      function graphCanvas() {
        if (!q.graph || !ui.graphView) return null;
        var holder = h('div', { class: 'vl-offscreen vl-export-holder', 'aria-hidden': 'true' });
        document.body.appendChild(holder);
        try {
          var gv = ui.graphView.mount(holder, q.graph, q.table || { columns: [], rows: [] }, { readOnly: true, dpr: EXPORT_DPR });
          var c = typeof gv.renderClean === 'function' ? gv.renderClean() : gv.canvas;
          return { canvas: c, destroy: function () { gv.destroy(); if (holder.parentNode) holder.parentNode.removeChild(holder); } };
        } catch (e) {
          if (holder.parentNode) holder.parentNode.removeChild(holder);
          return null;
        }
      }

      var canCSV = !!(E && E.tableToCSV && E.download && q.table);
      var canPNG = !!(E && E.downloadCanvasPNG && q.graph && ui.graphView);
      var canPDF = !!(E && E.reportPDF && E.download);
      var csvBtn = h('button', { type: 'button', class: 'vl-btn', disabled: !canCSV, on: { click: function () {
        try { E.download(base + '-table.csv', E.tableToCSV(q.table), 'text/csv;charset=utf-8'); say('Table downloaded as CSV.'); }
        catch (e) { say('Could not export the table: ' + e.message); }
      } } }, 'Table (CSV)');
      var pngBtn = h('button', { type: 'button', class: 'vl-btn', disabled: !canPNG, on: { click: function () {
        var gc = graphCanvas();
        if (!gc) { say('The graph could not be drawn for export.'); return; }
        try { E.downloadCanvasPNG(gc.canvas, base + '-graph.png'); say('Graph downloaded as PNG.'); }
        catch (e) { say('Could not export the graph: ' + e.message); }
        finally { setTimeout(gc.destroy, 0); }
      } } }, 'Graph (PNG)');
      var pdfBtn = h('button', { type: 'button', class: 'vl-btn', disabled: !canPDF, on: { click: function () {
        var gc = graphCanvas();
        try {
          var blob = E.reportPDF({ session: opts.session, question: q, report: report, graphCanvas: gc ? gc.canvas : null });
          E.download(base + '-report.pdf', blob, 'application/pdf');
          say('Report downloaded as PDF.');
        } catch (e) { say('Could not create the PDF: ' + e.message); }
        finally { if (gc) setTimeout(gc.destroy, 0); }
      } } }, 'Report (PDF)');
      return h('div', { class: 'vl-report-export', role: 'group', 'aria-label': 'Export' },
        h('span', { class: 'vl-report-export-label' }, 'Download:'), csvBtn, pngBtn, pdfBtn,
        (!canCSV && !canPNG && !canPDF) ? h('span', { class: 'vl-muted' }, ' Export is not available in this build.') : null,
        status);
    }

    return {
      el: root,
      destroy: function () {
        cleanups.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  ui.reportView = {
    mount: mount,
    mountExamSummary: mountExamSummary,
    summarize: summarize,
    answerLabels: answerLabels,
    SKILLS: SKILLS
  };
})(globalThis.VLab = globalThis.VLab || {});
