# Virtual Practical Lab — Architecture & Interface Contract

This document is the **binding contract** between all modules. If you implement a module, implement exactly the
API described here. If you consume a module that already exists in the working tree, read its source and conform
to what it actually does; if it does not exist yet, code against this contract.

Audience: Cambridge International AS Level Physics 9702, Paper 3 (Advanced Practical Skills) students.
Language of all user-visible text: British English, Cambridge conventions (SI units, `quantity / unit`
headings, `lg` = log₁₀, `ln` = natural log). Never copy past-paper text — write original wording in exam style.

---

## 1. Global conventions

* **No build step, no modules, no CDN, no npm dependencies at runtime.** The app must work by double-clicking
  `index.html` (`file://`). Chrome blocks `<script type="module">` on `file://`, so every source file is a
  **classic script** wrapped in an IIFE that attaches to the global namespace `VLab`:

  ```js
  (function (VL) {
    'use strict';
    // ... module code ...
    VL.sigfig = { /* public API */ };
  })(globalThis.VLab = globalThis.VLab || {});
  ```

* Use `globalThis`, never `window`, in `core/` and `experiments/` (they also run in Node for tests).
* **No top-level DOM access** anywhere (`document`, `window`, `localStorage`, `requestAnimationFrame`, canvas)
  except inside functions that are only called in the browser. `core/` and `experiments/` files must load cleanly
  in a Node `vm` context with no `document`.
* Modules may only call other modules **at call time**, never at load time (load order only matters for
  `core/registry.js` before `experiments/*.js`).
* ES2019-level JavaScript (const/let, arrow functions, classes, template strings, destructuring, spread).
  No optional-chaining-heavy code is required but it is allowed (Chrome/Edge/Safari/Firefox current).
* Plain, readable code; JSDoc comments on public functions; no minification.
* `Math.random()` is only allowed in `VL.rng.newSeed()`. All physics randomness goes through `VL.rng`.
* All numbers the student types are **kept as the exact strings typed** (so "0.50" ≠ "0.5" for d.p./s.f. marking).
* CSS: every component uses the shared tokens in `styles/tokens.css` (`var(--ink)` etc.) and puts its own
  rules in its own stylesheet with a component prefix (see §9).

## 2. Load order (`index.html`)

```
styles/tokens.css, styles/main.css, styles/table.css, styles/graph.css,
styles/instruments.css, styles/drills.css, styles/progress.css

core/rng.js
core/sigfig.js
core/units.js
core/stats.js
core/noise.js
core/uncertainty.js
core/instruments/base.js
core/instruments/rules.js          (metreRule, rule30, setSquare)
core/instruments/vernier.js
core/instruments/micrometer.js
core/instruments/protractor.js
core/instruments/balance.js
core/instruments/cylinder.js
core/instruments/thermometer.js
core/instruments/stopwatch.js      (stopwatch, lightGateTimer, stopwatch widget)
core/instruments/meters.js         (analogueMeter, digitalMeter)
core/datatable.js
core/graph.js
core/textmatch.js
core/marking.js
core/storage.js
core/export.js
core/circuit.js                    (circuit components + solver)
core/circuitTemplates.js           (Circuit lab set-ups)
core/registry.js
experiments/pendulum.js            (+ future experiments, one <script> each)
ui/dom.js
ui/calculator.js
ui/apparatusView.js
ui/paperView.js
ui/tableView.js
ui/graphView.js
ui/uncertaintyView.js
ui/reportView.js
ui/timer.js
ui/shortcuts.js
ui/instrumentLab.js
ui/circuitSymbols.js
ui/circuitBench.js
ui/circuitLab.js
ui/drillsView.js
ui/progressView.js
ui/app.js                          (boots on DOMContentLoaded)
```

## 3. Core module APIs

### 3.1 `VL.rng` — seeded randomness (`core/rng.js`)

```js
VL.rng.hash(str) -> [u32, u32, u32, u32]           // cyrb128
VL.rng.create(seedStr) -> Rng                       // sfc32 seeded from hash(seedStr)
VL.rng.newSeed(prefix) -> 'PEN-7K2Q-91C3'           // prefix 2–4 uppercase letters + two groups of 4
                                                    // Crockford base32 chars (0-9 A-H J K M N P-T V-Z)
VL.rng.normalizeSeed(str) -> string                 // trim + uppercase
VL.rng.isValidSeed(str) -> boolean

Rng = {
  seed,                         // the seed string
  next(),                       // float in [0, 1)
  uniform(a, b),                // float in [a, b)
  int(a, b),                    // integer in [a, b] inclusive
  normal(mean = 0, sd = 1),     // Box–Muller
  pick(array),
  chance(p),                    // boolean, true with probability p
  shuffle(array),               // returns a shuffled COPY
  fork(name) -> Rng             // independent stream: create(seed + '/' + name)
}
```

Convention: hidden parameters use `rng.fork('params')`, measurement noise uses `rng.fork('noise')`,
model answers use `rng.fork('model')`.

### 3.2 `VL.sigfig` — significant figures / decimal places of typed strings (`core/sigfig.js`)

```js
VL.sigfig.parse(str) -> {
  ok, value, str,        // str = trimmed input
  sf, sfMin, sfMax,      // sf === sfMax. Trailing zeros of an integer without a decimal point are ambiguous:
                         // '1200' -> sfMin 2, sfMax 4. '0.050' -> 2. '50.0' -> 3. '0' -> 1. '0.00' -> 1.
  dp,                    // digits after the point in the mantissa minus the exponent ('1.25e-3' -> 5, '1.2e3' -> -2)
  mantissa, exponent,
  problems: []           // e.g. 'leading decimal point', 'comma used as decimal separator'
}
```
Accepts: `12`, `12.0`, `-0.050`, `+3`, `.5` (ok, flagged), `1.2e-3`, `1.2E3`, `1.2×10^-3`, `1.2x10^-3`,
`1.2 × 10⁻³`, `1.2*10^3`, unicode minus `−`. Rejects (ok=false): empty, `1,2`, `12 cm`, `1/2`, text.

```js
VL.sigfig.sf(str) -> number|NaN
VL.sigfig.dp(str) -> number|NaN
VL.sigfig.roundSF(x, n) -> number
VL.sigfig.formatSF(x, n) -> string     // keeps trailing zeros: formatSF(2, 3) === '2.00';
                                        // plain notation for 1e-4 <= |x| < 1e6, else '1.23e-5' style
VL.sigfig.formatDP(x, n) -> string
VL.sigfig.agreesWithin(str, trueValue, relTol = 0) -> boolean
        // true if |parsed - trueValue| <= half a unit in the last place of str (+1e-12 relative),
        // or <= relTol * |trueValue|
VL.sigfig.leastSF(strs) -> number       // min sf over parseable strings
```

### 3.3 `VL.units` — units, dimensions, headings (`core/units.js`)

Dimensions object: only non-zero entries among `m kg s A K mol cd`, e.g. `{ m: 1, s: -2 }`. Dimensionless `{}`.

```js
VL.units.parseUnit(str) -> { ok, dims, factor, str, canonical, angle: bool, offset: number, problems: [] }
```
* Tokens separated by spaces, `·`, `.`, `*`. Exponents: `^2`, `^-1`, superscripts `²³⁻¹`, or trailing integers
  (`m2`, `s-2`). One `/` allowed: everything after it is negated (`m/s^2`).
