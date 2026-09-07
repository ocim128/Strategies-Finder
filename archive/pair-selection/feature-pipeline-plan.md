# Pair-selection feature pipeline implementation contract

Design authority: [feature-architecture-design.md](feature-architecture-design.md). This plan implements that accepted design with the task's narrower migration scope: **no retroactive repair or enrichment of pre-snapshot folders**. Paths below are relative to the repository root. Paths marked **new** are proposed deliverables, not claims that code exists. Implement one work package (WP) at a time. Each package inherits sections 1–3, 5–7, and its listed dependencies; those sections are normative, not optional background.

## 1. PURPOSE

Feature additions currently require a batch-exporter implementation pass, a human-operated full batch rerun of approximately nine minutes, and a new research folder. The measured v3 experiment has 5,309 loaded pairs, 5.63 million signal rows, 13,147 distinct signal timestamps, and approximately 4.8 GB of `ledger.jsonl`. The motivating incident is `feat_legVolatilityRatio20` being null on 100% of rows. These numbers and that incident are supplied research observations, not measurements performed while writing this plan.

The relevant current mechanisms are `buildTradeLedgerRowsForPair` and `TradeLedgerWriter` in `lib/batch-backtest/trade-ledger-exporter.ts`, the embedded feature definitions in `lib/batch-backtest/trade-ledger-features.ts`, and exact-match provenance gates in **both** `lib/pair-selection/tally.ts:validatePairSelectionProvenance` and `lib/selection-rules/catalog.ts:inspectEntryMeta`. Moving only the tally gate would leave menu discovery coupled to the old version.

Success means five successive idea batches can consume one newly captured experiment folder, with new feature definitions added outside the exporter, automatic preparation before CHECK, and unchanged selection semantics. Adding a feature supported by the frozen inputs must require neither a batch rerun nor a ledger rewrite. New input capabilities are a different matter: information never captured cannot be reconstructed by a feature library.

Non-goals: no database, scheduler, UI work, strategy re-execution during enrichment, portfolio or robustness tooling, or retroactive repair of old folders. There is one intentional human-operated **new capture batch after WP2**. This is the migration capture, not an enrichment operation. Existing folders and historical rule behavior remain intact.

## 2. ARCHITECTURE

### Three layers

| Layer | Authority and contents | Mutation rule |
|---|---|---|
| Immutable experiment | Original `ledger.jsonl`, `provenance.json`, `summary.json`, and `signal-ranks.jsonl`: identities, signals, settings, outcomes, and completeness | Never rewritten by the feature pipeline. Normal export completes these once. |
| Immutable source snapshot | Exact exported pair input bars, actual engine trade records, and the accepted entry-signal sequence bound to ledger rows | Written during the same export; final manifest published once. No later loader calls to fill holes. |
| Derived feature packs | Per-pair numeric columns, validity and observation counts, definition/release manifests, and immutable check receipts | Add missing definitions/partitions. Never overwrite a published definition or pack. |

### Four guarantees

1. **Causality:** for a candidate at signal bar index `s`, new features consume only bars with index `< s`, trades with exit bar index `< s`, and accepted entry signals with signal bar index `< s`. A same-bar exit is excluded in every execution mode. No candidate outcome is available to feature functions. Signal-horizon performance features are outside catalog v1; any later proposal must use outcome availability time, not signal time, for its cutoff.
2. **Determinism:** the same immutable source bytes and pinned library release produce identical values and byte-identical generated artifacts under that release's pinned generation runtime. Pin Node, V8, zlib, platform, and architecture; reject regeneration under a different fingerprint. Existing verified packs remain readable without their original generation runtime. No wall-clock timestamps, random IDs, machine paths, locale-sensitive sorting, or completion-order reductions enter deterministic files.
3. **Self-containment:** copying a completed experiment folder copies every input, mapping, manifest, and materialized value needed for offline checking and enrichment with its matching library checkout/runtime. No symlinks, absolute-path references, mutable price caches, SQLite, network, or temporary Batch artifacts are dependencies. This does not promise to bundle Node or executable application code inside every folder.
4. **No package invalidates an existing folder:** old rules keep their embedded feature semantics and supported readers. A new rule requiring unavailable source inputs fails specifically for that requirement; the folder is not globally rejected or modified. Unsupported, unmaterialized, and mathematically missing are different states.

### Definitions and compatibility boundaries

- **Candidate:** one validated ledger entry-signal row. **Event:** all candidates at the same signal timestamp, as grouped by `lib/pair-selection/tally.ts:loadPairSelectionArchive`. Existing candidate ordering, duplicate rejection, horizon eligibility, reference arms, tie-breaking, and null-score handling in `lib/pair-selection/tally.ts` remain authoritative.
- **Pair:** exact ledger `pair` string and canonical `baseSymbol`/`quoteSymbol` identity; never infer legs from a display name. The metadata path already exists in `lib/batch-backtest/batch-dataset-loader-core.ts:BatchDatasetLoadResult` and `lib/batch-backtest/batch-backtest-runner.ts:BatchBacktestSymbolCompletionContext`.
- **Row ordinal:** zero-based ordinal of each nonempty JSON record in the original ledger traversal, before rank joining, sorting, date filtering, or horizon filtering. Use the blank-line/BOM handling of `lib/batch-backtest/trade-ledger-replay-loader.ts:iterateJsonlLines`. Hash the raw ledger bytes, including whitespace. Ordinals alone never identify a folder.
- **Legacy feature:** an embedded `feat_*` value with its original version-specific meaning. Several v3 fields use the signal bar, explicitly documented in `lib/batch-backtest/trade-ledger-schema.ts:TradeLedgerRow`. Preserve them; do not relabel them as strictly-before features, shift them silently, or alias them to new definitions.
- **New feature:** a catalog definition with a distinct `feat_fp_..._rN` name, strict cutoff, minimum support, units, and pinned implementation. `null` is valid missing data, never a substitute for a missing input file or unimplemented feature.
- **Library release:** immutable inventory of exact feature definitions, dependency digests, implementation files, and generation runtime. WP3 introduces `v0` containing two definitions; WP5 introduces `v1`. Never mutate `v0` to become `v1`.
- **CHECK:** offline preparation, verified loading, then the existing tally. The pair CLI is `scripts/pair-pick-checker.ts`; the menu's pair job is `lib/selection-rules/job.ts:runSelectionRulesJob`. Both will use one preparation implementation. No new UI route or widget is needed.
- **Separate selection harness:** `scripts/selection-checker.ts` and `lib/selection-rules/tally.ts` consume asset-selection archives (`meta.json`, pool snapshots, candidate outcomes, archived baselines). They are not pair-ledger readers. Preserve them unchanged and prove parity; do not invent a pair-to-asset aggregation adapter.

