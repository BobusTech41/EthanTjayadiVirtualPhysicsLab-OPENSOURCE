# Experiment spec — Simple pendulum (`experiments/pendulum.js`)

id `pendulum`, seedPrefix `PEN`, topic "Oscillations / kinematics".
Variants: `graph` (style Q1, 20 marks) and `twopoint` (style Q2, 20 marks).

## Hidden physics (`model`)

* L = length of string from the **bottom of the split cork** to the **top of the bob** (what the student measures).
* Effective length L_eff = L + r + δ, where r = d/2 is the bob radius and δ is the hidden pivot offset
  (the string actually flexes a little inside / below the cork).
* Period: T = 2π √(L_eff / g) · (1 + θ₀²/16), with θ₀ = current angular amplitude in radians, g = 9.81 m s⁻².
* Damping: θ(t) = θ₀ e^(−t/τ) cos(2πt/T + φ).
* Hidden parameters (`sampleParams(rng)`):
  * d: bob diameter, uniform 1.80–2.60 cm (true value, to 0.001 cm)
  * δ: pivot offset 0.00–0.40 cm
  * τ: damping time constant 60–150 s
  * vernier type: resolution 0.1 mm or 0.02 mm (50/50); vernier zero error via `VL.noise.zeroError` (chance 0.3)
  * eyeStart: initial eye angle for parallax, ±(3–9)°
  * slipChance: anomaly — after a length change, on first release the string slips by 0.3–0.8 cm with
    probability `VL.noise.anomalyRate` (logged hidden as `{ type: 'anomaly', kind: 'slip', amount }`).
  * ruleStartY: world y of the metre rule's zero mark at the start, 1–3 cm above the bottom of the cork (not lined
    up: the student aligns it or reads both ends). It is the LAST draw, so adding it changed no other parameter;
    sessions saved before it existed start the zero 2 cm above the cork.
* `model.period(Lcm, dcm, deltacm, amplitudeDeg)` → s; `model.Leff(...)`; `model.gFromGradient(a, unit)`.
* `knownValues`: T(L = 100.0 cm, d = 0, δ = 0, 0°) = 2.006 s; T(24.53 cm, 0, 0, 0) = 0.9935 s ±0.001;
  amplitude factor at 10° = 1.0019; `gFromGradient(4.024 s² m⁻¹)` = 9.81 m s⁻² (±0.01).

## Apparatus (createApparatus)

World ≈ 110 cm wide × 130 cm tall (cm, y down). Draw at physical scale so that scale markings need zooming.

* Bench, retort stand, boss and clamp holding a **split cork** near the top (pivot = bottom of cork, x ≈ 45, y ≈ 12).
* String + spherical metal bob (diameter d). Bob swings with θ(t); drawn in real time from `services.now()`.
* **Metre rule** (VL.instruments metreRule) standing vertically beside the string, **draggable** (vertical and
  horizontal) so the student can align its zero with the cork or read two positions and subtract. The string/bob
  is ~1.5 cm in front of the rule → parallax shift `VL.noise.parallaxShift(1.5, eyeAngle)` applied to the apparent
  positions of the cork bottom and bob top relative to the scale (the rule is drawn shifted by the angle at the
  centre of the view; `snapshot().ruleReadings.corkSeen / bobTopSeen` record what is seen). The eye is a fixed
  world height (`view.eyeY`, also in the snapshot) that does not move with the view, so the cork and the bob are
  seen at different angles: the student must move the eye level with the cork to read the cork, then down level
  with the top of the bob to read the bob. Zoom-target jumps leave the eye roughly (±3–9°), not exactly, level.
  The rule's edge face is not a usable cue here (for a vertical rule it shows only at the rule's ends), so the
  hints teach re-levelling the eye at each end; practice mode with hints shows a sight-line cue.
* **Protractor** fixed behind the pivot (for reading the release angle). It hangs upside down with its centre at
  the cork, so a vertical string reads 90° and the angle from the vertical is |90° − reading|; hint (c), the model
  note (c) and the "Pull bob aside" control explain this. It is drawn after (in front of) the rule, which shows
  through its semi-transparent body, so the graduations near 90° stay readable with the rule beside the string.
* **Vernier callipers** on the bench (inset area at the bottom of the world) holding a spare identical bob:
  the student drags the sliding jaw; it stops at contact (opening = d·10 mm ± 0.01 mm squeeze). Reading =
  `readingFor(opening)` (includes zero error). A "Close jaws (check zero)" control shows the zero reading.
