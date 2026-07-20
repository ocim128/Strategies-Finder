## Plan: Bring MAX_ACTIVE_REVERSION to parity with the long-side selector arms

### Context (verified, not assumptions)

The previous AI's work landed in the engine but stopped short. Current state of `MAX_ACTIVE_REVERSION`:

**Already shipped** (`lib/batch-backtest/batch-open-score-usd-replay-engine.ts`):
- Result interface fields `maxActiveReversion` + `maxActiveReversionByAsset` (lines 116-118)
- Candidate pool `negatives[]` mirrored from `positives[]` (lines 530-562)
- `pickMax(negatives, "activePairs")` selector (line 614)
- Per-event short return math at outcome phase (lines 711-715) — already correct
- Aggregation block using `arr.short[hIdx]` with its own random baseline (lines 867-896)
- Per-asset samples map `maxActiveReversionSamplesByAsset` (line 767)
- Report line `MAX_ACTIVE_REVERSION` + asset breakdown labeled "(short USD)" (lines 1259, 1282-1285)
- One passing test at `tests/batch-open-score-usd-max-active.spec.ts:93-116`

**Missing — these are the gaps to close:**
1. `controls | ...` legend line (engine:1246) doesn't mention `MAX_ACTIVE_REVERSION`
2. `tie rates | ...` line (engine:1273) doesn't include `reversionTie` even though it's already collected (engine:625) — silent drop
3. No `MAX_ACTIVE_REVERSION_EX_DOM` arm — long side has `maxActiveExDominant` (engine:143, 999-1003); reversion has no analog
4. No `REVERSION_VS_RANDOM_SHORT` or similar null check — when `negatives.length < 2` everywhere, the line silently shows `events=0` with no warning explaining why
5. Zero docs — `docs/open-score-usd-replay-implementation-plan.md`, `docs/batch-backtest-server-side.md`, `README.md`, `AGENTS.md` make no mention of the reversion arm
6. Copy/stream path tests (`tests/batch-backtest-copy.spec.ts`, `tests/batch-backtest-server-plugin.spec.ts`) don't assert reversion appears in output

**User intent (confirmed):** *"Yes, mirror the long study"* — reversion should be the short-side analog of `MAX_ACTIVE`, at parity with the long-side arms.

### What I will NOT add (and why)

- **`ACTIVE_VS_REVERSION` pairwise arm.** The existing `appendPairwise` (engine:801-814) uses `retByAsset` which contains positive candidates' LONG returns. A long-vs-short pairwise would mix directions and the resulting delta isn't interpretable. Adding it correctly would require a separate dual-direction pairwise helper. **Out of scope** unless you say otherwise — call it out separately if you want it.
- **No UI/DOM changes.** Per agent 2's finding, the service renders `reportLines.join("\n")` opaquely at `batch-backtest-service.ts:2240` (display), `:2269` (Copy OPEN_SCORE USD), and `:1062-1067` (main Copy Results). The new line automatically rides both copy paths. Zero HTML/DOM touches needed.

### Steps

Each step ends with a verification check. Tests run via the existing `esno` runner.

**1. Add `MAX_ACTIVE_REVERSION_EX_DOM` (mirror of `maxActiveExDominant`)**
- Add `maxActiveReversionExDominant: ReplayComparison` and `maxActiveReversionDominantAsset: string | null` to the horizon interface (after line 118)
- In Phase 5 after line 993: compute the reversion dominant asset from `maxActiveReversionByAsset[0]?.asset`, filter `maxActiveReversion.assets` indexes to non-dominant, and `buildComparison(...)` over them — exactly mirroring lines 994-1003
- Add the result fields to the `horizonResults.push({...})` object (after line 1010)
- Add report line `lines.push(comparisonLine(\`REVERSION_EX_${h.maxActiveReversionDominantAsset ?? "NONE"}\`, h.maxActiveReversionExDominant))` after line 1259
- *Verify:* `npm run typecheck`; new engine test asserts the field exists and matches a hand-computed value

