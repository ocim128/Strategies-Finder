# Selection Rules Mining Loop — Plan (v4, post-audit)

> **CAMPAIGN STATUS (2026-09-06):** Stage-1/1.5 mining on folder
> `sp500_top_mean_1788560534200_jedw` is COMPLETE and EXHAUSTED: 42 ideas
> (40 agent + 2 hand-made), 0 strict-bar survivors, all logged in
> `archive/selection-rules/idea-log.txt`. Findings: the edge on this window IS
> the thin-coverage/high-vote tail (SNDK); every mean-beating rule was an SNDK
> concentration artifact (EX lines negative); history features (vote flow,
> stability, incumbent returns) carry no forward value. Do NOT mine further on
> this folder. Next gate: P4 (pair-internals exporter) + a FRESH coordinator
> run (different/longer window — doubles as replication of the arms).

Status: audited. An independent skeptical audit returned NOT READY with 10
findings (3 blockers). Every finding is resolved in this revision; the two
open user preferences are marked DEFAULT (flippable). This layer is DISTINCT
from the Trade-Ledger mining loop: that loop filters WHICH SIGNALS to take on
one stream; this plan decides WHICH ASSET to enter among same-event candidates.
From the gate loop we borrow hygiene only (control comparison, append-only
logs, anti-clone), never decision logic.

## The question

The strategy config is frozen. The TOP_MEAN Coordinator replays it across the
pair universe; at each decision event the question is **which asset do we
enter?** Today ~12 hardcoded selector arms inside
`lib/batch-backtest/batch-open-score-usd-replay-engine.ts` answer it. Each new
idea means hand-editing a ~3,500-line engine. We want: **a rules lib + a
Finder-style menu** where selection rules run like strategies do in the Finder:
pick a saved coordinator folder, pick rules, run, compare against baselines.

## Confirmed decisions

1. **Rule output = pick 1 asset per event.** The rule (with its one parameter)
   selects one asset; the checker looks up what that asset did next and
   tallies it. Ties are part of the rule: see the tie contract below.
   Abstention / Top-K / direction+sizing stay out of scope.
2. **Feature expansion = pair internals** (recent realized trades, drawdown
   state, volatility per candidate pair) — staged; existing folders do NOT
   carry them (see P4).
3. **Metric = whole-window tally, then certification.** Mining scores the
   WHOLE folder window as ONE number vs three yardsticks — TOP_RAW, TOP_MEAN,
   and the ARCHIVED CONTROL (see below). NO IS/holdout split; overfitting is
   deliberately not filtered at mining stage. Finalists get portfolio
   certification (P5) + second-folder replication.
   **DEFAULT (user preference pending): strict success bar** — a rule passes
   only if its mean delta AND its median delta are both positive against ALL
   three yardsticks on the same horizon.
4. **Runtime = new menu UI, Finder-style** (dedicated top-level menu, server
   job over saved folders) with the engine core as a pure leaf callable from
   CLI for agent mining.
5. **Archived control definition (audit F1).** The engine's control is NOT
   seeded random draws: `controlReturn = (Σ other candidates' returns) /
   (candidateCount − 1)` — the leave-one-out mean of the other candidates,
   i.e. the EXPECTED return of a uniform random pick. It is per-selector
   (depends on who was picked), deterministic, and already archived. P1 adopts
   this definition verbatim and reports it as "others' mean". No new seeded
   control is introduced.
6. **Start folder (audit F5 + user preference pending). DEFAULT: start with
   the existing archived folder now; re-test survivors later on bigger
   folders.** Sample reality: the folder holds **961 distinct decision
   events**; per selector×horizon there are **937 completed comparisons**
   (e.g. TOP_MEAN at horizon 24). The 10,871 rows in `events-full.jsonl` are
   12 selector arms re-picking the same moments — never counted as separate
   events.

## Rules lib contract (mirrors strategy-lib conventions)

Location: `lib/selection-rules/lib/<rule-key>.ts`, registered in a static
`lib/selection-rules/registry.ts`. Server-side only; type-only imports and
leaf helpers keep it out of the Vite bundle trap (no `lightweight-charts`, no
browser managers).

```ts
export const <rule_key>: SelectionRule = {
    key, name, description,
    defaultParams: { lookback: 20 },      // exactly ONE numeric param (mining rules)
    paramLabels,                          // + metadata.paramBounds (metadata-only in v1)
    normalizeParams?(p) { ... },
    requiredFeatures?: [...],             // feature ids the rule needs; loader refuses loudly if the folder lacks them
    score(cand, event, params): number,   // higher = better; harness picks max
};
```

- **One parameter** applies to MINING rules. **Reference baselines are exempt**
  (audit F2): the TOP_MEAN re-implementation and the top-active-count seed
  rule are fixed reference points with no parameter.
