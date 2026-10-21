/**
 * Export: CSV tables, PNG graphs and a small built-in PDF 1.4 writer (docs/ARCHITECTURE.md §3.13).
 *
 * Public API (VL.export):
 *   tableToCSV(table) -> string               RFC 4180, heading row first, every string exactly as typed, UTF-8 BOM
 *   download(filename, data, mime) -> boolean  browser only: Blob + temporary <a download>, object URL revoked
 *   downloadCanvasPNG(canvas, filename) -> boolean
 *   pdf(opts?) -> PdfDoc                       opts: { title?, author?, subject?, date? (Date|ISO string), footer? }
 *   reportPDF({ session, question, report, graphCanvas }) -> Blob
 *
 *   PdfDoc = {
 *     heading(text, level = 1), text(text, { size = 10.5, bold, indent, gap, color }), table(rows, opts),
 *     image(canvas, widthMm), pageBreak(), toBlob(),
 *     // additive:
 *     list(items, opts), space(pt), rule(), keyValue(pairs), toBytes() -> Uint8Array, pageCount() -> number
 *   }
 *
 * PDF details: A4 portrait (595 × 842 pt), standard Type 1 fonts Helvetica (F1) and Helvetica-Bold (F2) with
 * WinAnsiEncoding (no font embedding needed). Text is word-wrapped with the real Helvetica glyph widths and flows
 * onto new pages automatically. Characters outside WinAnsi are transliterated (Ω → ohm, θ → theta, ⁻¹ → ^-1 ...).
 * Images are JPEG (DCTDecode) XObjects taken from canvas.toDataURL('image/jpeg', 0.92) over a white background.
 * The file is assembled as bytes, with a byte-accurate cross-reference table.
 *
 * Pure parts (CSV, transliteration, PDF building from JPEG bytes) run in Node; download helpers need a browser.
 */
