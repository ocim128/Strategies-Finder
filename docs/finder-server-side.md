# Server-Owned Finder Jobs

Finder Symbol Universe is a **server-owned job**: the Vite server process owns
the complete lifecycle for every selected entry strategy — IS evaluation,
survivor merge, optional OOS validation, diagnostics combination, and the
authoritative terminal candidate slice. The browser is the control and
rendering layer and can reattach to an in-flight or completed job after a tab
reload. Current-chart Finder remains browser-side.

Universe and Asset Opportunity holdout runners share the single-task worker
transport in `lib/finder/server/finder-task-worker.ts`: current-task ownership,
crash/exit reporting, immediate Stop termination, and awaited disposal.
Each runner retains its own message conversion, resource limits, and scheduling;
TOP_MEAN and ledger pools keep their separate lifecycle contracts.

Historical crypto CSV loads pass their requested bar limit to the shared
columnar loader, materializing only the newest requested bars on cache hits.
Detached loads retain the full series. See the
[price-data guide](price-data.md) for shared loader and freshness contracts.

Shared IBKR parsed columns in worker isolates are bounded by 512 series and
16 million candle points (768 MB). Main-thread daily/4h working sets keep
their separate limits. CSV mtime validation and per-run cache invalidation
remain authoritative. TOP_MEAN Arm Performance children still make one replay
pass; the standalone coordinator's annual delta-index cache is not retained
between Finder candidates.

Asset Opportunity fixed-horizon `oosHorizonBasis` accepts `pair` (default),
`base_only` (BASE long), and `quote_only` (QUOTE short). Single and batch runs
load the selected synthetic leg through the run-scoped dataset cache and align
entry/horizon candles by normalized pair timestamps. Only needed leg candles
reach the runner; missing horizon candles remain unavailable. Ordinary symbols
keep pair measurement, and next-exit replay does not use the leg basis.

## Arm Performance

Ranking consistency is an optional measurement on the existing local route.
`options.armPerformance.measurement` is `return` (also the omitted legacy
default) or `ranking_consistency`. Fixed-horizon ranking uses `horizon`; switch
ranking requires `rankingHorizon`, sent from the same saved UI input. Both use
the existing positive integer bound of 1,000 bars. Validation occurs before
owner acquisition; stale contributor exclusion becomes raw when ranking is
selected. Optional `options.armPerformance.rankingSort` accepts
`overall_ordering` (the compatibility default) or `selected_asset`. It is a local
display preference captured for configuration/export metadata; replay never uses
it to select assets or calculate scores. The captured context records the
effective measurement, horizon and submitted sort preference.
Authorization, pair limits, memory admission and run-id-scoped Stop are unchanged.

Only the trusted `finder_arm` execution profile forwards the opt-in to replay.
Switch capture retains at most five indexes and complete predictor keys per arm
before releasing score snapshots. Its simulation and target-outcome measurement
run sequentially; horizon mode shares its existing same-horizon outcomes. Both
reuse lazy target loading, bounded prefetch/LRUs, frozen cutoff and cost arithmetic.
Ranking uses completed candles, including when switch fills can use the current
candle's known open. Target timestamps are normalized before gap detection.
Forward gaps beyond the decision-window end also invalidate frozen measurements.
Cooldown capture uses original pools and the existing pre-update selection
history; it never adds a second history or replaces failed members with #6.
Cooldown top-five capture shares a lazy digest cache across arms at one event
timestamp. The cache is cleared when the timestamp changes, preserving the
existing digest and tie order without retaining a run-length cache.

Replay, coordinator and both Finder candidate variants add a scalar-only
`rankingMeasurement` section: `semanticsVersion: "top-five-ranking-v2"`,
`horizonBars` and `arms` keyed by the canonical replay arm mapping. Each arm
carries `eligibleEvents` and `scoredEvents` (both count every valid event),
other skipped counts and reasons, tied/total comparisons, mean accuracy, #1
superiority, optional `soleFirstPlaceCount`, `sharedFirstPlaceCount`,
`soleFirstPlaceRate`, `sharedFirstPlaceRate`, CI bounds, populated `blockCount`, `measurementWindowSec`,
`timeBlockWidthSec`, and `timeCoverageSec`
and `available` / `insufficient_data` / `no_events` status. Ranking status is
independent of switch trading status. Overlap never removes a valid event from
these means. CI availability requires 100 scored events and ten populated
elapsed-time blocks. Per arm, `D` is the maximum completed exit-open minus
entry-open duration plus one parsed interval; initial width is `2*D`. Bins are
anchored at the earliest scored entry and are half-open; empty bins are omitted.
If no interval is available, multi-bar windows infer their final-candle duration
as elapsed/(H-1); a one-bar window cannot infer coverage and has null confidence.
Ten thousand seeded draws resample whole populated blocks and pool their sums
and event counts. Unequal blocks never give events unequal point-score weight.
See [the exact rule and its limits](finder.md#arm-performance).

A valid zero-event section is unavailable
data; a requested missing, malformed or wrong-horizon child section is a fatal
child contract error, collected before owned artifact cleanup. Stop prevents
partial measurement scores from completing a candidate.

The first-place counts use the same five completed returns and scored events:
strictly highest selected return is sole first place; a tied highest return is
shared first place. Their rates divide separately by scored events and are null
at zero events. Predictor ties do not change these realized outcomes. No extra
loads, outcome arrays or backtests are needed.

The coordinator wire serializer, Finder preview/terminal serializer and local
snapshot compactor explicitly copy these scalars and discard unknown arrays.
Frequency fields are additive within v2. Missing or malformed source counts
leave only frequencies unavailable with a rerun message; existing accuracy,
superiority, CI and return/P&L survive. Valid counts can reconstruct absent rates;
provided rates must agree with counts. Recovery never invents zero counts.
Version-1 persistence envelopes remain unchanged. Missing UI preference means
Return and Overall ordering; v1 ranking, missing or future/malformed measurement semantics require
a rerun while
original return/P&L summaries survive. The existing terminal/status inventory
remains authoritative on reload. No annual passes, pool snapshots, outcome
archives, detailed ranking event rows, database migration or resume storage
are introduced. The original v1 delivery plan has been retired; the current
v2 rules are documented above.

Scalar ranking recovery validates each of the seventeen arm sections once. The
fifteen legacy sections remain required; absent or malformed additional sections
are omitted independently, without discarding valid legacy measurements.
Ranking scoring and confidence bootstrap report the existing `aggregate` phase,
with one start notification and one completion per enabled arm. The coordinator's
existing progress throttle bounds wire updates, and ranking time is attributed
to `aggregateMs` rather than target `outcomesMs`. Scores, bootstrap draws and
cancellation checks are unchanged.

Arm Performance is a server-owned Finder job registered at
`POST /api/finder/arm-performance-run`. The browser sends the selected entry
and exit strategy keys, search options, captured backtest/capital settings,
interval, Rust preference, horizon/date window, and explicit synthetic-pair
list. The route rejects unsupported modes, malformed limits or dates, blank
or single-symbol lists, duplicate resolved pair identities, unsupported
strategies, provider conflicts, and more than 5,000 pairs before reserving
owners. Pairs whose local legs are unavailable are skipped; at least one
available pair is required. The route enumerates the trusted pair list once
and passes that exact enumeration to every child coordinator, retaining the
skipped pair tokens in the run context.
At execution time, missing or short candle loads are recorded and omitted from
that candidate's coverage; the candidate proceeds with pairs that loaded.
Backtest execution errors still fail the candidate. Pair load reasons and
replay coverage counts are retained in the terminal run context for Copy
Diagnostics and reload reattachment, including runs with no completed
candidates. If no pair loads for a candidate, that candidate cannot be scored.

The Finder plugin holds Finder ownership and the shared Batch/TOP_MEAN
reservation for the whole sweep, including the gaps between candidates and
child teardown. It runs one TOP_MEAN coordinator at a time. Worker reuse is ENABLED for production sweeps (`enableWorkerReuse`): the
benchmark (docs/finder-arm-performance-worker-reuse-plan.md) measured 10-21%
faster multi-candidate sweeps with identical deterministic results and
comparable peak memory. The runner owns a
single sweep-scoped TOP_MEAN worker pool lent to every child: a successful
child execution leaves the workers alive so the next candidate skips worker
startup, and before each reused execution the pool makes every retained
worker drop its module-level dataset caches (the leg/pair LRUs key without a
source version, so stale candles must never survive a candidate boundary) — the same worker-count and 75%-RAM
memory budgets as standalone runs, retained across candidates instead of
re-spawned. A child failure, fatal, or Stop cancels the pool - including a Stop
landing in the artifact-cleanup gap, which the runner forwards from its abort
signal - and the sweep never lends it again; the runner's `finally` disposes the pool (cancel +
worker-termination drain) on every sweep exit before owner release. Child
archive logging and resume are disabled; after worker-termination drainage,
the runner removes only that validated child's artifact directory. Cleanup failure stops the sweep
before another child starts and leaves earlier compact result rows available.
Batch Stop or TOP_MEAN child Stop delegates to the parent Finder run and keeps
both reservations until teardown finishes. A mismatched run id does not stop
or release the active sweep.

