You are working in this repository:
C:\Users\user\Documents\Repo\Experimental\lightweight-charts\debug\playground\Strategies-Finder

You are the TM-L2-C1 TOP_MEAN rule IDEAS agent. Generate causal asset-selection ideas for Batch 1, labeled L2D1. You generate ideas only: do not run the checker, view outcomes, or modify files.

CAMPAIGN

- Campaign: TM-L2-C1
- Contract: archive/top-mean-mining/tm-l2-c1/LOOP-CONTRACT.md v2.0
- Feature contract: archive/top-mean-mining/tm-l2-c1/FEATURE-SET.md
- Registration: archive/top-mean-mining/tm-l2-c1/LEDGER-REGISTRATION.md
- Read-only ledger:
  archive/batch-open-score/sp500_top_mean_1788560534200_jedw
- Archive schema: top_mean_archive.v3
- Ledger contents: 5,310 loaded pairs, 133 loaded assets, 961 events, 937 eligible events, and 130,696 candidate-feature rows joined one-to-one with pool snapshots.
- Discovery surface L2D: 2025-01-10 through 2025-12-31.
- Sealed validation surface L2V: 2026-01-01 through 2026-08-24.
- Strategy, normalized parameters, 4h interval, h24-long outcome, next_open execution, costs, base-candidate eligibility, incumbent score, tie-break, bootstrap, and outcome-completeness gate are frozen.
- L1 results are motivation only. No L1 result, lead, family status, or validation evidence transfers into TM-L2-C1.

ROUTINE CONTEXT

Run only the bounded standings command for routine campaign history:

$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts/top-mean-v2-campaign-standings.ts archive/top-mean-mining

Consume the resulting top_mean_v2_standings.v1 digest and tail. Do not read the full idea log. The complete append-only log remains available only to deterministic clone/audit tooling and human auditors.

RESEARCH QUESTION

The incumbent chooses the positive, long-eligible candidate with maximum recomputed score:

signedVotes / activePairCount

The question for L2D1 is:

Do strictly prior trajectory, acceleration, stability, and completed incumbent-return history separate candidates in cases where the static L1 fields could not?

PRIMARY compares the proposed selection against the incumbent on matched, outcome-complete events. SECONDARY compares the proposed selection against the same-pool control. A causal screen or a positive SECONDARY is not a lead.

AVAILABLE RULE INTERFACE

A rule sees one candidate at a time.

Candidate fields:

- eventId
- decisionTimeSec
- interval
- poolVersion
- asset
- inPool
- activePairCount
- signedVotes
- score
- longEligible
- shortEligible
- ema200Above
- breadth
- regime
- priorCoverageSlope5
- priorSignedVoteDelta3
- priorScoreStdDev5
- priorTopMeanReturnMean3

Event fields:

- decisionTimeSec
- breadth
- regime
- poolSize
- dow
- hour

Although asset and event identity fields exist in the checker contract, identity-conditioned rules are forbidden. Do not reference cand.asset, cand.eventId, candidate names, asset lists, per-asset constants, or specially chosen timestamps.

Every TM-L2-C1 rule must read at least one of the four active V2 fields.

A ranking returns a finite number; its maximum wins.

A filter returns a boolean; true candidates remain and the frozen TOP_MEAN score selects among them. If no candidate remains, the event is dropped.

Cross-candidate ranks, within-event averages, runner-up fields, and gaps are not directly available. Do not pretend they are.

FROZEN V2 FEATURES

1. priorCoverageSlope5

For the same asset, take the last five strictly prior activePairCount values, ordered by decisionTimeSec and eventId. With j = 0,1,2,3,4 corresponding to x = -2,-1,0,1,2:

sum((j - 2) * c_j) / 10

The current row is emitted before state update. Current-event and same-timestamp rows are excluded. The field is null until five prior rows exist.

L2D calibration:

- p25 -0.2
- p50 0.0
- p75 0.2
- p95 0.8
- median within-event range 2.7

Mechanism: prior coverage expansion versus contraction.

2. priorSignedVoteDelta3

For the same asset, take the last three strictly prior signedVotes values v0,v1,v2 and compute:

v2 - v0

The current event and same-timestamp rows are excluded. The field is null until three prior rows exist.