The leg-null incident does not authorize reconstructing legs from ratio bars. Catalog v1 is pair-local and does not implement or repair `feat_legVolatilityRatio20`. The optional aligned leg arrays exposed by `lib/batch-backtest/batch-dataset-loader-core.ts` are not guaranteed present and are not a v1 source capability. A future leg feature needs an explicit future capture contract; old embedded leg-null behavior remains reproducible.

## 3. FILE AND MODULE LAYOUT

### Source modules and exact integration points

| Proposed path | Responsibility and real integration point |
|---|---|
| **new** `lib/pair-features/types.ts` | Data-only snapshot, feature-definition, release, pack, requirement, and reader types. Shared by writer, generator, and adapter. No Node runtime imports. |
| **new** `lib/pair-features/compatibility.ts` | Explicit ledger-format/embedded-feature compatibility table. Shared by `lib/pair-selection/tally.ts` and `lib/selection-rules/catalog.ts`. It does not use the latest exporter constant as a minimum. |
| **new** `lib/batch-backtest/trade-ledger-snapshot-writer.ts` | Node-only snapshot writer owned by `TradeLedgerWriter` in `lib/batch-backtest/trade-ledger-exporter.ts`. Called from the existing awaited export path in `lib/batch-backtest/batch-backtest-vite-plugin.ts:processRunBatch`. |
| **new** `lib/pair-features/artifact-io.ts` | Fixed canonical JSON, streaming SHA-256, gzip, binary-column encoding/validation, and safe relative artifact paths. Exactly two concrete consumers: snapshot writer and pack generator/reader. No pluggable codecs or general storage framework. |
| **new** `lib/pair-features/catalog.ts` | Explicit feature entries and function dispatch. No plugin discovery, DSL, dynamic code loading, or strategy imports. |
| **new** `lib/pair-features/releases/v0.json`, **new** `lib/pair-features/releases/v1.json` | Immutable release inventories; generated values are bound to their exact digests. v0 is WP3, v1 is WP5. |
| **new** `lib/pair-features/families/trades.ts`, `spread.ts`, `volatility.ts`, `dependence.ts`, `geometry.ts`, `fires.ts`, `trends.ts`, `support.ts` | Finite causal feature implementations. Trade performance/drawdown/excursion share `trades.ts`; do not create a module per column. Only `trades.ts` and `spread.ts` are required in WP3. |
| **new** `lib/pair-features/generate.ts` | `generatePairFeaturePack`: validate inputs; process one pair; compute requested definitions and prerequisites; write only missing columns; publish a manifest. Called by CLI and automatic preparation. |
| **new** `scripts/pair-feature-pack.ts` | Thin CLI: `esno scripts/pair-feature-pack.ts <folderPath> <libraryRelease> <featureId>...`. All arguments are positional. Explicit IDs only, no globs, implicit latest release, loader fallback, or format/concurrency flags. |
| **new** `lib/pair-selection/feature-access.ts` | Node reader/preparation adapter. `ensurePairFeatures(folder, rules, signal?)` prepares/validates the union of requirements once; `activatePairFeatures(prepared, rule)` loads only one rule's columns. Serves CLI and menu job. |
| Existing `lib/pair-selection/types.ts` | Optional rule metadata `featureRequirements: { libraryRelease: string; columns: readonly string[] }` and typing for new scalar column names; original `score` and `tieBreak` signatures stay unchanged. |
| Existing `lib/pair-selection/tally.ts` | Provenance compatibility, private row-ordinal retention, optional prepared-feature access, and scalar injection when cloning candidates. No scoring, outcome, gating, sorting, or tie-break rewrite. |
| Existing `scripts/pair-pick-checker.ts`, `lib/selection-rules/job.ts` | Explicit preparation before archive loading, per-rule activation before tally, and immutable check receipts. Retain existing CLI date/horizon arguments and the menu's existing phase/error/cancellation protocol. |

`lib/batch-backtest/batch-backtest-runner.ts` already awaits `onSymbolComplete` and supplies engine signals plus loader identity/context before pruning results. `lib/batch-backtest/batch-backtest-vite-plugin.ts` already passes those inputs to `buildTradeLedgerRowsForPair` and awaits `ledger.appendPairRows`. Extend that call chain, not the engine. `lib/batch-backtest/batch-dataset-loader-core.ts` and `scripts/lib/synthetic-pair.ts` remain read-only reference contracts: freeze the final pair data, never duplicate their synthetic assembly or reload seed legs. No planned production edit is needed in the loader core or runner unless the capture-fidelity test demonstrates an actual missing handoff; any such edit must be limited to handing through the already-consumed data.

Reuse `parseTimeToUnixSeconds` from `lib/time-normalization.ts`, `iterateJsonlLines` from `lib/batch-backtest/trade-ledger-replay-loader.ts`, and compatible rolling/bar-geometry helpers from `lib/strategies/lib/price-action-statistics-core.ts` and `lib/strategies/lib/price-action-frequency-core.ts`. Verify each helper's window, padding, units, and inclusive-index semantics before reuse; sample at `s - 1` where appropriate. Helpers enter the release dependency digest. Do not import a browser-bound barrel just to obtain a helper.

Use Node builtins `node:fs`, `node:fs/promises`, `node:stream/promises`, `node:crypto`, `node:zlib`, `node:buffer`, and `node:path`; add **no dependencies**. The project already declares Node typings and `esno` in `package.json`. The SHA-256 helpers in `lib/batch-backtest/sp500-top-mean-archive-log.ts` are largely private or read entire files; do not import that larger archive subsystem or read a 4.8 GB ledger into a Buffer to reuse them. Keep the small streaming hash implementation in the new, concretely shared `artifact-io.ts`.

### Experiment-folder layout

All paths below are beneath the actual per-run directory created by `lib/batch-backtest/trade-ledger-exporter.ts:TradeLedgerWriter.create`, normally under `archive/mining-ledger/`. The four existing ledger files retain their format and meaning.

```text
<run>/
  ledger.jsonl
  provenance.json
  summary.json
  signal-ranks.jsonl
  source-snapshot/
    manifest.json
    pairs/<pairKey>/bars.jsonl.gz
    pairs/<pairKey>/trades.jsonl.gz
    pairs/<pairKey>/entries.jsonl.gz
  feature-packs/
    releases/<libraryRelease>.json
    columns/<definitionDigest>/<pairKey>/values.f64le.gz
    columns/<definitionDigest>/<pairKey>/valid.u8.gz
    columns/<definitionDigest>/<pairKey>/observations.u32le.gz
    families/<familyId>/<familyManifestDigest>.json
    manifests/<packDigest>.json
    checks/<receiptDigest>.json
```