The worker script is resolved and bundled lazily when a pool first needs a
worker, then pinned for that pool's lifetime. Reused candidates and pool growth
reuse that path; new pools resolve current sources afresh. A fully completed
resume does not bundle or spawn workers. Per-candidate dataset-cache resets
remain mandatory. Successful child-directory deletion also evicts that
child's parsed shards from the coordinator's process-wide cache.

Each evaluated candidate writes one compact diagnostic event to the parent's
JSONL log under `archive/finder-runs/<runId>.jsonl` (or `FINDER_RUN_LOG_DIR`).
`arm_candidate_complete`, `arm_candidate_failed`, and
`arm_candidate_cancelled` include candidate/child ids, pair counts, requested
and actual engines, phase durations, worker bundle/startup/load/backtest
timings, and cache counters when available. The runner drains the best-effort
log append before deleting child artifacts. Logging failures warn without
failing the sweep. These measurements do not add candles, trades, or results
to Finder's stream or status wire.

The local-only, run-id-scoped
`GET /api/finder/arm-performance-diagnostics?runId=...` supplies Copy Diagnostics
with a bounded `finder.arm-speed.v1` JSON report while running or after completion.
It uses existing child measurements without rerunning backtests or replay.
The parent accumulates numeric totals and retains only five slow candidates
plus the last diagnostic; the current child's snapshot is separate from totals.
The route includes configuration counts, progress, server-process RSS (including
threads), main-thread heap use/limit, system RAM and CPU count, cache counters,
and bounded pair-failure examples. No pair inventory, candle/trade arrays, or
arm score tables are returned. Normal status polls remain unchanged.
Reports use one JSON line per section. Finished-candidate phases use child wall
time; worker durations sum concurrent work, replay subphases can overlap, and
engine phase times are sampled. Live phase counters may update only at phase
completion. Reports are retained with the in-memory job and are unavailable
after a server restart or replacement by another run; durable JSONL logs remain.

Replay efficiency (replay-efficiency plan): the finder_arm child runs ONE
full-window replay, so its target LRU is sized to the prefetch window (not
the standalone 512-entry annual working set) and the cross-window shared
target-outcome cache is omitted — per-target entries die after consumption
instead of persisting for an annual pass that never comes. Dense per-event
score snapshots are released before outcome evaluation (they are only
retained when pool-snapshot/candidate-outcome diagnostics are enabled), and
clean data (no target gaps) reuses the pre-computed selector winners instead
of re-ranking every view. Standalone TOP_MEAN keeps the large cache, the
shared annual outcome cache, and full diagnostics.

Asset-switch replay has a dedicated selector pass: it resolves all 17 arm
picks in one pass over each event, retains only the event time and picks, and
releases each score snapshot after use. Its position loop handles no-due-order
and unchanged-pick decisions synchronously; it awaits only when a target-candle
lookup or fill needs asynchronous work.

Only TOP_STABLE_SUPPORT and TOP_FRESH_SUPPORT remain as additional causal
arms. Their scores use the trade-vote ledger and original entry timestamps,
without graph scoring or a separate target-price loading pass. Tie hashing
reuses the fixed event prefix with identical UTF-8 digests and tie order.

On the captured 4,999-pair `mcginley_dynamic_confirmation` 4h switch-return
fixture, the isolated first candidate took 11.5 s with the seventeen retained
arms versus 21.8 s after the earlier twenty-arm optimizations (about 47% less
wall time). All ten candidates matched the saved metrics for the seventeen
retained arms exactly. The full seventeen-arm CLI sweep took 113.9 s; host
load and cache state affect live-server timings.

The coordinator receives one frozen evaluation cutoff across all child runs.
Pair backtests and annual replay windows use it. Horizon outcomes use only
closed target candles; asset-switch fills also receive the current candle when
its open timestamp is at or before the cutoff, while terminal marks remain
closed-candle-only. This prevents later candidates from gaining newly closed
bars during a long sweep without dropping a valid open fill at the cutoff. The
cutoff is not a market-data snapshot: files can still be corrected or replaced
while the sweep runs.