- **Tie contract (audit F2).** Harness default tie-break = the ENGINE's exact
  rule: smallest versioned FNV-1a-64 digest of
  `MAX_ACTIVE_TIE_VERSION|tieSeed|truncatedEventTimeSec|scoringAsset`; asset
  name order only on digest collision. Reference rules MUST use it (parity
  depends on it — alphabetical order provably diverges from the archive).
  A mining idea MAY override with its own declared tie-break; the idea prompt
  requires a tie-break spec per idea.
- **TOP_MEAN ground truth (audit F2).** TOP_MEAN maximizes CURRENT-event
  `signedVotes / activePairCount` among positive-score candidates (≥2 positives
  required). There is NO historical averaging. Anti-clone wording everywhere
  derives from this: a clone is any rule reducible to
  `signedVotes/activePairCount` or a trivial transform of it.
- **Leakage contract (audit F4).** The harness builds FRESH allowlisted
  runtime objects per event — the rule never receives a joined object that
  also carries outcomes. The candidate list is constructed BEFORE any
  outcome-based gating (a rule never sees outcome-filtered membership; the
  event-level gate applies afterwards to the tally, not to what the rule
  sees). Any history features are restricted to the decision-time prefix.
  Honesty note: imported TypeScript rules are TRUSTED code — argument
  projection is a convention, not a sandbox. Regression test: mutating
  outcome rows must never change any rule's pick.
- **Units (audit F3).** Archived outcomes are fractions; reports multiply by
  100 (percentage points).
- `normalizeParams` required if `score` sanitizes; defaults valid after
  normalization.

## What already exists (verified by audit)

Archived coordinator run
`archive/batch-open-score/sp500_top_mean_1788560534200_jedw/`:

- `pool-snapshots.jsonl` — 130,696 rows, **961 distinct events**. Per
  (event, asset): `score`, `signedVotes`, `activePairCount`, `ema200Above`,
  `breadth`, `regime`, `longEligible`/`shortEligible` (exact names), `inPool`.
  Stage-1 feature space.
- `candidate-outcomes.jsonl` — 261,392 rows, all composite keys unique. Per
  (event, asset, horizon, direction): `return` + `status`. Statuses: 254,996
  `ok`, 6,140 `right_censored`, 256 `missing_entry`. GROUND TRUTH.
- `events-full.jsonl` — 10,871 rows = 12 selector arms × 937 completed
  moments. Frozen baseline picks + returns + deltas + control. Baseline
  lookup keys: eventId + horizonBars + selector + direction.
- `candidate-features.jsonl` — prior-history features
  (`priorCoverageSlope5`, `priorSignedVoteDelta3`, `priorScoreStdDev5`,
  `priorTopMeanReturnMean3`; 24-bar long TOP_MEAN incumbent semantics,
  null warm-ups). DEFERRED: P1 does not load it; it joins when stage-2 mining
  starts.
- `meta.json` — `schema: "top_mean_archive.v3"`,
  `fingerprintVersion: "top_mean_ledger_fingerprint.v2"`,
  `featureSet.contractVersion: "top_mean_feature_set.v2"`,
  `postAssemblyFingerprint`, per-file SHA-256 hashes (audit verified all four
  JSONL hashes match). P1 validates hashes before loading.
- **Event eligibility gate (audit F3, preserved verbatim for parity):** an
  event enters the comparison for a horizon only if EVERY positive candidate
  has a finite long AND short return; otherwise the event is omitted for that
  horizon ("censored or missing → omit from both arms"). Malformed/missing
  JOIN rows are a different thing: they fail loudly as data bugs, they are
  never treated as unavailable outcomes.

## Roadmap

**P0 — Baselines frozen (done).**

**P1 — Selection tally core + parity (the only new engine code).**
Prerequisites live HERE (audit F10): the minimal `SelectionRule` type, the
registry skeleton, and the TOP_MEAN reference rule — P2 builds them out.

- Leaf module + CLI: `scripts/selection-checker.ts <folder> <ruleKey>` —
  validates meta.json hashes, parses/indexes the folder ONCE, groups
  pool-snapshots by eventId, joins outcomes per (event, asset, horizon,
  direction), applies the archived eligibility gate, rule picks → tally per
  horizon over the whole window: rule vs TOP_RAW vs TOP_MEAN vs others'-mean
  (mean + median deltas in percentage points, selected-assets +
  `<RULE>_EX_<dominant>` lines, event counts). Whole window = ONE score.
- **Parity gate:** the TOP_MEAN reference rule must reproduce all 937
  archived picks exactly — including the 230 tied events under the FNV
  tie-break. No rule result is trusted before parity passes.
- Verify: parity spec passes; one rule runs in seconds.

**P2 — Rules lib build-out.**
`registry.ts` build-out (flat `lib/selection-rules/` layout — P1 established
it; no `lib/` subfolder); seed baselines TOP_MEAN, TOP_RAW, and top-active-count
(all parameter-exempt), with the parity spec extended to cover TOP_RAW too;
`docs/selection-rules.md`: contract, stage-1 feature table with MEASURED SCALES
(percentiles computed from the folder — idea agents calibrate against them),
success bar, discipline. The feature-requirement refusal mechanism moves to P4:
nothing to refuse until folders with differing feature sets exist.

