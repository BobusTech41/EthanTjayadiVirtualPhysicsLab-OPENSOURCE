/**
 * Keyword / concept matcher for written answers (docs/ARCHITECTURE.md §3.10).
 *
 * Written answers in Paper 3 (limitations, improvements, explanations, s.f. justifications, conclusions) are marked
 * the way an examiner reads them: each mark point is a list of acceptable CONCEPTS, and each concept is a set of
 * synonym groups that must all be present. Generic answers ("use more accurate equipment", "human error",
 * a bare "repeat the readings") earn nothing, exactly as in real mark schemes.
 *
 *   Concept = { all: [ group, ... ], none: [ group, ... ] }
 *     group = [ alternative, ... ]                  // any one alternative matching satisfies the group
 *     alternative = 'plain phrase'                  // matched as whole words after normalisation and stemming
 *                 | '/regular expression/flags'     // tested against the normalised text BEFORE and AFTER
 *                                                   // stemming, so '/reaction ?time/' also matches "reaction times"
 *                 | RegExp
 *   Short forms accepted wherever a Concept is expected: a string or RegExp (one alternative) or an array of
 *   groups (= { all: array }).
 *
 * Public API (VL.textmatch):
 *   normalize(text) -> string                       stemmed, normalised text
 *   plain(text) -> string                           normalised text without stemming (what regexes also see)
 *   clauses(text) -> string[]                       plain() clauses split at sentence / clause boundaries
 *   stem(word) -> string
 *   matches(text, concept) -> boolean
 *   matchesAny(text, concepts) -> boolean           any of several concepts
 *   splitItems(textOrArray) -> string[]
 *   GENERIC_REJECTS -> [{ id, concept, reason }]
 *   genericReject(text) -> { id, reason } | null
 *   markWritten(text, specs, { max, generic = true, rejects = [] }) -> { awarded, hits, misses, rejected }
 *   markLimitationsImprovements(limItems, impItems, bank, { maxEach = 4 }) ->
 *       { limitations: Column, improvements: Column }
 *       Column = { awarded, hits: [{ id, label, text }], misses: [{ id, label }], rejected: [{ text, reason }],
 *                  items: [{ text, id: string|null, reason: string|null }] }   // items: additive, per answer line
 */