Asset-switch replay normalizes target prices into a bounded LRU that retains
up to 8,192 series and 8 million candle points (three `Float64Array` fields per
point, about 192 MB at the point limit). Short daily histories can therefore
stay cached across decisions in large universes; long histories still evict
by candle count. Empty and invalid histories remain bounded by the entry limit.
Copy Diagnostics exposes `switchSeriesCacheHits`, `switchSeriesCacheMisses`,
`switchSeriesCacheEvictions`, and `switchSeriesCachePeakPoints` separately from
the raw target-loader cache. The coordinator's
raw target-data cache remains separately bounded by its prefetch window.
Rust preference is forwarded to each child, and result rows record requested
and actual engine modes.

Speed diagnostics include the executing child's `runtime`: process id, Node
version, process start time and replay implementation marker. Historical
children without these fields report `null`; exporting later never assigns
the exporter's code version to an earlier run. This helps distinguish stale
server code from CPU, I/O and cache variability when CLI and live timings differ.
The current marker is `temporal-support-only-v4`.
`config.pairListHash` fingerprints the ordered canonical pair list without
exporting thousands of symbols. Equal pair counts do not mean equal work:
compare the hash, strategy parameters, window, cutoff and costs before treating
two runs as a speed comparison.

Daily IBKR targets retain compact source columns in a main-thread LRU with
8,192 entries and an 8-million-candle limit (about 384 MB for six Float64
columns). Every request still checks the CSV mtime; sync changes invalidate
retained columns before use. Worker caches still reset between candidates.
`parsedDailyCacheHits` and `parsedDailyCacheMisses` count these source-column
reads during replay, including reuse across candidates; raw target loads can
remain misses while the underlying disk read is avoided.

Short server IBKR target histories are authoritative local CSV reads. They no
longer trigger two additional historical reads of the same file just because
their length is below the generic stale-fragment threshold. Synced crypto CSV
targets use the same rule; non-authoritative cached fragments retain refetch.

For the 41-strategy daily switch-ranking snapshot (4,990 pairs, two-bar
horizon, captured date range/cutoff), a controlled four-worker CLI comparison
took 161.1 s before and 137.2 s after this cache change. Source-column reads
recorded 195,611 hits and 2,798 misses; summed target-load time fell from
157.1 s to 52.3 s. A four-strategy sample at the usual 28 workers took 17.9 s
and 14.3 s with identical results. The full sweep differed slightly in one
confidence-weighted ranking; the unchanged baseline also reproduced that
variation in separate runs, so this is not a full bit-for-bit parity claim.
These comparisons pin the captured pairs and parameters; live timings depend
on worker count and host load.

Causal switch picks share lazy tie digests within each decision timestamp.
Ranking insertion computes the incoming candidate digest at most once and
visits only the applicable pool specifications. Bounded top-five insertion
creates no retained row for discarded candidates. These changes preserve
score arithmetic, tie keys, and all seventeen retained arms.

`scripts/bench-finder-arm-snapshot.ts <status.json> <label> [baseline.json]`
reruns a completed `/api/finder/status?runId=...` snapshot as an isolated CLI
job with the captured parameters, pairs, costs and cutoff. It writes timings
and canonical result hashes under `artifacts/arm-replay-eff-bench/`; it fails
when results differ from the captured inventory or supplied baseline.
Use the usual 16 GB Node heap for large runs. Local candle files must remain
unchanged, and this harness currently supports snapshots without exit overrides.
The 4,989-pair, daily `true_range_skew_acceptance` / switch-ranking example
reduced target loads from 13,796 to 7,249 with identical results. Local measured
wall times were 63.4 s before and 28.5 s after (the original browser report was
48.3 s); single-run timings vary with CPU and cache state.
On the subsequent 4,990-pair snapshot, removing per-insertion closures and
discarded rows reduced profiled CLI time from 30.2 s to 21.5 s; an unprofiled
rerun took 19.9 s. Both reruns matched every captured result field. The user's
server report for that snapshot was 45.0 s, so compare timings on the same
host workload and cache state rather than treating CLI time as a guarantee.

Finder streams each scalar candidate once and keeps live `/status` polling
counts-only. The browser saves a bounded, rate-limited Arm Performance preview
while candidates arrive and keeps the matching preview visible after reload;
it can be stale until the next checkpoint or terminal response. The terminal
`arm_done` event and terminal status response carry the authoritative completed
rows plus the frozen run context: ordered pairs, settings, capital,
horizon/date window, cutoff, cap-tilt baseline, and engine usage. Reload
reattaches by the parent Finder run id; a server restart that no longer has
the run returns unavailable instead of polling indefinitely. If the server
inventory cannot be recovered, Re-Sort remains limited to the bounded browser
preview. Apply and copy use the terminal context rather than current menu
controls.

The inventory holds compact metrics for all 17 replay arms per successfully
evaluated configuration; it does not retain candles, trades, event details,
pool snapshots, or candidate outcomes. Work scales as configurations × pairs,
so keep the configuration budget small for 500–5,000-pair runs. Large
server-side TOP_MEAN work should use
`NODE_OPTIONS=--max-old-space-size=16384` or higher.


### Additional causal arms: execution and recovery