`pairKey` is the full lowercase SHA-256 of the canonical JSON tuple `[pair, baseSymbol, quoteSymbol]`. It is a safe directory token, not a replacement for identity; the manifest carries the tuple. All paths are folder-relative, forward-slash paths validated to remain within the run. Reject symlink/reparse-point escape and path traversal. The current catalog containment pattern is in `lib/selection-rules/catalog.ts`; retain its existing route-level behavior.

### Snapshot format and publication

Use UTF-8 canonical JSON Lines, LF line endings, and a trailing LF per nonempty file, gzip level 6 with no filename/comment and a zero timestamp. Empty record streams decompress to zero bytes. Canonical JSON recursively sorts object keys by code-unit order, preserves array order, emits finite numbers with the runtime's JSON numeric representation, normalizes negative zero to zero, and rejects undefined/nonfinite required fields. This deliberately canonicalizes JSON only, not the original experiment ledger. Fixed generation runtime plus golden gzip tests establish compressed-byte reproducibility.

- `bars.jsonl.gz`: each line is `[timeSec, open, high, low, close, volume]`, retaining the exact input order and values. Normalize time with `parseTimeToUnixSeconds`; require finite values and strictly increasing, uniquely mapped times. Never sort, repair, resample, truncate, or fetch missing warmup during capture. The first captured bar is index 0. Capture the entire actual input array, including any warmup already in it; promise no earlier history.
- `trades.jsonl.gz`: each line preserves one actual `Trade` from `result.trades`, in original array order, with `tradeOrdinal`, `id`, `direction`, `entryTimeSec`, `exitTimeSec`, `entryBarIndex`, `exitBarIndex`, `entryPrice`, `exitPrice`, `pnl`, `pnlPercent`, `size`, nullable `fees`, and nullable `exitReason`. These are fields/types supplied by `lib/types/strategies.ts:Trade`, with explicit time/index projections. No deduplication or inferred position grouping. A partial-exit record remains a record; performance features are explicitly closed-record statistics. Missing mappings fail snapshot capture. Do not reconstruct executed trades from ledger `asIf` or `horizons`.
- `entries.jsonl.gz`: each line is `[rowOrdinal, signalBarIndex, direction, signalTimeSec]`, following the corresponding successfully appended ledger rows exactly. These are **accepted entry candidates**, after the existing exporter's deterministic duplicate collapse, not every raw strategy signal. Fire features count this sequence. Store no outcome fields here.

The snapshot writer receives the already-built `pairRows`, exact `data`, complete `trades`, and canonical identity in the same awaited append operation. Record ordinal ranges from successful ledger appends, never attempted writes. Snapshot writes finish before the per-pair callback releases its inputs; do not retain all pairs, launch unbounded writes, or alter existing artifact submission/backpressure behavior in `lib/batch-backtest/batch-backtest-vite-plugin.ts`.

Capture every successfully executed pair, including an empty entry sequence or zero closed trades; those are valid empty histories, not missing files. Load/run failures remain failures in the original experiment accounting and get no invented source partition. New export setup must refuse an already-existing run directory before writing provenance or appending a ledger; report the existing ledger-creation failure path instead of modifying a prior folder. This is an immutability fence, not a new folder-naming configuration.

`source-snapshot/manifest.json` fields: `formatVersion: 1`, `writerRevision: 1`, `complete: true`, `ledgerSha256`, `ledgerBytes`, `ledgerRowCount`, `provenanceSha256`, `summarySha256`, nullable `ranksSha256` (absence explicit), `runtime` fingerprint, `capabilities: ["pair_bars_v1", "closed_trade_records_v1", "entry_candidates_v1"]`, and `pairs`. Each pair entry carries identity, `pairKey`, `barCount`, first/last bar times, `tradeCount`, `rowStart`, `rowCount`, and each file's relative path, record count, compressed byte count, and compressed/uncompressed SHA-256. `pairs` sorts by `rowStart` then `pairKey` using code-unit ordering. A pair's rows are contiguous in newly captured exports; reject a repeated noncontiguous partition, rather than add an external-sort framework.

Hash the ledger and other experiment files after their successful finalization, by streaming. Verify entries cover every ledger row exactly once and agree on identity/index/time/direction; validate first/last/index bounds. The snapshot manifest's SHA-256 is `sourceSnapshotSha256`; it does not contain its own hash. Publish it last through a same-directory temporary file and rename. Snapshot partitions use the same write-temp/validate/rename pattern.

Snapshot failure must not change strategy results or claim successful enrichment readiness. Leave the original ledger usable when it is complete; omit the complete snapshot manifest and record an explicit snapshot failure in the existing terminal summary text plus a diagnostic `source-snapshot/error.json`. Error diagnostics are not deterministic artifacts. A canceled/incomplete ledger never receives a complete snapshot manifest. Avoid marking an otherwise complete ledger incomplete solely for optional snapshot failure. New exported folders capture snapshots automatically whenever the existing ledger toggle is on; add no setting or UI toggle. Snapshot capture is optional at the experiment level because ledger export itself is optional.

### Numeric packs, manifests, and row binding

Within each pair, every column has exactly `rowCount` entries in `entries.jsonl.gz` order. `values.f64le.gz` is consecutive IEEE-754 Float64 little-endian values; `valid.u8.gz` is one byte per entry, 0 or 1; `observations.u32le.gz` is one UInt32 little-endian count per entry. Invalid values store the canonical +0 payload and validity 0, decoded to `null`. Valid values must be finite. Count fields do not silently wrap; reject overflow. Observation counts record actual available valid observations for that definition, capped at its requested window. Undefined denominators may therefore yield null with full support.

Resolve a requested `<featureId>_n` by finding the exact parent definition, preparing its existing observation stream, and exposing that count as a finite integer scalar. Keep the requested accessor in the requirement/receipt; deduplicate generation by the parent definition. Count-only activation need not load the value stream. Unknown parent IDs or malformed suffixes reject. The CLI and automatic preparation use this same resolution rule.

This fixed format needs no Arrow/Parquet dependency or generic schema engine. 100 value columns on 5.63M rows are approximately 4.5 GB uncompressed before validity/counts; the generator holds one pair, and the checker loads only the current rule's required columns into typed arrays. Gzip disk size and preparation runtime must be measured, not promised.

Each immutable release JSON has `releaseId`, `catalogFormatVersion: 1`, `runtime`, and sorted `definitions`. Each definition has `id`, `family`, `revision`, `units`, `directionConvention`, `parameters`, `requiredCapabilities`, `minimumObservations`, `missingPolicy`, `cutoff`, `formula`, `dependencies` (exact definition IDs/digests), and `implementationFiles` (repo-relative paths and SHA-256, including transitive helper implementations). `definitionDigest` is SHA-256 of that canonical definition excluding its own digest. No current Git HEAD or unrelated source file participates. The release digest hashes its canonical file. Retain old release implementations or exact checkout references; never generate an old release with changed helper code.