* **Stopwatch**: shared (`services.stopwatch`, `uses: ['stopwatch']`). Real time.
* Optional **fiducial marker** (toggle): a vertical pointer at the centre of the swing — a credited technique.
* Controls (DOM, no numbers revealed): "Shorten string" / "Lengthen string" (hold-to-repeat, 0.5 cm steps,
  plus fine 1 mm steps), "Pull bob aside" by dragging the bob in the canvas (release on pointer-up starts the
  swing), "Stop the bob", "Fiducial marker on/off", "Close vernier jaws", "Open vernier jaws".
  Length range 10.0–100.0 cm; amplitude range 0–30°.
* `zoomTargets`: cork & rule top, bob & rule, protractor, vernier scale.
* `snapshot()`: `{ L, d, delta, Leff, T, amplitudeDeg, swinging, ruleOffset, vernierOpening, vernierZeroError, eyeAngle,
  eyeY, ruleReadings: { cork, bobTop, corkSeen, bobTopSeen } }`.
* `onStopwatchEvent('stop', info)`: return `{ elapsedTrue, oscillationsTrue: elapsed / T, amplitudeDeg, L }`.
* State persists via getState/setState (L, rule position, vernier opening, swinging state).

## Variant `graph` (Q1) — paper & rubric (20 marks)