The trusted TOP_MEAN coordinator enables the internal `enableCausalArms`
replay option for both Batch TOP_MEAN and Finder children. Every new Finder
child computes the two support arms for Return and Ranking consistency;
Batch TOP_MEAN also computes them for its full-window and annual replays.
The separate Batch OPEN_SCORE post-analysis route keeps its legacy subset.
This is not a public request field, route, service or infrastructure change.
Definitions, clocks and eligible pools are specified in
[Additional causal score definitions](finder.md#additional-causal-score-definitions).

The sequential scan and packed scan workers reconstruct valid loaded degree
and original entry timestamps on both delta legs, including
exits. Tradeless valid pairs contribute degree without a stream. Legacy retained
degree and artifact schemas are unchanged. Entry times add one optional
Float64 column (8 bytes per delta) only for enabled scans; worker packing,
transfer, global-index remapping and segment sorting carry it together.
The parallel path keeps its existing sequential fallback.

The event sweep processes every timestamp, including pre-window and exit-only
buckets. Rolling step-function integrals and expiry queues maintain support
without walking synthetic bars or every open trade at each decision.
No graph endpoints, open-edge ledger, solver buffers or separate price-history
pass are constructed. Target datasets remain lazy and bounded for execution
and forward outcome measurement.

Horizon mode transfers additional keys only into ordinary positive candidates.
Switch mode retains at most five keys/picks and an eligible-pool count per arm
and event while dense legacy snapshots remain available, then releases them
before simulation. No additional dense price/asset/event matrix is retained.
Eligibility counts survive with ranking disabled. Ranking capture still freezes
membership before forward data inspection; future failures skip rather than
replace support-arm picks.

Coordinator summaries, wire serialization, Finder metrics, exports and local
snapshots retain the two optional support result keys plus whitelisted scalar
`causalArmDefinitions` (`finder-causal-arms-v2`) and `causalArmDiagnostics`.
New enabled children require every new section even when it has zero events;
missing or invalid required sections are child contract errors before cleanup.
Legacy recovery requires only the original fifteen arms, validates present
additional data independently and leaves absent/malformed additions unavailable
with **Rerun required**. It never invents zero-event recovery data. The existing
`top-five-ranking-v2` and persistence envelope remain unchanged.

For rollback, disable the trusted additional-arm option for new runs and show
the legacy selector subset. Keep optional-field readers so previously saved
twenty-arm runs remain readable after dropping the three retired arms;
legacy provenance retains its v1 marker and the unchanged support definitions.
Ownership, authorization, admission limits,
reattach, cancellation and owned-artifact cleanup are unchanged; Node worker
imports stay outside browser-bound modules.

Use `scripts/bench-finder-arm-replay.ts --causal-arms --interval 100s` with the
same fixture/options as the baseline (omit `--causal-arms`). The fixture has
100-second target bars; supplying that interval makes the causal clock match
the data. `legacyArmFingerprint` covers all fifteen legacy comparisons,
contributor exclusions, switch metrics and rankings, and must match between
enabled/disabled runs. Reports include runtime, target reads, peak memory and
Stop latency. `tests/open-score-replay-memory.spec.ts` exercises enabled scan,
sweep and compact switch records on 600,000 trades under a 128 MiB JS heap cap.
These checks establish implementation parity and bounded retention, not
out-of-sample research performance.

Historical measurements before retiring Coverage, Price Strength and Graph
Strength: the 2026-10-03 deterministic fixture (60 pair artifacts, 2,000 decisions,
100-second bars, five-bar horizon, ranking enabled) measured:

| Replay | Legacy time | Enabled time | Legacy / enabled target reads | Legacy / enabled peak RSS |
| --- | --- | --- | --- | --- |
| Horizon | 1.39 s | 2.05 s | 67 / 127 | 321 / 341 MiB |
| Asset switch | 1.07 s | 2.35 s | 1,895 / 3,492 | 241 / 299 MiB |

Both legacy fingerprints matched. The enabled switch Stop fixture responded
1.3 ms after cancellation was observed. The enabled 600,000-trade memory spec
passed its 128 MiB heap cap. These are local single-run measurements, not a
production latency guarantee. The final transfer research check still requires
the original and untouched pair lists and one identical fixed configuration,
interval, date window and horizon; it has not been performed on this fixture.

## Asset Opportunity

Asset Opportunity uses the same server owner, run id, Stop route, and reload
reattach path as Symbol Universe, but evaluates one symbol at a time. The
browser receives only scalar opportunity rows; the terminal slice is bounded
by the existing Finder `topN` control. With no fixed holdout, each asset
reserves its latest closed candle for fresh-entry detection and searches
historical candidates without that candle. With a fixed holdout, the visible
prefix is used for both candidate search and the boundary signal, while the
final N candles remain hidden for validation.

Asset Opportunity can reserve the last N historical bars as an OOS holdout.
Candidate ranking and the Finder data slice use only the visible prefix, while
the hidden bars validate the boundary opportunity. `Fixed horizons` preserves
the existing signed close-to-entry forward PnL at three horizons (default
`1,3,5`). `Next configured exit` replays the selected winner across the full
execution-aware timeline and reports the first engine exit for the boundary
entry, including TP/SL, signal exits, exit-strategy overrides, trailing/path
exits, and max-hold time stops. A forced `end_of_data` close is reported as
`censored` without a realized PnL. The setting is disabled when N is `0`,
which retains the normal latest-closed-candle opportunity behavior.

The separate `Eval Window Bars` control (`finderAssetEvalWindowBars`, option
`evalLastBars`) caps the historical search window to the last N bars. The cap
is applied AFTER the holdout trim and the data-slice fraction, so the two
compose: an eval window of 1000 with a 1000-bar holdout evaluates bars
`[-2000, -1001]`, never the reserved holdout itself. `0` evaluates all
available bars. Shorter datasets keep all their bars before the gap
(`slice(-N)` semantics).

The server caps a run at 1,000 symbols. It records an estimated candidate-work
count as a diagnostic, but does not reject a run based on that estimate. The
server requires random Finder mode and clamps the candidate pool to
1–50. The symbol and heap guards protect process stability; they do not
change the Current Chart or Symbol Universe limits.

Asset runs emit bounded debug events named
`finder.asset_opportunity.start`, `finder.asset_opportunity.asset.complete`,
`finder.asset_opportunity.run.complete`, `finder.asset_opportunity.run.cancelled`,
and `finder.asset_opportunity.run.failed`. Event payloads contain counts,
grades, symbols, timings, and errors only—never candles, signals, or trades.

When a single-run stream fails, the browser polls the scoped status endpoint.
A recovered fatal snapshot remains a failed run, even when it includes an
empty `terminalAssets` array; it must not be persisted as successful results.

For a single retained `signal_close` candidate, the full-history freshness
pass first generates signals and skips trade simulation when there is no
boundary entry signal. A possible entry still gets the complete replay with
the generated signals reused, preserving position capacity and repeated-entry
behavior. This screen is disabled for open-position results, multiple retained
candidates (whose active-position support matters), exit overrides, and bounded
replays. Diagnostics report skipped simulations as
`no boundary entry signal; fresh replay skipped` under TypeScript reasons.

## Asset Opportunity Batch

Batch mode sweeps an inclusive holdout range in **one server-owned job** under
a single `runId`. The browser enables it with the `Batch OOS Holdout` toggle
in the Asset Opportunity settings (which hides and disables the single
`OOS Holdout Bars` input) and sends
`POST /api/finder/asset-opportunity-batch-run` with the same fields as the
single route plus `batch: { startHoldoutBars, endHoldoutBars }`. The server
validates the range **before acquiring ownership**: positive integers,
ascending (`start <= end`), each at most 100,000, and at most 1000 values
(`normalizeFinderAssetOosBatchHoldoutRange` in
`lib/finder/finder-asset-opportunity-oos.ts`).

The batch archive always writes the default block plus every Asset Opportunity
Re-Sort metric. For each holdout N, those rankings are appended as separate
delimited blocks in the same `oos-holdout-<N>-bars.txt` file. The `finderResort`
control only changes the displayed Asset Opportunity rows after a run; it does
not affect archive output.

The browser displays and persists one representative row per normalized pair
symbol. Server iteration results and archive blocks remain strategy-level so
the archived evidence can still show which strategy libraries contributed to a
pair.

The batch coordinator (`processFinderAssetOpportunityBatchRun` in
`lib/finder/server/finder-vite-plugin.ts`) drives the range in ascending order
and calls the same per-asset iteration seam as the single route
(`runAssetOpportunityIteration`, extracted unchanged into
`lib/finder/server/asset-opportunity-iteration.ts`), cloning the options
with `oosIgnoreLastBars` set to the current N. The random seed is preserved
across iterations so differences come from the holdout boundary, not a new
sample. After each iteration it appends a compact performance-only top-N
payload (built by `buildAssetOpportunityPerformancePayload` in
`lib/finder/finder-asset-opportunity-metadata.ts`) to
`<server.config.root>/archive/asset opportunity/oos-holdout-<N>-bars.txt`
(`appendAssetOpportunityArchiveBlock` in
`lib/finder/server/finder-asset-opportunity-archive.ts`). Re-running the same
N appends a new delimited block; it never overwrites or deduplicates prior
research. The filename is derived only from the validated integer N — a
request can never supply a filesystem path. Each block records the selected
metric as `Archive sort: <metric>` (`run_default` for the normal run order),
which makes repeated appends with different rankings auditable. The archive
JSON is compact and contains only row identity plus selection/OOS performance
metrics and the selected forward measurement. Next-exit rows use
`nextExitOosPerformance` and the archive adds a mode-specific baseline; those
are never combined with horizon data.
New blocks also include a stable
`candidateFingerprint`, the latest signal-candle hour in UTC and Asia/Jakarta,
and an all-candidate forward-OOS baseline captured before the top-N slice.
Older blocks remain readable but cannot answer fingerprint, baseline, or
signal-hour questions. Manual Copy Top Results remains the full metadata
payload; automatic archives omit params, strategy metadata, support, trades,
equity curves, and exit details.

The archive can be analyzed with
`archive/asset opportunity/analyze-asset-opportunity-holdouts.bat` (or
`scripts/analyze-asset-opportunity-holdouts.ts`). The analyzer reads only
matching files directly inside the selected archive directory, never nested
subfolders. It combines archive blocks from all batch runs by default, so
separate Finder batches covering different holdout ranges appear in one report.
If the same holdout and sort was archived more than once, the latest block is
used. Pass `--batch-run-id <id>` to analyze one run instead. The report includes
strategy-library contribution, a descriptive worst-strategy removal
counterfactual across forward horizons, and best/worst signal-candle hours.
The removal section excludes archived rows; it does not rerun Finder or
simulate capital, position sizing, or trade overlap.

Only the current iteration's full scalar rows are retained (for re-sort and
the terminal view); prior iterations' rows are never held in memory or sent
again. The terminal status snapshot carries the LAST completed iteration's
rows on `terminalAssets` plus bounded batch counts on `batch`:

