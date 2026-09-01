# Trade Gate (Batch certification)

Trade Gate applies one or more validated local ledger rules to new entry
signals during a Batch server run. It is a certification run: the normal
TypeScript engine owns ordering, position state, fills, exits, fees, slippage,
and resulting P&L. A rejected signal opens nothing and does not consume a
position slot. A signal is admitted when **any** selected rule returns `true`
(OR semantics). Selecting overlapping rules can increase admissions; it is not
diversification.

## Certification workflow

1. Run a replay-eligible Batch export with **Save trade ledger** enabled.
2. Run Ledger Sweep over that folder. Treat only `EDGE-CANDIDATE` results from
   the folder's latest completed sweep as selectable rules.
3. In the Batch tab, enable **Apply Trade Gate**, select the folder first, then
   select one or more EDGE rules. The UI shows the rule's kept percentage and
   IS/holdout deltas, plus an approximate rejection percentage from the sweep.
4. Run the Batch certification from the server. Compare the engine-actual
   trade count, expectancy, P&L, and gate counters with the checker replay.
5. Keep the holdout sealed after this read; use a shadow-forward run before
   exposing capital.

### Certification surface identity

The EDGE lists belong to separate sweep surfaces and must not be merged:

| Surface | Sweep | EDGE list recorded for the comparison |
| --- | --- | --- |
| F3 | `2026-08-30_0940` | `q20`, `q94`, `q98`, `q114`, `q130`, `q178`, `q188` |
| F2 | `2026-08-29_1936` | `q77`, `q108`, `q107`, `q156`, `q90`, `q8`, `q126`, `q109` |

`q8` is EDGE on both surfaces. That cross-surface replication is why q8 was
the certification rule; it is not a mismatch between the F2 and F3 lists.

The selected rule source is loaded only from
`archive/mining-ledger/rules/<ruleId>.ts`. The server re-discovers the folder
and latest sweep at run time, verifies the source SHA-256 against the sweep,
rejects source containing `feat_rank`, and records folder, sweep, rule names,
and hashes in the terminal run provenance. Rule exceptions are fatal.

## Feature parity

`lib/batch-backtest/trade-ledger-features.ts` is the single feature leaf used
by both `trade-ledger-exporter.ts` and the server gate. It computes the causal
bar-local fields (range position, ATR14 percentage, return20, gap percentage,
UTC day/hour), per-pair prior-trade fields, and the cross-pair
`feat_candidatesAtTime` count. The gate's server pre-pass runs the strategy
without a gate to collect the same entry rows and same-timestamp universe
before the real gated pass. Gate rows contain no outcome fields and do not
support `feat_rank`.

The exporter golden fixture remains the parity oracle. The gate regression
spec also checks that the shared values are unchanged and that
`candidatesAtTime` is available to a predicate.

## Counters and limits

Each gated pair reports `signalsEvaluated`, `admitted`, `rejectedByGate`, and
`blocked`; Batch totals expose the same counters in the result summary and
terminal stream/status. `blocked` means a rule admitted the signal but normal
engine state (capacity, cooldown, opposite-position policy, or sizing) still
prevented an open.

Trade Gate v1 is server-side only because `candidatesAtTime` needs the
universe pre-pass. The in-tab path refuses a gate request. The request omits
the gate field entirely when disabled, preserving the ordinary Batch path.
Rules are trusted repository TypeScript, not uploads or a sandbox. `feat_rank`
is intentionally unsupported because it is alphabetical/noise. Multi-rule
selection is OR, not a portfolio allocation or diversification feature.

For large server batches, use the existing heap guidance, for example:

```powershell
$env:NODE_OPTIONS="--max-old-space-size=16384"
npm run dev
```

### Measured gate overhead

On the F2 workload, the normal Batch run measured **13,933 ms** and the q8
gated run measured **30,572 ms** (approximately **2.2x**). The additional cost
is the causal feature pre-pass used to reproduce the cross-pair
`candidatesAtTime` context. Optimization is deliberately deferred: parity and
certification correctness come first.