* Symbols: `m g s A K mol cd N J W Pa Hz C V Ω ohm ohms °C degC ° deg degree degrees rad min h L % `.
  `kg` handled as k+g (factor 1 for SI). `°C` dims `{K:1}`, offset 273.15 (differences only). Angle units are
  dimensionless with `angle: true` (`°` factor π/180). `%` dimensionless, factor 0.01.
* Prefixes: `p n µ μ u m c d k M G`. Exact symbol match is tried before prefix+symbol (`min`, `mol`, `cd`, `Pa`).

```js
VL.units.parseHeading(str) -> {
  ok, style: 'slash'|'brackets'|'none',
  quantity,            // as typed, trimmed, e.g. 'T²', '1/u', '20T'
  symbol,              // normalizeSymbol(quantity)
  unitStr, unit,       // unit = parseUnit result or null
  log: null|'lg'|'ln', // for 'lg (T / s)', 'ln(θ / °C)' etc.
  inner,               // for log headings: { quantity, symbol, unitStr, unit }
  problems: []         // human-readable, e.g. 'no unit given', 'unit not separated by / or ( )',
                       // 'unit inside lg ( ) missing'
}
```
Rules: prefer a `/` surrounded by spaces as the separator (`v / m/s`, `1/u / m⁻¹`); if none, use the last `/`
whose right side parses as a unit (`T/s`, `1/u/m^-1`). Brackets style: `T (s)`. Anything else with a unit-like
tail (`T in s`, `T, s`, `T s`) → ok=false with a problem. A heading with no unit at all → style 'none'
(valid only for dimensionless quantities — the marker decides). `lg (T / s)`, `lg(T/s)`, `log (T / s)` → log 'lg'.

```js
VL.units.parseValueWithUnit(str, opts?) -> { ok, valueStr, num /* sigfig.parse */, unitStr, unit, si, problems,
                                              plusMinus?, uncertainty? }
     // '9.79 m s^-2', '4.0 s² m⁻¹', '0.52 s2', '12 %' ; si = value * factor
     // opts.allowPlusMinus: accept a leading '±', '+/-' or '+-' (spaces allowed), e.g. an absolute uncertainty
     //   '±0.01 cm' or a percentage '± 0.41 %' → plusMinus: true (value and unit as usual)
     // opts.allowUncertainty: accept 'x ± Δx unit', '(x ± Δx) unit' and 'x unit ± Δx unit'; the result describes x
     //   exactly as if it had been typed alone (valueStr, num → s.f./d.p. of x, unit, si) plus
     //   uncertainty: { valueStr, num, si } for Δx. A leading '±' is NOT a value ('±2.45 cm' → ok: false).
     // Without these options the behaviour is unchanged: '±0.01 cm' → 'no number found',
     //   '2.45 ± 0.01 cm' → 'unit not recognised: ± 0.01 cm'.
     // The marker uses allowPlusMinus for percentUncertainty fields and allowUncertainty for value answers
     //   (answerValue, the pendulum's L, T and timing answers).
VL.units.dimsEqual(a, b) -> boolean
VL.units.formatDims(dims) -> 'kg m s⁻²'
VL.units.normalizeSymbol(s) -> string
     // remove spaces, superscripts -> '^n' ('T²' -> 'T^2'), subscripts -> '_n', unicode minus -> '-',
     // 'T2' stays 'T2' (callers list both spellings). Case is preserved (T ≠ t).
```

### 3.4 `VL.stats` (`core/stats.js`)

```js
mean(a), sum(a), min(a), max(a), range(a), halfRange(a), median(a), sd(a) /* sample */,
linearFit(xs, ys) -> { m, c, r2, n }, residuals(xs, ys, m, c) -> number[]
```

### 3.5 `VL.noise` (`core/noise.js`)

```js
VL.noise.level = 1           // global multiplier; tests set 0 to get exact physics
VL.noise.anomalyRate = 0.03  // per opportunity
VL.noise.gauss(rng, sd) -> number                  // sd * level * normal()
VL.noise.quantize(value, resolution) -> number     // round to nearest multiple
VL.noise.maybeAnomaly(rng, rate = anomalyRate) -> boolean   // always false when level === 0
VL.noise.zeroError(rng, { resolution, chance = 0.3, maxDivisions = 3 }) -> number
        // 0 with probability 1-chance, else ±k*resolution (k = 1..maxDivisions); 0 when level === 0
VL.noise.parallaxShift(gap, eyeAngleDeg) -> number // gap * tan(angle)
```

### 3.6 `VL.uncertainty` (`core/uncertainty.js`)

```js
halfRange(values), fractional(abs, value), percent(abs, value), fromPercent(pct, value),
meanWithUncertainty(values) -> { mean, abs, percent },
product(terms /* [{ value, abs, power = 1 }] */) -> { fractional, percent }  // Σ|power|·abs/|value|
sum(terms /* [{ abs }] */) -> abs
worstLine(points /* [{x, y, ex, ey}] */) -> { best: {m, c}, steep: {m, c}, shallow: {m, c}, dm }
     // Paper 5 extension: worst lines through the extreme error-bar corners of first and last points
```

### 3.7 Instruments (`core/instruments/*.js`) — `VL.instruments`

`base.js` defines `VL.instruments = { types: {}, define(type, factory), create(type, opts, rng) }`.
Every instance has:

```js
{
  type, name,                 // 'metreRule', 'Metre rule'
  unit,                       // display unit: 'cm' | 'mm' | '°' | 'g' | 'cm³' | '°C' | 's' | 'A' | 'V'
  resolution,                 // smallest division / digit, in display unit
  range: [min, max],
  zeroError,                  // hidden, display unit (0 if none)
  tolerance,                  // acceptable reading error for marking (analogue: resolution/2, digital: resolution)
  indicate(trueValue, now?)   // what the instrument physically shows (true + zeroError (+ jitter), clamped,
                              // quantized for digital instruments)
  draw(g, place, view, state) // draw on a CanvasRenderingContext2D already transformed to WORLD units
                              // (1 unit = 1 cm, y downward) at true physical size.
                              // place: instrument-specific position/orientation; state: e.g. { opening }.
                              // view: { scale /* px per cm */, eyeAngle /* deg, + = eye above */, eyeY?, eyeDist? }
                              // (an apparatus view passes eyeAngle at the centre of the view; see §4.1)
  describe()                  // tutorial HTML: how to read it, resolution, zero error, parallax, technique
}
```

Instrument-specific notes (all drawn so that you must zoom in to read them, exactly like a real scale):

