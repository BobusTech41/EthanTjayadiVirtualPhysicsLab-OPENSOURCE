/**
 * Student data-table model (docs/ARCHITECTURE.md §3.8).
 *
 * A Table is plain JSON-serialisable data:
 *
 *   Table = {
 *     columns: [ { id: 'c1', heading: 'L / cm' } ],
 *     rows:    [ { id: 'r1', cells: { c1: '50.0' } } ],   // raw strings exactly as typed; missing = ''
 *     nextId: 2
 *   }
 *
 * Cells and headings always hold the exact strings the student typed ("0.50" is never turned into "0.5").
 * Nothing in this module ever invents data for the student.
 *
 * Besides the contract functions this module also provides (additive):
 *   moveRow(t, rowId, newIndex), op types 'moveRow' and 'batch', history.seal(), history.reset(t),
 *   VL.datatable.parseNumber(str) (VL.sigfig.parse with a small fallback when sigfig is not loaded),
 *   VL.datatable.columnLabel(t, colId) and VL.datatable.rowNumber(t, rowId) (1-based) for UI messages.
 */
(function (VL) {
  'use strict';

  /* ------------------------------------------------------------------ helpers */

  /** True when a cell string contains something other than white space. */
  function isFilled(str) {
    return typeof str === 'string' && str.trim() !== '';
  }

  /** Coerce anything to a string the way a text input would hold it. */
  function asString(v) {
    if (v === undefined || v === null) return '';
    return String(v);
  }

  function clamp(i, lo, hi) {
    return Math.max(lo, Math.min(hi, i));
  }

  /** Numeric part of an id such as 'c12' / 'r3' (0 if none). */
  function idNumber(id) {
    var m = /(\d+)$/.exec(String(id || ''));
    return m ? parseInt(m[1], 10) : 0;
  }

  function newId(t, prefix) {
    var id = prefix + t.nextId;
    t.nextId += 1;
    return id;
  }

  function colIndex(t, colId) {
    for (var i = 0; i < t.columns.length; i++) if (t.columns[i].id === colId) return i;
    return -1;
  }

  function rowIndex(t, rowId) {
    for (var i = 0; i < t.rows.length; i++) if (t.rows[i].id === rowId) return i;
    return -1;
  }

  function requireCol(t, colId) {
    var i = colIndex(t, colId);
    if (i < 0) throw new Error('datatable: unknown column "' + colId + '"');
    return i;
  }

  function requireRow(t, rowId) {
    var i = rowIndex(t, rowId);
    if (i < 0) throw new Error('datatable: unknown row "' + rowId + '"');
    return i;
  }

  /**
   * Minimal number parser used only when VL.sigfig has not been loaded (keeps this module usable on its own).
   * Returns the subset of the sigfig.parse shape that this module relies on.
   * @param {string} str
   */
  function fallbackParse(str) {
    var s = asString(str).trim();
    var out = { ok: false, value: NaN, str: s, sf: NaN, dp: NaN, problems: [] };
    if (!s) return out;
    var t = s.replace(/−/g, '-').replace(/\s+/g, '')
      .replace(/[x×*]10\^?([+-]?\d+)$/i, 'e$1');
    var m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(t);
    if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return out;
    var intPart = m[2] || '', frac = m[3] || '', exp = m[4] ? parseInt(m[4], 10) : 0;
    out.ok = true;
    out.value = Number(m[1] + (intPart || '0') + '.' + (frac || '0') + 'e' + exp);
    out.dp = frac.length - exp;
    var digits = (intPart + frac).replace(/^0+/, '');
    out.sf = digits.length || 1;
    if (intPart === '' && frac !== '') out.problems.push('leading decimal point');
    return out;
  }

  /**
   * Parse a typed number. Uses VL.sigfig.parse when available (the contract shape), otherwise a small fallback.
   * @param {string} str
   * @returns {{ok:boolean, value:number, str:string, sf:number, dp:number, problems:string[]}}
   */
  function parseNumber(str) {
    if (VL.sigfig && typeof VL.sigfig.parse === 'function') return VL.sigfig.parse(asString(str));
    return fallbackParse(str);
  }

  /* ------------------------------------------------------------------ construction */

  /**
   * Create an empty table.
   * @param {{columns?: number, rows?: number}} [opts] defaults: 3 columns, 7 rows
   * @returns {object} Table
   */
  function create(opts) {
    opts = opts || {};
    var nc = opts.columns === undefined ? 3 : Math.max(0, opts.columns | 0);
    var nr = opts.rows === undefined ? 7 : Math.max(0, opts.rows | 0);
    var t = { columns: [], rows: [], nextId: 1 };
    var i;
    for (i = 1; i <= nc; i++) t.columns.push({ id: 'c' + i, heading: '' });
    for (i = 1; i <= nr; i++) t.rows.push({ id: 'r' + i, cells: {} });
    t.nextId = Math.max(nc, nr) + 1;
    return t;
  }

  /* ------------------------------------------------------------------ mutations */

  /**
   * Add a column.
   * @param {object} t Table
   * @param {string} [heading='']
   * @param {number} [index] position (default: end)
   * @param {string} [id] reuse a specific id (used by redo); must not already exist
   * @returns {{id:string, heading:string}} the new column
   */
  function addColumn(t, heading, index, id) {
    if (id !== undefined && colIndex(t, id) >= 0) throw new Error('datatable: column "' + id + '" exists');
    var col = { id: id !== undefined ? id : newId(t, 'c'), heading: asString(heading) };
    if (id !== undefined) t.nextId = Math.max(t.nextId, idNumber(id) + 1);
    var at = index === undefined || index === null ? t.columns.length : clamp(index | 0, 0, t.columns.length);
    t.columns.splice(at, 0, col);
    return col;
  }

  /**
   * Remove a column and its cells.
   * @returns {{column:object, index:number, cells:Object<string,string>}} what was removed (for undo)
   */
  function removeColumn(t, colId) {
    var i = requireCol(t, colId);
    var column = t.columns.splice(i, 1)[0];
    var cells = {};
    t.rows.forEach(function (r) {
      if (Object.prototype.hasOwnProperty.call(r.cells, colId)) {
        cells[r.id] = r.cells[colId];
        delete r.cells[colId];
      }
    });
    return { column: column, index: i, cells: cells };
  }

  /**
   * Move a column to a new position (index in the final order, clamped).
   * @returns {number} the previous index
   */
  function moveColumn(t, colId, newIndex) {
    var i = requireCol(t, colId);
    var col = t.columns.splice(i, 1)[0];
    t.columns.splice(clamp(newIndex | 0, 0, t.columns.length), 0, col);
    return i;
  }

  /**
   * Set a column heading (exact string).
   * @returns {string} the previous heading
   */
  function setHeading(t, colId, str) {
    var col = t.columns[requireCol(t, colId)];
    var prev = col.heading;
    col.heading = asString(str);
    return prev;
  }

  /**
   * Add a row.
   * @param {object} t
   * @param {number} [index] position (default: end)
   * @param {string} [id] reuse a specific id (used by redo)
   * @returns {{id:string, cells:object}}
   */
  function addRow(t, index, id) {
    if (id !== undefined && rowIndex(t, id) >= 0) throw new Error('datatable: row "' + id + '" exists');
    var row = { id: id !== undefined ? id : newId(t, 'r'), cells: {} };
    if (id !== undefined) t.nextId = Math.max(t.nextId, idNumber(id) + 1);
    var at = index === undefined || index === null ? t.rows.length : clamp(index | 0, 0, t.rows.length);
    t.rows.splice(at, 0, row);
    return row;
  }

  /**
   * Remove a row.
   * @returns {{row:object, index:number}} what was removed (for undo)
   */
  function removeRow(t, rowId) {
    var i = requireRow(t, rowId);
    return { row: t.rows.splice(i, 1)[0], index: i };
  }

  /**
   * Move a row to a new position (additive to the contract).
   * @returns {number} the previous index
   */
  function moveRow(t, rowId, newIndex) {
    var i = requireRow(t, rowId);
    var row = t.rows.splice(i, 1)[0];
    t.rows.splice(clamp(newIndex | 0, 0, t.rows.length), 0, row);
    return i;
  }

  /**
   * Set a cell to the exact string typed. An empty string removes the entry (missing = '').
   * @returns {string} the previous value
   */
  function setCell(t, rowId, colId, str) {
    var row = t.rows[requireRow(t, rowId)];
    requireCol(t, colId);
    var prev = getCellOfRow(row, colId);
    var v = asString(str);
    if (v === '') delete row.cells[colId];
    else row.cells[colId] = v;
    return prev;
  }

  function getCellOfRow(row, colId) {
    var v = row && row.cells ? row.cells[colId] : undefined;
    return v === undefined || v === null ? '' : String(v);
  }

  /**
   * @returns {string} the cell string exactly as typed ('' when empty or unknown)
   */
  function getCell(t, rowId, colId) {
    var i = rowIndex(t, rowId);
    return i < 0 ? '' : getCellOfRow(t.rows[i], colId);
  }

  /* ------------------------------------------------------------------ queries */

  /**
   * Non-empty values of one column, in row order.
   * @returns {Array<{rowId:string, str:string, num:object}>} num = sigfig.parse(str)
   */
  function columnValues(t, colId) {
    var out = [];
    t.rows.forEach(function (r) {
      var s = getCellOfRow(r, colId);
      if (isFilled(s)) out.push({ rowId: r.id, str: s, num: parseNumber(s) });
    });
    return out;
  }

  /** Rows having at least one non-empty cell (in a column that still exists). */
  function filledRows(t) {
    return t.rows.filter(function (r) {
      return t.columns.some(function (c) { return isFilled(getCellOfRow(r, c.id)); });
    });
  }

  /** 1-based position of a row (0 if unknown). */
  function rowNumber(t, rowId) {
    return rowIndex(t, rowId) + 1;
  }

  /**
   * Human-readable name of a column for messages: its heading in quotes, or 'column N' when it has none.
   * @returns {string}
   */
  function columnLabel(t, colId) {
    var i = colIndex(t, colId);
    if (i < 0) return 'column';
    var h = t.columns[i].heading.trim();
    return h ? '“' + h + '”' : 'column ' + (i + 1);
  }

  /* ------------------------------------------------------------------ serialisation */

  /** Deep copy (plain data). */
  function clone(t) {
    return {
      columns: t.columns.map(function (c) { return { id: c.id, heading: c.heading }; }),
      rows: t.rows.map(function (r) {
        var cells = {};
        Object.keys(r.cells || {}).forEach(function (k) { cells[k] = r.cells[k]; });
        return { id: r.id, cells: cells };
      }),
      nextId: t.nextId
    };
  }

  /** Plain JSON-safe object. */
  function toJSON(t) {
    return clone(t);
  }

  /**
   * Rebuild a Table from JSON, repairing missing fields (ids, strings, nextId).
   * @param {object} obj
   * @returns {object} Table
   */
  function fromJSON(obj) {
    obj = obj || {};
    var t = { columns: [], rows: [], nextId: 1 };
    var srcCols = (Array.isArray(obj.columns) ? obj.columns : []).map(function (c) { return c || {}; });
    var srcRows = (Array.isArray(obj.rows) ? obj.rows : []).map(function (r) { return r || {}; });
    // First pass: keep every valid, unique id and find the largest id number in use.
    var maxId = 0, seen = {};
    function keep(id) {
      if (id === undefined || id === null || id === '' || seen[String(id)]) return null;
      seen[String(id)] = true;
      maxId = Math.max(maxId, idNumber(id));
      return String(id);
    }
    var colIds = srcCols.map(function (c) { return keep(c.id); });
    var rowIds = srcRows.map(function (r) { return keep(r.id); });
    // Second pass: give missing or duplicate ids fresh numbers.
    function fresh(prefix) {
      var s;
      do { s = prefix + (++maxId); } while (seen[s]);
      seen[s] = true;
      return s;
    }
    srcCols.forEach(function (c, i) {
      t.columns.push({ id: colIds[i] || fresh('c'), heading: asString(c.heading) });
    });
    var validCol = {};
    t.columns.forEach(function (c, i) { if (colIds[i]) validCol[c.id] = true; });
    srcRows.forEach(function (r, i) {
      var cells = {};
      Object.keys(r.cells || {}).forEach(function (k) {
        var v = asString(r.cells[k]);
        if (validCol[k] && v !== '') cells[k] = v;
      });
      t.rows.push({ id: rowIds[i] || fresh('r'), cells: cells });
    });
    t.nextId = Math.max(Number(obj.nextId) || 1, maxId + 1);
    return t;
  }

  /* ------------------------------------------------------------------ undo / redo */

  /**
   * Apply one op to a table, returning { result, inverse } where inverse undoes it and op is normalised
   * (ids filled in) so that re-applying it (redo) reproduces exactly the same ids.
   */
  function applyOp(t, op) {
    if (!op || typeof op.type !== 'string') throw new Error('datatable: op needs a type');
    var r, prev, idx;
    switch (op.type) {
      case 'setCell': {
        var val = op.value !== undefined ? op.value : op.str;
        prev = setCell(t, op.rowId, op.colId, val);
        return {
          op: { type: 'setCell', rowId: op.rowId, colId: op.colId, value: asString(val) },
          inverse: { type: 'setCell', rowId: op.rowId, colId: op.colId, value: prev },
          result: prev
        };
      }
      case 'setHeading': {
        var h = op.value !== undefined ? op.value : (op.heading !== undefined ? op.heading : op.str);
        prev = setHeading(t, op.colId, h);
        return {
          op: { type: 'setHeading', colId: op.colId, value: asString(h) },
          inverse: { type: 'setHeading', colId: op.colId, value: prev },
          result: prev
        };
      }
      case 'addRow': {
        r = addRow(t, op.index, op.id !== undefined ? op.id : op.rowId);
        idx = rowIndex(t, r.id);
        return {
          op: { type: 'addRow', index: idx, id: r.id },
          inverse: { type: 'removeRow', rowId: r.id },
          result: r
        };
      }
      case 'removeRow': {
        r = removeRow(t, op.rowId);
        return {
          op: { type: 'removeRow', rowId: op.rowId },
          inverse: { type: '_restoreRow', row: r.row, index: r.index },
          result: r
        };
      }
      case '_restoreRow': {
        var row = { id: op.row.id, cells: Object.assign({}, op.row.cells) };
        t.rows.splice(clamp(op.index, 0, t.rows.length), 0, row);
        return { op: op, inverse: { type: 'removeRow', rowId: row.id }, result: row };
      }
      case 'moveRow': {
        var toR = op.index !== undefined ? op.index : op.newIndex;
        prev = moveRow(t, op.rowId, toR);
        return {
          op: { type: 'moveRow', rowId: op.rowId, index: rowIndex(t, op.rowId) },
          inverse: { type: 'moveRow', rowId: op.rowId, index: prev },
          result: prev
        };
      }
      case 'addColumn': {
        var col = addColumn(t, op.heading, op.index, op.id !== undefined ? op.id : op.colId);
        idx = colIndex(t, col.id);
        return {
          op: { type: 'addColumn', heading: col.heading, index: idx, id: col.id },
          inverse: { type: 'removeColumn', colId: col.id },
          result: col
        };
      }
      case 'removeColumn': {
        r = removeColumn(t, op.colId);
        return {
          op: { type: 'removeColumn', colId: op.colId },
          inverse: { type: '_restoreColumn', column: r.column, index: r.index, cells: r.cells },
          result: r
        };
      }
      case '_restoreColumn': {
        var c = { id: op.column.id, heading: op.column.heading };
        t.columns.splice(clamp(op.index, 0, t.columns.length), 0, c);
        Object.keys(op.cells || {}).forEach(function (rowId) {
          var ri = rowIndex(t, rowId);
          if (ri >= 0 && op.cells[rowId] !== '') t.rows[ri].cells[c.id] = op.cells[rowId];
        });
        return { op: op, inverse: { type: 'removeColumn', colId: c.id }, result: c };
      }
      case 'moveColumn': {
        var toC = op.index !== undefined ? op.index : op.newIndex;
        prev = moveColumn(t, op.colId, toC);
        return {
          op: { type: 'moveColumn', colId: op.colId, index: colIndex(t, op.colId) },
          inverse: { type: 'moveColumn', colId: op.colId, index: prev },
          result: prev
        };
      }
      case 'batch': {
        var done = [];
        try {
          (op.ops || []).forEach(function (o) { done.push(applyOp(t, o)); });
        } catch (e) {
          for (var k = done.length - 1; k >= 0; k--) applyOp(t, done[k].inverse);
          throw e;
        }
        return {
          op: { type: 'batch', ops: done.map(function (d) { return d.op; }) },
          inverse: { type: 'batch', ops: done.map(function (d) { return d.inverse; }).reverse() },
          result: done.map(function (d) { return d.result; })
        };
      }
      default:
        throw new Error('datatable: unknown op type "' + op.type + '"');
    }
  }

  /**
   * Undo/redo wrapper around a table (the table is mutated in place).
   *
   * op = { type: 'setCell', rowId, colId, value }        (value may also be given as `str`)
   *    | { type: 'setHeading', colId, value }
   *    | { type: 'addRow', index?, id? }                  | { type: 'removeRow', rowId }
   *    | { type: 'moveRow', rowId, index }               (additive)
   *    | { type: 'addColumn', heading?, index?, id? }     | { type: 'removeColumn', colId }
   *    | { type: 'moveColumn', colId, index }            (index may also be given as `newIndex`)
   *    | { type: 'batch', ops: [op, ...] }               (additive: one undo step)
   *
   * Typing support: an op with `merge: true` (setCell / setHeading only) is merged into the previous undo
   * step when that step edited the same cell/heading and was also a merge op, so one undo removes a whole
   * edit rather than one keystroke. Call seal() (e.g. on blur) to end the current edit.
   *
   * @param {object} t Table
   * @param {{limit?: number}} [opts] maximum undo depth (default 500)
   * @returns {{apply(op):*, undo():boolean, redo():boolean, canUndo():boolean, canRedo():boolean,
   *            seal():void, reset(t?):void, table:object}}
   */
  function history(t, opts) {
    var limit = (opts && opts.limit) || 500;
    var undoStack = [], redoStack = [];
    var api = {
      table: t,
      /** Apply an op, record it for undo and clear the redo stack. Returns the op result. */
      apply: function (op) {
        var res = applyOp(api.table, op);
        var key = op.merge && (res.op.type === 'setCell' || res.op.type === 'setHeading')
          ? res.op.type + ':' + (res.op.rowId || '') + ':' + res.op.colId : null;
        var top = undoStack[undoStack.length - 1];
        if (key && top && top.mergeKey === key && !top.sealed) {
          top.op = res.op;                       // keep the original inverse (value before the edit)
        } else {
          undoStack.push({ op: res.op, inverse: res.inverse, mergeKey: key, sealed: false });
          if (undoStack.length > limit) undoStack.shift();
        }
        redoStack.length = 0;
        return res.result;
      },
      /** Undo the last step. @returns {boolean} true if something was undone */
      undo: function () {
        var e = undoStack.pop();
        if (!e) return false;
        applyOp(api.table, e.inverse);
        e.sealed = true;
        redoStack.push(e);
        return true;
      },
      /** Redo the last undone step. @returns {boolean} */
      redo: function () {
        var e = redoStack.pop();
        if (!e) return false;
        applyOp(api.table, e.op);
        e.sealed = true;
        undoStack.push(e);
        return true;
      },
      canUndo: function () { return undoStack.length > 0; },
      canRedo: function () { return redoStack.length > 0; },
      /** End the current merged edit so the next keystroke starts a new undo step. */
      seal: function () {
        var top = undoStack[undoStack.length - 1];
        if (top) top.sealed = true;
      },
      /** Forget all history (optionally switching to another table). */
      reset: function (newTable) {
        if (newTable) api.table = newTable;
        undoStack.length = 0;
        redoStack.length = 0;
      }
    };
    return api;
  }

  /* ------------------------------------------------------------------ practice-mode lint */

  function parseHeading(str) {
    if (VL.units && typeof VL.units.parseHeading === 'function') {
      try { return VL.units.parseHeading(str); } catch (e) { return null; }
    }
    return null;
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  /** "rows 1, 2 and 5" */
  function listRows(nums) {
    if (nums.length === 1) return 'row ' + nums[0];
    return 'rows ' + nums.slice(0, -1).join(', ') + ' and ' + nums[nums.length - 1];
  }

  /**
   * Practice-mode hints about the form of the table (never about the physics or the expected values).
   * Checks: empty headings, heading problems reported by VL.units.parseHeading, duplicate headings,
   * non-numeric cells (e.g. a unit typed in a cell), number-format problems, and inconsistent decimal
   * places within a column.
   * @param {object} t Table
   * @returns {Array<{level:'warn'|'info', colId?:string, rowId?:string, message:string}>}
   */
  function lint(t) {
    var out = [];
    var headingsSeen = {};

    t.columns.forEach(function (col, ci) {
      var heading = col.heading.trim();
      var values = columnValues(t, col.id);
      var name = columnLabel(t, col.id);

      // --- heading
      if (!heading) {
        if (values.length) {
          out.push({ level: 'warn', colId: col.id,
            message: 'Column ' + (ci + 1) + ' has entries but no heading. Write the quantity and its unit, ' +
              'separated by a solidus, for example “L / cm”.' });
        } else {
          out.push({ level: 'info', colId: col.id,
            message: 'Column ' + (ci + 1) + ' is empty. Give it a heading or delete it if you do not need it.' });
        }
      } else {
        var key = heading.replace(/\s+/g, ' ');
        if (headingsSeen[key]) {
          out.push({ level: 'info', colId: col.id,
            message: 'Two columns have the heading ' + name + '. If they are repeat readings, number them ' +
              '(for example t₁ / s and t₂ / s).' });
        }
        headingsSeen[key] = true;
        var ph = parseHeading(heading);
        if (ph) {
          var problems = (Array.isArray(ph.problems) ? ph.problems : []).filter(function (p) {
            return !/^no unit given$/i.test(p);   // handled below as an info: fine for dimensionless quantities
          });
          if (problems.length) {
            problems.forEach(function (p) {
              out.push({ level: 'warn', colId: col.id, message: 'Heading ' + name + ': ' + p + '.' });
            });
          } else if (ph.ok === false) {
            out.push({ level: 'warn', colId: col.id,
              message: 'Heading ' + name + ' could not be read as “quantity / unit”.' });
          } else if (ph.style === 'none' && !ph.log && !ph.unitStr) {
            out.push({ level: 'info', colId: col.id,
              message: 'Heading ' + name + ' has no unit. That is only correct for a quantity with no unit, ' +
                'such as a number of oscillations.' });
          }
        }
      }

      // --- cells
      var numeric = [];
      values.forEach(function (v) {
        var rn = rowNumber(t, v.rowId);
        if (!v.num || !v.num.ok) {
          var s = v.str.trim();
          var unitTail = /^[+\-−]?[\d.]+(?:\s*(?:[eE]|[x×*]\s*10\^?)[+\-−]?\d+)?\s*[A-Za-zµμ°Ω%²³⁻¹]+[\w²³⁻¹]*$/.test(s);
          out.push({ level: 'warn', colId: col.id, rowId: v.rowId,
            message: 'Row ' + rn + ', ' + name + ': “' + s + '” is not a number.' +
              (unitTail ? ' Put the unit in the column heading only, not in the cells.' : '') });
          return;
        }
        numeric.push(v);
        (v.num.problems || []).forEach(function (p) {
          out.push({ level: 'info', colId: col.id, rowId: v.rowId,
            message: 'Row ' + rn + ', ' + name + ' (“' + v.str.trim() + '”): ' + p + '.' });
        });
      });

      // --- decimal places
      var byDp = {};
      numeric.forEach(function (v) {
        var dp = v.num.dp;
        if (typeof dp !== 'number' || isNaN(dp)) return;
        (byDp[dp] = byDp[dp] || []).push(rowNumber(t, v.rowId));
      });
      var dps = Object.keys(byDp).map(Number).sort(function (a, b) { return a - b; });
      var sfs = {};
      numeric.forEach(function (v) { if (typeof v.num.sf === 'number' && !isNaN(v.num.sf)) sfs[v.num.sf] = true; });
      // values that all have the same s.f. (e.g. calculated T = 1.453, 0.9287, 1.209) are consistent: no hint, so the
      // student is never told to change correct values
      var sameSf = Object.keys(sfs).length === 1;
      if (dps.length > 1 && !sameSf) {
        var parts = dps.map(function (dp) {
          var label = dp < 0 ? 'to the nearest ' + Math.pow(10, -dp)
            : dp + ' ' + plural(dp, 'decimal place', 'decimal places');
          return label + ' (' + listRows(byDp[dp]) + ')';
        });
        out.push({ level: 'warn', colId: col.id,
          message: name.charAt(0).toUpperCase() + name.slice(1) + ': values are given to different numbers of ' +
            'decimal places — ' + parts.join(', ') + '. Raw readings from one instrument should all have ' +
            'the same number of decimal places; calculated values should have a consistent number of ' +
            'significant figures instead.' });
      }
    });
    return out;
  }

  VL.datatable = {
    create: create,
    addColumn: addColumn,
    removeColumn: removeColumn,
    moveColumn: moveColumn,
    setHeading: setHeading,
    addRow: addRow,
    removeRow: removeRow,
    moveRow: moveRow,
    setCell: setCell,
    getCell: getCell,
    columnValues: columnValues,
    filledRows: filledRows,
    rowNumber: rowNumber,
    columnLabel: columnLabel,
    clone: clone,
    toJSON: toJSON,
    fromJSON: fromJSON,
    history: history,
    lint: lint,
    parseNumber: parseNumber,
    isFilled: isFilled
  };
})(globalThis.VLab = globalThis.VLab || {});
