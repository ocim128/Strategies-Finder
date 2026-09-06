# Batch 1 rule archive — folder `sp500_top_mean_1788560534200_jedw` (tag jedw), 2026-09-06

42 selection rules from the stage-1/1.5 diagnostic campaign: 2 hand-made
(coverage_confirmed_votes, coverage_floor_votes) + 40 agent-proposed.
ALL 42 FAILED the strict success bar (mean AND median delta positive vs
TOP_RAW, TOP_MEAN, and OTHERS_MEAN) — see `idea-log.txt` (parent folder) for
per-rule verdicts and deltas.

Preserved unmodified per campaign hygiene (never delete tested rules). These
files are NOT compiled (archive/ is outside tsconfig) and NOT registered;
imports are stale by design. Do not re-mine this surface — see the campaign
status note in archive/selection-mining-plan.md.

Headline lessons:
- Every mean-beating rule held SNDK at 41.7% of picks (identical to TOP_RAW);
  excluding SNDK, their edges were negative.
- Four rules collapsed to byte-identical TOP_RAW ordering.
- History features (vote flow, stability, incumbent returns) carried no
  forward selection value in either direction.