```text
batch: {
  startHoldoutBars, endHoldoutBars, currentHoldoutBars,
  currentIteration, totalIterations, completedIterations, failedIterations
}
```

Batch stream events (`FinderAssetOpportunityBatchStreamEvent`):

| Event | Purpose |
| --- | --- |
| `asset_batch_start` | Declares the validated range, iteration/asset totals, strategy names, and the fixed `All Sorts` archive mode (`archiveSort`). |
| `asset_batch_progress` | Overall job percent plus in-iteration asset progress, current holdout, phase, and status text. |
| `asset_batch_iteration_done` | Full scalar rows for THIS holdout only, current diagnostics/totals, and the archive filename (including empty-result blocks). |
| `asset_batch_done` | Completed/failed holdout counts, last successfully archived iteration rows, holdout, totals, diagnostics, and summary. |
| `asset_batch_fatal` | Terminal error, current holdout, completed count — also used for archive write failures. |

Stop aborts the active iteration and prevents the next from starting; a
stopped batch reports partial completion and keeps already-appended blocks
intact. If the archive append fails, the batch stops with a visible fatal
(error prefixed `Archive write failed for holdout N`). Stream disconnect does
not cancel the job; reload reattach polls the same scoped status endpoint and
recovers the batch counts plus the last completed iteration.

### Parallel holdout sweep (worker pool)

The production batch route runs the holdout iterations across a bounded pool
of `worker_threads` (`lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts`).
Large ranges use one holdout value per task because iterations are independent
by design (same seed; only the holdout boundary differs). When a small range
would underfill the pool, each holdout is split into contiguous asset chunks;
the main thread merges those chunks back into one iteration before archiving.
The main thread stays the single writer: completed iterations are buffered and
released in **ascending holdout order**, so archive blocks,
`asset_batch_iteration_done` events, and the terminal snapshot remain
sequential-parity outputs. Workers re-resolve strategies by key — strategy
objects never cross the worker boundary — and iteration payloads are the
already-scalar rows enforced by `toScalarAssetResult`.

Worker count: `min(task count, logical cores − 2, memory ceiling)` where
the ceiling estimates one dataset plus its prepared closed-candle view per
worker (~10 MB/symbol) and reserves an estimated 64 MB for that worker's
signal cache against
75% of **actual system RAM** (`os.totalmem()` — 48 GB on a 64 GB
host, 12 GB on a 16 GB host, so small hosts auto-select proportionally fewer
workers). `FINDER_ASSET_BATCH_WORKERS=<N>` overrides outright — `1`
forces the sequential in-process loop (the rollback lever); the override
intentionally bypasses the memory ceiling (operator judgment) but is capped
at 32. Each worker holds each assigned dataset and its prepared closed-candle
view, so large symbol lists reduce the worker count automatically. For chunked tasks the
memory estimate uses the partition size, allowing the pool to use more CPU
without budgeting a full-universe copy per worker. Chunked tasks carry only
their symbol partition and stay affinity-pinned to one worker across holdouts
(whole-holdout tasks pin by their cache-affinity group through the same
scheduling path),
so the total retained dataset budget stays bounded by the same policy while
synthetic leg/pair caches are reused. Large holdout ranges still use one
whole-holdout task per worker. When Rust is actually eligible, the external
Rust server becomes the serialization point and
posts full OHLCV payloads per request — the AUTO worker count is therefore
clamped at 2 (`ASSET_OPPORTUNITY_BATCH_RUST_WORKER_CAP`; 4 for chunked
asset-partition tasks, `ASSET_OPPORTUNITY_BATCH_RUST_CHUNK_WORKER_CAP`); a Rust preference
alone does not apply that cap when the settings force TypeScript. Set
`FINDER_ASSET_BATCH_WORKERS` explicitly only when you have measured a
better value.

