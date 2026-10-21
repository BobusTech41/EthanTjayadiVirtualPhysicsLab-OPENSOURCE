/**
 * Standard 9702 circuit symbols drawn on a canvas, and circuit diagrams built from them (browser only).
 *
 *   VL.ui.circuitSymbols.drawSymbol(g, sym, p, q, u, opts)    // p, q = end points in px; u = px per grid unit
 *   VL.ui.circuitSymbols.drawDiagram(g, diagram, box, opts)    // diagram from core/circuitTemplates.js
 *   VL.ui.circuitSymbols.icon(sym, size)                       // small canvas icon for the component box
 *
 * Symbols: cell, battery, dcsupply, switch, resistor (variable: true adds the arrow), rheostat, pot, wire,
 * ammeter, voltmeter, dmm, lamp, diode, led, thermistor, ldr, capacitor.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  function arrowHead(g, x, y, ang, s) {
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - s * Math.cos(ang - 0.45), y - s * Math.sin(ang - 0.45));
    g.lineTo(x - s * Math.cos(ang + 0.45), y - s * Math.sin(ang + 0.45));
    g.closePath();
    g.fill();
  }
  function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }

  /**
   * Draw one symbol between p and q (px). In the local frame the symbol runs along +x from 0 to L, centred on L/2.
   * opts: { ink, label, plus: 'p'|'q', slider: [x, y] px, jockey: [x, y] px, ends: ['A', 'B'], variable, font }
   */
  function drawSymbol(g, sym, p, q, u, opts) {
    opts = opts || {};
    var ink = opts.ink || '#111';
    var dx = q[0] - p[0], dy = q[1] - p[1], L = Math.sqrt(dx * dx + dy * dy) || 1, ang = Math.atan2(dy, dx);
    var lw = Math.max(1.2, u * 0.05);
    g.save();
    g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
    var base = g.getTransform();
    var flip = Math.cos(ang) < -1e-6 ? -1 : 1;     // keep decorations (arrows, labels) on the upper side
    g.translate(p[0], p[1]);
    g.rotate(ang);
    if (flip < 0) g.scale(1, -1);
    var mid = L / 2, bodyHalf, h;
    var ca = Math.cos(ang), sa = Math.sin(ang);

    function leads(half) { line(g, 0, 0, mid - half, 0); line(g, mid + half, 0, L, 0); }
    function text(t, x, y, size) {
      // draw upright in the caller's frame at the local point (x, y)
      var X = p[0] + ca * x - sa * flip * y, Y = p[1] + sa * x + ca * flip * y;
      g.save();
      g.setTransform(base);
      g.translate(X, Y);
      g.fillStyle = ink;
      g.font = Math.round(size) + 'px ' + (opts.font || 'Arial, Helvetica, sans-serif');
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t, 0, 0);
      g.restore();
    }
    function plusMark(atQ) {
      var x = atQ ? L - u * 0.25 : u * 0.25;
      text('+', x, -u * 0.32, u * 0.36, true);
    }

    switch (sym) {
      case 'resistor':
      case 'rheostat':
      case 'thermistor':
      case 'ldr':
      case 'pot': {
        bodyHalf = u * 0.5; h = u * 0.19;
        leads(bodyHalf);
        g.strokeRect(mid - bodyHalf, -h, 2 * bodyHalf, 2 * h);
        if (sym === 'rheostat' || opts.variable) {
          line(g, mid - bodyHalf * 0.9, h * 2.1, mid + bodyHalf * 0.8, -h * 2.1);
          arrowHead(g, mid + bodyHalf * 0.8, -h * 2.1, Math.atan2(-h * 4.2, bodyHalf * 1.7), u * 0.16);
        }
        if (sym === 'thermistor') {
          line(g, mid - bodyHalf * 0.95, h * 2.1, mid + bodyHalf * 0.75, -h * 2.1);
          line(g, mid + bodyHalf * 0.75, -h * 2.1, mid + bodyHalf * 1.15, -h * 2.1);
        }
        if (sym === 'ldr') {
          g.beginPath(); g.arc(mid, 0, bodyHalf * 1.25, 0, 2 * Math.PI); g.stroke();
          [-0.35, 0.05].forEach(function (o) {
            var x0 = mid + o * u - u * 0.35, y0 = -u * 0.95, x1 = mid + o * u - u * 0.05, y1 = -u * 0.55;
            line(g, x0, y0, x1, y1);
            arrowHead(g, x1, y1, Math.atan2(y1 - y0, x1 - x0), u * 0.13);
          });
        }
        if (sym === 'pot' && opts.slider) {
          // slider arrow from the slider point onto the middle of the track
          g.restore(); g.save();
          g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = lw;
          var cx = (p[0] + q[0]) / 2, cy = (p[1] + q[1]) / 2;
          var sx = opts.slider[0], sy = opts.slider[1];
          var a2 = Math.atan2(cy - sy, cx - sx), dd = Math.hypot(cx - sx, cy - sy);
          var ex = sx + (dd - h * 1.2) * Math.cos(a2), ey = sy + (dd - h * 1.2) * Math.sin(a2);
          line(g, sx, sy, ex, ey);
          arrowHead(g, ex, ey, a2, u * 0.16);
          g.restore();
          return;
        }
        break;
      }
      case 'wire': {
        h = u * 0.09;
        g.strokeRect(0, -h, L, 2 * h);
        if (opts.ends) { text(opts.ends[0], 0, -u * 0.38, u * 0.34, true); text(opts.ends[1], L, -u * 0.38, u * 0.34, true); }
        g.restore();
        if (opts.jockey) {
          g.save(); g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = lw;
          // the jockey touches the wire at the foot of the perpendicular from the jockey point
          var t = ((opts.jockey[0] - p[0]) * dx + (opts.jockey[1] - p[1]) * dy) / (L * L);
          var fx = p[0] + t * dx, fy = p[1] + t * dy;
          var a3 = Math.atan2(fy - opts.jockey[1], fx - opts.jockey[0]);
          var gx = fx - Math.cos(a3) * h * 1.2, gy = fy - Math.sin(a3) * h * 1.2;
          line(g, opts.jockey[0], opts.jockey[1], gx, gy);
          arrowHead(g, gx, gy, a3, u * 0.16);
          g.restore();
        }
        return;
      }
      case 'cell':
      case 'battery':
      case 'dcsupply': {
        var plusAtQ = opts.plus !== 'p';
        var gap = u * 0.14, longH = u * 0.38, shortH = u * 0.2;
        var cells = sym === 'battery' ? 2 : 1;
        var span = cells * 2 * gap + (cells - 1) * gap * 1.6;
        leads(span / 2);
        var x = mid - span / 2;
        for (var i = 0; i < cells; i++) {
          // plates ordered so that the long (+) plate is nearer the + end
          var firstLong = !plusAtQ;
          g.lineWidth = firstLong ? lw : lw * 2.6;
          line(g, x, firstLong ? -longH : -shortH, x, firstLong ? longH : shortH);
          g.lineWidth = firstLong ? lw * 2.6 : lw;
          line(g, x + 2 * gap, firstLong ? -shortH : -longH, x + 2 * gap, firstLong ? shortH : longH);
          g.lineWidth = lw;
          if (i < cells - 1) line(g, x + 2 * gap, 0, x + 2 * gap + gap * 1.6, 0);
          x += 2 * gap + gap * 1.6;
        }
        if (sym === 'dcsupply') text('d.c.', mid, u * 0.62, u * 0.3, true);
        plusMark(plusAtQ);
        break;
      }
      case 'switch': {
        bodyHalf = u * 0.45;
        leads(bodyHalf);
        var r = u * 0.07;
        g.beginPath(); g.arc(mid - bodyHalf + r, 0, r, 0, 2 * Math.PI); g.stroke();
        g.beginPath(); g.arc(mid + bodyHalf - r, 0, r, 0, 2 * Math.PI); g.stroke();
        line(g, mid - bodyHalf + 2 * r, -r * 0.4, mid + bodyHalf - r * 0.5, -u * 0.38);
        break;
      }
      case 'ammeter':
      case 'voltmeter':
      case 'dmm': {
        bodyHalf = u * 0.38;
        leads(bodyHalf);
        g.beginPath(); g.arc(mid, 0, bodyHalf, 0, 2 * Math.PI); g.stroke();
        text(sym === 'voltmeter' ? 'V' : sym === 'ammeter' ? 'A' : 'M', mid, 0, u * 0.42, true);
        if (opts.plus) plusMark(opts.plus === 'q');
        break;
      }
      case 'lamp': {
        bodyHalf = u * 0.36;
        leads(bodyHalf);
        g.beginPath(); g.arc(mid, 0, bodyHalf, 0, 2 * Math.PI); g.stroke();
        var k = bodyHalf * 0.7071;
        line(g, mid - k, -k, mid + k, k); line(g, mid - k, k, mid + k, -k);
        break;
      }
      case 'diode':
      case 'led': {
        bodyHalf = u * 0.3;
        leads(bodyHalf);
        g.beginPath();
        g.moveTo(mid - bodyHalf, -bodyHalf); g.lineTo(mid + bodyHalf * 0.75, 0); g.lineTo(mid - bodyHalf, bodyHalf); g.closePath();
        g.stroke();
        line(g, mid + bodyHalf * 0.75, -bodyHalf, mid + bodyHalf * 0.75, bodyHalf);
        if (sym === 'led') {
          [0, 0.32].forEach(function (o) {
            var x0 = mid - u * 0.05 + o * u, y0 = -u * 0.4, x1 = x0 + u * 0.3, y1 = y0 - u * 0.36;
            line(g, x0, y0, x1, y1);
            arrowHead(g, x1, y1, Math.atan2(y1 - y0, x1 - x0), u * 0.12);
          });
        }
        break;
      }
      case 'capacitor': {
        var cg = u * 0.12, ch = u * 0.36;
        leads(cg);
        line(g, mid - cg, -ch, mid - cg, ch);
        line(g, mid + cg, -ch, mid + cg, ch);
        if (opts.plus) plusMark(opts.plus === 'q');
        break;
      }
      default:
        leads(u * 0.4);
        g.strokeRect(mid - u * 0.4, -u * 0.25, u * 0.8, u * 0.5);
    }
    if (opts.label) text(opts.label, mid, -u * 0.62, u * 0.38, true);
    g.restore();
  }

  /**
   * Draw a whole diagram scaled into box { x, y, w, h } (px).
   * opts: { ink, highlight: ref | null, font }
   */
  function drawDiagram(g, diagram, box, opts) {
    opts = opts || {};
    var pad = 0.8;
    var u = Math.min(box.w / (diagram.w + 2 * pad), box.h / (diagram.h + 2 * pad));
    var ox = box.x + (box.w - (diagram.w + 2 * pad) * u) / 2 + pad * u;
    var oy = box.y + (box.h - (diagram.h + 2 * pad) * u) / 2 + pad * u;
    function P(pt) { return [ox + pt[0] * u, oy + pt[1] * u]; }
    var ink = opts.ink || '#111';
    g.save();
    g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = Math.max(1.2, u * 0.05); g.lineCap = 'round'; g.lineJoin = 'round';
    (diagram.wires || []).forEach(function (poly) {
      g.beginPath();
      poly.forEach(function (pt, i) { var s = P(pt); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); });
      g.stroke();
    });
    (diagram.dots || []).forEach(function (pt) {
      var s = P(pt);
      g.beginPath(); g.arc(s[0], s[1], Math.max(2.5, u * 0.09), 0, 2 * Math.PI); g.fill();
    });
    (diagram.items || []).forEach(function (it) {
      var hl = opts.highlight && opts.highlight === it.ref;
      if (hl) {
        var a = P(it.p), b = P(it.q);
        g.save();
        g.fillStyle = opts.highlightFill || 'rgba(255, 179, 0, 0.35)';
        var cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        g.beginPath(); g.arc(cx, cy, u * 0.85, 0, 2 * Math.PI); g.fill();
        g.restore();
      }
      drawSymbol(g, it.sym, P(it.p), P(it.q), u, {
        ink: ink, label: it.label, plus: it.plus, variable: it.variable, ends: it.ends,
        slider: it.slider ? P(it.slider) : null, jockey: it.jockey ? P(it.jockey) : null, font: opts.font
      });
    });
    (diagram.dims || []).forEach(function (d) {
      var a = P(d.from), b = P(d.to), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      g.save();
      g.lineWidth = Math.max(1, u * 0.035);
      line(g, a[0], a[1], b[0], b[1]);
      arrowHead(g, a[0], a[1], ang + Math.PI, u * 0.14);
      arrowHead(g, b[0], b[1], ang, u * 0.14);
      g.font = Math.round(u * 0.38) + 'px ' + (opts.font || 'Arial, Helvetica, sans-serif');
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText(d.label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - u * 0.08);
      g.restore();
    });
    g.restore();
    return { u: u, ox: ox, oy: oy };
  }

  /** A small canvas with the symbol, for lists and buttons. */
  function icon(sym, size, ink) {
    var c = document.createElement('canvas');
    var g = ui.fitCanvas ? ui.fitCanvas(c, size, size * 0.6) : c.getContext('2d');
    var u = size * 0.42;
    var opts = { ink: ink || '#111' };
    if (sym === 'wire') opts.jockey = [size * 0.55, size * 0.55];
    if (sym === 'pot') opts.slider = [size * 0.5, size * 0.08];
    drawSymbol(g, sym, [size * 0.06, size * 0.3], [size * 0.94, size * 0.3], u, opts);
    c.setAttribute('aria-hidden', 'true');
    c.className = 'vc-icon';
    return c;
  }

  ui.circuitSymbols = { drawSymbol: drawSymbol, drawDiagram: drawDiagram, icon: icon };
})(globalThis.VLab = globalThis.VLab || {});
