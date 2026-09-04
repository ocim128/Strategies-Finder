# TM-L2-C1 mining guide

## Read-only checker commands

```text
../../../node_modules/.bin/esno scripts/top-mean-rule-checker.ts archive/batch-open-score/<v3-run> --self-check
../../../node_modules/.bin/esno scripts/top-mean-rule-checker.ts archive/batch-open-score/<v3-run> --feature-stats --window discovery
../../../node_modules/.bin/esno scripts/top-mean-rule-checker.ts archive/batch-open-score/<v3-run> --feature-stats --window validation
../../../node_modules/.bin/esno scripts/top-mean-rule-checker.ts archive/batch-open-score/<v3-run> archive/top-mean-mining/tm-l2-c1/rules/<rule>.ts --screen --window discovery
../../../node_modules/.bin/esno scripts/top-mean-rule-checker.ts archive/batch-open-score/<v3-run> archive/top-mean-mining/tm-l2-c1/rules/<rule>.ts --window validation
```

`--feature-stats` is causal-only and reads metadata, snapshots, and the feature
sidecar. It never reads candidate outcomes. Every feature read is tracked. A
null ranking read is neutralized to recomputed score; a null boolean read is
neutralized to `true`. Never replace a null with zero.

## Calibration workflow

1. Verify the v3 sidecar row count, identity join, source hashes, builder hash,
   and registration hash.
2. Run feature statistics on L2D and record non-null rate, distinctness,
   warm-up, role distributions, and Pearson/Spearman correlations.
3. Apply the activation gates in `FEATURE-SET.md`; highly correlated features
   are deduplicated and failed features remain inactive.
4. Screen only registered rules with a different source SHA and a declared
   family/mechanism lineage. Require the changed-selection admission threshold.
5. Evaluate sealed L2V outcomes under the unchanged all-base outcome gate and
   V2 power gate. A positive screen is not an outcome lead.

## Batch gates and recovery

The pilot is limited to three outcome batches, thirty outcome SHAs, and six
validation views. `N_G=57` is carried from L1 while `N_D_surface=0` starts the
successor surface. Stop after Batch 3 without a corroborated V2 lead.

Before cancellation, persist the browser/server run id and the latest sealed
batch marker. On resume, reattach by run id, verify the registration and source
hashes, and replay only the missing suffix. Never rewrite an old log line or
reuse a changed pair-list, feature builder, or checker source under the same
registration.

Campaign log hashes use canonical UTF-8 text with every CRLF pair stripped
(`hashConvention=crlf-stripped`). The committed log retains one historical CR
byte on line 209 from the B8 F4 append; that byte is permanent and is not
rewritten. This canonical convention applies to campaign hashes from v1.5
forward.
