# Fresh-Window Research Mode

Operational doc for the fresh-window research infrastructure (planned in
[finder-fresh-window-research.md](finder-fresh-window-research.md); research
spec in `archive/asset opportunity/Decision Rule Research/research-agenda-2026-08-23.md`;
build/audit trail in the same folder's `build-report-*` and `agent-*-audit-*` files).

## What this is

A hardened measurement mode for Asset Opportunity research. It exists because
the closed 2026-08 window's instruments had known flaws: price-only forward
targets instead of the declared TP/SL trade, a shortlist random control
instead of the full evaluated pool, no point-in-time data boundaries, and
silent config drift. This mode fixes the instruments; it adds no trading rule.

It judges three pre-registered experiments from one batch's captured data:
time-to-TP (fast winners), cross-fold recurrence, and the
distinct-strategy-coverage gate. The semantics live in the research agenda and
are enforced by the analyzer — including every kill condition.

## How to run

1. Restart the dev server after any change to these server modules
   (`NODE_OPTIONS=--max-old-space-size=16384 npm run dev`).
2. Set real provenance before a batch: `FINDER_DATA_SYNC_SNAPSHOT` (the sync
   log timestamp) and `GIT_COMMIT`. Fresh runs fail closed without them.
3. Enable **Fresh-window research mode** in the Finder AO panel. The toggle
   routes artifacts to `archive/fresh-window` — the legacy
   `archive/asset opportunity` namespace is untouched when the mode is off.
4. The request must carry the frozen agenda config (notably
   `evalLastBars=1000`, `oosIgnoreLastBars=26`, horizons `[12,18,24]`,
   TP2/SL2, long, next_open) plus:
   - a **25-entry fold schedule** (strictly ordered point-in-time fold ends);
   - a **batchRole**: `collection` | `judged` | `replication`.
   Anything else is archived but marked `INVALID` for judgment.
5. Judge with the S0-first analyzer — read NOTHING below `S0: PASS`:

   ```text
   ..\..\..\node_modules\.bin\esno scripts\analyze-fresh-window-research.ts ^
     --archive-dir "archive\fresh-window" --stride-bars 12 --horizon 12 --seed 42
   ```

   (`.bat` launcher sits next to this doc's sibling research folders.)

## The role sequence (enforced, not advisory)

`collection` → `judged` → `replication`. A `judged` run with no prior valid
collection fails S0. A collection-only archive can never print a verdict.
Replication without a prior judged archive fails S0. Promotion language is
impossible without all three.

## Load-bearing contracts

- **Pinned execution path**: long, `next_open`, `allowSameBarExit=false`,
  percentage TP/SL only. Other execution models are rejected at request
  validation AND at S0. The forward contract matches the TS engine exactly on
  this path (including end-of-data raw-close semantics); the engine itself is
  never modified for parity.
- **Full-pool capture**: every evaluated candidate's scalar summary
  (identity hash, path scalars, censored forward outcome) is captured BEFORE
  the IS-search ranker discards. The random control is a seeded (42) draw
  from that full pool; the producer archives the draw trace and S0 verifies
  the digest by recomputation.
- **Point-in-time folds**: the dataset cache stores RAW data keyed by
  `symbol|interval`; each fold slices its own historical/forward windows.
  Leakage past a declared fold end fails loudly.
- **Fail-closed identity**: fresh-run identity/config persistence failures
  are fatal; S0 validates the full frozen settings object, fold bounds
  ordering, expected row counts, control trace, batch role, and completion
  markers. Missing outcomes trip a coverage threshold — never silent drops.
- **Bounded memory/durability**: per-task scalar retention is capped
  (fatal overflow); archive blocks end with completion markers and partial
  trailing blocks are rejected.
- **Legacy isolation**: absent `researchProgram`, behavior is unchanged —
  legacy analyzers, archive namespace, and Rust engine selection are untouched.
  Fresh-window capture always uses the TS engine (recorded in identity).

## Data policy

History is for remembering; fresh data is for deciding. Searches naturally
use the ~1000 bars before each fold boundary (historical). Final judgments
belong on data the tested ideas have never touched — hence the fresh-window
cadence: weekly syncs, weekly `collection` batches, `judged` + `replication`
only once ~100+ genuinely new bars exist.

## Validation habit (after any change to this feature)

```text
npm run typecheck
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-batch-parallel.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-archive.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-fold.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-forward-contract.spec.ts
..\..\..\node_modules\.bin\esno tests\analyze-fresh-window-research.spec.ts
..\..\..\node_modules\.bin\esno tests\vite-config-bundle.spec.ts
```

Current count: 204 passing across the eight suites.
