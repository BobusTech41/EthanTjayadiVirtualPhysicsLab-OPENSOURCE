/**
 * End-to-end checks for the Circuit lab (dev only), run by tests/e2e/smoke.js:
 *
 *   await require('./circuits.js')({ browser, INDEX, check, step, watch, shot })
 *
 * The bench is driven with real mouse drags and clicks on the canvas; VLab.* is read only to locate terminals on
 * screen and to compare meter readings with the hidden true values.
 */
'use strict';

module.exports = async function circuits(env) {
  const { browser, INDEX, check, step, watch, shot } = env;

  async function open(viewport) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1366, height: 860 } });
    const page = await ctx.newPage();
    watch(page, 'circuits');
    await page.goto(INDEX + '#/circuits');
    await page.waitForSelector('.vl-circuitlab .vl-app-canvas');
    await page.waitForTimeout(300);
    const tip = page.locator('.vl-app-hint button');
    if (await tip.isVisible()) await tip.click();
    return { ctx, page };
  }

  const lab = (page, fn, arg) => page.evaluate(fn, arg);

  /** Screen position of a world point. */
  async function toClient(page, w) {
    return page.evaluate((pt) => {
      const cv = document.querySelector('.vl-app-canvas'), r = cv.getBoundingClientRect();
      const v = VLab._circuitLabPage.apparatus().getView(), s = v.fit * v.z;
      return { x: r.left + (pt.x - v.cx) * s + r.width / 2, y: r.top + (pt.y - v.cy) * s + r.height / 2 };
    }, w);
  }
  async function term(page, id, t) {
    const w = await lab(page, (a) => VLab._circuitLabPage.bench().termPos(a[0], a[1]), [id, t]);
    return toClient(page, w);
  }
  async function dragLead(page, a, at, b, bt) {
    const A = await term(page, a, at), B = await term(page, b, bt);
    await page.mouse.move(A.x, A.y);
    await page.mouse.down();
    await page.mouse.move((A.x + B.x) / 2, (A.y + B.y) / 2, { steps: 4 });
    await page.mouse.move(B.x, B.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  }
  async function tapLead(page, a, at, b, bt) {
    const A = await term(page, a, at), B = await term(page, b, bt);
    await page.mouse.click(A.x, A.y);
    await page.waitForTimeout(80);
    await page.mouse.click(B.x, B.y);
    await page.waitForTimeout(120);
  }
  const parts = (page) => lab(page, () => VLab._circuitLabPage.state().circuit.parts.map((p) => ({ id: p.id, type: p.type, x: p.x, y: p.y })));
  const wires = (page) => lab(page, () => VLab._circuitLabPage.state().circuit.wires.length);
  const result = (page, id) => lab(page, (i) => {
    const r = VLab._circuitLabPage.bench().result().parts[i] || {};
    return { reading: r.reading, unit: r.unit, blown: !!r.blown };
  }, id);

  await step('Circuit lab: home card and free build', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const page = await ctx.newPage();
    watch(page, 'circuits-home');
    await page.goto(INDEX + '#/');
    await page.waitForSelector('.vl-home-list');
    check(await page.locator('.vl-home-list a[href="#/circuits"]').count() === 1, 'home page links to the Circuit lab');
    await page.click('.vl-home-list a[href="#/circuits"]');
    await page.waitForSelector('.vl-circuitlab .vl-app-canvas');
    check(/Circuit lab/.test(await page.title()), 'page title names the Circuit lab');
    await ctx.close();
  });

  await step('Circuit lab: build a circuit with drag and tap wiring, read the meters', async () => {
    const { ctx, page } = await open();
    for (const label of ['Cell (1.5 V)', 'Switch', 'Fixed resistor', 'Ammeter (analogue)', 'Digital multimeter']) {
      await page.click('button[title="Add: ' + label + '"]');
      await page.waitForTimeout(250);
    }
    await page.click('.vl-app-toolbar button:has-text("Fit")');
    await page.waitForTimeout(700);
    const ps = await parts(page);
    check(ps.length === 5, 'five components added from the component box');
    const id = (t) => ps.find((p) => p.type === t).id;
    const cell = id('cell'), sw = id('switch'), R = id('resistor'), A = id('ammeter'), M = id('dmm');
    // zoom so terminals are easy to hit
    await lab(page, () => VLab._circuitLabPage.apparatus().setView({ cx: 35, cy: 22, z: 1.6 }));
    await page.waitForTimeout(200);
    await dragLead(page, cell, '+', sw, 'a');
    await dragLead(page, sw, 'b', A, '+');
    await dragLead(page, A, '-', R, 'a');
    await tapLead(page, R, 'b', cell, '-');
    await dragLead(page, M, 'V', R, 'a');
    await tapLead(page, M, 'COM', R, 'b');
    check(await wires(page) === 6, 'six leads connected by dragging and by tap–tap (' + await wires(page) + ')');
    let rA = await result(page, A);
    check(Math.abs(rA.reading) < 1e-9, 'no current while the switch is open');
    // close the switch by clicking its lever on the canvas
    const swPart = ps.find((p) => p.id === sw);
    const lever = await toClient(page, { x: swPart.x + 4.5, y: swPart.y + 1.5 });
    await page.mouse.click(lever.x, lever.y);
    await page.waitForTimeout(600);
    const closed = await lab(page, (i) => VLab.circuit.getPart(VLab._circuitLabPage.state().circuit, i).settings.closed, sw);
    check(closed === true, 'clicking the switch closes it');
    rA = await result(page, A);
    const truth = await lab(page, (ids) => {
      const L = VLab._circuitLabPage, c = L.state().circuit, sim = L.bench().sim;
      const h = (i) => sim.hidden(VLab.circuit.getPart(c, i));
      const cellH = h(ids.cell), rH = h(ids.R), aH = h(ids.A);
      return cellH.emf / (rH.R + cellH.r + aH.r1 + h(ids.sw).R);
    }, { cell, R, A, sw });
    check(Math.abs(rA.reading - truth) < 0.002, 'ammeter shows I = E / (R + r + r_A) (' + rA.reading.toFixed(4) + ' vs ' + truth.toFixed(4) + ' A)');
    const rM = await result(page, M);
    check(rM.unit === 'V' && Math.abs(rM.reading - rA.reading * (await lab(page, (i) => VLab._circuitLabPage.bench().sim.hidden(VLab.circuit.getPart(VLab._circuitLabPage.state().circuit, i)).R, R))) < 0.01,
      'multimeter across the resistor reads I × R (' + rM.reading.toFixed(3) + ' V)');
    // zoom to the ammeter and screenshot
    const aPart = ps.find((p) => p.id === A);
    const aC = await toClient(page, { x: aPart.x + 6, y: aPart.y + 3 });
    await page.mouse.click(aC.x, aC.y);
    await page.click('.vc-actions button:has-text("Zoom to it")');
    await page.waitForTimeout(1100);
    await shot(page, 'circuit-01-ammeter');
    // record a reading into the table
    await page.click('#vc-tab-table');
    await page.waitForSelector('#vc-panel-table .vt-input--head');
    await page.locator('#vc-panel-table input.vt-input--head').first().fill('I / A');
    await page.locator('#vc-panel-table input.vt-input:not(.vt-input--head)').first().click();
    await page.fill('.vl-pad-input', '0.14');
    await page.click('.vl-pad-record');
    await page.waitForTimeout(200);
    check(await page.locator('#vc-panel-table input.vt-input:not(.vt-input--head)').first().inputValue() === '0.14', 'reading pad records into the selected table cell');
    // persistence
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForSelector('.vl-circuitlab .vl-app-canvas');
    await page.waitForTimeout(400);
    check((await parts(page)).length === 5 && await wires(page) === 6, 'the bench (components and leads) is restored after a reload');
    await ctx.close();
  });

  await step('Circuit lab: set-ups, circuit check, jockey and faults', async () => {
    const { ctx, page } = await open();
    await page.selectOption('#vc-template', 'resistivity');
    await page.click('button:has-text("Set out this bench")');
    await page.waitForTimeout(300);
    const conf = page.locator('.vl-modal button:has-text("Clear and set out")');
    if (await conf.count()) { await conf.click(); await page.waitForTimeout(300); }
    const blank = await page.evaluate(() => {
      const c = document.querySelector('.vc-diagram');
      if (!c) return true;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
      return ink < 500;
    });
    check(!blank, 'the circuit diagram is drawn');
    await page.click('button:has-text("Check my circuit")');
    check(/Not yet/.test(await page.textContent('.vc-check')), 'an unwired kit does not pass the circuit check');
    await page.click('button:has-text("Wire it for me")');
    await page.click('.vl-modal button:has-text("Wire it")');
    await page.waitForTimeout(300);
    check(/matches the diagram/.test(await page.textContent('.vc-check')), 'the reference wiring passes the circuit check');
    await shot(page, 'circuit-02-resistivity');
    // close the switch and move the jockey with the nudge buttons
    const ids = await lab(page, () => {
      const c = VLab._circuitLabPage.state().circuit;
      const f = (t) => c.parts.find((p) => p.type === t).id;
      return { sw: f('switch'), W: f('wire'), V: f('voltmeter') };
    });
    await lab(page, (i) => { VLab._circuitLabPage.bench().select({ kind: 'part', id: i }); }, ids.sw);
    await page.click('.vc-selected button:has-text("Close the switch")');
    await page.waitForTimeout(500);
    const v1 = (await result(page, ids.V)).reading;
    await lab(page, (i) => { VLab._circuitLabPage.bench().select({ kind: 'part', id: i }); }, ids.W);
    await page.click('.vc-selected button:has-text("towards B")');
    await page.click('.vc-selected button:has-text("towards B")');
    await page.waitForTimeout(500);
    const v2 = (await result(page, ids.V)).reading;
    check(v2 > v1 + 0.005, 'moving the jockey away from A increases V across the wire (' + v1.toFixed(3) + ' → ' + v2.toFixed(3) + ' V)');
    const jockeyText = await page.textContent('.vc-selected');
    check(!/\d+\.\d+\s*cm/.test(jockeyText), 'the jockey position is never shown as a number');
    // delete a lead with the keyboard: the check now fails
    await lab(page, () => { const L = VLab._circuitLabPage, w = L.state().circuit.wires[0]; L.bench().select({ kind: 'wire', id: w.id }); });
    await page.focus('.vl-app-canvas');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    check(/Not yet/.test(await page.textContent('.vc-check')), 'removing a lead with Delete makes the check fail again');
    await ctx.close();
  });

  await step('Circuit lab: a multimeter on the mA range across a cell blows its fuse', async () => {
    const { ctx, page } = await open();
    await page.click('button[title="Add: Cell (1.5 V)"]');
    await page.click('button[title="Add: Digital multimeter"]');
    await page.waitForTimeout(300);
    const ps = await parts(page);
    const cell = ps.find((p) => p.type === 'cell').id, M = ps.find((p) => p.type === 'dmm').id;
    await lab(page, (i) => { VLab._circuitLabPage.bench().select({ kind: 'part', id: i }); }, M);
    await page.selectOption('.vc-selected select >> nth=0', 'A');
    await page.selectOption('.vc-selected select >> nth=1', '200 mA');
    await lab(page, () => VLab._circuitLabPage.apparatus().setView({ cx: 30, cy: 15, z: 2.4 }));
    await page.waitForTimeout(200);
    await dragLead(page, cell, '+', M, 'V');
    await dragLead(page, M, 'COM', cell, '-');
    await page.waitForTimeout(800);
    const r = await result(page, M);
    check(r.blown, 'the fuse blows');
    check(/fuse has blown/i.test(await page.textContent('.vc-warnings')), 'a warning explains the blown fuse');
    await lab(page, (i) => { VLab._circuitLabPage.bench().select({ kind: 'part', id: i }); }, M);
    check(await page.locator('.vc-selected button:has-text("Replace the fuse")').count() === 1, 'a Replace the fuse button is offered');
    await shot(page, 'circuit-03-fuse');
    await ctx.close();
  });

  await step('Circuit lab: phone layout', async () => {
    const { ctx, page } = await open({ width: 390, height: 844 });
    await page.click('.vl-narrow-toggle [data-show="panel"]');
    await page.waitForTimeout(300);
    check(await page.isVisible('#vc-template'), 'the set-up chooser is reachable on a phone');
    await page.click('.vl-narrow-toggle [data-show="apparatus"]');
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => document.querySelector('.vl-app-canvas').getBoundingClientRect().height);
    check(h > 200, 'the bench is visible on a phone (' + Math.round(h) + ' px)');
    const sw = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    check(sw, 'no horizontal page scroll on a phone');
    await shot(page, 'circuit-04-phone');
    await ctx.close();
  });
};