| type | key facts |
|---|---|
| `metreRule`, `rule30` | 1 mm divisions, numbered every cm; optional `zeroInset` (cm from physical end to zero mark). `place = {x, y, angle}` (x,y = zero mark; angle in rad, `-Math.PI/2` = vertical going up, `Math.PI/2` = vertical going down). `readingAt(place, worldPt)` → scale reading (cm) of the projection of a world point. Rule has thickness; when `view.eyeAngle ≠ 0` draw its edge face, and objects at a gap `g` from the scale appear shifted by `parallaxShift(g, eyeAngle)`. The edge face is a level-eye cue only for a rule lying horizontally: for a vertical rule it shows only at the rule's ends, so the tutorial tells students to put the eye level with the mark being read (or use a set square). With an apparatus view, `eyeAngle` is the angle at the centre of the view and the eye is a fixed height (§4.1), so each end of a vertical length is re-levelled separately. |
| `setSquare` | draw only (alignment aid). |
| `vernier` | `opts.resolution` 0.1 mm or 0.02 mm (display unit **mm**); main scale mm; vernier 10 or 50 divisions; `state = {opening}` in mm; `readingFor(opening) = opening + zeroError`. |
| `micrometer` | 0.01 mm, sleeve 0.5 mm, thimble 50 divisions; zeroError up to ±0.03 mm; `state = {gap}` mm. |
| `protractor` | 180°, 1° divisions, radius ≈ 7.5 cm; `place = {x, y, rotation}`; `angleReading(place, rayAngle)`. |
| `balance` | digital, resolution 0.1 g or 0.01 g, last-digit flicker, `tare()`, untared offset; display string. |
| `cylinder` | 100 cm³ (1 cm³ div) or 250 cm³ (2 cm³ div); meniscus; parallax via eyeAngle. |
| `thermometer` | −10 to 110 °C, 1 °C div; `update(dt, envTemp)` bulb lag τ ≈ 5 s. |
| `stopwatch` | 0.01 s, `start(nowMs) stop(nowMs) reset() running elapsed(nowMs)` (s), `display(nowMs)` → `'12.34'` below 60 s, `'1:02.35'` from 60 s. **Real time**: the student's own reaction time is the timing error. `getState(nowMs)` → `{ elapsed /* s, exact */, running }`; `setState({ elapsed })` leaves the watch **stopped** showing that accumulated time (a running watch's time base does not survive a reload) and a later `start()` keeps accumulating. Used to keep a reading across question switches and reloads. |
| `lightGateTimer` | 0.001 s digital, triggered by the experiment. Same `getState` / `setState`. |
| `analogueMeter` | `opts.kind 'A'|'V'`, ranges e.g. `{max: 1, minor: 0.02}`; needle with mirror strip & parallax; small damping; optional zero offset (needle not on 0 when off). |
| `digitalMeter` | resolution by range (2 V → 0.001 V, 20 V → 0.01 V, 200 mA → 0.1 mA, 2 A → 0.001 A), last-digit flicker, small zero offset. |

`stopwatch.js` also exports the DOM widget (browser only):
```js
VL.instruments.stopwatchWidget(container, sw, { onEvent(kind /* 'start'|'stop'|'reset' */, info) })
   -> { el, destroy(), toggle(), reset() }
```
It shows a realistic LCD display updating live while running, big touch-friendly Start/Stop and Reset buttons.
Keyboard is handled by `ui/shortcuts.js` (Space = start/stop, X = reset) which calls `toggle()` / `reset()`.

### 3.8 `VL.datatable` — student data table model (`core/datatable.js`)

```js
Table = {
  columns: [ { id: 'c1', heading: 'L / cm' } ],
  rows:    [ { id: 'r1', cells: { c1: '50.0' } } ],   // raw strings exactly as typed; missing = ''
  nextId: 2
}
VL.datatable.create({ columns: n = 3, rows: n = 7 }) -> Table   // empty headings/cells
addColumn(t, heading = '', index?) -> col ; removeColumn(t, colId) ; moveColumn(t, colId, newIndex)
setHeading(t, colId, str) ; addRow(t, index?) -> row ; removeRow(t, rowId)
setCell(t, rowId, colId, str) ; getCell(t, rowId, colId) -> str
columnValues(t, colId) -> [ { rowId, str, num /* sigfig.parse */ } ]  // non-empty cells only
filledRows(t) -> rows having at least one non-empty cell
clone(t) ; toJSON(t) ; fromJSON(obj)
// Undo/redo: every mutation above can be expressed as an op; history wrapper:
VL.datatable.history(t) -> { apply(op), undo(), redo(), canUndo(), canRedo(), table }
   // op = { type: 'setCell'|'setHeading'|'addRow'|'removeRow'|'addColumn'|'removeColumn'|'moveColumn', ... }
VL.datatable.lint(t) -> [ { level: 'warn'|'info', colId?, rowId?, message } ]   // practice-mode hints only
```

### 3.9 `VL.graph` — graph-paper model and checks (`core/graph.js`)

All positions are in **small squares** from the bottom-left corner of the grid (floats). One large square = 10
small squares = 2 cm on the printed grid.

```js
Graph = {
  grid: { cols: 14, rows: 10, small: 10 },   // large squares across / up; small squares per large square
  x: { colId: null, label: '', origin: 0, perLarge: 1, labelEvery: 1 },
  y: { colId: null, label: '', origin: 0, perLarge: 1, labelEvery: 1 },
     // origin = value at the left / bottom edge; perLarge = value per large square;
     // labelEvery = scale numbers every N large squares
  points: [ { id: 'p1', rowId: 'r1', gx, gy, anomaly: false } ],   // anomaly = circled by the student
  line: null | { a: { gx, gy }, b: { gx, gy } },          // student's best-fit line (ruler endpoints)
  triangle: null | { p1: { gx, gy }, p2: { gx, gy } },    // gradient-triangle vertices on/near the line
  readOffs: { x1: '', y1: '', x2: '', y2: '' },           // coordinates the student TYPED for p1, p2
  intercept: { method: null|'direct'|'substitution', value: '' },
  worstLine: null | { a, b },                             // Paper 5 extension only
  nextId: 1
}
VL.graph.create() -> Graph
valueToGrid(axis, value) -> small squares ; gridToValue(axis, g) -> value
lineY(line, gx) -> gy | null (vertical) ; lineLength(line) ; lineValueAt(graph, xValue) -> yValue
checkScale(graph, axisName /* 'x'|'y' */, values) -> {
  ok, awkward /* perLarge mantissa not in {1, 2, 4, 5} */, fill /* fraction of grid spanned by data */,
  fitsOnGrid, labelEveryOk /* labelEvery <= 3 */, labelled, problems: []
}
checkPlotting(graph, table) -> { allPlotted, missingRows: [], points: [ { pointId, rowId, errX, errY /* small squares */ , ok } ], ok }
     // ok: every filled row with numeric x & y has a point within 0.5 small square in x and y
checkLine(graph, table) -> {
  present, nPoints, usedPoints, balanced, above, below, maxDev, lsq: { m, c } /* value units */,
  spansData, ok, problems: []
}
     // Balanced: ignoring circled anomalies, with ≥ 5 points: the student line evaluated at the smallest and
     // largest plotted x lies within tol of the least-squares line at those x, where
     // tol = max(1.0 small square, 1.5 × RMS of the LSQ residuals (small squares) without the largest one, so
     // one uncircled outlier cannot widen it), AND |#above − #below| ≤ 2, AND the drawn line extends across at
     // least 80 % of the data x-span. Only a circled anomaly may be ignored: with ≥ 5 uncircled points, a line
     // that follows the LSQ fit without a far-off point (> 3 small squares, > 3 × the others' scatter) rather
     // than the fit with it gives ignoresUncircled = true and is not balanced.
checkTriangle(graph) -> {
  present, hypFraction /* hypotenuse length / drawn line length */, bigEnough /* ≥ 0.5 */,
  onLine /* both vertices within 0.5 small square of the line */,
  readOffsOk /* typed read-offs equal the vertex values within 0.5 small square */, gradient /* from typed read-offs */,
  problems: []
}
checkIntercept(graph, typedValue) -> {
  falseOrigin /* x.origin !== 0 */, expected /* line y at x = 0 */, ok /* within 0.5 small square (y units) */, problems
}
VL.graph.clone(g), toJSON(g), fromJSON(o)
```

