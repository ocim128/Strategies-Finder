# TOP_MEAN Price Candidate Features - Technical Plan

Status: planned; no implementation or feature calibration performed

Date: 2026-09-05

Proposed campaign: `TM-PRICE-C1`

## Purpose and scope

Add six causal price measurements to the offline TOP_MEAN candidate-rule checker.
They describe the underlying stock, supplementing the existing pair-graph fields.
Admission requires measured absolute Pearson and Spearman correlation below 0.30
with existing economic fields. Six is a maximum, not a promise that six will pass.

Use an external enrichment sidecar and the existing checker, selection, and outcome
join. Do not change strategies, synthetic-pair construction, entries, exits, trade
management, live selectors, UI, settings, Rust, or Worker code. No database, HTTP
endpoint, background service, deployment, or credentials are needed.

This plan lives beside research artifacts because [docs/README.md](../../docs/README.md)
explicitly excludes implementation plans from `docs/`. Existing plans there are not
the convention to extend. After implementation, document shipped usage in a maintained
guide and retire this plan.

## Existing architecture and implementation seams

| Existing source | Relevant behavior and planned use |
|---|---|
| [TM-L1 final report](../top-mean-mining/FINAL-REPORT.md), [idea log](../top-mean-mining/idea-log.txt), [L2 report](../batch-open-score/sp500_top_mean_1788560534200_jedw/report.txt) | Closed campaigns provide design context, not inherited promotion evidence. The L2 ledger supplies the first discovery snapshots. |
| [sp500-top-mean-causal-features.ts](../../lib/batch-backtest/sp500-top-mean-causal-features.ts) | Four temporal fields, version constants, nullable scalar rows, and strict-prior state updates. Preserve this module and its existing sidecar. |
| [sp500-top-mean-archive-log.ts](../../lib/batch-backtest/sp500-top-mean-archive-log.ts) | `archiveCompletedTopMeanRun` writes `candidate-features.jsonl` and seals file hashes. Use its manifest conventions; do not modify its writer for offline enrichment. |
| [top-mean-rule-checker.ts](../../scripts/top-mean-rule-checker.ts) | `loadCausalTopMeanArchiveFromDirectory` avoids outcome reads; `validateFeatureRows` enforces identity and coverage. Extend with a separate price-sidecar join. |
| Same checker | `candidateProxy`, `RuleAccessTracker`, `neutralizeNullFeatureRead`, `evaluateTopMeanCausalScreen`, `computeTopMeanFeatureStats`, and CLI parsing are the primary change sites. |
| [server-ibkr-csv-loader.ts](../../lib/batch-backtest/server-ibkr-csv-loader.ts) | `parseIbkrCsvPayload` truncates to the latest 100,000 candles and converts invalid volume to zero. Do not use this parser for full-history research features or change its runtime contract. |
| [data-integrity-preflight.ts](../../scripts/data-integrity-preflight.ts), [data-integrity-scan.ts](../../lib/market-data/data-integrity-scan.ts) | Existing deterministic data-quality diagnostics. Useful for preflight; present-day freshness and gap checks are not historical session-completeness certification. |
| [alpaca-ibkr-sync.md](../../docs/alpaca-ibkr-sync.md), [ibkr-data-vite-plugin.ts](../../lib/ibkr-data/ibkr-data-vite-plugin.ts) | The IBKR directory can contain Alpaca/mixed sources. `adjustIntradayCandlesToDailyScale` can rescale prices and volumes against daily CSVs. Audit provenance instead of assuming folder name proves source or adjustment. |
| [max-active-research-contract.ts](../../lib/batch-backtest/max-active-research-contract.ts), [top-mean-campaign-log.ts](../../scripts/top-mean-campaign-log.ts) | Preserve historical tie/bootstrap/window constants and append-only log parsing. Successor registration must identify its own enrichment and windows. |

Planned new implementation files (not created by this plan):

- `scripts/lib/top-mean-price-features.ts`: typed session summaries, six formulas,
  sidecar schema/field constants; no filesystem access or outcomes.
- `scripts/build-top-mean-price-features.ts`: offline CSV/session ingestion, input
  validation, feature construction, and immutable enrichment output.
