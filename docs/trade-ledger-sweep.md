# Ledger Rule Sweep

The sweep produces research candidates; it does not replace the real engine.
For the follow-up certification workflow (selecting latest-sweep
`EDGE-CANDIDATE` rules, applying them to Batch entries, and comparing replay
predictions with engine-actual trades), see [`docs/trade-gate.md`](trade-gate.md).

Status: approved implementation plan. This document is the implementation
contract for a new server-owned trade-ledger rule sweep and its top-level
Ledger Sweep tab UI.
It is intentionally self-contained. The builder should also follow
`AGENTS.md`, especially its Server-Side Batch Backtest, Server-Owned Finder
Symbol Universe, audit F1-F7/F9, and Documentation Standard sections.

Related existing documentation:

- [Trade Ledger](trade-ledger.md)
- [Server-Side Batch Backtest](batch-backtest-server-side.md)
- [Server-Owned Finder Jobs](finder-server-side.md)

## Decisions the human must make

None. All v1 product, safety, execution, storage, and research-display
decisions are settled below.

## Purpose and success criteria

The existing offline workflow in
`archive/mining-ledger/test-all-rules.bat` runs every TypeScript rule in
`archive/mining-ledger/rules/` against one saved ledger folder by launching
`scripts/trade-ledger-checker.ts` once per rule. Each checker process streams
the JSONL input but retains every parsed row for replay, so every rule repeats
the ledger parse, rank parse, rank join, pair preparation, rule replay, and 200
seeded random controls. Large ledgers therefore take hours.

The feature succeeds when it:

1. Lists saved ledger folders safely in the top-level Ledger Sweep tab and explains
   why an invalid folder cannot run.
2. Runs every currently discovered rule as one server-owned, reattachable job.
3. Preserves the checker's existing replay, anti-leakage, IS/holdout, seeded
   control, report, and EDGE-bar semantics exactly.
4. Loads and prepares the ledger once when a conservative memory preflight
   permits it, with an isolated-per-rule fallback and an absolute refusal
   boundary.
5. Keeps multi-GB parsed rows and executable rule code out of the Vite process
   by using isolated Node child processes with the repository's TypeScript
   loader.
6. Never sends ledger rows or full checker reports to the browser. The wire
   carries only bounded scalar results and diagnostics.
7. Makes load, parse, join, replay, controls, persistence, memory, CPU, event
   loop, and throughput costs visible in the UI and durable artifacts.
8. Prevents a sweep from overlapping any Batch or Finder server workload,
   without otherwise changing the existing Batch-vs-Finder concurrency model.

## Corrections from the approved draft

The approved design is retained, with these repository-verified corrections:

1. **The checker already streams JSONL.**
   `scripts/trade-ledger-checker.ts` uses `createReadStream` plus
   `node:readline`; it does not hold a whole-file `Buffer`. The repeated cost is
   parsing and retaining all rows once per rule process, not whole-file buffer
   loading.
2. **The legacy batch file writes one consolidated report.**
   `archive/mining-ledger/test-all-rules.bat` appends every rule block to one
   timestamped report under `archive/mining-ledger/reports/`. The new artifact
   contract preserves a consolidated `full-report.txt` and additionally writes
   one report per rule.
3. **The certified row hint is `summary.totals.signals`.**
   `TradeLedgerSummary` has no `rows` property. The catalog exposes that value
   to the browser as `rows` only after reading
   `summary.json.totals.signals`.
4. **Route authorization is centralized.**
   New routes use `registerLocalJsonRoute` from `lib/vite-http-utils.ts`; that
   existing helper calls `isAllowedLocalRequest` from
   `lib/local-route-authorization.ts`. Do not duplicate an inline auth check.
5. **The coordinator reports an array.**
   The approved conflict matrix continues to allow a Batch workload and a
   Finder workload to coexist. The coordinator and API therefore expose
   `activeWorkloads[]`, not a singular `activeWorkload`.
6. **The existing reusable run-id validator is 64 characters.**
   `isValidRunId` in
   `lib/batch-backtest/sp500-top-mean-artifact-store.ts` accepts only
   `[A-Za-z0-9_-]{1,64}`. The sweep uses that real guard rather than inventing
   the draft's wider limit.
7. **No shared cross-plugin coordinator exists today.**
   `lib/server-research-job-coordinator.ts` below is a proposed leaf module;
   the existing Batch and Finder module-local owner locks remain in place.
8. **The schema is currently exporter-owned.**
   Trade-ledger constants and types currently live in
   `lib/batch-backtest/trade-ledger-exporter.ts`. Phase 1 deliberately extracts
   them into a proposed leaf so the replay code does not import the writer and
   its heavier dependencies.

## Decision record

- **DECIDED — UI placement:** Add a full-width Ledger Sweep tab to the
  top-level strategy-panel menu, because the sweep is an independent,
  server-owned research workflow and its own menu entry makes it discoverable
  without coupling initialization to the normal Batch Backtest feature.
- **DECIDED — process boundary:** Vite owns routing, owner state, reattach, and
  child lifecycle, while replay runs in isolated Node child processes with the
  resolved TypeScript loader,
  because multi-GB row retention or a bad rule must not freeze or crash the
  Vite control plane.
- **DECIDED — memory modes:** Use an automatic load-once versus
  isolated-per-rule preflight with a hard refusal boundary and no v1 override,
  because a UI override would turn a measured guard into an accidental OOM
  button.
- **DECIDED — rule trust:** Rules are trusted local repository code, not
  uploads and not sandboxed; canonical-path restrictions, local route auth,
  child isolation, and the existing outcome-field Proxy bound the intended
  risks without pretending arbitrary TypeScript is safe.
- **DECIDED — coordinator matrix:** Ledger Sweep conflicts with Ledger Sweep,
  Batch, and Finder; Batch and Finder keep their current relationship, because
  the requested change must prevent sweep contention without silently
  serializing unrelated established workflows.
- **DECIDED — holdout display:** Show the existing holdout-derived verdicts but
  place a permanent warning above the table, because sweeping every rule
  consumes holdout trust and an EDGE-CANDIDATE remains surface-specific audit
  evidence rather than certification.
- **DECIDED — rule order and parallelism:** Snapshot rules in ascending filename
  order and run one rule at a time, because deterministic output, bounded
  memory, and stable artifact ordering matter more than intra-sweep
  parallelism.
- **DECIDED — incomplete ledgers:** The UI lists but refuses incomplete,
  unsupported, or replay-ineligible folders; `--allow-incomplete` remains a
  CLI-only forensic escape hatch, because the UI must not normalize unsafe
  evidence.
- **DECIDED — artifact lifetime:** Sweep artifacts are permanent user research
  under the selected ledger folder and have no TTL or automatic orphan sweep,
  because even a cancelled or crashed run is useful audit evidence and must
  never be deleted by PID/age heuristics.

## Non-goals

- Do not change the strategy or backtest engine.
- Do not change ledger v2 row semantics, replay eligibility, or causal-feature
  policy.
- Do not change the 60/40 global-calendar split, 200 controls, seed 42,
  keep-rate calibration, or EDGE thresholds.
- Do not add a browser-side replay path.
- Do not add a true streaming/columnar replay engine in v1. Every individual
  checker evaluation still needs one complete parsed ledger.
- Do not run rules concurrently.
- Do not accept rule source, a rule path, or an arbitrary ledger path from the
  browser.
- Do not automatically apply an EDGE-CANDIDATE to a strategy.
- Do not remove `archive/mining-ledger/test-all-rules.bat`; it remains a
  fallback and parity oracle.
- Do not add cleanup, retention, or deletion controls for sweep artifacts.
- Do not support a static-only deployment. Match Batch and Finder by
  registering in Vite dev and preview servers.

## Existing contracts that must remain intact

The implementation touches server import boundaries, Batch/Finder ownership,
the Batch lazy tab, persisted browser state, and checker semantics. Preserve
these existing contracts:

| Existing contract | Existing source of truth |
| --- | --- |
| Ledger v2 schema, provenance, completeness, and replay eligibility | `lib/batch-backtest/trade-ledger-exporter.ts` and `docs/trade-ledger.md` |
| Streaming JSONL load, rank join, replay state machine, control seed/calibration, stable report | `scripts/trade-ledger-checker.ts` |
| EDGE classification and sort order | `archive/mining-ledger/summarize-report.ts` |
| Batch owner lock, `runId`, `pendingStopRunId`, disconnect-safe stream, retained terminal status | `lib/batch-backtest/batch-backtest-vite-plugin.ts` |
| Finder owner lock, scoped Stop, reattach, terminal state, local auth | `lib/finder/server/finder-vite-plugin.ts` |
| Local authorization and route error handling | `registerLocalJsonRoute` in `lib/vite-http-utils.ts`, backed by `lib/local-route-authorization.ts` |
| Disconnect-safe NDJSON response | `createDisconnectSafeStream` in `lib/vite-http-utils.ts` |
| Strict browser NDJSON consumption | `consumeNdjsonStream` in `lib/ndjson-stream.ts` |
| Persisted JSON envelopes | `readPersistedJson` and `writePersistedJson` in `lib/persisted-json.ts` |
| Ledger Sweep lazy initialization | `registerLazyFeature("ledger-sweep", ...)` in `lib/app-bootstrap.ts`, mapped from the `ledgersweep` tab in `lib/lazy-feature-init.ts` |
| Runtime Ledger Sweep markup | `html-partials/tab-ledger-sweep.html`, loaded by `lib/strategy-panel-tab-markup.ts` |
| Feature-local structural IDs | `lib/batch-backtest/trade-ledger-sweep-dom.ts` and `tests/feature-dom-contracts.spec.ts` |
| Vite plugin registration | `vite.config.ts` |
| Safe child TypeScript-loader resolution pattern | `createRequire(import.meta.url).resolve("tsx")` in the sweep job; the installed `esno` launcher delegates to a secondary process that does not preserve the requested V8 heap flag. |

