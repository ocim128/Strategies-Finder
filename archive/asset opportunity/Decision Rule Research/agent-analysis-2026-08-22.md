# Candidate Rule Mining from Asset Opportunity Archives — 2026-08-22

This is hypothesis generation only. None of the findings below is a deployment
or live-trading recommendation. A fresh untouched data window is the only
confirmation standard.

## Method and audit ledger

The primary judge was the existing stability analyzer with a unique active
candidate-pool control:

```powershell
& '..\..\..\node_modules\.bin\esno' scripts\analyze-asset-opportunity-stability.ts `
  --archive-dir '<run folder>' --horizon 12 --top-k 1,2,3 `
  --stride-bars 12 --control random_pool --seed 42 `
  --sample-size 10 --iterations 2000 --min-holdout 12 --max-holdout 300
```

The same command was run on the three A-cell folders (`run-2116`, `run-0506`,
`run-0816`), the three B-cell folders (`run-1105`, `run-1523`, `run-1800`),
and older probe folders `TP&SL1%/run-0653`, `TP&SL2%/run-0603`,
`300rangebars/run-1312`, `maxtrades=10/run-1420`, and
`maxtrades=10/run-1533`. A second A-cell pass added
`--friction-bps 30`. The analyzer's 12/18/24-bar horizon output was retained;
the verdicts below are for 12 bars unless stated otherwise.

Pair-summary checks used:

```powershell
& '..\..\..\node_modules\.bin\esno' scripts\analyze-asset-opportunity-pair-summaries.ts `
  --archive-dir '<run-1523-or-run-1800-folder>' --stride-bars 12 --horizon 12
```

The independent audit was run with the scratch parser left in the repository:

```powershell
py scripts\scratch-candidate-rule-mining-2026-08-22.py `
  --label A2116 'archive\asset opportunity\Decision Rule Research\output collection\uptrend-only\run-2116-21aug2026' `
  --label A0506 'archive\asset opportunity\Decision Rule Research\output collection\uptrend-only\run-0506-22aug2026' `
  --label A0816 'archive\asset opportunity\Decision Rule Research\output collection\uptrend-only\run-0816-22aug2026' `
  --stride 12 --min-holdout 12 --max-holdout 300 --horizon 12
```

The equivalent B-cell command used `B1105`, `B1523`, and `B1800` labels and
their corresponding folders.

Within each holdout file, rows from all 22 sort blocks were unioned and
deduplicated by `(symbol, strategyId, candidateFingerprint)`. Holdouts were
greedily selected at a 12-bar stride: 289 files became 25 disjoint windows.
Forward fields were used only as targets or random-pool baselines, never as
predictors. The stability statistics are window-level means, medians, and
positive-window rates; they are not independent-sample p-values. Candidate
rows sharing a symbol were not treated as independent.

Ledger definition: a stability cell is `(config, sort, K, horizon)` across 22
sorts, K=1/2/3, and horizons 12/18/24. Fourteen analyzed config variants
(11 no-friction archive folders plus three A-cell 30-bps passes) produced
`14 × 22 × 3 × 3 = 2,772` stability cells. The two pair-summary runs produced
10 IC cells and 10 increment/gate cells. Total recorded analysis ledger:
**2,792 cells**. This is a count of examined cells, not a count of successful
rules.

## Ranked candidate rules and theses

### 1. [REPRODUCED] Rising-orientation long + `profitFactor` K=1 is the strongest candidate rule

**Rule.** In the rising-orientation long A-cell, rank the visible AO pool by
`profitFactor`, take the top one, and evaluate a 12-bar forward window against
the same-window random candidate pool.

**Evidence.** With 25 disjoint windows per replicate:

| A-cell replicate | Mean delta | Median delta | Windows positive | 30-bps mean delta | 30-bps positive |
|---|---:|---:|---:|---:|---:|
| `run-2116` | +4.4419% | +3.1476% | 68.0% | +4.14% | 68.0% |
| `run-0506` | +3.5053% | +3.6091% | 72.0% | +3.21% | 72.0% |
| `run-0816` | +2.6130% | +2.1829% | 64.0% | +2.31% | 60.0% |

All six primary cells were `WEAK+` under the tool's locked rule. The visible
union pool was 121.2–130.4 unique candidates per file and 68.1–85.3 distinct
symbols per file. The A-cell top-pool fingerprint Jaccard was only 2.85% on
average across the three run pairs, so this is not a repeated-row artifact.
The 30-bps pass is a useful friction sensitivity, not a deployment test.