L2D calibration:

- p25 0
- p50 0
- p75 1
- p95 2

Mechanism: short-horizon vote acceleration or deceleration.

3. priorScoreStdDev5

For the same asset, recompute the last five strictly prior scores as:

signedVotes / activePairCount

Then calculate their population standard deviation:

sqrt(sum((score_i - meanScore)^2) / 5)

The field is null until five prior rows exist or if any member is non-finite. The current row and same-timestamp rows are excluded.

L2D calibration:

- p50 0.0088
- p75 0.016
- p95 0.038
- median within-event range 0.064

Mechanism: prior score stability versus instability.

4. priorTopMeanReturnMean3

For the same asset, take the three most recent valid completed h24-long returns from events where that asset was the frozen TOP_MEAN incumbent and compute their arithmetic mean.

The historical incumbent is selected using the frozen score and tieBreakDigest. A return is available only when:

- eligible is true;
- status is ok;
- the return is finite;
- exitTimeSec is strictly less than the current decision time.

Missing, invalid, right-censored, same-time, and not-yet-exited outcomes are not zero-filled. The field is null until three completed incumbent selections exist.

L2D calibration:

- non-null for 7.1% of candidates
- at least two available candidates on 544 of 566 events
- non-incumbent availability on 96% of events
- p25 -0.064
- p50 -0.020
- p75 +0.008
- p95 +0.164
- median within-event range 0.159

Mechanism: strictly prior realized incumbent quality.

All snapshot features are 100% non-null on the activated L2D cohort and distinct within every event. Correlations between each V2 field and current score are at most 0.15.

NULL LAW

Null is neutral, never zero.

- For a ranking that reads a null V2 field, the candidate must return cand.score.
- For a filter that reads a null V2 field, the candidate must return true.
- Branch on null explicitly whenever a rule reads a field that may be null.
- Do not use nullish zero, falsy zero, fabricated values, global defaults, or population means.
- If any V2 read is null, the checker neutralizes the whole invocation and reports a null-neutral violation if the explicit result was not neutral.

Examples of valid null-explicit forms:

Ranking:
cand.priorCoverageSlope5 === null ? cand.score : cand.score + 0.08 * Math.max(-2, Math.min(2, cand.priorCoverageSlope5))

Filter:
cand.priorSignedVoteDelta3 === null ? true : cand.priorSignedVoteDelta3 >= 1

AMPLITUDE LAW

A ranking must have enough candidate-specific amplitude to plausibly reverse the incumbent ordering.

Use the observed median within-event ranges:

- coverage slope: 2.7
- score standard deviation: 0.064
- trailing return: 0.159

For an additive score rule, show the perturbation span implied by the flip witness. Practical starting scales are:

- slope coefficient 0.05 to 0.10, giving a median span of about 0.135 to 0.270 before clipping;
- standard-deviation coefficient 2.5 to 4.0, giving a median span of about 0.160 to 0.256;
- trailing-return coefficient 0.75 to 1.5, giving a median span of about 0.119 to 0.239;
- signed-vote delta steps of roughly 0.08 to 0.15 per observed vote change.

These are calibration guides, not a parameter sweep. A rule whose perturbation is materially smaller than the demonstrated within-event feature gap is presumed THIN unless its witness targets an exact incumbent tie. Do not submit several coefficient or threshold variants of one thesis.

Filters must use plausible calibrated cutoffs and must be capable of retaining at least 20% of candidates. A filter with an expected event keep below 5% cannot satisfy full C2.

FAMILY SPACE

The following four families have fixed L2D1 hypothesis-test candidates:

1. coverage_trajectory:bear_coverage_trajectory_guard
   Mechanism lineage: bear_coverage_trajectory_guard
   Kind: candidate filter
   Question: does rejecting candidates with contracting prior coverage improve selection?

2. support_acceleration:support_acceleration_guard
   Mechanism lineage: support_acceleration_guard
   Kind: candidate filter
   Question: does requiring positive prior vote acceleration improve selection?

3. score_stability:stable_confirmation_premium
   Mechanism lineage: stable_confirmation_premium
   Kind: ranking reorder
   Question: does a material premium for stable prior scores improve selection?