Dataset reuse: the batch load context carries run-scoped plain-dataset and
prepared closed-candle LRUs (`BatchDatasetLoadContext.datasetCache` and
`closedCandleCache`) sized by
`resolveAssetOpportunityDatasetCacheCapacity`, which leaves the signal-cache
reserve out of the 75%-RAM budget before dividing by 10 MB per symbol. This
keeps the dataset LRU and signal cache within the worker estimate, so each
symbol loads and prepares its closed-candle view ONCE per worker (or once for
a whole sequential sweep) instead of once per holdout iteration. Synthetic
pairs are excluded from the plain-dataset LRU (their `pairCache` retains them).
The worker-local `pairCache` and pair-metadata LRU use the same reserve-aware
limit through `resolveAssetOpportunityPairCacheCapacity`; if a partition
exceeds that limit, earlier pairs may be reloaded on later holdout iterations.
Failed or empty loads are never cached
— they stay retryable. Iteration diagnostics report prepared-candle cache
hits/misses and isolate `closedCandlePreparation` time inside
`dataPreparation`.

The same worker also keeps a bounded full-series signal cache for repeated
holdout prefixes. It is used only when the search uses the complete data slice,
has no `evalLastBars` or exit-strategy override, and has strategy timeframes
disabled; these are the conditions under which indexed signals can be filtered
to a shorter prefix without changing their meaning. The first eligible
candidate pays a signal-only warm pass, while later holdouts reuse the cached
signals and still run their normal trade simulation. Ordered signal arrays are
validated on insertion and window hits binary-search the requested range;
unordered arrays retain stable scan behavior. The cache is worker-local and
bounded to 8,192 entries and an estimated 64 MB. Asset diagnostics expose
`work.signalCacheHits` and `work.signalCacheMisses` so a run can verify the
reuse rate; a zero hit count is expected for unsupported strategy signal shapes
or ineligible option combinations.

Failure semantics match the sequential loop: a fatal iteration stops the
sweep with `asset_batch_fatal` while iterations before the failed index
complete and archive normally (their runners are allowed to finish);
iterations after it are aborted and never emit. On Stop, in-flight
iterations are discarded and the ones that already completed flush
ascending. A worker crash (non-zero exit or mid-task disappearance) maps to
the same fatal path, and per-asset `run_log` events route through the main
thread so `archive/finder-runs/<runId>.jsonl` stays a single file.

Batch debug events: `finder.asset_opportunity_batch.start`,
`finder.asset_opportunity_batch.iteration.complete`,
`finder.asset_opportunity_batch.iteration_failed`,
`finder.asset_opportunity_batch.archive_failed`,
`finder.asset_opportunity_batch.cancelled`, and
`finder.asset_opportunity_batch.complete` — counts, N, filenames, byte
counts, timings, and errors only.

Two further production-path details:

- Server IS-search exit-param spaces are cached per exit library
  (`exitParamSetsByKey` in
  `lib/finder/server/server-asset-is-search.ts`), mirroring the browser and
  Universe runners. Regenerating them inside the per-candidate loop is
  O(maxRuns²).
- Exit-signal reuse across candidates keys the executor's exit cache by a
  full-window CONTENT identity (`computeExitSignalDataIdentity`): ordered
  time/OHLCV values with exact numeric bit mixing, so a revised candle
  window can never reuse another window's exit signals while
  content-identical slices still share one series. The historical search
  window is immutable for the pass, so the server IS search fingerprints it
  once and threads the identity through `runAssetCandidateBacktest`
  (`exitSignalDataIdentity`); the browser Asset Opportunity runner does the
  same for its full-closed window, the built complementary-OOS window, and
  the window-owned trade-timing movement floors
  (`getTradeTimingPreparedMovementFloors`). The identity is internal
  execution plumbing and never reaches persisted or wire data. Callers that
  do not own an immutable window omit the identity and the executor hashes
  the window itself; mutating callers must bypass reuse rather than trust
  array identity, length, or boundary timestamps.
- `asset_progress` / `asset_batch_progress` STREAM writes pass through
  `createProgressEventThrottle` (first event, ≥250 ms, ≥1% aggregate delta,
  or phase transition). The `/status` snapshot mirroring stays per-event so
  reattach remains fresh; do not throttle the snapshot assignments.

## Symbol Universe parallel strategy sweep (worker pool)

Multi-strategy Symbol Universe jobs run their selected strategies across a
bounded pool of persistent `worker_threads` (`lib/finder/server/
finder-universe-strategy-pool.ts`, worker entry
`finder-universe-strategy-worker.ts`). Each worker executes whole strategies
through the UNCHANGED `runFinderUniverseExecution` core, so backtest
semantics are byte-identical to the sequential loop. Load-bearing contracts:

- **The main thread is the single writer.** The shared sweep coordinator
  (`runAssetOpportunityBatchSweep`, genericized over task/result/progress
  types) releases completed strategies in ASCENDING strategy order, so
  survivor merges, `candidate` stream events, and the terminal inventory
  stay identical to the sequential loop. A fatal strategy stops the sweep
  after earlier strategies merge; Stop discards in-flight strategies while
  flushing the ones that already completed.
- **Survivors stream per strategy, not per candidate plan.** Unlike the
  sequential path (which streams survivors live during a strategy via
  `onResultsUpdate`), the parallel path streams each strategy's survivors
  when that strategy releases. The terminal `done.candidates` slice is
  authoritative on both paths.
- **Strategy objects never cross the worker boundary.** Tasks carry keys;
  workers re-resolve via `loadBuiltInStrategyByKey`. Worker param generation
  uses its own `FinderParamSpace` — the SAME seeded generator the HTTP
  handler injects, so plan generation and exit sampling stay deterministic
  and identical to the sequential path. (A caller-injected
  `generateParamSets` stub is a sequential-path-only test seam.)
- **Each worker owns a private dataset cache** with the job cache's
  dedupe/eviction semantics (failed/empty loads are evicted and retryable),
  so a worker loads every universe symbol at most once no matter how many
  strategies it processes. One dataset copy exists per worker; the
  worker-count memory ceiling budgets for that. Per-strategy cache DELTAS
  are summed into the job diagnostics (`requests`/`hits`/`misses` reflect
  real per-worker loads; `entries` reports the largest worker cache).
- **Worker count policy** (`resolveUniverseStrategyWorkerCount`):
  `FINDER_UNIVERSE_WORKERS` env override (1 = sequential in-process loop,
  the rollback lever; capped at 32, bypasses the memory ceiling), otherwise
  min(strategy count, logical cores − 2, memory ceiling). The ceiling budgets
  75%-of-RAM for each dataset and its prepared closed-candle view, estimated at
  `bars-per-symbol × ~105 B` when the run's slice/interval bounds the bars
  (`resolveUniverseMaxBarsPerSymbol`: `date_range` with both bounds, or the
  `1`..`5` year slices), and at the 100k-bar-cap worst case (~10 MB/symbol)
  otherwise. A 6-year 4h window is ~13k bars/symbol, so bounded runs no
  longer collapse to 1 worker on hosts that could safely host many.
  With the Rust engine preferred AND the settings able to execute Rust runs,
  the AUTO value is capped at 4 — the external Rust HTTP server serializes
  execution. When the settings force the TypeScript engine for every run
  (e.g. exit-strategy override / slippage —
  `hasCapabilityIndependentTypescriptRequirement`), Rust serializes nothing
  and the cap does not apply.
