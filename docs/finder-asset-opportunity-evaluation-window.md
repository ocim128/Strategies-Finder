# Finder Asset Opportunity Evaluation Window Plan

Status: Implemented (2026-08-16) · Branch: `feat/asset-opportunity-eval-window` (temp worktree off
`chore/complexity-reduction` @ `e68505f`) · Scope: server-owned Finder Asset Opportunity **single + batch**
runs (options contract, iteration leaf, browser Asset Opportunity settings UI).

Per `docs/README.md` maintenance rules this is a temporary plan, not a durable guide: once shipped, fold the
behavior into the Asset Opportunity section of [finder-server-side.md](finder-server-side.md) and delete this
file.

## Problem

Asset Opportunity always scores each asset over its entire (gap-trimmed) history. Two recurring user needs
are not expressible today:

1. **Recency-bounded evaluation** — "measure performance on the last N bars only" (e.g. N = 1000), instead of
   the whole dataset. Also a speed win: candidate backtests scale with window length.
2. **Trailing window with a gap** — "last 2000 bars but only the first half" — i.e. evaluate bars
   `[-(N+M), -M)` where the newest M bars are excluded.

Need 2 already half-exists: `oosIgnoreLastBars` (M) trims the newest M bars from the in-sample window
(`lib/finder/finder-asset-opportunity-runner.ts:650`) and reserves them as the fixed OOS holdout. What is
missing is N: a cap on how far back the evaluation window reaches. The two settings compose — no new window
arithmetic concept is required.

This is commonly called a **lookback window** / **trailing evaluation window**. It is an exact-bar-count
extension of the fraction-based `FinderDataSlice` presets (`1`–`5`, halves), which Asset Opportunity already
applies via `sliceHistoricalWindow` (`lib/finder/finder-asset-opportunity-runner.ts:341`).

## Scope and Non-goals

In scope:

- One new optional numeric setting on the Asset Opportunity options block: `evalLastBars` (0 = disabled =
  full history, matching the `oosIgnoreLastBars: 0` convention).
- Browser settings UI (Asset Opportunity section), persisted UI state, request pass-through, server clamp,
  runner window application, diagnostics, JSONL run-log field, tests.

Non-goals (explicitly out):

- **Do NOT extend the shared `FinderDataSlice` enum** (`lib/types/finder.ts:18`). The Data Window dropdown is
  shared by all four Finder scopes; adding an N-bars mode there would force threading a numeric param through
  every `sliceFinderDataWindow` call site (current-chart, Universe, Strategy Quality, OOS) for an
  Asset-Opportunity-only need. If wanted later, promote `evalLastBars` to `FinderDataSlice` then.
- No changes to the Universe/Strategy Quality/current-chart paths, the worker pool, archive format, stream
  contracts, or the fresh-entry detection algorithm.
- No new routes, schemas, caches, or abstractions.

## Design

### Semantics

`evalLastBars` (N) is applied in `searchOneAsset` **after** the existing holdout trim and fraction slice —
it caps the in-sample window to the last N bars of `inSampleHistorical`:

| evalLastBars (N) | oosIgnoreLastBars (M) | Evaluated window (bar offsets from newest closed bar) |
| ---------------- | --------------------- | ----------------------------------------------------- |
| 0 (default)      | 0                     | all history before the application candle (today)     |
| 1000             | 0                     | `[-1000, -1]` (app candle still excluded, see guard)  |
| 1000             | 1000                  | `[-2000, -1001]` — the "first half of last 2000" case |
| 0                | 1000                  | all bars before the gap (today's fixed-holdout mode)  |

Properties:

- **Graceful short-history fallback**: an asset with fewer than N bars before the gap uses all of them
  (`Array.prototype.slice(-N)` semantics — no error).
- **Application-candle guard (load-bearing)**: `includeApplicationCandleInSearch`
  (`lib/finder/finder-asset-opportunity-runner.ts:671-673`) currently folds the application candle into the
  search window when `dataSlice === "all"` and there is no holdout. With N active it must NOT: the candle
  would be folded in and then re-captured by `.slice(-N)`, leaking the application candle into the search
  window. Extend the guard with `&& (input.options.assetOpportunity?.evalLastBars ?? 0) === 0`.
- **Fresh-entry recheck unchanged**: `canReuseIsSignalsForFresh` (`finder-asset-opportunity-runner.ts:716`)
  compares window lengths, so a shrunk window automatically takes the existing re-execute path (already the
  behavior for non-`all` fraction slices). The recheck itself still runs on the full boundary data — recent
  performance is bounded, but the live signal is still detected on the newest *visible* candle.
- **OOS holdout composition**: with M > 0 the hidden bars remain the fixed OOS holdout; N only narrows the IS
  window before the gap. The batch holdout sweep rebuilds the `assetOpportunity` block per iteration
  (`buildIterationOptions` in `lib/finder/server/finder-vite-plugin.ts`), so the field must be listed there
  explicitly — see Post-implementation Notes.
- **Diagnostics for free**: `diagnostics.slicedHistoricalBars` (`finder-asset-opportunity-runner.ts:701`)
  already records the post-slice length, so per-asset run diagnostics show the reduced window without extra
  work.

### UI decision

A single number input **"Eval Window Bars"** with `0 = all bars before the ignore-last gap`, placed next to
the existing "OOS Holdout Bars" row in `#finderAssetOpportunitySettings` (`html-partials/tab-finder.html:140`).
This mirrors the sibling `finderAssetOosIgnoreLastBars` control (`0 = disabled`), needs one DOM contract id
instead of two, and persists as a plain number. (A separate enable checkbox mirroring the Batch OOS toggle was
considered; rejected because the numeric `0 = off` convention is already the adjacent pattern. If a literal
toggle is preferred, add `finderAssetEvalWindowToggle` — the persisted-state pattern supports either.)

## Implementation Phases

### Phase 1 — Options contract and normalization

**Objective**: `evalLastBars` exists on the typed options contract, is normalized in one shared helper, and is
clamped server-side. Behavior at `0`/absent is byte-identical to today.

**Tasks**:

1. Add `evalLastBars?: number` to `FinderAssetOpportunityOptions` in `lib/types/finder.ts` (doc comment:
   `0`/undefined = evaluate all bars before any ignore-last gap).
2. Add `normalizeFinderAssetEvalLastBars(value: unknown): number` in `lib/finder/finder-asset-opportunity-oos.ts`
   next to `normalizeFinderAssetOosIgnoreLastBars` (line 85), mirroring its body: non-finite → `0`, else
   `round` + clamp to `[0, MAX_FINDER_ASSET_OOS_VALUE]`.
3. In `lib/finder/server/finder-vite-plugin.ts`, normalize the field inside the assetOpportunity
   reconstruction (lines 1698–1710) exactly like `oosIgnoreLastBars` at line 1702 — same import, same leaf
   module, no new dependency edges.

**Dependencies**: none.

**Risks**: none meaningful — additive optional field; `clampFinderOptions` (`lib/server-request-limits.ts:49`)
only touches `topN`/`maxRuns`, and the plugin spread at line 1701 already carries sibling fields through.

**Deliverables**: typed field + shared normalizer + server normalization.

**Validation/testing**: unit cases in `tests/finder-asset-opportunity-oos.spec.ts` (non-number → 0, negative → 0,
non-integer rounds, above-cap clamps); `npm run typecheck`.

**Exit criteria**: typecheck passes; normalizer spec green; a request without the field behaves exactly as
before (covered by existing plugin specs staying green).

### Phase 2 — Runner window application

**Objective**: `searchOneAsset` evaluates only the last N bars of the in-sample window; the application candle
cannot leak into the search; diagnostics and the JSONL run log record the setting.

**Tasks**:

1. In `lib/finder/finder-asset-opportunity-runner.ts` (~line 700), after `sliceHistoricalWindow`, apply
   `const evalLastBars = input.options.assetOpportunity?.evalLastBars ?? 0;` and, when `> 0`,
   `slicedHistorical = slicedHistorical.slice(-evalLastBars)`. Keep the existing empty-window failure path
   ("historical window empty after data slice", line 703–705) as the guard.
2. Extend `includeApplicationCandleInSearch` (lines 671–673) with the `evalLastBars === 0` condition described
   in Design.
3. Add `evalLastBars` to the `iteration_start` JSONL payload in `lib/finder/server/asset-opportunity-iteration.ts`
   (lines 210–217), next to `holdoutBars`.

**Dependencies**: Phase 1 (typed field + normalizer).

**Risks**:

- Missing the application-candle guard would silently include the live candle in ranking — the highest-risk
  detail of this feature; locked by a dedicated spec case.
- Fresh-entry recheck cost: with N active and no gap, signal reuse is disabled and every top-K candidate
  re-executes the recheck (the existing slow path for non-`all` slices). Accepted; noted under Performance.

**Deliverables**: window-capped search, guard fix, run-log field.

**Validation/testing**: extend `tests/finder-asset-opportunity-runner.spec.ts` with a window-slicing suite:
(1) N=1000 → injected `runIsSearch` receives exactly 1000 bars and `diagnostics.slicedHistoricalBars === 1000`;
(2) N=1000 + M=1000 → window is bars `[-2000, -1001]`, boundary signal anchored at the last visible bar;
(3) N>0 with no gap → application candle absent from the search window; (4) dataset shorter than N → all
gap-trimmed bars; (5) N=0 → identical input length to today (regression lock).

**Exit criteria**: runner spec suite green including the five cases; existing
`finder-asset-opportunity-oos.spec.ts` / `finder-asset-opportunity-batch-parallel.spec.ts` unchanged and green.

### Phase 3 — Browser UI and persistence

**Objective**: the setting is visible in the Asset Opportunity section, persisted, and sent with the run
request; no other scope's UI changes.

**Tasks**:

1. `html-partials/tab-finder.html`: new `param-row` inside `#finderAssetOpportunitySettings` mirroring the
   "OOS Holdout Bars" row (lines 153–154): label "Eval Window Bars", `<input type="number" id="finderAssetEvalWindowBars" value="0" min="0" max="100000">`, plus hint text `0 = all bars before the ignore-last gap`.
2. Register the input (and its row id if a row wrapper is used) in `lib/finder/finder-manager-dom.ts` next to
   `finderAssetOosIgnoreLastBars` (structural contract — id must exist in the partial or
   `tests/feature-dom-contracts.spec.ts` fails).
3. `lib/finder-manager.ts`:
   - `FinderPersistedUiState`: add `assetOpportunityEvalWindowBars: number` (near line 258), default `0` in
     `DEFAULT_FINDER_UI_STATE` (near line 340), normalized on load via the shared normalizer (near lines
     486–541), restored to the input near line 942, saved in the asset-settings change handler that already
     calls `saveUiState()`.
   - Options assembly at line 3454: set `evalLastBars` on `options.assetOpportunity` using
     `normalizeFinderAssetEvalLastBars(this.readFinderNumberInput(dom.finderAssetEvalWindowBars, 0, 0))`.
4. Update the fake DOM helper `tests/helpers/fake-finder-manager-dom.ts` with the new control so manager specs
   compile.

**Dependencies**: Phase 1 (normalizer), Phase 2 (field is meaningful server-side).

**Risks**: forgetting the DOM contract / fake-DOM update is the standard failure mode
("renamed UI id but forgot contract") — mitigated by `feature-dom-contracts.spec.ts` and typecheck.

**Deliverables**: UI control, persistence, request field.

**Validation/testing**: `tests/feature-dom-contracts.spec.ts`; `npm run typecheck`; `npm run typecheck:tests`.

**Exit criteria**: control appears in the Asset Opportunity section only, survives reload with its value, and
the POST body carries `options.assetOpportunity.evalLastBars` (assert in Phase 4 plugin spec).

### Phase 4 — Server contract tests and validation sweep

**Objective**: wire-level guarantees (clamp + pass-through) and the full validation habit pass.

**Tasks**:

1. Extend `tests/finder-server-plugin.spec.ts` (asset-opportunity run route): valid `evalLastBars` reaches the
   iteration input; invalid values (negative, `NaN`, string) normalize to `0` rather than 400 (mirroring
   `oosIgnoreLastBars` tolerance); one batch-route case asserting N survives the per-holdout options clone.
2. Run the AGENTS.md Finder validation habit:
   - `npm run typecheck`, `npm run typecheck:tests`
   - `esno tests/finder-server-plugin.spec.ts`
   - `esno tests/finder-asset-opportunity-runner.spec.ts`
   - `esno tests/finder-asset-opportunity-batch-parallel.spec.ts`
   - `esno tests/finder-asset-opportunity-oos.spec.ts`
   - `esno tests/feature-dom-contracts.spec.ts`
3. Manual smoke (`npm run dev`): single run with N=1000 over a few symbols (confirm per-asset diagnostics show
   the reduced window); N=1000 + M=1000 composition; batch holdout sweep with N set; Stop and reload reattach
   unaffected.

**Dependencies**: Phases 1–3.

**Risks**: none new — this phase only locks existing behavior in.

**Deliverables**: spec coverage, green validation matrix, smoke confirmation.

**Exit criteria**: all listed specs green; manual smoke confirms the three scenarios; nothing skipped silently.

## Affected Files / Modules

| File | Change |
| ---- | ------ |
| `lib/types/finder.ts` | `FinderAssetOpportunityOptions.evalLastBars?: number` |
| `lib/finder/finder-asset-opportunity-oos.ts` | `normalizeFinderAssetEvalLastBars` (mirror of line 85 helper) |
| `lib/finder/finder-asset-opportunity-runner.ts` | window slice after line 700; guard at lines 671–673 |
| `lib/finder/server/asset-opportunity-iteration.ts` | `evalLastBars` in `iteration_start` payload |
| `lib/finder/server/finder-vite-plugin.ts` | normalize field in assetOpportunity reconstruction (lines 1698–1710) |
| `html-partials/tab-finder.html` | "Eval Window Bars" row in `#finderAssetOpportunitySettings` |
| `lib/finder/finder-manager-dom.ts` | structural id(s) for the new input |
| `lib/finder-manager.ts` | persisted UI state + options assembly (lines ~258, ~340, ~486, ~942, 3454) |
| `tests/helpers/fake-finder-manager-dom.ts` | new control stub |
| `tests/finder-asset-opportunity-{runner,oos}.spec.ts`, `tests/finder-server-plugin.spec.ts`, `tests/feature-dom-contracts.spec.ts` | new cases |

## Data Flow

```
UI input (#finderAssetEvalWindowBars)
  → FinderManager UI state (persisted: assetOpportunityEvalWindowBars)
  → buildOptions: options.assetOpportunity.evalLastBars          (lib/finder-manager.ts:3454)
  → POST /api/finder/asset-opportunity-run (options serialized wholesale)
  → parseOptions → clampFinderOptions (untouched by it) → assetOpportunity
    reconstruction normalizes the field                            (finder-vite-plugin.ts:1698)
  → FinderAssetOpportunityRunInput.options
  → runAssetOpportunityIteration → runAssetOpportunitySearch → searchOneAsset
    → holdout trim (M) → sliceHistoricalWindow (fraction slice) → .slice(-N)   (runner:650,700)
  → IS search on N-bar window; fresh-entry recheck on full boundary data; fixed
    OOS holdout (M bars) unchanged
```

Batch mode clones `options` per holdout value, so N reaches every worker task unchanged (options cross the
worker boundary as JSON already; strategy objects do not — unchanged).

## APIs / Contracts

- Wire: additive optional JSON field `options.assetOpportunity.evalLastBars: number` on
  `POST /api/finder/asset-opportunity-run` and `POST /api/finder/asset-opportunity-batch-run`. No route, event,
  or scalar-row changes; the scalar-only stream contract is untouched.
- Persistence: additive `assetOpportunityEvalWindowBars` key in the Finder UI-state blob. Old payloads lack the
  key → normalizer defaults `0`; new payloads read fine on old code (unknown key ignored). No migration needed.
- No database/schema changes. No infrastructure or deployment changes (no new routes, env vars, or caches).

## Security

- No new endpoints; existing routes stay behind `isAllowedLocalRequest` (audit F1).
- The numeric field is normalized browser-side, again server-side (Phase 1 task 3) — a malformed payload cannot
  smuggle a nonsensical window. The clamp bound reuses `MAX_FINDER_ASSET_OOS_VALUE` (same 0–100000 envelope as
  the sibling input).

## Performance

- Candidate backtests scale with window length: N=1000 on a 100k-bar dataset makes each IS backtest ~100×
  cheaper; the dominant remaining cost is dataset loading, which is unchanged (the window is one cheap
  `.slice(-N)` per asset, not a new load path; per-job dataset caches are untouched).
- Known cost: fresh-entry signal reuse is disabled while N is active, so each top-K candidate re-executes its
  recheck on the boundary data (existing slow path; bounded by `candidatePoolSize` ≤ 50 and
  `ASSET_FRESH_RECHECK_CONCURRENCY`).

## Error Handling

- Invalid/absent input → `0` → today's behavior (silent-safe default, matching `oosIgnoreLastBars`).
- Asset with fewer than N bars → full gap-trimmed history (no error).
- Window empty after slicing → existing per-asset failure path ("historical window empty after data slice",
  runner lines 703–705) → asset surfaces as failed with reason, run continues.

## Rollback

Feature is additive and default-off (`0`). Revert the implementing commits; persisted UI state keeps a stale
key that old code ignores (and the load normalizer drops on next save). No migrations, no wire-version
dependencies, no cache invalidation. The `FINDER_ASSET_BATCH_WORKERS=1` rollback lever is unrelated and
untouched.

## Assumptions and Unknowns

- **Assumed**: the `0 = off` single-number control (no separate checkbox) satisfies "a toggle that if turned on
  I can pick any number" — the numeric 0/non-0 is the toggle, matching the adjacent OOS Holdout Bars control.
  Flagged for confirmation before Phase 3; the checkbox variant is a small, local change if preferred.
- **Assumed**: `MAX_FINDER_ASSET_OOS_VALUE` (100000) is an acceptable ceiling for N; it matches the dataset cap
  scale and the sibling input's HTML `max`.
- **Unknown (accepted)**: with small N, more candidates fall below the `minTrades` trade filter and more assets
  grade `no_fresh_entry`/`reject`. That is inherent to measuring on fewer bars, not a defect; worth one line in
  the shipped doc so users calibrate `minTrades` alongside N.
- **Out of scope by design**: identical capability in Universe / Strategy Quality / current-chart scopes.

## Post-implementation

Fold a short "Evaluation window" paragraph (semantics table + composition with the holdout gap) into
`docs/finder-server-side.md` (Asset Opportunity section), then delete this plan per `docs/README.md`.

## Post-implementation Notes (2026-08-16)

- **The plan's batch assumption was wrong and is fixed.** `buildIterationOptions`
  (`lib/finder/server/finder-vite-plugin.ts`) does NOT spread the incoming `assetOpportunity` block — it
  reconstructs it field by field, so an unlisted `evalLastBars` would have been silently dropped in EVERY
  batch iteration while working in single runs. The field was added to the reconstruction and locked by
  `tests/finder-asset-opportunity-batch-parallel.spec.ts` ("carries assetOpportunity.evalLastBars through
  every per-holdout iteration clone").
- **Validation results** (`feat/asset-opportunity-eval-window` @ implementation): `tsc --noEmit` clean;
  green specs: finder-asset-opportunity-runner (29, incl. 6 new), finder-asset-opportunity-oos (10, incl. 2
  new), finder-server-plugin (70, incl. 1 new), finder-asset-opportunity-batch-parallel (11, incl. 1 new),
  feature-dom-contracts (48), finder-manager-logic (16). Full compact suite: 220/228 — the 8 failures
  (7 × `tests/strategies-lib/*` referencing strategy lib files absent at `e68505f`, plus a
  `sp500-top-mean-worker-pool.spec.ts` 120s timeout under the 6-job parallel run) are pre-existing or
  load-dependent: the strategies-lib failures reproduce identically on the untouched base tree, and the
  sp500 spec passes standalone in BOTH trees (real worker threads are just slow under full-suite parallel
  load). `tsc -p tsconfig.tests.json` likewise reports 79 pre-existing errors at base, unchanged
  by this branch.
- **Temp-worktree note**: the parent `lightweight-charts` directory is an npm workspace root, so `npm run`
  inside a sibling worktree fails with `EDUPLICATEWORKSPACE` (duplicate package name). Run the binaries
  directly (`../../../node_modules/.bin/tsc|esno ...`), which is the invocation style AGENTS.md already
  documents for specs.