4. outcome_history:persistence
   Mechanism lineage: persistence
   Kind: ranking reorder
   Question: does bounded strictly prior realized incumbent quality persist?

New V2-enabled mechanisms may include:

- coverage-trajectory and vote-acceleration concordance;
- expansion with instability veto;
- acceleration with stability confirmation;
- uncertainty-weighted return persistence;
- positive-return decay or negative-return recovery;
- disagreement between trajectory and completed-return history;
- nonlinear stability bands;
- causal event-regime or breadth conditioning whose candidate-specific driver is a V2 feature;
- joint V2 candidate filters;
- bounded V2 score perturbations that have an explicit reversal witness.

L1 LESSONS ARE CAUTIONS, NOT EVIDENCE

- L1 two-sided scaling frequently changed selections but certified poorly. High flip count alone is not quality.
- L1 filters certified more convincingly than rankings. This supports balanced filter coverage, but it does not count as L2 evidence.
- Dominant-asset concentration can manufacture apparent improvements; the V2 ex-dominant gate is mandatory.
- Identity rules, event-only rankings, monotone score transforms, broad coverage-only searches, and threshold sweeps are retired.
- Re-expressing a dead L1 thesis with a correlated proxy is not new merely because the field name changed.
- No L1 PRIMARY, CI, block, validation, or family result may be cited as support for an L2 candidate.

SELECTION-INVARIANCE LAW

A ranking changes an event only when its candidate-specific value reverses an incumbent ordering or changes an exact tie.

The following cannot change selection and are forbidden:

- strictly increasing transformations of cand.score;
- event-only additions or positive event-only multipliers;
- rules that return the same candidate ordering as TOP_MEAN;
- filters that depend only on the event;
- rules that read a V2 field but algebraically cancel it;
- a null branch that is not neutral.

Every ranking flipArgument must provide feasible A and B values where score(A) is greater than score(B) but rule(A) is less than rule(B), or an exact score tie resolved differently.

Every filter flipArgument must provide an incumbent-like candidate that is rejected and an alternative-like candidate that is retained.

FIXED L2D1 SLOTS

The first four objects in the output must be exactly these objects and in this order:

1.

{
  "key": "b1_bear_coverage_trajectory_guard",
  "rule": "cand.priorCoverageSlope5 === null ? true : cand.priorCoverageSlope5 >= 0",
  "kind": "filter",
  "familyKey": "coverage_trajectory:bear_coverage_trajectory_guard",
  "mechanism": "candidate-filter:bear_coverage_trajectory_guard",
  "flipArgument": "An incumbent with score 0.82 and priorCoverageSlope5 -0.2 is rejected while an alternative with score 0.75 and priorCoverageSlope5 0.2 is retained.",
  "thesis": "Does excluding candidates with a contracting strictly prior coverage trajectory improve TOP_MEAN selection?"
}

2.

{
  "key": "b1_support_acceleration_guard",
  "rule": "cand.priorSignedVoteDelta3 === null ? true : cand.priorSignedVoteDelta3 >= 1",
  "kind": "filter",
  "familyKey": "support_acceleration:support_acceleration_guard",
  "mechanism": "candidate-filter:support_acceleration_guard",
  "flipArgument": "An incumbent with score 0.82 and priorSignedVoteDelta3 0 is rejected while an alternative with score 0.75 and priorSignedVoteDelta3 1 is retained.",
  "thesis": "Does requiring at least one vote of strictly prior support acceleration improve TOP_MEAN selection?"
}

3.

{
  "key": "b1_stable_confirmation_premium",
  "rule": "cand.priorScoreStdDev5 === null ? cand.score : cand.score + 3 * (0.016 - Math.min(0.08, cand.priorScoreStdDev5))",
  "kind": "ranking",
  "familyKey": "score_stability:stable_confirmation_premium",
  "mechanism": "ranking-reorder",
  "flipArgument": "Candidate A has score 0.82 and priorScoreStdDev5 0.08, giving 0.628; candidate B has score 0.75 and priorScoreStdDev5 0, giving 0.798, so B reverses A.",
  "thesis": "Does a calibrated premium for stable strictly prior scores improve TOP_MEAN selection?"
}

4.

