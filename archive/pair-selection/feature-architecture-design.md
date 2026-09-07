# Feature Pipeline Architecture — Accepted Design

Author: thinker agent, 2026-09-07. Accepted by the human. This document is
the design contract for the implementation plan
(archive/pair-selection/feature-pipeline-plan.md). Verbatim recommendation:

Recommend D + E, with a bounded version of B: immutable feature sidecars,
computed from frozen source history, plus a broad initial feature library.
Keep the existing ledger and selection harnesses. Move feature development
out of the batch exporter.

The operating loop becomes: propose rules -> automatically prepare any
missing feature columns -> run the existing checks. A feature addition
requires feature code and tests, but no strategy execution, batch rerun, or
replacement ledger folder — provided the required source history was
preserved.

## 1. Architecture and guarantees

Treat each research folder as three layers with separate compatibility
contracts.

| Layer | Contents | Changes when |
|---|---|---|
| Immutable experiment | Existing ledger: candidate identity, signals, outcomes, strategy/settings provenance | The experiment itself changes |
| Immutable source snapshot | Exact pair bars consumed by the run, preceding warmup history available to it, and historical trade/signal records needed for enrichment | A different dataset or experiment is created |
| Derived feature packs | Numeric feature columns, validity information, and manifests identifying their inputs and definitions | Features are added or corrected |

The experiment is authoritative. Feature packs are reproducible derivatives.

Freeze the actual inputs, not instructions to reload them. Persist compressed
per-pair OHLCV as the batch already processes each pair. For synthetic pairs,
preserve the actual final pair series produced by the existing seed-interval
synthesis and aggregation pipeline. A later generator should not rebuild it
using possibly revised leg data or aggregation code.

Also preserve complete historical closed-trade records if the ledger does not
already contain them. Signal outcomes are not necessarily strategy trades: do
not derive a purported trade equity path from overlapping hypothetical signal
returns. Closed-trade MAE/MFE features require either preserved excursion
measurements with defined semantics or sufficient execution information to
reproduce them.

This makes future enrichment independent of current data loaders, network
availability, revised prices, and temporary Batch artifact retention.
Persistent research snapshots must survive that temporary artifact TTL.

An important boundary: this supports future features derivable from the
preserved inputs. It cannot promise arbitrary future leg-level, intrabar, or
external-data features.

Use one standalone generator. It processes one pair at a time, computes
rolling quantities once, and samples feature values at that pair's ledger
rows. It never executes strategies or recomputes outcomes.

Store packs as compressed numeric columns partitioned by pair, with a
manifest per feature family. Avoid another wide JSONL file. A new feature
writes new columns; it does not rewrite every existing column. Do not add a
database server, distributed scheduler, or separate check-time implementation.

Bind every value to an unambiguous ledger row. For existing folders, a ledger
content hash plus original row ordinal is sufficient; timestamp and pair alone
may not distinguish duplicate signals. A reusable disk index can map pair
partitions back to ledger order without retaining millions of parsed objects.

Version definitions and dependencies, not entire folders. Each feature
definition specifies: stable identifier, revision, parameters, units, and
direction convention; required input capabilities and historical window;
formula, initialization, minimum observations, and missing-value behavior;
exact causal cutoff and dependency revisions. An immutable library release
manifest pins those definitions, their implementation, and the supported
numerical runtime. Each pack additionally pins the source and ledger hashes,
row mapping, and storage format. Each rule batch pins its required feature
definitions and library release.

Adding a feature does not invalidate unrelated features. Correcting a formula
creates a new revision; previous rule batches keep their original revision.
Columns may be reused across library releases only when their definitions and
transitive dependencies are identical.

Replace the global exact-match feature gate with a capability check: "Can
this reader decode the ledger, and are these particular feature revisions
available?" Keep strict validation of ledger formats, hashes, and feature
compatibility. This is narrower validation, not weaker validation.

Enforce causality at the generator boundary. For a signal at bar index s:
- Price features may consume bars with index < s.
- Trade features may consume only trades whose closure was observable
  strictly before s.
- Fire-pattern features may consume only earlier signals.
- A historical signal outcome becomes usable only after its measurement
  horizon has ended strictly before s.

An exit on the signal bar is excluded, regardless of execution timing mode.
Sorting trades by entry time does not establish eligibility. Feature
functions receive historical input views; they do not receive the current
row's outcome or unrestricted future trade records. Explicit causal
definitions and boundary tests remain necessary — API isolation alone is not
proof.