### 3.10 `VL.textmatch` — keyword/concept matcher for written answers (`core/textmatch.js`)

```js
VL.textmatch.normalize(text) -> string     // lower case, unify unicode, ' and ' spacing, strip punctuation,
                                           // simple stemming (readings→reading, timed→time ...)
Concept = {
  all:  [ group, ... ],   // every group must match; group = array of alternatives (plain phrases or /regex/ strings)
  none: [ group, ... ]    // optional: if any group matches the concept fails
}
VL.textmatch.matches(text, concept) -> boolean
MarkPointSpec = { id, label /* shown in report */, concepts: [Concept, ...] /* any one matching is enough */ }
VL.textmatch.markWritten(text, specs, { max }) -> {
  awarded, hits: [ { id, label } ], misses: [ { id, label } ], rejected: [ { text, reason } ]
}
VL.textmatch.splitItems(textOrArray) -> string[]   // numbered lines / bullet lines / array entries
VL.textmatch.GENERIC_REJECTS   // [{ concept, reason }] e.g. 'use more accurate equipment',
                               // bare 'repeat the experiment / readings', 'human error', bare 'parallax',
                               // 'use a computer', 'be more careful', 'reaction time' with no specific fix
VL.textmatch.markLimitationsImprovements(limItems, impItems, bank, { maxEach: 4 }) -> {
  limitations: { awarded, hits, misses, rejected }, improvements: { awarded, hits, misses, rejected }
}
   // bank = [ { id: 'A', limitation: { label, concepts }, improvement: { label, concepts } } ]
   // each bank row credited at most once per column; limitations and improvements marked independently
```

### 3.11 `VL.marking` — rubric runner + generic mark points (`core/marking.js`)

```js
MarkPoint = { id, part /* paper part id e.g. 'c', 'e-iii' */, skill: 'MMO'|'PDO'|'ACE', max, label,
              check(ctx) -> { awarded, comment, details? } }

VL.marking.run(exp, question) -> Report
Report = {
  expId, variantId, seed, total, max,
  skills: { MMO: { got, max }, PDO: { got, max }, ACE: { got, max } },
  parts:  [ { part, label, got, max } ],
  points: [ { id, part, skill, label, max, awarded, comment, details } ],
  modelAnswer,            // exp.modelAnswer(params, variantId, rng.fork('model'))
  commonMistakes: [],
  markedAt                // ISO string (passed in; never Date.now() inside pure functions where avoidable)
}

ctx = {
  exp, variantId, params, question, table, graph, answers, log,
  cols,        // VL.marking.identifyColumns(table, exp.quantities(variantId)) -> { quantityId: [colId, ...] }
  answer(key) -> string|array, num(str) -> sigfig.parse(str), vu(str) -> units.parseValueWithUnit(str)
}

VL.marking.identifyColumns(table, quantities) -> { map: { qId: [colIds] }, unknown: [colIds], details }
   // quantities = [ { id, symbols: ['T', 'period'], dims: { s: 1 }, kind: 'raw'|'derived', repeat?: bool,
   //                  names?: ['period', 'time for one oscillation'] } ]
   // match normalized heading symbol (case-sensitive) and unit dims; a raw quantity with repeat:true may map
   // to several columns ('t₁ / s', 't₂ / s'). Unmatched columns are reported, not fatal.
```

Cambridge accepts any name or symbol plus a unit, so headings are matched in stages (the first stage with a
candidate wins; inside every stage a quantity whose dims match the heading unit is preferred):

1. `symbol` — exact normalised symbol; 2. `pattern` — `'/regex/'` symbols; 3. `repeat` — repeat index stripped
   (`t1`, `t_1`, `t(1)`), repeat quantities only; 4. `mean` — `mean t`, `t̄`, `<t>` → the quantity with `meanOf`;
   5. `case` — case-insensitive, symbols of 3+ characters;
6. `name` — the heading quantity in lower case, with `²` and the word ` squared` written `^2`, is compared with
   each quantity's **`names`** (optional `string[]`: lower-case word forms such as `'length of string'`,
   `'period^2'`, or `'/regex/'` strings). Then a trailing `for <digits|n|one|ten|twenty> (complete)
   oscillation(s)/swing(s)` phrase and a repeat marker (trailing digits or subscripts, `(1)`, `_1`, a leading
   `1st|2nd|3rd|first|second|third`) are stripped and the exact and pattern symbol stages and `names` are tried
   again (`T squared` → `T^2`, `Time for 20 oscillations` → `time`). A stripped repeat marker is only allowed for
   a quantity with `repeat: true`.
7. `token` — each word of the heading quantity (ignoring filler words: the, of, for, a, an, time, length, period,
   mean, average, squared, string, pendulum, oscillations, swings, and numbers) is tried with the symbol, pattern
   and repeat stages, the last word first: `Length L` → L, `time t₁` → t (repeat), `period T` → T. If the words
   point to different quantities there is no match.

