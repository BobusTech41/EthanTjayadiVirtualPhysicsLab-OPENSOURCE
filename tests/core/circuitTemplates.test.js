/* Every circuit-lab template: its reference wiring matches its own diagram and gives sensible readings. */
VLab.circuitTemplates.list.forEach(function (tpl) {
  test('template ' + tpl.id + ': reference wiring matches and works', function () {
    VLab.noise.level = 1;
    var built = VLab.circuitTemplates.build(tpl, 'TPL-AAAA-BBBB', { wired: true });
    var c = built.circuit;
    var m = VLab.circuit.matchTemplate(c, tpl.match);
    assert.ok(m.ok, tpl.id + ': ' + JSON.stringify(m.problems));
    // every kit part is used in the diagram, and every diagram ref has a kit part
    var refs = tpl.match.parts.map(function (p) { return p.ref; }).sort();
    assert.deepEqual(tpl.kit.map(function (k) { return k.ref; }).sort(), refs);
    tpl.diagram.items.forEach(function (it) { assert.ok(refs.indexOf(it.ref) !== -1, 'diagram ref ' + it.ref); });
    // close the switch, run, and check there are no fault warnings
    c.parts.forEach(function (p) { if (p.type === 'switch') p.settings.closed = true; });
    var sim = VLab.circuit.createSim(c), res;
    for (var i = 0; i < 20; i++) res = sim.step(0.05);
    var bad = res.warnings.filter(function (w) { return /short|fuse|blown|reversed|limit/.test(w.kind); });
    assert.equal(bad.length, 0, tpl.id + ' warnings: ' + JSON.stringify(bad));
    // the meters show something non-zero
    c.parts.forEach(function (p) {
      var r = res.parts[p.id];
      if (p.type === 'voltmeter' || (p.type === 'dmm' && p.settings.mode === 'V')) {
        if (tpl.id !== 'capacitor') assert.ok(Math.abs(r.reading) > 0.01, tpl.id + ' voltmeter ' + r.reading);
      }
      if (p.type === 'ammeter') assert.ok(Math.abs(r.reading) > 0.001, tpl.id + ' ammeter ' + r.reading);
    });
  });
});

test('templates: an unwired kit does not match; a missing lead is detected', function () {
  var tpl = VLab.circuitTemplates.get('ohm');
  var b = VLab.circuitTemplates.build(tpl, 'TPL-AAAA-BBBB');
  assert.ok(!VLab.circuit.matchTemplate(b.circuit, tpl.match).ok);
  var w = VLab.circuitTemplates.build(tpl, 'TPL-AAAA-BBBB', { wired: true }).circuit;
  w.wires.splice(2, 1);
  assert.ok(!VLab.circuit.matchTemplate(w, tpl.match).ok);
});
