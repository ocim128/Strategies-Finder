# Pairlist Selection Research Plan (ex-ante pool selection)

Status: plan approved from external thinker/auditor review on 2026-08-24; doc-plan audit
(2026-08-24) returned PASS WITH AMENDMENTS and all nine amendments plus locking rulings
have been applied. This document is the single implementation plan; phases are gated and
pre-registered. Do not run Phase 2+ experiments or retune any rule after seeing
validation-window results.

Source artifacts: thinker proposals 1–7 + instrumentation wishlist, auditor verdict
(2026-08-24), archive logger (`lib/batch-backtest/sp500-top-mean-archive-log.ts`, landed
2026-08-24). The audit changed no repository files; this plan encodes its decisions.

## 1. Research question

The OPEN_SCORE TOP_MEAN replay proved the ranking layer works inside a hindsight-chosen
uptrend pairlist (TOP_MEAN vs same-pool random: delta +2.36%, CI95 [+1.48, +3.38] @48 bars,
10/10 blocks, positive in both 2025 and 2026). The pool itself contributed most of the raw
P&L and was selected with lookahead — it is not live-tradeable. The open problem is ex-ante
pool (pairlist) selection: which assets belong in the pool, decided at present time with
zero lookahead.

Two estimands, always reported separately:

1. **Pool quality**: random picks from the proposed pool vs random picks from a neutral
   full-catalog pool on matched event times.
2. **Ranking quality**: TOP_MEAN (and other arms) vs same-pool random — the existing
   methodology.

The existing same-pool random control answers only the second question. Every pool-quality
claim additionally requires the matched full-catalog random control.

## 2. Frozen conventions (all phases)

- Methodology: same-pool random control, bootstrap CI95, 10 chronological blocks,
  EX-dominant diagnostics, calendar-year splits, direction-specific reporting. Frozen
  tie/bootstrap versions per `lib/batch-backtest/max-active-research-contract.ts`
  (10 blocks, 10,000 bootstrap samples, seed 1, FNV-1a 64 tie-break).
- Windows: discovery `2025-01-10..2025-12-31`, validation `2026-01-01..2026-08-24`.
  No validation-window retuning, ever.
- Horizons: 48 bars primary; 12 and 24 bars secondary, descriptive only.
- Costs: identical across compared runs. Batch 1 replay uses slippageRate=0.001 and
  commissionRate=0.001; the manifest also records their source values as
  slippageBps=10 and commissionPercent=0.1.
- Direction separation: long and short results are never pooled into one number; each side
  keeps its own random control and eligibility gates.
- Run naming: `<MODE><ASSETS>_<TOPOLOGY><EDGES>` (e.g. `LONG70_BAL679`). One named pool =
  one deterministic pairlist file plus provenance (see pool registry, Phase 1).
- Archive: every completed coordinator run lands in `archive/batch-open-score/<runId>/`
  (report.txt, meta.json, events JSONL; no TTL). Known gap until Phase 0a lands: meta.json
  records `canonicalAssets` (submitted, e.g. 70) and `counts.pairCount` (the
  submitted/preflight pair count, e.g. 679) but NOT the exact pairlist or normalized
  settings; the replay report counts retained/usable artifacts (665 pairs / 69 assets
  after load failures). The run-manifest fields close this.

## 3. Phase 0a — run-manifest provenance (BLOCKS Phase 1)

Required before the first evidentiary batch. Extend the archive `meta.json` with:

- strategy key and parameters normalized by the same built-in strategy `normalizeParams(...)`
  call that backtest execution uses — never raw request/UI display values
- backtest settings persisted after
  `resolveBacktestSettingsFromRaw({ ...request.backtestSettings, interval: request.interval }, { coerceWithoutUiToggles: true })`
  and capital settings after `resolveCapitalSettingsFromRaw(request.capitalSettings)`
- the exact preflight execution array `enumRes.canonicalPairs`, persisted WITHOUT sorting
  or reordering, plus its SHA-256 (the execution-order hash — this identifies the actual
  run input); a separate SHA-256 of the lexicographically sorted canonical pair set is
  stored for identity checks only. Also: pair construction algorithm + seed; catalog
  list + hash; warmup; data cutoff
- costs (execution rates plus source values), horizons, discovery/validation designation,
  tie/bootstrap version strings

The current coordinator fingerprints RAW settings while execution normalizes parameters
later; the normalized representation above — not the raw fingerprint — is the research
provenance of record.

All fields ride the existing best-effort completion hook
(`archiveCompletedTopMeanRun`); logging stays Node-leaf, never fails the run, no TTL.

## 4. Phase 0b — event-level instrumentation (BLOCKS Phase 2)

Build order:

1. **Stable `eventId` + `poolVersion`** — `eventId` is exactly
   `<interval>:<decisionTimeSec>` (runId stays a separate field). Static poolVersion is
   `BAL679.v1`; offline monthly pool versions are `<ruleId>:<YYYY-MM>`. Enables
   matched-event joins across pool variants. Added to `events-full.jsonl` / annual JSONL
   rows and all new files below.
2. **`pool-snapshots.jsonl`** — one record per decisionTime × asset: membership, pool
   version, active-pair count, signed votes, score, long/short eligibility, EMA state,
   breadth state, regime label. Unlocks pool-rule evaluation offline.
3. **`candidate-outcomes.jsonl`** — one record per decision event × horizon × direction ×
   asset for EVERY asset in the frozen canonical catalog, including assets with no
   current score candidate. Each row stores membership, eligibility, the finite
   direction-correct return or null, entry/exit timestamps when available, and a fixed
   missing/censored reason; missing values are never zero-filled. For each direction and
   horizon, a matched comparison uses only events for which BOTH the required
   full-catalog and proposed-pool returns are finite, applying the same event filter to
   both controls. Essential for stable pool-quality estimates; removes dependence on
   single random draws. Semantics note: the existing `events-full.jsonl` `controlReturn`
   is the leave-one-out mean of the other eligible assets, not a random draw — document
   this in the file's header comment; do not change it. Implementation note: the current
   replay only requests target datasets for score candidates, so "every catalog asset"
   requires an explicit loader and outcome-path change in the replay engine.
4. **`pool-transitions.jsonl`** — DEFERRED to Phase 3 (cadence work). Do not build now.

Each new file = one writer in the archive-log module family + focused spec, mirroring
`tests/sp500-top-mean-archive-log.spec.ts` (disabled-env, never-throw, runId guard,
byte-exact content checks).

## 5. Phase 1 — Batch 1: long-only vs symmetric (Proposal 6, no engine code)

Gate: Phase 0a landed. Two fresh static runs via the existing `pairListText` request path:

- `LONG70_BAL679` — frozen 70-asset catalog, deterministic 679-edge degree-balanced
  pairlist, long-only.
- `SYMMETRIC70_BAL679` — identical catalog, pairlist, settings, costs; long and short
  evaluated independently (same undirected pair graph).