### TypeScript batch safety and timing

The Trade Gate pre-pass intentionally uses the TypeScript engine, even when
the requested main run prefers Rust, because the pre-pass must produce the
same ledger features that the gate consumes. The TypeScript simulator now
checks cancellation during bar and signal processing, and its compact
end-of-data position-drain loop has a bound derived from the candle and signal
counts in `lib/strategies/backtest/backtest-engine.ts`. If a position fails to
drain, the run fails loudly instead of spinning forever. Rust did not hang
because it uses a separate simulator implementation and never enters this
TypeScript forced-close loop. Per-pair timing is logged for both the pre-pass and main pass; a pair
over 10x the running average is warned. Stop is cooperative and is checked
inside the synchronous simulator, so the server can observe it as soon as a
bar-level checkpoint is reached.

### F3 q114 certification record

The gated F3 run was re-run through the production resolver and runner against
`2026-08-30_0940_batch-mtf7c0sj-armf8vch`, selecting
`q114-orderly_decline_no_gap` from the latest completed sweep. It completed
2,000/2,000 pairs with 0 failures and 0 cancellations. The q114 source
SHA-256 was `486153522481eb6b88537123f8dfbbaa28b581e34a0802c01f98a9dc287d7a77`.

| Measure | Value |
| --- | ---: |
| Sweep kept | 111,891 (`2.0672595135%`) |
| Sweep IS mean / median P&L delta | `+1.7605661017 pp` / `+0.1693454525 pp` |
| Sweep holdout mean / median P&L delta | `+0.1393694737 pp` / `+0.1103947727 pp` |
| Engine gate evaluated / admitted / blocked | 5,414,069 / 339,205 / 227,190 |
| Engine actual opened trades | 112,015 |
| Engine aggregate net profit | `$715,924.9315733875` |
| Engine aggregate expectancy | `$6.39133090723017` per trade |

The sweep's kept count is its replay statistic; the engine-actual opened count
is `admitted - blocked`, so the two counts are reported separately. The
completed-run pair timing was pre-pass **35,653 ms** total (**17.8265 ms/pair**,
maximum **75 ms**) and main pass **48,927 ms** total (**24.4635 ms/pair**,
maximum **334 ms**); three main-pass pairs exceeded the 10x warning threshold.

## Evidence status

The automated gate suite proves engine OR/state/error behavior, shared-feature
parity, `candidatesAtTime`, gate-off JSON identity, and wire omission when off.

## F2 q8 certification record

This was re-run through the real resolver against
`2026-08-29_1936_batch-mted6ti8-ooajqsxc`, without adding a `complete: true`
overlay. The catalog accepted its legacy `terminalPhase: "done"` summary,
reported the folder runnable, and exposed all eight EDGE-CANDIDATE rules from
`20260830_140000_phase5-f2-load-once`.

| Metric | Certified value |
| --- | ---: |
| Rule | `q8-crowded_drawdown_reversal` |
| Rule source SHA-256 | `8dd39a247a4cbf57f9da6b2162e63ade6746394073103738ee84f2ccdb066d6a` |
| Candidates evaluated | 116,930 |
| Replay / engine-opened trades | 17,470 / 17,470 |
| Replay admitted-set SHA-256 | `ef37e6b77387731c7490a34bc6f44a3bcc210ebc813a034a1f52c5c96ee528fb` |
| Replay-vs-engine expectancy delta | approximately `1e-15` |
| Engine aggregate net profit | `$52,387.74216463413` |
| Engine aggregate expectancy | `$2.9987259395898187` per trade |

The engine terminal counters were `evaluated=116,930`, `admitted=18,019`,
`rejected=98,911`, and `blocked=549`; therefore `18,019 - 549 = 17,470`
actual opens. The q8 replay expectancy table remains: IS `4,830` trades at
`+1.1051288761%` mean P&L, holdout `12,640` at `-0.0074176805%`, and overall
`17,470` at `+0.3001724666%`. The replay table is percentage P&L; the engine
aggregate expectancy above is the Batch dollar metric.