(function (VL) {
  'use strict';

  /* ================================================================== CSV */

  function str(v) { return v === undefined || v === null ? '' : String(v); }

  /** Quote a CSV field when needed (RFC 4180): comma, quote, CR/LF, or leading/trailing white space. */
  function csvField(v) {
    var s = str(v);
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * Convert a student's table to CSV. Headings first, then every row up to the last row that has any content
   * (blank rows in between are kept so row numbers match the table). Cells are written exactly as typed.
   * @param {object} table VL.datatable Table
   * @returns {string} CSV text starting with a UTF-8 byte-order mark, lines separated by CRLF
   */
  function tableToCSV(table) {
    var cols = table && Array.isArray(table.columns) ? table.columns : [];
    var rows = table && Array.isArray(table.rows) ? table.rows : [];
    var lines = [cols.map(function (c) { return csvField(c.heading); }).join(',')];
    var last = -1;
    rows.forEach(function (r, i) {
      var cells = (r && r.cells) || {};
      if (cols.some(function (c) { return str(cells[c.id]).trim() !== ''; })) last = i;
    });
    for (var i = 0; i <= last; i++) {
      var cells = (rows[i] && rows[i].cells) || {};
      lines.push(cols.map(function (c) { return csvField(cells[c.id]); }).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  /* ================================================================== downloads (browser only) */

  /** Decode a base64 string to bytes. */
  function base64ToBytes(b64) {
    var bin = globalThis.atob(String(b64).replace(/\s+/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  /** Bytes of a data: URL (base64 or percent-encoded). */
  function dataURLToBytes(url) {
    var m = /^data:([^,]*?)(;base64)?,(.*)$/.exec(String(url));
    if (!m) throw new Error('not a data URL');
    if (m[2]) return base64ToBytes(m[3]);
    var s = decodeURIComponent(m[3]);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  /**
   * Save data as a file via a temporary <a download> link.
   * @param {string} filename
   * @param {string|Blob|Uint8Array} data
   * @param {string} [mime] e.g. 'text/csv;charset=utf-8'
   * @returns {boolean} true when the download was started
   */
  function download(filename, data, mime) {
    var doc = globalThis.document;
    var URLs = globalThis.URL;
    if (!doc || !URLs || typeof URLs.createObjectURL !== 'function' || typeof globalThis.Blob !== 'function') {
      throw new Error('downloads need a browser');
    }
    var blob = data instanceof globalThis.Blob ? data : new globalThis.Blob([data], { type: mime || 'application/octet-stream' });
    var url = URLs.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = String(filename || 'download');
    a.rel = 'noopener';
    a.style.display = 'none';
    (doc.body || doc.documentElement).appendChild(a);
    try {
      a.click();
    } finally {
      if (a.parentNode) a.parentNode.removeChild(a);
      // revoke later: some browsers start reading the blob asynchronously after click()
      setTimeout(function () { try { URLs.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 4000);
    }
    return true;
  }

  /**
   * Save a canvas as a PNG file (synchronous, so the canvas may be destroyed straight afterwards).
   * @param {HTMLCanvasElement} canvas
   * @param {string} [filename='graph.png']
   * @returns {boolean}
   */
  function downloadCanvasPNG(canvas, filename) {
    if (!canvas || typeof canvas.toDataURL !== 'function') throw new Error('no canvas to export');
    var bytes = dataURLToBytes(canvas.toDataURL('image/png'));
    return download(filename || 'graph.png', new globalThis.Blob([bytes], { type: 'image/png' }), 'image/png');
  }

  /* ================================================================== text encoding for PDF (WinAnsi) */

  /** Unicode code points in 0x80–0x9F of WinAnsiEncoding (cp1252). */
  var CP1252 = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
    0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91,
    0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
    0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F
  };

  /** WinAnsi byte for a single character, or -1 when it has none. */
  function winAnsiByte(ch) {
    var c = ch.charCodeAt(0);
    if (ch.length !== 1) return -1;
    if (c === 9 || c === 10 || c === 13) return c;
    if (c >= 0x20 && c <= 0x7E) return c;
    if (c >= 0xA0 && c <= 0xFF) return c;
    return CP1252[c] !== undefined ? CP1252[c] : -1;
  }

  var GREEK = {
    'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta',
    'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'ν': 'nu', 'ξ': 'xi', 'ο': 'o', 'π': 'pi', 'ρ': 'rho',
    'ς': 'sigma', 'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi', 'ϕ': 'phi', 'χ': 'chi', 'ψ': 'psi',
    'ω': 'omega', 'Γ': 'Gamma', 'Δ': 'delta', '∆': 'delta', 'Θ': 'Theta', 'Λ': 'Lambda', 'Ξ': 'Xi',
    'Π': 'Pi', 'Σ': 'Sigma', 'Φ': 'Phi', 'Ψ': 'Psi', '\u03A9': 'ohm', '\u2126': 'ohm', 'ϑ': 'theta'
  };

  var SYMBOLS = {
    '√': 'sqrt', '≥': '>=', '≤': '<=', '≈': '~', '≃': '~', '≅': '~', '∼': '~', '≠': '=/=', '→': '->',
    '←': '<-', '↔': '<->', '⇒': '=>', '∝': ' proportional to ', '∞': 'infinity', '∑': 'sum', '∫': 'integral',
    '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '—', '⁄': '/', '∕': '/', '∗': '*', '⋅': '·', '∙': '·',
    '✓': '[OK]', '✔': '[OK]', '✗': '[X]', '✘': '[X]', '⚠': '(!)', 'ℹ': '(i)', '★': '*', '☆': '*',
    '′': "'", '″': '"', '\u2009': ' ', '\u200A': ' ', '\u202F': ' ', '\u2002': ' ', '\u2003': ' ',
    '\u2007': ' ', '\u2008': ' ', '\u200B': '', '\u200C': '', '\u200D': '', '\uFEFF': '', 'ℓ': 'l',
    '\u03BC': '\u00B5', '⟨': '<', '⟩': '>', '〈': '<', '〉': '>', '∠': 'angle ', '⊥': 'perp.',
    '╱': '/', '╲': '\\', '◺': 'triangle', '⌫': '', '∓': '-/+'
  };

  var SUPER = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁽': '(', '⁾': ')', 'ⁿ': 'n' };
  var SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₍': '(', '₎': ')' };

  /**
   * Replace every character that WinAnsiEncoding cannot show with a readable ASCII spelling.
   * Ω → ohm, θ → theta, π → pi, λ → lambda, Δ → delta, √ → sqrt, ≥ → >=, ≤ → <=; runs of superscripts that are
   * not all in WinAnsi become '^' + plain characters ('s⁻¹' → 's^-1', '10⁻³' → '10^-3') while ² ³ ¹ stay;
   * subscripts become plain digits ('t₁' → 't1'). ± ° ² ³ µ × · are kept (they are in WinAnsi).
   * @param {string} text
   * @returns {string} text whose every character has a WinAnsi byte
   */
  function transliterate(text) {
    var s = str(text);
    // superscript runs
    s = s.replace(/[⁰¹²³⁴-⁹⁺⁻⁽⁾ⁿ]+/g, function (run) {
      if (/^[¹²³]+$/.test(run)) return run;
      return '^' + run.split('').map(function (c) { return SUPER[c]; }).join('');
    });
    s = s.replace(/[₀-₎]/g, function (c) { return SUB[c] !== undefined ? SUB[c] : c; });
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var code = s.charCodeAt(i);
      // surrogate pairs (emoji etc.)
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
        out += '?';
        i++;
        continue;
      }
      if (winAnsiByte(ch) >= 0) { out += ch; continue; }
      var next = s.charAt(i + 1);
      if (GREEK[ch] !== undefined) {
        // keep words apart from following letters: 'Δy' → 'delta y', 'Ωm' → 'ohm m' (but 'θ0' → 'theta0')
        out += GREEK[ch] + (/[A-Za-z]/.test(next) ? ' ' : '');
        continue;
      }
      if (SYMBOLS[ch] !== undefined) {
        var rep = SYMBOLS[ch];
        out += rep + (/[A-Za-z]$/.test(rep) && /[A-Za-z0-9]/.test(next) ? ' ' : '');   // '√L' → 'sqrt L'
        continue;
      }
      // accented letters outside Latin-1 (ā, ő ...) and combining marks: strip the accents
      var base = '';
      if (typeof ch.normalize === 'function') base = ch.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
      if (base && base !== ch && base.split('').every(function (c) { return winAnsiByte(c) >= 0; })) { out += base; continue; }
      if (code >= 0x0300 && code <= 0x036f) continue;   // lone combining mark (e.g. the bar in t\u0304)
      out += '?';
    }
    return out;
  }

  /** Transliterate and convert to an array of WinAnsi byte values. */
  function toWinAnsi(text) {
    var t = transliterate(text);
    var out = [];
    for (var i = 0; i < t.length; i++) {
      var b = winAnsiByte(t.charAt(i));
      out.push(b < 0 ? 63 : b);
    }
    return out;
  }

  /**
   * A PDF literal string '(...)' from WinAnsi bytes: '\', '(' and ')' escaped; bytes outside printable ASCII
   * written as octal escapes so that content streams stay 7-bit clean.
   */
  function pdfString(bytes) {
    var s = '(';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b === 0x5C) s += '\\\\';
      else if (b === 0x28) s += '\\(';
      else if (b === 0x29) s += '\\)';
      else if (b < 0x20 || b > 0x7E) s += '\\' + ('00' + b.toString(8)).slice(-3);
      else s += String.fromCharCode(b);
    }
    return s + ')';
  }

  /**
   * Bytes for a document-information string. These use PDFDocEncoding, which agrees with WinAnsi except in
   * 0x80–0x9F, so dashes, curly quotes, bullets and the ellipsis are written in ASCII instead.
   */
  function infoBytes(text) {
    var swap = { 0x91: [39], 0x92: [39], 0x93: [34], 0x94: [34], 0x95: [42], 0x96: [45], 0x97: [45], 0x85: [46, 46, 46] };
    var out = [];
    toWinAnsi(text).forEach(function (b) {
      if (swap[b]) out.push.apply(out, swap[b]);
      else if (b >= 0x80 && b <= 0x9F) out.push(63);
      else out.push(b);
    });
    return out;
  }

  /* ================================================================== Helvetica metrics */

  // Advance widths (1/1000 em) for WinAnsi codes 32–126 (standard Adobe AFM values).
  var HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  var HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
  // Upper half of WinAnsi: [regular, bold]; accented letters take the width of their base letter.
  var HIGH = {
    0x80: [556, 556], 0x82: [222, 278], 0x83: [556, 556], 0x84: [333, 500], 0x85: [1000, 1000], 0x86: [556, 556],
    0x87: [556, 556], 0x88: [333, 333], 0x89: [1000, 1000], 0x8A: [667, 667], 0x8B: [333, 333], 0x8C: [1000, 1000],
    0x8E: [611, 611], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350],
    0x96: [556, 556], 0x97: [1000, 1000], 0x98: [333, 333], 0x99: [1000, 1000], 0x9A: [500, 556], 0x9B: [333, 333],
    0x9C: [944, 944], 0x9E: [500, 500], 0x9F: [667, 667], 0xA0: [278, 278], 0xA1: [333, 333], 0xA2: [556, 556],
    0xA3: [556, 556], 0xA4: [556, 556], 0xA5: [556, 556], 0xA6: [260, 280], 0xA7: [556, 556], 0xA8: [333, 333],
    0xA9: [737, 737], 0xAA: [370, 370], 0xAB: [556, 556], 0xAC: [584, 584], 0xAD: [333, 333], 0xAE: [737, 737],
    0xAF: [333, 333], 0xB0: [400, 400], 0xB1: [584, 584], 0xB2: [333, 333], 0xB3: [333, 333], 0xB4: [333, 333],
    0xB5: [556, 611], 0xB6: [537, 556], 0xB7: [278, 278], 0xB8: [333, 333], 0xB9: [333, 333], 0xBA: [365, 365],
    0xBB: [556, 556], 0xBC: [834, 834], 0xBD: [834, 834], 0xBE: [834, 834], 0xBF: [611, 611], 0xC6: [1000, 1000],
    0xC7: [722, 722], 0xD0: [722, 722], 0xD7: [584, 584], 0xD8: [778, 778], 0xDE: [667, 667], 0xDF: [611, 611],
    0xE6: [889, 889], 0xE7: [500, 556], 0xF0: [556, 611], 0xF7: [584, 584], 0xF8: [611, 611], 0xFE: [556, 611]
  };
  var BASE_LETTER = 'AAAAAA_CEEEEIIIIDNOOOOO_OUUUUYPsaaaaaa_ceeeeiiiidnooooo_ouuuuypy';  // for 0xC0–0xFF

  /** Width of one WinAnsi byte in 1/1000 em. */
  function glyphWidth(b, bold) {
    if (b >= 32 && b <= 126) return (bold ? HELV_BOLD : HELV)[b - 32];
    if (HIGH[b]) return HIGH[b][bold ? 1 : 0];
    if (b >= 0xC0 && b <= 0xFF) {
      var base = BASE_LETTER.charAt(b - 0xC0);
      if (base && base !== '_') return glyphWidth(base.charCodeAt(0), bold);
    }
    return bold ? 611 : 556;
  }

  /**
   * Width of a string in points.
   * @param {string} text
   * @param {number} size font size (pt)
   * @param {boolean} [bold]
   */
  function textWidth(text, size, bold) {
    var bytes = toWinAnsi(text), w = 0;
    for (var i = 0; i < bytes.length; i++) w += glyphWidth(bytes[i], bold);
    return w * size / 1000;
  }

  /**
   * Word-wrap text into lines no wider than maxWidth (pt). Paragraphs ('\n') are kept; words longer than a line
   * are broken. Leading spaces of a paragraph are kept, other runs of spaces collapse.
   * @returns {string[]} lines (transliterated)
   */
  function wrapText(text, size, bold, maxWidth) {
    var out = [];
    var paras = transliterate(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    var spaceW = textWidth(' ', size, bold);
    paras.forEach(function (para) {
      var indentMatch = /^ */.exec(para);
      var lead = indentMatch ? indentMatch[0] : '';
      var words = para.slice(lead.length).split(/ +/).filter(function (w) { return w !== ''; });
      if (!words.length) { out.push(''); return; }
      var line = lead, lineW = textWidth(lead, size, bold);
      var fresh = true;
      words.forEach(function (w) {
        var ww = textWidth(w, size, bold);
        if (!fresh && lineW + spaceW + ww <= maxWidth + 1e-6) {
          line += ' ' + w;
          lineW += spaceW + ww;
          return;
        }
        if (!fresh) { out.push(line); line = ''; lineW = 0; }
        // break very long words
        while (ww > maxWidth - lineW + 1e-6 && w.length > 1) {
          var cut = 1;
          while (cut < w.length && textWidth(w.slice(0, cut + 1), size, bold) <= maxWidth - lineW + 1e-6) cut++;
          out.push(line + w.slice(0, cut));
          w = w.slice(cut);
          ww = textWidth(w, size, bold);
          line = '';
          lineW = 0;
        }
        line += w;
        lineW += ww;
        fresh = false;
      });
      out.push(line);
    });
    return out;
  }

  /* ================================================================== PDF writer */

  var PAGE_W = 595, PAGE_H = 842;
  var MARGIN_L = 50, MARGIN_R = 50, MARGIN_T = 56, MARGIN_B = 60;
  var CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;
  var MM = 72 / 25.4;

  function num(x) {
    var s = (Math.round(x * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  }

  function colorOp(color, stroke) {
    var c = color || [0, 0, 0];
    return num(c[0]) + ' ' + num(c[1]) + ' ' + num(c[2]) + (stroke ? ' RG' : ' rg');
  }

  /** Latin-1 string → bytes. */
  function asciiBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  /** Format a Date as a PDF date string D:YYYYMMDDHHmmSSZ. */
  function pdfDate(d) {
    var date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return null;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return 'D:' + date.getUTCFullYear() + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
      p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  }

  /**
   * JPEG bytes and pixel size of an image source:
   * a canvas (drawn over white, then toDataURL('image/jpeg', 0.92)), a JPEG data URL with { width, height },
   * or { jpeg: Uint8Array, width, height }.
   */
  function jpegOf(src) {
    if (!src) throw new Error('no image');
    if (src.jpeg && src.width && src.height) return { bytes: src.jpeg, width: src.width | 0, height: src.height | 0 };
    if (typeof src.dataURL === 'string') return { bytes: dataURLToBytes(src.dataURL), width: src.width | 0, height: src.height | 0 };
    if (typeof src.toDataURL !== 'function') throw new Error('unsupported image source');
    var w = src.width | 0, hgt = src.height | 0;
    if (!(w > 0 && hgt > 0)) throw new Error('empty canvas');
    var source = src;
    var doc = globalThis.document;
    if (doc && typeof doc.createElement === 'function') {
      // JPEG has no transparency: composite over white so transparent areas do not turn black
      try {
        var flat = doc.createElement('canvas');
        flat.width = w;
        flat.height = hgt;
        var g = flat.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, hgt);
        g.drawImage(src, 0, 0);
        source = flat;
      } catch (e) {
        source = src;
      }
    }
    var url = source.toDataURL('image/jpeg', 0.92);
    if (!/^data:image\/jpeg/i.test(url)) throw new Error('this browser cannot make JPEG images');
    return { bytes: dataURLToBytes(url), width: w, height: hgt };
  }

  /**
   * Create a PDF document.
   * @param {{title?:string, author?:string, subject?:string, date?:(Date|string), footer?:string}} [opts]
   * @returns {object} PdfDoc
   */
  function pdf(opts) {
    opts = opts || {};
    var pages = [];        // { ops: [string], images: { name: imageIndex } }
    var images = [];       // { bytes, width, height }
    var page = null;
    var y = 0;             // current baseline cursor (pt from the bottom)

    function newPage() {
      page = { ops: [], images: {} };
      pages.push(page);
      y = PAGE_H - MARGIN_T;
    }

    function ensure(h) {
      if (!page) newPage();
      if (y - h < MARGIN_B && y < PAGE_H - MARGIN_T - 0.5) newPage();
    }

    function drawText(x, baseline, text, size, bold, color) {
      var bytes = toWinAnsi(text);
      if (!bytes.length) return;
      page.ops.push('BT ' + colorOp(color) + ' /' + (bold ? 'F2' : 'F1') + ' ' + num(size) + ' Tf ' +
        num(x) + ' ' + num(baseline) + ' Td ' + pdfString(bytes) + ' Tj ET');
    }

    function line(x1, y1, x2, y2, width, color) {
      page.ops.push(colorOp(color || [0, 0, 0], true) + ' ' + num(width || 0.5) + ' w ' +
        num(x1) + ' ' + num(y1) + ' m ' + num(x2) + ' ' + num(y2) + ' l S');
    }

    function rect(x, y0, w, h, fill) {
      page.ops.push(colorOp(fill) + ' ' + num(x) + ' ' + num(y0) + ' ' + num(w) + ' ' + num(h) + ' re f');
    }

    /** Write wrapped text lines. */
    function paragraph(text, o) {
      o = o || {};
      var size = o.size || 10.5;
      var bold = !!o.bold;
      var lead = size * (o.lineHeight || 1.3);
      var indent = o.indent || 0;
      var first = o.firstPrefix || '';
      var prefixBold = o.prefixBold === undefined ? bold : !!o.prefixBold;
      var firstW = first ? textWidth(first, size, prefixBold) : 0;
      var lines = wrapText(text, size, bold, CONTENT_W - indent - firstW);
      if (o.gapBefore) { ensure(o.gapBefore + lead); if (y < PAGE_H - MARGIN_T - 0.5) y -= o.gapBefore; }
      lines.forEach(function (ln, i) {
        ensure(lead);
        y -= lead;
        var x = MARGIN_L + indent;
        if (first) {
          if (i === 0) drawText(x, y + (lead - size) * 0.5, first, size, prefixBold, o.color);
          x += firstW;
        }
        drawText(x, y + (lead - size) * 0.5, ln, size, bold, o.color);
      });
      if (o.gap) y -= o.gap;
    }

    var api = {
      /**
       * A heading (level 1: 18 pt, 2: 14 pt, 3: 12 pt), kept with at least two following lines.
       * @param {string} text
       * @param {number} [level=1]
       */
      heading: function (text, level) {
        level = level || 1;
        var size = level === 1 ? 18 : level === 2 ? 14 : 12;
        var before = level === 1 ? 6 : level === 2 ? 14 : 10;
        if (!page) newPage();
        ensure(before + size * 1.3 + 30);
        if (y < PAGE_H - MARGIN_T - 0.5) y -= before;
        paragraph(text, { size: size, bold: true, gap: level === 1 ? 6 : 4, color: level === 1 ? [0.04, 0.2, 0.45] : null });
        if (level === 1) {
          line(MARGIN_L, y + 2, PAGE_W - MARGIN_R, y + 2, 1, [0.04, 0.2, 0.45]);
          y -= 6;
        }
        return api;
      },

      /**
       * Wrapped body text. Separate paragraphs with '\n'.
       * @param {string} text
       * @param {{size?:number, bold?:boolean, indent?:number, gap?:number, color?:number[]}} [o]
       */
      text: function (text, o) {
        o = o || {};
        paragraph(text, { size: o.size, bold: o.bold, indent: o.indent, color: o.color, gap: o.gap === undefined ? 3 : o.gap });
        return api;
      },

      /**
       * Bulleted (or numbered with { numbered: true }) list with hanging indents.
       * @param {string[]} items
       */
      list: function (items, o) {
        o = o || {};
        (items || []).forEach(function (it, i) {
          var marker = o.numbered ? (i + 1) + '. ' : '• ';
          paragraph(str(it), { size: o.size, indent: (o.indent || 0) + 4, firstPrefix: marker, gap: 1.5 });
        });
        if (page) y -= 3;
        return api;
      },

      /** Label/value pairs, e.g. [['Seed', 'PEN-7K2Q-91C3']]. */
      keyValue: function (pairs, o) {
        o = o || {};
        var size = o.size || 10.5;
        (pairs || []).forEach(function (p) {
          var label = str(p[0]) + ': ';
          paragraph(str(p[1]), { size: size, firstPrefix: label, prefixBold: true, gap: 0.5 });
        });
        if (page) y -= 4;
        return api;
      },

      /** Vertical space (pt). */
      space: function (pt) {
        if (!page) newPage();
        y -= pt || 6;
        if (y < MARGIN_B) newPage();
        return api;
      },

      /** Horizontal rule across the text width. */
      rule: function () {
        ensure(10);
        y -= 5;
        line(MARGIN_L, y, PAGE_W - MARGIN_R, y, 0.5, [0.6, 0.6, 0.6]);
        y -= 5;
        return api;
      },

      /**
       * A ruled table. rows[0] is the header row (repeated after a page break) unless header: false.
       * Column widths follow the content (or opts.widths, relative numbers) and always fit the page.
       * @param {string[][]} rows
       * @param {{header?:boolean, size?:number, widths?:number[]}} [o]
       */
      table: function (rows, o) {
        o = o || {};
        rows = (rows || []).filter(Array.isArray);
        if (!rows.length) return api;
        var size = o.size || 9.5, lead = size * 1.25, pad = 4;
        var header = o.header !== false;
        var nCols = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
        if (!nCols) return api;
        var widths;
        if (Array.isArray(o.widths) && o.widths.length === nCols) {
          var tot = o.widths.reduce(function (s, w) { return s + w; }, 0);
          widths = o.widths.map(function (w) { return CONTENT_W * w / tot; });
        } else {
          // natural widths (longest unbreakable word as minimum), scaled to fit
          var natural = [], minW = [];
          for (var c = 0; c < nCols; c++) {
            var mx = 20, mn = 20;
            rows.forEach(function (r, ri) {
              var cell = str(r[c]);
              var bold = header && ri === 0;
              cell.split('\n').forEach(function (part) {
                mx = Math.max(mx, textWidth(part, size, bold) + 2 * pad);
                part.split(/\s+/).forEach(function (w) { mn = Math.max(mn, Math.min(textWidth(w, size, bold) + 2 * pad, CONTENT_W / 2)); });
              });
            });
            natural.push(mx);
            minW.push(mn);
          }
          var sumNat = natural.reduce(function (s, w) { return s + w; }, 0);
          if (sumNat <= CONTENT_W) widths = natural;
          else {
            var sumMin = minW.reduce(function (s, w) { return s + w; }, 0);
            if (sumMin >= CONTENT_W) widths = minW.map(function (w) { return w * CONTENT_W / sumMin; });
            else {
              // give each column its minimum, share the rest in proportion to (natural − minimum)
              var extra = CONTENT_W - sumMin;
              var want = natural.map(function (w, i) { return w - minW[i]; });
              var sumWant = want.reduce(function (s, w) { return s + w; }, 0) || 1;
              widths = minW.map(function (w, i) { return w + extra * want[i] / sumWant; });
            }
          }
        }
        var tableW = widths.reduce(function (s, w) { return s + w; }, 0);

        // a single row may never be taller than a page: a very long cell is cut short, and says so (with the number
        // of characters left out) rather than ending in a bare ellipsis
        var maxLines = Math.max(1, Math.floor((PAGE_H - MARGIN_T - MARGIN_B - 3 * lead - 4 * pad) / lead) - 2);
        function layoutRow(r, bold) {
          var cells = [];
          var nLines = 1;
          for (var c = 0; c < nCols; c++) {
            var text = str(r[c]);
            var ls = wrapText(text, size, bold, widths[c] - 2 * pad);
            if (ls.length > maxLines) ls = truncateCell(text, ls, bold, widths[c] - 2 * pad);
            cells.push(ls);
            nLines = Math.max(nLines, ls.length);
          }
          return { cells: cells, h: nLines * lead + 2 * pad - 2, bold: bold };
        }

        /** The first lines of an over-long cell, then a note: '[answer continues — N more characters not shown …]'. */
        function truncateCell(text, ls, bold, w) {
          var noteLines = [], keep = maxLines, shown = 0;
          for (var pass = 0; pass < 3; pass++) {           // the count's width can change the note's line count
            keep = Math.max(1, maxLines - Math.max(1, noteLines.length));
            shown = 0;
            for (var i = 0; i < keep; i++) shown += ls[i].trim().length + (i ? 1 : 0);
            var left = Math.max(1, transliterate(text).trim().length - shown);
            noteLines = wrapText('[answer continues \u2014 ' + left + ' more characters not shown; see the report in the app]', size, bold, w);
          }
          return ls.slice(0, Math.max(1, maxLines - noteLines.length)).concat(noteLines);
        }

        function drawRow(lr, isHeader) {
          var top = y, bottom = y - lr.h;
          if (isHeader) rect(MARGIN_L, bottom, tableW, lr.h, [0.9, 0.92, 0.95]);
          var x = MARGIN_L;
          for (var c = 0; c < nCols; c++) {
            lr.cells[c].forEach(function (ln, i) {
              drawText(x + pad, top - pad - (i + 1) * lead + (lead - size) * 0.5 + 1, ln, size, lr.bold);
            });
            x += widths[c];
          }
          // rules: top, bottom and vertical separators
          line(MARGIN_L, top, MARGIN_L + tableW, top, 0.5);
          line(MARGIN_L, bottom, MARGIN_L + tableW, bottom, 0.5);
          x = MARGIN_L;
          for (var k = 0; k <= nCols; k++) {
            line(x, top, x, bottom, 0.5);
            if (k < nCols) x += widths[k];
          }
          y = bottom;
        }

        var headLayout = header ? layoutRow(rows[0], true) : null;
        if (!page) newPage();
        ensure(4 + (headLayout ? headLayout.h : 0) + lead + 2 * pad);
        y -= 4;
        if (headLayout) drawRow(headLayout, true);
        rows.slice(header ? 1 : 0).forEach(function (r) {
          var lr = layoutRow(r, false);
          if (y - lr.h < MARGIN_B) {
            newPage();
            if (headLayout) drawRow(headLayout, true);
          }
          drawRow(lr, false);
        });
        y -= 8;
        return api;
      },

      /**
       * Embed an image (JPEG) at the given width, keeping its aspect ratio; moves to a new page if needed.
       * @param {HTMLCanvasElement|{jpeg:Uint8Array,width:number,height:number}} canvas
       * @param {number} [widthMm=160]
       */
      image: function (canvas, widthMm) {
        var img = jpegOf(canvas);
        var w = Math.min((widthMm || 160) * MM, CONTENT_W);
        var h = w * img.height / img.width;
        var maxH = PAGE_H - MARGIN_T - MARGIN_B - 10;
        if (h > maxH) { w = w * maxH / h; h = maxH; }
        if (!page) newPage();
        ensure(h + 8);
        images.push(img);
        var name = 'Im' + images.length;
        page.images[name] = images.length - 1;
        y -= h + 4;
        page.ops.push('q ' + num(w) + ' 0 0 ' + num(h) + ' ' + num(MARGIN_L) + ' ' + num(y) + ' cm /' + name + ' Do Q');
        page.ops.push(colorOp([0.6, 0.6, 0.6], true) + ' 0.5 w ' + num(MARGIN_L) + ' ' + num(y) + ' ' + num(w) + ' ' + num(h) + ' re S');
        y -= 8;
        return api;
      },

      /** Start a new page. */
      pageBreak: function () {
        newPage();
        return api;
      },

      /** Number of pages so far. */
      pageCount: function () {
        return pages.length || 1;
      },

      /** The finished file as bytes. */
      toBytes: function () {
        if (!pages.length) newPage();
        return build();
      },

      /** The finished file as a Blob (application/pdf). */
      toBlob: function () {
        var bytes = api.toBytes();
        if (typeof globalThis.Blob !== 'function') throw new Error('Blob is not available');
        return new globalThis.Blob([bytes], { type: 'application/pdf' });
      }
    };

    /** Assemble the file. Object numbers: 1 catalog, 2 pages, 3–4 fonts, 5 info, then images, then pages. */
    function build() {
      var chunks = [], offsets = [], length = 0;
      function push(bytes) { chunks.push(bytes); length += bytes.length; }
      function pushStr(s) { push(asciiBytes(s)); }
      function startObj(n) { offsets[n] = length; pushStr(n + ' 0 obj\n'); }

      var nImages = images.length, nPages = pages.length;
      var firstImage = 6, firstPage = firstImage + nImages;
      var total = firstPage + 2 * nPages;   // object count including object 0

      push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // %PDF-1.4 + binary comment

      startObj(1);
      pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
      startObj(2);
      var kids = [];
      for (var p = 0; p < nPages; p++) kids.push((firstPage + 2 * p) + ' 0 R');
      pushStr('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + nPages + ' >>\nendobj\n');
      startObj(3);
      pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
      startObj(4);
      pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');
      startObj(5);
      var info = '<< /Producer ' + pdfString(infoBytes('Virtual Practical Lab (9702 Paper 3)'));
      if (opts.title) info += ' /Title ' + pdfString(infoBytes(opts.title));
      if (opts.author) info += ' /Author ' + pdfString(infoBytes(opts.author));
      if (opts.subject) info += ' /Subject ' + pdfString(infoBytes(opts.subject));
      var pd = opts.date ? pdfDate(opts.date) : null;
      if (pd) info += ' /CreationDate (' + pd + ')';
      pushStr(info + ' >>\nendobj\n');

      images.forEach(function (img, i) {
        startObj(firstImage + i);
        pushStr('<< /Type /XObject /Subtype /Image /Width ' + img.width + ' /Height ' + img.height +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.bytes.length + ' >>\nstream\n');
        push(img.bytes);
        pushStr('\nendstream\nendobj\n');
      });

      pages.forEach(function (pg, i) {
        var ops = pg.ops.slice();
        // footer: page n of N
        var footer = (opts.footer ? opts.footer + '   ' : '') + 'Page ' + (i + 1) + ' of ' + nPages;
        var fw = textWidth(footer, 8.5, false);
        ops.push('BT ' + colorOp([0.35, 0.35, 0.35]) + ' /F1 8.5 Tf ' + num(PAGE_W - MARGIN_R - fw) + ' ' + num(MARGIN_B - 30) +
          ' Td ' + pdfString(toWinAnsi(footer)) + ' Tj ET');
        var content = ops.join('\n');
        var pageObj = firstPage + 2 * i, contentObj = pageObj + 1;
        var xo = Object.keys(pg.images);
        startObj(pageObj);
        pushStr('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>' +
          (xo.length ? ' /XObject << ' + xo.map(function (n) { return '/' + n + ' ' + (firstImage + pg.images[n]) + ' 0 R'; }).join(' ') + ' >>' : '') +
          ' /ProcSet [/PDF /Text /ImageC] >> /Contents ' + contentObj + ' 0 R >>\nendobj\n');
        var cb = asciiBytes(content);
        startObj(contentObj);
        pushStr('<< /Length ' + cb.length + ' >>\nstream\n');
        push(cb);
        pushStr('\nendstream\nendobj\n');
      });

      var xrefAt = length;
      var xref = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
      for (var n = 1; n < total; n++) xref += ('0000000000' + offsets[n]).slice(-10) + ' 00000 n \n';
      pushStr(xref);
      pushStr('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 5 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF');

      var out = new Uint8Array(length), pos = 0;
      chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
      return out;
    }

    return api;
  }

  /* ================================================================== report PDF */

  var SKILL_NAMES = {
    MMO: 'Manipulation, measurement and observation',
    PDO: 'Presentation of data and observations',
    ACE: 'Analysis, conclusions and evaluation'
  };

  function pct(got, max) { return max > 0 ? Math.round(100 * got / max) + ' %' : '—'; }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function modeName(mode) {
    return mode === 'exam' ? 'Exam' : mode === 'drill' ? 'Skill drill' : mode === 'practice' ? 'Practice' : str(mode) || '—';
  }

  /** Strip the ✓ / ✗ the marker puts at the start of a comment (the table has its own Awarded column). */
  function plainComment(c) {
    return str(c).replace(/^\s*[✓✗]\s*/, '');
  }

  /** Answer keys → readable labels from the paper (part label + prefix), e.g. 'g' → '(g) g ='. */
  function answerLabels(paper) {
    var labels = {};
    function scan(part, prefixLabel) {
      (part.answers || []).forEach(function (a) {
        if (!a || !a.key) return;
        var lab = (prefixLabel || '') + (a.prefix ? ' ' + a.prefix : ' ' + a.key);
        labels[a.key] = lab.trim();
        if (a.type === 'working') labels[a.key + '_working'] = (prefixLabel || '') + ' working';
      });
    }
    ((paper && paper.parts) || []).forEach(function (p) {
      scan(p, p.label || '');
      (p.subparts || []).forEach(function (s) { scan(s, (p.label || '') + (s.label || '')); });
    });
    return labels;
  }

  function tableRows(table) {
    if (!table || !Array.isArray(table.columns) || !table.columns.length) return null;
    var cols = table.columns;
    var rows = [cols.map(function (c) { return str(c.heading) || '(no heading)'; })];
    (table.rows || []).forEach(function (r) {
      var cells = (r && r.cells) || {};
      if (!cols.some(function (c) { return str(cells[c.id]).trim() !== ''; })) return;
      rows.push(cols.map(function (c) { return str(cells[c.id]); }));
    });
    return rows.length > 1 || cols.some(function (c) { return str(c.heading).trim(); }) ? rows : null;
  }

  /**
   * Rows [label, text] for the answers table. A list answer (array) gets one row per non-empty item,
   * '(h)(i) limitation 1', '(h)(i) limitation 2' ..., so one very long item can never hide the others.
   */
  function answerRows(answers, keys, labels) {
    var rows = [];
    keys.forEach(function (k) {
      var v = answers[k], lab = labels[k] || k;
      if (Array.isArray(v)) {
        var one = lab.replace(/([^s])s$/, '$1');            // 'limitations' → 'limitation 1'
        v.forEach(function (x, i) { if (str(x).trim()) rows.push([one + ' ' + (i + 1), str(x)]); });
      } else {
        rows.push([lab, answerValueText(v)]);
      }
    });
    return rows;
  }

  function answerValueText(v) {
    if (Array.isArray(v)) return v.map(function (x, i) { return (i + 1) + '. ' + str(x); }).join('\n');
    if (v && typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return ''; } }
    return str(v);
  }

  /**
   * Build the examiner-style report as a PDF.
   * @param {{session?:object, question:object, report:object, graphCanvas?:HTMLCanvasElement}} o
   * @returns {Blob}
   */
  function reportPDF(o) {
    return buildReport(o).toBlob();
  }

  /** The report PdfDoc (shared by reportPDF and tests). */
  function buildReport(o) {
    o = o || {};
    var session = o.session || {}, q = o.question || {}, report = o.report || q.report || {};
    var exp = null, variant = null, paper = null;
    try { exp = VL.getExperiment ? VL.getExperiment(q.expId || report.expId) : null; } catch (e) { exp = null; }
    var variantId = q.variantId || report.variantId;
    if (exp) {
      try { variant = VL.getVariant ? VL.getVariant(exp, variantId) : null; } catch (e) { variant = null; }
      try {
        var params = exp.sampleParams(VL.rng.create(q.seed || report.seed).fork('params'), variantId);
        paper = exp.paper(variantId, params);
      } catch (e) { paper = null; }
    }
    var expTitle = exp ? exp.title : str(q.expId || report.expId) || 'Experiment';
    var seed = str(q.seed || report.seed);
    var doc = pdf({
      title: 'Practical report — ' + expTitle,
      subject: 'Cambridge International AS Level Physics 9702, Paper 3 practice',
      date: report.markedAt || undefined,
      footer: 'Virtual Practical Lab · ' + expTitle + (seed ? ' · seed ' + seed : '')
    });

    doc.heading('Practical report: ' + expTitle, 1);
    doc.keyValue([
      ['Mode', modeName(session.mode)],
      ['Experiment', expTitle + (q.expId ? ' (' + q.expId + ')' : '')],
      ['Variant', variant ? (variant.title || variant.id) + ' (' + (variant.style === 'Q2' ? 'Question 2 style' : 'Question 1 style') + ')' : str(variantId) || '—'],
      ['Seed', seed || '—'],
      ['Session', str(session.title) || '—'],
      ['Marked', fmtDate(report.markedAt) || '—']
    ]);

    // totals
    doc.heading('Marks', 2);
    var total = Number(report.total) || 0, max = Number(report.max) || 0;
    doc.text('Total: ' + total + ' / ' + max + (max ? ' (' + pct(total, max) + ')' : ''), { size: 13, bold: true, gap: 6 });
    var skills = report.skills || {};
    var skillRows = [['Skill', 'Marks', 'Percentage']];
    ['MMO', 'PDO', 'ACE'].forEach(function (k) {
      var s = skills[k] || { got: 0, max: 0 };
      skillRows.push([k + ' — ' + SKILL_NAMES[k], s.got + ' / ' + s.max, pct(s.got, s.max)]);
    });
    doc.table(skillRows, { widths: [5, 1.2, 1.2] });

    if (Array.isArray(report.parts) && report.parts.length) {
      doc.heading('Marks by part', 3);
      doc.table([['Part', 'Marks']].concat(report.parts.map(function (p) {
        return [str(p.label || p.part), p.got + ' / ' + p.max];
      })), { widths: [3, 1] });
    }

    // every mark point
    if (Array.isArray(report.points) && report.points.length) {
      doc.heading('Mark points', 2);
      var partLabel = {};
      (report.parts || []).forEach(function (p) { partLabel[p.part] = p.label || p.part; });
      doc.table([['Part', 'Skill', 'Mark point', 'Awarded', 'Examiner comment']].concat(report.points.map(function (p) {
        var aw = (p.awarded >= p.max && p.max > 0 ? '✓ ' : p.awarded > 0 ? '~ ' : '✗ ') + p.awarded + ' / ' + p.max;
        return [str(partLabel[p.part] || p.part), str(p.skill), str(p.label), aw, plainComment(p.comment)];
      })), { widths: [0.8, 0.8, 2.2, 1.1, 5], size: 8.5 });
    }

    // the student's answers
    var answers = q.answers || {};
    var keys = Object.keys(answers).filter(function (k) { return answerValueText(answers[k]).trim() !== ''; });
    doc.heading('Your answers', 2);
    if (keys.length) {
      doc.table([['Question', 'Your answer']].concat(answerRows(answers, keys, answerLabels(paper))), { widths: [1.4, 4] });
    } else {
      doc.text('No written answers were given.');
    }

    // the student's table
    doc.heading('Your table', 2);
    var tr = tableRows(q.table);
    if (tr) doc.table(tr, { size: 9.5 });
    else doc.text('No table was recorded.');

    // the graph
    doc.heading('Your graph', 2);
    var drewGraph = false;
    if (o.graphCanvas) {
      try { doc.image(o.graphCanvas, 165); drewGraph = true; } catch (e) { drewGraph = false; }
    }
    if (!drewGraph) doc.text(q.graph && q.graph.points && q.graph.points.length ? 'The graph could not be included in this file.' : 'No graph was drawn.');
    if (q.graph && q.graph.readOffs) {
      var ro = q.graph.readOffs;
      if ([ro.x1, ro.y1, ro.x2, ro.y2].some(function (v) { return str(v).trim(); })) {
        doc.text('Gradient triangle read-offs: (' + str(ro.x1) + ', ' + str(ro.y1) + ') and (' + str(ro.x2) + ', ' + str(ro.y2) + ')', { size: 9.5 });
      }
      if (q.graph.intercept && str(q.graph.intercept.value).trim()) {
        doc.text('y-intercept on the graph: ' + str(q.graph.intercept.value) +
          (q.graph.intercept.method ? ' (' + (q.graph.intercept.method === 'direct' ? 'read at x = 0' : 'by substitution') + ')' : ''), { size: 9.5 });
      }
    }

    // model answer
    var model = report.modelAnswer;
    if (model && typeof model === 'object') {
      doc.heading('Model answer', 2);
      if (model.answers && Object.keys(model.answers).length) {
        doc.table([['Question', 'Model value']].concat(answerRows(model.answers, Object.keys(model.answers), answerLabels(paper))),
          { widths: [1.4, 4] });
      }
      var mt = tableRows(model.table);
      if (mt) {
        doc.heading('Model table', 3);
        doc.table(mt, { size: 9.5 });
      }
      if (model.graph && model.graph.readOffs && str(model.graph.readOffs.x1)) {
        var mro = model.graph.readOffs;
        doc.text('Model gradient triangle: (' + mro.x1 + ', ' + mro.y1 + ') to (' + mro.x2 + ', ' + mro.y2 + ')' +
          (model.graph.intercept && str(model.graph.intercept.value) ? '; y-intercept ' + model.graph.intercept.value : '') + '.', { size: 9.5 });
      }
      if (Array.isArray(model.notes) && model.notes.length) {
        doc.heading('How the model answer was obtained', 3);
        doc.list(model.notes.map(str));
      }
    }

    var cm = Array.isArray(report.commonMistakes) ? report.commonMistakes : [];
    if (cm.length) {
      doc.heading('Common mistakes', 2);
      doc.list(cm.map(str));
    }
    return doc;
  }

  VL.export = {
    tableToCSV: tableToCSV,
    download: download,
    downloadCanvasPNG: downloadCanvasPNG,
    pdf: pdf,
    reportPDF: reportPDF,
    // additive helpers (also used by tests)
    buildReport: buildReport,
    transliterate: transliterate,
    toWinAnsi: toWinAnsi,
    pdfString: pdfString,
    textWidth: textWidth,
    wrapText: wrapText,
    base64ToBytes: base64ToBytes,
    dataURLToBytes: dataURLToBytes,
    csvField: csvField,
    PAGE: { width: PAGE_W, height: PAGE_H, margins: { left: MARGIN_L, right: MARGIN_R, top: MARGIN_T, bottom: MARGIN_B } }
  };
})(globalThis.VLab = globalThis.VLab || {});
