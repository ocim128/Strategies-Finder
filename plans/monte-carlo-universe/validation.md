# Acceptance and validation

Status: **future implementation checks, not passed implementation evidence**.
[technical-design.md](technical-design.md) owns formulas and lifecycle;
[implementation.md](implementation.md) owns delivery order.

## Numerical cases

Use independent expected values. Real execution fixtures must exercise the
shared executor; do not mock the P&L helper whose behavior is being checked.
Identity-order/one-path unit cases may bypass UI simulation-count limits.

| Case | Expected result |
| --- | --- |
| All-path profitability | Profits [-10, 0, 5, 8, 12] -> 60%, regardless of trade win rates. With >48 paths, a biased display subset must not change the result. |
| Verdict edges | Exactly 90% profitable and exactly 20% P95 drawdown passes. Slightly worse fails. Rounding never decides the verdict. |
| Quantile | A known ordered sample distinguishes P95 from P97.5 using the existing interpolation rule. |
| Eligibility | With minimum 30, N=0/4/5/29 is insufficient; N=30/31 qualifies. Minimum 5 permits five. Invalid records fail preparation rather than disappear. |
| Coverage | 60 requested, 50 evaluated, 34 Pass, 16 Fail, eight insufficient, two load failures -> 68% eligible pass rate. Zero eligible -> null, not 0/100%. |
| Equal symbol weight | A 10,000-record instrument and a 30-record instrument each count once. |
| Account return | $250 net on $10,000 initial capital -> 2.5%, even with $1,000 fixed sizing. |
| Drawdown basis | Equity 100 -> 120 -> 90 -> 110 has 25% closed-trade drawdown. A different observed bar-level drawdown stays separately labeled. |
| Work cap | N=10,000/request=1,000 -> 800 paths. N=40,000 -> resource_limit because only 200 paths fit. |
| Seed | Same replay/settings reproduces results. Reordering/inserting symbols does not change existing keys. Alias equivalence preserves key/seed; provider/mode/interval changes identity. |
| Legacy units | Detail ruinProbability=ruinRate=0.25 remains 0.25 on the wire and renders 25% once. New percent fields with value 25 also render 25%. |

The following audit cases require direct MC output assertions:

1. **50/50 costs:** $1,000 gross; base 100 -> 110, quote 100 -> 105; five
   units of each. Gross long P&L $25, inverse short -$25. At 0.1% commission,
   long entry fees $1 and exit fees $1.075 give net $22.925. Five identical
   complete records at fixed $1,000 must yield $114.625 (absolute tolerance
   1e-8), not $114.51048951048506. Identical bootstrap draws give the same result.
2. **Ordinary denominator:** five ordinary/ratio records with $1,000 entry
   value and $22.925 net each have $1,001 fee-inclusive allocation at 0.1%.
   Fixed $1,000 yields approximately $114.51048951048506; fixed $1,001 yields
   $114.625. A blanket gross-denominator change must fail this test.
3. **Partial exits:** six ordinary half-close records ($500 entry value,
   $50 P&L each, fixed $1,000, no costs) retain the current chart result $600.
   Universe rejects effective partial controls before reservation, even if no
   target would be hit. Unexpected partial records cause simulation_failed,
   no metrics/verdict. Cover fixed/percent and exit overrides.
4. **Overflow:** 1,500 finite +100%-return records, $10,000 initial capital,
   100% percent sizing, zero fees. Current runtime can return Infinity, P95 zero,
   and success. Future engine must return non_finite_simulation; Universe must
   exclude that row from verdicts. Check before stats filtering/serialization,
   in normal 250+-path runs, and during saved-input replay. Add finite path
   samples that overflow naive aggregate sums/moments: stable finite arithmetic
   or explicit failure is acceptable; filtering/zero replacement is not.
5. **Replay:** serialize the allowlisted five-field backtest input, original
   trades/pair legs, sizing, seed, and effective settings. Reload and call the
   same engine without candles. Fixed/percent summary metrics match before and
   after serialization, including after external price data changes.

## Backtest and pair parity

Use deterministic candles/signals with the real executor. Cover ordinary,
ratio, and 50/50; long/short; signal-close/next-open; commissions/slippage; active
exit override; confirmation filtering; and one common inclusive date/as-of
window. Compare the MC input trades against a direct executor baseline.

Verify pair legs survive loading, slicing, closed-candle preparation, and worker
cloning. Missing legs fail explicitly. Ratio and 50/50 cache identities stay
distinct, with the established 50/50 disk-cache bypass and TypeScript fence.
Check pair notional mismatch tolerance and avoid Finder ranking transformations.

Alias cases: shorthand/explicit crypto legs, @/@50/50, reversed pairs, IBKR
single-marker inference, self-pairs, provider conflicts, malformed allocation
suffixes, unsafe tokens, and limits. Verify captured Spot/Futures/provider
context reaches the loader after unrelated UI source changes. Empty date overlap
is a counted load failure; valid zero-trade data is insufficient trades.

## Lifecycle cases

