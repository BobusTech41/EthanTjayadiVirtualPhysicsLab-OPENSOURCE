#!/usr/bin/env node
/**
 * End-to-end smoke test (dev only). Drives the real index.html from file:// in headless Chromium via Playwright.
 *
 *   node tests/e2e/smoke.js
 *
 * Environment:
 *   SMOKE_SCREENS   directory for screenshots (default: <os tmpdir>/vlab-smoke)
 *   SMOKE_HEADFUL=1 show the browser
 *
 * The run FAILS (exit code 1) on any failed check, any console error, any uncaught page error or any failed
 * file request (e.g. a missing script). Test-only access to hidden values (VLab.*) is used to compute where to
 * click and what realistic readings to type; the student UI is always driven through real clicks and typing.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX = 'file://' + path.join(ROOT, 'index.html');
const SHOTS = process.env.SMOKE_SCREENS || path.join(os.tmpdir(), 'vlab-smoke');
const SEED = 'PEN-7K2Q-91C3';
fs.mkdirSync(SHOTS, { recursive: true });

const failures = [];
const problems = [];          // console errors, page errors, failed requests
let passed = 0;

function check(cond, msg) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { failures.push(msg); console.log('  \x1b[31m✗ ' + msg + '\x1b[0m'); }
  return !!cond;
}

async function step(name, fn) {
  console.log('\n\x1b[1m' + name + '\x1b[0m');
  try { await fn(); }
  catch (e) {
    failures.push(name + ': ' + (e && e.message ? e.message.split('\n')[0] : e));
    console.log('  \x1b[31m✗ threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e) + '\x1b[0m');
  }
}

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push('[' + label + '] console.error: ' + m.text());
    else if (m.type() === 'warning') console.log('  (console warning) ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('[' + label + '] page error: ' + (e.stack || e.message)));
  page.on('requestfailed', (r) => problems.push('[' + label + '] request failed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
}

async function shot(page, name, opts) {
  const file = path.join(SHOTS, name + '.png');
  await page.screenshot(Object.assign({ path: file }, opts || {}));
  console.log('  📷 ' + file);
}

/* --------------------------------------------------------------------------- page helpers */

const ws = (page, fn, arg) => page.evaluate(fn, arg);
const question = (page) => ws(page, () => JSON.parse(JSON.stringify(VLab.ui.app.current().question())));
const snap = (page) => ws(page, () => VLab.ui.app.current().app.controller.snapshot());
const logTypes = (page) => ws(page, () => VLab.ui.app.current().question().log.map((e) => e.type));

async function button(page, name, scope) {
  const loc = (scope ? page.locator(scope) : page).getByRole('button', { name: name, exact: true });
  await loc.first().click();
}

/** World (cm) → client px for the apparatus canvas. */
function worldToClient(page, wx, wy) {
  return page.evaluate(([x, y]) => {
    const app = VLab.ui.app.current().app;
    const v = app.getView();
    const s = v.fit * v.z;
    const r = document.querySelector('.vl-app-canvas').getBoundingClientRect();
    return { x: r.left + (x - v.cx) * s + v.width / 2, y: r.top + (y - v.cy) * s + v.height / 2 };
  }, [wx, wy]);
}

/** Value → client px on the graph canvas (scrolled into view first). */
async function valueToClient(page, xv, yv) {
  await page.locator('#vl-panel-graph canvas.vg-canvas').scrollIntoViewIfNeeded();
  return page.evaluate(([x, y]) => {
    const w = VLab.ui.app.current();
    const g = w.question().graph;
    return w.views.graph.gridToClient(VLab.graph.valueToGrid(g.x, x), VLab.graph.valueToGrid(g.y, y));
  }, [xv, yv]);
}

async function confirmDialog(page) {
  await page.waitForSelector('.vl-modal');
  await page.click('.vl-modal .vl-modal-actions .vl-btn--primary');
  await page.waitForSelector('.vl-modal', { state: 'detached' });
}

async function download(page, trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), trigger()]);
  const p = await dl.path();
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(p) };
}

/* --------------------------------------------------------------------------- main */