Copy the release JSON into `feature-packs/releases/` before publishing a pack. Its filename alone is not trust: verify its digest and implementation/runtime fingerprint for generation. If the same release name already exists with different bytes, reject it.

Each family manifest contains `formatVersion`, `familyId`, `ledgerSha256`, `ledgerRowCount`, `sourceSnapshotSha256`, and sorted feature entries. Each feature entry carries `id`, `definitionDigest`, and per-pair file paths, lengths, hashes, row counts, null counts, and minimum/maximum observation counts. It describes only the requested features in that family, not an obligation to compute the whole family.

The pack manifest contains `formatVersion: 1`, `libraryRelease`, `libraryReleaseSha256`, `ledgerSha256`, `ledgerRowCount`, `sourceSnapshotSha256`, `requestedFeatureIds`, and sorted family-manifest paths/hashes. Hash its canonical bytes for `<packDigest>`. Exclude generation duration and timestamps. A new request can publish a new small manifest referring to unchanged column files. Reuse a column only if its definition digest, source hash, ledger hash, and pair mapping all match, including dependency digests. A request-order permutation must produce the same manifest.

All validation completes before a manifest is published. Existing manifests remain valid during interrupted generation. Ignore unreferenced temporary files; on the next invocation delete/recompute only this generator's verified in-folder temporary paths. Use exclusive temporary-file creation and atomic publication: concurrent invocations may redundantly compute a missing partition, but must validate identical bytes and converge on one artifact; neither may overwrite a different published artifact. No scheduler, resumable-job database, or general lock service.

### Harness adapter and receipts

Extend `PairSelectionRule.metadata` only with the exact release and column requirements above; old rules omit it. New rules read new numeric scalar fields on the ordinary `PairCandidate`, with a narrow `feat_fp_` template-string type in `lib/pair-selection/types.ts`. Do not use arbitrary row spreading from JSON into the rule-visible object.

Retain a private ledger ordinal on archive candidates during `lib/pair-selection/tally.ts:loadPairSelectionArchive`. At candidate-clone time, the adapter uses the original candidate's ordinal to attach **only the current rule's requested scalar fields**. Strip the private ordinal from rule-visible clones. The archive owns the feature reader; rules never receive it, typed arrays, filesystem handles, trades, future values, or outcomes. Add an optional final feature-context argument to internal/public pick helpers only where necessary to preserve existing direct callers. Legacy calls without requirements follow the original path.

Preparation validates the snapshot/ledger binding before tally loading. Activation fills one global typed array per requested value/count from its pair partitions; replace/release the previous rule's arrays on activation. Expose observation counts through the corresponding `<featureId>_n` scalar only when explicitly requested; it refers to the same stored count stream and is not a separate formula. Compare catalog IDs against requirements; missing definitions fail, while valid nulls pass to the unchanged rule missing-value policy. Never silently drop candidates or substitute zeros.

`ensurePairFeatures` has one implementation used by the new pack CLI (through `generatePairFeaturePack`), `scripts/pair-pick-checker.ts`, and `lib/selection-rules/job.ts`. Union preparation occurs before the menu's one archive load; the existing job already reuses one archive across rules in `lib/selection-rules/job.ts`. Avoid union-wide value materialization. Date filtering must happen after binding the original row ordinals; `--from` must not reset history.

Write `feature-packs/checks/<receiptDigest>.json` for feature-aware checks only: `formatVersion`, ledger/source hashes, ordered rule keys with source-file digests and normalized parameters, release/definition/pack digests, selected horizons, nullable date boundaries, and a digest of deterministic picks/report results (exclude timing/heap diagnostics). The CLI writes its receipt after successful tally; the menu writes one after all successful rule tallies. Failures/cancellation do not publish a success receipt. Receipts pin what was tested without altering report arithmetic or legacy report lines. Rule source digests include imported scoring helpers where present. Do not build a code bundler to archive arbitrary rule closures; registered source modules and their explicit dependency lists are the supported surface.

## 4. WORK PACKAGES

### Shared completion gate for every package

Before edits, read `README.md`, `lib/app-bootstrap.ts`, `index.ts`, applicable `AGENTS.md`, this plan, and the package's immediate callers; inspect `git status --short`. Do not alter the accepted design document or unrelated work. Establish the unfiltered test baseline, then make surgical changes. All package acceptance tests below are mandatory in addition to section 6's full-suite gate. Never claim a package shipped with failures or silently skipped tests; report a blocked validation condition with the actual failing commands instead of weakening tests. Each package must be deployable before the next one exists.

### WP1 — Decouple compatibility from latest feature version

**Depends on:** none.

**Scope:** add explicit compatibility decisions for understood ledger/feature versions and required capabilities. At the inspected baseline, the exporter is ledger v3/feature v3 and the shared replay schema lists ledger/feature v2 and v3 (`lib/batch-backtest/trade-ledger-schema.ts`); pair selection additionally requires fixed-horizon fields (`lib/pair-selection/tally.ts`). Therefore pair selection supports the understood v3 shape, while v2 stays supported by its existing replay consumers but is not magically granted missing horizons. Add v4 only if a real shipped schema and fixture exist by implementation time; never accept an invented v4 or all versions greater than three.

**Files:** new `lib/pair-features/compatibility.ts` and `types.ts`; edit `lib/pair-selection/tally.ts`, `lib/pair-selection/types.ts`, `lib/selection-rules/catalog.ts`; update `tests/pair-pick-checker.spec.ts`, `tests/selection-rules-server.spec.ts`; add `tests/pair-feature-compatibility.spec.ts`. Read `lib/batch-backtest/trade-ledger-replay-loader.ts` and `trade-ledger-schema.ts`; do not loosen their completeness/replay gates.

Do not rewrite every registered rule to declare requirements in this package. Metadata absence means legacy behavior. For a metadata-declaring new rule, report unavailable capabilities explicitly until packs exist. Some registered rules currently read optional, not-yet-populated fields, for example `lib/pair-selection/historical_adverse_excursion_target.ts` and `lib/pair-selection/pair_drawdown_recovery_target.ts`; leave their keys and behavior intact rather than silently mapping new close-excursion/additive-drawdown definitions onto them.

**Acceptance:** existing v3 picks, candidate order, reference results, ties, eligible counts, and deterministic report text are identical before/after; catalog discovery and direct CLI loading agree; malformed/unknown schemas still reject; v2 replay fixtures still pass and v2 pair selection still reports the missing horizon capability; an unrelated feature-library release cannot reject a supported folder; unsupported new requirements name the rule and missing capability. Existing all-null legacy columns remain null without fabricated data. End with full-suite gate green.

**After shipping:** existing folders stop depending on the latest exporter constant. No new values or snapshots yet; no human batch rerun. **Old folders invalidated: none.**

### WP2 — Capture immutable source inputs during normal ledger export

