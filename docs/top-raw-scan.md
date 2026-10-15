# Fast TOP_RAW asset scans

Fast TOP_RAW in Batch Backtest estimates current NOW-arm scores of individual
local IBKR stocks, then fully scores leading candidates. The **Ranking arm**
select chooses the quantity leaders are ranked by — raw open-position votes by
default, or mean/max-active/open-profit arms. Enable **Fast TOP_RAW (asset
list)** beside Pairs. The same textarea becomes
Assets; use the maintained Nasdaq/S&P500 templates or enter one marked stock
per line, such as `AAPL•`. The entered list defines the universe. Templates are
not refreshed or substituted during a scan.

Synthetic ratios are evaluated internally. The textarea stays a raw asset list.
Unmarked symbols, crypto/provider mixtures and synthetic `AAPL•+MSFT•` rows are
rejected with row numbers. Existing identity helpers normalize case/whitespace;
the local catalog resolves dot/hyphen aliases. Duplicates/aliases are counted.

## Controls and budgets

Defaults are 64 sampled opponents per asset, 20 finalists and seed 1. Accepted
ranges are opponents 1..256, finalists 1..100 and an unsigned 32-bit seed,
including zero. Effective values clamp to N−1 opponents and N finalists after
preflight. The preview shows the requested-list budget before execution;
preflight verifies the canonical universe and excludes assets that cannot
support the shared evaluation candle before sampling.

For N eligible stocks and effective degree k, discovery evaluates
`min(N(N−1)/2, ceil(Nk/2))` relationships. The refinement upper bound is
`K(N−K) + K(K−1)/2` before subtracting reused discovery relationships. The total
unique work is capped at 1,000,000; excessive requests are rejected rather than
truncated. Input is bounded to 5,000 physical lines and 256 KiB before identity
normalization. Workers share TOP_MEAN's auto core/RAM policy and 32-worker cap.
An explicit worker count retains the existing memory-ceiling override.

Fast mode hides ordinary Batch execution, the balanced generator and historical
replay controls. Replay mode, horizons, replay dates, cap tilt, cooldown, archives
and smoke-pair limits do not enter scan requests. Switching modes preserves the
textarea and ordinary control values. Mode, list, templates and scan options
are locked while a scan or reattach owns the UI. Stop waits for worker teardown
and terminal persistence; disposing/reloading the client detaches from
server-owned work.
Stop during lazy strategy loading cancels that attempt before submission. Stop
during admission retains its scoped run id and uses the server tombstone; a
later deliberate Run starts with a fresh cancellation state.

## What the scores mean

At one frozen closed target candle E, every still-active long position in an
oriented BASE/QUOTE ratio contributes +1 to BASE and −1 to QUOTE. Shorts reverse
the signs. Flat relationships contribute zero. Multiple open positions are
summed, including offsetting positions. The ordinary engine's forced
`end_of_data` closes represent positions active at the evaluation boundary;
genuine strategy/risk exits do not contribute.

## Ranking arms

The **Ranking arm** select chooses which Batch NOW quantity ranks discovery
estimates, finalist selection and the verified winners. The profit-now arms
reproduce the OPEN_SCORE causal semantics exactly
(`open-score-replay/artifact-scan.ts`): walking a pair's trade ledger
chronologically (exits at a timestamp count before entries at that timestamp),
a trade's vote applies only when every PnL is known and the pair's realized net
PnL from trades closed **before that entry** was strictly positive. The
confidence weight of that closed history is
`n/(n+1) × realizedNet / Σ|pnl|`, clamped to `[0,1]` — zero without closed
history. Only positions still open at the frozen candle E contribute.

| Arm | Asset value | Positive pool |
| --- | --- | --- |
| `top_raw` (default) | Signed sum of open endpoint votes | raw > 0 |
| `top_mean` | Raw divided by pairs with a nonzero vote | raw > 0 |
| `max_active` | Count of pairs with a nonzero vote | raw > 0 |
| `top_raw_profit_now` | Signed gated open votes | gated score > 0 |
| `top_mean_profit_now` | Gated score divided by pairs with a nonzero gated vote | gated score > 0 |
| `top_raw_profit_now_conf` | Confidence-weighted gated open votes | weighted score > 0 |