The new Vite plugin and every module imported transitively by it must remain
Node/leaf-safe. They must not import `lib/batch-backtest/batch-backtest-service.ts`,
`lib/finder-manager.ts`, `lib/data-manager.ts`, `lib/settings-manager.ts`,
`lib/ui-manager.ts`, `lib/constants.ts`, `lib/chart-manager.ts`, or anything
else that reaches `lightweight-charts`.

Audit findings F2, F3, F7, and F9 are not reasons to rewrite existing Batch or
Finder internals. Coordinator edits must be surgical: preserve awaited Batch
artifact backpressure, generation-safe artifact detachment, PID-safe temporary
artifact cleanup, and Finder's unique failed-symbol accounting.

## Proposed file map

Every path in this table is new and **proposed** unless explicitly marked
existing.

| Path | Status | Responsibility |
| --- | --- | --- |
| `lib/batch-backtest/trade-ledger-schema.ts` | Proposed | Data-only ledger constants and types extracted from the exporter. |
| `lib/batch-backtest/trade-ledger-replay-core.ts` | Proposed | Pure replay preparation, guarded rule rows, per-pair replay, stats, controls, structured evaluation, and stable report formatting. No filesystem or browser imports. |
| `lib/batch-backtest/trade-ledger-replay-loader.ts` | Proposed | Node streaming JSONL reader, strict folder validation, rank load/join, and load diagnostics. |
| `lib/batch-backtest/trade-ledger-verdict.ts` | Proposed | EDGE constants, structured classifier, weak-note logic, verdict counts, and canonical sort. |
| `lib/batch-backtest/trade-ledger-sweep-catalog.ts` | Proposed | Safe folder/rule discovery and opaque catalog IDs. |
| `lib/batch-backtest/trade-ledger-sweep-preflight.ts` | Proposed | v1 memory estimator, mode decision, and refusal reason. |
| `lib/batch-backtest/trade-ledger-sweep-diagnostics.ts` | Proposed | Diagnostic types, clocks, memory/CPU/event-loop samplers, aggregation, and schema v1. |
| `lib/batch-backtest/trade-ledger-sweep-diagnostics-summary.ts` | Proposed | Bounded summary projection from the final in-memory diagnostics aggregate. |
| `lib/batch-backtest/trade-ledger-sweep-artifacts.ts` | Proposed | Safe output directory construction, incremental appenders, atomic final files, and terminal manifest update. |
| `lib/batch-backtest/trade-ledger-sweep-job.ts` | Proposed | Vite-side child-process orchestration, worker protocol parsing, Stop, retained scalar state, and mode execution. |
| `lib/batch-backtest/trade-ledger-sweep-stream-types.ts` | Proposed | Browser/server wire types and scalar guards. |
| `lib/batch-backtest/trade-ledger-sweep-vite-plugin.ts` | Proposed | Dev/preview route registration, owner lock, `pendingStopRunId`, status, and coordinator integration. |
| `lib/batch-backtest/trade-ledger-sweep-dom.ts` | Proposed | `TRADE_LEDGER_SWEEP_REQUIRED_IDS` plus `createTradeLedgerSweepDom()`. |
| `lib/batch-backtest/trade-ledger-sweep-service.ts` | Proposed | Browser catalog, run/stop, stream consumption, status reattach, rendering, and copy actions. |
| `html-partials/tab-ledger-sweep.html` | Proposed | Top-level Ledger Sweep tab markup; preserves the existing sweep section and IDs. |
| `styles/trade-ledger-sweep.css` | Proposed | Ledger Sweep layout plus exact local copies of the Batch presentation classes used by the moved markup. |
| `lib/server-research-job-coordinator.ts` | Proposed | Leaf singleton workload tokens and conflict matrix. |
| `scripts/trade-ledger-sweep-worker.ts` | Proposed | Node child entry loaded through the resolved `tsx` loader for load-once or one-rule execution. |
| `tests/trade-ledger-sweep-engine.spec.ts` | Proposed | Mode parity, replay parity, diagnostics, artifacts, and worker behavior. |
| `tests/trade-ledger-parity-golden.spec.ts` | Proposed | Independent committed report fixture and SHA-locked parity in both engine preparation modes. |
| `tests/fixtures/trade-ledger-parity/*` | Proposed | Frozen v2 ledger, rule, metadata, and expected checker report. |
| `tests/trade-ledger-sweep-server-plugin.spec.ts` | Proposed | Route auth, owner, runId, Stop race, disconnect, status, scalar wire, and path safety. |
| `tests/server-research-job-coordinator.spec.ts` | Proposed | Conflict matrix and generation-safe token release. |
| `tests/trade-ledger-sweep-service.spec.ts` | Proposed | Browser ownership, stream/status reconciliation, rendering, and persistence. |
| `lib/batch-backtest/trade-ledger-exporter.ts` | Existing, modify | Import/re-export the extracted schema while leaving writer behavior unchanged. |
| `scripts/trade-ledger-checker.ts` | Existing, modify | Thin CLI adapter plus compatibility re-exports for current tests and benchmark imports. |
| `archive/mining-ledger/summarize-report.ts` | Existing, modify | Keep legacy report parsing; delegate classification and sorting to the verdict leaf. |
| `lib/batch-backtest/batch-backtest-vite-plugin.ts` | Existing, modify | Acquire/release Batch coordinator tokens without changing local ownership. |
| `lib/batch-backtest/sp500-top-mean-vite-routes.ts` | Existing, modify | Acquire/release a Batch coordinator token for TOP_MEAN. |
| `lib/finder/server/finder-vite-plugin.ts` | Existing, modify | Acquire/release Finder coordinator tokens for all long-running Finder jobs. |
| `lib/batch-backtest/batch-backtest-service.ts` | Existing, modify | Keep normal Batch initialization independent from the sweep service. |
| `html-partials/tab-batch-backtest.html` | Existing, modify | Keep only normal Batch markup; the sweep section is removed. |
| `styles/batch-backtest.css` | Existing, modify | Remove the moved sweep-only declarations; normal Batch styles remain unchanged. |
| `lib/app-bootstrap.ts` | Existing, modify | Register the separate Ledger Sweep lazy feature. |
| `lib/lazy-feature-init.ts` | Existing, modify | Map the top-level `ledgersweep` tab to its lazy feature. |
| `lib/strategy-panel-tab-markup.ts` | Existing, modify | Load the new tab partial and its matching runtime root. |
| `html-partials/strategy-panel-shell.html` | Existing, modify | Add the top-level Ledger Sweep menu button. |
| `tests/feature-dom-contracts.spec.ts` | Existing, modify | Register the new feature-local ID group. |
| `vite.config.ts` | Existing, modify | Register `tradeLedgerSweepVitePlugin()` for dev and preview. |
| `docs/trade-ledger.md` | Existing, modify in Phase 5 | Add the UI sweep entry point and link back to this contract. |
| `scripts/bench-trade-ledger-scale.ts` | Existing, modify in Phase 5 | Emit the same diagnostic schema and accept scale inputs used by validation. |

The Ledger Sweep tab is a separate lazy-loaded source of truth:
`html-partials/tab-ledger-sweep.html`. Keep the normal Batch Backtest markup in
`html-partials/tab-batch-backtest.html`; the two features must not initialize
one another.

## Architecture

```text
Ledger Sweep tab / trade-ledger-sweep-service
        |  catalog JSON; run NDJSON; scoped stop/status
        v
trade-ledger-sweep-vite-plugin (small Vite control plane)
        |  local owner + pendingStopRunId + coordinator token
        |  retained scalar snapshot only
        v
trade-ledger-sweep-job
        |  process.execPath + --import resolved tsx loader; shell:false
        v
trade-ledger-sweep-worker child
        |  imports trusted local rule modules
        |  loads/replays ledger; writes durable reports
        v
<ledgerFolder>/sweeps/<stamp>_<runId>/
```

The Vite process owns the job even though computation runs in a child. Closing
or reloading the tab drops the response stream but does not stop the child.
The plugin continues updating its retained scalar snapshot; the browser
reattaches through scoped `/status` polling.

### Child launch contract

Use the existing repository pattern from `scripts/run-tests.ts`:

1. Resolve the runtime with
   `createRequire(import.meta.url).resolve("tsx")`; invoke Node with the
   resolved loader using `--import` so the child keeps the requested V8 heap
   limit. The repository's installed `esno` launcher delegates to another
   process and was measured to cap the effective heap at about 4.35 GiB even
   when passed `--max-old-space-size=12288`.
2. Spawn `process.execPath` with
   `--max-old-space-size=12288`, `--import` and the resolved `tsx` loader, the
   absolute proposed worker path, and explicit arguments.
3. Set `shell: false`; never construct a command string.
4. Set stdio to `ignore`, `pipe`, `pipe`. Stdout is worker NDJSON only. Retain
   at most the final 64 KiB of stderr for a fatal diagnostic.
5. Pass only server-resolved absolute paths to the child. No path from an HTTP
   body reaches `spawn` or the filesystem directly.
6. Keep at most one child alive. Load-once uses one child for all rules;
   isolated-per-rule starts the next child only after the prior child exits.
7. A normal exit without a terminal worker event is fatal. A malformed worker
   line is fatal. Report content is written to disk and never printed on the
   worker protocol.

The proposed worker CLI is internal but fixed for tests:

```text
trade-ledger-sweep-worker.ts
  --mode load_once|isolated_rule
  --ledger-folder <server-resolved-absolute-folder>
  --rules-root <server-resolved-absolute-rules-root>
  --output-dir <server-resolved-absolute-output-folder>
  --run-id <validated-run-id>
  [--rule-id <catalog-rule-id>]
```

`--rule-id` is required only for `isolated_rule`. The worker verifies all
canonical path boundaries again; controller validation is not sufficient.

### Large-ledger control parallelism

The load-once worker uses a bounded `worker_threads` pool over compact shared
numeric columns for the 200 seeded controls. Small datasets use four workers;
datasets with at least 250,000 replay candidates use up to 20 workers by
default, reserving one logical processor for the server and UI. Set
`TRADE_LEDGER_SWEEP_CONTROL_WORKERS` before starting Vite to tune the pool;
the value is capped at `availableParallelism() - 1`. The diagnostic summary
reports the selected worker count as `controlWorkers`. A worker that fails a
control chunk surfaces the worker-side error stack, and the pool re-posts that
chunk once to a different worker before failing the rule: control replay is
deterministic (seeded PRNG over immutable shared columns), so the retry is
result-identical and a genuine bug still fails the rule. The common
`maxOpenTrades=1`, no-cooldown path also precomputes the next row after each
trade’s exit, so blocked rows are skipped in constant time; non-chronological
pair data and other replay settings use the exact general path.

