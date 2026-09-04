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

## v1.3 routes and B8 lock

The v1.3 amendment is effective before B8, the fifth outcome-bearing batch.
Existing B5, B6, and B7 S3 pools are immutable, clone-blocked, and quarantined;
their S3 labels do not advance the completed outcome-batch ordinal.

The campaign has two discovery routes:

- `STRICT`: a lead requires `PRIMARY >= +0.50pp` and every C2 item. Corroboration
  requires a different SHA in a different outcome-bearing batch, with the same
  frozen `familyKey` and mechanism lineage, passing the same bar.
- `REPLICATION`: a seed requires `PRIMARY >= +1.00pp`, event keep `>= 5%`, and
  `EX_dominant > 0`. CI95 and block counts are mandatory report fields but advisory
  for route selection. A replicated lead requires a different-SHA sibling in a
  different outcome-bearing batch, with the same predeclared `familyKey` and
  mechanism lineage, independently passing the full seed bar.

FamilyKey and mechanism lineage are frozen before either rule receives outcomes.
Same-batch results cannot corroborate, failed siblings cannot be replaced by a
different parameter value, and routing gates are not promotion evidence. C2 remains
mandatory for STRICT and every fresh confirmation. L1 validation remains before L2
registration and before any L2 outcomes.

Before any B8 I2 outcome, materialize 30 unique candidates, run S3 on all 30,
discard ZERO candidates, admit at most one THIN with human approval, and freeze
exactly 10 finalists. The F4 registration must preserve ordered paths, exact source
bodies, SHAs, familyKeys, mechanism lineages, and the designated replication rule.
Run the deterministic audit from the repository root; it must PASS before the first
I2:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts/top-mean-campaign-audit.ts B8
```

If the pool cannot produce 10 compliant finalists, stop before outcomes and
regenerate. The designated legacy sibling is fixed exactly as follows and counts
toward the 30:

```text
key=q26_sibling_low_breadth_coverage_floor_55
kind=filter
family=interaction:interaction
mechanism=candidate-filter
rule=event.breadth < 0.62 ? cand.activePairCount >= 55 : true
```

Identity and broad `coverage:coverage` exploration are retired. No second Q26
threshold or functional variant is allowed, including a 54/56/58/60 sweep. The
other 29 candidates must not clone any logged thesis, including B5-B7 S3 records.

## v1.4 standings and grammar

Routine idea and implementation work consumes the deterministic standings digest
and its tail instead of rereading the full append-only log:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts/top-mean-campaign-standings.ts --campaign TM-L1-C1 --tail 8
```

The digest reads only `idea-log.txt`, `rules/`, and `B8-REGISTRATION.md`, writes
nothing, and fails with `DIGEST OVERFLOW` rather than truncating when it exceeds
40 lines or 8192 UTF-8 bytes. Use `--family <familyKey>` for one family's full
history. Use `--check-ideas <ideas.json>` to run the complete-history clone
checks without printing the candidate JSON.

Each new batch targets 50 causal-screen candidates, including fixed corroboration
siblings; the registered pool remains exactly 30 qualifying candidates and the
frozen finalist set exactly 10. Top up with causal-only candidates when fewer
than 30 qualify, without relaxing ZERO or THIN standards.

B9-or-later rule source bytes and registered `sourceBody` values must contain no
U+007C pipe byte. This bans logical/bitwise OR and pipes anywhere in the rule.
Use a ternary filter such as `A ? true : B`. The checker rejects the byte before
archive loading or dynamic import, and the audit checks every registered pool and
finalist source. B8 is the X5 historical exception and its v1 digest is preserved.

`N_D_surface` is the unique outcome-bearing discovery SHA count for the currently
registered ledger/schema/fence surface, including the immutable Q1 baseline;
`N_G` is every lifetime outcome-bearing evaluation and never resets. A genuinely
new registered surface may reset `N_D_surface`, but renaming or reusing a surface
does not. L2 confirmation data never becomes fresh discovery data.

## Frozen contract

The checker is v1: horizon 24, direction `long`, and causal base candidates
with finite recomputed `signedVotes / activePairCount > 0` and
`longEligible === true`. Events need at least two base candidates. Selection
happens before outcome lookup. A kept event is discarded entirely unless every
base candidate has an eligible, `ok`, finite, non-null h24 long outcome.
Unavailable outcomes are never replaced with zero.

## Causal idea preflight

The v1.1 campaign requires a discovery-window degeneracy screen for every
provisional idea before it receives a Q id or an outcome-bearing I2 record.
Both modes are read-only, discovery-only causal checks over `meta.json` and
`pool-snapshots.jsonl`; they never read outcomes or performance reports.

Screen a rule file:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts\top-mean-rule-checker.ts archive\batch-open-score\sp500_top_mean_1788443592188_cgd3 archive\top-mean-mining\rules\b2-candidate-<id>-<key>.ts --screen --window discovery
```

Print causal calibration and top-of-book statistics:

```powershell
..\..\..\node_modules\.bin\esno scripts\top-mean-rule-checker.ts archive\batch-open-score\sp500_top_mean_1788443592188_cgd3 --causal-stats --window discovery
```

`ZERO` means no selection changed and must be replaced. `THIN` is a warning,
not an accounting exemption, and at most one THIN idea may enter a final batch
with explicit human approval. A successful screen never replaces the mandatory
self-check before an outcome-bearing discovery run.

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
