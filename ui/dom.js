/**
 * Small DOM helpers shared by every UI component (browser only).
 * VL.ui.h(tag, attrs, ...children) creates elements; VL.ui.bus is a tiny pub/sub.
 */
(function (VL) {
  'use strict';
  var ui = VL.ui = VL.ui || {};

  /**
   * Create an element.
   * attrs: { class, text, html, style (object|string), dataset, on: {event: fn}, ...plain attributes }
   * children: strings, nodes, arrays, null/false (ignored).
   */
  ui.h = function (tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  };

  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child)) : child);
  }
  ui.append = append;

  /** Remove all children. */
  ui.clear = function (el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
    return el;
  };

  /** addEventListener returning an unsubscribe function. */
  ui.on = function (target, event, fn, opts) {
    target.addEventListener(event, fn, opts);
    return function () { target.removeEventListener(event, fn, opts); };
  };

  ui.debounce = function (fn, ms) {
    var t = null;
    var d = function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
    d.flush = function () { clearTimeout(t); fn(); };
    return d;
  };

  /** Escape text for safe insertion into HTML strings. */
  ui.esc = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /** True when the event target is a text-entry element (shortcuts should not fire). */
  ui.isTyping = function (ev) {
    var t = ev && ev.target;
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    return tag === 'textarea' || tag === 'select' || t.isContentEditable ||
      (tag === 'input' && !/^(button|checkbox|radio|range|submit|reset)$/i.test(t.type || 'text'));
  };

  /** Format milliseconds as h:mm:ss or m:ss. */
  ui.formatClock = function (ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = (h ? String(m).padStart(2, '0') : String(m));
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  };

  /** Tiny pub/sub bus: VL.ui.bus.on('name', fn) -> off(); VL.ui.bus.emit('name', data). */
  ui.bus = (function () {
    var subs = {};
    return {
      on: function (name, fn) {
        (subs[name] = subs[name] || []).push(fn);
        return function () { subs[name] = (subs[name] || []).filter(function (f) { return f !== fn; }); };
      },
      emit: function (name, data) {
        (subs[name] || []).slice().forEach(function (fn) {
          try { fn(data); } catch (e) { console.error('[bus ' + name + ']', e); }
        });
      }
    };
  })();

  /** Non-blocking message (uses #toast-root). */
  ui.toast = function (msg, kind) {
    var root = document.getElementById('toast-root');
    if (!root) return;
    var el = ui.h('div', { class: 'vl-toast' + (kind ? ' vl-toast--' + kind : ''), role: 'status', text: msg });
    root.appendChild(el);
    setTimeout(function () { el.classList.add('vl-toast--out'); }, 3500);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4200);
  };

  /** Device-pixel-ratio aware canvas sizing. Returns the 2D context scaled to CSS pixels. */
  ui.fitCanvas = function (canvas, cssW, cssH, dprOverride) {
    var dpr = typeof dprOverride === 'number' && dprOverride > 0 ? dprOverride : (globalThis.devicePixelRatio || 1);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  };
})(globalThis.VLab = globalThis.VLab || {});