**Depends on:** WP1.

**Scope:** implement the snapshot layout/publication contract in section 3. Capture automatically with the existing ledger toggle. Extend the exporter append operation with its source inputs; handle snapshot errors separately from ledger write failures. Capture before callback return/pruning, finalize ledger first, then hash and finalize the snapshot. No new data loads and no feature formulas. Preserve original ledger bytes for identical fixed inputs, including legacy embedded features.

**Files:** new `lib/batch-backtest/trade-ledger-snapshot-writer.ts`, `lib/pair-features/artifact-io.ts`; extend `lib/pair-features/types.ts`, `lib/batch-backtest/trade-ledger-exporter.ts`, `lib/batch-backtest/batch-backtest-vite-plugin.ts`. `lib/batch-backtest/batch-backtest-runner.ts`, `lib/batch-backtest/batch-dataset-loader-core.ts`, and `scripts/lib/synthetic-pair.ts` are inspected contracts; do not change their algorithms. Add `tests/pair-feature-snapshot.spec.ts`; extend `tests/trade-ledger-exporter.spec.ts` and `tests/batch-backtest-server-plugin.spec.ts`.

**Acceptance:** round-trip all bars/trades and canonical times; full entry-row mapping with two directions at one timestamp; exact captured input identity versus the existing executor handoff; no extra loader or executor calls; unsuccessful ledger append cannot get a valid source mapping; snapshot I/O failure leaves a complete legacy ledger checkable and reports snapshot failure; cancellation/fatal path never publishes completeness; full export fixtures keep original ledger/rank bytes and results. Test zero-entry/zero-trade partitions and refusal to reuse an existing run directory without changing any of its bytes. Verify capture reads only one completion payload at a time and its promise delays callback completion. Verify persistent snapshots survive temporary Batch artifact release. End with full-suite gate green and the Vite build/import check.

**Human action at this package:** after WP2 passes, the human runs **one normal Batch with “Save trade ledger” enabled**, producing a new folder. Check ledger completeness, snapshot completeness, row counts/hashes, and coverage against that run's actual loaded/row-bearing pair counts. Do not expect an exact repeat of the motivating dataset's counts if inputs differ. Preserve the existing folders.

**Immediately possible:** ordinary legacy checks work on the new folder; its bars, actual trades, and candidate mappings are frozen and portable, so WP3/WP5 can enrich it offline later without another batch run. Snapshot capture alone does not yet create new features. **Old folders invalidated: none; old folders repaired: none.**

### WP3 — Minimal offline generator and immutable v0 pack

**Depends on:** WP2.

**Scope:** implement release/column/family/pack formats, streaming validation, publication, and the positional CLI. Release v0 contains exactly `feat_fp_spread_log_return_b12_r1` and `feat_fp_trade_mean_net_pct_t8_r1` plus their count accessors. Use the full definition template in section 5 for the first. For the second, take the arithmetic mean of the last eight eligible closed records' captured `pnlPercent`, in `(exitBarIndex, tradeOrdinal)` order; include all trade directions as actually executed, do not subtract fees again, require eight finite records, and return null otherwise. Its units are percentage points of the engine's captured trade-return measure, not a recomputed return.

**Files:** new `lib/pair-features/catalog.ts`, `releases/v0.json`, `families/spread.ts`, `families/trades.ts`, `generate.ts`, `scripts/pair-feature-pack.ts`; extend `types.ts` and `artifact-io.ts`. Add `tests/pair-feature-generator.spec.ts`, `tests/pair-feature-causality.spec.ts`, `tests/pair-feature-reproducibility.spec.ts`, and shared `tests/fixtures/pair-features/fixture.ts` for in-test synthetic inputs. No production market-data fixture or giant committed binary.

The generator's historical boundary advances monotonically per pair. Before evaluating all entries at `s`, expose bars and closures only through `s - 1`; append the current entries to fire history only after all entries at `s` have been evaluated. Keep unrestricted trade records in the generator, not in formula arguments; formulas receive only eligible historical records. Precomputation may scan future bars for later outputs only when mutation tests prove each earlier output prefix independent. No outcome columns are supplied at all.

**Acceptance:** hand-calculated two-feature values; mutations to bar `s` and every later bar/trade leave outputs for entries at or before `s` unchanged; mutation of a contributing prior bar/trade changes the appropriate result; same-bar exits excluded; eight-record threshold and 13-close return warmup tested; valid undefined calculations return null plus support; truncated/misordered/duplicated/wrong-pair entries reject; altered ledger bytes, source bytes, and ordinal counts reject loudly. Repeated clean generation, reordered feature requests, and interrupted/resumed generation are byte-identical under the pinned runtime; corrupt existing columns reject rather than get trusted by filename. Offline test replaces loader/network/executor access with throwing sentinels. End with full-suite gate green.

**After shipping:** the WP2 folder can receive the two sample columns via CLI without strategy execution. Existing folders without a snapshot receive “source snapshot required; this folder is unchanged,” with no repair attempt. **Old folders invalidated: none.**

### WP4 — Consume prepared columns through the proven pair harness

**Depends on:** WP3.

**Scope:** implement `feature-access.ts`, exact rule requirement resolution, ledger-bound candidate scalar injection, per-rule activation, and receipts. In this package preparation validates existing packs only; missing packs produce the precise WP3 CLI invocation. WP5 turns on automatic generation. Add metadata-declaring fixture rules in tests, not new production research ideas. Keep CLI/menu signatures, reports, event sets, and outcomes intact.

**Files:** new `lib/pair-selection/feature-access.ts`; extend `lib/pair-selection/types.ts`, `lib/pair-selection/tally.ts`, `scripts/pair-pick-checker.ts`, `lib/selection-rules/job.ts`, and pack types as needed for receipts. Add `tests/pair-feature-access.spec.ts`; extend `tests/pair-pick-checker.spec.ts`, `tests/selection-rules-server.spec.ts`, and `tests/pair-selection-registry.spec.ts`. `lib/selection-rules/tally.ts`, `lib/selection-rules/types.ts`, and `scripts/selection-checker.ts` are unchanged parity targets.

**Acceptance:** a fixture rule sees exactly the scalar values obtained directly from the v0 generator; feature and embedded fixture paths with deliberately equal numeric inputs yield identical picks/tallies; no actual legacy alias is introduced. Rules cannot observe outcomes, full columns, ordinal internals, or source records. Zero-valid-candidate events behave exactly as existing scoring specifies. Original candidate and benchmark ordering survives activation changes and duplicate timestamps; the existing duplicate-candidate rejection still operates. Date-filtered checks retain pre-range feature history and original ordinals. Changed ledger order/hash, wrong pair partition, unknown feature revision, missing column, and source mismatch reject before a tally result. Rules with no requirements work unchanged without snapshots. The menu loads one base archive, releases previous rule arrays, and preserves Stop/ownership behavior. Receipt references resolve offline. End with full-suite gate green.