**Steelman objection.** The three runs may still share a market regime and the
25 windows are only 25 effective observations. The top-pool control does not
remove symbol clustering, and the positive result could be a rising-orientation
selection composition effect rather than a portable `profitFactor` mechanism.

**Kill condition.** On a pre-declared untouched chronological A-cell window,
`profitFactor` K=1 fails if its 12-bar mean is non-positive, its positive-window
rate is below 55%, or it is not `WEAK+` under the same random-pool and 30-bps
settings. Any one failed confirmation closes this thesis.

**Single-axis confirmation.** Keep 4h, long direction, rising orientation,
TP2/SL2, minTrades=10, strategy set, symbols, sort, and costs fixed; shift only
the chronological holdout/search window (for example, a new 12–300 batch after
the next data refresh). Pre-register K=1 before reading the output.

**Expected cost.** One full 12–300 A-cell batch: 289 holdout files, 22 sort
blocks, and the existing strategy/symbol universe. No code change is needed.

### 2. [REPRODUCED] The A-cell quality edge is K-robust, but breadth dilutes the signal

**Thesis.** In the same A-cell, `profitFactor` K=2 and K=3 remain positive after
30 bps, but K=1 is the cleanest expression; increasing K should be treated as
a breadth variant, not as evidence of three independent winners.

**Evidence.** At 30 bps, the mean deltas for K=2/K=3 were `+1.68%/+1.43%` in
`run-2116`, `+1.49%/+1.35%` in `run-0506`, and `+1.72%/+1.48%` in `run-0816`.
Positive-window rates were respectively `60/64%`, `60/60%`, and `56/64%`.
Every one of these six breadth cells was `WEAK+`. The 18/24-bar mean deltas
for PF K=1 were `+4.61/+5.51%`, `+3.31/+3.69%`, and `+0.85/+0.43%` across
the same three replicates: directionally positive, but not uniformly stronger
than 12 bars.

**Steelman objection.** K=2 and K=3 reuse the K=1 population and often share
symbols; their apparent confirmation is therefore correlated. The weaker third
replicate term structure also argues against a universal holding-horizon claim.

**Kill condition.** Pre-register K=1, K=2, and K=3 on the shifted A-cell run;
close the breadth thesis if K=2 or K=3 loses positive-window rate below 55% or
turns negative after 30 bps. Do not promote a horizon-specific version unless
the horizon was declared before the run.

**Single-axis confirmation.** Use the same confirmation config as candidate 1
and change only the chronological data window. Report K=1/2/3 together.

**Expected cost.** The same one full 12–300 batch as candidate 1; the extra K
values are an analysis cost, not another batch.

### 3. [POST-HOC] Quality sorting may extend beyond the A-cell, but the extension is not yet a rule

**Thesis.** `profitFactor`/`expectancy` K=1 may be a broader quality-over-random
effect under several tight-pin configurations, rather than an A-orientation-only
effect.

**Evidence.** Fresh-band, 13-window random-pool results included:

| Probe | Sort/K | Mean delta | Positive windows | Verdict |
|---|---|---:|---:|---|
| TP1/SL1 | PF K=1 | +1.61% | 69.2% | WEAK+ |
| TP2/SL2 | PF K=1 | +1.21% | 61.5% | WEAK+ |
| 300-range-bar probe | PF K=1 | +3.10% | 69.2% | STABLE+ |
| maxTrades=10 combined | PF K=1 | +2.72% | 61.5% | WEAK+ |
| maxTrades=10 long | PF K=1 | +0.42% | 61.5% | WEAK+ |

This is a cross-config scan performed after the A-cell result, so it is
`[POST-HOC]`, not an independent replication. The same probes also had
inconsistent K behavior; for example, the TP1/SL1 PF K=2 cell was +0.40% with
46.2% positive windows, while the 300-range PF K=3 cell was +0.18% with 53.8%.

**Steelman objection.** These folders mix pin geometry, symbol composition,
trade filters, and search settings. Several are older or partial cells, and a
common market window can make cross-config positives look like a mechanism.

**Kill condition.** A single-axis rising-orientation TP1/SL1 confirmation must
fail this thesis if PF K=1 is not positive and at least 55% positive after 30
bps, or if PF and expectancy disagree in the pre-registered direction.

**Single-axis confirmation.** Keep the A-cell universe, orientation, long
direction, 4h timeframe, minTrades, evaluation window, and costs fixed; change
only TP2/SL2 to TP1/SL1. Judge PF K=1 at 12 bars with the same stride and
random-pool baseline.

**Expected cost.** One full 12–300 batch under TP1/SL1, again 289 holdout files
and the existing 22-sort analysis.

### 4. [POST-HOC] Pair-summary dispersion and median-profit gating are pilot hypotheses only