| Trigger | Required outcome |
| --- | --- |
| No chart backtest / loading strategy | Universe runs after correct selection resolves; chart retains its guard. |
| Controls/chart/tab change | Captured Universe run stays fixed; chart invalidation remains separate. |
| Run races or competing heavy workflow | One checked owner; other gets 409; no stolen locks or auto-cancellation. |
| Same run ID retried / edited payload | Identical request is idempotent; changed payload is 409. |
| Worker entry resolution | Real JS/CJS run/detail task starts; bundle/raw-TS fallback failure cleans up. |
| Callback failure | No rejection into Batch, duplicate notification, or backtest-error relabel. Fatal write/transport failure wins over generic Done/cancel flags. |
| Stop during admission/load/backtest/MC/append/final yield | No escaped job or false Complete; retain complete commits, synthesize tail, settle worker/writer before releasing owner. |
| Late message or cleanup / crash or exit zero mid-task | No newer-owner mutation; failed run reaches a terminal state and releases resources. |
| Browser disconnect/reload / brief HTTP failure | Run continues; reattach to a full snapshot; bounded backoff, no resubmission or double count. |
| Process restart | Running manifest becomes interrupted; rebuild complete journal prefix, no automatic computation resume. |
| Missing/corrupt/replaced artifacts | Useful rerun/error state; no initialization crash or silent corruption skipping. |
| Disk error / journal cap / incomplete final line | Retain committed prefix; explicit failed state; no row with missing replay input. |
| Oversized record | Small resource_limit exclusion before MC; bounded read/allocation. |
| New result replaces old / detail still active | Retain latest + active only; no active-reader deletion or cleanup outside root. |
| Rapid detail selection / detail disconnect | Stale reply cannot replace selection; one detail retained; stored run unchanged. |
| Replay algorithm/digest mismatch | Explicit rerun message, no silently changed details. |
| Unauthorized route / absent backend / shutdown | Authorization precedes work; static UI explains availability; workers/timers/writes/locks settle. |

## Browser, exports, and scale

Extend existing MC DOM tests for the two scope containers, all required IDs,
lazy-root extraction, and existing results/empty-state hierarchy. A missing ID
still fails before listeners attach.

Use a 1,000-row full snapshot with the best row at index 999. Sorting puts it
on UI page one; CSV/JSON includes all rows, not the visible 100. Test partial
labels, null values, stable ties, missing-last sort in both directions, actual
date coverage, keyboard controls, narrow layout, and CSV escaping/formula text.
Exports stay disabled until a terminal snapshot. JSON excludes replay inputs.

Build the largest valid scalar DTO, including bounded errors/keys/configuration,
and prove the full status response fits 2 MiB. Test file/record/body/token limits
and latest-result replacement without adding a paging or history subsystem.
Include disk failure during terminal-manifest replacement: the live state is
failed; startup may recover it as interrupted when the terminal write never
succeeded. No test may treat a rejected filesystem write as durable success.

Run one deterministic local mixed-universe fixture large enough to expose
retention mistakes (100 instruments, including shared-leg pairs). Record
effective path/eligible counts, wall time, memory, status/Stop response times,
and file bytes. Confirm one worker, bounded caches/prefetch, no full-universe
trade/metric arrays in browser/server memory, and release of prior details.
If measurements show unresolved growth or blocking, investigate with larger
fixtures or heap inspection. A mandatory multi-size benchmark framework and
hardware-specific latency SLA are not part of this feature.

E2E uses local deterministic data: open the real lazy tab; run ordinary + ratio
+ 50/50 inputs; inspect summary/detail; export; Stop; reload/reattach. Use
controlled progress gates instead of sleeps. Keep the existing chart long/short
next-open three-method E2E scenario.

## Test selection and evidence

Extend owning specs; add feature specs only for missing numerical, runner,
server/store, and browser behavior. Do not mirror every module with a trivial
test. Existing relevant spec families include:

- `monte-carlo` and `feature-dom-contracts.spec.ts`.
- `batch-backtest-runner.spec.ts`, `batch-backtest-server-loader-parity.spec.ts`,
  `finder-server-loader-parity.spec.ts`, `synthetic-pair-equal-weight.spec.ts`,
  `batch-synthetic-cache-identity.spec.ts`, `synthetic-leg-identity.spec.ts`.
- `batch-backtest-server-plugin.spec.ts`, `finder-server-plugin.spec.ts`,
  `local-route-authorization.spec.ts`, `server-run-poll-loop.spec.ts`,
  `settings-compat.spec.ts`, and `validation-map.spec.ts` when their contracts change.

Use RTK and inspect selection before execution. Examples:

```powershell
rtk proxy npm.cmd run validate:changes
rtk proxy npm.cmd run --silent test -- monte-carlo --list --json
rtk proxy npm.cmd run test -- monte-carlo feature-dom-contracts.spec.ts
rtk proxy npm.cmd run validate:changes -- --run
rtk proxy npm.cmd run test:e2e
rtk proxy npm.cmd run ci
```

Add focused semantic-impact checks for shared changes even if the router misses
them. CI includes dependency, application/test typechecks, broad JS, and build
checks. Preserve existing Rust workflow requirements; if shared fill/exit or
TS/Rust semantics change, run the applicable parity/Rust checks from the engine
guide. No strategy changes or manifest regeneration are planned.

Run shared-log commands sequentially. Save final-state commands, outcomes,
failure logs, and measurements in the handoff; do not repeat already successful
checks without a code change or unresolved concern. Inspect logs under
`artifacts/test-logs/latest/` and `artifacts/validation-logs/latest/`.

For this documentation-only task: verify links, existing source references,
formatting, and validation routing. Do not claim implementation checks passed.