- `tests/top-mean-price-features.spec.ts` and
  `tests/top-mean-rule-checker-price.spec.ts`: formula/causality and integration tests.

Keep price statistics in the current checker initially. Do not introduce a feature
registry framework or refactor unrelated loaders to share one-use code.

## Feature and causal contract

For decision time `t`, use the latest complete regular session `d` with close time
strictly less than `t`. Every contributing 30m bar must have `barEndSec < t`;
`barStartSec < t` alone is insufficient. Features update after a complete session,
accepting this latency rather than inventing partial-session estimates.

Use exchange-local sessions with DST, holidays, and early closes. Missing sessions
do not shorten a fixed lookback into the last N available sessions. No forward fill.
Freeze the session schedule and timestamp convention before implementation proceeds.

Notation: `r[s] = log(C[s]/C[s-1])`, `g[s] = log(O[s]/C[s-1])`, and `u[s,k]` is
the within-session close-to-close 30m return (first bar measured from session open).
`m[-a,s]` is the equal-weight return of other members of the frozen 136-asset catalog
with valid endpoints on session `s`; require at least 100 peers. Membership uses
only contemporaneous valid endpoints, never future survival or outcome coverage.

| Field | Frozen formula and window | Initial mechanism/direction |
|---|---|---|
| `priceResidualMomentum5` | Fit OLS `r = alpha + beta*m + e` on sessions `d-64..d-5` (60 observations). Sum residuals from that fixed fit on `d-4..d`, divided by `sqrt(5)*sigma`; `sigma = sqrt(SSE/58)` from the fitting window. Requires 66 closing prices. | Higher: recent stock-specific strength beyond usual catalog exposure can distinguish similarly supported pair candidates. |
| `priceReversalRate5` | Across `d-4..d`, opposite-sign adjacent nonzero `u` comparisons divided by all adjacent nonzero comparisons. Never compare across sessions or jump over a zero/missing bar. | Lower: fewer intrabar reversals may distinguish sustained support from whipsaws hidden inside 4h bars. |
| `priceVolExpansion5` | `Q[s] = g[s]^2 + sum(u[s,k]^2)`; `0.5*log(mean(Q[d-4..d])/mean(Q[d-24..d-5]))`. | Lower: less recent variance expansion may reduce selection of stocks whose ratio crossings were driven by a volatility shock. |
| `priceRelativeVolume1` | `log(sum(V[d,k])/sum(median(V[d-20..d-1,k])))`, matching the current session's slots. Each slot needs 20 scheduled, valid prior observations; if an earlier early close omits a required slot, return null, not zero. | Higher: unusual participation may distinguish supported moves from quiet-market price drift. |
| `priceGapFollowThrough20` | Set `j[s]=log(C[s]/O[s])`; over `d-19..d`, `sum(g*j)/sqrt(sum(g^2)*sum(j^2))`. This is uncentered alignment, not Pearson correlation. | Higher: habitual continuation after opening gaps can make gap-generated pair support more credible. |
| `priceCatalogCorrelation20` | Pearson correlation of `r[a]` and `m[-a]` over the 20 scheduled sessions `d-19..d`. | Lower: weaker common-market coupling may identify more independent asset leadership. |

Invalid/missing inputs, insufficient history, zero denominators, singular OLS, or
unresolved adjustment discontinuities yield `null` for affected fields. Price-only
fields remain usable when only volume is invalid. Distinguish genuine zero volume
from missing volume where provenance permits; already coerced zeros are an unknown.
Mechanisms are hypotheses, not evidence of predictive value.

## Data flow and output contract

```text
parent meta + pool-snapshots + catalog + hashed 30m CSVs + session schedule
  -> offline builder -> compact session summaries -> price features per event/asset
  -> external enrichment directory
  -> checker causal loader + explicit enrichment join
  -> feature stats/admission -> registered rules -> causal screen
  -> existing normalized outcome loader -> paired selector evaluation
```

Create an immutable directory under
`archive/top-mean-price-mining/enrichments/<enrichmentId>/` containing:

- `candidate-price-features.jsonl`: `{eventId, decisionTimeSec, asset, <six number|null fields>}`,
  sorted by decision time, event id, and asset. Exactly one row per parent snapshot key,
  including candidates outside the long-eligible pool. No arrays or outcomes.
