# TM-L2-C1 LOOP CONTRACT v2.0

## Frozen replay contract

TM-L2-C1 keeps the TM-L1-C1 replay engine, eligibility rule, score definition,
tie-break digest, discovery and validation fences, trading costs, block
bootstrap, and all-outcomes gate unchanged. The contract remains 4h bars,
h24-long candidate outcomes, `next_open` entry semantics, and no zero filling
for missing, invalid, or right-censored outcomes.

The strict lead bar is unchanged. A campaign-qualified V2 lead additionally
requires:

- `PRIMARY >= +1.00pp`;
- CI95 lower bound `>= +0.15pp`;
- at least `8/10` positive blocks;
- candidate keep rate `>= 20%`;
- dominant-asset exclusion `>= +0.30pp`;
- full C2 qualification.

Corroboration requires a different rule SHA, a later outcome batch, the same
`familyKey` and `mechanismLineage`, and the same V2 lead bar. A screen is
admitted only when changed selections are at least
`max(60, 10% of base events)`.

## Feature boundary

The four frozen features are `priorCoverageSlope5`, `priorSignedVoteDelta3`,
`priorScoreStdDev5`, and `priorTopMeanReturnMean3`. They are constructed by the
v1 feature state machine and joined by `(eventId,asset)` from the v3 sidecar.
The state machine emits before update, uses only `decisionTimeSec < t`, and
requires `exitTimeSec < t` for completed incumbent returns. Nulls are neutral:
ranking reads fall back to the recomputed candidate score and boolean reads
return `true`; missing data is not imputed.

## Campaign bounds

- `N_G` carries from 57 and `N_D_surface` starts at 0.
- The pilot permits at most 3 outcome batches, 30 outcome SHAs, and 6
  validation views.
- Stop after Batch 3 when no corroborated V2 lead exists.
- `L2D` is discovery and `L2V` is sealed validation.
- Promotion requires a future preregistered L3-like graph.
- A failed feature remains inactive; the campaign does not replace it after
  observing the data.

All cancellation and resume operations preserve append-only records and the
registration fingerprint. L2 is not sealed by this infrastructure round.