**Thesis.** A pair-level dispersion measure might identify when a summary-based
quality sort is safer, while `medianNetProfitPercent` might gate the PF K=1
selection; both require A-cell pair-summary recordings before they can be
considered candidates.

**Evidence.** The only pair-summary runs were the B-cell pilots, each with 25
disjoint windows:

| Run | Dispersion IC mean / positive windows | Median-profit gate delta | Gated windows |
|---|---:|---:|---:|
| `run-1523` | −0.0312 / 44.0% | +1.0973 pp | 22/25 (88.0%) |
| `run-1800` | −0.0196 / 40.0% | −0.1327 pp | 21/25 (84.0%) |

The IC signs agree, but the magnitude is small and the gate sign flips. The
time-block check was positive for median profit in both pilots, but that is not
enough to overcome the failed increment replication. This is therefore
`[POST-HOC]` and not evidence for a live predictor. Forward pair PnL remained a
target only.

**Steelman objection.** The pair-summary regime is compressed: 665 pair rows
per holdout, mean profitable-share 1.065%/1.048%, and median candidate count
11/11. It is also the falling B-cell, not the rising A-cell. The two pilots
may be measuring a sparse active subset and do not test the proposed A rule.

**Kill condition.** Record pair summaries in two independent A-cell replicates;
close this thesis unless dispersion has negative mean IC and the median-profit
gate has a positive increment in both, each using 25 stride-12 windows.

**Single-axis confirmation.** Keep the A-cell batch configuration unchanged
and enable/retain pair-summary recording as the only changed analysis surface;
pre-register the two tests and do not add predictors after seeing the rows.

**Expected cost.** One full 12–300 A-cell batch; pair summaries add storage and
analysis time but no second backtest.

## Checked and dead

- **[REPRODUCED] B-cell inverted orientation:** `invertedWinRate` was not stable
  across the three falling-orientation runs. K=1/K=2/K=3 means were
  `+4.899/+1.903/+1.500%` at 60/48/48% positive in B1105,
  `−0.519/+0.204/+0.506%` at 36/36/48% in B1523, and
  `+0.496/−1.511/+0.068%` at 48/36/48% in B1800. The established B-cell close
  stands; the apparent K=1 exception is not a repeat.
- **[REPRODUCED] `totalTrades` as predictor:** A-cell K=1 means were
  `+0.666/−1.249/+1.496%` across A2116/A0506/A0816, with 48/48/56% positive
  windows. The sign and K behavior do not replicate.
- **[REPRODUCED] `averageGain` as a general sort:** A-cell K=1 means were
  `−2.638/+0.107/−1.030%`; K=2 was `−1.765/−0.690/−0.860%`. The earlier
  mixed-universe result is configuration-specific and is not promoted here.
- **[REPRODUCED] Deep-stale cells as fresh confirmation:** the `hardest-eval`
  folders begin around holdout 812, so they contribute zero windows to the
  declared 12–160 fresh-band test. They cannot confirm the A-cell rule.
- **[REPRODUCED] `invertSignals` orientation instrument:** the prior two-cell
  test was muddled and remains closed; it is not used to rescue B-cell results.
- **[REPRODUCED] Mine timing, breadth, kNN, and related allocation diagnostics:**
  the negative conclusions in `docs/mine-timing-validation-findings.md` remain
  out of scope for candidate-rule promotion.

## Data-integrity notes

- The A and B audit runs used distinct batch IDs and produced no exact identical
  visible row sets: 0/3 pairwise duplicates in each three-run family. The
  A/B visible union fingerprint Jaccards were 2.85% and 6.92% respectively,
  both below the 50% overlap alarm.
- The B pair-summary cells are marked **COMPRESSED** for research purposes:
  profitable breadth is about 1% and the per-symbol candidate-count median is
  11. The visible union of top-10 sort rows is larger, but it does not negate
  the sparse full-pool regime indicated by the pair summaries.
- Newer `config.txt` files are envelope-style run logs rather than uniformly
  parseable standalone JSON; some contain formatting/trailing-comma defects.
  Batch IDs and holdout ranges were taken from block headers, as required. A
  few older folders lack complete config metadata, so their probe results are
  explicitly post-hoc.
- The live/current partial pair-summary surface was not used as evidence. It
  was still incomplete during this audit (examples included 3/29 and 11/122
  windows), so it would violate the completed-run and de-overlap requirements.
- The scratch audit reports visible top-pool structure, not the full candidate
  universe. That distinction is why the B pair-summary compression warning is
  retained even though its 22-block top-row union exceeds 50 candidates.