- `price-feature-manifest.json`: independent schema `top_mean_price_features.v1`,
  formula/availability versions, parent run id and meta/snapshot/temporal-sidecar
  hashes, parent post-assembly fingerprint, canonical catalog, source CSV hashes,
  session-schedule hash, builder-source hash, row count, and sidecar hash.
- `price-feature-audit.jsonl`: per-row field availability reasons and maximum source
  bar-end timestamps; inaccessible to rules. Include its hash in the manifest.

The new checker option is proposed as `--price-features <enrichmentDir>`. Keep the
positional ledger argument at its existing `archive/batch-open-score/<runId>` path.
Without the option, current behavior and output remain unchanged. Parent
`validateV3FileManifest` must remain strict: it rejects undeclared files, so copying
the new sidecars inside the original ledger is not acceptable.

Define enrichment identity as a hash of the canonical manifest, without a self-hash
field. Admission/threshold reports are separate hashed campaign artifacts; registering
a rule binds the parent fingerprint, enrichment identity, and calibration hash.
The parent temporal-sidecar hash can be read without reading any outcomes.

## Phase 1 - Freeze data provenance and calibration protocol

**Objective:** resolve assumptions that could invalidate causal features before coding.

**Tasks:** inventory the parent catalog's canonical CSVs (ignore `.bak`), date ranges,
source metadata, mixed-feed boundaries, timestamp labeling, adjustment policy, and
volume quality. Confirm whether all windows needed for pre-2025 reference calibration
exist. Inspect the existing integrity diagnostics and capture findings without fixing
or rewriting source data. Select and hash a verified regular-session schedule covering
reference and research windows; an authoritative holiday/early-close helper was not
identified in the inspected code, so do not infer early closes from missing bars.

Freeze the correlation protocol before reading selection outcomes: eligible population,
top-five frontier, year/time partitions, weights, categorical encodings, missing-value
handling, minimum sample/block support, bootstrap seed/count/block length, and interval
construction. Choose block length from price/feature persistence, not outcome gains.

**Risks/blockers:** current CSVs can be revised or mixed-source; hashes prove bytes, not
historical availability. Unresolved adjustment or feed changes can mimic momentum,
gaps, or volume shocks. The fixed catalog is a research universe, not historical
point-in-time S&P membership. No feature's correlation has been measured yet.

**Deliverables/validation:** source inventory, hashed schedule, frozen feature/calibration
contract, and representative normal/DST/early-close/IPO/adjustment fixtures.

**Exit criteria:** bar availability and session completeness are explicit; unsupported
source windows are identified; the statistical protocol is executable and frozen.
Unresolved provenance must block causal certification or yield explicit unavailable
windows, never a silent assumption of clean data.

## Phase 2 - Build and seal the external price sidecar

**Objective:** compute reproducible nullable scalars from price prefixes only.

**Dependencies:** Phase 1's source and session contracts.

**Tasks:** implement the formula leaf and offline builder. Stream one canonical CSV
at a time using Node file streams/readline; preserve the existing six-column CSV and
time-normalization conventions without latest-N truncation. Reject malformed rows,
duplicates, and nonmonotonic input rather than choosing a silent last-write winner.
Aggregate compact session/slot summaries, release raw bars, then compute leave-one-out
catalog returns and join snapshots. Reuse session results across same-day decisions.

Write into a staging directory and publish the manifest only after all rows and
hashes validate. Refuse to overwrite a sealed enrichment or write inside the parent
ledger/price tree. Record hashes of bytes actually read and fail if inputs change
during the build. Distinguish fatal schema/I/O/provenance errors from expected
per-feature `null` availability.

**Deliverables:** builder, pure formulas, sidecars, manifest, and audit output.

**Validation:** hand-calculated formula fixtures; independent prefix recomputation;
changing/appending bars ending at or after `t` cannot change its feature values;
session-close equality excludes that session; tests for missing bars, zero volume,
singular fits, early closes, DST, insufficient peers, and new listings. Two builds
from identical inputs must produce identical artifact bytes. Test interruption and
input mutation without leaving an apparently sealed partial result.