- **Cancellation** combines ownership loss and the run abort signal (the
  same two conditions the asset paths check); Stop terminates in-flight
  workers immediately so no CPU/RAM-heavy orphan work survives.
- Single-strategy jobs (or a resolved count of 1) always use the sequential
  in-process loop.

The parallel contracts are locked by
`tests/finder-universe-parallel.spec.ts` (sequential/parallel parity,
ordered release, cancel flush, fatal isolation, worker-count policy, worker
dataset-cache semantics; in-process fake runners execute the real worker
task core). The real-thread bootstrap (esbuild bundle + `worker_threads`
message protocol) is covered by the real-worker smokes in
`tests/server-worker-entry.spec.ts`.

## Per-run JSONL diagnostics log

Single and batch Asset Opportunity runs append one JSON line per event
(`iteration_start`, `asset_complete`, `asset_failed`,
`iteration_complete`, plus per-iteration `datasetCacheHits` /
`datasetCacheMisses`) to
`<server.config.root>/archive/finder-runs/<runId>.jsonl`.
Set `FINDER_RUN_LOG_DIR` to override the directory (an empty value behaves
like unset — there is no disable switch). This file is the durable post-mortem trace when
the Vite process dies mid-run — the in-memory debug ring buffer does not
survive. The production sink is `createBufferedFinderRunLogSink`
(`lib/finder/server/finder-run-log.ts`), which batches appends (256 lines /
250 ms / iteration boundaries) instead of one syscall per event; it is
fire-and-forget and must never throw into a run. In the parallel sweep,
per-asset run-log events route through the main thread so the JSONL stays a
single file.

## Browser-owned Finder modes

Current-chart Finder and Strategy Quality remain in the browser. Genetic and
scoring modes use their dedicated in-tab runners. This document covers
only the server-owned Symbol Universe and Asset Opportunity routes; do not
infer server ownership for another Finder mode from the shared result types.

## Runtime contract

- Start with `npm run dev` for development. `vite preview` also registers the
  Finder Universe endpoint; a static-only deployment does not.
- **One request per run.** The browser submits all selected entry strategy
  keys in a single `POST /api/finder/universe-run` request with a
  browser-generated `runId`. The server sequences strategies, merges scalar
  survivors, runs OOS (when enabled), and publishes one terminal snapshot.
  The browser no longer sequences per-strategy requests or loads OHLCV for
  the OOS pass. Asset Opportunity batch mode uses the analogous
  `POST /api/finder/asset-opportunity-batch-run` route (see above).
- **Stop is scoped by `runId`** — `POST /api/finder/stop` carries the active
  run id so a stale tab cannot cancel a newer run. Stop aborts in-flight
  data loads, makes every strategy + OOS loop observe lost ownership, marks
  the snapshot cancelled, and clears the browser-side active-run record.
- **Tab reload reattach is supported.** The browser persists the active
  `runId` (`playground_finder_active_server_run`, schema
  `finder.active_server_run`, v1) before `fetch`. On Finder init, it polls
  `GET /api/finder/status?runId=...`; if the server still has the job, it
  restores progress + Stop state and polls status with `includePreview=1` until
  terminal. Universe responses include a bounded live ranking preview (25
  candidates, at most 200 scalar symbol rows per candidate), so existing rows
  return after reload and continue updating without starting another run.
  The preview never becomes the full run inventory; terminal adoption replaces
  it with the authoritative final candidates once. Reattach
  only survives a browser reload while the same Vite process remains alive
  — a Vite restart loses the in-memory job (the reattach clears its record).

- If the initiating NDJSON stream breaks without a reload, the same tab polls
  the scoped status endpoint to terminal. It never promotes provisional
  streamed candidates to the final result.
- Both entrypoints share one owned-run poll loop in
  `lib/finder/browser/finder-server-session.ts`
  (`pollOwnedServerRunStatus`): it fetches and parses the scoped status
  snapshot, waits abort-aware between requests (Stop / a new run unblock a
  pending sleep or backoff immediately), and returns an internal outcome
  (terminal / job gone / rejected / cancelled / connection lost). Retry
  cadence preserves each caller's pre-consolidation policy: recovery's first
  request is immediate and a retry follows the failure backoff (2s→15s)
  directly; adopted reattach waits the polling interval before each request,
  steps from 2s to 5s after 150 completed polls, and re-waits the interval
  after every backoff before retrying. Both terminate after more than 20
  consecutive failures. The callers keep their distinct responsibilities:
  reattach owns the initial persisted-run probe, scope/UI adoption, and
  whether the persisted record is cleared (confirmed completion/Stop and
  confirmed missing jobs clear it; transient failures retain it); recovery
  only interprets the terminal snapshot for the workflow that still owns the
  run. Ownership (`activeRunId`) is re-checked after every await — before
  HTTP status interpretation, progress updates, or terminal adoption — so a
  stale response (404 included) can never update a newer run's UI, and a
  reattach teardown reverts the run UI only when no newer run owns it.
- The shared browser reader (`lib/ndjson-stream.ts`) dispatches the final JSON
  record at clean EOF even without a trailing newline, including Finder's
  configured terminal event types. Malformed final records fail with their
  line number; EOF without the required terminal event remains an interrupted
  stream. See `tests/ndjson-stream.spec.ts`.

## Memory

Large universes require a larger Node heap:

```powershell
$env:NODE_OPTIONS="--max-old-space-size=16384"; npm run dev
```

`run_playground.bat` applies this default unless a heap value is already set.
The server rejects 400-799 symbols below 8192 MB and 800+ below 12288 MB.

Within one server-owned run, successful sliced datasets are cached by
`symbol|interval` and reused by every selected strategy. The cache does not
increase the runner's peak dataset count because one strategy already loads
the full universe; it extends that dataset lifetime until Done, Stop, or Fatal,
when the job cache is cleared. Failed and empty loads are not retained, so a
later strategy can retry them. In the parallel strategy sweep each worker
keeps its own private copy of that cache — the worker-count memory ceiling
(`resolveUniverseStrategyWorkerCount`) budgets 75% of system RAM for one full
dataset copy per worker, so a large universe + many workers cannot silently
exhaust the host.

## Wire contract

`FinderUniverseCandidate` is scalar-only. `toScalarCandidate(...)` and
`assertCandidateIsScalar(...)` reject `data`, `signals`, `trades`, and
`equityCurve` before streaming and on the terminal status snapshot.

