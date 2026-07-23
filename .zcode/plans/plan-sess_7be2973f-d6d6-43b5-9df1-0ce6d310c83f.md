## Goal

Add a start-date (and end-date, for parity with the sibling control) filter to the **S&P 500 TOP_MEAN Coordinator** so its phase-3 replay only considers decision events from the chosen date onward — mirroring the existing **OPEN_SCORE USD** `From`/`To` controls exactly. This is purely additive: when blank, behavior is unchanged (full history).

## Worktree

Create a temp worktree as a sibling of the others:
```
git worktree add -b feat/sp500-top-mean-date ../Strategies-Finder-top-mean-date
```
Then junction `node_modules` from the main checkout so typecheck/tests/esno resolve without a full `npm install`:
```
cmd //c mklink /J node_modules ..\..\Strategies-Finder\node_modules
```
All work happens in that worktree. No commits unless you ask.

## Honest scope note (what this does NOT speed up)

TOP_MEAN has 3 phases:
1. **preflight** (cheap)
2. **backtesting** — runs the strategy across all canonical pairs in workers, writing artifacts. **Not affected by the date filter** (artifacts must cover full history to keep fingerprint/resume semantics intact).
3. **replay** — scans artifacts and computes OPEN_SCORE decision events + selector arms. **This is the phase the date filter trims** (events with `t < sampleFromSec` are skipped at `batch-open-score-usd-replay-engine.ts:513`).

So the speedup lands in phase 3. This matches OPEN_SCORE USD's semantics (your original question). Slicing phase 2 by date is a much larger change (changes artifact contents, fingerprint, coverage) and is **out of scope**.

## Files to change (5, all surgical — each mirrors an OPEN_SCORE USD touchpoint)

### 1. `html-partials/tab-batch-backtest.html` (TOP_MEAN controls block, ~lines 148-151)
Add two `<input type="date">` fields (`batchBacktestSp500TopMeanFrom`, `batchBacktestSp500TopMeanTo`) with the same classes/title text as the OPEN_SCORE USD pair (lines 87-94), placed in the `.batch-stability-controls` grid next to Horizons/Workers/Max Pairs.

### 2. `lib/batch-backtest/batch-backtest-dom.ts`
- Append `"batchBacktestSp500TopMeanFrom"` and `"batchBacktestSp500TopMeanTo"` to `BATCH_BACKTEST_REQUIRED_IDS`.
- Add two resolvers (`HTMLInputElement`) in `createBatchBacktestDom()` next to the other `Sp500TopMean*` entries.

### 3. `lib/batch-backtest/batch-backtest-service.ts` (`runSp500TopMeanCoordinator()`, ~line 2108)
Read the two inputs and conditionally spread into the payload, identical to the OPEN_SCORE USD pattern at lines 1424-1443:
```ts
const sampleFrom = dom.batchBacktestSp500TopMeanFrom.value.trim();
const sampleTo = dom.batchBacktestSp500TopMeanTo.value.trim();
// ...
const payload = {
    ...,
    ...(sampleFrom ? { sampleFrom } : {}),
    ...(sampleTo ? { sampleTo } : {}),
};
```
(The `diagnosticPayload = { ...payload }` spread carries them into diagnostics automatically.)

### 4. `lib/batch-backtest/batch-backtest-vite-plugin.ts` (`handleSp500TopMeanRunRequest()`, ~line 2070)
Add the same `parseBodyDateSec(body, key, endOfDay)` helper used in `handleOpenScoreUsdRequest()` (lines 1660-1669) — inlined as a small local closure to keep the change surgical (not refactoring the OPEN_SCORE path). Convert `sampleFrom`/`sampleTo` (YYYY-MM-DD) → `sampleFromSec`/`sampleToSec` (unix seconds, To = end-of-day inclusive) and attach to the `req` object before constructing `TopMeanCoordinatorEngine`.

### 5. `lib/batch-backtest/sp500-top-mean-coordinator-engine.ts`
- Add `sampleFromSec?: number;` and `sampleToSec?: number;` to `TopMeanCoordinatorRunRequest` (lines 27-40).
- In the phase-3 `runOpenScoreUsdReplay(...)` call (~lines 259-265), add:
  ```ts
  ...(this._request.sampleFromSec !== undefined ? { sampleFromSec: this._request.sampleFromSec } : {}),
  ...(this._request.sampleToSec !== undefined ? { sampleToSec: this._request.sampleToSec } : {}),
  ```
  The engine's existing gate at `batch-open-score-usd-replay-engine.ts:513` does the rest — **no engine change needed.**

## Why this is safe
- `sampleFromSec`/`sampleToSec` are already optional on `RunOpenScoreUsdReplayOptions` (engine lines 224-225) and already gated as `undefined → keep all events` (engine line 513). TOP_MEAN currently omits them → full history. After the change, blank inputs → still omitted → still full history. **Behavior is identical when fields are blank.**
- Phase 2 artifacts, fingerprint, resume, and coverage counts are untouched (the filter lives entirely in phase 3).
- No new settings id / localStorage migration — these are transient input fields read on Run, like the OPEN_SCORE USD From/To.

## Verification
- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts` (locks the 2 new ids into the partial)
- Check `tests/` for an existing sp500-top-mean spec; if one exists and asserts the request shape, update it to cover the optional `sampleFromSec`/`sampleToSec` fields (default-undefined case must still pass).
- Report any unrelated pre-existing failures separately (baseline note in AGENTS.md says typecheck/test are expected green as of 2026-03-08).

## Out of scope
- No phase-2 dataset slicing (would change artifacts/fingerprint/coverage — separate, larger change).
- No new date-format helpers — reuses OPEN_SCORE USD's exact `Date.parse(YYYY-MM-DD)` → unix-seconds convention.
- No commit unless you ask.