**Exit criteria:** exact snapshot-key coverage, causal fixtures pass, source archives
remain byte-identical, and full-catalog build time/peak RSS are recorded. Memory must
scale with compact session history plus output rows, not all assets' raw OHLCV.

## Phase 3 - Join price fields into the existing checker

**Objective:** expose validated price information without weakening legacy contracts.

**Dependencies:** Phase 2 schema and sealed enrichment fixture.

**Tasks:** extend CLI parsing and both causal/normalized loading paths with the explicit
enrichment option. Validate parent identity/hashes, schema, field list, finite-or-null
values, unique keys, matching decision times, and exact coverage before joining.
Add separate price storage/types and access counters rather than appending price names
to `TOP_MEAN_CAUSAL_FEATURE_FIELDS` or changing the temporal schema.

Extend `candidateProxy` and null neutralization: a missing accessed field forces base
`score` for rankings or `true` for filters. Retain forbidden-property, enumeration,
prototype, and mutation checks. Candidate arrays, provenance, and outcomes stay hidden.

`evaluateTopMeanCausalScreen` currently rejects v3 rules with zero temporal-field
reads. With explicit price enrichment, require an admitted price-field read instead;
without enrichment preserve the existing v3 requirement. Do not force a meaningless
temporal read into price-only rules. Preserve legacy access labels and add price labels.
Report price completeness for fields used by the rule separately from the current
all-four-temporal `eventFeaturesFullyObserved` measure.

**Deliverables:** scoped checker changes and CLI/integration tests.

**Validation:** add tampered hash, wrong parent/time, duplicate/missing/extra key,
forbidden field, unknown CLI option, and null-fallback fixtures. Remove outcomes and
report files in a fixture and prove enriched feature stats/screens still work. Verify
legacy tests/output and `score`-only outcome selections remain identical; the existing
successor screen may still intentionally reject a baseline-only rule.

**Exit criteria:** explicit enrichment enables price rules, missing enrichment denies
price access, and no old archive schema, file seal, outcome eligibility, or tie behavior
changes. Errors use existing `CheckerFailure`/CLI failure conventions.

## Phase 4 - Calibrate and enforce feature admission

**Objective:** expose only useful, demonstrably nonredundant information to the campaign.

**Dependencies:** Phases 1-3; no outcome reads are permitted in this phase.

**Tasks:** extend `computeTopMeanFeatureStats`/its formatter for price distributions,
availability by asset/year, incumbent/runner-up distributions, and within-event range.
Existing correlations cover only score, votes, active pairs, and EMA status; expand the
price report to all four temporal fields plus breadth, regime, and calendar.

Apply equal total weight per event (renormalized for each observed feature pair),
weighted Pearson, and weighted midrank Spearman. Check raw and event-demeaned candidate
values, top-five candidates under the existing incumbent ordering, and registered
year/time partitions. Test event constants across event-level feature summaries, with
one-hot categorical encodings; do not claim undefined within-event correlations pass.
Preserve null EMA/temporal values as missing rather than coercing them to false/zero.

Use the frozen contiguous-time-block bootstrap with whole events together. Admission
requires both absolute correlations and the registered upper confidence bound on each
absolute correlation below 0.30 on every required estimable surface. Insufficient
support is UNVERIFIED, not PASS. Test rule-bin transforms too. Report the six-feature
correlation matrix; if a pair exceeds 0.70 in absolute Pearson or Spearman correlation,
retain better coverage, breaking ties by the slate's listed order. Do not search new
lookbacks to rescue a failed feature.

Compute lower/upper quartiles from price-only observations in 2020-2024, weighted
equally per asset; allow earlier bars only as warmup. Freeze quantile/tie conventions.
Write a hashed calibration artifact containing thresholds, protocol, measurements,
and admitted field list. `--feature-stats` may inspect all six fields before admission;
enriched `--screen` and rule evaluation must additionally load the registered calibration
artifact (proposed `--price-calibration <file>`) and allow only its admitted fields.

**Deliverables/validation:** reproducible calibration artifact and tests for weighted
correlations, ties, categorical constants, insufficient samples, threshold boundaries,
artifact identity, and admission enforcement. Verify prefix causality separately from
this retrospective, outcome-blind feature selection step.

