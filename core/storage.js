/**
 * Persistence (docs/ARCHITECTURE.md §3.12, §5).
 *
 * Everything is kept in the browser's localStorage under keys prefixed 'vlab1:'. When localStorage is not usable
 * (undefined in the Node test sandbox; it throws in some private-browsing modes or when cookies/site data are
 * blocked) the module silently falls back to an in-memory store for the current page, so the app keeps working
 * and nothing ever throws. `available()` tells the UI whether work will survive a reload.
 *
 * Keys (all prefixed 'vlab1:'):
 *   session:<id>     one full Session object each (saved individually so one large session never blocks others)
 *   sessions:index   [ SessionSummary ] — what listSessions() returns, kept in step by saveSession/deleteSession
 *   progress         [ ProgressEntry ] in the order they were added (oldest first)
 *   settings         { examMinutes, theme, hintsInPractice, ... }
 *   anything else    via get(key) / set(key) (e.g. drill state, last tab)
 *
 *   SessionSummary = { id, mode, title, created, updated, finished, elapsedMs, examMinutes?,
 *                      expIds: [], questionCount, marked (number of questions marked),
 *                      total?, max? (only present when at least one question has been marked) }
 *   (A summary never has a `questions` property, so callers can tell it apart from a full Session.)
 *
 * Public API (VL.storage):
 *   available() -> boolean
 *   get(key, fallback), set(key, value) -> boolean, remove(key) -> boolean
 *   saveSession(session) -> boolean, loadSession(id) -> Session|null, listSessions() -> [summary],
 *   deleteSession(id) -> boolean
 *   saveSessionChecked(session) -> { ok, conflict: null|'changed'|'deleted', rev }   (revision-checked save)
 *   addProgress(entry) -> boolean (idempotent per sessionId|qIndex|expId|variantId|seed), getProgress() -> entry[],
 *   clearProgress() -> boolean
 *   getSettings() -> settings, setSettings(patch) -> settings
 * Additive helpers:
 *   summarizeSession(session) -> SessionSummary          (pure)
 *   rebuildIndex() -> [summary]                          (re-scan every stored session)
 *   DEFAULT_SETTINGS, PREFIX, MAX_PROGRESS
 *   _setBackend(backend|null)                             (tests only: inject a Storage-like object or reset)
 */