For multi-GB ledgers, start the server with a larger server heap and raise
the sweep child heap (the child spawns its own `--max-old-space-size`; the
server's `NODE_OPTIONS` alone does not raise it):

```powershell
$env:NODE_OPTIONS="--max-old-space-size=16384"; $env:TRADE_LEDGER_SWEEP_CHILD_HEAP_MB="24576"; npm run dev
```

Or set `TRADE_LEDGER_SWEEP_CHILD_HEAP_MB` in `.env` — `run_playground.bat`
exports it into the Vite process environment.

## Shared workload coordinator

The proposed `lib/server-research-job-coordinator.ts` is a Node/TypeScript leaf
with no Vite, browser, Batch, or Finder imports. Existing local owner locks
remain the cancellation authority inside their plugins.

### Coordinator types

```text
ResearchWorkloadKind = "batch" | "finder" | "ledger_sweep"

ResearchWorkloadToken = {
  tokenId, kind, ownerId, startedAt
}

ResearchWorkloadSnapshot = {
  kind, ownerId, startedAt
}
```

`ownerId` is the browser `runId` where the existing route has one. Existing
unscoped Batch analyses use a server-generated owner id such as
`batch-analysis-<generation>`; the coordinator does not broaden their Stop
API.

Required synchronous API:

```text
tryAcquire(kind, ownerId): ResearchWorkloadToken | null
releaseIfOwner(token): void
getActiveWorkloads(): ResearchWorkloadSnapshot[]
resetForTests(): void
```

### Conflict matrix

| Requesting kind | Existing Batch | Existing Finder | Existing Ledger Sweep |
| --- | ---: | ---: | ---: |
| Batch | allowed by coordinator; existing Batch lock still applies | allowed | rejected |
| Finder | allowed | allowed by coordinator; existing Finder lock still applies | rejected |
| Ledger Sweep | rejected | rejected | rejected |

All workload starts must perform cheap request validation first, then acquire
their existing local owner and coordinator token synchronously before their
first `await`. Release only in `finally` and only through the exact token.
Stop requests trigger the subsystem's existing cancellation path; they must
not release the coordinator token early. The job teardown releases it after
the child/runner has actually stopped.

Integrate Batch tokens into:

- normal Batch Run in `lib/batch-backtest/batch-backtest-vite-plugin.ts`;
- OPEN_SCORE USD in the same plugin;
- TOP_MEAN in `lib/batch-backtest/sp500-top-mean-vite-routes.ts`.

Integrate Finder tokens into all three current long-running starts in
`lib/finder/server/finder-vite-plugin.ts`:

- Symbol Universe;
- Asset Opportunity;
- Asset Opportunity Batch.

Do not change cache invalidation routes, status routes, Stop routes, or the
F9 failed-symbol calculation.

## Folder and rule catalog

The catalog root is always
`<server.config.root>/archive/mining-ledger`. Do not use the persisted Batch
export-folder text field as an arbitrary catalog root in v1.

Folder discovery rules:

1. Inspect immediate child directories only; never recurse.
2. Skip symbolic links and junctions. Resolve `realpath` and require it to be a
   strict child of the canonical catalog root.
3. Treat the immediate child basename as `folderId`. It is opaque to the
   browser and must contain no separator or traversal segment.
4. A folder is discoverable when `ledger.jsonl` exists. Missing or malformed
   `provenance.json`/`summary.json` remains visible as a refused folder.
5. Read row and pair hints only from certified summary scalars:
   `totals.signals`, `totals.pairs`, `submittedPairs`, and `loadedPairs`.
   Do not scan JSONL merely to populate the menu.
6. Stat `ledger.jsonl` and optional `signal-ranks.jsonl` for byte hints.
7. A runnable folder requires ledger v2, a supported feature version,
   `summary.ledgerComplete === true`, `summary.failedWrites === 0`, and
   `provenance.replay.replayEligible === true`.
8. Sort folders by `provenance.startedAt` descending, falling back to directory
   modification time, then basename.

Rule discovery rules:

1. Enumerate immediate regular `*.ts` files under
   `<server.config.root>/archive/mining-ledger/rules`; never recurse.
2. Skip symbolic links/junctions and require canonical containment.
3. Sort by filename using deterministic ordinal comparison.
4. `ruleId` is the filename without `.ts`; reject duplicate IDs.
5. Record `ruleName` (basename with `.ts`), byte size, modification time, and
   SHA-256 of the entry file.
6. At Start, repeat discovery and freeze the ordered list and hashes in the
   run manifest. A catalog shown earlier is only a hint.
7. A sweep with zero valid rules is a 400 refusal.

## Memory preflight constants

> **V1 CONSTANTS — recalibrated after the F3 audit; do not tune per run.**
>
> Child V8 heap limit: **12,288 MiB**.
>
> `estimatedHeapBytes = 512 MiB + rows * 2,048 bytes`
>
> `estimatedRssBytes = 768 MiB + rows * 2,048 bytes`
>
> `rows = summary.json.totals.signals`
>
> Choose **load_once** only when estimated heap is at most **50%** of the
> child heap limit **and** estimated RSS is at most **50%** of
> `os.freemem()` measured after coordinator acquisition.
>
> **Refuse with HTTP 507** when estimated heap exceeds **70%** of the child
> heap limit **or** estimated RSS exceeds **75%** of `os.freemem()`.
>
> All values between the load-once and refusal boundaries use
> **isolated_per_rule**. There is no UI, body, or query-string override.
>
> **Operator child-heap override:** set `TRADE_LEDGER_SWEEP_CHILD_HEAP_MB`
> (MiB, clamped to 2048..262144, default 12288) before starting Vite — the
> launcher exports it from `.env`. The override is the operator's judgment
> that the machine can hold the ledger: the preflight boundaries, the spawned
> child's `--max-old-space-size`, and the 85% runtime guard all scale from
> the same resolved value. The RSS boundaries still measure real
> `os.freemem()` and refuse independently.

> Runtime defense-in-depth: for a load-once worker only, sample `heapUsed` at
> every phase boundary and in the existing one-second sampler. Abort with
> `runtime memory guard tripped - preflight underestimated; run refused` when
> `heapUsed >= 85%` of the child heap limit. Record the observed value,
> threshold, phase, and message in diagnostics before the fatal terminal event.

The heap coefficient was recalibrated from the measured F3 two-rule peak:
5,412,528 rows and 9.01 GiB observed heap require a 2,048-byte rounded
coefficient with the existing 512 MiB base, estimating 10.82 GiB (1.20x the
observed peak) and therefore refusing at the 70% boundary. The RSS coefficient
remains the validated `2,048 bytes/row`. The formulas are a mode selector, not
a guarantee. `isolated_per_rule` guarantees process reclamation between rules
but does not lower the peak memory needed for one complete parsed ledger. If
one ledger cannot fit, the only honest v1 behavior is refusal.

The estimator constants must be recalibrated whenever
`TRADE_LEDGER_FEATURE_VERSION` changes or the retained row representation
changes materially, or when a guarded production run observes a peak above
the estimate. Use the largest certified observed heap point, retain an explicit
margin, and update this document, the preflight tests, and the benchmark
together.

## Replay engine contract

### Phase 1 extraction

Move data-only constants/types from the existing exporter to proposed
`lib/batch-backtest/trade-ledger-schema.ts`. The exporter imports and
re-exports them so existing imports continue to compile. Do not move writer
logic, as-if computation, or feature construction.

Split the existing checker into:

- proposed `trade-ledger-replay-loader.ts`: streaming files, validation, rank
  map, rank join, and instrumentation;
- proposed `trade-ledger-replay-core.ts`: Proxy, preparation, replay, stats,
  controls, structured result, and report lines;
- existing `scripts/trade-ledger-checker.ts`: argument parsing, dynamic rule
  import, call into the two leaves, print report, and compatibility re-exports.

Before changing code, capture a small certified-ledger report and its
`summarize-report.ts` output as parity fixtures. Phase 1 is incomplete unless
the refactored CLI is byte-identical for the same folder/rule.

### Prepared dataset

After load and rank join, `prepareTradeLedgerReplay(...)` constructs one
immutable run-scoped object containing:

- all rows;
- total and right-censored counts;
- the global 60% time split;
- pair buckets sorted by `signalTime`, then `signalBarIndex`;
- reusable guarded rule-row proxies;
- replay parameters resolved from provenance;
- joined/unmatched rank counts.

Preparation may eliminate repeated pair grouping and sorting. It must not
cache a rule decision, an admitted trade list, a control result, or anything
derived from outcome access by a rule.

### Semantics that are byte-for-byte load-bearing

For every rule, retain the existing behavior from
`scripts/trade-ledger-checker.ts`:

- Apply the rule before admission/ordering state changes.
- Replay independently per pair; there is no global capital replay.
- Respect `maxOpenTrades`, cooldown, fill shift, inclusive busy-through-exit
  behavior, and right-censored blocking.
- Give the rule only the guarded identity/entry/`feat_*` proxy. Preserve all
  `get`, `has`, `ownKeys`, and `getOwnPropertyDescriptor` traps.
- Split IS/holdout at 60% of the folder's global signal-time range, never by
  row count or per pair.
- Run exactly `TRADE_LEDGER_CONTROL_RUNS = 200` controls with base seed
  `TRADE_LEDGER_CONTROL_SEED = 42` and the current per-rule, per-control
  two-pass keep-rate calibration.
- Do not pool, cache, or share control outcomes across rules.
- Keep existing mean/median/hit-rate, compounded informational values, and
  per-pair report lines.
- Preserve the stable `RULE ...` summary line and the consolidated report
  block markers used by `summarize-report.ts`.

The core returns a structured `LedgerSweepRuleResultInput` alongside
`reportLines`. The UI and new summary JSON classify the structure directly;
they never parse report text.

### Verdict contract

Proposed `trade-ledger-verdict.ts` owns the single canonical classifier:

| Condition | Verdict | Note |
| --- | --- | --- |
| Evaluation/import/report error | `ERROR` | Error message, bounded for the table; full text in the report. |
| IS mean delta >= +0.3 pp, kept >= 2%, holdout mean delta > 0 | `EDGE-CANDIDATE` | Add `weak: IS median negative` when IS median delta < 0. |
| IS mean delta >= +0.3 pp, kept >= 2%, holdout mean delta <= 0 | `HOLDOUT-NEG` | Add the same weak note when applicable. |
| IS mean delta >= +0.3 pp, kept < 2% | `TOO-RARE` | `passes delta bar but kept < 2%`. |
| Otherwise | `NO-EDGE` | No note unless the evaluator supplies an error. |

Canonical sort order remains:

1. `EDGE-CANDIDATE`
2. `HOLDOUT-NEG`
3. `TOO-RARE`
4. `NO-EDGE`
5. `ERROR`

Within a verdict, sort descending by holdout mean delta, then descending by IS
mean delta, then ascending by `ruleName` for a total deterministic order.

## Execution modes

### `load_once`

One child performs, in order:

1. Strict folder validation.
2. Rule import validation in the frozen catalog order.
3. One streamed ledger parse.
4. One streamed rank parse.
5. One rank join.
6. One prepared-dataset build.
7. Sequential per-rule replay, controls, classification, report write, result
   append, and diagnostic append.
8. Worker terminal event.

Catch rule import errors, forbidden-field access, predicate exceptions, and
report errors at the rule boundary. Emit/write an `ERROR` result and continue
to the next rule. A process exit, malformed worker protocol, ledger failure,
or inability to persist the authoritative result is job-fatal.

### `isolated_per_rule`

The Vite-side job controller starts one `isolated_rule` child for each frozen
rule in order. Each child validates, loads, joins, prepares, evaluates exactly
one rule, writes its per-rule artifacts, emits one result, and exits. The next
child starts only after exit and after the controller has appended the scalar
result to retained state.

A rule child that exits non-zero before emitting a valid result becomes an
`ERROR` row and the sweep continues, unless the failure is a shared-input or
artifact-integrity error. Shared-input errors are fatal because every later
rule would repeat the same invalid work.

### Rule loading and trust boundary

Inside the TypeScript-loader child, import the canonical `.ts` file with
`import(pathToFileURL(rulePath).href + "?v=" + sourceHash)`. Require a
default-exported function. Do not use Vite `ssrLoadModule`, do not evaluate
browser-supplied source, and do not import rule modules in the Vite process.

The rule may execute arbitrary trusted local code; child isolation is a
reliability boundary, not a security sandbox. The existing rule-row Proxy is
the research anti-leakage boundary. A rule that accesses `process`, imports a
module, loops forever, or exits the process is outside the safe authoring
contract. Stop must still be able to terminate its child from Vite.

### Stop and failure lifecycle

The sweep plugin keeps:

```text
runOwner
runOwnerGeneration
runOwnerRunId
runState
activeChild
abortController
pendingStopRunId
```

Required behavior:

1. The browser generates and persists `runId` before POSTing Run.
2. A Stop that arrives before Run ownership stores exactly one
   `pendingStopRunId`; the matching Run consumes it before starting a child.
3. A mismatched Stop returns `{ ok: false, stopped: false }` and changes
   nothing.
4. A matching Stop aborts controller work and terminates the active child. The
   plugin waits for child exit before releasing the coordinator token.
5. A disconnected HTTP response does not abort the job.
6. `done`, `cancelled`, and `fatal` states remain in `runState` until a later
   sweep replaces them. Artifact success is not a condition for exposing a
   terminal error in `/status`.
7. A new run never deletes or mutates a prior output directory.
8. Generation checks guard every child callback and finalizer so an old child
   cannot append results to a newer run.

## Top-level Ledger Sweep tab UI contract

### Markup and IDs

The existing sweep `<section>` lives in
`html-partials/tab-ledger-sweep.html` under the lazy root `#ledgersweepTab`.
Reuse the existing `batch-section`, button, progress, status, table/list, and
diagnostic classes without changing the section's IDs or content.

Proposed `TRADE_LEDGER_SWEEP_REQUIRED_IDS`:

| ID | Element/role |
| --- | --- |
| `tradeLedgerSweepSection` | Section root. |
| `tradeLedgerSweepRefreshBtn` | Refresh catalog button. |
| `tradeLedgerSweepFolderSelect` | Folder selector; disabled options remain visible with refusal labels. |
| `tradeLedgerSweepFolderMeta` | Selected folder size, rows, pairs, versions, status, and preflight hint. |
| `tradeLedgerSweepRunBtn` | Start all discovered rules. |
| `tradeLedgerSweepStopBtn` | Stop matching active sweep; hidden when idle. |
| `tradeLedgerSweepStatus` | Idle/running/terminal status. |
| `tradeLedgerSweepProgress` | Progress wrapper. |
| `tradeLedgerSweepProgressFill` | Percent fill. |
| `tradeLedgerSweepProgressText` | Phase, current rule, counts, elapsed, and control progress. |
| `tradeLedgerSweepHoldoutWarning` | Permanent research warning above results. |
| `tradeLedgerSweepOutput` | Relative artifact directory or terminal persistence error. |
| `tradeLedgerSweepCopySummaryBtn` | Copy canonical `summary.txt` text; disabled until available. |
| `tradeLedgerSweepCopyDiagnosticsBtn` | Copy compact `diagnostics-summary.json`; disabled until available. |
| `tradeLedgerSweepResults` | Final/current scalar verdict table. |
| `tradeLedgerSweepEmpty` | Empty-state text before results. |
| `tradeLedgerSweepDiagnosticsSummaryTab` | Default compact diagnostics Summary view. |
| `tradeLedgerSweepDiagnosticsRawTab` | Secondary Full JSON diagnostics view. |
| `tradeLedgerSweepDiagnosticsSummary` | Compact phase, throughput, memory, slow-rule, verdict/error, and optimization-target table. |
| `tradeLedgerSweepDiagnostics` | Secondary collapsible/preformatted full `diagnostics.json` view. |

The proposed `lib/batch-backtest/trade-ledger-sweep-dom.ts` owns these IDs and
`createTradeLedgerSweepDom()`. Add it as its own `tradeLedgerSweep` group in
existing `tests/feature-dom-contracts.spec.ts`; do not merge the IDs into
`BATCH_BACKTEST_REQUIRED_IDS`.

### Initialization and persistence

The `ledgersweep` menu button follows the existing lazy strategy-panel pattern:
`lib/strategy-panel-tab-markup.ts` loads the matching partial,
`lib/lazy-feature-init.ts` maps the tab to `ledger-sweep`, and
`lib/app-bootstrap.ts` registers a dynamic import of
`tradeLedgerSweepService.init()`. The normal `BatchBacktestService.init()` does
not initialize the sweep. Do not modify `index.ts`.

Persist only the active ownership record through existing
`readPersistedJson`/`writePersistedJson`:

```text
key: playground_trade_ledger_sweep_active_server_run
schema: trade_ledger_sweep.active_server_run
version: 1
data: { runId, startedAt }
```

Writing `data: null` clears the envelope, matching current Batch/Finder
practice. Do not persist results or diagnostics separately; terminal status
and durable artifacts are authoritative while the Vite process lives.

### Browser lifecycle

1. On init, fetch Catalog and render folders.
2. Restore the persisted active run, if any, and call scoped Status before
   enabling Run.
3. Generate `ledger-sweep-<base36-time>-<random>` for Start. It must pass the
   existing 64-character `isValidRunId` guard.
4. Persist ownership before `fetch`.
5. Consume Run with existing `consumeNdjsonStream`, using
   `requireTerminal: true` and terminal types `done`, `cancelled`, `fatal`.
6. Guard every stream and status mutation with
   `this.activeServerRunId === event.runId`.
7. Upsert results by `ruleId`; never append duplicates after stream/status
   recovery.
8. If the stream truncates or the tab reloads, poll scoped Status. Reuse
   existing `ReattachBackoffController` from
   `lib/batch-backtest/reattach-backoff.ts`; healthy running polls use a 2s
   cadence.
9. Adopt terminal `results` and `diagnostics` as authoritative, render, then
   clear the active-run envelope.
10. On `runMismatch` or missing server state after the retry policy, clear the
    stale envelope and retain a visible explanation.

The selector shows every folder. Runnable folders appear first; refused
folders are disabled and include a short reason. Selected-folder metadata
must show `ledgerBytes`, `rankBytes`, `rows`, `pairs`, ledger/feature versions,
completeness, replay eligibility, estimated memory, and current mode/refusal
hint.

The holdout warning text is fixed:

> This sweep exposes holdout results for every rule. Treat verdicts as
> surface-specific audit evidence only; EDGE-CANDIDATE still requires a new
> surface and one raw-engine certification run.

## HTTP contract

All proposed endpoints are under `/api/trade-ledger-sweep/*`, are registered
in both `configureServer` and `configurePreviewServer`, and use existing
`registerLocalJsonRoute`. Therefore each route structurally receives the
existing method check, `isAllowedLocalRequest` authorization, JSON body limit,
and `sendCaughtErrorJson` behavior.

Set proposed `TRADE_LEDGER_SWEEP_MAX_BODY_BYTES = 8 * 1024`. Reject unknown
body keys before ownership. Once a Run response has started NDJSON, failures
are stream terminal events; never attempt to send a JSON error body after
headers have streamed.

### `GET /api/trade-ledger-sweep/catalog`

Request: no body or query parameters.

Success, HTTP 200:

```text
{
  ok: true,
  catalogRoot: "archive/mining-ledger",
  generatedAt: number,
  folders: LedgerSweepFolderCatalogEntry[],
  rules: LedgerSweepRuleCatalogEntry[],
  activeWorkloads: ResearchWorkloadSnapshot[]
}
```

`LedgerSweepFolderCatalogEntry`:

```text
{
  folderId: string,
  name: string,
  startedAt: string | null,
  modifiedAt: number,
  ledgerBytes: number,
  rankBytes: number,
  rows: number | null,
  pairs: number | null,
  submittedPairs: number | null,
  loadedPairs: number | null,
  ledgerVersion: number | null,
  featureVersion: number | null,
  complete: boolean,
  replayEligible: boolean,
  runnable: boolean,
  refusalReason: string | null,
  preflight: LedgerSweepPreflightDecision | null
}
```

Catalog `preflight` is a current hint. Run repeats it after acquiring the
coordinator token.

`LedgerSweepRuleCatalogEntry`:

```text
{
  ruleId: string,
  ruleName: string,
  bytes: number,
  modifiedAt: number,
  sourceHash: string
}
```

### `POST /api/trade-ledger-sweep/run`

Exact JSON body:

```text
{
  runId: string,
  folderId: string
}
```

Both fields are required strings. `runId` must pass existing `isValidRunId`.
`folderId` is resolved through fresh server discovery; it is never joined as
an unchecked path. The route rejects before streaming when:

- the body is malformed or has unknown fields (400);
- the folder/rules are missing or invalid (400);
- the folder is incomplete, unsupported, or replay-ineligible (400);
- the same `runId` output directory already exists (409);
- local sweep ownership or the coordinator conflicts (409);
- memory preflight refuses the folder (507).

On success, set status 200 and content type
`application/x-ndjson; charset=utf-8` through existing
`createDisconnectSafeStream`. The stream events are complete below.

### `POST /api/trade-ledger-sweep/stop`

Exact JSON body:

```text
{ runId: string }
```

`runId` is required and validated. Success/mismatch response, HTTP 200:

```text
{ ok: boolean, stopped: boolean }
```

- Matching active run: `{ ok: true, stopped: true }`.
- Active different run: `{ ok: false, stopped: false }`; no mutation.
- No active owner: store this value in the single `pendingStopRunId` slot and
  return `{ ok: true, stopped: false }`.

The matching Run consumes the pending slot and terminates cancelled before
spawning. Repeated Stops collapse into the one slot.

### `GET /api/trade-ledger-sweep/status?runId=<id>`

`runId` is required and validated. Success is always HTTP 200; ownership
mismatch is data, not an exception:

```text
{
  ok: true,
  runMismatch: boolean,
  running: boolean,
  activeWorkloads: ResearchWorkloadSnapshot[],
  run: LedgerSweepStatusRun | null,
  lastRun: LedgerSweepStatusRun | null
}
```

- Matching active run: `running: true`, `run` populated, `lastRun: null`.
- Matching terminal run: `running: false`, `run: null`, `lastRun` populated.
- Different retained generation or no retained generation:
  `runMismatch: true`, both branches null.

Do not gate `lastRun` on output-directory completeness. Fatal persistence or
worker failures must survive reload in memory, matching audit F6.

### Common HTTP failures

| Status | Meaning |
| ---: | --- |
| 400 | Invalid body/query/run id, invalid folder, no rules, incomplete/ineligible ledger. |
| 401 | Existing local authorization rejected the request. |
| 405 | Wrong method, supplied by `registerLocalJsonRoute`. |
| 409 | Existing owner/coordinator conflict, output collision, or consumed pending Stop. |
| 507 | Memory preflight refusal. |
| 500 | Unexpected catalog/controller failure before streaming. |

## Wire and retained-state contract

### Enums

```text
LedgerSweepMode = "load_once" | "isolated_per_rule"

LedgerSweepPhase =
  "preflight" |
  "starting_worker" |
  "loading_ledger" |
  "loading_ranks" |
  "joining_ranks" |
  "preparing" |
  "rule_replay" |
  "random_controls" |
  "writing_report" |
  "finalizing" |
  "done" |
  "cancelled" |
  "fatal"

LedgerSweepVerdict =
  "EDGE-CANDIDATE" |
  "HOLDOUT-NEG" |
  "TOO-RARE" |
  "NO-EDGE" |
  "ERROR"
```

### Preflight decision

```text
LedgerSweepPreflightDecision = {
  decision: "load_once" | "isolated_per_rule" | "refuse",
  reason: string,
  rows: number,
  estimatedHeapBytes: number,
  estimatedRssBytes: number,
  childHeapLimitBytes: number,
  freeSystemMemoryBytes: number,
  heapLoadOnceLimitBytes: number,
  rssLoadOnceLimitBytes: number,
  heapRefusalLimitBytes: number,
  rssRefusalLimitBytes: number
}
```

Normalized memory samples used by `phase`, diagnostics, status, and artifacts
have exactly this byte-normalized shape:

```text
LedgerSweepMemorySample = {
  at: number,
  source: "worker" | "controller",
  phase: LedgerSweepPhase,
  ruleId: string | null,
  heapUsed: number,
  heapTotal: number,
  rss: number,
  external: number,
  arrayBuffers: number,
  maxRss: number
}
```

Controller samples populate the Node values available in the controller;
worker-only values are not copied or estimated. Normalize
`process.resourceUsage().maxRSS` to bytes before storage, and convert event-loop
histogram nanoseconds to milliseconds before writing percentile fields.

### Scalar rule result

```text
LedgerSweepRuleResult = {
  ruleId: string,
  ruleName: string,
  sourceHash: string,
  verdict: LedgerSweepVerdict,
  weak: boolean,
  note: string | null,
  candidates: number,
  kept: number,
  keptPct: number | null,
  isMeanPnlDeltaPp: number | null,
  isMedianPnlDeltaPp: number | null,
  holdoutMeanPnlDeltaPp: number | null,
  holdoutMedianPnlDeltaPp: number | null,
  ruleReplayMs: number,
  controlReplayMs: number,
  totalMs: number,
  reportPath: string,
  error: string | null
}
```

`outputDir` on every wire/status object is relative to `server.config.root`.
`reportPath` is relative to that `outputDir`. Absolute server paths are allowed
only inside the controller/worker protocol and are never exposed to the
browser or written into copy output.

Every number must be finite or `null` before crossing the HTTP boundary. Add
an explicit `assertLedgerSweepWireEventIsScalar(...)` in proposed
`trade-ledger-sweep-stream-types.ts`; reject keys named `trades`, `pairRows`,
`report`, or `reportLines` anywhere in an event, and reject `rows` except as
the scalar count inside `diagnostics.preflight`. The `ledgerRows` field is
allowed only as the scalar count in the `start` event, the
catalog/preflight or per-rule replay diagnostic metrics, and final
`diagnostics.perRule` entries.
A bounded `results:
LedgerSweepRuleResult[]` is allowed.

### Stream events

Every event includes the matching `runId`.

| Event | Exact fields and purpose |
| --- | --- |
| `start` | `{ type, runId, folderId, folderName, mode, modeReason, totalRules, ledgerRows, ledgerBytes, rankBytes, outputDir, startedAt }`. Declares the authoritative frozen job. |
| `phase` | `{ type, runId, phase, detail, elapsedMs, completedRules, totalRules, memory }`. Emitted at each phase boundary; `memory` is the current normalized memory sample. |
| `rule_start` | `{ type, runId, ruleIndex, totalRules, ruleId, ruleName, sourceHash, startedAt }`. `ruleIndex` is zero-based. |
| `progress` | `{ type, runId, phase, percent, detail, completedRules, totalRules, currentRuleId, elapsedMs, controlCompleted, controlRuns, rulesPerHour }`. Control fields are `null` outside controls. Throttle to phase change, >=1% overall delta, or 250 ms. |
| `rule_result` | `{ type, runId, result }`, where `result` is one scalar `LedgerSweepRuleResult`. The plugin persists it to `runState` before writing to the browser stream. |
| `diagnostics` | `{ type, runId, entry }`, where `entry` is one bounded diagnostic group entry from the metric table below. Never resend the accumulated diagnostic history on every rule. |
| `done` | `{ type, runId, ok: true, cancelled: false, finishedAt, summary, results, diagnostics, outputDir }`. Authoritative terminal result. |
| `cancelled` | `{ type, runId, ok: false, cancelled: true, finishedAt, summary, results, diagnostics, outputDir }`. Completed/errored rules remain visible. |
| `fatal` | `{ type, runId, ok: false, cancelled: false, finishedAt, error, summary, results, diagnostics, outputDir }`. Fatal state is retained even if final artifacts failed. |

`createDisconnectSafeStream` is used without an `onDisconnect` cancellation
callback. The job remains authoritative after disconnect. The browser passes
`terminalTypes: ["done", "cancelled", "fatal"]` to
`consumeNdjsonStream`.

### Status snapshot

`LedgerSweepStatusRun` contains exactly:

```text
{
  runId: string,
  folderId: string,
  folderName: string,
  mode: LedgerSweepMode,
  modeReason: string,
  phase: LedgerSweepPhase,
  startedAt: number,
  finishedAt: number | null,
  totalRules: number,
  completedRules: number,
  currentRuleId: string | null,
  elapsedMs: number,
  percent: number,
  results: LedgerSweepRuleResult[],
  diagnostics: LedgerSweepDiagnosticsV1,
  summary: string | null,
  outputDir: string,
  error: string | null
}
```

The plugin stores at most one active or terminal snapshot. Results are bounded
by the frozen rule count and contain no row arrays or full report text.

## Artifact contract

The output root is structurally derived from the selected canonical ledger
folder, never from an HTTP path:

```text
<ledgerFolder>/
  sweeps/
    <YYYYMMDD_HHmmss>_<runId>/
      manifest.json
      rule-results.jsonl
      diagnostics.jsonl
      full-report.txt
      summary.txt
      summary.json
      diagnostics.json
      diagnostics-summary.json
      reports/
        <ruleId>.txt
```

Before creating it, require the resolved `sweeps` directory and final run
directory to remain under the canonical selected ledger folder. Reject an
existing final directory; never overwrite or merge runs.

| Artifact | Write contract |
| --- | --- |
| `manifest.json` | Write at Start with schema `trade_ledger_sweep.manifest.v1`; update atomically at terminal. Contains run/folder identity, ledger and rank size/mtime, hashes of small provenance/summary files, frozen rule IDs/names/hashes, replay constants, preflight decision, mode, start/finish times, terminal phase, and error. The worker revalidates the ledger/rank size+mtime and small-file hashes before and after loading. Do not hash the multi-GB JSONL files in v1. |
| `rule-results.jsonl` | Await one append per completed or errored rule in frozen order. Each line is exactly `LedgerSweepRuleResult`. This is partial-run recovery evidence. |
| `diagnostics.jsonl` | Await one append per phase boundary, per-rule replay/control/report completion, and terminal event. It is authoritative when final JSON is absent. |
| `reports/<ruleId>.txt` | Stable checker report for a successful evaluation; for `ERROR`, a standard checker-style failure report containing the full bounded stack/message. Write via same-directory temp file plus rename. |
| `full-report.txt` | Append `===== <ruleId> =====`, the exact per-rule report, and a blank line in frozen order. It remains consumable by existing `archive/mining-ledger/summarize-report.ts`. |
| `summary.txt` | Canonical verdict table with the existing EDGE bar, counts, surface-specific warning, and weak-note explanation. Atomic final write. |
| `summary.json` | Schema `trade_ledger_sweep.summary.v1`; run metadata, terminal phase, `complete`, sorted scalar results, verdict counts, `diagnosticFooter`, `artifactVsIdeaLogVerdictDifferences`, output paths, and error. Atomic final write. |
| `diagnostics.json` | Schema `trade_ledger_sweep.diagnostics.v1`; final aggregate described below. Atomic final write. |
| `diagnostics-summary.json` | Schema `trade_ledger_sweep.diagnostics-summary.v1`; bounded phase, throughput, memory, persistence, slow-rule, verdict/error, and optimization-target summary. Atomic final write. |

Append calls are awaited; do not accumulate unbounded pending filesystem
promises. Final JSON/text writes use a unique same-directory `.tmp` name and
rename. If terminal finalization fails, retain `runState` fatal information
and the already-written JSONL/per-rule evidence.

There is no TTL, deletion route, startup sweep, PID orphan cleanup, or
automatic pruning for these artifacts. Cancelled/fatal output directories
remain explicitly marked by their manifest and partial JSONL files.

## Diagnostics contract

Diagnostics are a first-class result, not debug-log decoration. The worker
collects replay-related measurements; the Vite controller collects spawn,
child-exit, and controller memory measurements. Use monotonic
`performance.now()` for durations, `process.memoryUsage()` for live memory,
`process.resourceUsage()` for CPU/max RSS where supported, and
`node:perf_hooks` `performance.eventLoopUtilization()` plus
`monitorEventLoopDelay()` for worker saturation.

Sample worker and controller memory:

- at job start and end;
- before/after catalog/preflight;
- before/after ledger load, ranks load, join, and prepare;
- before rule replay, after rule replay, after controls, and after report write;
- once per second while a child is alive.

For streaming parsing, accumulate time immediately around each `JSON.parse`.
Define read residual as stream wall time minus accumulated parse time. Label it
I/O + UTF-8 + readline residual; do not call it pure disk time.

`LedgerSweepDiagnosticsV1` contains:

```text
{
  schema: "trade_ledger_sweep.diagnostics.v1",
  runId,
  mode,
  input,
  preflight,
  phases: PhaseDiagnostic[],
  memory: { samples, workerPeak, controllerPeak },
  cpu: CpuDiagnostic[],
  persistence: { resultAppendMs, diagnosticAppendMs, summaryBuildMs, summaryWriteMs },
  perRule: RuleDiagnostic[],
  throughput,
  verdictCounts,
  errors
}
```

Every incremental diagnostic entry has the common envelope below; `metrics`
is the exact group-specific object named in the metric table, not an arbitrary
dump of worker or row state:

```text
LedgerSweepDiagnosticEntry = {
  at: number,
  group:
    "catalog_preflight" |
    "ledger_load" |
    "ranks" |
    "prepare" |
    "rule_replay" |
    "controls" |
    "persistence" |
    "memory" |
    "cpu_event_loop" |
    "progress",
  phase: LedgerSweepPhase,
  ruleId: string | null,
  metrics: <the exact object for this group from the table below>
}
```

Keep every metric group below. Names are wire/artifact names, not suggestions.

`diagnostics-summary.json` is the primary human/agent read for bottleneck
triage. It is projected from the final in-memory `diagnostics.json` aggregate
and contains no trace arrays or ledger rows. Its pretty-printed form is capped
by fixed top-rule and error-sample limits, so it remains under approximately
150 lines regardless of the rule count:

```text
{
  schema: "trade_ledger_sweep.diagnostics-summary.v1",
  runId,
  mode,
  terminalPhase,
  phases: {
    load: { ledgerMs, ranksMs, joinMs, totalMs },
    prepare: { totalMs },
    ruleReplay: { totalMs },
    controls: { totalMs },
    reportWriting: { totalMs },
    other: { totalMs }
  },
  wallMs,
  controlsShareOfCompute,
  controlsShareOfWall,
  throughput: { rulesCompleted, rulesPerHour, rowsLoadedPerSecond,
    aggregateRowsPerSecond, aggregateRuleRowsPerSecond,
    aggregateControlRowsPerSecond },
  memory: { peakHeapUsed, peakRss, maxRss },
  persistence: { resultAppendMs, diagnosticAppendMs, summaryBuildMs, summaryWriteMs },
  topSlowestRules: [{ ruleId, name, candidates, kept, controlReplayMs }],
  verdictCounts,
  errors: { count, samples, omitted },
  optimizationTarget: {
    file: "lib/batch-backtest/trade-ledger-replay-core.ts",
    symbol: "random controls loop",
    constraint: "two-pass calibration, independent seeds, exact control math are frozen"
  }
}
```

The phase shares are percentages; compute is `ruleReplay + controls` to match
the existing bottleneck footer. `aggregateRowsPerSecond` combines the known
rule-replay row scans and control-candidate visits, while the two component
rates remain alongside it for interpretation. `errors.samples` is bounded to
the first ten messages and `errors.omitted` preserves the full count. The
source `diagnostics.jsonl` remains the raw trace for deep dives and is not
changed or sent to the browser.

| Metric group and exact metrics | Phase and boundaries | Bottleneck question answered |
| --- | --- | --- |
| **Catalog/preflight:** `catalogMs`, `preflightMs`, `ledgerBytes`, `rankBytes`, `ledgerRows`, `pairCount`, `ruleCount`, `selectedMode`, `modeReason`, `estimatedHeapBytes`, `estimatedRssBytes`, `childHeapLimitBytes`, `freeSystemMemoryBytes` | Request receipt, catalog validation complete, coordinator acquired, authoritative preflight complete, immediately before child spawn. | Is startup metadata-bound, is the estimate credible, and exactly why was load-once, fallback, or refusal selected? |
| **Ledger load:** `ledgerStreamWallMs`, `ledgerJsonParseMs`, `ledgerRowsParsed`, `ledgerBytesRead`, `ledgerReadResidualMs` | Before ledger open through final line; accumulate around every `JSON.parse`. | Is ledger cost JSON parsing or I/O/UTF-8/readline overhead? |
| **Ranks:** `ranksStreamWallMs`, `ranksJsonParseMs`, `rankRowsParsed`, `rankBytesRead`, `rankReadResidualMs`, `rankJoinMs`, `joinedRows`, `unmatchedRows` | Before optional rank open, after parse, before join, after join. | Are ranks expensive to read/parse, is the map/join the bottleneck, and is the join complete? |
| **Prepare:** `prepareMs`, `candidateRows`, `rightCensoredRows`, `pairBuckets`, `sortedRows`, `proxyCount` | Before/after global split, pair bucketing, pair sorting, and guarded proxy construction. | How much reusable work exists, and is ledger ordering/fragmentation unexpectedly expensive? |
| **Rule replay, per rule:** `ruleName`, `sourceHash`, `ruleReplayMs`, `ledgerRows`, `eligibleCandidates`, `predicateCalls`, `admitted`, `rejectedByRule`, `blocked`, `rightCensored` | `rule_start` to deterministic admission replay completion. | Which predicates are slow, and did runtime/verdict differences come from admission-state counts? |
| **Random controls, per rule:** `ruleName`, `controlReplayMs`, `controlRuns`, `calibrationReplays`, `controlCandidateVisits`, `controlsPerSecond`, `candidateVisitsPerSecond` | Immediately before control 0 through completion of control 199. | Are controls the dominant cost, and should later optimization target calibration or replay traversal? |
| **Persistence:** `reportFormatMs`, `reportWriteMs`, `reportBytes`, `resultAppendMs`, `diagnosticAppendMs`, `summaryBuildMs`, `summaryWriteMs` | Per-rule formatting/write/append and terminal aggregation/final writes. | Is runtime computation or report formatting, antivirus/filesystem latency, or durable diagnostics the bottleneck? |
| **Memory:** `heapUsed`, `heapTotal`, `rss`, `external`, `arrayBuffers`, `maxRss`, `controllerHeapUsed`, `controllerRss`; runtime guard `tripped`, `thresholdBytes`, `observedHeapBytes`, `phase`, `ruleId`, `message` | Both processes at every phase boundary, before/after every rule, plus one-second peak sampling; load-once guard trips at the fixed 85% heap threshold. | What is retained-row cost, are controls allocating transiently, does fallback reclaim between children, and is Vite bounded? |
| **CPU/event loop:** `userCpuMs`, `systemCpuMs`, `eventLoopUtilization`, `eventLoopDelayP50Ms`, `eventLoopDelayP99Ms` | Whole job, load, prepare, aggregate rule replay, aggregate controls, and finalization. | Is the job CPU-saturated, I/O-waiting, or blocked without useful progress? |
| **Progress/throughput:** `elapsedMs`, `rulesCompleted`, `rulesPerHour`, `rowsLoadedPerSecond`, `aggregateRuleRowsPerSecond`, `aggregateControlRowsPerSecond`, `verdictCounts`, `errors` | Periodic progress snapshots and terminal aggregation. | How fast is the current run, what should the next run take, and how many rule failures/verdicts occurred? |

Measurement rules:

- Worker CPU durations are summed across isolated children; wall durations are
  never summed and are reported from the controller timeline.
- For fallback mode, `workerPeak` is the maximum across children, not the sum.
- Derive visit counts from known replay scans where possible; do not add a hot
  per-row diagnostic counter solely to count deterministic visits.
- Emit progress at phase changes, at >=1% aggregate delta, or after 250 ms.
  Update retained status on every internal progress update even when the
  stream event is throttled, matching Finder's status-freshness contract.
- Diagnostic collection must not throw into replay. A diagnostic persistence
  failure is recorded, but inability to persist the authoritative rule result
  is fatal.
- The UI renders the compact diagnostics summary by default. Full
  `diagnostics.json` remains available in the secondary Full JSON view; Copy
  Diagnostics copies the compact summary, while the raw `diagnostics.jsonl`
  remains on disk for deep dives.

## Implementation phases

Implement these phases in order. Do not start a later phase from an
unverified earlier state.

### Phase 1. Extract and lock checker semantics

**Deliverable:** Create the proposed schema, replay loader/core, and verdict
leaf modules; reduce the checker and summarizer to adapters while preserving
the Batch exporter and existing CLI.

Before editing, capture baseline checker and summary output from a small clean
ledger fixture. Add assertions that the refactored path is byte-identical,
including deterministic controls, proxy leakage refusals, incomplete-ledger
refusals, verdicts, weak notes, and sorting.

**Verify commands:**

```powershell
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno tests\trade-ledger-checker.spec.ts
..\..\..\node_modules\.bin\esno tests\trade-ledger-exporter.spec.ts
```

Phase 1 exit criteria: the existing checker CLI and batch file still work;
there is no server or UI feature yet; no report byte changed without a failing
parity test explaining it.

### Phase 2. Add the workload interlock and server protocol

**Deliverable:** Implement the proposed additive coordinator, integrate every
long-running Batch/Finder entry point, then register Catalog/Run/Stop/Status
routes and bounded retained sweep state.

Tests must cover simultaneous starts, validation before acquisition,
generation-safe release, matching/mismatched Stop, Stop-before-ownership,
disconnect continuation, status reattachment, fatal-without-artifacts
retention, body limits, unknown keys, traversal/symlink rejection, scalar
events, and unauthenticated non-loopback rejection.

**Verify commands:**

```powershell
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno tests\server-research-job-coordinator.spec.ts
..\..\..\node_modules\.bin\esno tests\trade-ledger-sweep-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts
```

Phase 2 exit criteria: all current Batch/Finder lifecycle tests still pass;
Ledger Sweep conflicts with both; Batch and Finder remain mutually allowed by
the new coordinator; no child replay exists yet.

### Phase 3. Build the worker engine, modes, artifacts and diagnostics

**Deliverable:** Implement load-once and isolated-per-rule orchestration,
exact rule/control replay, structured results, incremental artifacts, memory
preflight, and worker/controller diagnostic collection.

On a deterministic fixture, compare both modes against independent checker
invocations field-for-field and report-for-report. Inject memory values to
force every preflight branch. Verify one ordinary rule error does not stop
later rules, shared-input failures are fatal, a worker crash leaves durable
partial JSONL, Stop leaves no child, and stale worker callbacks cannot mutate a
new generation.

**Verify commands:**

```powershell
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno tests\trade-ledger-sweep-engine.spec.ts
..\..\..\node_modules\.bin\esno tests\trade-ledger-parity-golden.spec.ts
..\..\..\node_modules\.bin\esno tests\trade-ledger-sweep-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\trade-ledger-checker.spec.ts
npm run build:check
```

Phase 3 exit criteria: the server job can complete, cancel, fail, and reattach
without UI; all wire payloads are bounded scalars; Vite never imports the
replay core's child-only execution surface or rule modules.

### Phase 4. Add the top-level Ledger Sweep UI

**Deliverable:** Add the feature-local DOM contract, folder catalog,
Start/Stop ownership, progress, reattachment, sorted verdict table, output
location, holdout warning, and first-class diagnostic rendering/copy actions.

Test stream/status dedupe, stale-run guards, active-run persistence,
`runMismatch`, truncated stream recovery, terminal adoption, disabled invalid
folders, verdict sorting, weak notes, and copy output.

**Verify commands:**

```powershell
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno tests\trade-ledger-sweep-service.spec.ts
..\..\..\node_modules\.bin\esno tests\trade-ledger-sweep-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
..\..\..\node_modules\.bin\esno tests\persisted-json.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts
```

Manual Phase 4 smoke: reload during ledger load, rule replay, and controls;
verify the same `runId` reattaches, Stop remains scoped, stale events cannot
overwrite a newer run, invalid folders cannot start, and all three terminal
states remain visible.

Phase 4 exit criteria: the menu replaces the normal need to run the batch file
without removing that fallback; no ledger/report payload is present in
browser state or localStorage.

### Phase 5. Scale validation and handoff

**Deliverable:** Document routes, modes, artifact schemas, trusted-rule
stance, memory estimates, and operational limits in existing
`docs/trade-ledger.md`; update the existing benchmark to emit the same
diagnostic schema.

Run a 24,000-row full sweep, the existing 2,000,000-row benchmark in
load-once and forced-fallback tests, and a 5,400,000-row preflight plus
multi-rule Stop/reattach smoke. Compare all completed rule metrics/verdicts to
the legacy checker path on the small corpus. Do not call a partial manual smoke
a full-scale pass.

**Verify commands:**

```powershell
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno scripts\bench-trade-ledger-scale.ts 48 500
..\..\..\node_modules\.bin\esno scripts\bench-trade-ledger-scale.ts 4000 500
..\..\..\node_modules\.bin\esno scripts\bench-trade-ledger-scale.ts 10800 500
..\..\..\node_modules\.bin\esno tests\trade-ledger-sweep-engine.spec.ts
..\..\..\node_modules\.bin\esno tests\trade-ledger-sweep-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\trade-ledger-sweep-service.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
npm run build:check
```

Manual Phase 5 server smoke:

```powershell
$env:NODE_OPTIONS="--max-old-space-size=16384"; npm run dev
```

With the UI, run a small full sweep, force/test fallback through injected test
preflight values rather than a production override, start competing Batch and
Finder requests to confirm sweep conflicts, reload during work, Stop, then
inspect the artifact tree and copied diagnostics. For the 5.4M folder, verify
the authoritative mode/refusal decision and observed peaks before allowing
more than the first few rules.

Phase 5 exit criteria: measured peaks agree with the guard branch; the small
full sweep matches the legacy workflow; scale evidence is recorded; all
commands above pass without skips; docs links and paths validate.

## As built (Phase 5 validation, 2026-08-30)

The implemented surface is the top-level Ledger Sweep tab. The four local
routes are `GET /api/trade-ledger-sweep/catalog`, `POST /run`, `POST /stop`,
and `GET /status`; all are registered in dev and preview through
`registerLocalJsonRoute`. Run uses a frozen catalog of trusted repository rule
files, a scoped `runId`, the additive research-job coordinator, and a
disconnect-safe NDJSON stream. Browser state contains scalar rule results and
diagnostics only. Durable output is written below the selected ledger folder:
`sweeps/<YYYYMMDD_HHmmss>_<runId>/`, with no automatic cleanup. The terminal
directory now includes `diagnostics-summary.json` as the primary compact read;
`diagnostics.jsonl` remains the unchanged raw trace and `diagnostics.json`
remains the complete aggregate.

The fixed preflight estimator remains the production authority: child heap
limit 12 GiB, `512 MiB + rows * 2,048` heap estimate, load-once at no more
than 50% of child heap and free memory, isolated-per-rule below the 70%/75%
refusal boundaries, and HTTP 507 above those refusal boundaries. The
load-once worker also stops at the fixed 85% child-heap guard with the fatal
message `runtime memory guard tripped - preflight underestimated; run refused`.
The benchmark accepts an explicit `load_once|isolated_per_rule` mode so both
diagnostic profiles can be recorded; production mode is still selected only
by the fixed preflight.

Measured gates:

| Corpus | Mode/scope | Measured result |
| --- | --- | --- |
| smoke-v2, 24,778 rows | 176-rule load-once snapshot | 176/176 checker report bytes matched; 0 mismatches/failures. |
| smoke-v2, 24,778 rows | 234-rule isolated snapshot | 234/234 checker report bytes matched; 0 mismatches/failures. The rule directory grew between snapshots, so the counts differ by design. |
| F2, 116,930 rows | 193-rule load-once snapshot | 1,844.633s wall timeline; 4.138s aggregate rule replay; 1,835.294s aggregate controls; 684.8 MiB worker RSS peak. The pre-W5 artifact classified five valid zero-admit rules as `ERROR`; the W5 classifier correction makes those `NO-EDGE`. The eight EDGE-CANDIDATE rows include the known q8/q77/q108 rows; q77 is weak from its negative IS median. |
| Synthetic benchmark, 2,000,000 rows | load-once | 9.736s load; 0.683s prepare; 0.529s rule replay; 15.778s controls; 3.57 GiB sampled heap; 3.86 GiB process max RSS. |
| Synthetic benchmark, 5,400,000 rows | load-once, one rule | 29.106s load; 3.303s prepare; 1.972s rule replay; 58.815s controls; 5.11 GiB sampled heap; 9.90 GiB process max RSS. |
| F3 real ledger, 5,412,528 rows / 1,880 pairs | production preflight + two-rule validation-only load-once | Production preflight refuses: estimated heap 10.82 GiB and estimated RSS 11.08 GiB. The validation-only test-harness run measured load 33.492s, ranks 11.074s, join 8.825s, prepare 4.696s, rule replay 4.404s, controls 1,313.568s, and total diagnostic wall 1,384.352s; peak sampled heap was 6.270 GiB and peak RSS 9.624 GiB, with the 85% runtime guard not tripped. |

The measured bottleneck is control replay, not parsing or ranking. F2 controls
were 99.775% of aggregate replay-plus-controls time and 99.494% of total wall;
F3 controls were 99.699% and 94.858%, respectively. The pinned optimization
target is `lib/batch-backtest/trade-ledger-replay-core.ts:466-502`; preserve
the two-pass calibration, seeds, and exact replay math while optimizing it.
The per-phase and per-rule diagnostics retain the load/parse/ranks/prepare/
replay/controls evidence needed before any future estimator change.

The current F3 validation confirms the breakdown directly: controls consumed
1,313.568s, versus 33.492s loading, 11.074s ranking, 8.825s joining, 4.696s
preparation, and 4.404s rule replay. The certified F3 diagnostic snapshot used
for the fixed percentage summary above reports controls at 99.699% of aggregate
replay-plus-controls time and 94.858% of total wall; the validation-only rerun
had different machine timing (99.666% and 94.887%) but the same control-replay
bottleneck. No production override was added.

The W6 legacy-oracle check ran
`archive/mining-ledger/test-all-rules.bat` once with the smoke-v2 selection
piped to the batch prompt. It processed the current 244-rule catalog with zero
failures. The matching server sweep completed with 244 durable report files;
all 244 report bodies matched the BAT sections field-for-field after removing
the BAT-only trailing blank separator. This keeps the BAT workflow working
through the refactored CLI while retaining it as a fallback oracle.

W5 verdict reconciliation is read-only against
`archive/mining-ledger/idea-log.txt`; the log remains authoritative for the
implementation-agent judgment. In the historical 189-rule F2 comparison,
10 artifact verdicts differed from the log. The current frozen artifact has
193 rows because four rules were added later; after converting valid zero-admit
results to `NO-EDGE`, the same ten substantive differences remain:
q90 `EDGE-CANDIDATE` vs log `NO-EDGE`, q68 `HOLDOUT-NEG` vs `NO-EDGE`, q125
`HOLDOUT-NEG` vs `EDGE`, and q51, q61, q151, q43, q152, q36, and q75
`TOO-RARE` vs `NO-EDGE`. Each sweep `summary.json` now records these as
`artifactVsIdeaLogVerdictDifferences` without changing the log. The five
zero-admit `ERROR` rows were q11, q12, q157, q46, and q56. The rule-side
reasons are mechanical: q11 requires prior pair win rate/trade history plus a
positive gap, q12 requires overnight hour plus at most five candidates, q157
requires a six-trade 48–54% prior win-rate band plus at least 35 candidates,
and q46/q56 require at least 40 prior pair trades with win rate below 35% (q46
and q56 are the same predicate). None admitted a candidate in F2. This was a
sweep classification error, not evidence that the rule source failed.

W4 browser lifecycle smoke was not run: this execution environment has no
browser automation/DevTools runner. The UI claim is therefore downgraded to
the route/service/DOM-contract coverage and injected reattach/Stop tests; a
human browser run must still verify reload reattach, stale-tab Stop rejection,
invalid-folder refusal, and fatal-state retention.

The full npm wrapper suite remains unavailable in this sibling workspace because
npm rejects duplicate workspace names (`Strategies-Finder` and
`Strategies-Finder-rust-engine-audit-tmp`, `EDUPLICATEWORKSPACE`). The equivalent
direct `tsc` and `esno` runners were used for the listed gates; the unrun npm
wrapper commands are not marked green.

## Risks

1. **Controls may remain the dominant runtime.** The 200 independently
   calibrated controls dominate asymptotic work. Load-once removes repeated
   parsing and preparation but may not turn a four-hour sweep into minutes.
   Diagnostics v1 must establish the real bottleneck before anyone changes
   control mathematics or shares work.
2. **Memory estimates are empirical.** Row shapes can grow with future feature
   versions. Version the estimator assumptions, report estimates beside
   observed peaks, refuse unsafe runs, and recalibrate whenever
   `TRADE_LEDGER_FEATURE_VERSION` changes.
3. **Fallback does not reduce single-rule peak.** Isolated-per-rule guarantees
   reclamation but still needs enough memory for one complete parsed ledger.
   It is not a streaming low-memory algorithm and must never be presented as
   one.
4. **Rules are executable code.** A local rule can read files, loop forever,
   or terminate its worker. Child isolation and local authorization reduce the
   blast radius but are not a sandbox; only trusted repository rules are
   eligible.
5. **Coordinator integration can regress mature jobs.** A leaked token can
   deadlock starts; an over-broad matrix can serialize unrelated work; early
   release can permit memory overlap. Keep the coordinator additive, preserve
   local locks, and test every Batch, TOP_MEAN, and Finder start path.
6. **The sweep consumes holdout trust.** Showing holdout for every rule makes
   the result descriptive, not pristine selection evidence. Keep the warning,
   never auto-apply a rule, and require cross-surface replication plus one raw
   engine certification.
7. **A process or machine crash can prevent final files.** Incremental
   `rule-results.jsonl` and `diagnostics.jsonl` are the recovery evidence.
   Never reconstruct or label a partial directory as a clean completed sweep
   silently.

## Builder completion checklist

- Phase 1 parity fixtures prove unchanged checker and verdict behavior.
- Every proposed route uses `registerLocalJsonRoute` and has an authorization
  regression test.
- Every streamed route uses `createDisconnectSafeStream`; browser consumption
  requires a terminal event.
- Stop is always scoped by `runId`, including the single pending-stop race
  closer.
- Fatal/no-artifact terminal state is available from scoped Status.
- No heavy rows or report text cross the child-to-Vite retained state or the
  Vite-to-browser wire.
- Every Vite-transitive import remains leaf-safe; `npm run build:check` passes.
- Rules and folder IDs are rediscovered and canonicalized server-side.
- The memory formulas and thresholds match this document exactly.
- The artifact directory is permanent, unique, path-contained, and never
  automatically deleted.
- The Ledger Sweep partial and feature-local sweep DOM contract change together.
- Active browser ownership uses the persisted-json envelope and stale-event
  guards.
- Diagnostics contain every metric group and are useful after a crash through
  incremental JSONL.
- The holdout warning is visible whenever results are shown.
- Existing Batch, TOP_MEAN, Finder, trade-ledger, persisted-json, DOM, and build
  checks pass without skips.
