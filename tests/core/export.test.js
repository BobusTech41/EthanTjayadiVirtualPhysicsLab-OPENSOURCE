/* Tests for core/export.js (VL.export): CSV, transliteration, and the PDF 1.4 writer (pure parts, run in Node). */
(function () {
  'use strict';
  var VL = globalThis.VLab;
  var E = VL.export;

  /** Bytes → latin1 string (one char per byte), so the PDF structure can be inspected with regexes. */
  function latin1(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + 8192));
    return s;
  }

  /** Check the xref table: every in-use entry must point at 'N 0 obj'; startxref must point at 'xref'. */
  function checkXref(bytes) {
    var s = latin1(bytes);
    var m = /startxref\n(\d+)\n%%EOF$/.exec(s);
    assert.ok(m, 'trailer ends with startxref <offset> %%EOF');
    var xrefAt = Number(m[1]);
    assert.equal(s.substr(xrefAt, 5), 'xref\n', 'startxref offset points at the xref keyword');
    var head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefAt));
    assert.ok(head, 'xref subsection header');
    var size = Number(head[1]);
    var entriesAt = xrefAt + head[0].length;
    assert.equal(s.substr(entriesAt, 20), '0000000000 65535 f \n', 'free entry 0 is exactly 20 bytes');
    for (var n = 1; n < size; n++) {
      var entry = s.substr(entriesAt + 20 * n, 20);
      var em = /^(\d{10}) 00000 n \n$/.exec(entry);
      assert.ok(em, 'xref entry ' + n + ' is 20 bytes: ' + JSON.stringify(entry));
      var off = Number(em[1]);
      assert.equal(s.substr(off, String(n).length + 6), n + ' 0 obj', 'xref offset of object ' + n);
    }
    var trailer = /trailer\n<< \/Size (\d+) \/Root 1 0 R/.exec(s);
    assert.ok(trailer, 'trailer dictionary');
    assert.equal(Number(trailer[1]), size, '/Size equals the number of xref entries');
    return { size: size, text: s };
  }

  /** Every stream's /Length matches the bytes between 'stream\n' and '\nendstream'. */
  function checkStreams(s) {
    var re = /\/Length (\d+)[^>]*>>\nstream\n/g, m, count = 0;
    while ((m = re.exec(s)) !== null) {
      var start = m.index + m[0].length;
      var len = Number(m[1]);
      assert.equal(s.substr(start + len, 10), '\nendstream', 'stream length is byte accurate');
      count++;
    }
    return count;
  }

  function fakeJpeg() {
    // SOI ... EOI: not a decodable picture, but the writer only copies the bytes
    return { jpeg: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x28, 0x29, 0x5C, 0xFF, 0xD9]), width: 40, height: 30 };
  }

  /* ---------------------------------------------------------------- CSV */

  test('export: tableToCSV writes a BOM, headings first, CRLF lines', function () {
    var t = {
      columns: [{ id: 'c1', heading: 'L / cm' }, { id: 'c2', heading: 'T² / s²' }],
      rows: [{ id: 'r1', cells: { c1: '50.0', c2: '2.03' } }, { id: 'r2', cells: { c1: '60.0', c2: '' } }],
      nextId: 3
    };
    var csv = E.tableToCSV(t);
    assert.equal(csv.charCodeAt(0), 0xFEFF, 'UTF-8 byte-order mark first');
    assert.equal(csv.slice(1), 'L / cm,T² / s²\r\n50.0,2.03\r\n60.0,\r\n');
  });

  test('export: tableToCSV quotes per RFC 4180 and keeps strings exactly', function () {
    var t = {
      columns: [{ id: 'a', heading: 'note, with comma' }, { id: 'b', heading: 'say "hi"' }, { id: 'c', heading: 'plain' }],
      rows: [
        { id: 'r1', cells: { a: 'line1\nline2', b: '0.50', c: ' 12' } },
        { id: 'r2', cells: {} },
        { id: 'r3', cells: { a: '-0.050', b: '1.2×10⁻³', c: 'x\r\ny' } },
        { id: 'r4', cells: {} },
        { id: 'r5', cells: { a: '   ' } }
      ]
    };
    var csv = E.tableToCSV(t).slice(1);
    var expected = '"note, with comma","say ""hi""",plain\r\n' +
      '"line1\nline2",0.50," 12"\r\n' +
      ',,\r\n' +                                  // blank row in the middle kept (row numbers match the table)
      '-0.050,1.2×10⁻³,"x\r\ny"\r\n';            // trailing blank / white-space-only rows dropped
    assert.equal(csv, expected);
    assert.equal(E.csvField('0.50'), '0.50', 'trailing zero kept');
    assert.equal(E.tableToCSV({ columns: [], rows: [] }).slice(1), '\r\n', 'empty table');
  });

  /* ---------------------------------------------------------------- transliteration */

  test('export: transliterate characters outside WinAnsi', function () {
    var T = E.transliterate;
    assert.equal(T('R / Ω'), 'R / ohm');
    assert.equal(T('ρ / Ω m'), 'rho / ohm m');
    assert.equal(T('2.2 kΩ'), '2.2 kohm');
    assert.equal(T('θ / °C'), 'theta / °C', '° is in WinAnsi');
    assert.equal(T('g = 4π²/a'), 'g = 4pi²/a', '² is in WinAnsi');
    assert.equal(T('λ / nm'), 'lambda / nm');
    assert.equal(T('Δy/Δx'), 'delta y/delta x');
    assert.equal(T('ΔT'), 'delta T');
    assert.equal(T('√(L/g)'), 'sqrt(L/g)');
    assert.equal(T('√L'), 'sqrt L');
    assert.equal(T('x ≥ 5 and y ≤ 2'), 'x >= 5 and y <= 2');
    assert.equal(T('9.81 m s⁻²'), '9.81 m s^-2', 'a run with ⁻ becomes ^-2');
    assert.equal(T('s² m⁻¹'), 's² m^-1');
    assert.equal(T('1.2 × 10⁻³'), '1.2 × 10^-3');
    assert.equal(T('10⁴'), '10^4');
    assert.equal(T('cm³'), 'cm³');
    assert.equal(T('t₁ and t₂'), 't1 and t2');
    assert.equal(T('± 0.5 µm'), '± 0.5 µm');
    assert.equal(T('μ'), 'µ', 'Greek mu becomes the micro sign');
    assert.equal(T('−3.2'), '-3.2', 'unicode minus');
    assert.equal(T('✓ good ✗ bad'), '[OK] good [X] bad');
    assert.equal(T('café – “quoted” — ok…'), 'café – “quoted” — ok…', 'WinAnsi punctuation kept');
    assert.equal(T('t̄'), 't', 'combining bar dropped');
    assert.equal(T('ā'), 'a', 'accent outside Latin-1 stripped');
    assert.equal(T('😀x'), '?x', 'astral characters become ?');
    // every output character must have a WinAnsi byte
    var all = T('ΩθπλΔ√≥≤⁻¹²³⁴±°µ×·αβγδεζηικνξοσςτυφχψω∞∝→✓✗⚠');
    E.toWinAnsi(all).forEach(function (b) { assert.ok(b !== 63 || all.indexOf('?') >= 0, 'no unknown bytes'); });
  });

  test('export: WinAnsi bytes and PDF string escaping', function () {
    assert.deepEqual(E.toWinAnsi('A±°²'), [65, 0xB1, 0xB0, 0xB2]);
    assert.deepEqual(E.toWinAnsi('–—•…€'), [0x96, 0x97, 0x95, 0x85, 0x80]);
    assert.deepEqual(E.toWinAnsi('Ω'), [111, 104, 109], 'transliterated before encoding');
    assert.equal(E.pdfString(E.toWinAnsi('(a\\b)')), '(\\(a\\\\b\\))', 'parentheses and backslash escaped');
    assert.equal(E.pdfString(E.toWinAnsi('5 °C')), '(5 \\260C)', 'bytes above 126 written as octal');
    assert.equal(E.pdfString([10, 13]), '(\\012\\015)');
  });

  /* ---------------------------------------------------------------- metrics and wrapping */

  test('export: Helvetica widths and word wrapping', function () {
    assert.close(E.textWidth('Hello', 10), 22.78, 1e-9, 'Helvetica');
    assert.close(E.textWidth('Hello', 10, true), (722 + 556 + 278 + 278 + 611) / 100, 1e-9, 'Helvetica-Bold');
    var text = 'The period of a simple pendulum depends on the length of the string and on the acceleration of free fall. ';
    var long = new Array(8).join(text);
    var lines = E.wrapText(long, 10.5, false, 200);
    assert.ok(lines.length > 5, 'wrapped into several lines');
    lines.forEach(function (ln) { assert.ok(E.textWidth(ln, 10.5) <= 200 + 1e-6, 'line fits: ' + ln); });
    assert.equal(lines.join(' ').replace(/\s+/g, ' ').trim(), long.replace(/\s+/g, ' ').trim(), 'no words lost');
    var broken = E.wrapText(new Array(80).join('x'), 10, false, 50);
    assert.ok(broken.length > 1, 'an over-long word is broken');
    broken.forEach(function (ln) { assert.ok(E.textWidth(ln, 10) <= 50 + 1e-6); });
    assert.deepEqual(E.wrapText('a\n\nb', 10, false, 100), ['a', '', 'b'], 'paragraph breaks kept');
  });

  /* ---------------------------------------------------------------- PDF structure */

  test('export: a PDF starts with %PDF-1.4, ends with %%EOF and has a byte-accurate xref', function () {
    var doc = E.pdf({ title: 'Test — report', date: '2026-10-10T12:00:00.000Z', footer: 'seed PEN-7K2Q-91C3' });
    doc.heading('Practical report: Simple pendulum (Ω, θ)', 1);
    doc.text('Paragraph with (parentheses) and a back\\slash, 5 °C, ±0.1 cm, T² / s², 9.81 m s⁻².');
    doc.list(['first point', 'second point']);
    doc.keyValue([['Seed', 'PEN-7K2Q-91C3'], ['Mode', 'Practice']]);
    doc.table([['L / cm', 'T / s', 'Comment'], ['50.0', '1.42', 'fine'], ['60.0', '1.56', 'a long comment that needs to wrap onto several lines inside its cell of the table']]);
    doc.image(fakeJpeg(), 120);
    doc.pageBreak();
    doc.text('Second page');
    var bytes = doc.toBytes();
    assert.ok(bytes instanceof Uint8Array, 'bytes');
    var s = latin1(bytes);
    assert.equal(s.slice(0, 8), '%PDF-1.4', 'header');
    assert.ok(bytes[10] > 127 && bytes[11] > 127, 'binary comment on line 2');
    assert.equal(s.slice(-5), '%%EOF', 'ends with %%EOF');
    var x = checkXref(bytes);
    assert.equal(x.size, 6 + 1 + 2 * 2, 'catalog, pages, 2 fonts, info, 1 image, 2 pages × (page + content)');
    assert.equal(checkStreams(s), 3, 'one image stream and two content streams');
    assert.match(s, /\/Type \/Pages \/Kids \[7 0 R 9 0 R\] \/Count 2/);
    assert.match(s, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
    assert.match(s, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
    assert.match(s, /\/MediaBox \[0 0 595 842\]/);
    assert.match(s, /\/Subtype \/Image \/Width 40 \/Height 30 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode \/Length 16/);
    assert.match(s, /\/XObject << \/Im1 6 0 R >>/);
    assert.match(s, /\/Im1 Do/);
    assert.match(s, /\(Practical report: Simple pendulum \\\(ohm, theta\\\)\) Tj/, 'escaped, transliterated heading');
    assert.match(s, /back\\\\slash/, 'backslash escaped');
    assert.match(s, /9\.81 m s\^-2/, 'superscript run transliterated');
    assert.match(s, /\/CreationDate \(D:20261010120000Z\)/);
    assert.match(s, /\/Title \(Test - report\)/, 'info strings ASCII-safe');
    assert.match(s, /\(seed PEN-7K2Q-91C3   Page 2 of 2\) Tj/, 'footer with page numbers');
    // content streams are 7-bit clean (only the header comment and the JPEG hold high bytes)
    var content = s.split('stream\n').slice(1).map(function (c) { return c.split('\nendstream')[0]; })
      .filter(function (c) { return c.indexOf('BT ') >= 0; });
    assert.equal(content.length, 2);
    content.forEach(function (c) { assert.ok(!/[^\x0a\x20-\x7e]/.test(c), 'ASCII-only content stream'); });
  });

  test('export: an empty document is still a valid one-page PDF', function () {
    var doc = E.pdf();
    assert.equal(doc.pageCount(), 1);
    var bytes = doc.toBytes();
    var x = checkXref(bytes);
    assert.equal(x.size, 6 + 2, 'one page');
    assert.match(x.text, /\/Count 1/);
  });

  test('export: long text flows onto the expected number of pages', function () {
    var doc = E.pdf();
    var para = 'Each limitation must be specific to the experiment and each improvement must say exactly what to change. ';
    var text = new Array(400).join(para);
    var lines = E.wrapText(text, 10.5, false, E.PAGE.width - E.PAGE.margins.left - E.PAGE.margins.right);
    var lead = 10.5 * 1.3;
    var perPage = Math.floor((E.PAGE.height - E.PAGE.margins.top - E.PAGE.margins.bottom) / lead + 1e-9);
    doc.text(text);
    var expected = Math.ceil(lines.length / perPage);
    assert.ok(expected >= 3, 'test text spans several pages (' + expected + ')');
    assert.equal(doc.pageCount(), expected, 'page breaks: ' + lines.length + ' lines, ' + perPage + ' per page');
    var bytes = doc.toBytes();
    var x = checkXref(bytes);
    assert.equal((x.text.match(/\/Type \/Page /g) || []).length, expected, 'page objects');
    assert.match(x.text, new RegExp('/Count ' + expected + ' '));
    assert.equal(checkStreams(x.text), expected);
  });

  test('export: long tables break across pages and repeat the header row', function () {
    var doc = E.pdf();
    var rows = [['n', 'L / cm', 'T / s']];
    for (var i = 1; i <= 120; i++) rows.push([String(i), (20 + i * 0.5).toFixed(1), (1 + i / 100).toFixed(2)]);
    doc.table(rows);
    assert.ok(doc.pageCount() >= 3, 'several pages');
    var s = latin1(doc.toBytes());
    assert.equal((s.match(/\(L \/ cm\) Tj/g) || []).length, doc.pageCount(), 'header row on every page');
    checkXref(doc.toBytes());
    // a pathological cell taller than a page is cut short instead of running off the page
    var doc2 = E.pdf();
    doc2.table([['A', 'B'], ['x', new Array(3000).join('word ')]]);
    assert.equal(doc2.pageCount(), 1, 'cut to one page');
    var shown2 = tjText(latin1(doc2.toBytes()));
    assert.match(shown2, /\[answer continues \\227 \d+ more characters not shown; see the report in the app\]/, 'the cut is stated');
    assert.ok(!/\(\\205\) Tj/.test(latin1(doc2.toBytes())), 'no bare ellipsis');
  });

  /** The text of every 'Tj' string in a PDF (page content), joined with spaces (wrapped lines rejoined). */
  function tjText(s) {
    var out = [], re = /\(((?:[^()\\]|\\.)*)\) Tj/g, m;
    while ((m = re.exec(s)) !== null) out.push(m[1]);
    return out.join(' ');
  }

  test('export: a list answer is one row per item, and a very long item is cut with a note (twopoint report)', function () {
    if (!VL.getExperiment || !VL.getExperiment('pendulum')) return;
    var long = '';
    while (long.length < 15800) long += 'The string slips a little in the split cork every time the bob is released. ';
    long = long.slice(0, 15800);
    var question = { qid: 'q1', expId: 'pendulum', variantId: 'twopoint', seed: 'PEN-7K2Q-91C3', table: null, graph: null,
      answers: { limitations: [long, 'Only two lengths were used.', 'The amplitude was not kept constant.', 'The bob moved in an ellipse.'] } };
    var report = { expId: 'pendulum', variantId: 'twopoint', seed: 'PEN-7K2Q-91C3', total: 3, max: 20, points: [], parts: [],
      markedAt: '2026-10-10T09:30:00.000Z' };
    var doc = E.buildReport({ session: { mode: 'practice' }, question: question, report: report, graphCanvas: null });
    var bytes = doc.toBytes();
    var x = checkXref(bytes);
    checkStreams(x.text);
    var shown = tjText(x.text);
    ['Only two lengths were used.', 'The amplitude was not kept constant.', 'The bob moved in an ellipse.'].forEach(function (t) {
      assert.ok(shown.indexOf(t) >= 0, 'short item shown: ' + t);
    });
    assert.match(shown, /\\\(h\\\)\\\(i\\\) limitation 1/, 'labelled per item');
    assert.match(shown, /\\\(h\\\)\\\(i\\\) limitation 4/);
    var m = /\[answer continues \\227 (\d+) more characters not shown; see the report in the app\]/.exec(shown);
    assert.ok(m, 'the long item says how much is not shown');
    assert.ok(Number(m[1]) > 5000 && Number(m[1]) < 15800, 'a sensible count: ' + m[1]);
  });

  test('export: images from a canvas-like object and from data URLs', function () {
    var jpeg = fakeJpeg().jpeg;
    var b64 = globalThis.btoa(String.fromCharCode.apply(null, Array.prototype.slice.call(jpeg)));
    var canvasLike = {
      width: 300, height: 200,
      toDataURL: function (type, q) { this.args = [type, q]; return 'data:image/jpeg;base64,' + b64; }
    };
    var doc = E.pdf();
    doc.image(canvasLike, 150);
    assert.deepEqual(canvasLike.args, ['image/jpeg', 0.92], 'JPEG at quality 0.92');
    var s = latin1(doc.toBytes());
    assert.match(s, /\/Width 300 \/Height 200 /);
    var at = s.indexOf('/Filter /DCTDecode /Length 16 >>\nstream\n');
    assert.ok(at > 0);
    var start = s.indexOf('stream\n', at) + 7;
    assert.deepEqual(Array.prototype.slice.call(E.base64ToBytes(b64)), Array.prototype.slice.call(jpeg), 'base64 decoded to bytes');
    assert.equal(s.substr(start, 16), latin1(jpeg), 'JPEG bytes copied unchanged (binary safe)');
    // 150 mm wide = 425.2 pt, aspect 3:2
    assert.match(s, /q 425\.197 0 0 283\.465 50 [\d.]+ cm \/Im1 Do Q/);
    assert.throws(function () { E.pdf().image({ toDataURL: function () { return 'data:image/png;base64,AAAA'; }, width: 2, height: 2 }); },
      'non-JPEG output is refused');
    assert.deepEqual(Array.prototype.slice.call(E.dataURLToBytes('data:text/plain,a%20b')), [97, 32, 98]);
  });

  test('export: toBlob gives an application/pdf Blob', function () {
    if (typeof globalThis.Blob !== 'function') return;
    var blob = E.pdf().text('hello').toBlob();
    assert.equal(blob.type, 'application/pdf');
    assert.ok(blob.size > 300);
  });

  test('export: report PDF contains the marks, comments, answers, table and model answer', function () {
    var report = {
      expId: 'zzz-unknown', variantId: 'graph', seed: 'PEN-7K2Q-91C3', total: 13, max: 20,
      skills: { MMO: { got: 6, max: 8 }, PDO: { got: 5, max: 7 }, ACE: { got: 2, max: 5 } },
      parts: [{ part: 'a', label: '(a)', got: 1, max: 1 }, { part: 'd', label: '(d)', got: 5, max: 8 }],
      points: [
        { id: 'p1', part: 'a', skill: 'MMO', label: 'Diameter d', max: 1, awarded: 1, comment: '✓ d = 2.34 cm, in range.' },
        { id: 'p2', part: 'd', skill: 'PDO', label: 'Column headings', max: 1, awarded: 0, comment: '✗ Heading “T² (s)”: the unit of T² is s².' }
      ],
      modelAnswer: {
        table: { columns: [{ id: 'c1', heading: 'L / cm' }, { id: 'c2', heading: 'T² / s²' }], rows: [{ id: 'r1', cells: { c1: '20.0', c2: '0.823' } }] },
        answers: { g: '9.79 m s⁻²' },
        notes: ['g = 4π² / gradient.']
      },
      commonMistakes: ['Timing only one oscillation.'],
      markedAt: '2026-10-10T09:30:00.000Z'
    };
    var question = {
      qid: 'q1', expId: 'zzz-unknown', variantId: 'graph', seed: 'PEN-7K2Q-91C3',
      table: { columns: [{ id: 'c1', heading: 'L / cm' }, { id: 'c2', heading: 'T² (s)' }], rows: [{ id: 'r1', cells: { c1: '50.0', c2: '2.03' } }, { id: 'r2', cells: {} }] },
      graph: { points: [], readOffs: { x1: '20.0', y1: '0.85', x2: '90.0', y2: '3.65' }, intercept: { method: 'direct', value: '0.05' } },
      answers: { g: '9.8 m s⁻²', lims: ['Two readings are not enough.', ''], empty: '' },
      report: report
    };
    var doc = E.buildReport({ session: { mode: 'practice', title: 'Pendulum practice' }, question: question, report: report, graphCanvas: null });
    var bytes = doc.toBytes();
    var x = checkXref(bytes);
    var s = x.text;
    assert.match(s, /\(Practical report: zzz-unknown\) Tj/);
    assert.match(s, /\(Total: 13 \/ 20 \\\(65 %\\\)\) Tj/);
    assert.match(s, /MMO \\227 Manipulation, measurement and observation/, 'skill rows (em dash as octal byte)');
    assert.match(s, /\(\[OK\] 1 \/ 1\) Tj/, 'awarded marked with words, not colour');
    assert.match(s, /\(\[X\] 0 \/ 1\) Tj/);
    assert.match(s, /Heading \\223T\\262 \\\(s\\\)\\224/, 'comment without its leading cross, transliterated quotes kept');
    assert.match(s, /\(9\.8 m s\^-2\) Tj/, 'student answer');
    assert.match(s, /\(lim 1\) Tj/, 'list answer: one row per item, numbered in the label');
    assert.match(s, /\(Two readings are not enough\.\) Tj/, 'list item text');
    assert.ok(!/\(lim 2\) Tj/.test(s), 'blank list items left out');
    assert.ok(!/\(empty\) Tj/.test(s), 'blank answers left out');
    assert.match(s, /\(T\\262 \\\(s\\\)\) Tj/, 'student heading exactly as typed');
    assert.match(s, /\(No graph was drawn\.\) Tj/);
    assert.match(s, /\\\(20\.0, 0\.85\\\) and \\\(90\.0, 3\.65\\\)/, 'read-offs');
    assert.match(s, /\(0\.823\) Tj/, 'model table');
    assert.match(s, /\(9\.79 m s\^-2\) Tj/, 'model value');
    assert.match(s, /g = 4pi\\262 \/ gradient\./, 'model notes transliterated');
    assert.match(s, /\(Timing only one oscillation\.\) Tj/, 'common mistakes');
    if (typeof globalThis.Blob === 'function') {
      var blob = E.reportPDF({ session: {}, question: question, report: report });
      assert.equal(blob.type, 'application/pdf');
    }
  });

  test('export: download helpers refuse to run without a browser', function () {
    if (globalThis.document) return;
    assert.throws(function () { E.download('a.csv', 'x', 'text/csv'); });
  });
})();
