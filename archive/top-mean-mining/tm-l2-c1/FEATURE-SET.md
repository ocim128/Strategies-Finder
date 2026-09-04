# TM-L2-C1 FEATURE SET V2

This file freezes `top_mean_candidate_features.v1` for the successor campaign.
Feature rows are joined to the immutable pool snapshots by `(eventId, asset)`.
Every feature is computed from information available strictly before the
decision timestamp. A row is emitted before any snapshot or incumbent update at
that timestamp; same-timestamp rows cannot observe one another.

| Field | Formula | Causal boundary | Storage | Warm-up / null | Mechanism | Calibration requirement |
| --- | --- | --- | --- | --- | --- | --- |
| `priorCoverageSlope5` | OLS slope of the last five `activePairCount` values at `x=-2,-1,0,1,2`: `sum((j-2)*c_j)/10` | Prior snapshots for the same asset, ordered by `(decisionTimeSec,eventId)`; no row at `t` | `candidate-features.jsonl` | Null until five prior rows | Recent coverage expansion or contraction | At least 99% non-null and 80% distinct before activation |
| `priorSignedVoteDelta3` | `v2-v0` over the last three prior `signedVotes` values | Prior snapshots only; current event and same-timestamp rows excluded | `candidate-features.jsonl` | Null until three prior rows | Short-horizon vote acceleration | At least 99% non-null and 80% distinct before activation |
| `priorScoreStdDev5` | Population standard deviation of the last five recomputed scores `signedVotes/activePairCount` | Scores are recomputed from prior snapshots; any non-finite member invalidates the value | `candidate-features.jsonl` | Null until five rows or when any score is non-finite | Recent score dispersion / conviction instability | At least 99% non-null and 80% distinct before activation |
| `priorTopMeanReturnMean3` | Mean of the three most recent valid incumbent h24-long returns for the asset | Incumbent selection is frozen by the existing score and `tieBreakDigest`; an outcome is available only when `eligible=true`, `status=ok`, finite return, and `exitTimeSec < t` | `candidate-features.jsonl` | Null until three completed selections; missing, invalid, right-censored, and same-time exits are never zero-filled | Prior realized incumbent quality | Two-plus available candidates on at least 70% of events and non-incumbent availability on at least 80% |

## Activation gates

- Snapshot features must be at least 99% non-null and at least 80% distinct.
- `priorTopMeanReturnMean3` must have two-plus available candidates on 70% of
  events and be available for non-incumbents on 80% of events.
- A feature with absolute Pearson or Spearman correlation of at least 0.90
  with another feature is deduplicated before activation.
- A failed feature is inactive. No replacement feature is silently introduced.
- Null values are neutral in checker replay: a ranking read falls back to the
  candidate's recomputed score and a boolean read returns `true`.

The sidecar records the formula, availability, source-file, and builder hashes
in the v3 archive metadata. No forward outcome file is read by
`--feature-stats`.