**2. Add reversion tie rate to the tie-rate line**
- Extend `SelectorName` union (engine:184) to include `"REVERSION"`
- Add `REVERSION: 0` to the `tieCounts` initializer (engine:758)
- In the ties object pushed to EventView (engine:626-633), add `REVERSION: view.reversionTie`
- Extend the tie-line formatter (engine:1271-1273) to include `REVERSION` using the `reversionTie` counter — note `reversionTie` is stored on `EventView` directly, not via `ties`, so the accumulation needs a separate counter `reversionTieCount` accumulated alongside `tieCounts`
- *Verify:* engine test asserts tie line includes `REVERSION=...`

**3. Add the controls legend entry**
- One-line edit at engine:1246 to append `MAX_ACTIVE_REVERSION=most open pairs among negative-score assets, shorted vs USD`
- *Verify:* existing test at `tests/batch-open-score-usd-replay-engine.spec.ts:362` (locks `controls | TOP_MEAN=raw/activePairs`) still passes since the substring check is unaffected

**4. Add a warning when the negative pool is structurally empty**
- After Phase 5, if `maxActiveReversion` series has `events === 0` across ALL horizons AND `totalEvents > 0`, push a warning to `warnings[]` like `"Reversion selector contributed 0 events — pair universe may not produce enough negative-score assets at any decision event."`
- Surface in the existing WARN block (engine:1289) — no UI change needed
- *Verify:* new test with a long-only pair universe asserts the warning fires

**5. Tests**
- Extend `tests/batch-open-score-usd-max-active.spec.ts`:
  - Add test asserting `maxActiveReversionExDominant` drops the most-selected negative asset
  - Add test asserting the tie line includes `REVERSION=`
  - Add test asserting the empty-negatives warning fires
- Extend `tests/batch-open-score-usd-replay-engine.spec.ts`:
  - Add test asserting the controls legend line mentions `MAX_ACTIVE_REVERSION`
- Extend `tests/batch-backtest-copy.spec.ts`:
  - Add test asserting a reversion-bearing `reportLines` is included verbatim in the main Copy Results text (mirrors the existing OPEN_SCORE inclusion pattern at `batch-backtest-service.ts:1062-1067`)

**6. Documentation**
- `docs/open-score-usd-replay-implementation-plan.md`: add a new section "Short-side reversion selector (MAX_ACTIVE_REVERSION)" explaining the candidate pool, short trade math, dominant-asset exclusion, and how to read the line
- `docs/batch-backtest-server-side.md`: one paragraph in the OPEN_SCORE USD section noting the short-side arm is computed alongside the long arms in the same pass
- `README.md`: update the OPEN_SCORE USD selector list to include `MAX_ACTIVE_REVERSION`
- `AGENTS.md`: add a single line to the "Safe Change Checklist" → "Any backtest behavior change" section noting reversion semantics must stay direction-correct (negative pool, short return) and that long-side changes do not automatically propagate

### Verification (final)

Run after all changes:
- `npm run typecheck`
- `npm run typecheck:tests`
- `..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-max-active.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-replay-engine.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts` (sanity — no DOM contract changes expected)

### Files touched

| File | Type of change |
|---|---|
| `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` | Engine: new fields, EX_DOM computation, tie-rate extension, legend line, warning |
| `tests/batch-open-score-usd-max-active.spec.ts` | 3 new tests |
| `tests/batch-open-score-usd-replay-engine.spec.ts` | 1 new test (controls legend) |
| `tests/batch-backtest-copy.spec.ts` | 1 new test (copy includes reversion line) |
| `docs/open-score-usd-replay-implementation-plan.md` | New section |
| `docs/batch-backtest-server-side.md` | One paragraph |
| `README.md` | Selector list update |
| `AGENTS.md` | One line in safe-change checklist |

No changes to: `batch-backtest-service.ts`, `batch-backtest-vite-plugin.ts`, `batch-backtest-dom.ts`, `html-partials/tab-batch-backtest.html`, or any strategy/backtest engine file. The browser Copy paths already carry the new lines automatically.

### Complexity budget

The dominant-asset exclusion for reversion is a mechanical mirror of the existing `maxActiveExDominant` pattern — roughly 20 lines in the engine, plus the interface fields and report line. The tie-rate extension is 5-6 lines. The warning is 4 lines. Total engine delta: ~40 lines, no new abstractions, no new helper functions. Matches AGENTS.md "Simplicity First" — every line traces to a long-side parity analog that already exists.