**P3 — The menu (Finder-style UI + server job).**
New top-level menu/tab; folder catalog (from meta.json, schema-gated to
supported versions); rules multi-select (v1 = default params; bounds are
metadata for a later sweep); Run/Stop; streamed results table; Copy. Server
lifecycle carried over explicitly (audit F8): F1 `isAllowedLocalRequest` on
every route; F4 disconnect-safe streaming; F5 runId-scoped Stop + pending-stop
slot; F6 terminal status preserved (fatal runs stay visible); F3-style
generation-scoped cleanup detached before first await; browser runId guards;
catalog path containment (realpath inside allowed root); folder indexing once
per job (not per rule); cooperative yielding (or a worker) so Stop/status are
serviced mid-run. F2/F7 apply only if artifact/temp-dir machinery is ever
added; F9 is not applicable; NO backtests and NO Rust preference anywhere.

**P4 (v5) — Pair-selection data infrastructure (L0). SUPERSEDES the
asset-shaped pair-internals exporter.**

The selection unit moves from ASSET to PAIR+DIRECTION: a signal on pair
BASE+QUOTE is a spread bet (buy BASE, sell QUOTE), and the pair is the actual
tradeable expression. The surface is the trade-ledger: one row per
(pair, direction, signal time), causal feat_* columns, as-if outcomes,
candidatesAtTime — already produced by Batch runs and saved as folders.

L0 scope (the only build before any idea is implemented):
- Ledger feature version 3: three new causal per-signal features —
  feat_barsSincePairLastFire (bars since this pair's previous signal; null on
  first fire), feat_pairSpreadVolatility20 (population std-dev of the previous
  twenty one-bar percent changes of the pair's synthetic close, strictly
  before the signal bar), feat_legVolatilityRatio20 (BASE vs QUOTE leg
  volatility over the same window; requires leg-series plumbing in the
  exporter — null when legs are unavailable).
- Identity columns baseSymbol/quoteSymbol on every row (canonical legs), so
  shared-leg/overlap research never depends on parsing derived chart symbols.
- Causality: decision-bar prefix data only; nulls are warm-up or
  unavailable-leg, never zero.
- A fresh Batch run of the frozen config materializes a v3 ledger folder;
  old v2 folders stay untouched on disk.

L1 (after L0): the pair-pick checker — argmax among same-timestamp fires,
whole-window tally, strict bar; yardsticks = seeded random-fire control plus
deterministic trivial orderings; self-test before any rule result is trusted.
L2 (after L1): idea batches from the approved thinker batch (10 pair ideas,
2026-09-06) implemented against the v3 feature set; append-only idea log.

**P5 — Portfolio certification.**
Before any certified run, FREEZE (audit F7): admission/overlap policy — the
existing simulator skips tied opportunities and rejects overlapping
same-asset positions (`batch-open-score-usd-replay-engine.ts:848-879`), which
contradicts a mandatory-pick rule and must be re-specified — capital, costs,
horizon, realized vs marked equity, pass criteria. Finalists AND their
parameters are frozen before the replication window is inspected; overlap/
purge policy defined; failed/repeat attempts counted.

**P6 — Agent mining loop.**
Two NEW prompts authored fresh, modeled on
`archive/prompt-4h-syntheticpair-nvda.txt`: campaign context (measured arm +
rule results), anti-clone rule in the corrected form ("any rule reducible to
`signedVotes/activePairCount` or a trivial transform — forbidden"),
one-parameter rule, per-idea TIE-BREAK spec (or explicit default), JSON-only
ideas, calibration to measured scales, rules-lib contract + registry entry.
Two-phase protocol: idea agent writes nothing, runs nothing; implementation
agent writes rules, runs the CLI, appends the append-only idea log (failures
included), declares ≤2 finalists per batch.

## Discipline

- Success bar: DEFAULT strict (mean AND median positive vs all three
  yardsticks) on the whole window.
- Mining does not filter overfitting — by design. Luck control is downstream:
  P5 certification + replication on a second folder (different window and/or
  config). A family is believable only after it also tests positive there.
- Family cap: ≤10 ideas per batch from the same feature pair. Append-only
  idea log; never delete tested rule files.

## Risks

- **Only 937 completed comparisons per selector×horizon** — verdicts are
  noisy; expect survivors to flip on replication. Accepted as the price of
  starting now (DEFAULT decision 6); bigger folders are the mitigation.
- **Whole-window mining guarantees lucky survivors** when many rules are
  tested — accepted by design; P5 + second-folder replication are the only
  luck filters.
- **Single frozen config:** rules inherit the folder's strategy/universe/
  horizons; until replicated they are candidates, not conclusions.
- **Pair-internals leakage:** the P4 exporter is the danger point; tested by
  "features at time t identical when data after t is truncated".
- **UI scope creep:** the menu stays a thin wrapper; all comparison semantics
  live in P1 so CLI and UI cannot drift.
