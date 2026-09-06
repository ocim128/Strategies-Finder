# Pair Selection Rules

Pair-selection rules choose ONE firing pair per decision timestamp from a v3
mining-ledger folder, judged on fixed-horizon spread outcomes (default 24
bars, direction-adjusted fractional return) over the whole window. The
checker never runs backtests: it replays the ledger's recorded fires and
outcomes.

The retired asset-era documentation (asset registry, coordinator folders,
signedVotes-based rules over `archive/batch-open-score/`) lives in git
history and is no longer maintained. The asset core in `lib/selection-rules/`
is preserved for its CLI and parity tests only.

## Rule contract

Rules are registered in the static `lib/pair-selection/registry.ts`. The
contract in `lib/pair-selection/types.ts` is:

```ts
interface PairSelectionRule {
    key: string;
    name: string;
    description: string;
    defaultParams: Readonly<Record<string, number>>;
    paramLabels: Readonly<Record<string, string>>;
    normalizeParams?: (params) => params;
    metadata?: { paramBounds?: Readonly<Record<string, { min; max; step? }>> };
    score: (candidate, event, params, pool) => number;
}
```

- `score` returns the candidate's numeric score; the harness enters the
  highest-scoring candidate of the event. Mining rules expose exactly ONE
  numeric parameter (or none when the honest mechanism needs none);
  reference baselines are parameter-exempt.
- `normalizeParams` is required when scoring sanitizes the parameter;
  defaults must already be valid after normalization.
- `metadata.paramBounds` is metadata only (the sweep does not exist yet).
- Ties: the harness default is the smallest versioned FNV-1a-64 digest of
  `signalTime + "|pair|direction"`, asset-name order only on digest
  collision. A rule may override with its own deterministic tie-break;
  a rule scoring every candidate equally is a coin flip, not a rule.
- Inputs are fresh plain objects: candidate (identity + `feat_*` causal
  features + `feat_candidatesAtTime`), event context (`signalTime`,
  `interval`, `strategyKey`), and `pool` (fresh read-only copies of ALL
  same-event candidates, built before outcome gating). `feat_rank`,
  `executed`, `notExecutedReason`, and every outcome field are absent from
  these objects and unreachable by a rule.
- Pool-wide computations (event medians, MAD, overlap fractions) MUST use
  `memoByPool(pool, "<unique-key>", () => ...)` from `rule-helpers.ts` —
  un-memoized per-candidate pool scans caused multi-minute timeouts in
  batch 1.
- Performance envelope: a full 13,120-event tally runs in seconds when
  pool passes are memoized; the one-time folder load dominates.

## Eligibility and outcomes

An event is tallyable when it has >= 2 fired candidates and EVERY candidate
has a finite horizon outcome; otherwise the whole event is omitted.
`right_censored` rows are legitimate unavailability (they omit events);
malformed or unjoinable rows are data bugs and fail loudly. Outcomes are
direction-adjusted fractional returns: long = exit/entry - 1,
short = 1 - exit/entry. Reported deltas are percentage points (x100).

## How to run

From the repository root:

```text
NODE_OPTIONS=--max-old-space-size=24576 esno scripts/pair-pick-checker.ts <folderPath> <ruleKey> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
NODE_OPTIONS=--max-old-space-size=8192 esno scripts/pair-pick-scales.ts <folderPath>
```

Or use the Selection Rules menu (same engine, one load for all rules).
Loading a 5M+-signal folder takes minutes and several GB of heap — size
`--max-old-space-size` accordingly.

## MEASURED SCALES (folder mtpt2fxs)

Positive candidates from all candidate events (>= 2 fires), before outcome
gating. Percentiles use linear interpolation; decision-time distributions
are event-level and UTC. `feat_legVolatilityRatio20` is effectively 100%
null on this folder (2 non-null rows out of 5,627,132) — its percentile
line below is computed from those 2 rows and is NOT a distribution.

Folder run id: `2026-09-06_1946_batch-mtpt2fxs-saly4qxn`
Ledger: v3, feature set v3, horizons [24]
Computed: 2026-09-07

```text
events=13158 candidateEvents=13147 candidates=5627121
feat_entryRangePosition p1=-109.640217 p10=26.506677 p25=64.937150 p50=112.739019 p75=181.653576 p90=327.900178 p99=1029.465374 null=0.01%
feat_atrPct p1=0.622522 p10=0.881826 p25=1.103684 p50=1.424289 p75=1.874245 p90=2.486296 p99=4.417901 null=0.00%
feat_return20 p1=-9.849622 p10=-3.184334 p25=-0.286337 p50=2.866171 p75=6.808950 p90=11.784770 p99=28.008450 null=0.00%
feat_gapPct p1=-2.479036 p10=-0.499791 p25=-0.062397 p50=0.000000 p75=0.068259 p90=0.564009 p99=3.091244 null=0.00%
feat_dow p1=1.000000 p10=1.000000 p25=2.000000 p50=3.000000 p75=4.000000 p90=5.000000 p99=5.000000 null=0.00%
feat_hour p1=12.000000 p10=12.000000 p25=12.000000 p50=16.000000 p75=16.000000 p90=20.000000 p99=20.000000 null=0.00%
feat_pairWinRatePrior p1=0.000000 p10=14.285714 p25=20.000000 p50=27.777778 p75=36.842105 p90=45.454545 p99=66.666667 null=19.66%
feat_pairTradesPrior p1=1.000000 p10=2.000000 p25=6.000000 p50=12.000000 p75=23.000000 p90=35.000000 p99=52.000000 null=0.00%
feat_barsSincePairLastFire p1=1.000000 p10=1.000000 p25=1.000000 p50=2.000000 p75=3.000000 p90=5.000000 p99=89.000000 null=0.09%
feat_pairSpreadVolatility20 p1=0.422407 p10=0.661771 p25=0.869954 p50=1.192407 p75=1.673441 p90=2.336597 p99=4.651932 null=0.00%
feat_legVolatilityRatio20 p1=0.814606 p10=0.818078 p25=0.823866 p50=0.833512 p75=0.843159 p90=0.848947 p99=0.852419 null=100.00%
feat_candidatesAtTime p1=117.000000 p10=200.000000 p25=316.000000 p50=761.000000 p75=987.000000 p90=1117.000000 p99=1338.000000 null=0.00%
```

Reading notes:
- `feat_hour` is a dead dimension (12:00 / 16:00 UTC bars plus a winter
  20:00 stub); `feat_dow` (Mon-Fri) is the only live time dimension.
- `feat_entryRangePosition` is UNCLAMPED: p50 = 112.7 and p99 = 1,029 —
  spread bars routinely close far outside the prior range, and extremes are
  common, not anomalous.
- Events are large: p50 = 761 simultaneous fires (never below ~59). A rule
  always picks 1 of hundreds.
- `feat_legVolatilityRatio20` coverage is an infra gap tracked in
  archive/selection-mining-plan.md; ideas needing it are BLOCKED until the
  loader reacquires legs reliably.

## Success bar and discipline

Strict bar: a rule passes only when its mean AND median delta are positive
vs ALL THREE yardsticks (OTHERS_MEAN, reference_alphabetical,
reference_loudest_atr) on the whole window. Concentration is inspected, not
forgiven: the report includes selected pair / BASE / QUOTE frequency tables
and `<RULE>_EX_<dominant pair>` lines — an edge that disappears when the
dominant pair (or dominant leg) is excluded is a concentration bet.

Batch discipline lives in archive/selection-mining-plan.md and
archive/pair-selection/idea-log.txt (append-only; one line per idea,
failures included). Known gaps are tracked in the plan's campaign status.