| Event | Purpose |
| --- | --- |
| `start` | Echoes the `runId`, declares symbol/candidate counts, ordered strategy keys + count. |
| `progress` | Updates bounded progress, status, phase (`loading`/`evaluating`/`oos`), and current strategy index/count. |
| `candidate` | Streams a scalar survivor (merged job-level survivors, deduped by identity). |
| `symbol_failed` | Reports one dataset failure. |
| `done` | Authoritative final slice, combined diagnostics, totals (incl. `oosRemoved`), and the matching `runId`. |
| `fatal` | Terminates the run with an error and the matching `runId`. |

The terminal `done.candidates` slice is authoritative. `/status` in-progress
snapshots are summary-only by default. Scoped reattach requests can opt into
the bounded Universe `previewResults` with `includePreview=1`; unscoped
requests cannot retrieve a preview. It uses the existing snapshot compactor
and carries no candles, trades or signals. Terminal responses omit the preview;
the terminal snapshot is the one place that carries the final candidate slice.

Copied diagnostics report job-cache requests, hits, misses, unique bars,
candidate plans versus symbol evaluations, and actual Rust/TypeScript executor
usage. When Rust was requested but a run remains on TypeScript, diagnostics
include the deterministic eligibility reason. Same-bar exit policy is passed
to the compatible Rust service; unsupported execution settings still fall back
to TypeScript. Timing phases
are marked `overlapping` because yielding and nested
signal/backtest work must not be added together as independent wall time.

## `GET /api/finder/status?runId=...`

Returns a typed `FinderRunStatusSnapshot`: `running`, `terminal`, `phase`,
`progressPercent`, `statusText`, candidate `candidateCount` (count only while
running), loaded/failed totals, and — when terminal — the authoritative
`terminalCandidates` slice + summary + diagnostics. A mismatched `runId`
returns 404 and must never be adopted. A request without `runId` returns the
legacy ad-hoc introspection object for `curl` debugging; the browser reattach
path must pass a `runId`.

With `includePreview=1`, a matching running Universe job also returns
`previewResults`, a compact display checkpoint. Default polling and other
job kinds retain their counts-only contract. Each preview is guarded by the
active run id before rendering; late responses cannot replace a newer run.

## Data flow

The server loader reuses `createBatchDatasetLoaderCore`, preserving Batch
synthetic-pair construction, cache limits, gap filling, and data slicing. The
server evaluates IS candidates, merges survivors across strategies, runs the
OOS pass (loads complementary datasets through the same loader, sliced at the
caller), and releases datasets when the job ends. There is no Mine artifact
directory or TTL. The browser loads **no** Universe OHLCV for IS or OOS.

The IS data window is applied once per dataset by the handler's
`loadDatasetWithSlice` wrapper (and, in the parallel sweep, once per dataset
inside each worker's cache): `sliceFinderDataWindow(data, dataSlice,
dateRange)`. The `date_range` mode filters bars to the inclusive UTC range
`dataRangeFrom`/`dataRangeTo`; its OOS complement (`date_range_after`,
resolved by `resolveUniverseOosSlice`) is every bar strictly AFTER the `To`
date, sliced in the OOS loader wrapper with the same range. Range bounds
arrive as `options.dataRangeFrom`/`options.dataRangeTo` and flow to workers
inside the task's `options` object — never as functions.

For offline-first leg and target loads, the server wrapper reads synced IBKR
and crypto CSVs directly with bounded mtime-aware parsed-file caches. Missing
crypto files retain the existing `DataFetcher` fallback path. A present crypto
CSV is also accepted when its history is naturally shorter than the generic
deep-history threshold, avoiding a redundant SQLite/provider retry. The
disk-first routing itself (`fetchServerHistoricalDataWithFetcher` /
`fetchServerDetachedDataWithFetcher` in
`lib/data/server-data-fetcher-factory.ts`) is shared verbatim with the Batch
server loader; each loader still retains its own `DataFetcher` identity, loader
LRUs, and invalidation policy.

Diagnostics are combined server-side by the leaf
`buildCombinedUniverseDiagnostics(...)` (the prior `FinderManager` combiners,
extracted verbatim). The OOS pass is the leaf `runUniverseOosPass(...)`
(`lib/finder/finder-universe-oos.ts`), a faithful lift of the prior
`FinderManager.applyUniverseOosValidationIfNeeded` body with all runtime
dependencies injected — it reads no browser DOM, `state`, `backtestService`,
or `dataManager`.

When local data is synchronized, the browser also calls
`POST /api/finder/invalidate-cache` so the server loader does not retain stale
datasets across later Universe runs.

Server-side modules imported by `vite.config.ts` must not import browser-bound
managers or anything that transitively imports `lightweight-charts`. The
server plugin itself reaches only leaf and server-side modules — engine
runners, worker pools, loaders, stream types, the run-log sink — never a
browser-bound manager (check the plugin's import block for the current set).

## Stop-before-ownership race

`POST /api/finder/stop` with a `runId` that has not yet acquired ownership is
recorded in a module-scope `pendingStopRunId` (single slot — not an
unbounded set). The matching run request consumes the marker and finishes
cancelled instead of starting heavy work. A newer run with a different
`runId` is unaffected.

## Validation

- `npm run typecheck`
- `npm run typecheck:tests`
- `..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-server-loader-parity.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-metrics.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-oos.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-oos.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-metadata.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-archive.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-batch-parallel.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-parallel.spec.ts`

Manual smoke: run one and multiple strategies over 50 symbols, then 400
symbols with the larger heap. Confirm progress scaling, server-side OOS
filtering, Stop (scoped by run id), diagnostics merging, reload reattach
during IS and OOS phases, and Apply. For batch mode, enable the toggle, enter
a small range such as 2–4 with at least two symbols, and verify one file per
N under `archive/asset opportunity/`, append-on-repeat, empty-result blocks,
Stop partial completion, and reload reattach mid-sweep. For the parallel
sweep, also compare a full run against a `FINDER_ASSET_BATCH_WORKERS=1`
baseline — the per-N archive blocks must be identical for the same inputs,
and Task Manager should show >100% CPU on the dev-server process during the
sweep. A real-worker smoke script lives at
`artifacts/smoke-batch-parallel-worker.ts` (run with esno; it sweeps the
local IBKR data through three real workers). For the Symbol Universe
parallel sweep, compare a full multi-strategy run against
`FINDER_UNIVERSE_WORKERS=1` — the terminal candidate inventory must be
identical for the same inputs (the spec locks this parity in-process), the
combined diagnostics' `jobDatasetCache` counts should reflect one dataset
copy per worker, and wall-clock time should drop roughly by the worker
count.
