# Offline TOP_MEAN rule mining

This directory is the append-only handoff point for selector ideas. The
checker reads the frozen L1 ledger
`archive/batch-open-score/sp500_top_mean_1788443592188_cgd3` and never writes
to it, to this directory, or to any other archive. The designated L1 report is
allowed to be `DATA_INCOMPLETE` only for that run: its h24 long coverage is
938/962 (97.5%).

The active campaign is `TM-L1-C1`. [`LOOP-CONTRACT.md`](./LOOP-CONTRACT.md) is
the governing contract for discovery, corroboration, validation, L2, reviews,
stopping, and promotion. This guide remains the checker and CLI reference.

A checker `EDGE` is local discovery evidence only: it requires the C1
discovery label, but it does not authorize validation or any engine change.
Promotion requires the ordered C3 chain and the universal C2 evidence
checklist in `LOOP-CONTRACT.md`, including a positive dominant-exclusion
`PRIMARY`, corroboration where required, human authorization, and audit.

## Frozen contract

The checker is v1: horizon 24, direction `long`, and causal base candidates
with finite recomputed `signedVotes / activePairCount > 0` and
`longEligible === true`. Events need at least two base candidates. Selection
happens before outcome lookup. A kept event is discarded entirely unless every
base candidate has an eligible, `ok`, finite, non-null h24 long outcome.
Unavailable outcomes are never replaced with zero.

Rule files are trusted local TypeScript modules with a default export taking
`(candidate, event)` and returning either a finite number or a boolean:

```ts
export default (candidate, event) => candidate.signedVotes / candidate.activePairCount;
```

```ts
export default (candidate, event) => event.regime === "bullish" && candidate.ema200Above;
```

A numeric result is a ranking and the maximum wins. A boolean result is a
filter; true candidates are then ranked by frozen TOP_MEAN score. Ties use the
smallest `tieBreakDigest(decisionTimeSec, asset)`, then asset name. The first
result fixes the rule kind for the whole run. Mixed types, non-finite values,
exceptions, Promises, objects, null, and undefined fail the run.

Candidate fields are limited to: `eventId`, `decisionTimeSec`, `interval`,
`poolVersion`, `asset`, `inPool`, `activePairCount`, `signedVotes`, `score`,
`longEligible`, `shortEligible`, `ema200Above`, `breadth`, and `regime`.
Event fields are limited to: `decisionTimeSec`, `breadth`, `regime`,
`poolSize`, `dow`, and `hour` (UTC). Outcomes, returns, entry/exit times,
archive rows, enumeration, unknown properties, and mutation are sealed by the
checker.

`PRIMARY` is the rule-selected return minus the incumbent TOP_MEAN-selected
return. `SECONDARY` is the rule-selected return minus the mean return of every
other base candidate. Both use the same outcome-complete kept event set; the
secondary base pool is never redefined by a filter. The report also shows
candidate/event keep rates, every selected asset, and dominant-asset exclusion
diagnostics. Positive PRIMARY means the rule beat the incumbent on matched
events. Positive SECONDARY means it beat the original base-pool leave-one-out
control.

## Commands

Run the mandatory self-check before trusting any rule:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts\top-mean-rule-checker.ts archive\batch-open-score\sp500_top_mean_1788443592188_cgd3 --self-check
```

Evaluate a rule file (all commands run from the repository root; rule files live in
archive/top-mean-mining/rules/):

```powershell
..\..\..\node_modules\.bin\esno scripts\top-mean-rule-checker.ts archive\batch-open-score\sp500_top_mean_1788443592188_cgd3 archive\top-mean-mining\rules\q1-exclude-sndk.ts --window discovery
..\..\..\node_modules\.bin\esno scripts\top-mean-rule-checker.ts archive\batch-open-score\sp500_top_mean_1788443592188_cgd3 archive\top-mean-mining\rules\q1-exclude-sndk.ts --window validation
```

Calibrate causal fields without selecting on outcomes:

```powershell
..\..\..\node_modules\.bin\esno scripts\top-mean-rule-checker.ts archive\batch-open-score\sp500_top_mean_1788443592188_cgd3 --stats --window discovery
..\..\..\node_modules\.bin\esno scripts\top-mean-rule-checker.ts archive\batch-open-score\sp500_top_mean_1788443592188_cgd3 --stats --window validation
```

Discovery is for idea generation and calibration. The checker supports an
explicit validation window, but campaign validation is sealed: do not run it
as an immediate finalist step or without the corroboration and human-approved
G2 authorization required by `LOOP-CONTRACT.md`. Preserve the exact rule bytes
for any authorized validation provenance.

Rule files must be pure and deterministic: no imports, file I/O, network,
clocks, randomness, mutation, or logging. The checker is not a process
sandbox, so this is a trusted-rule contract rather than a security boundary.
The checker owns evaluation and reporting. This directory's `idea-log.txt` is
owned by the separate mining/implementation workflow and may only be appended
to there; the checker never appends ideas or results.