**After shipping:** a rule declaring the two v0 features can use previously generated packs in CLI or existing menu jobs. No second capture run. **Old folders invalidated: none.**

### WP5 — Catalog v1 and automatic preparation before CHECK

**Depends on:** WP4.

**Scope:** implement the finite family inventory in section 5, publish immutable `v1.json`, and make `ensurePairFeatures` generate missing required columns through `generatePairFeaturePack`. Resolve the selected rules' requirements once, compute their union, and then activate only one rule's columns at a time. Features not requested are not automatically materialized. A supported input capability with all-null output produces an explicit coverage diagnostic; missing capabilities fail. Preparation cancellation uses the existing `AbortSignal` and phase/error channel in `lib/selection-rules/job.ts`; do not create UI controls or job infrastructure.

**Files:** extend `lib/pair-features/catalog.ts`, `families/spread.ts`, `families/trades.ts`, `generate.ts`, `lib/pair-selection/feature-access.ts`; add the remaining family modules and `lib/pair-features/releases/v1.json`. Update `lib/selection-rules/job.ts` and `scripts/pair-pick-checker.ts` only for automatic preparation/error/receipt integration. Add `tests/pair-feature-catalog.spec.ts` and `tests/pair-feature-pipeline.spec.ts`; extend causality, generator, reproducibility, access, and server-job specs. Catalog is explicit, not generated by strategy manifest tooling.

**Acceptance:** every v1 definition has formula/units/support/cutoff metadata and at least one independent expected-value fixture; every family passes mutation and boundary suites. All-null output is distinguishable from unsupported input and from not-yet-materialized data. Five fixture idea batches with overlapping/new requirements use one captured folder; unchanged columns keep byte hashes; no exporter/loader/strategy call occurs; original ledger hash never changes. Failed or canceled preparation emits no success tally/receipt and leaves previously published packs readable. Test a concurrent duplicate request converges safely without a service. Log generation duration, compressed bytes, per-column support/null totals, and peak process memory outside deterministic files. On the WP2 folder, measure a representative v1 requirement set with a 24 GB Node heap; no second batch capture is required. End with full-suite gate green.

**After shipping:** the human selects rules and runs the existing CHECK workflow; missing supported features prepare automatically. A builder only implements a new catalog definition/test when genuinely new mathematics is needed. **Old folders invalidated: none.**

### WP6 — Freeze legacy exporter features and close the migration

**Depends on:** WP5.

**Scope:** document and lock the boundary: future feature additions use catalog revisions, never exporter feature bumps. Preserve legacy columns, readers, and code paths for historical rules. No removal/refactor of legacy feature formulas and no rule-key retargeting. New experiment fields may still require a real format migration in future; this contract does not forbid legitimate ledger evolution.

**Files:** add concise boundary comments to `lib/batch-backtest/trade-ledger-features.ts` and `lib/batch-backtest/trade-ledger-schema.ts`; update `docs/trade-ledger.md`; add **new** `docs/pair-feature-pipeline.md` with CLI, capture, capability/null, runtime, and revision instructions. Extend `tests/pair-feature-pipeline.spec.ts` and the existing trade-ledger/pair-selection parity fixtures only with boundary assertions, never by accepting changed expected results. Do not change the accepted design document.

**Acceptance:** add a test-only later library definition/release without editing exporter files or changing ledger bytes; older v0/v1 packs and rules remain usable; supported old folders still run their old rules; unsupported new requirements fail with no folder writes; receipts identify exact definitions. Verify all six deliverables and human capture evidence are recorded in the builder handoff. End with full-suite gate green; report any unavailable manual evidence rather than claiming completion.

**After shipping:** feature development and export development are separate contracts. No further migration run. **Old folders invalidated: none.**

## 5. FEATURE CATALOG v1

### Common vocabulary and numerical conventions

- Bar windows are `B = {12, 48, 240}` observed pair bars; trade windows are `T = {8, 32, 128}` eligible closed records. No optimization/configuration knobs for windows. Return-based windows of B observations need B+1 closes. Two directions at one timestamp share the same historical prefix.
- Column names: `feat_fp_<family>_<metric>_<windowTokens>_r<revision>`, with lowercase snake case and explicit units where necessary (`pct`, `bars`). Examples: `feat_fp_spread_log_return_b12_r1`, `feat_fp_trade_mean_net_pct_t8_r1`, `feat_fp_dependence_return_acf_b48_l1_r1`. No lookback token means an explicitly defined lifetime/last-observation feature. `_n` is the observation-count accessor for the complete preceding ID.
- Positive pair ratio is BASE/QUOTE exactly as captured; log-path features use `x[j] = ln(close[j])` and increments `r[j] = x[j] - x[j-1]`. Do not invert the series for short candidates. Trade records already carry their actually executed direction and captured `pnlPercent`; no second sign flip or fee subtraction. Direction-relative fire features use candidate direction only as a selector over earlier fires.
- Use population moments, arithmetic mean, sorted median with mean of the middle two, and fixed oldest-to-newest reduction order. Require complete requested windows; no partial-window estimates. Nonpositive close, zero variance/denominator, or insufficient valid support yields null and an observation count. Never use epsilon denominators unless a future explicit revision defines one.
- Windows count observations, not elapsed wall time. Gap quality is measured separately using the run interval. Warmup comes only from captured bars/trades; no pre-run trades are invented. No current-bar calendar or cross-sectional fields enter the strict feature catalog.

### Finite family inventory

Implement these families and expansions only. `B`/`T` means exactly the three windows above; explicitly named two-window comparisons are single definitions. The inventory should yield roughly 100–200 value columns, with count accessors stored in the same column artifacts; it is a ceiling guide, not permission to add speculative metrics. Freeze the exact expanded list and formulas in `releases/v1.json` before publishing any v1 pack.

