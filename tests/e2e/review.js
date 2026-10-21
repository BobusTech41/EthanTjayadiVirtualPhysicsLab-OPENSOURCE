/**
 * Extra end-to-end checks (dev only), run by tests/e2e/smoke.js after its main flow:
 *
 *   await require('./review.js')({ browser, INDEX, check, step, watch, shot })
 *
 * Each group uses its own browser context (its own localStorage) unless it needs two pages of one context.
 * Test-only access to VLab.* is used for set-up, to read hidden values and to inject faults; the student UI is
 * driven through real clicks and keys wherever the check is about the UI.
 */
'use strict';

const SEED = 'PEN-AB12-CD34';

module.exports = async function review(env) {
  const { browser, INDEX, check, step, watch, shot } = env;

  /* ------------------------------------------------------------------------- helpers */

  const ws = (page, fn, arg) => page.evaluate(fn, arg);
  const app = (page, fn, arg) => page.evaluate(fn, arg);
  const question = (page) => ws(page, () => JSON.parse(JSON.stringify(VLab.ui.app.current().question())));

  async function dismissTip(page) {
    const tip = page.locator('.vl-app-hint button');
    if (await tip.isVisible()) await tip.click();
  }

  /** A fresh context + page with a practice session (or an exam when o.exam). */
  async function open(o) {
    const ctx = o.ctx || await browser.newContext({ viewport: o.viewport || { width: 1366, height: 768 }, acceptDownloads: true });
    const page = await ctx.newPage();
    watch(page, o.label || 'review');
    if (o.exam) {
      await page.goto(INDEX + '#/exam');
      await page.waitForSelector('form.vl-form');
      if (o.seed) await page.fill('#vl-exam-seed', o.seed);
    } else {
      await page.goto(INDEX + '#/practice?exp=pendulum&variant=' + (o.variant || 'graph') + '&seed=' + (o.seed || SEED));
      await page.waitForSelector('form.vl-form');
      if (o.hints === false) await page.uncheck('#vl-practice-hints');
      else await page.check('#vl-practice-hints');
    }
    await page.click('form.vl-form button[type=submit]');
    await page.waitForSelector('.vl-ws .vl-app-canvas', { state: 'attached' });   // hidden on phones (Paper side shown)
    await page.waitForTimeout(350);
    await dismissTip(page);
    return { ctx, page };
  }

  const view = (page) => app(page, () => VLab.ui.app.current().app.getView());
  const snap = (page) => app(page, () => VLab.ui.app.current().app.controller.snapshot());
  const frames = (page, n) => page.evaluate((k) => new Promise((res) => {
    let i = 0;
    const f = () => (++i >= k ? res() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  }), n || 3);

  /** Visible part of an element's rect inside the viewport (px). */
  async function visibleHeight(page, sel) {
    return page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return 0;
      const r = e.getBoundingClientRect();
      return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    }, sel);
  }

  async function rect(page, sel) {
    return page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    }, sel);
  }

  async function fillTable(page, headings, rows) {
    await page.click('#vl-tab-table');
    await page.waitForSelector('#vl-panel-table .vt-root');
    const heads = page.locator('#vl-panel-table input.vt-input--head');
    while (await heads.count() < headings.length) {
      await page.getByRole('button', { name: 'Add a column at the right' }).click();
    }
    for (let i = 0; i < headings.length; i++) await heads.nth(i).fill(headings[i]);
    const n = headings.length;
    const cells = page.locator('#vl-panel-table input.vt-input:not(.vt-input--head)');
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) await cells.nth(r * n + c).fill(rows[r][c]);
    }
  }

  async function setAxes(page, xLabel, yLabel, xo, xp, yo, yp) {
    await page.click('#vl-tab-graph');
    await page.waitForSelector('#vl-panel-graph canvas.vg-canvas');
    const det = page.locator('#vl-panel-graph details.vg-axes');
    if (!(await det.evaluate((d) => d.open))) await det.locator('summary').click();
    await page.selectOption('[data-field="x-col"]', { label: xLabel });
    await page.selectOption('[data-field="y-col"]', { label: yLabel });
    for (const [f, v] of [['x-origin', xo], ['x-per', xp], ['y-origin', yo], ['y-per', yp]]) {
      await page.fill('[data-field="' + f + '"]', v);
      await page.press('[data-field="' + f + '"]', 'Tab');
    }
  }

  const gridToClient = (page, gx, gy) => page.evaluate(([x, y]) => VLab.ui.app.current().views.graph.gridToClient(x, y), [gx, gy]);

  /* ========================================================================= 1 parallax: the eye is a height */

  await step('Review 1: the eye stays at its height; each zoom target needs re-levelling', async () => {
    const { ctx, page } = await open({ label: 'eye' });
    const target = (id) => page.getByRole('button', { name: 'Zoom to ' + id });
    await target('Cork and rule').click();
    await page.waitForTimeout(700);
    let e = await app(page, () => VLab.ui.app.current().app.getEye());
    check(Math.abs(e) >= 3 - 1e-6 && Math.abs(e) <= 9 + 1e-6, '“Cork and rule” leaves the eye 3–9° off level (' + e.toFixed(2) + '°)');
    await app(page, () => VLab.ui.app.current().app.setEye(0));
    await frames(page, 3);
    let s = await snap(page);
    const rr = s.ruleReadings;
    check(rr && Math.abs(rr.corkSeen - rr.cork) <= 0.01, 'eye level with the cork: no parallax at the cork (' + (rr && rr.cork) + ' / ' + (rr && rr.corkSeen) + ')');
    // move the view to the bob WITHOUT touching the eye: drag empty space, then centre on the bob (test hook)
    const bob = await app(page, () => { const t = VLab.ui.app.current().app.controller.zoomTargets.find((z) => z.id === 'bob'); return { x: t.x, y: t.y }; });
    const eyeY0 = await app(page, () => VLab.ui.app.current().app.getEyeY());
    const c = await rect(page, '.vl-app-canvas');
    const v0 = await view(page);
    await page.mouse.move(c.left + c.width * 0.9, c.top + c.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(c.left + c.width * 0.9, c.top + c.height * 0.3, { steps: 6 });
    await page.mouse.up();
    const v1 = await view(page);
    check(v1.cy > v0.cy + 1, 'dragging empty space moves the view down the apparatus (' + v0.cy.toFixed(1) + ' → ' + v1.cy.toFixed(1) + ' cm)');
    await app(page, (b) => VLab.ui.app.current().app.setView({ cx: b.x, cy: b.y }), bob);
    await frames(page, 3);
    const eyeY1 = await app(page, () => VLab.ui.app.current().app.getEyeY());
    check(Math.abs(eyeY1 - eyeY0) < 1e-9, 'moving the view leaves the eye where it was');
    s = await snap(page);
    check(Math.abs(s.ruleReadings.bobTopSeen - s.ruleReadings.bobTop) > 0.5,
      'at the bob, an eye left at the cork’s height sees the bob shifted by more than 0.5 cm (' + (s.ruleReadings.bobTopSeen - s.ruleReadings.bobTop).toFixed(3) + ' cm)');
    await app(page, () => VLab.ui.app.current().app.setEye(0));
    await frames(page, 3);
    s = await snap(page);
    check(Math.abs(s.ruleReadings.bobTopSeen - s.ruleReadings.bobTop) < 0.01, 're-levelled at the bob: no parallax there');
    await target('Bob and rule').click();
    await page.waitForTimeout(700);
    e = await app(page, () => VLab.ui.app.current().app.getEye());
    check(Math.abs(e) >= 3 - 1e-6 && Math.abs(e) <= 9 + 1e-6, '“Bob and rule” again leaves the eye 3–9° off level (' + e.toFixed(2) + '°)');
    // practice cue: dashed eye-level line (or an edge tab) drawn on the stage, and the note under the slider
    const cue = await page.evaluate(() => {
      const st = document.querySelector('.vl-app-stage');
      const a = VLab.ui.app.current().app;
      const v = a.getView();
      const yPx = Math.round(((a.getEyeY() - v.cy) * v.fit * v.z + v.height / 2) * devicePixelRatio);
      const cv = document.querySelector('.vl-app-canvas');
      let ink = 0;
      if (yPx >= 0 && yPx < cv.height) {
        const d = cv.getContext('2d').getImageData(0, Math.max(0, yPx - 1), cv.width, 3).data;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 11) < 30 && Math.abs(d[i + 1] - 79) < 30 && Math.abs(d[i + 2] - 179) < 30) ink++;
      }
      return { state: st.getAttribute('data-eye-cue'), ink, note: !document.querySelector('.vl-eye-note').hidden };
    });
    check(cue.state === 'line' && cue.ink > 100, 'practice: the dashed “your eye level” line is drawn across the stage (' + cue.state + ', ' + cue.ink + ' px)');
    check(cue.note, 'practice: the note under the slider says the eye is not level');
    const level = await page.locator('.vl-eye-level').getAttribute('title');
    check(/middle of the slider is level with the centre of the view/.test(level || ''), 'slider has a “level” tick with its explanation');
    // the eye height survives a reload
    const eyeBefore = await app(page, () => VLab.ui.app.current().app.getEyeY());
    await app(page, () => VLab.ui.app.current().saveNow());
    await page.reload();
    await page.waitForSelector('.vl-ws .vl-app-canvas');
    await page.waitForTimeout(300);
    const eyeAfter = await app(page, () => VLab.ui.app.current().app.getEyeY());
    check(Math.abs(eyeAfter - eyeBefore) < 1e-6, 'reload restores the eye height (' + eyeBefore.toFixed(3) + ' → ' + eyeAfter.toFixed(3) + ')');
    await ctx.close();

    // exam: no line, no tab, no note
    const ex = await open({ exam: true, label: 'eye-exam' });
    await ex.page.getByRole('button', { name: 'Zoom to Cork and rule' }).click();
    await ex.page.waitForTimeout(700);
    const examCue = await ex.page.evaluate(() => ({
      state: document.querySelector('.vl-app-stage').getAttribute('data-eye-cue'),
      note: !document.querySelector('.vl-eye-note').hidden
    }));
    check(examCue.state === 'none' && !examCue.note, 'exam: no eye-level line, tab or note');
    await ex.ctx.close();
  });

  /* ========================================================================= 2, 3 record target and focus */

  await step('Review 2–3: record target expires with its tab, no silent overwrite, focus back to the apparatus', async () => {
    const { ctx, page } = await open({ label: 'record' });
    // (a) record into answer (b), then switch to the Table tab
    await page.click('#vl-tab-paper');
    await page.click('#vl-panel-paper [data-key="L"]');
    await page.fill('.vl-pad-input', '50.9 cm');
    await page.press('.vl-pad-input', 'Enter');
    let q = await question(page);
    check(q.answers.L === '50.9 cm', 'Record wrote into answer (b)');
    await page.click('#vl-tab-table');
    const tgt = await page.textContent('.vl-pad-target');
    check(/No box selected/.test(tgt), 'switching to the Table tab clears the record target (' + tgt.trim().slice(0, 40) + '…)');
    await page.fill('.vl-pad-input', '12.34');
    await page.click('.vl-pad-record');
    q = await question(page);
    check(q.answers.L === '50.9 cm' && (q.roughNotes || []).indexOf('12.34') !== -1, 'with no target the reading goes to Rough notes; the answer is untouched');
    // (b) a non-empty answer is not overwritten without confirmation
    await page.click('#vl-tab-paper');
    await page.click('#vl-panel-paper [data-key="L"]');
    await page.fill('.vl-pad-input', '28.98');
    await page.click('.vl-pad-record');
    q = await question(page);
    const row = page.locator('.vl-pad-confirm');
    check(q.answers.L === '50.9 cm' && await row.isVisible(), 'recording into a non-empty answer asks first and writes nothing');
    check(/“50\.9 cm” is already in .*L =.*Replace it\?/.test(await row.textContent()), 'the question names the old value and the box');
    await row.getByRole('button', { name: 'Cancel' }).click();
    q = await question(page);
    check(q.answers.L === '50.9 cm' && !(await row.isVisible()) && await page.inputValue('.vl-pad-input') === '28.98',
      'Cancel keeps the answer and leaves the reading in the pad');
    await page.click('.vl-pad-record');
    await row.getByRole('button', { name: 'Replace' }).click();
    q = await question(page);
    check(q.answers.L === '28.98', 'Replace overwrites the answer');
    // Esc in the pad cancels as well
    await page.click('#vl-panel-paper [data-key="L"]');
    await page.fill('.vl-pad-input', '30.00');
    await page.press('.vl-pad-input', 'Enter');
    await page.press('.vl-pad-input', 'Escape');
    q = await question(page);
    check(q.answers.L === '28.98' && !(await row.isVisible()), 'Esc cancels the replacement');
    // (c) an empty table cell needs no confirmation
    await page.click('#vl-tab-table');
    await page.locator('#vl-panel-table input.vt-input:not(.vt-input--head)').nth(0).click();
    await page.fill('.vl-pad-input', '20.0');
    await page.press('.vl-pad-input', 'Enter');
    q = await question(page);
    check(q.table.rows[0].cells[q.table.columns[0].id] === '20.0' && !(await row.isVisible()), 'recording into an empty cell needs no confirmation');
    // 3: after Enter the focus is on the apparatus, so X and Space work the stopwatch at once
    await page.click('.vi-sw-start');
    await page.waitForTimeout(400);
    await page.click('.vi-sw-start');
    const starts0 = (await question(page)).log.filter((e) => e.type === 'stopwatch-start').length;
    await page.locator('#vl-panel-table input.vt-input:not(.vt-input--head)').nth(1).click();
    await page.fill('.vl-pad-input', '28.98');
    await page.press('.vl-pad-input', 'Enter');
    await page.keyboard.press('x');
    const reset = parseFloat(await page.textContent('.vi-sw-digits'));
    await page.keyboard.press('Space');
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => ({
      pad: document.querySelector('.vl-pad-input').value,
      active: document.activeElement && document.activeElement.className,
      btn: document.querySelector('.vi-sw-start').textContent.trim()
    }));
    const starts1 = (await question(page)).log.filter((e) => e.type === 'stopwatch-start').length;
    check(st.pad === '' && reset === 0, 'after Enter the pad is empty and X reset the stopwatch');
    check(st.btn === 'Stop' && starts1 === starts0 + 1, 'Space then started it exactly once');
    check(/vl-app-canvas/.test(st.active || ''), 'the apparatus canvas has the focus after recording');
    await page.keyboard.press('Space');
    const live = await page.textContent('.vl-pad .vl-sr-only[role=status]');
    check(/^Recorded to /.test(live.trim()), 'the pad announces “Recorded to …” (' + live.trim() + ')');
    await ctx.close();
  });

  /* ========================================================================= 4 laptop viewports */

  await step('Review 4: apparatus and its controls on screen together on laptop screens', async () => {
    for (const [w, h] of [[1366, 657], [1280, 720], [1366, 768]]) {
      const { ctx, page } = await open({ viewport: { width: w, height: h }, label: 'laptop-' + w + 'x' + h });
      const m = await page.evaluate(() => {
        const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
        const left = document.querySelector('.vl-ws-left'), lower = document.querySelector('.vl-app-lower');
        return { canvas: r('.vl-app-canvas'), ctl: r('.vl-app-controls .vl-ctl-btn'), start: r('.vi-sw-start'), rec: r('.vl-pad-record'),
          scrolled: scrollY + document.documentElement.scrollTop + left.scrollTop + lower.scrollTop, vh: innerHeight };
      });
      const inside = (b) => b.top >= 0 && b.bottom <= m.vh + 0.5;
      check(m.scrolled === 0 && inside(m.canvas) && m.canvas.height >= 260,
        w + '×' + h + ': the whole stage is visible without scrolling (' + Math.round(m.canvas.height) + ' px tall)');
      check(inside(m.ctl) && inside(m.start) && inside(m.rec),
        w + '×' + h + ': first experiment control, Start/Stop and Record are on screen (' + [m.ctl, m.start, m.rec].map((b) => Math.round(b.bottom)).join(', ') + ')');
      if (w === 1366 && h === 657) await shot(page, 'r04-laptop-1366x657');
      await ctx.close();
    }
  });

  /* ========================================================================= 5 no worked gradient / intercept in an exam */

  await step('Review 5: no calculated gradient or intercept in an exam', async () => {
    const { ctx, page } = await open({ exam: true, label: 'exam-graph' });
    await page.click('#vl-tab-graph');
    await page.waitForSelector('#vl-panel-graph canvas.vg-canvas');
    await page.locator('#vl-panel-graph .vg-mode', { hasText: 'Line' }).click();
    await page.getByRole('button', { name: 'Place ruler' }).click();
    await page.locator('#vl-panel-graph .vg-mode', { hasText: 'Gradient' }).click();
    for (const [k, v] of [['x1', '20'], ['y1', '0.85'], ['x2', '80'], ['y2', '3.27']]) await page.fill('[data-field="ro-' + k + '"]', v);
    await page.press('[data-field="ro-y2"]', 'Tab');
    const gp = await page.evaluate(() => ({ strong: document.querySelectorAll('#vl-panel-graph .vg-result strong').length, text: document.querySelector('#vl-panel-graph .vg-panel').textContent }));
    check(gp.strong === 0 && !/=\s*-?\d/.test(gp.text), 'exam: the gradient panel shows no Δy/Δx result');
    await page.locator('#vl-panel-graph .vg-mode', { hasText: 'Intercept' }).click();
    await page.check('[data-field="im-substitution"]');
    const ip = await page.evaluate(() => ({ strong: document.querySelectorAll('#vl-panel-graph .vg-result strong').length, text: document.querySelector('#vl-panel-graph .vg-panel').textContent }));
    check(ip.strong === 0 && !/=\s*-?\d/.test(ip.text) && /Substitute a point/.test(ip.text), 'exam: the intercept panel keeps only the instruction');
    await ctx.close();
    // practice with hints: the worked substitution is still offered
    const pr = await open({ label: 'practice-graph' });
    await pr.page.click('#vl-tab-graph');
    await pr.page.locator('#vl-panel-graph .vg-mode', { hasText: 'Line' }).click();
    await pr.page.getByRole('button', { name: 'Place ruler' }).click();
    await pr.page.locator('#vl-panel-graph .vg-mode', { hasText: 'Gradient' }).click();
    for (const [k, v] of [['x1', '20'], ['y1', '0.85'], ['x2', '80'], ['y2', '3.27']]) await pr.page.fill('[data-field="ro-' + k + '"]', v);
    await pr.page.press('[data-field="ro-y2"]', 'Tab');
    await pr.page.locator('#vl-panel-graph .vg-mode', { hasText: 'Intercept' }).click();
    await pr.page.check('[data-field="im-substitution"]');
    const help = await pr.page.textContent('#vl-panel-graph .vg-panel');
    check(/c = 0\.85 − \(0\.04033 × 20\) = /.test(help), 'practice with hints: the substitution helper is still shown');
    await pr.ctx.close();
  });

  /* ========================================================================= 6 vernier zoom */

  await step('Review 6: the 0.02 mm vernier can be zoomed until lines are 1.5 px apart', async () => {
    const { ctx, page } = await open({ variant: 'twopoint', seed: 'PEN-0000-1111', label: 'vernier' });
    await page.getByRole('button', { name: 'Zoom to Vernier scale' }).click();
    await page.waitForTimeout(700);
    const zin = page.getByRole('button', { name: 'Zoom in', exact: true });
    for (let i = 0; i < 40 && await zin.isEnabled(); i++) await zin.click();
    const v = await view(page);
    check(!(await zin.isEnabled()), 'the zoom-in button is disabled at the maximum zoom (×' + Math.round(v.z) + ')');
    const px = v.fit * v.z * 0.002;
    check(px >= 1.5, '0.02 mm is ' + px.toFixed(2) + ' css px at the maximum zoom (≥ 1.5)');
    const ms = await page.evaluate(async () => {
      const a = VLab.ui.app.current().app, c = a.controller, orig = c.draw;
      const times = [];
      c.draw = function () { const t0 = performance.now(); try { return orig.apply(this, arguments); } finally { times.push(performance.now() - t0); } };
      for (let i = 0; i < 30; i++) {
        a.services.requestRedraw();
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
      await new Promise((r) => requestAnimationFrame(() => r()));
      c.draw = orig;
      return times.length ? times.reduce((x, y) => x + y, 0) / times.length : NaN;
    });
    check(ms < 8, 'drawing at the maximum zoom stays fast (' + ms.toFixed(2) + ' ms per frame)');
    await shot(page, 'r06-vernier-max-zoom');
    await ctx.close();
  });

  /* ========================================================================= 7, 8, 14 graph tool */

  await step('Review 7, 8, 14: ruler past the edge keeps its slope; sticky tools; axes collapse; loupe', async () => {
    const { ctx, page } = await open({ label: 'graph' });
    const rows = [['20.0', '1.62'], ['35.0', '2.80'], ['50.0', '3.98'], ['65.0', '5.18'], ['80.0', '6.36'], ['95.0', '7.56']];
    await fillTable(page, ['L / cm', 'T² / s²'], rows);
    await setAxes(page, 'L / cm', 'T² / s²', '0', '10', '0', '1');
    // 7: drag a new line from (5, 10) towards a point beyond the top edge
    await page.locator('#vl-panel-graph .vg-mode', { hasText: 'Line' }).click();
    await page.locator('#vl-panel-graph canvas.vg-canvas').scrollIntoViewIfNeeded();
    const A2 = await gridToClient(page, 5, 10), P2 = await gridToClient(page, 105, 120);
    await page.mouse.move(A2.x, A2.y);
    await page.mouse.down();
    await page.mouse.move(P2.x, P2.y, { steps: 12 });
    await page.mouse.up();
    const line = (await question(page)).graph.line;
    const g = await page.evaluate(() => VLab.ui.app.current().question().graph.grid);
    const nx = g.cols * g.small, ny = g.rows * g.small;
    const on = (p) => p.gx >= -1e-9 && p.gx <= nx + 1e-9 && p.gy >= -1e-9 && p.gy <= ny + 1e-9;
    const want = (120 - line.a.gy) / (105 - line.a.gx);
    const got = (line.b.gy - line.a.gy) / (line.b.gx - line.a.gx);
    check(!!line && on(line.a) && on(line.b) && Math.abs(line.b.gy - ny) < 1e-6, 'the line ends on the top edge of the grid');
    check(Math.abs(got / want - 1) < 0.005, 'the line keeps the direction drawn (gradient ' + got.toFixed(4) + ' vs ' + want.toFixed(4) + ')');
    // 14: magnifier: after a mouse click and leaving the canvas, no loupe stays behind
    await page.locator('#vl-panel-graph .vg-mode', { hasText: 'Plot' }).click();
    await page.locator('#vl-panel-graph .vg-btn', { hasText: 'Magnifier' }).click();
    await page.locator('#vl-panel-graph canvas.vg-canvas').scrollIntoViewIfNeeded();
    const p1 = await page.evaluate(() => {
      const w = VLab.ui.app.current(), gr = w.question().graph;
      return w.views.graph.gridToClient(VLab.graph.valueToGrid(gr.x, 20), VLab.graph.valueToGrid(gr.y, 1.62));
    });
    await page.mouse.click(p1.x, p1.y);
    await page.waitForTimeout(80);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    check(!(await page.evaluate(() => VLab.ui.app.current().views.graph.loupeShown())), 'magnifier: no loupe left on the selected cross once the pointer has left');
    await page.locator('#vl-panel-graph canvas.vg-canvas').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(120);
    check(await page.evaluate(() => VLab.ui.app.current().views.graph.loupeShown()), 'magnifier: with the keyboard the loupe follows the cross-hair');
    await page.keyboard.press('m');
    // 8: reopen: the axes are collapsed; the tools stay in view when the paper is scrolled
    await page.evaluate(() => VLab.ui.app.current().saveNow());
    await page.reload();
    await page.waitForSelector('.vl-ws .vl-app-canvas');
    await page.click('#vl-tab-graph');
    await page.waitForSelector('#vl-panel-graph canvas.vg-canvas');
    check(!(await page.locator('#vl-panel-graph details.vg-axes').evaluate((d) => d.open)), 'a graph with axes and scales set opens with “Axes and scales” collapsed');
    await page.evaluate(() => {
      const pnl = document.querySelector('#vl-panel-graph');
      const cv = pnl.querySelector('canvas.vg-canvas');
      pnl.scrollTop = cv.getBoundingClientRect().top - pnl.getBoundingClientRect().top + pnl.scrollTop - 60;
    });
    await page.waitForTimeout(100);
    const tb = await page.evaluate(() => {
      const pnl = document.querySelector('#vl-panel-graph').getBoundingClientRect();
      const t = document.querySelector('#vl-panel-graph .vg-modes').getBoundingClientRect();
      const cv = document.querySelector('#vl-panel-graph canvas.vg-canvas').getBoundingClientRect();
      return { pnlTop: pnl.top, pnlBottom: pnl.bottom, top: t.top, bottom: t.bottom, cvTop: cv.top, scrolled: document.querySelector('#vl-panel-graph').scrollTop, vh: innerHeight };
    });
    check(tb.scrolled > 0 && tb.top >= tb.pnlTop - 0.5 && tb.bottom <= Math.min(tb.pnlBottom, tb.vh) && tb.cvTop < tb.vh,
      'with the paper scrolled into view the mode buttons stay visible (toolbar ' + Math.round(tb.top) + '–' + Math.round(tb.bottom) + ', panel from ' + Math.round(tb.pnlTop) + ')');
    await shot(page, 'r08-graph-sticky-tools');
    await ctx.close();
  });

  /* ========================================================================= 9 two tabs */

  await step('Review 9: the same session in two tabs never overwrites or re-creates', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const A = (await open({ ctx, label: 'tab-A' })).page;
    const id = await A.evaluate(() => VLab.ui.app.current().session.id);
    await A.click('#vl-tab-paper');
    await A.fill('#vl-panel-paper [data-key="d"]', '2.35 cm');
    await A.evaluate(() => VLab.ui.app.current().saveNow());
    const B = await ctx.newPage();
    watch(B, 'tab-B');
    await B.goto(INDEX + '#/');
    await B.waitForSelector('.vl-home-resume a');
    await B.click('.vl-home-resume a');
    await B.waitForSelector('.vl-ws .vl-app-canvas');
    await dismissTip(B);
    check(await B.evaluate(() => VLab.ui.app.current().session.id) === id, 'tab B continues the same session');
    await B.click('#vl-tab-table');
    await B.locator('#vl-panel-table input.vt-input--head').nth(0).fill('L / cm');
    await B.evaluate(() => VLab.ui.app.current().saveNow());
    // A learns at once (storage event) or on its next save
    try { await A.waitForSelector('.vl-modal', { timeout: 2500 }); } catch (e) {
      await A.evaluate(() => VLab.ui.app.current().saveNow());
      await A.waitForSelector('.vl-modal', { timeout: 2000 }).catch(() => null);
    }
    const title = await A.locator('.vl-modal-title').textContent().catch(() => '');
    check(/changed in another tab/.test(title || ''), 'tab A shows “This session was changed in another tab”');
    await A.evaluate(() => VLab.ui.app.current().saveNow());
    const stored = await A.evaluate((k) => JSON.parse(localStorage.getItem(k)), 'vlab1:session:' + id);
    check(stored && stored.questions[0].table.columns[0].heading === 'L / cm' && stored.questions[0].answers.d === '2.35 cm',
      'storage keeps tab B’s heading (and A’s earlier answer)');
    check(/changed elsewhere/.test(await A.textContent('.vl-save')), 'tab A’s save status says “Not saved — changed elsewhere”');
    check(await A.locator('.vl-pad-input[disabled]').count() === 1 && await A.locator('#vl-panel-paper [data-key="d"][readonly]').count() === 1,
      'tab A is read-only (reading pad and answers)');
    // tab B is closed (its last save goes in: A is already stopped), then A reloads the stored copy
    await B.close();
    await A.locator('.vl-modal').getByRole('button', { name: 'Reload this session' }).click();
    await A.waitForSelector('.vl-ws .vl-app-canvas');
    await A.waitForTimeout(300);
    const aq = await question(A);
    check(aq.table.columns[0].heading === 'L / cm' && await A.locator('.vl-pad-input[disabled]').count() === 0,
      '“Reload this session” shows the stored copy, editable again');
    // deleted on Saved sessions in another tab: tab A's next autosave must not re-create it
    const C = await ctx.newPage();
    watch(C, 'tab-C');
    await C.goto(INDEX + '#/sessions');
    await C.waitForSelector('.vl-sessions');
    await C.locator('.vl-session', { has: C.locator('a.vl-session-title[href="#/s/' + encodeURIComponent(id) + '"]') })
      .getByRole('button', { name: /^Delete/ }).click();
    await C.waitForSelector('.vl-modal');
    await C.click('.vl-modal .vl-modal-actions .vl-btn--danger');
    await C.waitForSelector('.vl-modal', { state: 'detached' });
    await A.waitForTimeout(300);
    await A.evaluate(() => { const w = VLab.ui.app.current(); if (w) w.markDirty(); });
    await A.waitForTimeout(1600);
    await A.evaluate(() => VLab.ui.app.current() && VLab.ui.app.current().saveNow());
    check(await A.evaluate((k) => localStorage.getItem(k) === null, 'vlab1:session:' + id), 'a session deleted in another tab is not re-created by autosave');
    const t2 = await A.locator('.vl-modal-title').textContent().catch(() => '');
    check(/deleted in another tab/.test(t2 || ''), 'tab A shows “This session was deleted in another tab”');
    await A.locator('.vl-modal').getByRole('button', { name: 'Close' }).click();
    await A.waitForSelector('.vl-home');
    check(await A.evaluate((k) => localStorage.getItem(k) === null, 'vlab1:session:' + id), 'closing does not save it either');
    await ctx.close();
  });

  /* ========================================================================= 10 is in smoke.js (export after hover) */

  /* ========================================================================= 11 phones */

  await step('Review 11: exam on phones: compact header, big panels, no sideways scroll', async () => {
    for (const [w, h] of [[375, 667], [667, 375], [320, 568]]) {
      const { ctx, page } = await open({ exam: true, viewport: { width: w, height: h }, label: 'phone-' + w + 'x' + h });
      const hdr = await rect(page, '#app-header');
      const paper = await visibleHeight(page, '#vl-panel-paper');
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      check(hdr.height <= 0.25 * h + 0.5, w + '×' + h + ': header ' + Math.round(hdr.height) + ' px (≤ 25 % of ' + h + ')');
      check(paper >= 0.6 * h, w + '×' + h + ': paper panel shows ' + Math.round(paper) + ' px (≥ 60 %)');
      check(sw <= w, w + '×' + h + ': no horizontal scroll (' + sw + ')');
      await page.click('.vl-narrow-toggle [data-show="apparatus"]');
      await page.waitForTimeout(300);
      await dismissTip(page);
      await page.evaluate(() => document.querySelector('.vl-app-stage').scrollIntoView({ block: 'nearest' }));
      const stage = await visibleHeight(page, '.vl-app-stage');
      check(stage >= 0.6 * h, w + '×' + h + ': apparatus stage shows ' + Math.round(stage) + ' px (≥ 60 %)');
      // the zoom toolbar keeps its height (a scroll container in the column flexbox once shrank to a 9 px strip,
      // its buttons hidden under the header and the stage)
      const tb = await page.evaluate(() => {
        const hit = (el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!top && (top === el || el.contains(top));
        };
        const bar = document.querySelector('.vl-app-toolbar'), zin = bar.querySelector('button[aria-label="Zoom in"], button[title^="Zoom in"]') || bar.querySelector('.vl-app-zoom button:last-of-type');
        const tgt = bar.querySelector('.vl-app-targets button');
        return { h: bar.getBoundingClientRect().height, zin: !!zin && hit(zin), tgt: !!tgt && hit(tgt) };
      });
      check(tb.h >= 36 && tb.zin && tb.tgt, w + '×' + h + ': the zoom buttons and targets are on screen and clickable (toolbar ' + Math.round(tb.h) + ' px)');
      const sw2 = await page.evaluate(() => document.documentElement.scrollWidth);
      check(sw2 <= w, w + '×' + h + ': no horizontal scroll on the apparatus side (' + sw2 + ')');
      await page.click('.vl-menu-btn');
      const fin = page.locator('#vl-menu').getByRole('menuitem', { name: 'Finish exam' });
      check(await fin.isVisible(), w + '×' + h + ': “Finish exam” is in the Menu');
      check(await page.locator('#vl-menu').getByRole('menuitem', { name: /Copy the seed/ }).isVisible(), w + '×' + h + ': the seed is in the Menu');
      if (w === 667) await shot(page, 'r11-phone-landscape-menu');
      await page.keyboard.press('Escape');
      await ctx.close();
    }
  });

  /* ========================================================================= 12 storage full */

  await step('Review 12: storage full: banner, dialog after marking, progress only once saved', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const { page } = await open({ ctx, label: 'quota' });
    const id = await page.evaluate(() => VLab.ui.app.current().session.id);
    const progressFor = (p) => p.evaluate((sid) => (JSON.parse(localStorage.getItem('vlab1:progress') || '[]')).filter((e) => e.sessionId === sid).length, id);
    await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (String(k).indexOf('vlab1:session:') === 0) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return orig.call(this, k, v);
      };
    });
    await page.click('#vl-tab-paper');
    await page.fill('#vl-panel-paper [data-key="d"]', '2.35 cm');
    await page.waitForSelector('.vl-ws-banner[data-banner="save"]', { timeout: 4000 }).catch(() => null);
    const banner = await page.locator('.vl-ws-banner[data-banner="save"]').textContent().catch(() => '');
    check(/could not be saved/.test(banner || '') && /Saved sessions/.test(banner || ''), 'a failed save shows a banner with what to do');
    await page.getByRole('button', { name: 'Submit for marking' }).first().click();
    await page.waitForSelector('.vl-modal');
    await page.click('.vl-modal .vl-modal-actions .vl-btn--primary');
    await page.waitForSelector('.vl-modal-title >> text=Your marked work was not saved', { timeout: 5000 }).catch(() => null);
    const dlg = await page.locator('.vl-modal').textContent().catch(() => '');
    check(/Download the CSV and PDF from the Report now/.test(dlg || ''), 'after marking, a dialog says the marked work was not saved');
    check(await progressFor(page) === 0, 'no progress entry for work that was not stored');
    await page.click('.vl-modal .vl-modal-actions .vl-btn--primary');
    await page.close();          // its last save fails too: storage still holds the unmarked copy
    const B = await ctx.newPage();
    watch(B, 'quota-B');
    await B.goto(INDEX + '#/s/' + encodeURIComponent(id));
    await B.waitForSelector('.vl-ws .vl-app-canvas');
    await dismissTip(B);
    await B.getByRole('button', { name: 'Submit for marking' }).first().click();
    await B.waitForSelector('.vl-modal');
    await B.click('.vl-modal .vl-modal-actions .vl-btn--primary');
    await B.waitForSelector('#vl-panel-report .vl-report', { timeout: 15000 });
    check(await progressFor(B) === 1, 'submitted again with storage working: exactly one progress entry');
    await ctx.close();
  });

  /* ========================================================================= 13 stopwatch kept */

  await step('Review 13: a stopped stopwatch reading survives question switches and reloads', async () => {
    const { ctx, page } = await open({ exam: true, label: 'stopwatch' });
    await page.click('.vi-sw-start');
    await page.waitForTimeout(1500);
    await page.click('.vi-sw-start');
    const shown = await page.textContent('.vi-sw-digits');
    await page.click('.vl-qswitch-btn[data-q="1"]');
    await page.waitForSelector('#vl-panel-paper [data-key="limitations"]');
    await page.click('.vl-qswitch-btn[data-q="0"]');
    await page.waitForSelector('#vl-panel-paper [data-key="d"]');
    check(await page.textContent('.vi-sw-digits') === shown && parseFloat(shown) > 1, 'Q1 → Q2 → Q1 keeps the reading (' + shown + ')');
    await page.reload();
    await page.waitForSelector('.vl-ws .vl-app-canvas');
    await page.waitForTimeout(300);
    check(await page.textContent('.vi-sw-digits') === shown, 'a reload keeps it too');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('x');
    check(parseFloat(await page.textContent('.vi-sw-digits')) === 0, 'X resets it to 0.00');
    await ctx.close();
  });

  /* ========================================================================= 15 idle */

  await step('Review 15: no redraws while nothing moves', async () => {
    const { ctx, page } = await open({ label: 'idle' });
    await page.getByRole('button', { name: 'Stop the bob' }).click();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(1200);
    const count = (ms) => page.evaluate((t) => new Promise((res) => {
      const c = VLab.ui.app.current().app.controller, orig = c.draw;
      let n = 0;
      c.draw = function () { n++; return orig.apply(this, arguments); };
      setTimeout(() => { c.draw = orig; res(n); }, t);
    }), ms);
    const idle = await count(2000);
    check(idle <= 5, 'at rest with no input: ' + idle + ' draws in 2 s (≤ 5)');
    const pressed = await page.evaluate(() => new Promise((res) => {
      const c = VLab.ui.app.current().app.controller, orig = c.draw;
      let n = 0;
      c.draw = function () { n++; return orig.apply(this, arguments); };
      Array.from(document.querySelectorAll('.vl-ctl-btn')).find((b) => b.textContent.trim() === 'Lengthen 1 mm').click();
      setTimeout(() => { c.draw = orig; res(n); }, 120);
    }));
    check(pressed >= 1, 'a control pressed while idle redraws at once (' + pressed + ')');
    await page.getByRole('button', { name: 'Pull bob aside' }).click();
    await page.getByRole('button', { name: 'Release bob' }).click();
    const swinging = await count(1000);
    check(swinging >= 30, 'while the bob swings it redraws about every frame (' + swinging + ' in 1 s)');
    await ctx.close();
  });

  /* ========================================================================= 16 table */

  await step('Review 16: a six-column table fits; row numbers stay at the left', async () => {
    const { ctx, page } = await open({ label: 'table' });
    await fillTable(page, ['L / cm', 't1 / s', 't2 / s', 'mean t / s', 'T / s', 'T^2 / s^2'], [['50.0', '28.98', '29.04', '29.01', '1.451', '2.105']]);
    const fit = await page.evaluate(() => { const s = document.querySelector('#vl-panel-table .vt-scroll'); return { sw: s.scrollWidth, cw: s.clientWidth }; });
    check(fit.sw <= fit.cw + 1, 'six headed columns fit at 1366×768 (' + fit.sw + ' ≤ ' + fit.cw + ')');
    await fillTable(page, ['L / cm', 't1 / s', 't2 / s', 'mean t / s', 'T / s', 'T^2 / s^2', 'x / s', 'y / s'], []);
    await page.locator('#vl-panel-table input.vt-input:not(.vt-input--head)').nth(7).click();
    const r = await page.evaluate(() => {
      const s = document.querySelector('#vl-panel-table .vt-scroll');
      const num = () => document.querySelector('#vl-panel-table tbody tr .vt-rownum').getBoundingClientRect().left;
      s.scrollLeft = 0;
      const before = num();
      s.scrollLeft = s.scrollWidth;
      const box = s.getBoundingClientRect();
      // the left edge of the scroll box's content area (inside its border and padding)
      const inner = box.left + s.clientLeft + parseFloat(getComputedStyle(s).paddingLeft);
      return { scrolled: s.scrollLeft, before, after: num(), inner };
    });
    check(r.scrolled > 0 && Math.abs(r.after - r.before) <= 1 && Math.abs(r.after - r.inner) <= 1,
      'scrolled sideways by ' + Math.round(r.scrolled) + ' px, row 1’s number stays at the left edge (' + Math.round(r.after - r.inner) + ' px from it)');
    await ctx.close();
  });

  /* ========================================================================= 17 long answer */

  await step('Review 17: a long unbroken answer does not widen the report', async () => {
    const { ctx, page } = await open({ label: 'long' });
    await page.click('#vl-tab-paper');
    await page.fill('#vl-panel-paper [data-key="d"]', '9'.repeat(2000));
    await page.getByRole('button', { name: 'Submit for marking' }).first().click();
    await page.waitForSelector('.vl-modal');
    await page.click('.vl-modal .vl-modal-actions .vl-btn--primary');
    await page.waitForSelector('#vl-panel-report .vl-report', { timeout: 15000 });
    const w = await page.evaluate(() => { const p = document.querySelector('#vl-panel-report'); return { sw: p.scrollWidth, cw: p.clientWidth }; });
    check(w.sw <= w.cw + 1, 'report panel does not overflow sideways (' + w.sw + ' ≤ ' + w.cw + ')');
    await ctx.close();
  });

  /* ========================================================================= 18 apparatus errors */

  await step('Review 18: apparatus errors are shown, cleared after recovery, and can be reloaded', async () => {
    const { ctx, page } = await open({ label: 'faults' });
    const msg = () => page.evaluate(() => { const m = document.querySelector('.vl-app-stagemsg'); return m.hidden ? '' : m.textContent; });
    // (expected errors are logged with console.error: silence it while faults are injected)
    await page.evaluate(() => { window.__err = console.error; console.error = function () {}; });
    await page.evaluate(() => {
      const c = VLab.ui.app.current().app.controller, orig = c.draw;
      let n = 0;
      c.draw = function () { if (n++ < 3) throw new Error('transient'); c.draw = orig; return orig.apply(this, arguments); };
      VLab.ui.app.current().app.services.requestRedraw();
    });
    await page.waitForTimeout(50);
    await frames(page, 2);
    const shownMsg = await msg();
    check(/could not be drawn: transient/.test(shownMsg), 'a draw error shows the stage message');
    await page.waitForTimeout(1000);
    check(await msg() === '', 'the message is hidden again after the drawing recovers');
    await page.evaluate(() => {
      const c = VLab.ui.app.current().app.controller;
      c.update = function () { throw new Error('stuck'); };
      VLab.ui.app.current().app.services.requestRedraw();
    });
    await page.waitForTimeout(150);
    check(/stopped responding: stuck/.test(await msg()), 'an update error shows “The apparatus stopped responding”');
    await page.waitForTimeout(1500);
    check(await page.locator('.vl-app-reload').isVisible(), 'after repeated failures the apparatus stops and offers “Reload apparatus”');
    const L0 = await page.evaluate(() => VLab.ui.app.current().question().apparatusState && VLab.ui.app.current().question().apparatusState.L);
    await page.click('.vl-app-reload');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ s: VLab.ui.app.current().app.controller.snapshot(), hidden: document.querySelector('.vl-app-stagemsg').hidden }));
    check(after.hidden && after.s && (L0 === undefined || L0 === null || Math.abs(after.s.L - L0) < 1e-6), 'Reload apparatus rebuilds it from its saved state');
    await page.evaluate(() => { console.error = window.__err; });
    await ctx.close();
  });

  /* ========================================================================= 19 instrument lab heading */

  await step('Review 19: the instrument lab has a page heading', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    watch(page, 'lab');
    await page.goto(INDEX + '#/');
    await page.waitForSelector('.vl-home');
    await page.goto(INDEX + '#/instruments');
    await page.waitForSelector('.vi-navbtn');
    const r = await page.evaluate(() => ({ title: document.title, active: document.activeElement && document.activeElement.tagName, text: document.activeElement && document.activeElement.textContent }));
    check(/^Instrument lab · /.test(r.title), 'tab title starts with “Instrument lab ·” (' + r.title + ')');
    check(r.active === 'H1' && r.text === 'Instrument lab', 'the focus is on the page’s h1');
    await ctx.close();
  });
};