(async () => {
  const browser = await chromium.launch({ headless: !process.env.SMOKE_HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  watch(page, 'desktop');
  let practiceId = null;
  let typed = null;            // what we typed, to compare after reload

  await step('Home page renders', async () => {
    await page.goto(INDEX + '#/');
    await page.waitForSelector('.vl-home');
    check(await page.locator('.vl-home-list a').count() >= 6, 'home lists the features');
    check(/Virtual Practical Lab/.test(await page.textContent('.vl-home')), 'home shows the title');
    await shot(page, '01-home');
  });

  await step('Practice: start the pendulum graph variant', async () => {
    await page.click('.vl-home-list a[href="#/practice"]');
    await page.waitForSelector('form.vl-form');
    await page.check('input[name=variant][value="pendulum|graph"]');
    await page.fill('#vl-practice-seed', SEED);
    await page.click('form.vl-form button[type=submit]');
    await page.waitForSelector('.vl-ws .vl-app-canvas');
    await page.waitForTimeout(400);
    practiceId = decodeURIComponent((await page.evaluate(() => location.hash)).replace('#/s/', ''));
    check(!!practiceId, 'workspace route has a session id (' + practiceId + ')');
    check((await page.textContent('.vl-seed-code')) === SEED, 'seed shown in the header');
    const tip = page.locator('.vl-app-hint button');
    if (await tip.isVisible()) await tip.click();
  });

  await step('Apparatus canvas draws', async () => {
    const info = await page.evaluate(() => {
      const c = document.querySelector('.vl-app-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 61) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, cssH: r.height, colours: seen.size, msg: !document.querySelector('.vl-app-stagemsg').hidden };
    });
    check(info.w > 300 && info.h > 300, 'canvas has a real size (' + info.w + '×' + info.h + ' device px)');
    check(info.colours > 30, 'canvas has drawn content (' + info.colours + ' sampled colours)');
    check(!info.msg, 'no apparatus error message');
    check(info.cssH >= 380, 'apparatus stage is at least 380 px tall at 1366×900 (' + Math.round(info.cssH) + ' px)');
  });

  await step('String length: shorten and lengthen', async () => {
    const L0 = (await snap(page)).L;
    await button(page, 'Shorten');
    const L1 = (await snap(page)).L;
    check(L1 < L0 - 0.2 && L1 > L0 - 0.9, 'Shorten reduces L by about 5 mm (' + L0 + ' → ' + L1 + ')');
    await button(page, 'Lengthen');
    await button(page, 'Lengthen');
    const L2 = (await snap(page)).L;
    check(L2 > L1 + 0.5, 'Lengthen ×2 increases L (' + L1 + ' → ' + L2 + ')');
    await button(page, 'Lengthen 1 mm');
    const L3 = (await snap(page)).L;
    check(L3 > L2 + 0.04 && L3 < L2 + 0.2, 'fine step adds about 1 mm (' + L2 + ' → ' + L3 + ')');
  });

  await step('Drag the bob aside and release it', async () => {
    await button(page, 'Fit');
    await page.waitForTimeout(450);
    const s = await snap(page);
    const tgt = await page.evaluate(() => {
      const t = VLab.ui.app.current().app.controller.zoomTargets.find((z) => z.id === 'bob');
      return { x: t.x, y: t.y };
    });
    const centre = await worldToClient(page, tgt.x - 1, tgt.y + s.d / 2);
    const px = await page.evaluate(() => { const v = VLab.ui.app.current().app.getView(); return v.fit * v.z; });
    const dx = Math.tan(8 * Math.PI / 180) * (s.Leff) * px;    // about 8°
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(centre.x - dx * i / 6, centre.y, { steps: 2 });
    const held = await snap(page);
    check(held.amplitudeDeg > 4 && held.amplitudeDeg < 14, 'bob held aside at about 8° (' + held.amplitudeDeg + '°)');
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await snap(page);
    check(after.swinging === true, 'bob swings after release');
    const q = await question(page);
    const rel = q.log.filter((e) => e.type === 'release').pop();
    check(!!rel && rel.amplitudeDeg > 4 && rel.amplitudeDeg < 14, 'release logged with its amplitude (' + (rel && rel.amplitudeDeg) + '°)');
  });

  await step('Stopwatch: Start/Stop buttons and the Space shortcut', async () => {
    await page.click('.vi-sw-start');
    await page.waitForTimeout(1300);
    check((await page.textContent('.vi-sw-start')).trim() === 'Stop', 'Start button turns into Stop while running');
    await page.click('.vi-sw-start');
    const shown = parseFloat(await page.textContent('.vi-sw-digits'));
    check(shown >= 1.2 && shown < 3, 'stopwatch shows the elapsed time (' + shown + ' s)');
    let q = await question(page);
    const stop = q.log.filter((e) => e.type === 'stopwatch-stop').pop();
    check(!!stop && stop.oscillationsTrue > 0 && typeof stop.elapsedTrue === 'number', 'stop event logged with hidden truth (osc ' + (stop && stop.oscillationsTrue) + ')');
    await page.click('.vi-sw-reset');
    check(parseFloat(await page.textContent('.vi-sw-digits')) === 0, 'Reset sets the display to 0.00');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const before = (await logTypes(page)).filter((t) => t === 'stopwatch-stop').length;
    await page.keyboard.press('Space');
    await page.waitForTimeout(900);
    await page.keyboard.press('Space');
    const shown2 = parseFloat(await page.textContent('.vi-sw-digits'));
    const after = (await logTypes(page)).filter((t) => t === 'stopwatch-stop').length;
    check(after === before + 1, 'Space starts and stops the stopwatch exactly once each');
    check(shown2 >= 0.8 && shown2 < 2.5, 'Space-timed display is plausible (' + shown2 + ' s)');
    await page.keyboard.press('x');
    check(parseFloat(await page.textContent('.vi-sw-digits')) === 0, 'X resets the stopwatch');
  });

  await step('Zoom on the rule (screenshot)', async () => {
    await page.getByRole('button', { name: 'Zoom to Cork and rule' }).click();
    await page.waitForTimeout(700);
    const v = await page.evaluate(() => VLab.ui.app.current().app.getView());
    check(v.z > 5, 'zoom target zooms in (×' + v.z.toFixed(1) + ')');
    await shot(page, '02-practice-rule-zoom');
    await page.getByRole('button', { name: 'Zoom to Vernier scale' }).click();
    await page.waitForTimeout(700);
    await shot(page, '02b-practice-vernier-zoom');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    const z2 = (await page.evaluate(() => VLab.ui.app.current().app.getView())).z;
    check(z2 > v.z, 'the + button zooms in further');
    await button(page, 'Fit');
    await page.waitForTimeout(450);
  });

  /* Realistic readings from the hidden physics (test only). */
  const data = await page.evaluate(() => {
    const w = VLab.ui.app.current();
    const exp = VLab.getExperiment('pendulum');
    const p = w.params;
    const Ls = [20.0, 35.0, 50.0, 65.0, 80.0, 95.0];
    const rows = Ls.map((L, i) => {
      const T = exp.model.period(L, p.d, p.delta, 5);
      const t = Math.floor(20 * T * 100 + (i % 2 ? 7 : 3)) / 100;    // a little reaction-time scatter, truncated display
      const Tm = t / 20;
      return { L: L.toFixed(1), t: t.toFixed(2), T: Tm.toPrecision(4), T2: (Tm * Tm).toPrecision(4) };
    });
    return { d: p.d, rows: rows };
  });

  await step('Table: record via the reading pad, type headings and cells', async () => {
    await page.click('#vl-tab-table');
    await page.waitForSelector('#vl-panel-table .vt-root');
    await page.getByRole('button', { name: 'Add a column at the right' }).click();
    const heads = page.locator('#vl-panel-table input.vt-input--head');
    check(await heads.count() === 4, 'four columns after + Column');
    const cells = page.locator('#vl-panel-table input.vt-input:not(.vt-input--head)');
    await cells.nth(0).click();
    const label = await page.textContent('.vl-pad-target');
    check(/row 1/i.test(label), 'pad shows the selected cell as its target (' + label.trim() + ')');
    await page.fill('.vl-pad-input', data.rows[0].L);
    await page.click('.vl-pad-record');
    check(await cells.nth(0).inputValue() === data.rows[0].L, 'Record wrote the reading into the selected cell');
    let q = await question(page);
    const c1 = q.table.columns[0].id;
    check(q.table.rows[0].cells[c1] === data.rows[0].L, 'the model table holds the recorded string exactly');
    check(q.log.some((e) => e.type === 'record' && e.typed === data.rows[0].L && e.snapshot && typeof e.snapshot.L === 'number'),
      'record logged with an apparatus snapshot');
    const H = ['L / cm', 't / s', 'T / s', 'T² / s²'];
    for (let i = 0; i < 4; i++) await heads.nth(i).fill(H[i]);
    for (let r = 0; r < 6; r++) {
      const row = data.rows[r];
      const vals = [row.L, row.t, row.T, row.T2];
      for (let c = 0; c < 4; c++) {
        if (r === 0 && c === 0) continue;
        await cells.nth(r * 4 + c).click();
        await page.keyboard.type(vals[c]);
      }
    }
    await page.keyboard.press('Enter');
    q = await question(page);
    const ids = q.table.columns.map((c) => c.id);
    check(JSON.stringify(q.table.columns.map((c) => c.heading)) === JSON.stringify(H), 'headings stored exactly as typed');
    check(q.table.rows.slice(0, 6).every((row, r) => row.cells[ids[1]] === data.rows[r].t && row.cells[ids[3]] === data.rows[r].T2),
      'cells stored exactly as typed');
    check(await page.getByRole('button', { name: 'Download the table as a CSV file' }).count() === 1, 'table has an Export CSV button');
    await page.waitForTimeout(500);          // practice hints are linted 400 ms after typing stops
    await shot(page, '03-table');
    typed = { table: q.table };
  });

  let readOffs = null, gradient = null, intercept = null;
  await step('Graph: axes, plotting, line, gradient triangle, intercept', async () => {
    await page.click('#vl-tab-graph');
    await page.waitForSelector('#vl-panel-graph canvas.vg-canvas');
    await page.selectOption('[data-field="x-col"]', { label: 'L / cm' });
    await page.selectOption('[data-field="y-col"]', { label: 'T² / s²' });
    for (const [f, v] of [['x-origin', '0'], ['x-per', '10'], ['y-origin', '0'], ['y-per', '0.4'], ['x-every', null]]) {
      if (!v) continue;
      await page.fill('[data-field="' + f + '"]', v);
      await page.press('[data-field="' + f + '"]', 'Tab');
    }
    await page.selectOption('[data-field="x-every"]', '2');
    let q = await question(page);
    check(q.graph.x.colId === typed.table.columns[0].id && q.graph.y.colId === typed.table.columns[3].id, 'axes columns chosen');
    check(q.graph.x.label === 'L / cm' && q.graph.y.label === 'T² / s²', 'axis labels default to the headings');
    check(q.graph.x.perLarge === 10 && q.graph.y.perLarge === 0.4, 'scales set');
    // plot by clicking each point position
    for (let r = 0; r < 6; r++) {
      const pt = await valueToClient(page, parseFloat(data.rows[r].L), parseFloat(data.rows[r].T2));
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(60);
    }
    q = await question(page);
    check(q.graph.points.length === 6, 'six points plotted by clicking (' + q.graph.points.length + ')');
    const plot = await page.evaluate(() => { const q = VLab.ui.app.current().question(); return VLab.graph.checkPlotting(q.graph, q.table); });
    check(plot.ok, 'every point is within half a small square of its row');
    // best-fit line: drag the ruler along the least-squares line
    const fit = await page.evaluate((rows) => VLab.stats.linearFit(rows.map((r) => +r.L), rows.map((r) => +r.T2)), data.rows);
    await page.locator('#vl-panel-graph .vg-mode', { hasText: 'Line' }).click();
    const A = await valueToClient(page, 14, fit.m * 14 + fit.c);
    const B = await valueToClient(page, 97, fit.m * 97 + fit.c);
    await page.mouse.move(A.x, A.y);
    await page.mouse.down();
    await page.mouse.move(B.x, B.y, { steps: 12 });
    await page.mouse.up();
    q = await question(page);
    check(!!q.graph.line, 'line drawn');
    const line = await page.evaluate(() => { const q = VLab.ui.app.current().question(); return VLab.graph.checkLine(q.graph, q.table); });
    check(line.ok, 'drawn line passes checkLine (balanced, spans the data)' + (line.ok ? '' : ': ' + line.problems.join('; ')));
    // gradient triangle: two clicks on the line far apart
    await page.locator('#vl-panel-graph .vg-mode', { hasText: 'Gradient' }).click();
    for (const xv of [20, 90]) {
      const yv = await page.evaluate((x) => VLab.graph.lineValueAt(VLab.ui.app.current().question().graph, x), xv);
      const p = await valueToClient(page, xv, yv);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(80);
    }
    q = await question(page);
    check(!!q.graph.triangle, 'gradient triangle drawn');
    const corners = await page.evaluate(() => {
      const g = VLab.ui.app.current().question().graph;
      const t = g.triangle;
      return t && { x1: VLab.graph.gridToValue(g.x, t.p1.gx), y1: VLab.graph.gridToValue(g.y, t.p1.gy),
        x2: VLab.graph.gridToValue(g.x, t.p2.gx), y2: VLab.graph.gridToValue(g.y, t.p2.gy) };
    });
    readOffs = { x1: corners.x1.toFixed(1), y1: corners.y1.toFixed(2), x2: corners.x2.toFixed(1), y2: corners.y2.toFixed(2) };
    for (const k of ['x1', 'y1', 'x2', 'y2']) await page.fill('[data-field="ro-' + k + '"]', readOffs[k]);
    await page.press('[data-field="ro-y2"]', 'Tab');
    const res = await page.textContent('#vl-panel-graph .vg-result');
    check(/Δy\/Δx from your read-offs = .*\d/.test(res), 'gradient from the typed read-offs is shown (' + res.replace(/\s+/g, ' ').trim() + ')');
    const tri = await page.evaluate(() => VLab.graph.checkTriangle(VLab.ui.app.current().question().graph));
    check(tri.present && tri.bigEnough && tri.readOffsOk, 'triangle is large and the read-offs match (hyp ' + (tri.hypFraction || 0).toFixed(2) + ')');
    gradient = ((+readOffs.y2 - +readOffs.y1) / (+readOffs.x2 - +readOffs.x1)).toPrecision(3);
    // intercept read directly (x starts at 0)
    await page.locator('#vl-panel-graph .vg-mode', { hasText: 'Intercept' }).click();
    const c0 = await page.evaluate(() => VLab.graph.lineValueAt(VLab.ui.app.current().question().graph, 0));
    intercept = c0.toFixed(2);
    await page.fill('[data-field="icpt"]', intercept);
    await page.press('[data-field="icpt"]', 'Tab');
    const ic = await page.evaluate((v) => VLab.graph.checkIntercept(VLab.ui.app.current().question().graph, v), intercept);
    check(ic.ok, 'intercept read at x = 0 is accepted (' + intercept + ')');
    check(await page.getByRole('button', { name: 'Export PNG' }).count() === 1, 'graph has an Export PNG button');
    await page.locator('#vl-panel-graph canvas.vg-canvas').scrollIntoViewIfNeeded();
    await shot(page, '04-graph-line-triangle');
  });

  await step('Paper: fill the answers', async () => {
    await page.click('#vl-tab-paper');
    await page.waitForSelector('#vl-panel-paper [data-key="d"]');
    const s = await snap(page);
    const T50 = data.rows[2].T;
    const a = gradient;
    const g = (4 * Math.PI * Math.PI / (parseFloat(a) * 100)).toPrecision(3);
    const answers = {
      d: (Math.round(data.d * 100) / 100).toFixed(2) + ' cm',
      L: s.L.toFixed(1) + ' cm',
      T_working: 'Time for 20 oscillations measured twice; T = t / 20',
      T: T50 + ' s',
      gradient: gradient,
      intercept: intercept,
      a: a + ' s² cm⁻¹',
      b: intercept + ' s²',
      g_working: 'g = 4π² / a with a in s² m⁻¹',
      g: g + ' m s⁻²'
    };
    for (const k of Object.keys(answers)) await page.fill('#vl-panel-paper [data-key="' + k + '"]', answers[k]);
    // the pad can also write into an answer line
    await page.click('#vl-panel-paper [data-key="L"]');
    check(/\(b\).*L =/.test(await page.textContent('.vl-pad-target')), 'pad target follows the focused answer line');
    await page.fill('.vl-pad-input', answers.L);
    await page.click('.vl-pad-record');
    const q = await question(page);
    check(Object.keys(answers).every((k) => q.answers[k] === answers[k]), 'answers stored exactly as typed');
    typed.answers = answers;
    typed.L = s.L;
    await shot(page, '05-paper-filled');
  });

  await step('Keyboard coordination: undo once, Space not stolen from the graph, focused Start toggles once', async () => {
    const swStops = async () => (await logTypes(page)).filter((t) => t === 'stopwatch-stop').length;
    await page.click('#vl-tab-table');
    const cells = page.locator('#vl-panel-table input.vt-input:not(.vt-input--head)');
    const before = await cells.nth(6 * 4).inputValue();
    await cells.nth(6 * 4).click();
    await page.keyboard.type('9');
    await page.keyboard.press('Control+z');
    const q = await question(page);
    check(await cells.nth(6 * 4).inputValue() === before && q.table.rows[5].cells[q.table.columns[3].id] === data.rows[5].T2,
      'Ctrl+Z in the table undoes exactly one edit');
    await page.click('#vl-tab-graph');
    await page.locator('#vl-panel-graph canvas.vg-canvas').focus();
    const n0 = await swStops();
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    check((await page.textContent('.vi-sw-start')).trim() === 'Start', 'Space on the focused graph canvas does not start the stopwatch');
    await page.locator('.vi-sw-start').focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    check((await page.textContent('.vi-sw-start')).trim() === 'Stop', 'Space on the focused Start button starts the stopwatch');
    await page.keyboard.press('Space');
    check(await swStops() === n0 + 1, 'and stops it again with exactly one stop event');
    await page.click('.vi-sw-reset');
    await page.click('#vl-tab-paper');
  });

  await step('Tools tab: calculator', async () => {
    await page.click('#vl-tab-tools');
    await page.waitForSelector('#vl-panel-tools .vl-calc-input');
    await page.fill('#vl-panel-tools .vl-calc-input', '4*pi^2/4.03');
    await page.press('#vl-panel-tools .vl-calc-input', 'Enter');
    const out = (await page.textContent('#vl-panel-tools .vl-calc-result')).trim();
    check(/^=?\s*9\.79/.test(out), 'calculator evaluates 4π²/4.03 (' + out + ')');
    await page.click('#vl-tab-paper');
  });

  await step('Reload restores the session from localStorage', async () => {
    await page.waitForSelector('.vl-save--saved', { timeout: 5000 });
    const before = await question(page);
    await page.reload();
    await page.waitForSelector('.vl-ws .vl-app-canvas');
    await page.waitForTimeout(300);
    const q = await question(page);
    check(JSON.stringify(q.table.rows) === JSON.stringify(before.table.rows), 'table restored');
    check(q.graph.points.length === 6 && !!q.graph.line && !!q.graph.triangle, 'graph restored (points, line, triangle)');
    check(JSON.stringify(q.answers) === JSON.stringify(before.answers), 'answers restored');
    check(q.log.length === before.log.length, 'lab log restored (' + q.log.length + ' events)');
    const s = await snap(page);
    check(Math.abs(s.L - typed.L) < 1e-3, 'apparatus string length restored');
    check(await page.inputValue('#vl-panel-paper [data-key="g"]') === typed.answers.g, 'paper answer visible after reload');
  });

  let reportTotals = null;
  await step('Submit for marking and read the report', async () => {
    await button(page, 'Submit for marking', '.vl-ws-actions');
    await confirmDialog(page);
    await page.waitForSelector('#vl-panel-report .vl-report', { timeout: 15000 });
    const txt = await page.textContent('#vl-panel-report');
    check(/MMO/.test(txt) && /PDO/.test(txt) && /ACE/.test(txt), 'report shows MMO, PDO and ACE');
    reportTotals = await page.evaluate(() => {
      const r = VLab.ui.app.current().question().report;
      return { total: r.total, max: r.max, skills: r.skills, n: r.points.length };
    });
    check(reportTotals.max === 20, 'report is out of 20');
    check(reportTotals.skills.MMO.max === 8 && reportTotals.skills.PDO.max === 7 && reportTotals.skills.ACE.max === 5, 'skill maxima 8/7/5');
    console.log('    score ' + reportTotals.total + '/20  MMO ' + reportTotals.skills.MMO.got + ' PDO ' + reportTotals.skills.PDO.got + ' ACE ' + reportTotals.skills.ACE.got);
    check(reportTotals.total >= 12, 'a careful attempt scores well (' + reportTotals.total + '/20)');
    check(await page.locator('#vl-panel-report .vl-mp').count() === reportTotals.n, 'every mark point is listed');
    check(await page.locator('#vl-panel-report .vl-model').count() === 1, 'model answer section present');
    check(await page.locator('#vl-panel-report .vl-model-table .vt-root').count() >= 1, 'model answer table rendered');
    check(await page.locator('#vl-panel-report .vl-model-graph canvas').count() >= 1, 'model answer graph rendered');
    check(await page.locator('.vl-pad-input[disabled]').count() === 1, 'reading pad locked after marking');
    await shot(page, '06-report');
    await page.locator('#vl-panel-report .vl-model').scrollIntoViewIfNeeded();
    await shot(page, '06b-report-model');
  });

  /** Width and height of a PNG file (IHDR). */
  const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
  let pngAfterHover = null;
  await step('Graph export ignores the live Graph tab (magnifier on and hovering)', async () => {
    await page.click('#vl-tab-graph');
    await page.waitForSelector('#vl-panel-graph canvas.vg-canvas');
    await page.locator('#vl-panel-graph .vg-btn', { hasText: 'Magnifier' }).click();
    const c = page.locator('#vl-panel-graph canvas.vg-canvas');
    await c.scrollIntoViewIfNeeded();
    const box = await c.boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.42);
    await page.waitForTimeout(150);
    check(await page.evaluate(() => VLab.ui.app.current().views.graph.loupeShown()), 'the loupe is showing on the live graph');
    await page.click('#vl-tab-report');
    const png = await download(page, () => page.locator('#vl-panel-report .vl-report-export').getByRole('button', { name: 'Graph (PNG)' }).click());
    pngAfterHover = png.bytes;
    const sz = pngSize(png.bytes);
    check(sz.w >= 1700 && sz.h >= 1300, 'exported graph has the fixed print size, whatever the panel width (' + sz.w + '×' + sz.h + ' px)');
    fs.writeFileSync(path.join(SHOTS, 'report-graph-after-hover.png'), png.bytes);
  });

  await step('Exports: CSV, PNG and PDF', async () => {
    const box = '#vl-panel-report .vl-report-export';
    for (const n of ['Table (CSV)', 'Graph (PNG)', 'Report (PDF)']) {
      check(await page.locator(box).getByRole('button', { name: n }).isEnabled(), n + ' button present and enabled');
    }
    const csv = await download(page, () => page.locator(box).getByRole('button', { name: 'Table (CSV)' }).click());
    const csvText = csv.bytes.toString('utf8');
    check(csvText.charCodeAt(0) === 0xFEFF && /L \/ cm,t \/ s,T \/ s,T² \/ s²/.test(csvText), 'CSV has the BOM and the headings as typed (' + csv.name + ')');
    const png = await download(page, () => page.locator(box).getByRole('button', { name: 'Graph (PNG)' }).click());
    check(png.bytes.slice(1, 4).toString() === 'PNG' && png.bytes.length > 2000, 'PNG download is an image (' + png.bytes.length + ' bytes)');
    const pdf = await download(page, () => page.locator(box).getByRole('button', { name: 'Report (PDF)' }).click());
    check(pdf.bytes.slice(0, 5).toString() === '%PDF-', 'PDF blob starts with %PDF (' + pdf.bytes.length + ' bytes)');
    check(/%%EOF\s*$/.test(pdf.bytes.slice(-16).toString('latin1')), 'PDF ends with %%EOF');
    fs.writeFileSync(path.join(SHOTS, 'report.pdf'), pdf.bytes);
  });

  await step('Reload after marking shows the report again', async () => {
    await page.reload();
    await page.waitForSelector('#vl-panel-report .vl-report', { timeout: 10000 });
    const q = await question(page);
    check(q.submitted && q.report && q.report.total === reportTotals.total, 'marked session restored with its report');
    const png = await download(page, () => page.locator('#vl-panel-report .vl-report-export').getByRole('button', { name: 'Graph (PNG)' }).click());
    check(!!pngAfterHover && png.bytes.equals(pngAfterHover),
      'the graph PNG after a fresh reload is pixel-identical to the one exported after hovering with the magnifier');
  });

  await step('Try again (same seed) starts a fresh attempt on the same apparatus', async () => {
    await button(page, 'Try again (same seed)', '.vl-ws-actions');
    await page.waitForFunction((id) => location.hash.indexOf('#/s/') === 0 && decodeURIComponent(location.hash.slice(4)) !== id, practiceId);
    await page.waitForSelector('.vl-ws .vl-app-canvas');
    const q = await question(page);
    check(q.seed === SEED && !q.submitted && !q.report, 'new unmarked attempt with the same seed');
    check(!q.table || !q.table.rows.some((r) => Object.keys(r.cells).some((k) => r.cells[k])), 'its table starts empty');
    check(Object.keys(q.answers || {}).every((k) => !q.answers[k]), 'its answers start empty');
  });

  await step('Exam mode: two questions, timer, finish → report card out of 40', async () => {
    await page.goto(INDEX + '#/exam');
    await page.waitForSelector('form.vl-form');
    await page.check('#vl-exam-min-120');
    await page.click('form.vl-form button[type=submit]');
    await page.waitForSelector('.vl-ws .vl-app-canvas');
    const tip = page.locator('.vl-app-hint button');
    if (await tip.isVisible()) await tip.click();
    check(await page.locator('.vl-qswitch-btn').count() === 2, 'two question buttons');
    await page.waitForTimeout(1100);
    const timer = (await page.textContent('.vl-ws-timer')).trim();
    check(/\d:\d\d/.test(timer) && await page.locator('.vl-ws-timer').isVisible(), 'exam timer visible (' + timer.replace(/\s+/g, ' ') + ')');
    check(await page.locator('#vl-tab-report').count() === 0, 'no report tab before finishing');
    const qs = await page.evaluate(() => VLab.ui.app.current().session.questions.map((q) => q.variantId));
    check(qs.length === 2 && qs[0] === 'graph' && qs[1] === 'twopoint', 'Q1 graph + Q2 twopoint (' + qs.join(', ') + ')');
    // answer something in Q1
    await page.fill('#vl-panel-paper [data-key="d"]', '2.35 cm');
    await page.click('.vl-qswitch-btn[data-q="1"]');
    await page.waitForSelector('#vl-panel-paper [data-key="limitations"]');
    check(/Question 2/.test(await page.textContent('.vl-ws-title')), 'switched to Question 2');
    await page.fill('#vl-panel-paper [data-key="limitations"][data-index="0"]', 'Only two lengths were used, which is not enough to draw a valid conclusion.');
    await page.fill('#vl-panel-paper [data-key="improvements"][data-index="0"]', 'Use a fiducial marker at the centre of the swing.');
    await shot(page, '07-exam');
    await page.click('.vl-qswitch-btn[data-q="0"]');
    await page.waitForSelector('#vl-panel-paper [data-key="d"]');
    check(await page.inputValue('#vl-panel-paper [data-key="d"]') === '2.35 cm', 'Q1 answer kept after switching questions');
    await button(page, 'Finish exam', '.vl-ws-actions');
    await confirmDialog(page);
    await page.waitForSelector('.vl-report-exam', { timeout: 15000 });
    const card = await page.textContent('.vl-report-exam');
    const s = await page.evaluate(() => VLab.ui.app.current().session);
    const max = s.questions.reduce((a, q) => a + (q.report ? q.report.max : 0), 0);
    check(max === 40, 'both questions marked, out of 40');
    check(/40/.test(card) && /MMO/.test(card), 'exam report card shows the total out of 40 and skills');
    check(/Exam finished/.test(await page.textContent('.vl-ws-timer')), 'timer replaced by “Exam finished”');
    await shot(page, '08-exam-report');
  });

  await step('Instrument lab renders and every sandbox opens', async () => {
    await page.goto(INDEX + '#/instruments');
    await page.waitForSelector('.vi-navbtn');
    const n = await page.locator('.vi-navbtn').count();
    check(n >= 13, n + ' instruments listed');
    for (let i = 0; i < n; i++) {
      await page.locator('.vi-navbtn').nth(i).click();
      await page.waitForTimeout(120);
    }
    await page.locator('.vi-navbtn').first().click();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, 0));
    const c = await page.evaluate(() => { const cv = document.querySelector('.vi-root canvas, main canvas'); return cv ? cv.width : 0; });
    check(c > 100, 'sandbox canvas sized');
    await shot(page, '09-instrument-lab');
  });

  await step('Skill drills: all four drills render', async () => {
    await page.goto(INDEX + '#/drills');
    await page.waitForSelector('.vd-tabs');
    for (const id of ['graph', 'uncertainty', 'table', 'evaluation']) {
      await page.click('#vd-tab-' + id);
      await page.waitForTimeout(250);
      const vis = await page.locator('#vd-panel-' + id).isVisible();
      const len = (await page.textContent('#vd-panel-' + id)).trim().length;
      check(vis && len > 100, 'drill “' + id + '” visible with content');
      await shot(page, '10-drills-' + id);
    }
  });

  await step('Progress and saved-sessions pages render', async () => {
    await page.goto(INDEX + '#/progress');
    await page.waitForTimeout(500);
    const ptxt = await page.textContent('main');
    check(/Progress/.test(ptxt) && !/No marked work yet/.test(ptxt), 'progress page lists the marked attempts');
    await shot(page, '11-progress');
    await page.goto(INDEX + '#/sessions');
    await page.waitForSelector('.vl-sessions');
    check(await page.locator('.vl-session').count() >= 2, 'saved sessions listed');
    await shot(page, '12-sessions');
  });

  await step('Tablet 820×1180: practice workspace', async () => {
    const tab = await context.newPage();
    watch(tab, 'tablet');
    await tab.setViewportSize({ width: 820, height: 1180 });
    await tab.goto(INDEX + '#/practice?exp=pendulum&variant=twopoint');
    await tab.waitForSelector('form.vl-form');
    await tab.click('form.vl-form button[type=submit]');
    await tab.waitForSelector('.vl-ws');
    await tab.waitForTimeout(400);
    const sw = await tab.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 820, 'no horizontal scroll at 820 px (' + sw + ')');
    await shot(tab, '13-tablet-paper');
    await tab.click('.vl-narrow-toggle [data-show="apparatus"]');
    await tab.waitForTimeout(400);
    const tip = tab.locator('.vl-app-hint button');
    if (await tip.isVisible()) await tip.click();
    const h = await tab.evaluate(() => document.querySelector('.vl-app-canvas').getBoundingClientRect().height);
    check(h > 400, 'apparatus canvas is tall on the tablet (' + Math.round(h) + ' px)');
    await shot(tab, '13b-tablet-apparatus');
    await tab.close();
  });

  // checks for the review fixes (parallax, record target, layouts, saving, graph tools …): tests/e2e/review.js
  await require('./review.js')({ browser, INDEX, check, step, watch, shot });

  // Circuit lab: free build, wiring, meters, set-ups, faults (tests/e2e/circuits.js)
  await require('./circuits.js')({ browser, INDEX, check, step, watch, shot });

  await browser.close();

  console.log('\n' + '─'.repeat(70));
  if (problems.length) {
    console.log('\x1b[31mConsole / page errors (' + problems.length + '):\x1b[0m');
    problems.forEach((p) => console.log('  ' + p.split('\n').slice(0, 6).join('\n    ')));
  }
  if (failures.length) {
    console.log('\x1b[31mFailed checks (' + failures.length + '):\x1b[0m');
    failures.forEach((f) => console.log('  ✗ ' + f));
  }
  const ok = !failures.length && !problems.length;
  console.log((ok ? '\x1b[32m' : '\x1b[31m') + passed + ' checks passed, ' + failures.length + ' failed, ' +
    problems.length + ' console/page errors\x1b[0m');
  console.log('Screenshots: ' + SHOTS);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
