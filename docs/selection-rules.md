# Selection Rules

Selection rules choose one positive asset at each same-event decision point in
an archived coordinator run. The P1/P2 checker is a whole-window research
tally; it is not a portfolio simulator and does not run backtests.

## Rule contract

Rules are registered in the static `lib/selection-rules/registry.ts` registry.
The contract in `lib/selection-rules/types.ts` is:

```ts
interface SelectionRule {
    key: string;
    name: string;
    description: string;
    defaultParams: Readonly<Record<string, number>>;
    paramLabels: Readonly<Record<string, string>>;
    normalizeParams?: (params: Readonly<Record<string, number>>) => Readonly<Record<string, number>>;
    metadata?: {
        paramBounds?: Readonly<Record<string, { min: number; max: number; step?: number }>>;
    };
    score: (candidate: SelectionCandidate, event: SelectionEventContext, params: Readonly<Record<string, number>>) => number;
}
```

- `key` is the stable registry and CLI identifier.
- `name` is the report-facing label.
- `description` states the rule's selection logic.
- `defaultParams` contains the rule's default numeric parameters. Mining rules
  have exactly one numeric parameter.
- `paramLabels` gives each parameter a human-readable label.
- `normalizeParams` is optional, but required when scoring sanitizes, clamps,
  rounds, or otherwise changes parameter meaning. Defaults must already be
  valid after normalization.
- `metadata.paramBounds` is descriptive metadata only in this phase.
- `score` returns the candidate's numeric score; the harness selects the
  highest score. It also receives `pool`: fresh read-only copies of ALL
  positive candidates of the same event (pre-gating), so cross-candidate
  theses (event medians, vote shares, gaps, dispersion) are expressible.
  Events carry ~60 candidates; per-candidate pool scans are acceptable.
  Do not mutate the pool.

Reference baselines are parameter-exempt. `TOP_MEAN`, `TOP_RAW`, and
`TOP_ACTIVE` take no parameters. A mining rule must expose one numeric
parameter even if its first useful implementation is simple.

The default harness tie-break is the smallest versioned FNV-1a-64 digest. Its
exact key is
`MAX_ACTIVE_TIE_VERSION|tieSeed|truncatedEventTimeSec|scoringAsset`;
in shorthand, this is the decision-time-and-asset tie key. Asset-name order is
the final fallback only on digest collision. Reference rules use this default.
An idea may declare a different tie-break, but it must specify that choice
explicitly with the rule.

Rules receive only fresh plain `SelectionCandidate` and
`SelectionEventContext` objects. Candidate fields are `asset`, `pair`, `score`,
`signedVotes`, `activePairCount`, `ema200Above`, `breadth`, `regime`,
`longEligible`, `shortEligible`, and `inPool`. Event fields are `eventId`,
`decisionTimeSec`, `horizonBars`, and `interval`. Candidate lists are built
before outcome eligibility gating. Outcome rows and returns are never on those
objects and are not reachable by a rule.

Constant-field trap: on the measured folder below, `longEligible` (100%),
`shortEligible` (0%), and `inPool` (100%) are constant — they carry NO
information. A rule that scores every candidate equally is not a strategy:
the FNV tie-break then chooses, which is a coin flip. Do not mine constant
fields.

## How to run

From the repository root:

```text
NODE_OPTIONS=--max-old-space-size=8192 esno scripts/selection-checker.ts <folderPath> <ruleKey>
NODE_OPTIONS=--max-old-space-size=8192 esno scripts/selection-scales.ts <folderPath>
```

On Windows PowerShell, set `$env:NODE_OPTIONS` to
`--max-old-space-size=8192` before running the same `esno` commands. The
checker validates the archive hashes, indexes the folder once, and prints the
tally. The scales command reuses that archive loader and prints the measured
stage-1 input scales.

## MEASURED SCALES (stage 1)

These measurements describe the positive candidates rules actually see:
positive candidates from all candidate events with at least two positives,
before outcome gating. They are not restricted to the 937 completed tally
events. Numeric percentiles use linear interpolation over non-null values;
null shares use all positive-candidate observations. Decision-time
distributions are event-level and UTC.

Folder run id: `sp500_top_mean_1788560534200_jedw`  
Schema: `top_mean_archive.v3`  
Computed: `2026-09-06`

```text
horizon=24 candidateEvents=961 positiveCandidates=60467
score p1=0.014493 p10=0.041096 p25=0.088235 p50=0.193548 p75=0.360000 p90=0.574468 p99=1.000000 null=0.00%
signedVotes p1=1.000000 p10=3.000000 p25=6.000000 p50=12.000000 p75=20.000000 p90=28.000000 p99=39.000000 null=0.00%
activePairCount p1=40.000000 p10=48.000000 p25=54.000000 p50=60.000000 p75=65.000000 p90=69.000000 p99=75.000000 null=0.00%
breadth p1=0.181818 p10=0.393939 p25=0.583333 p50=0.653846 p75=0.704545 p90=0.744361 p99=0.819549 null=0.00%
ema200Above true=85.04%
longEligible true=100.00%
shortEligible true=0.00%
inPool true=100.00%
regime bullish=83.57% bearish=16.43% unavailable=0.00%
candidatesPerEvent p10=59 p25=61 p50=63 p75=65 p90=67 p99=70.400000
candidateCountShare exactly2to5=0.00% sixTo20=0.00% over20=100.00%
utcHour 00=0.00% 01=0.00% 02=0.00% 03=0.00% 04=0.00% 05=0.00% 06=0.00% 07=0.00% 08=0.00% 09=0.00% 10=0.00% 11=0.00% 12=43.18% 13=0.00% 14=0.00% 15=0.00% 16=43.39% 17=0.00% 18=0.00% 19=0.00% 20=13.42% 21=0.00% 22=0.00% 23=0.00%
utcDay 0=0.00% 1=19.04% 2=20.71% 3=20.60% 4=19.67% 5=19.98% 6=0.00%
```

## Success bar

The plan v4 default is strict: a rule passes only when both its mean delta
and its median delta are positive against all three yardsticks on the same
whole-window horizon:

- `TOP_RAW`
- `TOP_MEAN`
- `OTHERS_MEAN`, the fresh leave-one-out mean of the other positive
  candidates' long returns

The current folder's TOP_MEAN edge is concentrated: SNDK accounts for 30% of
its picks. Excluding SNDK, the mean edge against `OTHERS_MEAN` drops from
`+4.36%` to `+0.55%`. That is why every rule report includes its
`<RULE>_EX_<dominant>` line.

## Discipline

Mining does not filter overfitting by design. Luck control is P5 portfolio
certification plus replication on a second folder with a different window
and/or configuration. Keep the family cap at no more than 10 ideas per batch
from the same feature pair. The append-only idea log belongs to the later
mining loop, not this rules-library phase.