The positivity pools mirror the Batch NOW selectors: the vote arms qualify on
positive raw while ranking by their own quantity, so a top `max_active` asset
always also carries a positive raw score. The selected `arm` is part of the
request hash and data fingerprint, so Resume accepts only the original arm.
Votes persist additive per-pair `profitNow`/`profitNowConf` values; the
profit-now arms reject shards that lack them, and a changed arm is a new run.
Discovery estimates extrapolate the sampled sums to N−1 opponents; the mean
arms divide the extrapolated sums, which reduces to the sampled ratio. Exact
finalist values sum every opponent.

The scan executes the ordinary full-history `executeBacktest` path with the
selected strategy, parameters, capital, execution model, exits and sizing.
It omits replay, analytics, equity output and retained trade histories across
pairs. It retains only endpoint votes and diagnostics. `next_open` uses the
same execution-aware bridge as ordinary Batch; E remains the last **closed**
candle, rather than the bridge's timestamp. Rust preference uses the ordinary
capability selection and TypeScript fallback. The worker bundle and initial
Rust version/protocol/capabilities identify the execution implementation;
an incompatible change invalidates resumed work.

Local catalog and required CSV checks identify unavailable assets. Preflight
counts, per normalized closed target time, how many assets contain it with 200
closed bars of history, then chooses the newest candle with the widest support:
the latest common E when every usable asset shares one, otherwise the candle
supported by the most usable assets. Assets that cannot support the chosen E
are excluded with a recorded reason and the scan proceeds with the remaining
universe — price-data problems never reject an entire run. The result exposes
E, cutoff, individual leg endpoints and exclusions. **E can be older than the
latest market candle when the list contains stale sources.** Fewer than two
eligible assets fails with the sync report described below; the scan does not
carry stale positions forward or silently change E. Every reconstructed pair
must actually contain E and sufficient configured history. IBKR 4h ratios use
aligned 30m ratios followed by aggregation, through the ordinary synthetic
loader.

### Data problems and the sync report

Every distinct requested asset stays in the textarea. A missing catalog entry or
source file, a short history, or a history that cannot support the chosen
endpoint excludes that asset with a reason; preflight never substitutes assets
the user did not enter. The scan proceeds whenever at least two eligible assets
share the chosen candle.

Only a run left with fewer than two eligible assets fails before pair execution
and produces a versioned `top_raw_scan.preflight.v1` sync report. It lists
symbols needing attention, their available closed-bar count, first/last dates
and the reason. **Copy sync report** and **Download sync report** export
these diagnostics without presenting them as a score result. The report is
persisted in the failed run's reservation and is available through status/reattach.
Editing the list or selecting another template clears the old report.

For intraday scans, the comparison date uses the most represented closed-bar
phase on the latest observed day, avoiding a few extended-hours candles as the
reference for regular-session stocks. This date is for diagnosing freshness,
not an accepted scoring snapshot. The actual scan requires a shared E with at
least 200 closed target bars in every scanned asset; assets lacking it are
excluded. No missing candle is filled forward and no missing relationship is
counted as flat.

Preflight builds an ephemeral self ratio through the ordinary synthetic loader,
so its source interval, aggregation and history limits match pair execution.
CSV revision checks include the actual finer seed and target fallback, including
files that were absent when preflight began. A new fallback file invalidates
the frozen implementation/data snapshot rather than changing its data producer.