Original wording in Cambridge style ("In this experiment, you will investigate how the period T of a simple
pendulum depends on the length L of the string."). Parts and marks:

| part | content | marks | mark points (skill) |
|---|---|---|---|
| a | Measure the diameter d of the bob with the vernier callipers. `d =` | 1 | d within ±0.03 cm of true (after zero error) with unit, to 0.01 cm (0.1 mm vernier) or 0.002 cm (0.02 mm vernier); with a hidden zero error, a value that cannot be a careful corrected reading (more than half a division + 0.01 mm squeeze from true) and is nearer the uncorrected scale reading (true + z), or nearer reading + z (zero error added), scores 0 (MMO) |
| b | Set L ≈ 50 cm, measure and record L. `L =` | 1 | L within 50 ± 5 cm (the length asked for), within ±0.3 cm of the hidden L at the time, to the nearest mm, with unit (MMO) |
| c | Displace the bob through a small angle, release, take measurements to find T. `T =` | 1 | evidence (log + answer) of timing ≥ 10 oscillations and repeating — one timing per stopwatch reset cycle (the watch accumulates over start/stop), so a stop without a reset is not a repeat; T within 3 % of true (MMO) |
| d | Change L and repeat until you have six sets of L and T. Include T² in your table. | 8 | readingsCount 6 → 3 (MMO 3); range: L span ≥ 40 cm (MMO 1); headings (PDO 1); raw L consistency to nearest mm (PDO 1); s.f. of T² (PDO 1); calculation of T² from the student's T (PDO 1) |
| e-i | Plot T² (y) against L (x). | 3 | axes (PDO 1); plotting (PDO 1); quality: all points within ±0.04 s² of a straight line (or ±1 % of the T² range, whichever larger) (MMO 1) |
| e-ii | Draw the line of best fit. | 1 | bestFit (PDO 1) |
| e-iii | Determine the gradient and y-intercept. | 2 | gradient (ACE 1); intercept (ACE 1) |
| f | T² = aL + b — find a and b with units. | 2 | a = gradient and b = intercept (ECF) (ACE 1); units of a (s² cm⁻¹ or s² m⁻¹) and b (s²) (ACE 1) |
| g | Use a to find g. `g =` | 1 | g = 4π²/a (ECF, unit conversion), unit m s⁻², 2–3 s.f., within 9.81 ± 10 % (ACE 1) |

Totals: MMO 8, PDO 7, ACE 5 = 20.

Quantities for column identification: `d` (raw, m), `L` (raw, m), `t` (raw time for n oscillations, s, repeat:
symbols `t`, `t1`, `t2`, `t₁`, `t₂`, `10T`, `20T`, `nT`, `t/s`…), `tMean` (derived, s), `n` (raw, dimensionless,
optional), `T` (derived, s), `T2` (derived, s², symbols `T²`, `T^2`, `T2`).

## Variant `twopoint` (Q2) — paper & rubric (20 marks)

"It is suggested that T² is proportional to (L + d/2)." Two lengths, compute k = T² / (L + d/2) twice.

| part | content | marks | mark points (skill) |
|---|---|---|---|
| a | Measure d with the vernier callipers. | 1 | as Q1 (MMO) |
| b | Estimate the percentage uncertainty in d. | 1 | absolute uncertainty 0.01–0.05 cm (or 0.002–0.05 cm for the 0.02 mm vernier) and % correctly calculated (ACE) |
| c-i | Set L ≈ 30 cm. Record L. | 1 | L within 30 ± 5 cm, within ±0.3 cm of the hidden L, nearest mm, unit (MMO) |
| c-ii | Determine T (show repeated timings of several oscillations). | 2 | raw times of ≥ 10 oscillations repeated (MMO 1); T within 3 % of true (MMO 1) |
| d | Set L ≈ 80 cm; repeat (c). | 3 | second L (within 80 ± 5 cm) and raw times present (MMO 1); T within 3 % of true (MMO 1); trend T₂ > T₁ (MMO 1) |
| e-i | Calculate k for both sets. | 1 | both k calculated correctly from the student's own values (PDO) |
| e-ii | Justify the number of s.f. in your values of k. | 1 | sfJustification: refers to s.f. of L (and d) and t/T (PDO) |
| f | Explain whether your results support the suggestion. | 1 | conclusion with stated numerical criterion consistent with own k values (ACE) |
| g | Use your results to find g. | 1 | g = 4π²/k̄ with unit, value 9.81 ± 15 % (ACE); no s.f. condition (the paper asks only for a unit) |
| h-i | Four limitations / sources of uncertainty. | 4 | limitationsImprovements (ACE, max 4) |
| h-ii | Four improvements. | 4 | limitationsImprovements (ACE, max 4) |

Totals: MMO 7, PDO 2, ACE 11 = 20. (Paper 3 skill minima Q2: MMO ≥ 5, PDO ≥ 2, ACE ≥ 10 — satisfied.)

### Limitations / improvements bank

| id | limitation (concepts) | improvement (concepts) |
|---|---|---|
| A | two readings / two sets of results are not enough to draw a valid conclusion | take more readings (more lengths) and plot a graph of T² against L |
| B | difficult to judge the start/end of an oscillation, or reaction time large compared with the time measured | use a fiducial marker at the centre of the swing; or time more oscillations (≥ 20); or use a light gate / video with a timer |
| C | difficult to measure L because the bob/cork/string position is hard to judge against the rule (rule not touching the string, parallax for that specific reason) | use a set square to transfer the bob/cork position to the rule; or clamp the rule vertically next to the string |
| D | amplitude not kept constant / large amplitude changes T | use the protractor to release from the same small angle (≤ 10°) each time |
| E | bob does not swing in a single plane / moves in an ellipse / twists ("side to side" alone describes the normal swing and only counts with motion out of the plane as well) | release more carefully from a fixed release point, or use a release mechanism / bifilar suspension |
| F | string slips in the cork / pivot point not fixed or not clearly defined | clamp the split cork tightly / check L after each set of oscillations (clamping the stand to the bench is not this improvement) |
| G | amplitude decreases (damping) during timing | use a denser or smaller bob to reduce air resistance (timing *fewer* oscillations is not credited: it raises the percentage reaction-time uncertainty, contradicting row B) |

Generic rejects (score 0): "use a more accurate stopwatch", bare "repeat readings", "human error", bare
"parallax error", "use a computer", "be more careful", "reaction time" without a specific fix.

## Model answer (`modelAnswer`)

Simulate a careful student with `rng`: d read correctly; lengths 20.0, 35.0, 50.0, 65.0, 80.0, 95.0 cm (Q1) or
30.0 / 80.0 cm (Q2); for each, two timings of 20 oscillations with reaction-time noise sd 0.08 s; table headings
`L / cm`, `t₁ / s`, `t₂ / s`, `T / s`, `T² / s²` with correct d.p./s.f.; a graph with good scales (fill > half
grid, 1/2/5 multiples), all points plotted exactly, LSQ best-fit line, large gradient triangle with exact read-offs,
intercept by substitution if false origin; answers for every key; for Q2 a stated criterion and the full A–F list.
`notes`: short explanations of each step.

## Common mistakes

Timing only one oscillation; not repeating timings; L recorded as "50 cm" (no mm precision); headings like "T²"
with no unit or "T² (s)"; T² to too many / too few s.f.; plotting T instead of T²; line forced through the origin;
small gradient triangle; reading the intercept at a false origin; forgetting to convert cm → m for g; generic
improvements such as "use better equipment".

## Hints (practice mode)

One short hint per part, e.g. (c) "Time at least 10–20 oscillations, start timing as the bob passes the centre,
and repeat."

## Tests (`tests/experiments/pendulum.test.js`)

With `VLab.noise.level = 0`: knownValues pass; for both variants, Σ part marks = 20 = Σ rubric max; every rubric
part id exists in the paper; skills total MMO/PDO/ACE match the tables above; `sampleParams` deterministic for a
given seed; `modelAnswer` marked by `VL.marking.run` scores ≥ 17/20 (Q1) and ≥ 15/20 (Q2).