`details[colId].via` records the stage. A column that has values but matches no quantity is not marked; the
`readingsCount` "No column of X found" comment and the `headings` comment name it ("The column headed “…”
could not be matched to a quantity in this experiment, so it was not marked; use the symbol from the question,
e.g. L / cm."). `headings` keeps its mark; `spec.exampleQ` picks the quantity used for the example heading.

Generic mark-point factories (each returns a `MarkPoint`, or an array where stated). Every factory takes
`{ id, part, skill, label, ...specific }` and produces Cambridge-style comments.

| factory | awards when |
|---|---|
| `points.answerValue({key, dims, range /* SI [lo, hi] */, requireUnit = true, sf /* [min, max] optional */, dpOf /* instrument resolution in SI, optional */, reject /* optional fn(ctx, { si, vu, raw }) -> string\|null */})` | answer parses as value+unit (`x ± Δx unit` is marked as x), unit dims match, value in range, (precision matches instrument). `reject`: an experiment-specific objection, called when the unit is acceptable; a returned string is added to the problems and the mark is withheld (the pendulum uses it for a d that was not corrected for the vernier's hidden zero error, or had it added) |
| `points.readingsCount({xQ, yQs, full = 6, max = 3, trend: 'increasing'|'decreasing'|fn(sets, ctx)})` | full sets → max; each missing set −1; wrong trend → 0. A `yQs` entry may be an array of alternatives, any one of which completes a set (e.g. `[['t', 'tMean', 'T']]`) |
| `points.range({xQ, minSpanSI})` | span of x values (SI) ≥ minSpanSI |
| `points.repeats({q})` | ≥ 2 raw readings for every row (repeat columns) |
| `points.headings()` | every non-empty column heading has quantity and correctly separated unit with dims matching the identified quantity (or no unit for dimensionless / lg columns) |
| `points.rawConsistency({q})` | all raw values of q in the table have the same d.p. (and precision consistent with the instrument if `resolutionSI` given) |
| `points.derivedSF({q, from: [qIds]})` | every value of q has s.f. equal to the least s.f. of the raw data used, or one more; lg/ln columns: d.p. = s.f. of raw or one more |
| `points.calc({q, compute(rowValues) -> number})` | every value of q agrees with computation from the student's own raw values (within rounding) |
| `points.axes({xQ?, yQ?})` | both axes labelled with a quantity, scales not awkward, data fills ≥ half the grid both ways, scale labels ≤ 3 large squares apart. With `xQ`/`yQ`: the graph must plot yQ (y) against xQ (x), else 0 ("The question asks for a graph of T² (y-axis) against L (x-axis); your graph shows T against L." / "The axes are the wrong way round: …") |
| `points.plotting()` | `checkPlotting` ok and all rows plotted |
| `points.quality({tolY: (ctx) -> number /* value units of y */, xQ?, yQ?, minPoints = 5, requirePlotted = true})` | all points (one circled anomaly allowed) within tolY of a straight line (LSQ through the table values in SI). `requirePlotted`: also needs a graph (else "No graph drawn."), plotting yQ against xQ (else the wrong-graph comment), on which `checkPlotting` finds every table row with numbers in both columns plotted (circled anomalies count), at least minPoints ("All the points in the table (at least 5) must be plotted on your graph of T² against L for this mark.") |
| `points.bestFit()` | `checkLine` ok |
| `points.gradient({sign: +1|-1, xQ?, yQ?})` | triangle present, hypotenuse ≥ ½ line, read-offs within ½ small square, gradient answer = Δy/Δx from read-offs, sign right; with `xQ`/`yQ` the graph must plot yQ against xQ (as `axes`) |
| `points.intercept({xQ?, yQ?})` | direct read at x = 0 within ½ small square, or substitution with a point on the line; with `xQ`/`yQ` the graph must plot yQ against xQ (as `axes`) |
| `points.custom({check})` | anything experiment-specific |
| `util.graphQuantities(ctx)` → `{ x, y, xHeading, yHeading }` | quantity references plotted on the graph (`ctx.colInfo.details[graph.x.colId].qId`, `'lg(T)'` for an lg column; null if no column is chosen or it is unidentified); `util.wrongGraphComment(ctx, {xQ, yQ})` → '' or the wrong-graph comment |
| `points.sfJustification({key, rawWords: ['L', 't', 'd']})` | text links s.f. to the s.f. of raw data (not d.p.) |
| `points.percentUncertainty({absKey, pctKey, valueKey, absRangeSI})` | absolute uncertainty realistic and % correctly calculated |
| `points.conclusion({k1Key, k2Key})` | states a numerical criterion (e.g. 10 %) and the claim (supports / does not support) is consistent with the student's own % difference between k1 and k2 |
| `points.limitationsImprovements({limKey, impKey, bank, part})` → **array of 2 MarkPoints** (max 4 each, skill ACE) | via `VL.textmatch.markLimitationsImprovements` |

### 3.12 `VL.storage` (`core/storage.js`)

```js
VL.storage.available() -> boolean        // false if localStorage throws (private mode)
get(key, fallback), set(key, value), remove(key)     // JSON values, prefixed 'vlab1:'; never throw
saveSession(session), loadSession(id), listSessions() -> [summary], deleteSession(id)
saveSessionChecked(session) -> { ok: boolean, conflict: null|'changed'|'deleted', rev: number }
     // revision-checked save for an open workspace (two tabs on one session). Session.rev counts saves (missing =
     // 0). Reads the stored copy's rev: if the key is missing and session.rev > 0 → conflict 'deleted' (another tab
     // deleted it; nothing is written, so it is not re-created); if stored.rev !== (session.rev || 0) → conflict
     // 'changed' (another tab saved since; nothing written, rev = the stored rev). Otherwise session.rev is
     // incremented in place and written exactly like saveSession (index summary included) → { ok: true, rev }.
     // Storage full → { ok: false, conflict: null } and session.rev is left as it was.
     // saveSession keeps its plain boolean behaviour (session creation, import).
addProgress(entry), getProgress() -> entry[], clearProgress()
     // addProgress is idempotent: an entry with the same sessionId|qIndex|expId|variantId|seed as a stored one
     // replaces it in place (a question re-submitted after a failed save is one entry); entries without a
     // sessionId are always appended
getSettings() -> { examMinutes: 120, theme: 'light', hintsInPractice: true }, setSettings(patch)
```

### 3.13 `VL.export` (`core/export.js`)

```js
VL.export.tableToCSV(table) -> string        // RFC 4180, heading row first, strings exactly as typed, UTF-8 BOM
VL.export.download(filename, data /* string|Blob */, mime)
VL.export.downloadCanvasPNG(canvas, filename)
VL.export.pdf() -> PdfDoc   // tiny built-in PDF 1.4 writer, Helvetica, A4, auto page breaks
PdfDoc = { heading(text), text(text, { size, bold }), table(rows /* string[][] */), image(canvas, widthMm),
           pageBreak(), toBlob() }
   // Characters outside WinAnsi (Ω θ π λ ⁻ etc.) are transliterated (ohm, theta, pi, lambda, ^-).
VL.export.reportPDF({ session, question, report, graphCanvas }) -> Blob
```

### 3.14 Registry (`core/registry.js`)

```js
VL.registerExperiment(def)          // validates required fields, stores in VL.experimentsById
VL.getExperiment(id) -> def
VL.listExperiments({ style }?) -> def[]
```

## 4. Experiment contract (`experiments/<id>.js`)

```js
VL.registerExperiment({
  id: 'pendulum', title: 'Simple pendulum', topic: 'Oscillations / kinematics', seedPrefix: 'PEN',
  variants: [ { id: 'graph', style: 'Q1', title: '...' }, { id: 'twopoint', style: 'Q2', title: '...' } ],
  apparatusList(variantId) -> string[],          // shown in the paper ("You are provided with ...")
  sampleParams(rng, variantId) -> params,        // hidden; rng is already the 'params' fork
  model: { ... },                                // pure noise-free physics functions used by tests & marker
  knownValues: [ { name, actual: (VL) => number, expected, tol /* absolute */ } ],
  quantities(variantId) -> Quantity[],           // see VL.marking.identifyColumns
  paper(variantId, params) -> Paper,             // §6
  rubric(variantId) -> MarkPoint[],              // part ids must match Paper part ids; total = paper total
  modelAnswer(params, variantId, rng) -> { table, graph, answers, notes: [] },
  commonMistakes(variantId) -> string[],
  hints: { [partId]: string },                   // practice mode only
  createApparatus(ctx) -> Controller             // browser only
});
```

### 4.1 Apparatus controller (browser)

`ui/apparatusView.js` owns the canvas, the world→screen transform, zoom (wheel / pinch / +/− buttons, up to
×40, or further when the controller sets `maxPxPerCm`), pan (drag on empty space or with two fingers), the "eye
level" control (parallax) and the reading pad. The experiment owns the scene.

**The eye is a world height.** The student's eye is at a fixed world height `eyeY` (cm, y down), a horizontal
distance `eyeDist` in front of the apparatus (`controller.eyeDistance`, default 40 cm). It does **not** move when
the view is panned or zoomed, so a point at height y is seen at its own angle atan((y − eyeY) / eyeDist) and each
end of a length has its own parallax error: the student re-levels the eye ([ / ] or the eye control) at each end.
A zoom-target jump models walking over to look: it re-places the eye roughly level with the target, within
±(3–9)° of it (seeded), but never exactly level.

```js
ctx = { params, variantId, rng /* 'noise' fork */, services, savedState }
services = {
  mode: 'exam'|'practice', hints: boolean,
  log(event),              // append to question.log: { t: ms since question start, type, ... }
  now() -> ms,             // performance.now()
  stopwatch,               // shared Stopwatch instance for this question (widget rendered by apparatusView)
  requestRedraw(),
  focusWorld(x, y, zoom),  // pan/zoom the view (used by "zoom to" shortcuts); zoom relative to fit-to-world
  toast(message)           // practice-mode tips; suppressed in exam mode
}
Controller = {
  world: { width, height },                 // cm
  uses: ['stopwatch', ...],                 // shared bench tools to show
  draw(g, view),                            // g already in world coords; view = { scale /* css px per cm */, eyeAngle,
                                            //   eyeY, eyeDist,
                                            //   rect: { x, y, width, height, w, h } /* visible world cm */, now, dpr, zoom }
                                            // eyeAngle: degrees (+ = eye above) of the line of sight to the CENTRE of
                                            //   the view; eyeY: world y of the eye (cm, y down); eyeDist: horizontal
                                            //   distance of the eye from the apparatus (cm, default 40)
  update(dtSeconds, nowMs),                 // advance physics (call based on real elapsed time)
  pointer: { down(p, ev) -> bool, move(p, ev), up(p, ev) },   // p = {x, y} world cm; return true to capture
  controls(container, ui),                  // build DOM controls — no numeric truth shown. ui = VL.ui plus
                                            //   button(label, fn, { hold, title }), toggle(label, on, fn), group(label), note(text)
  zoomTargets: [ { id, label, x, y, zoom } ],   // zoom = factor relative to fit-to-world (1 = whole world, max 40),
                                            // the same factor as the +/− buttons; x, y, zoom may be getters
  maxPxPerCm?: number,                      // optional: the view may zoom in until the scale reaches this many css px
                                            //   per world cm, even beyond ×40 (fine scales such as a 0.02 mm vernier)
  eyeDistance?: number,                     // optional: eyeDist in cm (default 40)
  isAnimating?() -> boolean,                // optional: true while anything in the scene changes with time without
                                            //   input (swinging, settling); when false the view may stop redrawing
                                            //   until requestRedraw(), pointer or view changes. Absent: redraw every
                                            //   frame. Every state change made by controls or pointer input must call
                                            //   services.requestRedraw().
  snapshot() -> object,                     // hidden true state, logged with every Record
  onStopwatchEvent(kind, info) -> object?,  // extra hidden truth to log at start/stop
  getState() -> object, setState(obj),
  destroy()
}
```

**Record flow.** The reading pad (an input + "Record" button, Enter or `R`) writes the typed string into the
current *record target* (the last focused table cell or paper answer box — tracked by `ui/app.js`) and logs
`{ type: 'record', typed, target, snapshot: controller.snapshot() }`. Typing directly into cells is also
allowed. **Nothing is ever auto-filled.** A record target belongs to the tab that shows it (`target.tab`):
switching to another tab clears it, so Record then goes to Rough notes (the narrow-layout Apparatus / Paper toggle
is not a tab change and keeps it). A box that already holds a *different* value is never overwritten silently:
nothing is written and the pad asks "“old” is already in <label>. Replace it?" (Enter / Replace overwrites, Esc /
Cancel keeps the typed reading in the pad). After a successful Record the pad is cleared and the focus returns to
the apparatus canvas, so X and Space work the stopwatch at once.

## 5. Session data model (saved to localStorage)

```js
Session = {
  id, mode: 'exam'|'practice'|'drill', created /* ISO */, updated, title,
  examMinutes /* exam only */, elapsedMs, finished,
  questions: [ Question ]
}
Question = {
  qid: 'q1', expId, variantId, seed,
  apparatusState, table /* Table */, graph /* Graph */,
  answers: { [key]: string | string[] },
  log: [ ... ], startedAt, submitted: false, report: null | Report
}
ProgressEntry = { sessionId, date, mode, expId, variantId, seed, total, max, skills: { MMO, PDO, ACE },
                  qIndex? /* index of the question in the session; part of the addProgress identity */ }
// Session.rev?: number of revision-checked saves (VL.storage.saveSessionChecked)
```

## 6. Paper format

```js
Paper = {
  title: 'Question 1', totalMarks: 20,
  intro: 'In this experiment, you will investigate ...',          // trusted HTML authored by us
  apparatusNote: 'You may not need to use all of the apparatus provided.',
  parts: [
    { id: 'a', label: '(a)', marks: 1, html: '...', answers: [ { key: 'd', type: 'value', prefix: 'd =' } ] },
    { id: 'b', label: '(b)', html: '...', subparts: [ { id: 'b-i', label: '(i)', marks: 1, html, answers } ] },
    { id: 'c', label: '(c)', marks: 10, html: '...', answers: [ { type: 'table' } ] },
    { id: 'd-i', label: '(d)(i)', marks: 3, html: '...', answers: [ { type: 'graph' } ] },
    { id: 'd-iii', ..., answers: [ { key: 'gradient', type: 'value', prefix: 'gradient =' } ],
      tools: [ 'gradient', 'intercept' ] }
  ]
}
answer types: 'value' (one line), 'text' (textarea), 'list' ({count} numbered boxes → string[]),
              'working' (textarea stored under key + '_working' plus a value line under key),
              'table' / 'graph' (links to the Table / Graph tabs, with a status line)
```
Marks appear in square brackets in the right margin, e.g. `[1]`. Part ids are the join keys between paper,
rubric and report.

## 7. Cambridge Paper 3 conventions the marker enforces

* **Headings**: `quantity / unit` (preferred) or `quantity (unit)`; unit must match the quantity's dimensions;
  no unit for dimensionless quantities; `lg (T / s)` for logs.
* **Raw data**: every raw value of a quantity to the same number of d.p., matching the instrument resolution
  (e.g. lengths read with a metre rule to the nearest mm → `50.0 cm` or `0.500 m`; stopwatch to 0.01 s).
* **Derived data**: s.f. equal to the least s.f. of the raw data used, or one more. lg values: d.p. equal to the
  s.f. of the raw value, or one more.
* **Graph**: labelled axes; sensible scales (1, 2, 4 or 5 × 10ⁿ per large square; no 3s, 6s, 7s, 9s); plotted
  points occupy at least half the grid in each direction; scale labels no more than 3 large squares apart;
  points within half a small square; thin best-fit line with balanced scatter; only a circled/labelled anomaly
  may be ignored.
* **Gradient**: triangle hypotenuse at least half the length of the drawn line; read-offs within half a small
  square; Δy/Δx from read-offs. **Intercept**: read at x = 0 if the x-axis starts at 0, otherwise calculate by
  substituting a point on the line into y = mx + c.
* **Q2-style**: justify s.f. by reference to the s.f. (not d.p.) of the raw readings; conclusion must state a
  numerical criterion (e.g. "within 10 %") and be consistent with the student's own k values; four limitations
  and four improvements marked independently (max 4 each); generic answers earn nothing.
* **[verify]** items (couldn't access the syllabus while building): exact skill minima, 2 h duration,
  allowed scale multiples (we allow 1, 2, 4, 5), heading styles accepted.

## 8. Keyboard shortcuts (handled in `ui/shortcuts.js`; ignored while typing in an input except where noted)

| key | action |
|---|---|
| Space | stopwatch start / stop |
| X | stopwatch reset |
| R / Enter in reading pad | record reading to the current target (Enter / Esc answer a pending “Replace it?”) |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y | undo / redo (table or graph, whichever is active) |
| + / − / 0 | zoom in / out / reset apparatus view |
| [ / ] | eye lower / higher (parallax) |
| Alt+1 … Alt+5 | switch right-panel tab (Paper, Table, Graph, Tools, Report) |
| ? | show shortcut help |

## 9. UI layout & styling

* Header: app name, mode, experiment, **seed** (copy button), timer (exam), save status, menu. On small screens
  (`max-width: 560px` or `max-height: 560px`) it is one wrapping row (Menu, timer, Apparatus / Paper); the question
  switch, seed, save status and Submit / Finish exam move into the Menu.
* Main (≥ 900 px wide): **left** apparatus panel (~58 %), **right** tabbed panel: Paper · Table · Graph ·
  Tools · Report. Below 900 px: one column with an Apparatus / Paper toggle. Touch targets ≥ 44 px (36 px for
  `pointer: fine` in the compact apparatus control strip). In the wide layout the left column does not scroll: the
  stage flexes (min 240 px) and the lower area (stopwatch + reading pad side by side, then the controls) takes at
  most 40 % of the column and scrolls inside itself, so the apparatus and its controls are on screen together.
* Saving: the workspace saves with `VL.storage.saveSessionChecked`. On a conflict (another tab changed or deleted
  the session, also detected from window `storage` events) it stops saving, turns read-only and shows a blocking
  dialog (Reload this session / Close); the save status reads "Not saved — changed elsewhere". A failed save shows
  a dismissible banner; progress entries (with `qIndex`) are only added after the marked session has been stored.
* High contrast, focus rings (`--focus`), font ≥ 16 px, never colour-only signalling (✓/✗ + text).
* Stylesheets: `styles/tokens.css` (shared variables — do not edit), `styles/main.css` (shell), and one
  stylesheet per component prefix: tableView `.vt-` → `styles/table.css`, graphView `.vg-` → `styles/graph.css`,
  instrument lab `.vi-` → `styles/instruments.css`, drills `.vd-` → `styles/drills.css`, progress `.vp-` →
  `styles/progress.css`, shell/paper/report `.vl-` → `styles/main.css`.
* Shared DOM helpers: `ui/dom.js` (`VL.ui.h`, `VL.ui.clear`, `VL.ui.on`, `VL.ui.debounce`, `VL.ui.bus`).

UI component APIs (all browser-only):

```js
VL.ui.tableView.mount(container, table, { readOnly, hints, onChange(table), onFocusCell(target) })
   -> { destroy(), writeToSelected(str) -> bool, undo(), redo(), refresh(table?) }
VL.ui.graphView.mount(container, graph, table, { readOnly, hints, extension /* worst line */, onChange(graph),
                      dpr? /* fixed device px per css px, e.g. 2 for exports */ })
   -> { destroy(), canvas, undo(), redo(), refresh(graph?, table?), renderClean() -> canvas /* no hover, selection
        or loupe */, gridToClient(gx, gy), loupeShown() /* tests */ }
   // the worked Δy/Δx and intercept substitution are shown only when hints is true (practice with hints)
VL.ui.apparatusView.mount(container, { exp, question, services, params?, readOnly?, readOnlyText?,
                          onRecord(str, { confirmed }) -> { label } | { needsConfirm: true, old, label } | null,
                          onChange(kind) })
   -> { el, controller, stopwatch, services, params, destroy(), record({ confirmed }?) -> bool, focusPad(),
        setTargetLabel(label|null), saveState(), zoomIn(), zoomOut(), zoomReset(), goToTarget(t), eyeLower(),
        eyeHigher(), getEye() /* angle at the view centre */, setEye(deg), getEyeY(), setEyeY(y),
        getView() -> { cx, cy, z, fit, width, height, zMax }, getZoomMax(), setView(v) /* tests */,
        stopwatchToggle(), stopwatchReset(), hasStopwatch(), reloadApparatus() }
   // zMax = max(40, controller.maxPxPerCm / fit), recomputed on resize. The eye (§4.1): pan / zoom / Fit /
   // focusWorld keep eyeY; goToTarget(t) re-places it at a seeded ±(3–9)° (VL.rng.create(seed + '/eye/' + n));
   // the slider, [ / ] and setEye(deg) set it relative to the view centre (±15°). In practice with hints a dashed
   // "your eye level" line (or an edge tab) and a note under the slider are shown; never in an exam.
   // Redraws only while dirty, animating, controller.isAnimating() or an error banner shows. Errors from
   // controller.update / draw show a stage message (hidden after 30 clean frames); after 60 failures the
   // apparatus stops and offers "Reload apparatus" (rebuilds from question.apparatusState).
VL.ui.paperView.mount(container, { paper, answers, readOnly, hints, onAnswer(key, value), onFocusAnswer(target), onGoto(tab) })
VL.ui.reportView.mount(container, { exp, question, report })
   // Graph (PNG) / Report (PDF) always draw the graph in an off-screen read-only graphView (892×692 css px at
   // dpr 2), never the live Graph tab, so exports are the same size and free of hover / loupe.
VL.ui.uncertaintyView.mount(container, { graph, table, extension })
VL.ui.calculator.mount(container)
VL.ui.instrumentLab.mount(container)
VL.ui.drillsView.mount(container, { storage })
VL.ui.progressView.mount(container)
// record target = { kind: 'cell'|'answer', tab: 'paper'|'table'|…, label, write(str) -> bool, current() -> string,
//                   appends? /* text boxes: write() adds text, no "Replace it?" */ }
// Workspace.recordTo(str, { confirmed }) -> { label } | { needsConfirm, old, label } | null (no target)
// VL.ui.app.progressEntry(session, q, report, qIndex?) -> ProgressEntry (qIndex set when given)
```

## 10. Tests

* `node tests/run-node.js` — loads `tests/manifest.js` (source list + test list) into a Node `vm` sandbox
  (`globalThis` only, no DOM), then `tests/harness.js`, then each test file. Missing files are reported as
  skipped. Exit code 1 on any failure.
* `tests/index.html` — the same tests in a browser, no Node needed.
* Test API (global): `test(name, fn)`, `assert.ok(v, msg)`, `assert.equal(a, b, msg)`,
  `assert.deepEqual(a, b, msg)`, `assert.close(actual, expected, tol, msg)`, `assert.throws(fn, msg)`,
  `assert.match(str, regex, msg)`.
* Every experiment has `tests/experiments/<id>.test.js` that sets `VLab.noise.level = 0` and checks
  `knownValues`, paper/rubric mark totals and part-id consistency, and that a model answer marks highly.
* `tests/manifest.js` lists the `ui/*.js` sources too (none touches the DOM at load time) and the UI tests
  `tests/ui/calculator.test.js`, `tests/ui/shell.test.js`.
* Tests that run in the browser must never touch the real `localStorage`: on `file://` the test page shares its
  storage with the app. `tests/core/storage.test.js` uses an isolated memory backend there.
* `tests/e2e/smoke.js` (dev only): `node tests/e2e/smoke.js` drives the real `index.html` from `file://` in headless
  Chromium via Playwright (practice flow end to end, reload/resume, exam, exports, lab, drills, progress, sessions,
  tablet viewport). It fails on any failed check, console error, page error or failed file request. Screenshots go
  to `$SMOKE_SCREENS` (default `<tmpdir>/vlab-smoke`).

## 11. As built — additions every module relies on

The modules were built in parallel against this contract; these are the additive APIs and conventions that the
integrated app actually depends on. They extend (never contradict) the sections above.

* **Instruments** (§3.7): `define(type, factory(inst, opts, rng), meta?)`; `create(type, opts, rng)` uses `rng`
  only for the zero error (one `VL.noise.zeroError` call; `opts.zeroError` forces it). Digital flicker is a pure
  hash of the seed and time, so it consumes no draws. Also `list()`, `util` (drawing helpers such as `lineW`, `text`,
  `roundRect`, `parallaxShift`), `apparentShift(gap, view)` and `formatTime(s)`.
  `stopwatchWidget(container, sw, { onEvent(kind, { nowMs, elapsed, display, reading }), now, label })` →
  `{ el, destroy, toggle, reset, refresh }`.
* **Graph** (§3.9): `valueToGrid(axis, value, small = 10)` and `gridToValue(axis, g, small = 10)`;
  `addPoint(graph, rowId, gx, gy)`; `lineValueAt`, `checkLine` also fails a line that ignores an *uncircled*
  outlier (`ignoresUncircled`); at most one circled anomaly. `modelGraph(table, xColId, yColId, opts)` builds an
  examiner-quality graph for model answers only. `history(graph)` gives snapshot undo/redo.
* **Marking** (§3.11): `createContext(exp, question, params?)`; `calc` and `answerCalc` compute in SI; quantity
  references `'T'`, `'lg(T)'`; optional `Quantity` fields `label`, `unit` (assumed unit for headings with none),
  `unitHint`, `meanOf`; a heading without a unit is taken to be in SI units (comments say so).
* **Experiments** (§4): `hints` may be a per-variant map (`{ graph: { partId: html }, ... }`), resolved by
  `VL.ui.app.hintsFor`. `modelAnswer` may also return `log` (simulated lab log); log-based mark points need it, so a
  model answer is marked with `question.log = modelAnswer.log`. `apparatusView` passes `savedState` to
  `createApparatus` **and** calls `controller.setState(savedState)` afterwards, so `setState` must be idempotent.
  Optional `controller.pointer.hover(p) -> bool`. `update(dt, nowMs)` is sub-stepped (≤ 0.1 s per call).
* **Apparatus scene**: the experiment draws in physical colours. The view clears the canvas to a light "lab wall"
  colour in both themes (`--bench` in the light theme, a dimmer light grey in the dark theme).
* **Sessions** (§5): additive Question fields `roughNotes: string[]`,
  `viewState: { cx, cy, z, eye /* centre angle, kept for older readers */, eyeY, eyeJumps }`,
  `stopwatchState: { elapsed, running }` (restored stopped at `elapsed`; nothing is logged), `markError`;
  Session fields `seed`, `hints`, `currentQ`. `ProgressEntry.skills` values are `{ got, max }`.
* **UI** (§9): `VL.ui.dialog` (`open/confirm/alert`, Promise-based), `VL.ui.app`, `VL.ui.timer`,
  `VL.ui.shortcuts.setContext/resolve`. Bus events: `table:changed`, `graph:plotRow`, `theme:changed`,
  `progress:changed`. Paper answer inputs carry `data-key` (and `data-index` for list items); graph fields carry
  `data-field`; `graphView` returns `gridToClient(gx, gy)` for tests. Components that handle Space, arrows or
  Ctrl+Z themselves call `preventDefault()`; `ui/shortcuts.js` listens in the bubble phase and ignores
  `defaultPrevented` events, so nothing is handled twice.


## 12. Circuit engine and Circuit lab

**`VL.circuit` (`core/circuit.js`)** — pure, runs in Node.

```js
Circuit = { seed, parts: [{ id, type, x, y, settings, ref?, truth? }], wires: [{ id, a: { part, term }, b, color }], nextId }
VL.circuit.types[type] = { label, group, symbol, category, terminals: [{ id, label }], symmetric?, settings: [spec],
                           describe, hidden(rng, settings), elements(ctx), readout?(ctx, res), dynamics?(ctx, res, dt),
                           iterate?(ctx, res), limit?(ctx, res) }
create(seed), addPart(c, type, x, y, settings?), removePart(c, id), addWire(c, a, b, colour?) -> wire | null,
removeWire(c, id), getPart(c, id), hidden(c, part), nets(c), defaultSettings(type), fmtOhm(R), rangeMax(name)
createSim(c, savedState?) -> { solve(), step(dt), hidden(part), repair(partId), getState(), state }
   solve()/step() -> { ok, converged, parts: { id: { reading?, unit?, current?, terminalPd?, terminalV, power?,
                       brightness?, blown?, over?, reversed?, ... } }, warnings: [{ part, kind, text }], events }
matchTemplate(c, { parts: [{ ref, category, polar?, label }], nets: [['ref:term', ...]] })
   -> { ok, problems, reversed, extra, missing }
```

* Types: `cell battery psu switch resistor unknownR rbox rheostat pot wire ammeter voltmeter dmm lamp diode led
  thermistor ldr capacitor`.
* Hidden values come from `VL.rng.create(seed + '/' + partId + '/' + type + '/' + value-defining settings)`. They
  respect `VL.noise.level`: at 0, every part gets its nominal or mid-range value. `part.truth` overrides them in tests
  and experiments.
* Solver elements: `R` (resistor), `V` (e.m.f. with internal resistance, stamped as a Norton source), `D` (Shockley
  diode, Newton with step limiting), `C` (backward-Euler companion model when `dt > 0`). Each connected piece of the
  circuit gets its own reference node, plus GMIN to that reference.
* Lamp resistance R ∝ T^1.2 with radiative balance. This is resolved by an outer fixed-point loop, which is also
  used for power-supply current limiting.
* Multimeter sockets: COM, V (VΩmA: volts, ohms and the mA ranges, with a 250 mA fuse) and A (20A, always joined to
  COM through a shunt of about 0.01 Ω).

**`VL.circuitTemplates`** — `list`, `get(id)`, `build(tpl, seed, { wired })`, `termFor(part, term)`.

**`VL.ui.circuitSymbols`** — `drawSymbol(g, sym, p, q, u, opts)`, `drawDiagram(g, diagram, box, opts)`, `icon(sym, size)`.

**`VL.ui.circuitBench.createController(ctx, { circuit, onChange, onWarnings, onSelect })`** — an apparatus controller
(§4.1). Its world is 120 × 76 cm. Extra API: `select`, `selection`, `removeSelected`, `addPart`, `result`,
`resolve`, `refreshPanel`, `sim`, `termPos`.

**`VL.ui.circuitLab.mount(container, { headerCtx, headerBar, toast })`** — the `#/circuits` page. It mounts the bench
in `apparatusView` through a pseudo-experiment, with Circuit / Table / Graph / Tools tabs, and stores its state under
the storage key `circuitlab`. Test hook: `VL._circuitLabPage`.