| Family / implementation | Required initial metrics and causal meaning |
|---|---|
| Closed-trade performance — `families/trades.ts` | For T: mean/median captured net `pnlPercent`, fraction strictly positive, downside RMS relative to zero, profit factor as positive sum / absolute negative sum (null without losses). Once: last result, terminal winning/losing streak lengths (zero ends either streak), and mean difference t8 minus t128. All records close before s. |
| Trade drawdown/recovery — `families/trades.ts` | For T: on the additive percentage-point path starting at zero within that window, current drawdown from the running peak, maximum drawdown, and records since most recent peak. Add largest-positive contribution / total positive contributions at t32, null without gains. Name these additive closed-record drawdowns, never account-equity percentage drawdowns. |
| Closed-trade duration/excursion — `families/trades.ts` | For T: median hold bars, median **interior-close** MAE and MFE. For each eligible record use only closes with `entryBarIndex < j < exitBarIndex`, relative to actual entry price and signed by trade direction; MAE = max(0, negative of minimum signed percentage return), MFE = max(0, maximum signed percentage return). Empty interior is null. At t32 add median net-return/MFE capture (positive MFE required), mean MFE-minus-MAE, and Pearson duration/net-return correlation. Once: bars since last eligible exit. Do not claim intrabar execution MAE/MFE: `lib/types/strategies.ts:Trade` has no such fields. These deliberately named close-excursion statistics preserve the design without changing the engine. |
| Spread position/shape — `families/spread.ts` | For B: log return over B bars; last log close's z-score within B log closes; last log close minus rolling median; distance below maximum; distance above minimum; OLS slope of log close against bar ordinal; efficiency = absolute net log change / sum absolute increments. Once: up/down close-increment streak lengths. |
| Dependence/reversion — `families/dependence.ts` | At b48 and b240: Pearson return autocorrelation at lags 1 and 4; overlapping-return variance ratios at horizon 4, using population variances and full required support; AR(1) slope with intercept on log close, its R-squared, and half-life `-ln(2)/ln(phi)` only for `0 < phi < 1`. At b48: sign-crossing frequency of the causal deviation from its rolling 12-bar center; each historical deviation uses its own prefix. Null degenerate fits. |
| Volatility structure — `families/volatility.ts` | For B: return standard deviation, downside/upside RMS, normalized simple-average true range (prior close required) divided by the last prior close, all in declared units. Once: std b12/b240, ATR b12/b240, std of trailing 48 historical b12 volatility values, lag-1 autocorrelation of absolute returns at b48, last prior range / mean range b48, and mean absolute opening-gap move / mean absolute intrabar close-open move at b48. |
| Tails/bar geometry — `families/geometry.ts` | At b48: population return skewness; downside-tail frequency where each historical return is compared with minus twice its **preceding** b48 return standard deviation; maximum absolute return / sum absolute returns; mean body/range fraction, signed upper-minus-lower wick/range fraction, and close location within bar range. Zero-range bars are undefined for ratios, not silently zero. Every rolling output is evaluated before s. |
| Fire structure — `families/fires.ts` | For B: earlier candidate counts, same-minus-opposite counts, and count of distinct fired bars / B. Once: bars since preceding fired bar, counts since last eligible trade closure; over last eight distinct fired-bar gaps: mean gap, population gap std, and coefficient of variation. At b48: proportion of consecutive fired-bar direction states that change, with a separate mixed state for both directions on one bar. Never let ordering of current same-bar candidates affect values. |
| Cross-time changes — `families/trends.ts` | For spread z-score b48, return std b48, and fire count b48 only: value now minus value at s-12, OLS slope across the last 12 historical feature evaluations, and percentile rank against the preceding 48 historical feature evaluations (strictly less + half ties, divided by 48). Historical evaluations use their own strictly-before cutoffs at every bar, including bars with no fire. Missing prerequisite history yields null; no whole-sample ranking. |
| History support — `families/support.ts` | Available preceding bar and eligible trade counts, prior fire count, warmup fraction min(prior bars/240, 1), and at b48: missing expected interval-slot count plus repeated-close fraction. Observation counts accompany every definition. Support counts may be zero and remain valid; estimated performance features do not become zero for lack of support. |

A family-level definition must be expanded into an exact formula entry before release: specify observation selection, support count, denominator, initialization, null cases, and units. There is no license to choose different meanings in different modules. Use explicit prerequisite IDs for trends; a short recursive closure over the concrete definition list is sufficient, with cycle rejection. No general computation-graph framework.

### Approved-rule definitions — v1 must include these ten columns

Ten registered rules await data and read fields that ledger v3 does not
carry. Their exact causal definitions are already approved
(archive/pair-selection/ideas-batch1-mtpt2fxs.json — spread-path shape,
fire-pattern structure, feature trends, trade-outcome path families) and
the concrete next rules needing them exist, satisfying the later-additions
rule. Catalog v1 MUST include these definitions under these exact column
names, so the registered rules run unmodified (grandfathered naming; the
`feat_fp_` convention applies to future additions):

feat_pairLosingStreakPrior, feat_pairDrawdownPctPrior,
feat_pairMedianMaePctPrior, feat_spreadReturnAutocorr20,
feat_spreadVarianceRatio5, feat_spreadHalfLifeBars20,
feat_atrRatio5Over20, feat_pairSpreadVolatilityRatio5Over20,
feat_pairFiresInLast20Bars, feat_pairInterFireIntervalCvPrior

Their definitions, windows (20-bar / 5-over-20 variants included), null
policies, and parameters are those in the approved idea JSON, expanded to
the same exactness as the template above before release v1 is published.
Each such definition gets its own mutation and boundary tests like every
other catalog entry.

### Fully specified example definition (template)

**ID:** `feat_fp_spread_log_return_b12_r1`; family `spread`; revision 1; window parameter `bars: 12`; capability `pair_bars_v1`; units dimensionless log return; direction convention `captured_base_over_quote`; no dependencies beyond its pinned implementation/helper files.

For an entry at index s, require the 13 closes at indices `s-13` through `s-1`, all finite and positive. Return `ln(close[s-1]) - ln(close[s-13])`. The price at s is never read. `minimumObservations = 13`; observation count is the number of valid positive closes available at those exact indices, capped at 13, even while insufficient. Any absent/invalid close in that window yields null; do not bridge a missing close. The window is 12 observed-bar intervals, independent of calendar gaps. Evaluate left log then right log and subtract; do not replace it with `ln(a/b)` under the same revision. Normalize a computed -0 to +0 for serialization.

Fixtures: s=12 yields null with at most 12 observations; s=13 with closes `2^0` through `2^12` gives `ln(4096)-ln(1)` with n=13; s=13 with 13 equal positive closes gives 0 with n=13. Mutating close[13] or any later input leaves the value unchanged; mutating close[12] changes it. A nonpositive interior close yields null even though only endpoints enter the arithmetic, because full-window quality is part of revision 1's contract. Expected arithmetic is asserted independently of the production function; reproducibility tests additionally lock the serialized bytes.

### Later catalog additions

A proposal must name the concrete next rule needing it, why existing columns/arithmetic cannot express it, its exact inputs/cutoff/formula/units/support/null policy, its cost, and a distinguishing expected-value plus mutation test. If the snapshot lacks a required capability, reject it for this folder; no loader fallback or old-folder repair. A new definition gets a new ID; a formula/helper meaning change gets a new revision and release. Do not change existing production rule keys to point at a new meaning. Adding a column must not touch ledger schemas, exporter features, or per-column harness/UI plumbing.

## 6. TEST STRATEGY

### Required suites and integration