**Exit criteria:** only passing fields reach the idea prompt. Fewer than six, or zero,
is a valid result. No outcome evidence is spent compensating for failed admission.

## Phase 5 - Register and run the first successor batch

**Objective:** test a small set of new selection mechanisms on the existing evaluator.

**Dependencies:** admitted fields and immutable calibration from Phase 4.

**Tasks:** create a new campaign prompt, registration, and log under this research
directory, using existing campaign-log conventions. Freeze rule hashes and dependencies
before screening, then record screens/finalists before outcome evaluation. Define
`h_f=-1,0,+1` below the lower quartile, between quartiles inclusive, and above the upper
quartile. Orient `z` positively for momentum/volume/gap and negatively for
reversal/volatility/correlation.

| Rules | Fixed ranking expression |
|---|---|
| P01-P06 | One per admitted field: `score + 0.25*z_f`. |
| P07 | `score + 0.125*(z_momentum + z_volume)`; strength with participation. |
| P08 | `score + 0.125*(z_momentum + z_reversal)`; strength with fewer reversals. |
| P09 | `score + 0.125*(z_volume + z_gap)`; participation with gap persistence. |
| P10 | `score + 0.125*(z_volatility + z_correlation)`; independent support without a variance shock. |

Withdraw rules using rejected fields. Preserve neutral fallback for any missing accessed
field. Deduplicate selection sequences, retain the existing ZERO/THIN/MATERIAL screen
(MATERIAL currently starts at 2% changed events), and evaluate only distinct MATERIAL
rules. Do not fill missing finalists with unregistered variants or tune amplitudes.

Use the existing paired 24-bar long return minus incumbent return as primary outcome,
with the existing same-pool control, costs, eligibility, tie handling, and bootstrap.
Add price-specific availability diagnostics; retain selected-asset concentration and
dominant-selection exclusion, and add highest-contributor exclusion if absent from the
checker report. Keep these in offline results, not production `reportLines` plumbing.

**Risks/blockers:** the current checker hardcodes discovery/validation dates in
`windowSpec`; the already examined 2025-2026 results are discovery context, not a fresh
holdout. Before any forward certification, add a small explicit successor registration
input for windows and parent identity, preserving historical defaults/constants.
`validateIncompleteHeader` also allows incomplete data only for two specific run ids;
do not bypass it for a future archive. Register any new archive's completeness policy
explicitly and retain missing/right-censored outcome exclusion. Fresh validation dates,
minimum worthwhile gain, and independent-block power target remain to be registered.

**Deliverables/validation:** new campaign artifacts, up to ten registered hypotheses,
screen results, discovery comparisons, per-year/per-asset concentration diagnostics,
and exact incumbent parity on the parent ledger. Count all outcome evaluations;
bootstrap seeds are not independent validation samples.

**Exit criteria:** complete discovery accounting with no claim of promotion from reused
data. At most one lead may advance to a separately registered forward window after
the freeze; positive paired confidence bounds and concentration diagnostics are
required there. No automated execution or production selector integration is included.

## Verification and rollback

Implementation checks, run when the corresponding code exists:

```powershell
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno tests\top-mean-price-features.spec.ts
..\..\..\node_modules\.bin\esno tests\top-mean-rule-checker-price.spec.ts
..\..\..\node_modules\.bin\esno tests\top-mean-rule-checker.spec.ts
..\..\..\node_modules\.bin\esno tests\top-mean-rule-checker-v3.spec.ts
..\..\..\node_modules\.bin\esno tests\top-mean-rule-checker-cli.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-causal-features.spec.ts
```

Use temporary fixtures for fast tests and a separate full-ledger parity/build run.
Verify all original archive hashes before/after. No UI/server deployment smoke is
required for this offline-only scope. Validate output paths and keep source credentials
out of manifests; the proxy remains a field-access guard, not a new untrusted-code sandbox.

Rollback is to omit the enrichment/calibration CLI options and use the unchanged sealed
ledger and legacy checker behavior. Retain superseded enrichment/campaign files as
research provenance. No source-data restoration, schema migration, or deployed-service
rollback should be necessary.
