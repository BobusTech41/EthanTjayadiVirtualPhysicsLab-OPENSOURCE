/**
 * Circuit bench: an apparatus controller (contract §4.1) for building and using electrical circuits.
 * Browser only. Used by the Circuit lab page (ui/circuitLab.js) and by electricity experiments.
 *
 *   var ctl = VL.ui.circuitBench.createController(ctx, {
 *     circuit,                       // VL.circuit circuit object (owned by the caller, mutated in place)
 *     onChange(kind),                // 'circuit' (parts/leads/settings changed) | 'state'
 *     onWarnings(list),              // current warnings [{ part, kind, text }]
 *     onSelect(sel)                  // { kind: 'part'|'wire', id } | null
 *   });
 *
 * Everything is drawn at true size in world cm (y down) so meters and scales must be zoomed to be read.
 * Wiring: press on a terminal and drag to another terminal (or tap one terminal, then tap the other).
 * Parts: drag the body to move it; drag the jockey, rheostat slider, LDR lamp or knobs; click the switch,
 * the power-supply rocker and resistance-box dials (upper half +1, lower half −1).
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  var WORLD = { width: 120, height: 76 };
  var TERM_R = 0.55, TERM_HIT = 1.5, LEAD_HIT = 0.8;
  var COLOURS = {
    red: { fill: '#c62828', dark: '#7f1414' }, black: { fill: '#222', dark: '#000' },
    blue: { fill: '#1d5fbf', dark: '#0d3270' }, yellow: { fill: '#e5b80b', dark: '#8a6c00' },
    green: { fill: '#2e8b3a', dark: '#14501c' }, white: { fill: '#f2f2f2', dark: '#8a8a8a' }
  };
  var COLOUR_ORDER = ['red', 'black', 'blue', 'yellow', 'green', 'white'];

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function U() { return VL.instruments && VL.instruments.util; }
  function lw(view, cm) { return Math.max(cm, 1 / (view.scale || 10)); }
  function txt(g, s, x, y, size, o) {
    var u = U();
    if (u) u.text(g, s, x, y, size, o);
    else { g.save(); g.font = size + 'px Arial, Helvetica, sans-serif'; g.fillText(s, x, y); g.restore(); }
  }
  function rrect(g, x, y, w, h, r) {
    var u = U();
    if (u) { u.roundRect(g, x, y, w, h, r); return; }
    g.beginPath(); g.rect(x, y, w, h);
  }

  /* ================================================================== */
  /* Geometry of each part type (local cm; part.x, part.y = top-left)    */
  /* ================================================================== */

  var GEOM = {
    cell: { w: 13, h: 4.4, terms: { '-': [1.2, 2.2], '+': [11.8, 2.2] } },
    battery: { w: 20, h: 4.8, terms: { '-': [1.2, 2.4], '+': [18.8, 2.4] } },
    psu: { w: 22, h: 14, terms: { '+': [15.8, 11.4], '-': [19.6, 11.4] } },
    switch: { w: 9, h: 4, terms: { a: [1, 2], b: [8, 2] } },
    resistor: { w: 10, h: 3.4, terms: { a: [1, 1.7], b: [9, 1.7] } },
    unknownR: { w: 10, h: 3.4, terms: { a: [1, 1.7], b: [9, 1.7] } },
    rbox: { w: 30, h: 11, terms: { a: [2, 2], b: [28, 2] } },
    rheostat: { w: 34, h: 8, terms: { A: [1.5, 6.6], B: [32.5, 6.6], S: [1.5, 1.2] } },
    pot: { w: 8, h: 9.5, terms: { A: [1.5, 8.4], S: [4, 8.4], B: [6.5, 8.4] } },
    wire: { w: 108, h: 6.5, terms: { A: [1.6, 2.3], B: [106.4, 2.3], J: null } },
    ammeter: { w: 12.4, h: 10.4, terms: { '+': [2.6, 8.8], '-': [9.8, 8.8] } },
    voltmeter: { w: 12.4, h: 10.4, terms: { '+': [2.6, 8.8], '-': [9.8, 8.8] } },
    dmm: { w: 8.6, h: 15.6, terms: { COM: [1.9, 13.2], V: [4.3, 13.2], A: [6.7, 13.2] } },
    lamp: { w: 7, h: 7.5, terms: { a: [1.2, 6.4], b: [5.8, 6.4] } },
    diode: { w: 9, h: 3, terms: { A: [1, 1.5], K: [8, 1.5] } },
    led: { w: 6, h: 5.5, terms: { A: [1.4, 4.6], K: [4.6, 4.6] } },
    thermistor: { w: 16, h: 32, terms: { a: [2.2, 11.6], b: [5.6, 11.6] } },
    ldr: { w: 62, h: 9, terms: { a: [1.4, 7.8], b: [4.6, 7.8] } },
    capacitor: { w: 7, h: 9, terms: { '+': [1.7, 8], '-': [5.3, 8] } }
  };
  var WIRE_ZERO = 4;          // x (local) of the 0 cm mark of the resistance-wire rule
  var WIRE_Y = 2.3;           // y (local) of the wire
  var LDR_ZERO = 6.4;         // x (local) of the LDR face = 0 of the track scale
  var RH_X0 = 4, RH_X1 = 30;  // rheostat slider travel (local x)

  function geom(part) { return GEOM[part.type] || { w: 8, h: 4, terms: {} }; }

  /** World position of a terminal. */
  function termPos(part, term) {
    var gm = geom(part);
    if (part.type === 'wire' && term === 'J') {
      var j = clamp(Number(part.settings.jockey), 0, 100);
      return { x: part.x + WIRE_ZERO + j, y: part.y + 0.15 };
    }
    var t = gm.terms[term];
    return t ? { x: part.x + t[0], y: part.y + t[1] } : { x: part.x, y: part.y };
  }

  function partContains(part, p) {
    var gm = geom(part);
    var x0 = part.x, y0 = part.y, x1 = part.x + gm.w, y1 = part.y + gm.h;
    if (part.type === 'wire') y0 -= 3;              // the jockey sticks up
    return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  }

  /* ================================================================== */
  /* Controller                                                          */
  /* ================================================================== */

  function createController(ctx, opts) {
    opts = opts || {};
    var C = VL.circuit, I = VL.instruments;
    var circuit = opts.circuit;
    var services = ctx.services || {};
    var sim = C.createSim(circuit, ctx.savedState && ctx.savedState.sim);
    var res = sim.solve();
    var sel = null;                 // { kind: 'part'|'wire', id }
    var hoverTerm = null;           // { part, term }
    var drag = null;                // current pointer interaction
    var pendingWire = null;         // tap-tap wiring: first terminal
    var meters = {};                // instrument instances per part (+ range)
    var thermos = {};               // thermometer instances for thermistor beakers
    var lastWarnKey = '';
    var controlsEl = null, selBox = null, warnBox = null;
    var colourIdx = circuit.wires.length;

    function changed(kind) { if (typeof opts.onChange === 'function') opts.onChange(kind || 'circuit'); }
    function redraw() { if (services.requestRedraw) services.requestRedraw(); }
    function select(s) {
      sel = s;
      renderSelected();
      if (typeof opts.onSelect === 'function') opts.onSelect(s);
      redraw();
    }

    function rngFor(part, what) { return VL.rng.create(circuit.seed + '/' + part.id + '/' + what); }

    /** Analogue meter instance for a part (re-created when the range changes). */
    function analogue(part) {
      var t = C.types[part.type], sc = t.scale(part.settings);
      var key = part.id + '|' + part.settings.range;
      if (!meters[key]) {
        meters[key] = I.create('analogueMeter', {
          kind: t.meter, range: { max: sc.max, minor: sc.minor }, unit: sc.unit
        }, rngFor(part, 'meter/' + part.settings.range));
      }
      return meters[key];
    }
    function digital(part) {
      var key = part.id + '|dmm';
      if (!meters[key]) meters[key] = I.create('digitalMeter', { kind: 'V', range: '20 V' }, rngFor(part, 'dmm'));
      var inst = meters[key];
      var range = C.types.dmm.validRange(part.settings);
      if (range && inst.rangeName !== range) { try { inst.setRange(range); } catch (e) { /* unknown range */ } }
      return inst;
    }
    function thermo(part) {
      if (!thermos[part.id]) {
        thermos[part.id] = I.create('thermometer', { initial: C.ROOM, tau: 6 }, rngFor(part, 'thermometer'));
        var saved = ctx.savedState && ctx.savedState.thermo && ctx.savedState.thermo[part.id];
        if (typeof saved === 'number') thermos[part.id].setTemperature(saved);
      }
      return thermos[part.id];
    }

    /* ---------------------------------------------------------- hit testing */

    function terminalAt(p) {
      var best = null, bd = TERM_HIT;
      circuit.parts.forEach(function (part) {
        C.types[part.type].terminals.forEach(function (t) {
          var d = dist(p, termPos(part, t.id));
          if (d < bd) { bd = d; best = { part: part.id, term: t.id }; }
        });
      });
      return best;
    }

    function leadPoints(w, n) {
      var pa = C.getPart(circuit, w.a.part), pb = C.getPart(circuit, w.b.part);
      if (!pa || !pb) return [];
      return curve(termPos(pa, w.a.term), termPos(pb, w.b.term), n || 24);
    }
    function curve(a, b, n) {
      var d = dist(a, b), sag = 1.2 + 0.07 * d;
      var c1 = { x: a.x + (b.x - a.x) * 0.25, y: Math.max(a.y, b.y) + sag };
      var c2 = { x: a.x + (b.x - a.x) * 0.75, y: Math.max(a.y, b.y) + sag };
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var t = i / n, mt = 1 - t;
        pts.push({
          x: mt * mt * mt * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * b.x,
          y: mt * mt * mt * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * b.y
        });
      }
      return pts;
    }
    function leadAt(p, maxDist) {
      var best = null, bd = maxDist || LEAD_HIT;
      circuit.wires.forEach(function (w) {
        leadPoints(w, 30).forEach(function (q) {
          var d = dist(p, q);
          if (d < bd) { bd = d; best = w; }
        });
      });
      return best;
    }
    function partAt(p) {
      for (var i = circuit.parts.length - 1; i >= 0; i--) if (partContains(circuit.parts[i], p)) return circuit.parts[i];
      return null;
    }

    /** An interactive handle of a part under p, or null. */
    function handleAt(part, p) {
      var lx = p.x - part.x, ly = p.y - part.y, s = part.settings;
      switch (part.type) {
        case 'switch': if (lx > 2 && lx < 7.5) return { kind: 'toggle', key: 'closed' }; break;
        case 'psu':
          if (Math.hypot(lx - 7, ly - 7.4) < 3.6) return { kind: 'knob', key: 'setV', min: 0, max: 12 };
          if (lx > 14 && lx < 21 && ly > 2.6 && ly < 6.4) return { kind: 'toggle', key: 'on' };
          break;
        case 'rbox':
          for (var i = 0; i < 5; i++) {
            var cx = 5 + i * 5, cy = 7;
            if (Math.hypot(lx - cx, ly - cy) < 2.1) return { kind: 'dial', key: ['x1000', 'x100', 'x10', 'x1', 'x01'][i], up: ly < cy };
          }
          break;
        case 'rheostat': {
          var sx = RH_X0 + (RH_X1 - RH_X0) * clamp(Number(s.pos), 0, 1);
          if (Math.abs(lx - sx) < 2 && ly < 4.2) return { kind: 'slide', key: 'pos', x0: part.x + RH_X0, x1: part.x + RH_X1, min: 0, max: 1 };
          break;
        }
        case 'pot': if (Math.hypot(lx - 4, ly - 4) < 3.3) return { kind: 'knob', key: 'pos', min: 0, max: 1 }; break;
        case 'wire': {
          var jx = WIRE_ZERO + clamp(Number(s.jockey), 0, 100);
          if (Math.abs(lx - jx) < 1.4 && ly < WIRE_Y + 0.6 && ly > -3) return { kind: 'slide', key: 'jockey', x0: part.x + WIRE_ZERO, x1: part.x + WIRE_ZERO + 100, min: 0, max: 100 };
          break;
        }
        case 'ldr': {
          var lxl = LDR_ZERO + clamp(Number(s.distance), 5, 50);
          if (Math.abs(lx - lxl) < 3 && ly < 7) return { kind: 'slide', key: 'distance', x0: part.x + LDR_ZERO, x1: part.x + LDR_ZERO + 50, min: 5, max: 50 };
          break;
        }
      }
      return null;
    }

    /* ---------------------------------------------------------- pointer */

    var pointer = {
      down: function (p, ev) {
        var t = terminalAt(p);
        if (t) {
          if (pendingWire && !(pendingWire.part === t.part && pendingWire.term === t.term)) {
            connect(pendingWire, t);
            pendingWire = null;
            return true;
          }
          drag = { kind: 'wire', from: t, p: p, start: p, moved: false };
          return true;
        }
        pendingWire = null;
        var part = partAt(p);
        if (part) {
          var hnd = handleAt(part, p);
          if (hnd) {
            select({ kind: 'part', id: part.id });
            if (hnd.kind === 'toggle') { setSetting(part, hnd.key, !part.settings[hnd.key]); drag = { kind: 'none' }; return true; }
            if (hnd.kind === 'dial') {
              var d = Number(part.settings[hnd.key]) || 0;
              setSetting(part, hnd.key, (d + (hnd.up ? 1 : 9)) % 10);
              drag = { kind: 'none' };
              return true;
            }
            drag = { kind: hnd.kind, part: part, h: hnd, start: p, v0: Number(part.settings[hnd.key]) || 0 };
            return true;
          }
        }
        // over a component, a lead wins only when the press is right on it
        var lead = leadAt(p, part ? 0.3 : LEAD_HIT);
        if (lead) { select({ kind: 'wire', id: lead.id }); drag = { kind: 'none' }; return true; }
        if (part) {
          select({ kind: 'part', id: part.id });
          drag = { kind: 'move', part: part, dx: p.x - part.x, dy: p.y - part.y, moved: false };
          return true;
        }
        if (sel) select(null);
        return false;
      },
      move: function (p) {
        if (!drag) return;
        if (drag.kind === 'wire') {
          drag.p = p;
          if (dist(p, drag.start) > 0.8) drag.moved = true;
          hoverTerm = terminalAt(p);
          redraw();
        } else if (drag.kind === 'move') {
          var gm = geom(drag.part);
          drag.part.x = clamp(p.x - drag.dx, 0, WORLD.width - gm.w);
          drag.part.y = clamp(p.y - drag.dy, drag.part.type === 'wire' ? 3 : 0, WORLD.height - gm.h);
          drag.moved = true;
          redraw();
        } else if (drag.kind === 'slide') {
          var h = drag.h, f = clamp((p.x - h.x0) / (h.x1 - h.x0), 0, 1);
          var v = h.min + f * (h.max - h.min);
          if (h.key === 'pos') v = Math.round(v * 1000) / 1000; else v = Math.round(v * 100) / 100;
          setSetting(drag.part, h.key, v, true);
        } else if (drag.kind === 'knob') {
          var dy = drag.start.y - p.y, dx = p.x - drag.start.x;
          var k = drag.h, span = k.max - k.min;
          var nv = clamp(drag.v0 + (dy + dx) / 12 * span, k.min, k.max);
          if (k.key === 'setV') nv = Math.round(nv * 10) / 10; else nv = Math.round(nv * 1000) / 1000;
          setSetting(drag.part, k.key, nv, true);
        }
      },
      up: function (p) {
        var d = drag;
        drag = null;
        if (!d) return;
        if (d.kind === 'wire') {
          var t = terminalAt(p);
          if (t && !(t.part === d.from.part && t.term === d.from.term)) connect(d.from, t);
          else if (!d.moved) {
            pendingWire = d.from;                       // tap mode: now tap the other terminal
            if (services.toast) services.toast('Now tap the terminal to connect this lead to (Esc to cancel).');
          }
          hoverTerm = null;
          redraw();
        } else if (d.kind === 'move' && d.moved) changed('circuit');
        else if (d.kind === 'slide' || d.kind === 'knob') changed('circuit');
      },
      hover: function (p) {
        var t = terminalAt(p);
        var same = (t && hoverTerm && t.part === hoverTerm.part && t.term === hoverTerm.term) || (!t && !hoverTerm);
        hoverTerm = t;
        if (pendingWire) { pendingWire.cursor = p; return true; }
        return !same;
      }
    };

    function connect(a, b) {
      var colour = COLOUR_ORDER[colourIdx % COLOUR_ORDER.length];
      var w = C.addWire(circuit, { part: a.part, term: a.term }, { part: b.part, term: b.term }, colour);
      if (w) { colourIdx++; select({ kind: 'wire', id: w.id }); changed('circuit'); }
      else if (services.toast) services.toast('Those two terminals are already joined.');
    }

    function setSetting(part, key, value, quiet) {
      part.settings[key] = value;
      if (part.type === 'dmm' && key === 'mode') {
        var list = C.DMM_RANGES[value] || [];
        if (list.length && list.indexOf(part.settings.range) === -1) part.settings.range = list[Math.min(1, list.length - 1)];
      }
      res = sim.solve();
      if (!quiet) { changed('circuit'); renderSelected(); }
      redraw();
    }

    /* ---------------------------------------------------------- simulation */

    function update(dt) {
      res = sim.step(dt);
      circuit.parts.forEach(function (part) {
        var r = res.parts[part.id] || {};
        if (part.type === 'ammeter' || part.type === 'voltmeter') analogue(part).update(dt, r.reading || 0);
        if (part.type === 'thermistor') thermo(part).update(dt, r.waterT);
      });
      var key = res.warnings.map(function (w) { return w.part + w.kind; }).join('|');
      if (key !== lastWarnKey) {
        lastWarnKey = key;
        renderWarnings();
        if (typeof opts.onWarnings === 'function') opts.onWarnings(res.warnings);
      }
    }

    /* ---------------------------------------------------------- drawing */

    function draw(g, view) {
      // bench surface
      g.save();
      g.fillStyle = '#ececec';
      g.fillRect(0, 0, WORLD.width, WORLD.height);
      g.strokeStyle = '#9a9a9a';
      g.lineWidth = lw(view, 0.1);
      g.strokeRect(0, 0, WORLD.width, WORLD.height);
      g.restore();

      circuit.parts.forEach(function (part) { drawPart(g, part, view); });
      // leads above parts
      circuit.wires.forEach(function (w) { drawLead(g, w, view, sel && sel.kind === 'wire' && sel.id === w.id); });
      if (drag && drag.kind === 'wire' && drag.moved) {
        var a = termPosOf(drag.from);
        drawCurve(g, curve(a, drag.p, 24), COLOURS[COLOUR_ORDER[colourIdx % COLOUR_ORDER.length]], view, true);
      }
      if (pendingWire) {
        var pa = termPosOf(pendingWire);
        g.save();
        g.strokeStyle = '#ffb300'; g.lineWidth = lw(view, 0.25);
        g.beginPath(); g.arc(pa.x, pa.y, TERM_R * 2, 0, 2 * Math.PI); g.stroke();
        g.restore();
      }
      // terminals on top so they are always reachable; highlight hover / sources of wiring
      circuit.parts.forEach(function (part) {
        C.types[part.type].terminals.forEach(function (t) {
          var pos = termPos(part, t.id);
          var hl = hoverTerm && hoverTerm.part === part.id && hoverTerm.term === t.id;
          drawTerminal(g, pos, part, t, view, hl);
        });
      });
      // selection outline
      if (sel && sel.kind === 'part') {
        var sp = C.getPart(circuit, sel.id);
        if (sp) {
          var gm = geom(sp);
          g.save();
          g.setLineDash([0.8, 0.5]);
          g.strokeStyle = '#ffb300'; g.lineWidth = lw(view, 0.18);
          g.strokeRect(sp.x - 0.6, sp.y - (sp.type === 'wire' ? 3.4 : 0.6), gm.w + 1.2, gm.h + (sp.type === 'wire' ? 4 : 1.2));
          g.restore();
        }
      }
      // warnings
      (res.warnings || []).forEach(function (w) {
        var p = C.getPart(circuit, w.part);
        if (!p) return;
        var gm2 = geom(p);
        drawWarning(g, p.x + gm2.w - 1, p.y - 1, view);
      });
    }

    function termPosOf(t) { var p = C.getPart(circuit, t.part); return p ? termPos(p, t.term) : { x: 0, y: 0 }; }

    function drawTerminal(g, pos, part, t, view, hl) {
      var red = t.id === '+' || t.id === 'V' || t.id === 'A' && part.type === 'dmm';
      var black = t.id === '-' || t.id === 'COM';
      g.save();
      g.beginPath(); g.arc(pos.x, pos.y, TERM_R, 0, 2 * Math.PI);
      g.fillStyle = red ? '#b3261e' : black ? '#1b1b1b' : '#b08a3c';
      g.fill();
      g.lineWidth = lw(view, 0.08); g.strokeStyle = '#3d2f12'; g.stroke();
      g.beginPath(); g.arc(pos.x, pos.y, TERM_R * 0.4, 0, 2 * Math.PI);
      g.fillStyle = '#0d0d0d'; g.fill();
      if (hl) {
        g.beginPath(); g.arc(pos.x, pos.y, TERM_R * 1.9, 0, 2 * Math.PI);
        g.strokeStyle = '#ffb300'; g.lineWidth = lw(view, 0.22); g.stroke();
        var label = t.label || t.id;
        if (label) {
          var size = Math.max(0.7, 11 / (view.scale || 10));
          g.font = size + 'px Arial, Helvetica, sans-serif';
          var tw = g.measureText(label).width;
          g.fillStyle = 'rgba(17, 20, 24, 0.85)';
          g.fillRect(pos.x - tw / 2 - size * 0.3, pos.y - TERM_R * 2 - size * 1.4, tw + size * 0.6, size * 1.25);
          g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(label, pos.x, pos.y - TERM_R * 2 - size * 0.78);
        }
      }
      g.restore();
    }

    function drawCurve(g, pts, col, view, ghost) {
      g.save();
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.globalAlpha = ghost ? 0.7 : 1;
      g.beginPath();
      pts.forEach(function (q, i) { if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); });
      g.strokeStyle = col.dark; g.lineWidth = lw(view, 0.55); g.stroke();
      g.strokeStyle = col.fill; g.lineWidth = lw(view, 0.38); g.stroke();
      g.restore();
    }

    function drawLead(g, w, view, selected) {
      var pts = leadPoints(w, 28);
      if (!pts.length) return;
      if (selected) {
        g.save();
        g.beginPath();
        pts.forEach(function (q, i) { if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); });
        g.strokeStyle = 'rgba(255, 179, 0, 0.75)'; g.lineWidth = lw(view, 1.1); g.lineCap = 'round'; g.stroke();
        g.restore();
      }
      drawCurve(g, pts, COLOURS[w.color] || COLOURS.red, view, false);
      [pts[0], pts[pts.length - 1]].forEach(function (q) {
        g.save();
        g.beginPath(); g.arc(q.x, q.y, 0.42, 0, 2 * Math.PI);
        g.fillStyle = (COLOURS[w.color] || COLOURS.red).dark; g.fill();
        g.restore();
      });
    }

    function drawWarning(g, x, y, view) {
      g.save();
      g.beginPath(); g.moveTo(x, y - 1.3); g.lineTo(x + 1.3, y + 1); g.lineTo(x - 1.3, y + 1); g.closePath();
      g.fillStyle = '#ffcc00'; g.fill();
      g.strokeStyle = '#7a4b00'; g.lineWidth = lw(view, 0.1); g.stroke();
      txt(g, '!', x, y + 0.2, 1.4, { colour: '#111', weight: '900' });
      g.restore();
    }

    function board(g, part, view, colour) {
      var gm = geom(part);
      rrect(g, part.x, part.y, gm.w, gm.h, 0.5);
      g.fillStyle = colour || '#e9e2d0'; g.fill();
      g.strokeStyle = '#5b5040'; g.lineWidth = lw(view, 0.06); g.stroke();
    }

    function drawPart(g, part, view) {
      var gm = geom(part), x = part.x, y = part.y, s = part.settings, r = res.parts[part.id] || {};
      g.save();
      switch (part.type) {
        case 'cell':
        case 'battery': {
          board(g, part, view, '#2f3a45');
          var n = part.type === 'battery' ? 2 : 1, cw = (gm.w - 4) / n;
          for (var i = 0; i < n; i++) {
            var cx = x + 2 + i * cw;
            var gr = g.createLinearGradient(0, y + 0.6, 0, y + gm.h - 0.6);
            gr.addColorStop(0, '#f2c14e'); gr.addColorStop(0.5, '#fbe7a6'); gr.addColorStop(1, '#b8861b');
            rrect(g, cx + 0.2, y + 0.7, cw - 1.4, gm.h - 1.4, 0.4); g.fillStyle = gr; g.fill();
            g.fillStyle = '#9aa3ad'; g.fillRect(cx + cw - 1.2, y + gm.h / 2 - 0.6, 0.7, 1.2);   // + button
            txt(g, '1.5 V', cx + cw / 2 - 0.4, y + gm.h / 2, 0.75, { colour: '#3a2a00', weight: '800' });
          }
          txt(g, '−', x + 2.3, y + gm.h / 2, 0.9, { colour: '#fff' });
          txt(g, '+', x + gm.w - 2.3, y + gm.h / 2, 0.9, { colour: '#fff' });
          break;
        }
        case 'psu': {
          rrect(g, x, y, gm.w, gm.h, 0.8); g.fillStyle = '#d9dde2'; g.fill();
          g.strokeStyle = '#59626c'; g.lineWidth = lw(view, 0.08); g.stroke();
          rrect(g, x + 0.6, y + 0.6, gm.w - 1.2, 1.6, 0.3); g.fillStyle = '#3c4650'; g.fill();
          txt(g, 'LOW VOLTAGE SUPPLY  d.c.', x + gm.w / 2, y + 1.4, 0.7, { colour: '#fff' });
          // knob with scale 0–12 V
          var kx = x + 7, ky = y + 7.4;
          for (var v = 0; v <= 12; v++) {
            var a = (-225 + 270 * v / 12) * Math.PI / 180;
            g.beginPath();
            g.moveTo(kx + Math.cos(a) * 3.3, ky + Math.sin(a) * 3.3);
            g.lineTo(kx + Math.cos(a) * (v % 2 ? 3.7 : 4.0), ky + Math.sin(a) * (v % 2 ? 3.7 : 4.0));
            g.strokeStyle = '#222'; g.lineWidth = lw(view, 0.07); g.stroke();
            if (v % 2 === 0) txt(g, String(v), kx + Math.cos(a) * 4.7, ky + Math.sin(a) * 4.7, 0.62, { colour: '#222' });
          }
          g.beginPath(); g.arc(kx, ky, 2.9, 0, 2 * Math.PI);
          var kg = g.createRadialGradient(kx - 0.8, ky - 0.8, 0.3, kx, ky, 2.9);
          kg.addColorStop(0, '#5a6570'); kg.addColorStop(1, '#1d2329'); g.fillStyle = kg; g.fill();
          var ka = (-225 + 270 * clamp(Number(s.setV) || 0, 0, 12) / 12) * Math.PI / 180;
          g.beginPath(); g.moveTo(kx + Math.cos(ka) * 0.6, ky + Math.sin(ka) * 0.6); g.lineTo(kx + Math.cos(ka) * 2.7, ky + Math.sin(ka) * 2.7);
          g.strokeStyle = '#fff'; g.lineWidth = lw(view, 0.25); g.stroke();
          txt(g, 'VOLTS', kx, ky + 5.6, 0.6, { colour: '#222' });
          // rocker switch and lamp
          var on = s.on !== false;
          rrect(g, x + 14.6, y + 3, 6, 3, 0.3); g.fillStyle = on ? '#2e7d32' : '#555'; g.fill();
          txt(g, on ? 'ON' : 'OFF', x + 17.6, y + 4.5, 0.85, { colour: '#fff', weight: '800' });
          g.beginPath(); g.arc(x + 12.5, y + 4.5, 0.6, 0, 2 * Math.PI); g.fillStyle = on ? '#ff5a4f' : '#5d2b28'; g.fill();
          txt(g, '+', x + 15.8, y + 9.4, 0.8, { colour: '#b3261e', weight: '900' });
          txt(g, '−', x + 19.6, y + 9.4, 0.8, { colour: '#111', weight: '900' });
          break;
        }
        case 'switch': {
          board(g, part, view, '#e7dcc0');
          var closed = !!s.closed;
          g.strokeStyle = '#555'; g.lineWidth = lw(view, 0.5); g.lineCap = 'round';
          g.beginPath(); g.moveTo(x + 1.6, y + 2); g.lineTo(closed ? x + 7.6 : x + 6.8, closed ? y + 2 : y - 0.6); g.stroke();
          g.fillStyle = '#222'; g.fillRect(x + 6.6, y + 1.3, 1.4, 1.4);
          rrect(g, closed ? x + 4.2 : x + 3.8, closed ? y + 1.2 : y + 0.2, 1.4, 1.6, 0.3); g.fillStyle = '#b3261e'; g.fill();
          break;
        }
        case 'resistor':
        case 'unknownR': {
          board(g, part, view, '#e9e2d0');
          g.strokeStyle = '#9a9a9a'; g.lineWidth = lw(view, 0.12);
          g.beginPath(); g.moveTo(x + 1, y + 1.7); g.lineTo(x + 9, y + 1.7); g.stroke();
          rrect(g, x + 2.8, y + 0.9, 4.4, 1.6, 0.7); g.fillStyle = part.type === 'unknownR' ? '#6f8fa8' : '#d8c08e'; g.fill();
          g.strokeStyle = '#6b5a33'; g.lineWidth = lw(view, 0.05); g.stroke();
          var lab = part.type === 'unknownR' ? String(s.label || 'X') : C.fmtOhm(Number(s.nominal));
          txt(g, lab, x + 5, y + 3.0, 0.55, { colour: '#222', weight: '700' });
          break;
        }
        case 'rbox': {
          rrect(g, x, y, gm.w, gm.h, 0.6); g.fillStyle = '#2b2b2b'; g.fill();
          rrect(g, x + 0.5, y + 0.5, gm.w - 1, gm.h - 1, 0.4); g.fillStyle = '#e8e3d6'; g.fill();
          txt(g, 'RESISTANCE BOX  Ω', x + gm.w / 2, y + 2, 0.75, { colour: '#222' });
          ['×1000', '×100', '×10', '×1', '×0.1'].forEach(function (lab2, i2) {
            var cx2 = x + 5 + i2 * 5, cy2 = y + 7, key = ['x1000', 'x100', 'x10', 'x1', 'x01'][i2];
            g.beginPath(); g.arc(cx2, cy2, 1.9, 0, 2 * Math.PI); g.fillStyle = '#1e1e1e'; g.fill();
            rrect(g, cx2 - 0.7, cy2 - 0.75, 1.4, 1.5, 0.2); g.fillStyle = '#fff'; g.fill();
            txt(g, String(s[key] || 0), cx2, cy2, 1.0, { colour: '#000', weight: '800' });
            txt(g, lab2, cx2, cy2 - 2.6, 0.6, { colour: '#222' });
            txt(g, '▲', cx2, cy2 - 1.35, 0.45, { colour: '#bbb' });
            txt(g, '▼', cx2, cy2 + 1.35, 0.45, { colour: '#bbb' });
          });
          break;
        }
        case 'rheostat': {
          // ceramic tube with coil, slider bar on top
          rrect(g, x + 2, y + 2.6, gm.w - 4, 3.2, 1.2); g.fillStyle = '#e8e0cc'; g.fill();
          g.strokeStyle = '#8c7f5a'; g.lineWidth = lw(view, 0.05);
          for (var cxw = x + 3; cxw < x + gm.w - 3; cxw += 0.35) { g.beginPath(); g.moveTo(cxw, y + 2.7); g.lineTo(cxw + 0.15, y + 5.7); g.stroke(); }
          g.fillStyle = '#6d6d6d'; g.fillRect(x + 1, y + 1.4, gm.w - 2, 0.5);
          g.fillStyle = '#3d3d3d'; g.fillRect(x, y + 5.8, 3, 2.2); g.fillRect(x + gm.w - 3, y + 5.8, 3, 2.2); g.fillRect(x, y + 0.2, 3, 2);
          var sx = x + RH_X0 + (RH_X1 - RH_X0) * clamp(Number(s.pos), 0, 1);
          rrect(g, sx - 1.2, y + 0.6, 2.4, 2.6, 0.3); g.fillStyle = '#1d5fbf'; g.fill();
          txt(g, C.fmtOhm(Number(s.nominal)), x + gm.w / 2, y + 4.2, 0.7, { colour: '#3a2a00' });
          break;
        }
        case 'pot': {
          board(g, part, view, '#2b3a2e');
          g.beginPath(); g.arc(x + 4, y + 4, 2.9, 0, 2 * Math.PI); g.fillStyle = '#d6d6d6'; g.fill();
          var pa2 = (-225 + 270 * clamp(Number(s.pos), 0, 1)) * Math.PI / 180;
          g.beginPath(); g.moveTo(x + 4, y + 4); g.lineTo(x + 4 + Math.cos(pa2) * 2.6, y + 4 + Math.sin(pa2) * 2.6);
          g.strokeStyle = '#111'; g.lineWidth = lw(view, 0.3); g.stroke();
          txt(g, C.fmtOhm(Number(s.nominal)), x + 4, y + 7.2, 0.55, { colour: '#fff' });
          txt(g, '1', x + 1.5, y + 9.3, 0.5, { colour: '#fff' }); txt(g, '2', x + 4, y + 9.3, 0.5, { colour: '#fff' }); txt(g, '3', x + 6.5, y + 9.3, 0.5, { colour: '#fff' });
          break;
        }
        case 'wire': {
          var rule = VL.instruments.create('metreRule', {}, null);
          rule.draw(g, { x: x + WIRE_ZERO, y: y + WIRE_Y + 0.25, angle: 0, side: 1 }, view, {});
          g.strokeStyle = s.material === 'nichrome' ? '#8d8d95' : '#b87333';
          g.lineWidth = lw(view, 0.03);
          g.beginPath(); g.moveTo(x + 1.6, y + WIRE_Y); g.lineTo(x + 106.4, y + WIRE_Y); g.stroke();
          txt(g, 'A', x + 1.6, y + 0.6, 0.8, { colour: '#222', weight: '800' });
          txt(g, 'B', x + 106.4, y + 0.6, 0.8, { colour: '#222', weight: '800' });
          // jockey (knife edge) touching the wire
          var jx = x + WIRE_ZERO + clamp(Number(s.jockey), 0, 100);
          g.beginPath(); g.moveTo(jx, y + WIRE_Y); g.lineTo(jx - 0.7, y - 1.6); g.lineTo(jx + 0.7, y - 1.6); g.closePath();
          g.fillStyle = '#9aa4ae'; g.fill(); g.strokeStyle = '#44505b'; g.lineWidth = lw(view, 0.04); g.stroke();
          rrect(g, jx - 1, y - 3, 2, 1.6, 0.4); g.fillStyle = '#c62828'; g.fill();
          break;
        }
        case 'ammeter':
        case 'voltmeter': {
          analogue(part).draw(g, { x: x + 6.2, y: y + 5.2 }, view, {});
          break;
        }
        case 'dmm': {
          var dm = digital(part);
          var on = s.mode !== 'off';
          var val = 0;
          if (on && typeof r.reading === 'number' && isFinite(r.reading)) val = r.reading / (dm.siFactor || 1);
          else if (on) val = Infinity;
          dm.draw(g, { x: x + 4.3, y: y + 7.8 }, view, { value: val, on: on, now: view.now });
          if (r.blown) txt(g, 'FUSE', x + 4.3, y + 9.5, 0.6, { colour: '#ff6b5f', weight: '800' });
          break;
        }
        case 'lamp': {
          board(g, part, view, '#2c2c2c');
          var br = r.brightness || 0;
          if (br > 0.02) {
            var glow = g.createRadialGradient(x + 3.5, y + 2.6, 0.2, x + 3.5, y + 2.6, 2 + 4 * br);
            glow.addColorStop(0, 'rgba(255, 236, 160,' + Math.min(0.95, 0.4 + br) + ')');
            glow.addColorStop(1, 'rgba(255, 200, 60, 0)');
            g.fillStyle = glow; g.beginPath(); g.arc(x + 3.5, y + 2.6, 2 + 4 * br, 0, 2 * Math.PI); g.fill();
          }
          g.beginPath(); g.arc(x + 3.5, y + 2.6, 1.9, 0, 2 * Math.PI);
          g.fillStyle = 'rgba(230, 240, 250, 0.55)'; g.fill();
          g.strokeStyle = '#9aa'; g.lineWidth = lw(view, 0.05); g.stroke();
          g.strokeStyle = r.blown ? '#555' : br > 0.05 ? '#fff6c8' : '#6b5a33'; g.lineWidth = lw(view, 0.08);
          g.beginPath(); g.moveTo(x + 2.8, y + 3.6); g.lineTo(x + 3.1, y + 2.3); g.lineTo(x + 3.9, y + 2.3); g.lineTo(x + 4.2, y + 3.6); g.stroke();
          g.fillStyle = '#b9b9b9'; g.fillRect(x + 2.4, y + 4.4, 2.2, 1);
          txt(g, s.rating, x + 3.5, y + 7.1, 0.42, { colour: '#ddd' });
          if (r.blown) txt(g, 'blown', x + 3.5, y + 0.6, 0.55, { colour: '#ff6b5f', weight: '800' });
          break;
        }
        case 'diode': {
          board(g, part, view, '#e9e2d0');
          g.strokeStyle = '#9a9a9a'; g.lineWidth = lw(view, 0.1);
          g.beginPath(); g.moveTo(x + 1, y + 1.5); g.lineTo(x + 8, y + 1.5); g.stroke();
          rrect(g, x + 3, y + 0.85, 3, 1.3, 0.3); g.fillStyle = '#222'; g.fill();
          g.fillStyle = '#d6d6d6'; g.fillRect(x + 5.3, y + 0.85, 0.45, 1.3);     // cathode band
          break;
        }
        case 'led': {
          board(g, part, view, '#e9e2d0');
          var bl = r.brightness || 0;
          if (bl > 0.02) {
            var lg = g.createRadialGradient(x + 3, y + 2, 0.1, x + 3, y + 2, 1.5 + 3 * bl);
            lg.addColorStop(0, 'rgba(255, 60, 40,' + Math.min(0.9, 0.3 + bl) + ')'); lg.addColorStop(1, 'rgba(255, 40, 20, 0)');
            g.fillStyle = lg; g.beginPath(); g.arc(x + 3, y + 2, 1.5 + 3 * bl, 0, 2 * Math.PI); g.fill();
          }
          g.beginPath(); g.arc(x + 3, y + 2, 1.15, Math.PI, 0); g.lineTo(x + 4.15, y + 3.1); g.lineTo(x + 1.85, y + 3.1); g.closePath();
          g.fillStyle = r.blown ? '#5d2b28' : bl > 0.05 ? '#ff5544' : '#b3261e'; g.fill();
          g.strokeStyle = '#999'; g.lineWidth = lw(view, 0.06);
          g.beginPath(); g.moveTo(x + 2.4, y + 3.1); g.lineTo(x + 1.4, y + 4.6); g.moveTo(x + 3.6, y + 3.1); g.lineTo(x + 4.6, y + 4.6); g.stroke();
          txt(g, '+', x + 1.4, y + 3.6, 0.6, { colour: '#b3261e', weight: '900' });
          if (r.blown) txt(g, 'blown', x + 3, y + 0.3, 0.5, { colour: '#b3261e', weight: '800' });
          break;
        }
        case 'thermistor': {
          var T = typeof r.waterT === 'number' ? r.waterT : C.ROOM;
          // hot plate
          var heat = s.heater === 'warm' ? 0.5 : s.heater === 'hot' ? 1 : 0;
          rrect(g, x, y + 30.5, gm.w, 1.5, 0.3); g.fillStyle = heat ? 'rgb(' + Math.round(120 + 120 * heat) + ',60,40)' : '#555'; g.fill();
          // terminal block
          rrect(g, x + 1, y + 10.6, 6, 2, 0.3); g.fillStyle = '#e7dcc0'; g.fill();
          // beaker and water
          var t01 = clamp((T - 0) / 90, 0, 1);
          g.fillStyle = 'rgba(' + Math.round(150 + 90 * t01) + ',' + Math.round(200 - 60 * t01) + ',' + Math.round(240 - 140 * t01) + ',0.55)';
          g.fillRect(x + 1, y + 17, 12.5, 13.3);
          g.strokeStyle = 'rgba(80, 100, 120, 0.9)'; g.lineWidth = lw(view, 0.12);
          g.beginPath(); g.moveTo(x + 0.8, y + 14.5); g.lineTo(x + 0.8, y + 30.4); g.lineTo(x + 13.7, y + 30.4); g.lineTo(x + 13.7, y + 14.5); g.stroke();
          if (s.heater === 'ice added') {
            g.fillStyle = 'rgba(255,255,255,0.8)';
            [[3, 17.4], [6.5, 17.2], [9, 17.6]].forEach(function (c) { g.fillRect(x + c[0], y + c[1], 1.8, 1.4); });
          }
          // thermistor leads and bead
          g.strokeStyle = '#999'; g.lineWidth = lw(view, 0.06);
          g.beginPath(); g.moveTo(x + 2.2, y + 11.6); g.lineTo(x + 3.6, y + 25); g.moveTo(x + 5.6, y + 11.6); g.lineTo(x + 4.0, y + 25); g.stroke();
          g.beginPath(); g.arc(x + 3.8, y + 25.4, 0.5, 0, 2 * Math.PI); g.fillStyle = '#3b2a14'; g.fill();
          thermo(part).draw(g, { x: x + 10.5, y: y + 29.6 }, view, {});
          break;
        }
        case 'ldr': {
          // housing with LDR facing right, track with scale, lamp carriage
          rrect(g, x, y + 1, LDR_ZERO, 7.8, 0.4); g.fillStyle = '#2b2b2b'; g.fill();
          g.beginPath(); g.arc(x + LDR_ZERO - 0.4, y + 3.6, 1.4, -Math.PI / 2, Math.PI / 2); g.fillStyle = '#c99a3c'; g.fill();
          g.strokeStyle = '#7a2a1a'; g.lineWidth = lw(view, 0.05);
          for (var zz = -1; zz <= 1; zz += 0.5) { g.beginPath(); g.moveTo(x + LDR_ZERO - 0.4, y + 3.6 + zz); g.lineTo(x + LDR_ZERO + 0.5, y + 3.6 + zz); g.stroke(); }
          g.save();
          g.beginPath(); g.rect(x + LDR_ZERO - 0.6, y + 4.6, 54, 4); g.clip();
          VL.instruments.create('metreRule', { zeroInset: 0 }, null).draw(g, { x: x + LDR_ZERO, y: y + 5.1, angle: 0, side: 1 }, view, {});
          g.restore();
          var lxp = x + LDR_ZERO + clamp(Number(s.distance), 5, 50);
          rrect(g, lxp - 2.2, y + 0.4, 4.4, 4.4, 0.4); g.fillStyle = '#444'; g.fill();
          var lgl = g.createRadialGradient(lxp - 1.4, y + 3.6, 0.1, lxp - 1.4, y + 3.6, 3);
          lgl.addColorStop(0, 'rgba(255, 245, 190, 0.95)'); lgl.addColorStop(1, 'rgba(255, 220, 100, 0)');
          g.fillStyle = lgl; g.beginPath(); g.arc(lxp - 1.4, y + 3.6, 3, 0, 2 * Math.PI); g.fill();
          g.strokeStyle = '#ffb300'; g.lineWidth = lw(view, 0.05);
          g.beginPath(); g.moveTo(lxp, y + 4.6); g.lineTo(lxp, y + 5.4); g.stroke();      // index line
          break;
        }
        case 'capacitor': {
          board(g, part, view, '#e9e2d0');
          rrect(g, x + 1.4, y + 0.5, 4.2, 6, 0.6); g.fillStyle = '#1d3f8a'; g.fill();
          g.fillStyle = '#c9d4ea'; g.fillRect(x + 4.6, y + 0.5, 0.8, 6);
          txt(g, '−', x + 5, y + 1.5, 0.6, { colour: '#1d3f8a', weight: '900' });
          txt(g, s.nominal + ' µF', x + 3.1, y + 3.3, 0.5, { colour: '#fff', rotate: -Math.PI / 2 });
          txt(g, '+', x + 1.7, y + 7, 0.6, { colour: '#b3261e', weight: '900' });
          break;
        }
        default:
          board(g, part, view);
      }
      g.restore();
    }

    /* ---------------------------------------------------------- DOM controls */

    function controls(container, cui) {
      controlsEl = container;
      var h = ui.h;
      var box = cui.group('Component box');
      var groups = {};
      Object.keys(C.types).forEach(function (type) {
        var t = C.types[type];
        (groups[t.group] = groups[t.group] || []).push(type);
      });
      Object.keys(groups).forEach(function (gname) {
        var row = h('div', { class: 'vc-box-row' }, h('span', { class: 'vc-box-group' }, gname));
        groups[gname].forEach(function (type) {
          var t = C.types[type];
          var b = cui.button('', function () { addPart(type); }, { title: 'Add: ' + t.label, className: 'vc-add' });
          if (ui.circuitSymbols) b.appendChild(ui.circuitSymbols.icon(t.symbol === 'dmm' ? 'voltmeter' : t.symbol, 34));
          b.appendChild(h('span', {}, t.label));
          row.appendChild(b);
        });
        box.appendChild(row);
      });
      container.appendChild(box);

      selBox = h('div', { class: 'vc-selected', 'aria-live': 'polite' });
      container.appendChild(selBox);
      warnBox = h('div', { class: 'vc-warnings', role: 'status', 'aria-live': 'polite' });
      container.appendChild(warnBox);
      var help = cui.group('Wiring');
      help.appendChild(cui.note('Press on a terminal and drag to another terminal to connect a lead (or tap one terminal, then tap the other). Hover over a terminal to see its name. Click a lead to select it; Delete removes the selected lead or component.'));
      help.appendChild(cui.button('Remove all leads', function () {
        if (!circuit.wires.length) return;
        circuit.wires.length = 0; select(null); res = sim.solve(); changed('circuit');
      }));
      container.appendChild(help);
      renderSelected();
      renderWarnings();
    }

    function addPart(type) {
      var gm = GEOM[type] || { w: 8, h: 4 };
      var spot = freeSpot(gm.w, gm.h + (type === 'wire' ? 3 : 0));
      var p = C.addPart(circuit, type, spot.x, spot.y + (type === 'wire' ? 3 : 0));
      res = sim.solve();
      select({ kind: 'part', id: p.id });
      changed('circuit');
      if (services.focusWorld) services.focusWorld(p.x + gm.w / 2, p.y + gm.h / 2, Math.min(4, 60 / Math.max(gm.w, gm.h * 1.5)));
    }

    function freeSpot(w, hgt) {
      for (var yy = 2; yy + hgt < WORLD.height; yy += 3) {
        for (var xx = 2; xx + w < WORLD.width; xx += 3) {
          var ok = circuit.parts.every(function (p) {
            var gm = geom(p), top = p.type === 'wire' ? p.y - 3 : p.y;
            return xx + w + 2 < p.x || xx > p.x + gm.w + 2 || yy + hgt + 2 < top || yy > p.y + gm.h + 2;
          });
          if (ok) return { x: xx, y: yy };
        }
      }
      return { x: 4, y: 4 };
    }

    function removeSelected() {
      if (!sel) return;
      if (sel.kind === 'wire') C.removeWire(circuit, sel.id);
      else C.removePart(circuit, sel.id);
      select(null);
      res = sim.solve();
      changed('circuit');
    }

    function renderWarnings() {
      if (!warnBox) return;
      ui.clear(warnBox);
      var list = res.warnings || [];
      if (!list.length) return;
      warnBox.appendChild(ui.h('ul', { class: 'vc-warn-list' }, list.map(function (w) {
        return ui.h('li', {}, ui.h('span', { 'aria-hidden': 'true' }, '⚠ '), w.text);
      })));
    }

    function renderSelected() {
      if (!selBox) return;
      var h = ui.h;
      ui.clear(selBox);
      if (!sel) {
        selBox.appendChild(h('p', { class: 'vl-ctl-note' }, 'Select a component or lead on the bench to change it.'));
        return;
      }
      if (sel.kind === 'wire') {
        var w = null;
        circuit.wires.forEach(function (x) { if (x.id === sel.id) w = x; });
        if (!w) return;
        var pa = C.getPart(circuit, w.a.part), pb = C.getPart(circuit, w.b.part);
        selBox.appendChild(h('h3', { class: 'vc-sel-title' }, 'Lead'));
        selBox.appendChild(h('p', {}, 'From ' + describeEnd(pa, w.a.term) + ' to ' + describeEnd(pb, w.b.term) + '.'));
        var colSel = h('select', { 'aria-label': 'Lead colour', on: { change: function () { w.color = colSel.value; changed('circuit'); redraw(); } } },
          COLOUR_ORDER.map(function (c) { return h('option', { value: c, selected: c === w.color }, c); }));
        selBox.appendChild(h('label', { class: 'vc-field' }, 'Colour ', colSel));
        selBox.appendChild(h('button', { type: 'button', class: 'vl-btn', on: { click: removeSelected } }, 'Remove lead'));
        return;
      }
      var part = C.getPart(circuit, sel.id);
      if (!part) return;
      var t = C.types[part.type];
      selBox.appendChild(h('h3', { class: 'vc-sel-title' }, t.label));
      selBox.appendChild(h('p', { class: 'vc-desc' }, t.describe || ''));
      (t.settings || []).forEach(function (spec) { selBox.appendChild(settingField(part, spec)); });
      var r = res.parts[part.id] || {};
      var actions = h('div', { class: 'vc-actions' });
      if (r.blown) {
        actions.appendChild(h('button', { type: 'button', class: 'vl-btn', on: { click: function () { sim.repair(part.id); res = sim.solve(); renderSelected(); redraw(); } } },
          part.type === 'dmm' ? 'Replace the fuse' : 'Replace it'));
      }
      actions.appendChild(h('button', { type: 'button', class: 'vl-btn', on: { click: function () {
        circuit.wires = circuit.wires.filter(function (x) { return x.a.part !== part.id && x.b.part !== part.id; });
        res = sim.solve(); changed('circuit'); redraw();
      } } }, 'Disconnect its leads'));
      actions.appendChild(h('button', { type: 'button', class: 'vl-btn', on: { click: function () {
        var gm = geom(part);
        if (services.focusWorld) services.focusWorld(part.x + gm.w / 2, part.y + gm.h / 2, Math.min(12, 60 / Math.max(gm.w, gm.h * 1.5)));
      } } }, 'Zoom to it'));
      actions.appendChild(h('button', { type: 'button', class: 'vl-btn vl-btn--danger', on: { click: removeSelected } }, 'Remove from bench'));
      selBox.appendChild(actions);
    }

    function describeEnd(p, term) {
      if (!p) return '?';
      var t = C.types[p.type], tl = '';
      t.terminals.forEach(function (x) { if (x.id === term) tl = x.label || ''; });
      return t.label + (tl ? ' (' + tl + ')' : '');
    }

    var POS_STEPS = { jockey: [1, 0.1, 'towards A', 'towards B'], pos: [0.05, 0.01, 'one way', 'the other way'], distance: [1, 0.1, 'closer', 'further away'] };

    function settingField(part, spec) {
      var h = ui.h, s = part.settings;
      var id = 'vc-' + part.id + '-' + spec.key;
      if (spec.type === 'choice') {
        var choices = spec.choices;
        if (part.type === 'dmm' && spec.key === 'range') choices = C.DMM_RANGES[s.mode] || [];
        var selEl = h('select', { id: id, on: { change: function () {
          var v = selEl.value, num = Number(v);
          setSetting(part, spec.key, isFinite(num) && String(num) === v ? num : v);
        } } }, choices.map(function (c) {
          return h('option', { value: String(c), selected: String(c) === String(s[spec.key]) }, spec.format ? spec.format(c) : String(c));
        }));
        if (part.type === 'dmm' && s.mode === 'off' && spec.key === 'range') selEl.disabled = true;
        return h('div', { class: 'vc-field' }, h('label', { for: id }, spec.label + ' '), selEl);
      }
      if (spec.type === 'bool') {
        var cb = h('button', { type: 'button', class: 'vl-btn vc-toggle', 'aria-pressed': s[spec.key] ? 'true' : 'false',
          on: { click: function () { setSetting(part, spec.key, !s[spec.key]); } } },
          spec.key === 'closed' ? (s.closed ? 'Open the switch' : 'Close the switch') : (s[spec.key] ? 'Switch off' : 'Switch on'));
        return h('div', { class: 'vc-field' }, h('span', {}, spec.label + ': ' + (s[spec.key] ? 'yes' : 'no') + ' '), cb);
      }
      if (spec.type === 'number') {
        var val = Number(s[spec.key]) || 0;
        var shown = part.type === 'psu' ? 'knob at ' + val.toFixed(1) + ' (approx.)' : String(val);
        return h('div', { class: 'vc-field' }, h('span', {}, spec.label + ': '),
          h('button', { type: 'button', class: 'vl-btn vl-btn--small', 'aria-label': 'Decrease ' + spec.label, on: { click: function () { setSetting(part, spec.key, clamp(round(val - spec.step), spec.min, spec.max)); } } }, '−'),
          h('span', { class: 'vc-num' }, shown),
          h('button', { type: 'button', class: 'vl-btn vl-btn--small', 'aria-label': 'Increase ' + spec.label, on: { click: function () { setSetting(part, spec.key, clamp(round(val + spec.step), spec.min, spec.max)); } } }, '+'));
      }
      if (spec.type === 'position') {
        // never show the position as a number: read it on the scale
        var st = POS_STEPS[spec.key] || [0.05, 0.01, 'down', 'up'];
        function nudge(dv) {
          var v = clamp(round((Number(s[spec.key]) || 0) + dv), spec.min, spec.max);
          setSetting(part, spec.key, v);
        }
        return h('div', { class: 'vc-field' }, h('span', {}, spec.label + ' (read it on the scale, or drag it on the bench): '),
          h('div', { class: 'vc-nudges' },
            h('button', { type: 'button', class: 'vl-btn vl-btn--small', on: { click: function () { nudge(-st[0]); } } }, '◀◀ ' + st[2]),
            h('button', { type: 'button', class: 'vl-btn vl-btn--small', on: { click: function () { nudge(-st[1]); } } }, '◀ a little'),
            h('button', { type: 'button', class: 'vl-btn vl-btn--small', on: { click: function () { nudge(st[1]); } } }, 'a little ▶'),
            h('button', { type: 'button', class: 'vl-btn vl-btn--small', on: { click: function () { nudge(st[0]); } } }, st[3] + ' ▶▶')));
      }
      return h('span');
    }
    function round(v) { return Math.round(v * 10000) / 10000; }

    /* ---------------------------------------------------------- keyboard */

    function onKey(ev) {
      var t = ev.target;
      if (!t || !t.classList || !t.classList.contains('vl-app-canvas')) return;
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel) { ev.preventDefault(); removeSelected(); }
      else if (ev.key === 'Escape' && pendingWire) { pendingWire = null; redraw(); }
    }
    if (typeof document !== 'undefined') document.addEventListener('keydown', onKey);

    var controller = {
      world: WORLD,
      uses: ['stopwatch'],
      maxPxPerCm: 120,
      eyeDistance: 40,
      draw: draw,
      update: update,
      pointer: pointer,
      controls: controls,
      zoomTargets: [],
      isAnimating: function () { return true; },
      snapshot: function () {
        var m = {};
        circuit.parts.forEach(function (p) {
          var r = res.parts[p.id] || {};
          if (typeof r.reading === 'number') m[p.id] = { type: p.type, reading: r.reading, unit: r.unit, settings: JSON.parse(JSON.stringify(p.settings)) };
        });
        return { meters: m };
      },
      onStopwatchEvent: function () { return null; },
      getState: function () {
        var th = {};
        Object.keys(thermos).forEach(function (k) { th[k] = thermos[k].temperature; });
        return { sim: sim.getState(), thermo: th };
      },
      setState: function (s) {
        if (!s) return;
        if (s.thermo) Object.keys(s.thermo).forEach(function (k) { if (thermos[k]) thermos[k].setTemperature(s.thermo[k]); });
      },
      destroy: function () { if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey); },
      // extra API for the Circuit lab page
      select: select,
      selection: function () { return sel; },
      removeSelected: removeSelected,
      addPart: addPart,
      result: function () { return res; },
      resolve: function () { res = sim.solve(); renderSelected(); redraw(); return res; },
      refreshPanel: function () { renderSelected(); renderWarnings(); },
      sim: sim,
      termPos: function (partId, term) { var p = C.getPart(circuit, partId); return p ? termPos(p, term) : null; }
    };
    return controller;
  }

  ui.circuitBench = { createController: createController, GEOM: GEOM, WORLD: WORLD };
})(globalThis.VLab = globalThis.VLab || {});