| Suite | Required evidence | First package / regression integrations |
|---|---|---|
| Causality mutation | For every new definition, compute outputs, mutate signal bar and all future bars plus future/same-bar trade contents, regenerate, compare earlier values/counts. Keep the fixed ledger/snapshot mapping in the computation fixture; artifact hashes naturally differ and are not the equality target of this test. Include positive-control mutations to relevant past inputs. Add future fires and reverse same-bar entry order. | WP3 onward; `tests/pair-feature-causality.spec.ts`; existing `tests/trade-ledger-exporter.spec.ts` retains legacy inclusive-feature expectations. |
| Boundary | No history, exact first-valid index, one-short support, zero variance/range/loss denominator, nonpositive log input, ties in exit times, partial records, same-bar exits under signal_close/next_open/next_close and long/short/both, missing time mappings, trade-window truncation, irregular timestamps. | WP2 mapping cases; WP3 two-feature cases; WP5 all families. |
| Reproducibility | Two clean outputs, request-order permutation, cancellation/restart, and duplicate simultaneous request yield identical canonical manifests and compressed columns on pinned runtime; changed runtime/helper digest refuses generation; old verified packs stay readable. Compare every referenced byte, excluding explicit operational diagnostics. | WP3 onward; `tests/pair-feature-reproducibility.spec.ts`. |
| Round trip / capture fidelity | Compare frozen bars/trades/entry maps to exporter inputs, including normalized time shapes; decode columns to original finite values/nulls/counts. Show snapshot writes do not change engine calls, results, or ledger/rank bytes. | WP2 `tests/pair-feature-snapshot.spec.ts`, existing `tests/trade-ledger-exporter.spec.ts`, `tests/batch-backtest-runner.spec.ts`, `tests/batch-backtest-server-plugin.spec.ts`; WP3 binary cases. |
| Mismatch rejection | Wrong raw ledger hash, swapped pair, reordered/missing/duplicate ordinal, invalid signal-bar mapping, source mutation, corrupt gzip, length/hash mismatch, unknown feature/release, incomplete publication, and escaped paths fail before scoring. No zero fill or automatic replacement of a conflicting published artifact. | WP3 generator; WP4 `tests/pair-feature-access.spec.ts` and `tests/pair-pick-checker.spec.ts`. |
| Harness parity | Identical eligible/candidate events, picks, ties, references, direction/horizon returns, frequencies, and deterministic reports for legacy rules; new feature fixtures match independent scalar fixtures. Read-only outcomes remain hidden from scoring. | Every WP: `tests/pair-pick-checker.spec.ts`, `tests/pair-selection-registry.spec.ts`, `tests/selection-checker-parity.spec.ts`, `tests/selection-sharpe-parity.spec.ts`, `tests/trade-ledger-parity-golden.spec.ts`, `tests/trade-ledger-checker.spec.ts`. |
| Menu/job lifecycle | Discovery agrees with CLI compatibility; preparation observes cancellation; ownership and one base archive load survive; no array fields added to stream payloads; prior successful packs survive a failed job. | WP1/4/5: `tests/selection-rules-server.spec.ts`; retain `tests/selection-rules-preferences.spec.ts`. |
| Five-batch reuse | One fixture capture, five requirement sets, stable ledger and reused column hashes, no execution/data loading, bounded active-column lifetime, usable receipts. | WP5/6: `tests/pair-feature-pipeline.spec.ts`. |

Use the existing assert/spec style in the touched test files. New `tests/**/*.spec.ts` files are automatically discovered by `scripts/run-tests.ts`; do not create a second test runner. Do not regenerate the expected reports in `tests/fixtures/trade-ledger-parity/` to hide a semantic regression. DOM source and contracts are untouched; `tests/feature-dom-contracts.spec.ts` still runs in the full suite.

### Full-suite gate, not a focused-test substitute

`package.json` defines `npm run verify` as production typecheck, test typecheck, and the unfiltered test runner. `scripts/run-tests.ts` explicitly excludes `tests/e2e.spec.ts`, and `package.json` exposes that test separately. Therefore **each WP ends with**:

1. Its focused new/updated specs, using `npm run test -- <spec-path>` during development.
2. `npm run verify` without filters, with no failures or silently ignored SKIP results.
3. `npm run test:e2e` separately; provide its required browser/runtime prerequisites instead of claiming the excluded spec passed implicitly.
4. `npm run build:check` for the server import/bundle boundary; especially WP2 and any package adding code reachable from `lib/batch-backtest/batch-backtest-vite-plugin.ts` or the selection server.

Record commands, passed/failed/skipped counts, and any prerequisites preventing execution in the builder handoff. A pre-existing failure is evidence to report and resolve within authorized scope, not a reason to lower the package's green gate or rewrite unrelated code silently. The planning task does not run these suites; this section assigns them to implementation packages.

For WP2's human capture, use the existing Batch server heap guidance from `AGENTS.md` (at least `NODE_OPTIONS=--max-old-space-size=16384`). For WP5's measured offline enrichment/check, use a 24 GB heap (`NODE_OPTIONS=--max-old-space-size=24576`). Do not change loader/cache caps or the temporary artifact memory/TTL policy. Report peak RSS as well as V8 heap because Buffer/typed-array memory may be external. Scale verification uses the newly captured real folder; never commit its multi-GB contents.

## 7. WHAT NOT TO BUILD

- No database, feature service, daemon, scheduler, worker pool, distributed job system, background refresh, or new menu/UI controls.
- No strategy execution, AS-IF replay, backtest rerun, or outcome recalculation in the generator. The single WP2 human capture is the only planned migration batch.
- No retroactive snapshots, repaired legacy ledgers, live-loader enrichment, automatic leg reconstruction, or claimed fix for old `feat_legVolatilityRatio20` nulls.
- No replacement of old inclusive-bar fields with strict-before meanings; no silent production-rule aliasing, key retargeting, new scoring rules, or selection-harness semantic rewrite.
- No portfolio equity/allocation, robustness miner, prediction, timing-edge, or OPEN_SCORE analysis additions.
- No general feature DSL, generic serialization layer, pluggable storage/compression formats, dependency-graph engine, arbitrary plugin discovery, or automatic window/lag search.
- No all-pairs source retention, full-ledger Buffer/string, millions of wide feature objects, all-library checker loading, or unbounded captured write promises.
- No global exact-match feature-library gate, implicit latest release, silent zero filling, candidate removal to hide missingness, or trusting artifact filenames without hash/binding checks.
- No snapshot dependence on temporary Batch artifacts, cache contents, external links, or network availability.
- No external dependencies. A later dependency proposal is separate work and must name the package, concrete capability missing from this design, and why Node builtins cannot reasonably provide it.
- No speculative infrastructure for a hypothetical second consumer. The concrete shared uses are CLI and menu preparation, snapshot and pack artifact I/O, and tally/catalog compatibility; keep all other implementation local to its existing owner.