(function (VL) {
  'use strict';

  var PREFIX = 'vlab1:';
  var SESSION_PREFIX = 'session:';
  var INDEX_KEY = 'sessions:index';
  var PROGRESS_KEY = 'progress';
  var SETTINGS_KEY = 'settings';
  var MAX_PROGRESS = 1000;            // oldest entries are dropped beyond this
  var DEFAULT_SETTINGS = { examMinutes: 120, theme: 'light', hintsInPractice: true };
  var SKILLS = ['MMO', 'PDO', 'ACE'];

  /* ------------------------------------------------------------------ backends */

  /** In-memory Storage-like object (used when localStorage is unavailable). */
  function createMemoryBackend() {
    var data = Object.create(null);
    return {
      memory: true,
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; },
      key: function (i) { var ks = Object.keys(data); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(data).length; },
      clear: function () { data = Object.create(null); }
    };
  }

  var memoryBackend = createMemoryBackend();
  var injected = null;       // backend injected by tests
  var probed = null;         // cached probe result: the usable localStorage object, or false

  /**
   * Find out (once) whether localStorage can be used. Accessing `localStorage` itself can throw a SecurityError
   * when site data is blocked, and setItem throws in some private-browsing modes, so both are probed.
   * @returns {object|false}
   */
  function probeLocalStorage() {
    if (probed !== null) return probed;
    probed = false;
    try {
      var ls = globalThis.localStorage;
      if (ls && typeof ls.setItem === 'function') {
        var k = PREFIX + '__probe__';
        ls.setItem(k, '1');
        var ok = ls.getItem(k) === '1';
        ls.removeItem(k);
        if (ok) probed = ls;
      }
    } catch (e) {
      probed = false;
    }
    return probed;
  }

  /** The Storage-like object in use right now. */
  function backend() {
    if (injected) return injected;
    return probeLocalStorage() || memoryBackend;
  }

  /** @returns {boolean} true when data will persist in localStorage (false = in-memory fallback). */
  function available() {
    if (injected) return !injected.memory;
    return !!probeLocalStorage();
  }

  /* ------------------------------------------------------------------ raw string access (never throws) */

  function readRaw(fullKey) {
    try {
      var v = backend().getItem(fullKey);
      return v === undefined ? null : v;
    } catch (e) {
      return null;
    }
  }

  function writeRaw(fullKey, str) {
    try {
      backend().setItem(fullKey, str);
      return true;
    } catch (e) {
      return false;   // quota exceeded, or storage became unavailable
    }
  }

  function removeRaw(fullKey) {
    try {
      backend().removeItem(fullKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** All full keys starting with a prefix (scans the backend). */
  function keysWithPrefix(prefix) {
    var out = [];
    try {
      var b = backend(), n = b.length;
      for (var i = 0; i < n; i++) {
        var k = b.key(i);
        if (typeof k === 'string' && k.indexOf(prefix) === 0) out.push(k);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /* ------------------------------------------------------------------ JSON key/value API */

  function fullKey(key) { return PREFIX + String(key); }

  /**
   * Read a JSON value.
   * @param {string} key without the 'vlab1:' prefix
   * @param {*} [fallback] returned when the key is missing or unreadable
   * @returns {*}
   */
  function get(key, fallback) {
    var raw = readRaw(fullKey(key));
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  /**
   * Store a JSON value.
   * @param {string} key without the 'vlab1:' prefix
   * @param {*} value anything JSON-serialisable (undefined removes the key)
   * @returns {boolean} false when it could not be stored (quota, circular data ...)
   */
  function set(key, value) {
    if (value === undefined) return remove(key);
    var str;
    try {
      str = JSON.stringify(value);
    } catch (e) {
      return false;
    }
    if (str === undefined) return false;
    return writeRaw(fullKey(key), str);
  }

  /** Remove a key. @returns {boolean} */
  function remove(key) {
    return removeRaw(fullKey(key));
  }

  /* ------------------------------------------------------------------ sessions */

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function strOr(v, d) { return typeof v === 'string' ? v : d; }
  function numOr(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  /**
   * Summary of a session for listings (pure).
   * @param {object} s Session
   * @returns {object} SessionSummary
   */
  function summarizeSession(s) {
    var qs = isObj(s) && Array.isArray(s.questions) ? s.questions : [];
    var sum = {
      id: String(s.id),
      mode: strOr(s.mode, 'practice'),
      title: strOr(s.title, ''),
      created: strOr(s.created, ''),
      updated: strOr(s.updated, strOr(s.created, '')),
      finished: !!s.finished,
      elapsedMs: numOr(s.elapsedMs, 0),
      expIds: [],
      questionCount: qs.length,
      marked: 0
    };
    if (s.examMinutes !== undefined) sum.examMinutes = numOr(s.examMinutes, null);
    var total = 0, max = 0;
    qs.forEach(function (q) {
      if (!isObj(q)) return;
      if (q.expId && sum.expIds.indexOf(q.expId) < 0) sum.expIds.push(String(q.expId));
      if (isObj(q.report)) {
        sum.marked++;
        total += numOr(q.report.total, 0);
        max += numOr(q.report.max, 0);
      }
    });
    if (sum.marked) {
      sum.total = total;
      sum.max = max;
    }
    return sum;
  }

  function sessionKey(id) { return SESSION_PREFIX + String(id); }

  function readIndex() {
    var idx = get(INDEX_KEY, null);
    if (!Array.isArray(idx)) return null;
    return idx.filter(function (x) { return isObj(x) && typeof x.id === 'string' && x.id; });
  }

  function writeIndex(idx) {
    return set(INDEX_KEY, idx);
  }

  function sortSummaries(list) {
    return list.sort(function (a, b) {
      return String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || ''));
    });
  }

  /**
   * Rebuild the session index by reading every stored session (used when the index is missing or damaged).
   * @returns {object[]} summaries, most recently updated first
   */
  function rebuildIndex() {
    var start = PREFIX + SESSION_PREFIX;
    var list = [];
    keysWithPrefix(start).forEach(function (k) {
      var raw = readRaw(k);
      if (raw === null) return;
      try {
        var s = JSON.parse(raw);
        if (isObj(s) && s.id !== undefined && s.id !== null) list.push(summarizeSession(s));
      } catch (e) { /* skip unreadable */ }
    });
    sortSummaries(list);
    writeIndex(list);
    return list;
  }

  /**
   * Save one session (and update the index).
   * @param {object} session Session with an id
   * @returns {boolean} false when the session could not be stored (e.g. storage full)
   */
  function saveSession(session) {
    if (!isObj(session) || session.id === undefined || session.id === null || String(session.id) === '') return false;
    var id = String(session.id);
    if (!set(sessionKey(id), session)) return false;
    var summary;
    try {
      summary = summarizeSession(session);
    } catch (e) {
      summary = { id: id, mode: 'practice', title: '', created: '', updated: '', finished: false };
    }
    var idx = readIndex();
    if (!idx) return !!rebuildIndex();
    var found = false;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].id === id) { idx[i] = summary; found = true; break; }
    }
    if (!found) idx.push(summary);
    sortSummaries(idx);
    writeIndex(idx);   // the session itself is saved; a failed index write is repaired on the next listing
    return true;
  }

  /**
   * Save a session only if the stored copy is the one this copy was loaded from (two tabs on one session).
   * Session.rev counts saves (a missing rev counts as 0). The stored rev must equal session.rev, and a session that
   * has been saved before (rev > 0) must still be stored: otherwise nothing is written and the conflict is returned
   * ('changed': another tab saved it since; 'deleted': another tab deleted it). On success session.rev is
   * incremented (in place) and the session is written exactly as saveSession writes it (index summary included).
   * @param {object} session Session with an id
   * @returns {{ok: boolean, conflict: null|'changed'|'deleted', rev: number}} rev: the session's rev after a save,
   *   else the stored rev ('changed'), or the session's own rev ('deleted', storage full or unusable session)
   */
  function saveSessionChecked(session) {
    var myRev = isObj(session) ? numOr(session.rev, 0) : 0;
    if (!isObj(session) || session.id === undefined || session.id === null || String(session.id) === '') {
      return { ok: false, conflict: null, rev: myRev };
    }
    var raw = readRaw(fullKey(sessionKey(String(session.id))));
    if (raw === null) {
      if (myRev > 0) return { ok: false, conflict: 'deleted', rev: myRev };
    } else {
      var stored = null;
      try { stored = JSON.parse(raw); } catch (e) { stored = null; }
      var storedRev = isObj(stored) ? numOr(stored.rev, 0) : 0;
      if (storedRev !== myRev) return { ok: false, conflict: 'changed', rev: storedRev };
    }
    var had = Object.prototype.hasOwnProperty.call(session, 'rev'), prev = session.rev;
    session.rev = myRev + 1;
    if (!saveSession(session)) {
      if (had) session.rev = prev; else delete session.rev;   // nothing was stored: keep the copy's revision
      return { ok: false, conflict: null, rev: myRev };
    }
    return { ok: true, conflict: null, rev: session.rev };
  }

  /**
   * Load a full session.
   * @param {string} id
   * @returns {object|null}
   */
  function loadSession(id) {
    if (id === undefined || id === null) return null;
    var s = get(sessionKey(id), null);
    return isObj(s) ? s : null;
  }

  /**
   * Summaries of every saved session, most recently updated first.
   * @returns {object[]}
   */
  function listSessions() {
    var idx = readIndex();
    if (!idx) return rebuildIndex();
    // repair: sessions stored without an index entry (e.g. an index write failed)
    var known = {};
    idx.forEach(function (x) { known[x.id] = true; });
    var start = PREFIX + SESSION_PREFIX;
    var missing = keysWithPrefix(start).some(function (k) { return !known[k.slice(start.length)]; });
    if (missing) return rebuildIndex();
    return sortSummaries(idx.slice());
  }

  /**
   * Delete a session and its index entry.
   * @param {string} id
   * @returns {boolean}
   */
  function deleteSession(id) {
    if (id === undefined || id === null) return false;
    id = String(id);
    var ok = remove(sessionKey(id));
    var idx = readIndex();
    if (idx) writeIndex(idx.filter(function (x) { return x.id !== id; }));
    return ok;
  }

  /* ------------------------------------------------------------------ progress */

  /** Normalise a ProgressEntry (unknown extra fields are kept). */
  function normalizeEntry(e) {
    var out = {};
    Object.keys(e).forEach(function (k) { out[k] = e[k]; });
    out.date = strOr(e.date, '') || new Date().toISOString();
    out.mode = strOr(e.mode, 'practice');
    out.total = numOr(Number(e.total), 0);
    out.max = numOr(Number(e.max), 0);
    var skills = {};
    SKILLS.forEach(function (sk) {
      var v = isObj(e.skills) ? e.skills[sk] : null;
      skills[sk] = { got: numOr(Number(v && v.got), 0), max: numOr(Number(v && v.max), 0) };
    });
    if (isObj(e.skills)) {
      Object.keys(e.skills).forEach(function (sk) {
        if (!skills[sk] && isObj(e.skills[sk])) skills[sk] = { got: numOr(Number(e.skills[sk].got), 0), max: numOr(Number(e.skills[sk].max), 0) };
      });
    }
    out.skills = skills;
    return out;
  }

  /** Identity of a progress entry: one per question of a session (null for entries without a sessionId). */
  function progressKey(e) {
    if (!isObj(e) || e.sessionId === undefined || e.sessionId === null || String(e.sessionId) === '') return null;
    var qi = e.qIndex === undefined || e.qIndex === null ? '' : e.qIndex;
    return [e.sessionId, qi, e.expId, e.variantId, e.seed].map(function (v) { return v === undefined || v === null ? '' : String(v); }).join('|');
  }

  /**
   * Record one marked attempt. Idempotent: an entry with the same sessionId | qIndex | expId | variantId | seed as
   * a stored one replaces it in place (e.g. a question re-submitted after its first save failed); entries without
   * a sessionId are always appended.
   * @param {object} entry ProgressEntry { sessionId, date, mode, expId, variantId, seed, total, max, skills, qIndex? }
   * @returns {boolean}
   */
  function addProgress(entry) {
    if (!isObj(entry)) return false;
    var list = getProgress();
    var e = normalizeEntry(entry), key = progressKey(e);
    if (key !== null) {
      for (var i = 0; i < list.length; i++) {
        if (progressKey(list[i]) === key) { list[i] = e; return set(PROGRESS_KEY, list); }
      }
    }
    list.push(e);
    if (list.length > MAX_PROGRESS) list = list.slice(list.length - MAX_PROGRESS);
    return set(PROGRESS_KEY, list);
  }

  /** @returns {object[]} every ProgressEntry, oldest first (a copy) */
  function getProgress() {
    var list = get(PROGRESS_KEY, []);
    return Array.isArray(list) ? list.filter(isObj) : [];
  }

  /** Remove all progress entries. @returns {boolean} */
  function clearProgress() {
    return remove(PROGRESS_KEY);
  }

  /* ------------------------------------------------------------------ settings */

  /** @returns {{examMinutes:number, theme:'light'|'dark', hintsInPractice:boolean}} (plus any other stored keys) */
  function getSettings() {
    var stored = get(SETTINGS_KEY, null);
    var s = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k]; });
    if (isObj(stored)) Object.keys(stored).forEach(function (k) { s[k] = stored[k]; });
    // repair invalid values of the known settings
    if (!(typeof s.examMinutes === 'number' && isFinite(s.examMinutes) && s.examMinutes > 0)) s.examMinutes = DEFAULT_SETTINGS.examMinutes;
    if (s.theme !== 'light' && s.theme !== 'dark') s.theme = DEFAULT_SETTINGS.theme;
    if (typeof s.hintsInPractice !== 'boolean') s.hintsInPractice = DEFAULT_SETTINGS.hintsInPractice;
    return s;
  }

  /**
   * Merge a patch into the settings and save them.
   * @param {object} patch
   * @returns {object} the new settings (as getSettings() would return them)
   */
  function setSettings(patch) {
    var s = getSettings();
    if (isObj(patch)) Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    set(SETTINGS_KEY, s);
    return getSettings();
  }

  /* ------------------------------------------------------------------ test hook */

  /**
   * Tests only: use a given Storage-like backend ({ getItem, setItem, removeItem, key, length }), or pass null to
   * go back to normal behaviour (localStorage if usable, else a fresh in-memory store).
   * @param {object|null} b
   */
  function setBackend(b) {
    injected = b || null;
    probed = null;
    if (!b) memoryBackend = createMemoryBackend();
  }

  VL.storage = {
    available: available,
    get: get,
    set: set,
    remove: remove,
    saveSession: saveSession,
    saveSessionChecked: saveSessionChecked,
    loadSession: loadSession,
    listSessions: listSessions,
    deleteSession: deleteSession,
    addProgress: addProgress,
    getProgress: getProgress,
    clearProgress: clearProgress,
    getSettings: getSettings,
    setSettings: setSettings,
    summarizeSession: summarizeSession,
    rebuildIndex: rebuildIndex,
    createMemoryBackend: createMemoryBackend,
    _setBackend: setBackend,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    PREFIX: PREFIX,
    MAX_PROGRESS: MAX_PROGRESS
  };
})(globalThis.VLab = globalThis.VLab || {});