Use null plus observation counts for insufficient history or undefined
estimates. Never silently fill missing features with zero, shorten windows,
or drop candidates. Preparation distinguishes unsupported inputs, not-yet-
materialized, and validly missing observations. The existing rule's explicit
missing-value policy determines eligibility.

Make preparation automatic before CHECK. The coordinator resolves
requirements, validates existing packs, builds missing columns, then invokes
the existing harness through a feature-access adapter. CHECK itself contains
no feature formulas. Cancellation leaves temporary output; only completely
validated partitions are published.

At the stated scale, 100 Float64 columns across 5.63 million rows contain
about 4.5 GB of numeric payload before compression, excluding indexes and
validity information. Keep the generator bounded to one pair and the checker
bounded to required columns and its existing event-processing needs. A 24 GB
heap is comfortable capacity, not a reason to construct one giant
feature-object graph.

No generation-time estimate is justified yet. Broad rolling features can
still be expensive; the gain is eliminating strategy reruns and repeated
human orchestration.

## 2. Trade-offs and rejected alternatives

| Design | Build cost now | Cost per future idea batch | Auditability | Memory / disk |
|---|---|---|---|---|
| Recommended: frozen inputs + incremental packs + initial library | Moderate: snapshot writer, generator, adapter | Existing columns: read only. New columns: bounded enrichment | Strong: pinned inputs, definitions, and results | Additional source storage and compact columns; bounded working memory |
| A. Batch-time features | Lowest initially | Exporter changes and full rerun whenever features expand | Reproducible within retained versions; poor reuse | Repeated multi-GB folders |
| B. Buffet inside exporter | Moderate upfront | Cheap until the first missing feature; then original bottleneck returns | Existing version coupling remains | Large ledger, including unused features |
| C. Pure check-time computation through live loaders | Moderate | Repeated loading/computation unless caching evolves into packs | Determinism fails when loaded history changes | Less persistent feature storage; repeated I/O |
| D. Sidecars without frozen history | Moderate | Cheap enrichment while exact inputs remain available | Cannot guarantee later reproduction | Lower initial disk cost |
| E. Frozen history without packs | Moderate | Recomputes features on repeated checks | Strong input provenance | Source storage plus repeated compute |

Reject A as the permanent architecture. Reject B as the sole solution because
an incomplete buffet recreates the problem. Reject live-loader C and
snapshot-free D because they cannot satisfy determinism. E supplies the
foundation but needs cached feature packs to keep repeated checks cheap.

## 3. First-pass feature scope

Start with a finite catalog, approximately 100-200 scalar columns, rather
than every combination of estimator, window, and lag. A reasonable initial
window vocabulary is 12/48/240 observed bars and 8/32/128 eligible closed
trades, with a few explicitly selected lags. These are observed-bar windows,
not calendar durations. All definitions below end strictly before the signal
bar.

| Family | Initial causal definitions |
|---|---|
| Closed-trade performance paths | Net-return mean and median, win rate, downside dispersion, profit factor where defined, recent-versus-long expectancy, last eligible result, win/loss streaks. Use a fixed return normalization consistent with the harness. |
| Trade drawdown and recovery | Drawdown from a defined cumulative closed-trade return path, rolling maximum drawdown, trades since peak, recovery slope, and concentration of gains/losses. Do not label this an account equity curve unless sizing semantics support that interpretation. |
| Closed-trade excursions and duration | Historical MAE/MFE distributions, realized-return-to-MFE capture, adverse/favorable excursion balance, holding-duration distributions, duration-performance association, and time since last closure. Require adequate preserved trade-path inputs. |
| Spread-path position and shape | On the log of the positive pair ratio: trailing returns, standardized distance from rolling mean/median, distance from trailing extrema, drawdown/run-up, slope, efficiency ratio, and up/down streaks. Define ratio orientation once. |
| Dependence and reversion | Return autocorrelation at selected lags, variance ratios at selected horizons, zero-crossing frequency about a causal rolling center, and trailing AR(1) persistence. Report OU-style half-life only in the valid mean-reverting coefficient region; otherwise null, with fit quality and sample count. |
| Volatility structure | Return volatility, downside/upside variation, normalized ATR, short/long volatility ratios, volatility-of-volatility, range expansion, absolute-return autocorrelation, and gap-versus-intrabar movement. |
| Tail and bar geometry | Tail-loss frequency under an explicitly trailing threshold, skewness, body/range and wick asymmetry, close-location distributions, and jump concentration. Document synthetic OHLC semantics; do not infer synchronized leg extremes. |
| Fire-pattern structure | Prior fire counts, bars since previous fire, interarrival mean/dispersion, clustering, same/opposite-direction balance, direction switches, and fire counts since the last eligible trade closure. Current firing is not historical evidence. |
| Cross-time feature changes | For selected core features: changes versus fixed bar lags, short/long differences, causal slopes, and trailing percentile position. Compute these from historically available feature values, never whole-sample normalization. |
| History quality and support | Available bars/trades, warmup coverage, observed gaps, stale or repeated-price frequency, and valid-observation fractions. These let rules distinguish evidence from thin history. |