(function (VL) {
  'use strict';

  /* ------------------------------------------------------------------ normalisation */

  /** Words ending in -ing that are not verb forms (left alone by the stemmer). */
  var ING_KEEP = {
    thing: 1, string: 1, bring: 1, spring: 1, swing: 1, sing: 1, king: 1, ring: 1, wing: 1, during: 1,
    nothing: 1, something: 1, anything: 1, everything: 1, ceiling: 1, ping: 1
  };

  /**
   * Very small suffix-stripping stemmer. It only has to be CONSISTENT (text and phrases are stemmed the same
   * way), not linguistically perfect: readings → reading → read, timed → tim, time → tim, uncertainties →
   * uncertainty, stopped → stop.
   * @param {string} w lower-case word
   * @returns {string}
   */
  function stem(w) {
    if (!/^[a-z]+$/.test(w) || w.length <= 2) return w;
    // plurals
    if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/sses$/.test(w)) w = w.slice(0, -2);
    else if (/[^siu]s$/.test(w)) w = w.slice(0, -1);
    // -ing / -ed
    var cut = null;
    if (/ing$/.test(w) && !ING_KEEP[w] && w.length - 3 >= 2) cut = w.slice(0, -3);
    else if (/ed$/.test(w) && w.length - 2 >= 2 && !/eed$/.test(w)) cut = w.slice(0, -2);
    if (cut !== null) {
      w = cut;
      // stopp → stop, slipp → slip (but keep fall, pass, buzz)
      if (/([b-df-hj-kmnp-rtv-y])\1$/.test(w)) w = w.slice(0, -1);
    }
    // final e: time → tim (so that time, times, timed, timing agree)
    if (w.length >= 3 && /e$/.test(w) && !/ee$/.test(w)) w = w.slice(0, -1);
    return w;
  }

  /**
   * Join the s.f. / d.p. abbreviations so that their full stops never end a sentence or clause, also straight
   * after a number: 's.f.', 's. f.', '3s.f.' → 'sf' ('3sf'); 'd.p.', 'd. p.' → 'dp'; 'sig. fig.', 'sig. figs.' →
   * 'sig fig(s)'. Case-insensitive (the joined form is lower case).
   * @param {string} s
   * @returns {string}
   */
  function joinAbbreviations(s) {
    return s
      .replace(/(^|[^a-z])sig\.\s?(fig(?:ure)?s?)\.?(?![a-z])/gi, function (m, pre, f) { return pre + 'sig ' + f.toLowerCase(); })
      .replace(/(^|[^a-z])(?:s\.f\.?|s\. f\.)(s?)(?![a-z])/gi, function (m, pre, pl) { return pre + 'sf' + pl.toLowerCase(); })
      .replace(/(^|[^a-z])(?:d\.p\.?|d\. p\.)(s?)(?![a-z])/gi, function (m, pre, pl) { return pre + 'dp' + pl.toLowerCase(); });
  }

  /**
   * Normalise text WITHOUT stemming: lower case, unified unicode (quotes, dashes, minus signs, super/subscripts,
   * accents), contractions expanded (doesn't → does not), abbreviations joined (s.f. → sf, d.p. → dp, also '3s.f.'),
   * '&' → 'and', '%' separated from numbers, other punctuation removed, white space collapsed.
   * @param {string} text
   * @returns {string}
   */
  function plain(text) {
    var s = String(text === undefined || text === null ? '' : text);
    if (typeof s.normalize === 'function') s = s.normalize('NFKD'); // ² → 2, ₁ → 1, ﬁ → fi, é → e + accent
    s = s.replace(/[\u0300-\u036f]/g, '');                          // drop accents / combining bars (t̄ → t)
    s = s.toLowerCase();
    s = s.replace(/[\u2018\u2019\u201b\u2032`\u00b4]/g, "'").replace(/[\u201c\u201d\u201e\u2033]/g, '"');
    s = s.replace(/[\u2010-\u2015\u2212]/g, '-');
    s = s.replace(/\u00d7/g, ' x ').replace(/&/g, ' and ').replace(/\^/g, '');
    s = s.replace(/[\u00b5\u03bc]/g, 'u');
    // contractions and negation
    s = s.replace(/\bcan'?t\b/g, 'can not').replace(/\bwon'?t\b/g, 'will not').replace(/\bcannot\b/g, 'can not')
      .replace(/n't\b/g, ' not')
      .replace(/\b(do|does|did|is|are|was|were|has|have|had|could|would|should)nt\b/g, '$1 not');
    // abbreviations such as s.f., d.p. (also '3s.f.'), sig. fig., e.g., i.e.
    s = joinAbbreviations(s);
    s = s.replace(/\b([a-z])\.([a-z])\.?(?![a-z])/g, '$1$2');
    s = s.replace(/\bper ?cent\b/g, '%').replace(/(\d)\s*%/g, '$1 %');
    s = s.replace(/(\d)\s*-\s*(\d)/g, '$1 to $2');                   // 10-20 → 10 to 20
    s = s.replace(/'/g, '');                                          // student's → students
    s = s.replace(/(^|[^\d])\.(\d)/g, '$1 0.$2');                   // .5 → 0.5
    s = s.replace(/[^a-z0-9.%\s\-\u0370-\u03ff]/g, ' ');
    s = s.replace(/\.(?!\d)|(^|[^\d])\./g, function (m, pre) { return (pre || '') + ' '; });
    s = s.replace(/-(?!\d)/g, ' ').replace(/(\S)-(\d)/g, '$1 $2');
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * Normalise and stem text for phrase matching.
   * @param {string} text
   * @returns {string}
   */
  function normalize(text) {
    var p = plain(text);
    return p ? p.split(' ').map(stem).join(' ') : '';
  }

  /**
   * Split text into clauses (sentences, comma/semicolon parts and parts joined by "but", "so", "because" ...),
   * each normalised with plain(). Decimal points and abbreviations such as s.f. do not split.
   * @param {string|string[]} text
   * @returns {string[]}
   */
  function clauses(text) {
    var s = Array.isArray(text) ? text.join('\n') : String(text === undefined || text === null ? '' : text);
    s = joinAbbreviations(s);
    s = s.replace(/\b([a-z])\.([a-z])\.?(?![a-z])/gi, '$1$2');
    var out = [];
    s.split(/(?:[.;!?:](?!\d)|,(?!\d)|\r?\n)+/).forEach(function (part) {
      plain(part).split(/\b(?:but|however|so|therefore|hence|thus|whereas|although|though|because|since|which means|meaning that)\b/)
        .forEach(function (c) {
          c = c.trim();
          if (c) out.push(c);
        });
    });
    return out;
  }

  /** Prepared text: both forms, computed once per answer. */
  function prepare(text) {
    if (text && typeof text === 'object' && text.__prepared) return text;
    var p = plain(Array.isArray(text) ? text.join('\n') : text);
    return {
      __prepared: true,
      plain: p,
      stem: p ? p.split(' ').map(stem).join(' ') : '',
      padded: null
    };
  }

  /* ------------------------------------------------------------------ concept matching */

  var regexCache = {};
  var phraseCache = {};

  /** Compile '/body/flags' to a RegExp (always case-insensitive), or null if the string is not a regex. */
  function toRegex(alt) {
    if (alt instanceof RegExp) return alt;
    if (typeof alt !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(regexCache, alt)) return regexCache[alt];
    var m = /^\/(.+)\/([a-z]*)$/.exec(alt);
    var re = null;
    if (m) {
      var flags = m[2].replace(/[gy]/g, '');
      if (flags.indexOf('i') < 0) flags += 'i';
      try { re = new RegExp(m[1], flags); } catch (e) { re = null; }
    }
    regexCache[alt] = re;
    return re;
  }

  /** Does one alternative match the prepared text? */
  function altMatches(prep, alt) {
    var re = toRegex(alt);
    if (re) {
      re.lastIndex = 0;
      if (re.test(prep.plain)) return true;
      re.lastIndex = 0;
      return re.test(prep.stem);
    }
    if (typeof alt !== 'string') return false;
    var phrase = phraseCache[alt];
    if (phrase === undefined) phrase = phraseCache[alt] = normalize(alt);
    if (!phrase) return false;
    if (prep.padded === null) prep.padded = ' ' + prep.stem + ' ';
    return prep.padded.indexOf(' ' + phrase + ' ') !== -1;
  }

  function asGroup(g) {
    return Array.isArray(g) ? g : [g];
  }

  /** Coerce the accepted short forms to { all, none }. */
  function asConcept(c) {
    if (c === null || c === undefined) return { all: [], none: [] };
    if (typeof c === 'string' || c instanceof RegExp) return { all: [[c]], none: [] };
    if (Array.isArray(c)) return { all: c, none: [] };
    return { all: c.all || [], none: c.none || [] };
  }

  function groupMatches(prep, group) {
    return asGroup(group).some(function (alt) { return altMatches(prep, alt); });
  }

  /**
   * Does the text express the concept? Every `all` group must match and no `none` group may match.
   * A concept with no `all` groups never matches.
   * @param {string|string[]} text
   * @param {object|string|Array} concept
   * @returns {boolean}
   */
  function matches(text, concept) {
    var prep = prepare(text);
    var c = asConcept(concept);
    if (!prep.stem || !c.all.length) return false;
    for (var i = 0; i < c.all.length; i++) if (!groupMatches(prep, c.all[i])) return false;
    for (var j = 0; j < c.none.length; j++) if (groupMatches(prep, c.none[j])) return false;
    return true;
  }

  /** True when any of the concepts matches. */
  function matchesAny(text, concepts) {
    var prep = prepare(text);
    return (concepts || []).some(function (c) { return matches(prep, c); });
  }

  /* ------------------------------------------------------------------ splitting answers into items */

  // A list marker at the start of a line: 1.  1)  (1)  (i)  ii)  (a)  b)  -  *  •  (never the start of a number)
  var MARKER_SRC = '^\\s*(?:\\(?\\d{1,2}\\s*[.):](?!\\d)|\\(?[ivx]{1,4}\\)|\\([a-h]\\)|[a-h]\\)|' +
    '[-*\\u2022\\u00b7\\u25aa\\u25e6\\u2023\\u2013\\u2014>](?![\\d.]))';
  var MARKER_TEST = new RegExp(MARKER_SRC, 'i');
  var MARKER_RE = new RegExp(MARKER_SRC + '\\s*', 'i');

  function stripMarker(line) {
    return line.replace(MARKER_RE, '').trim();
  }

  /** Split "1. aaa 2. bbb 3. ccc" written on one line (numbers must run 1, 2, 3 ...). */
  function splitInline(line) {
    var re = /(^|\s)\(?(\d{1,2})[.)]\s/g, m, cuts = [], expect = 1;
    while ((m = re.exec(line)) !== null) {
      if (parseInt(m[2], 10) === expect) {
        cuts.push(m.index + m[1].length);
        expect += 1;
      }
    }
    if (cuts.length < 2) return [line];
    var out = [];
    if (line.slice(0, cuts[0]).trim()) out.push(line.slice(0, cuts[0]));
    for (var i = 0; i < cuts.length; i++) out.push(line.slice(cuts[i], i + 1 < cuts.length ? cuts[i + 1] : line.length));
    return out;
  }

  /**
   * Split one string into items. Lines starting with a number, letter or bullet marker start a new item and
   * unmarked lines continue the previous one; when no line has a marker, each non-empty line is an item
   * (or, with linesAreItems = false, the whole string is one item).
   */
  function splitString(str, linesAreItems) {
    var lines = String(str).replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return l.trim() !== ''; });
    var expanded = [];
    lines.forEach(function (l) { splitInline(l).forEach(function (x) { expanded.push(x); }); });
    var anyMarker = expanded.some(function (l) { return MARKER_TEST.test(l); });
    var items = [];
    if (anyMarker) {
      expanded.forEach(function (l) {
        if (MARKER_TEST.test(l) || !items.length) items.push(stripMarker(l));
        else items[items.length - 1] += ' ' + l.trim();
      });
    } else if (linesAreItems) {
      items = expanded.map(function (l) { return l.trim(); });
    } else {
      items = [expanded.join(' ').trim()];
    }
    return items.filter(function (s) { return s !== ''; });
  }

  /**
   * Split an answer into separate items (numbered lines, bullet lines, or array entries).
   * Array entries (one per answer box) are kept as one item each unless the entry itself is a numbered list.
   * @param {string|string[]} textOrArray
   * @returns {string[]}
   */
  function splitItems(textOrArray) {
    if (textOrArray === null || textOrArray === undefined) return [];
    if (Array.isArray(textOrArray)) {
      var out = [];
      textOrArray.forEach(function (entry) {
        if (entry === null || entry === undefined) return;
        splitString(String(entry), false).forEach(function (s) { out.push(s); });
      });
      return out;
    }
    return splitString(String(textOrArray), true);
  }

  /* ------------------------------------------------------------------ generic answers */

  /**
   * Answers that real mark schemes never credit on their own. Checked only AFTER the experiment's own mark
   * points, so a specific answer that happens to contain one of these words can still be credited.
   */
  var GENERIC_REJECTS = [
    {
      id: 'accurate-equipment',
      concept: [['/\\b(more|better|higher|very|most|greater)\\s+(accurate|precise|precision|sensitive|reliable|quality|advanced|accuracy)\\b/',
        '/\\b(better|good|proper|modern|new|improved|high[ -]?tech|accurate|precise|sensitive)\\s+(equipment|apparatus|instruments?|tools?|devices?|stop ?watch|stop ?clock|timer|ruler|rule)\\b/']],
      reason: '“More accurate” or “better” equipment is too vague: name the instrument or technique and say what it improves.'
    },
    {
      id: 'repeat',
      concept: [['/\\brepeat/', '/\\bredo\\b/', '/\\bagain\\b/', '/\\baverag/', '/\\bmean\\b/', '/\\bmore (times|trials|attempts)\\b/', '/\\bseveral times\\b/']],
      reason: 'Repeating the readings or taking an average is not credited on its own: say what extra readings to take and what to do with them (e.g. more values and a graph).'
    },
    {
      id: 'human-error',
      concept: [['/\\bhuman (error|mistake)/', '/\\b(error|mistake)s? (made )?by (the |a )?(human|student|experimenter|observer|person)/', '/\\bpersonal error/']],
      reason: '“Human error” is not a valid limitation: describe the specific difficulty in taking the measurement.'
    },
    {
      id: 'parallax',
      concept: [['/parallax/']],
      reason: 'Parallax on its own is too vague: say which reading is difficult and why, or exactly how to avoid it.'
    },
    {
      id: 'computer',
      concept: [['/\\b(computer|data ?logg|software|apps?\\b|smart ?phone|phone\\b|robot|machine|automat)/']],
      reason: 'Name the sensor and what it would measure (e.g. a light gate connected to a timer), not just “a computer” or “a machine”.'
    },
    {
      id: 'careful',
      concept: [['/\\b(more|be|being|was not|were not|not) careful/', '/\\bcarefully\\b/', '/\\btake (more |greater )?care\\b/', '/\\bconcentrat/', '/\\bpay (more )?attention\\b/']],
      reason: '“Be more careful” is not a specific improvement.'
    },
    {
      id: 'reaction-time',
      concept: [['/\\breaction/', '/\\breflex/']],
      reason: 'Reaction time on its own is not credited: explain why it matters here (e.g. it is large compared with the time measured) or give a specific way to reduce its effect.'
    },
    {
      id: 'random-systematic',
      concept: [['/\\b(random|systematic) (error|uncertaint)/']],
      reason: 'Name the specific cause of the error rather than just “random” or “systematic error”.'
    },
    {
      id: 'faulty',
      concept: [['/\\b(faulty|broken|damaged|defective|uncalibrated|not calibrated|calibrat)/']],
      reason: 'Faulty or badly calibrated apparatus is not a limitation of the method.'
    }
  ];

  /**
   * First generic reject that the text matches.
   * @param {string} text
   * @param {Array} [extra] additional { id, concept, reason } entries checked first
   * @returns {{id:string, reason:string}|null}
   */
  function genericReject(text, extra) {
    var prep = prepare(text);
    var list = (extra || []).concat(GENERIC_REJECTS);
    for (var i = 0; i < list.length; i++) {
      if (matches(prep, list[i].concept)) return { id: list[i].id || 'generic', reason: list[i].reason };
    }
    return null;
  }

  /* ------------------------------------------------------------------ marking */

  function specMatches(prep, spec) {
    return !!spec && matchesAny(prep, spec.concepts || []);
  }

  /**
   * Mark a written answer against a list of mark points. Each spec is credited when any of its concepts
   * matches anywhere in the answer. Items (lines) that earn nothing and are generic are listed in `rejected`.
   * @param {string|string[]} text
   * @param {Array<{id:string, label:string, concepts:Array}>} specs
   * @param {{max?:number, generic?:boolean, rejects?:Array}} [opts]
   * @returns {{awarded:number, hits:Array<{id,label}>, misses:Array<{id,label}>, rejected:Array<{text,reason}>}}
   */
  function markWritten(text, specs, opts) {
    opts = opts || {};
    specs = specs || [];
    var max = opts.max === undefined ? specs.length : opts.max;
    var items = splitItems(text);
    var whole = prepare(items.join('\n'));
    var res = { awarded: 0, hits: [], misses: [], rejected: [] };
    specs.forEach(function (s) {
      (specMatches(whole, s) ? res.hits : res.misses).push({ id: s.id, label: s.label });
    });
    res.awarded = Math.max(0, Math.min(res.hits.length, max));
    if (opts.generic !== false) {
      items.forEach(function (it) {
        var prep = prepare(it);
        if (specs.some(function (s) { return specMatches(prep, s); })) return;
        var g = genericReject(prep, opts.rejects);
        if (g) res.rejected.push({ text: it, reason: g.reason });
      });
    }
    return res;
  }

  /**
   * Maximum bipartite matching (Kuhn): each item may credit at most one row and each row at most once.
   * Earlier items and earlier rows are preferred.
   * @param {boolean[][]} adj adj[i][j] = item i matches row j
   * @param {number} nRows
   * @returns {number[]} rowOfItem[i] (−1 = none)
   */
  function bipartite(adj, nRows) {
    var itemOfRow = [], rowOfItem = [];
    var i, j;
    for (j = 0; j < nRows; j++) itemOfRow[j] = -1;
    function tryItem(it, seen) {
      for (var r = 0; r < nRows; r++) {
        if (!adj[it][r] || seen[r]) continue;
        seen[r] = true;
        if (itemOfRow[r] === -1 || tryItem(itemOfRow[r], seen)) {
          itemOfRow[r] = it;
          return true;
        }
      }
      return false;
    }
    for (i = 0; i < adj.length; i++) tryItem(i, []);
    for (i = 0; i < adj.length; i++) rowOfItem[i] = -1;
    for (j = 0; j < nRows; j++) if (itemOfRow[j] >= 0) rowOfItem[itemOfRow[j]] = j;
    return rowOfItem;
  }

  /**
   * Mark one column (limitations or improvements) against the bank.
   * @param {string[]} items
   * @param {Array} bank
   * @param {'limitation'|'improvement'} side
   * @param {number} maxEach
   */
  function markColumn(items, bank, side, maxEach) {
    var rows = bank.map(function (b) { return b && b[side] ? b[side] : null; });
    var preps = items.map(prepare);
    var adj = preps.map(function (p) {
      return rows.map(function (r) { return !!r && specMatches(p, r); });
    });
    var rowOfItem = bipartite(adj, rows.length);
    var col = { awarded: 0, hits: [], misses: [], rejected: [], items: [] };
    var credited = {};
    var noun = side === 'limitation' ? 'limitation' : 'improvement';
    items.forEach(function (text, i) {
      var r = rowOfItem[i];
      var entry = { text: text, id: null, reason: null };
      if (r >= 0 && col.hits.length < maxEach) {
        entry.id = bank[r].id;
        credited[r] = true;
        col.hits.push({ id: bank[r].id, label: rows[r].label, text: text });
      } else if (r >= 0) {
        entry.reason = 'Maximum of ' + maxEach + ' marks for the ' + noun + 's already reached.';
      } else {
        var dup = -1;
        for (var j = 0; j < rows.length; j++) if (adj[i][j]) { dup = j; break; }
        if (dup >= 0) {
          entry.reason = 'Same point as another answer (' + rows[dup].label + '): each point is credited only once.';
        } else {
          var g = genericReject(preps[i]);
          entry.reason = g ? g.reason
            : 'Not a recognised ' + noun + ' for this experiment: be specific about ' +
              (side === 'limitation' ? 'what makes the measurement difficult or unreliable.' : 'exactly what to change in the method.');
        }
      }
      if (entry.reason) col.rejected.push({ text: text, reason: entry.reason });
      col.items.push(entry);
    });
    rows.forEach(function (r, j) {
      if (r && !credited[j]) col.misses.push({ id: bank[j].id, label: r.label });
    });
    col.awarded = col.hits.length;
    return col;
  }

  /**
   * Mark limitations and improvements independently against a bank of acceptable points.
   * Each bank row is credited at most once per column, each student item credits at most one row, generic
   * answers are rejected with a reason, and each column scores at most maxEach.
   * @param {string|string[]} limItems
   * @param {string|string[]} impItems
   * @param {Array<{id:string, limitation:{label,concepts}, improvement:{label,concepts}}>} bank
   * @param {{maxEach?:number}} [opts]
   * @returns {{limitations:object, improvements:object}}
   */
  function markLimitationsImprovements(limItems, impItems, bank, opts) {
    var maxEach = opts && opts.maxEach !== undefined ? opts.maxEach : 4;
    bank = bank || [];
    return {
      limitations: markColumn(splitItems(limItems), bank, 'limitation', maxEach),
      improvements: markColumn(splitItems(impItems), bank, 'improvement', maxEach)
    };
  }

  VL.textmatch = {
    normalize: normalize,
    plain: plain,
    clauses: clauses,
    stem: stem,
    prepare: prepare,
    matches: matches,
    matchesAny: matchesAny,
    splitItems: splitItems,
    GENERIC_REJECTS: GENERIC_REJECTS,
    genericReject: genericReject,
    markWritten: markWritten,
    markLimitationsImprovements: markLimitationsImprovements
  };
})(globalThis.VLab = globalThis.VLab || {});