Pool registry (fixed BEFORE Batch 1): the canonical catalog is the sorted 70-entry asset
array stored in the tracked `pool-registry.v1` file. Generate the pairlist exactly once
with `generateBalancedPairList({ assets, maxPairs: 679, seed: 1 })`
(`lib/batch-backtest/balanced-pair-list-generator.ts`, algorithm `seeded_round_robin_v1`,
using the generator's balanced orientation); degree max−min must be ≤ 1 and
`orientationImbalanceMax` ≤ 1. The registry stores the generator's emitted pair order
byte-for-byte; its SHA-256 is computed over the UTF-8 bytes of `pairs.join("\n") + "\n"`.
The tracked registry lives under `docs/pairlist-pools/` with a byte-identical copy under
`archive/batch-open-score/pools/` — the ignored runtime archive is never the sole
pre-registration record. The tracked registry's 70 sorted assets, `seeded_round_robin_v1`,
seed 1, maxPairs=679, emitted pair order, and SHA-256 are the sole Batch 1 inputs.

Symmetric semantics are RESOLVED (no build-time choice): `SYMMETRIC70_BAL679` uses the
same undirected 679-edge graph as `LONG70_BAL679` and reports long and short outcomes
independently. Reverse-directed pair rows are NOT part of Batch 1; any later reverse-row
experiment must use a separate pool name, registry, hash, and pre-registration.

## 6. Phase 2 — pool-quality experiments (after Phase 0b)

Phase 2 is OFFLINE-FIRST and does not reconstitute the pairlist during a run. P1/P2
membership is reconstructed from `candidate-outcomes.jsonl` and `pool-snapshots.jsonl`
using the frozen catalog and last-fully-closed-bar features. This offline analysis may
claim POOL quality. It may report TOP_MEAN ranking conditional on the existing static
pair graph, but it must not present that as "ranking quality under a dynamically
reconstituted pair graph" — dynamic ranking under changed membership remains out of scope
until separately justified and registered (§10).

Feature timing rule (all Phase 2 features): all features use the last fully closed bar;
EMA200 and 120-bar momentum require their full lookback; no partial warmup values are
admitted.

- **P1 trend/breadth pool**: UTC calendar-month membership. At each month's first
  eligible decision event, compute breadth over the frozen catalog using the last fully
  closed bar. The pool is active only when breadth is strictly greater than 50%;
  otherwise the pool is empty and NO fallback pool is substituted. An asset is admitted
  only when its prior close is strictly above its causal EMA200. Missing feature data
  excludes that event — never imputed. The existing TOP_MEAN_TREND/REGIME_MEAN arms
  answer ranking quality only and are regime-sensitive (24-bar delta −1.17% in 2025 vs
  +4.43% in 2026) — they do not substitute for this.
- **P2 cross-sectional momentum pool**: rank the frozen catalog by trailing 120-bar
  return minus the cross-sectional median, using only the last fully closed bar. The
  primary pool is EXACTLY the top 35 assets of the 70-asset catalog; the 21-asset and
  49-asset pools are fixed secondary arms. Ties use the existing versioned FNV
  event-time/asset tie-break. All pools use the same monthly effective-time rule as P1.
  Size-matched random pools use exactly 10,000 deterministic uniform without-replacement
  subsets of the same size, generated with LCG seed 1 keyed by eventId and pool size —
  no other random-pool count, seed, or cutoff may be introduced.
- **P3 corrected** (replaces the rejected design): pool-size study as natural
  complete-graph or fixed-average-degree construction — the original matched-pair-count
  design is impossible (8/12/20/30 assets cap at 28/66/190/435 unique pairs).
- **P5 corrected** (replaces the rejected design): matched uniform 679-edge vs
  degree-balanced 679-edge topology; star topology only as an explicitly unmatched stress
  control. Log per-asset degree and active-pair denominator over time. Locked
  construction detail: P5 uniform sampling uses lexicographically sorted complete-graph
  edges, Fisher-Yates/LCG seed 1, the first 679 edges, and the existing balanced
  orientation; no alternate topology may be substituted.
- **Hard gate on P3/P5**: the corrected designs are NOT executable from this document
  until their full arm list, pair-construction algorithms, seeds, primary endpoint,
  comparison control, and decision rules are added to §8 and reviewed BEFORE the first
  corrected-design run. No discovery result may be used to choose any of those items.

## 7. Phase 3 — deferred (unblock conditions)

- **P4 reconstitution cadence**: only after a pool rule survives validation in Phase 2;
  requires `pool-transitions.jsonl`.
- **P7 ex-ante pool-quality proxy**: only after a pool definition is locked. One feature,
  median split, both frozen in 2025, tested only in 2026. The ONLY allowed label is the
  subsequent block's INCREMENTAL pool quality: same-pool random return minus matched
  full-catalog random return. It is not the raw same-pool return, not a run verdict, not
  a strategy-selection result, and not a prediction of which run wins — that family was
  validated to carry no predictive information and is prohibited (see
  `docs/mine-timing-validation-findings.md`).

## 8. Pre-registered decision rules (LOCKED 2026-08-24)

- **P1**: confirm only if, at 48 bars in 2026, pool-random minus matched full-catalog
  random has CI95 lower bound > 0 AND ≥8/10 positive blocks, while TOP_MEAN minus
  same-pool random also has CI95 lower bound > 0 and ≥8/10 positive blocks. Otherwise
  refute or mark inconclusive by layer.
- **P2**: the 50% momentum pool is primary. At 48 bars in the 2026 validation window,
  confirm only if pool-random minus matched full-catalog random has CI95 lower bound > 0
  AND at least 8/10 positive blocks, AND the paired block-bootstrap CI95 lower bound for
  its TOP_MEAN delta minus the fixed FULL70_BAL679 benchmark delta is greater than
  −0.50 percentage points. The 30% and 70% arms are descriptive only and cannot
  determine confirmation.
- **P6 (Batch 1)**: confirm the short side only if its same-pool delta has CI95 lower
  bound > 0 and ≥8/10 positive validation blocks; long side must be non-inferior to
  long-only within 0.50 percentage points. Short and long conclusions remain separate.
- **P7**: confirm only if high-minus-low incremental pool quality has CI95 lower bound
  > 0, ≥8/10 validation blocks with expected sign, and the effect survives subtracting
  matched full-catalog random performance.

## 9. Risks and guardrails

1. Pool rule quietly encodes the hindsight uptrend → last fully closed bar only; frozen
   discovery/validation split; no validation retuning; hindsight pool is a non-live
   upper-bound reference only.
2. Catalog survivorship → archive frozen catalog, membership date, hash, cutoff
   (Phase 0a); repeat on future data.
3. Market beta or one dominant asset masquerading as pool quality → matched full-catalog
   random control, same-pool random control, direction-specific analysis, EX-dominant
   diagnostics.

## 10. Out of scope

- Dynamic mid-run pool reconstitution (any Phase 2 need must first justify itself against
  a static-pool grid).
- Changes to frozen engine/execution paths and engine-parity contracts.
- Allocation advice, run-verdict prediction, timing-edge miners (prohibited family).

## 11. Validation habits

- Archive-completion ordering: the coordinator must AWAIT the archive completion promise
  before emitting the terminal `done` event. Archive-write failures remain swallowed and
  never fail the coordinator, but the result must carry `archiveComplete=false`. A run
  with `archiveComplete=false`, missing required files, or mismatched file hashes is not
  evidence. (Current code fires `void archiveCompletedTopMeanRun(...)` — done can be
  emitted before the archive write finishes; this gate closes that gap.)
- Touching the archive logger / new JSONL writers:
  `npm run typecheck`, `..\..\..\node_modules\.bin\esno tests\sp500-top-mean-archive-log.spec.ts`
  (+ the new file's spec), `tests\batch-backtest-copy.spec.ts`.
- Touching the replay engine: additionally
  `tests\batch-open-score-usd-replay-engine.spec.ts`,
  `tests\batch-open-score-usd-max-active.spec.ts`,
  `tests\sp500-top-mean-server-plugin.spec.ts`.
- Import hygiene for every new server module: Node-leaf only — no imports reaching
  `lightweight-charts`, `lib/constants.ts`, or `lib/chart-manager.ts` (vite.config bundle
  trap).
- Every batch run: confirm `archive/batch-open-score/<runId>/` contains the expected
  files before interpreting results; a run without a complete archive is not evidence.

## 12. Research log

**2026-08-24 — Batch 1, P1/P2, and red-team audit (append-only; §8 rules unchanged)**

Executed: Batch 1 (long gks2 / both a8sv / combined 63wg on BAL679.v1; P6 short side NOT
confirmed, long side preserved with a marginal −0.55 pp TOP_MEAN dip), Phase 0b
instrumentation verified, offline P1/P2 analysis (both pool rules fail their §8 rules).

Red-team audit of the resulting "full pool + TOP_MEAN" conclusion — OVERTURNED as written.
Verified citations: the oas3 Phase 0b run has the SAME fingerprint as gks2 (deterministic
duplicate, not independent evidence); "both" 2026 h48 is 7/10 blocks (misses threshold);
"combined" 2026 h48 CI crosses zero (+2.41% [−0.29, +5.20] 6/10); 2025 h48 crosses zero
(+1.50% [−0.65, +3.57] 6/10); TOP_MEAN tie rate is 100% in every window, the $1k TOP_MEAN
portfolio executed zero trades (all events tie-skipped), and `latestSelections` TOP_MEAN
is null/"tied". All runs carry the From=2025-01-01 designation blemish ("other").

Standing claims (maximally licensed):
- C1: "TOP_MEAN showed a positive 48-bar (median ≈34 calendar days — see horizon-duration
  correction below) same-pool ranking delta in one long BAL679 replay during the 2026
  window" — nothing stronger.
- C2: "Neither P1 nor P2 met its pre-registered confirmation rule; no useful pool-quality
  signal was detected" — not "zero information" (n=123–156, wide CIs).
- C3: research-only interim baseline (auditor wording): frozen BAL679.v1 graph, long
  side, TOP_MEAN at each 4h decision event; ties resolved ONLY by the registered
  max_active_tie_v1 FNV-1a-64 rule with the full tied set recorded; act only on the
  latest fully closed 4h bar; no action when no tie-broken winner or <2 eligible
  positives; 48-bar horizon at slippageRate=0.001 / commissionRate=0.001;
  paper measurement only — not a live license, allocation advice, or prediction.

Horizon-duration correction (2026-08-24, operator-verified): synthetic 4h bars exist
only during US equity sessions (~2 bars per trading day with overnight/weekend gaps), so
bar counts are NOT wall-clock multiples of 4h. Measured from 53,644 ok-status 48-bar
holds in the oas3 candidate-outcomes: exit − decision median = 34.0 calendar days
(min 22.0, max 571.8 — rare long data gaps inflate the tail); decision → entry median
20h. All earlier "48 bars ≈ 8 days / 192 hours" wording is wrong and superseded; any
cost-annualization or cadence reasoning must use the measured distribution.

Key structural fact surfaced by the audit: with a 100% tie rate, TOP_MEAN's measured edge
flows through the FNV tie-break — the informative object is the TIED top-mean SET, not a
unique asset. Set-level evaluation (e.g. equal-weight tied set vs pool control, offline
from candidate-outcomes) is untested and is the cheapest next analysis.

Repair experiments (from the audit, none run yet): (a) clean Batch 1 replication with
exact frozen windows and complete manifests; (b) P1/P2 repeated on a genuinely future
validation window with any equivalence threshold registered before inspection; (c)
preregistered paper-only forward evaluation recording every tie, stale event, skip, and
fill at the modeled costs.