Thresholds, conjunctions, and simple ratios of available scalars belong in
rule definitions when supported by the existing harness; they should not each
require another stored column. This scope is intended to cover several idea
batches, not guarantee coverage of every future proposal. Exclude feature
families that require unpreserved external data or selection-dependent
portfolio history.

## 4. Incremental migration

No step needs to invalidate an existing folder. Some legacy folders will
remain unable to support particular new features.

| Step | Independently shippable change and verification | Effect on old folders |
|---|---|---|
| 1. Separate format compatibility from feature requirements | Add explicit legacy v3 — and v4 if already shipped — adapters. Initially expose only understood embedded features. Verify existing rules produce identical candidate ordering, selections, and tallies; unsupported requirements fail clearly. | None. Do not simply remove the gate. |
| 2. Add optional immutable input snapshots | Capture actual pair inputs and required historical records during future exports, without changing signal/outcome generation. Verify snapshot round trips, hashes, and unchanged ledger results. | None. Existing folders lack this capability until separately enriched. |
| 3. Ship a minimal standalone pack generator | Implement one price feature and one eligible-closed-trade feature. Verify strict boundaries, duplicate-row alignment, reproducible output, and interrupted-write recovery. | Additive where sufficient verified inputs exist. |
| 4. Connect packs through the harness adapter | Prefer the exact feature revision requested by a rule; retain legacy access for old rules. Compare both paths on a fixture with equivalent definitions. Keep selection, outcome, tie-breaking, and event semantics unchanged. | None. Existing rules retain their prior definitions. |
| 5. Release the initial library and automatic preparation | Add the families above, publish a pinned catalog, and prepare missing columns before CHECK. Verify multiple rule batches reuse the same ledger without exporter changes or strategy execution. | No blanket rejection. Availability depends on preserved inputs. |
| 6. Retire ongoing batch-time feature development | Freeze legacy embedded fields for compatibility; route future feature additions exclusively through the library. Retain regression coverage for legacy rules. | None. Ledger evolution is reserved for actual experiment-contract changes. |

Legacy backfill needs an honest provenance rule. Recover exact original
inputs from retained files or caches when their identity can be established.
Matching timestamps or reproducing a few signals is insufficient evidence
that the full price history is identical. If exact history cannot be
established: keep the original folder usable for its existing rules and
provably derivable historical-record features; report unavailable new
capabilities explicitly; if desired, create a separately identified
enrichment using a newly frozen dataset, with its provenance disclosed. Do
not present it as an exact reconstruction of the original experiment. No
architecture can retroactively recover discarded information. A one-time
legacy limitation is preferable to silently breaking determinism.

The proposed acceptance tests should include mutation of the signal bar and
all future bars/trades: earlier feature values must remain unchanged. Also
test exits exactly on the boundary, insufficient warmup, reproducible
regeneration, and rejection of mismatched row mappings. These are migration
criteria, not checks performed for this recommendation.

## 5. The two most likely failure modes

1. Temporal leakage or source drift disguised as reproducibility. Likely
   causes are same-bar exits, premature use of historical signal outcomes,
   revised loader data, and full-sample normalization. Cheap guard: immutable
   input hashes, explicit availability cutoffs, and a mandatory
   future-mutation/boundary test suite for every feature revision. Do not
   automatically certify legacy embedded features as causal.
2. The feature library becomes another sprawling schema bottleneck. Hundreds
   of speculative variants, whole-pack rewrites, and per-feature UI plumbing
   would recreate the maintenance burden. Cheap guard: one finite catalog,
   shared window vocabulary, incremental columns, one accessor, and
   generation-time/output-size measurements. A new rule using existing
   features must require zero exporter or harness edits.