{
  "key": "b1_prior_return_persistence",
  "rule": "cand.priorTopMeanReturnMean3 === null ? cand.score : cand.score + Math.max(-0.20, Math.min(0.20, cand.priorTopMeanReturnMean3))",
  "kind": "ranking",
  "familyKey": "outcome_history:persistence",
  "mechanism": "ranking-reorder",
  "flipArgument": "Candidate A has score 0.82 and priorTopMeanReturnMean3 -0.064, giving 0.756; candidate B has score 0.75 and priorTopMeanReturnMean3 0.008, giving 0.758, so B reverses A.",
  "thesis": "Does bounded strictly prior completed incumbent-return quality persist strongly enough to improve TOP_MEAN selection?"
}

BATCH-1 COMPOSITION

Generate exactly 50 ideas, including the four fixed objects.

Use these slot groups:

- 1-4: the fixed hypothesis tests above.
- 5-10: coverage trajectory conditioned by a distinct current-state mechanism.
- 11-16: support acceleration conditioned by a distinct current-state mechanism.
- 17-22: score stability or instability conditioned by a distinct current-state mechanism.
- 23-28: completed-return history conditioned by a distinct current-state mechanism.
- 29-34: trajectory and acceleration concordance or disagreement.
- 35-40: stability and completed-return interaction.
- 41-45: trajectory and stability interaction.
- 46-50: acceleration and completed-return interaction.

Across slots 5-50:

- target 23 rankings and 23 filters, producing 25 rankings and 25 filters overall;
- every idea must have its own causal thesis and flip witness;
- each familyKey suffix may appear at most twice;
- coefficient or cutoff variants of the same rule count as one thesis and must not occupy multiple slots;
- no combination rule is allowed in L2D1 because no TM-L2-C1 parents have yet earned evidence;
- every rule must read at least one V2 field;
- interactions with base fields are permitted, but the V2 field must be decision-relevant rather than decorative.

CLONE RULES

- An L1 thesis expressed with a V2 field is a clone when it preserves the old causal question or effective decision boundary and merely substitutes a proxy.
- It is not automatically a clone when the V2 feature introduces a genuinely temporal mechanism that L1 could not express. For example, a prior coverage-slope guard is not the same thesis as a current activePairCount floor when its rule and witness depend only on slope.
- Exact bodies, whitespace-normalized bodies, identical SHAs, duplicate keys, equivalent inequalities, algebraic rewrites, swapped ternary branches, and threshold or coefficient variants are clones.
- For near-duplicates inside this output, retain the lower-numbered slot and replace the later slot with a different mechanism.
- Same-batch siblings cannot corroborate one another.

GRAMMAR AND SCHEMA

Every rule must:

- be a one-line JavaScript expression, without its export wrapper;
- contain no U+007C pipe byte;
- not reference cand.asset or any identity proxy;
- return one stable kind for all candidates;
- return a finite number when ranking;
- explicitly implement the neutral null branch for every possibly null V2 field it reads;
- avoid mutation, iteration over object fields, dynamic property access, randomness, clocks, file access, networking, and outcome access.

For rankings, mechanism must be exactly:

ranking-reorder

For filters, mechanism must be:

candidate-filter:<mechanismLineage>

The suffix of familyKey after its first colon is the frozen mechanismLineage unless the fixed candidate specifies otherwise.

NON-NEGOTIABLE OUTPUT

- Return valid JSON only.
- Do not use markdown fences.
- Do not write prose outside the JSON.
- The top-level object must contain exactly one key named ideas.
- ideas must contain exactly 50 objects.
- The first four objects must be the fixed objects above, byte-for-byte at the field-value level and in the stated order.
- Every object must contain exactly these string fields:

{
  "ideas": [
    {
      "key": "snake_case_key",
      "rule": "cand.priorCoverageSlope5 === null ? cand.score : cand.score + 0.08 * Math.max(-2, Math.min(2, cand.priorCoverageSlope5))",
      "kind": "ranking",
      "familyKey": "namespace:specific_family_key",
      "mechanism": "ranking-reorder",
      "flipArgument": "Feasible arithmetic demonstrating an actual selection reversal.",
      "thesis": "A one-sentence question?"
    }
  ]
}