For a 4h scan, review/sync **30m** source history in **IBKR Data**; 4h ratios are
rebuilt from those seeds. Sync stale existing histories, and use Download with a
longer period for short or absent history. Check provider availability when
history remains short. Preserve the full asset list and press **Run TOP_RAW Scan**
again after syncing to capture a fresh cutoff. No network download starts from
this report. See [IBKR data sync](alpaca-ibkr-sync.md#download-and-sync).


Discovery reports `sampledRaw` and
`estimatedRaw = (N−1) × sampledRaw / successfully evaluated sampled opponents`.
The denominator includes flat relationships. Active-position counts are separate
diagnostics. An unexpected pair failure makes coverage incomplete and withholds
a completed ranking. Partial rows remain available for diagnosis.

The **Estimated leaders** and **Fully scored candidates** tables are separate,
with 100 rows per page. Discovery estimates stay frozen during refinement.
Each finalist is evaluated against every other eligible stock, reusing sampled
votes and counting finalist-finalist relationships once. Only complete
N−1-opponent coverage earns **Exact score in eligible universe**. Candidate rank
is discovery selection order; best verified positive candidates and tied sets
are reported separately. Cutoff ties include candidates omitted by the finalist
limit. If no fully evaluated candidate is positive, the result says so without
claiming that unsampled candidates are nonpositive.

The primary approximate claim is **Highest score among fully evaluated
candidates; global ranking estimated**. Exhaustive discovery skips redundant
refinement and makes every row/global ranking exact. Fully evaluating every
asset during refinement also establishes a global exact ranking. A sampled gap
or agreement across seeds cannot certify an unexamined global winner. These
scores describe configured strategy positions, with no prediction or selection
performance claim.

## Reproducible population and sampling

`top_raw_scan_orientation_v1` sorts canonical eligible symbols and applies a
seeded permutation. For positions a,b and `d=(b−a+N)%N`, a is BASE when d<N/2,
b is BASE when d>N/2, and the smaller position is BASE for an even-N antipodal
tie. Direction is independent of discovery degree, finalists and scheduling.
Inverse ratios can produce different strategy decisions.

`top_raw_scan_round_robin_v1` reuses the legacy generator's bounded undirected
circle/Walecki construction with a separate permutation. It emits unique
non-self relationships with degree spread at most one, including odd N/k=1.
`top_raw_scan_ties_v1` supplies a separate seeded tie order. Domain seeds use
FNV-1a32(domain) XOR request seed, versioned as
`fnv1a32_domain_xor_seed_v1`. Legacy balanced-generator output/provenance stays
unchanged. Benchmarks must use the scan's identical orientation and snapshot;
scores from differently oriented legacy lists are not interchangeable.

## Server, persistence and recovery

The authenticated local routes are
`/api/batch-backtest/top-raw-scan/{run,stop,status,result}`. Run/Stop use POST;
status/result use GET with a required safe runId. Unknown request fields,
including explicitly supplied historical replay options, fail validation.
Shared Batch/TOP_MEAN/Finder-sweep ownership is reserved before asynchronous
preflight. Stop is scoped to its runId; a preownership Stop tombstone prevents
a delayed Run from starting. A matching generic Batch Stop also routes to the
scan without releasing ownership before workers finish.

Phases are preflight, discovery, refinement, completed, interrupted and failed.
Run streams bounded NDJSON status events; status supports reload/stream-loss
reattach. All N scalar rows can be exported. Result downloads expose only an
authoritative terminal manifest, so a staged result write cannot announce
completion ahead of its terminal checkpoint.
Both streamed and polled terminal phases become visible only after worker
teardown, pending writes and terminal persistence settle and the shared server
owner token is released. The next scan or ordinary Batch operation can be
admitted immediately at that boundary, including after reopening a completed scan.
Saved-status reads recheck live ownership after disk I/O. Restart classification
is read-only, so an older status read cannot overwrite a newly resumed checkpoint.

`artifacts/top-raw-scan/<runId>/` holds a preflight reservation, the frozen
`top_raw_scan.manifest.v1`, atomic 32-pair vote shards and a
`top_raw_scan.result.v1` result. Shards contain oriented-key votes, engine used,
errors and the configuration/data fingerprint, without candles or trade arrays.
Atomic shard publication is the reuse boundary; phase checkpoints index shards,
and recovery can discover complete shards published before a crash checkpoint.
On explicit Resume, successful records remain cached and failed relationships
are retried in the same deterministic shard slots. A recovered shard is merged
and atomically replaced; an interrupted/failed write leaves either the previous
complete shard or the recovered complete shard available for the next Resume.
A listed shard that disappeared or malformed data fails recovery. The run's
memory scales with emitted discovery/refinement keys and scalar summaries,
never a full uncapped N×N matrix. Persistent workers retain the loader's bounded
leg/parsed-seed LRUs and use ephemeral synthetic pairs.

Resume uses the saved request, universe, E, source stat revisions, worker
implementation/Rust capabilities and algorithm contracts. Changed inputs or
sources fail explicitly. Source metadata (size, mtime and ctime) is checked
around shard execution and again before final publication. A preflight crash
can restart preflight with its saved cutoff; once frozen, it resumes that exact
manifest. Completed results can be reopened without re-executing pairs. There
is no cross-candle incremental strategy-state update.
Restore limits follow the shared 5,000-asset bound and up to three tracked source
files per asset plus the catalog, including daily scans with 15,001 source entries.

Failed pair votes are summarized in the optional versioned
`failureDiagnostics` (`top_raw_scan.failures.v1`) result field. It groups counts
by reason, with at most eight reasons, three pair-key examples per reason,
320 characters per reason and 160 per example. `otherCount` counts failures
outside those bounded groups; totals count evaluated unique failed pairs.
Fresh and cached failures contribute to status, saved results, reload, display
and Copy/Download. Older v1 results remain readable without this additive field.
Endpoint/source failures may require syncing histories and starting a new Run;
Resume retains E and refuses changed source revisions. Failed coverage continues
to withhold a completed ranking.

Browser keys use the versioned `playground_top_raw_scan_{preferences,active,
request,result}` persisted-JSON contracts. Absent/invalid older preferences
restore mode off and validated defaults; results are normalized defensively.
Starting a different run clears the prior saved result, including when the new
run fails before producing scores, so reload/export cannot present an older ranking.
Legacy TOP_MEAN schemas/keys are untouched. Server artifacts are local durable
scan checkpoints; remove obsolete run directories explicitly when no scan owns
them. They currently have no automatic retention sweep.

## Validation and measurements

`top-raw-scan-{sampling,preflight,execution,engine,routes}.spec.ts` and
`top-raw-scan-controller.browser.spec.ts` cover input/template limits,
orientation/symmetric inclusion, 5,000-asset bounded planning, flat denominators,
exhaustive finalist parity, per-arm sums/estimates/positivity, profit-parity of
the endpoint profit vote, profit-arm shard enforcement and selector persistence,
failures, phase Stop/resume, source/persistence failures, authenticated routes
and browser persistence/disposal. Execution
fixtures compare ordinary backtests for long/short/both/combined directions,
three execution models, overlapping positions, exits and exit overrides.
The E2E helper uses deterministic transport to exercise real controls, Nasdaq,
raw-list submission, Stop and an actual page reload. Real worker/data execution
is measured separately.

Run the offline benchmark after tests/sync have stopped changing data:

```powershell
rtk proxy npm.cmd exec -- esno scripts/bench-top-raw-scan.ts --size 500 --workers 4 --large --out artifacts/top-raw-scan-bench/sp500
```

The default matrix uses two strategies, two endpoints and seeds 1/7/29. It
evaluates both ratio directions to provide a valid exhaustive reference for
each seed's orientation, reports top-1/5/20 recall, winner inclusion, score
gaps, ties and coverage, and asserts every exact finalist against independent
exhaustive aggregation. Reference wall times distinguish the two orientation
passes. Scheduler-only 3,000/5,000-asset fixtures do not imply real execution
throughput. `--large` additionally runs 3,000/5,000-asset local-catalog fixtures
when enough 30m seeds are available. Fixture selection counts actual closed 4h
endpoints with at least 200 bars and prefers recent histories sharing one.
If the archive supports fewer than 3,000 (but at least 500), a supplemental run
measures that maximum feasible size under its actual asset count. Production
preflight independently verifies the explicit selected list. These fixtures are
separate from maintained template membership. `--large-only --size 8` skips the exhaustive
matrix while retaining a small scan, large fixtures, scheduling and Stop checks.
The benchmark defaults to four workers. The report also records engine mix, artifact bytes, sampled RSS and Stop
latency. RSS is sampled every 100 ms, rather than an operating-system peak.
Fast wall time includes final writes/worker teardown; coordinator `totalMs`
ends before terminal publication. A revision change aborts rather than publishing mixed-data evidence.

### Delivery measurements, 2026-10-15

These initial delivery measurements allowed preflight exclusions. The subsequent
Nasdaq fix below enforces the user's full-universe requirement: unavailable
stocks now stop a fresh run with a sync report instead of being omitted.

Hardware was an Intel i7-14700K (28 logical processors), 63.72 GiB RAM and
Node v22.16.0 on Windows. The final measurements used four workers, below-normal
process priority and affinity to eight logical processors after the user reported
high CPU use. A one-second sample during execution was about 22% of total CPU
capacity. No tests or data sync ran concurrently. Filesystem/build caches were
warm; these are local fixture measurements, not cold-start or throughput promises.

The S&P500 fixture requested the first 500 maintained template rows; 498 were
eligible. FDXF and HONA lacked 200 closed target bars. Strategy was
`dema_confirmation`, lookback 20, 4h, both directions, `next_open`, signal exits
enabled and max one open trade; capital was 10,000, fixed trade amount 1,000,
position size 100, commission 0.1, slippage zero, TypeScript preference. Full
configuration and source revisions are saved in
`artifacts/top-raw-scan-bench/sp500-low-cpu/report.json`.

| Fast scan, seed 1 | Measured |
| --- | ---: |
| Common E | 2026-08-04 16:00 UTC |
| Preflight / discovery / refinement | 0.63 / 28.52 / 10.38 s |
| Wall time including terminal writes/teardown | 39.77 s |
| Discovery / new refinement evaluations | 15,936 / 8,485 |
| Reused refinement relationships | 1,265 |
| Successful / failed evaluations | 24,421 / 0 |
| Sampled process RSS peak | 5.98 GiB |
| Manifest + result + vote shard bytes | 2,285,645 |
| Stop to interrupted terminal, including teardown | 68.95 ms |

One exhaustive orientation of the same strategy/population/E took 146.72 s for
123,753 relationships; its reverse pass took 144.38 s. Fast wall time was about
3.69 times shorter than the first pass, with 5.07 times fewer evaluations.
The reference timing excludes preflight and artifact writes, which are included
in fast wall time. The two reference directions support different seeds and must
not be added together to inflate the runtime comparison. Peak sampled RSS across
the entire matrix was 6.25 GiB. A final-code fast rerun matched all 498 discovery
rows and all 20 finalist scores from the earlier implementation snapshot.

Both strategies used lookback 20 and the same settings. Each strategy/endpoint
case executed 247,506 reference evaluations (both directions), with zero failures.
All 12 seed comparisons had exact finalist parity, included an exhaustive winner
among finalists and had final score gap zero. Discovery recall below uses strict
seeded top-k sets, including deterministic tie breaking; it is not tie-adjusted.
E1 is August 4 at 16:00 UTC; E2 is July 2 at 16:00 UTC, both in 2026.

| Strategy | E | Seed | Top-1 recall | Top-5 | Top-20 | Winner ties | Cutoff ties / omitted |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DEMA | E1 | 1 | 0% | 60% | 75% | 2 | 8 / 7 |
| DEMA | E1 | 7 | 0% | 60% | 80% | 1 | 5 / 2 |
| DEMA | E1 | 29 | 0% | 40% | 80% | 1 | 2 / 1 |
| DEMA | E2 | 1 | 100% | 80% | 70% | 1 | 8 / 5 |
| DEMA | E2 | 7 | 100% | 60% | 80% | 1 | 3 / 0 |
| DEMA | E2 | 29 | 0% | 60% | 80% | 1 | 0 / 0 |
| Rolling Median | E1 | 1 | 100% | 60% | 80% | 1 | 5 / 0 |
| Rolling Median | E1 | 7 | 0% | 40% | 85% | 1 | 4 / 0 |
| Rolling Median | E1 | 29 | 0% | 100% | 80% | 1 | 7 / 4 |
| Rolling Median | E2 | 1 | 0% | 40% | 80% | 1 | 7 / 5 |
| Rolling Median | E2 | 7 | 0% | 80% | 80% | 1 | 6 / 0 |
| Rolling Median | E2 | 29 | 100% | 60% | 70% | 1 | 9 / 5 |

The real eight-asset smoke run completed all 28 relationships in exact global
mode; independent exhaustive comparison agreed. Defaults remain k=64/K=20:
refinement recovered the winner in these fixtures, while discovery missed the
strict top-1 in eight of twelve comparisons and top-20 recall ranged 70–85%.
These observations do not establish a universal recall guarantee; the hidden
winner unit fixture demonstrates that sampled finalist selection can miss one.

Scheduler-only fixtures in the final S&P report emitted 96,000 discovery plus
58,515 new refinement relationships for 3,000 virtual assets in 99.59 ms;
5,000 emitted 160,000 plus 98,515 in 172.89 ms. These are planning costs, not
strategy execution times. The catalog coverage check found 3,545 marked source
candidates, with at most 2,978 sharing a target endpoint with at least 200 closed
bars. Thus neither a real 3,000- nor 5,000-asset execution was available in this
snapshot. The supplemental execution attempt is recorded separately below.

The supplemental **2,978-asset execution attempt** selected the maximal common
leg endpoint, 2026-09-21 16:00 UTC, with no preflight exclusions. It completed
95,296 discovery evaluations: 89,846 succeeded in TypeScript and 5,450 failed
the reconstructed pair's frozen-endpoint check. Common leg timestamps alone did
not ensure that sparse aligned ratios contained E. The scan correctly ended
`failed/incomplete_coverage`, skipped refinement, produced no finalist ranking
and kept `globalRankingExact=false`. Missing relationships were not flat votes.
This is resource/failure evidence, not a successful large-list throughput result.
Wall time was 146.31 s (2.58 s preflight, 143.27 s discovery), sampled RSS peaked
at 3.49 GiB and terminal artifacts totaled 10,449,764 bytes. Full provenance is
in `artifacts/top-raw-scan-bench/catalog-large-low-cpu/report.json` and its linked
run directory. The production scan of that delivery kept this failure rule
rather than silently shrinking an entered universe or changing its endpoint.

Earlier benchmark attempts that used an invalid strategy key or a historical
endpoint from only one leg are excluded from these claims. The shipped benchmark
validates strategy keys before execution, intersects all reference endpoints and
aborts on any failed reference rather than reporting misleading recall/parity.

### Delivery validation

`rtk proxy npm.cmd run validate:changes -- --run` passed on the initial delivery source:
`npm run ci` completed in 109.86 s, including dependency checks, application
and test typechecks, all 293 spec files (zero failures/skips) and build budgets;
browser E2E completed in 33.08 s, including template/raw input, Run, scoped Stop
and actual reload reattach. The run used two test jobs, below-normal priority
and eight-processor affinity. Entry/startup JavaScript remained within budgets
(572.0/650 KiB and 750.8/850 KiB raw). Logs are preserved under
`artifacts/validation-logs/latest/`. Relative documentation links and Git
whitespace checks passed. No shared simulator or Rust source changed.

### Nasdaq 4h sync-report follow-up

The reported 2,819-row Nasdaq failure was reproduced using the actual template
and local data. Of those stocks, 2,816 had 200 closed 4h bars, but their histories
had no common valid endpoint. Against the prevalent phase on the latest observed
day, 2026-10-14 16:00 UTC, 2,332 histories needed review/sync. CATL had only 2 closed
4h bars, GIXI 5 and MTAK 7; those need longer available source history, not just
a more recent last candle. The full list was preserved and no pair evaluation
or score ranking was produced.

The local reproduction saved the full versioned report to
`artifacts/top-raw-scan-bench/nasdaq-4h-sync-report.json` and the bare ticker list
to `artifacts/top-raw-scan-bench/nasdaq-4h-symbols-to-sync.txt`. These are observed
local-data diagnostics, not a claim that every provider can supply the absent
history. Review the report, sync/check 30m data in IBKR Data, and run the unchanged
full template again. That delivery offered no reduced-universe retry.

Regression coverage includes disjoint histories, missing assets while the rest
overlap, fewer than 200 closed bars at E, interrupted sync
diagnostics, persisted failure details, fallback-source creation, escaped browser
report content, exports and retention of the complete input in real browser E2E.

Follow-up validation passed with two test jobs, below-normal priority and
eight-processor affinity: `validate:changes -- --run` completed full JS checks
in 88.36 s (both typechecks, all 294 spec files and build budgets), followed by
browser E2E in 30.03 s. Entry/startup JavaScript remained within the same budgets.
No shared simulator or Rust source changed.

### Reduced-universe follow-up, 2026-10-15

The same 2,819-row Nasdaq template no longer rejects the run. Preflight now
counts, per closed 4h candle, how many usable assets hold it with 200 bars of
history, picks the newest candle with the widest support and excludes the
histories that cannot support it, so the scan ranks the assets that share one.
Excluded tickers keep their reasons in the result's exclusions and provenance;
the entered list stays unchanged. The sync report and its failure path remain
only for lists left with fewer than two eligible assets. The two sections above
record that earlier behavior. Regression coverage now asserts a stale-history
exclusion that completes on nine assets, a missing stock excluded while the
rest completes, a one-supporting-asset sync-report failure and Stop during
both the selection pass and report preparation.

### F1–F5 audit repair validation

The 2026-10-15 audit findings are covered by desired-behavior regressions in
the controller, engine and route specs: delayed-loader/admission Stop; daily
3,334/5,000-asset and 4h restore boundaries; discovery/refinement retry with
successful-edge reuse and atomic interrupted writes; deferred teardown/terminal
persistence and concurrent status restoration; bounded failure display/export
and older saved-result normalization. Browser E2E exercises startup Stop and
immediate subsequent Run alongside the existing reload/full-list diagnostics.

Final `rtk proxy npm.cmd run validate:changes -- --run` passed: full JS checks
in 87.33 s (both typechecks, 294 spec files, zero failures/skips and build budgets)
and browser E2E in 29.53 s. Tests used two jobs, below-normal priority and
eight-processor affinity. Logs are in `artifacts/validation-logs/latest/`;
the earlier successful repair run is preserved in
`artifacts/top-raw-scan-audit/repair-first-validation/`. Documentation targets
and tracked/untracked task-file whitespace checks passed. No real large-universe
performance rerun, source-data sync or Rust changes were required for this repair.
