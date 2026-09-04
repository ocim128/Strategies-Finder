# B8 registration — pre-outcome template

This registration is frozen before B8 outcome-bearing discovery. Replace only
the empty POOL and FINAL sections after all 30 S3 screens and the human-approved
final ten are frozen. The audit consumes the machine-readable pipe records below.
sourceBody is the exact UTF-8 file body without its final newline; the audit
requires the file bytes to equal sourceBody plus one LF.

REGISTRATION|schema=top_mean_campaign_registration.v1|batchLabel=B8|outcomeOrdinal=5|humanApproved=yes
DESIGNATED|key=q26_sibling_low_breadth_coverage_floor_55|kind=filter|family=interaction:interaction|familyKey=low_breadth_coverage_floor|mechanism=candidate-filter|mechanismLineage=low_breadth_coverage_floor|path=rules/b8-designated-q26-sibling.ts|sourceBody=export default (cand, event) => event.breadth < 0.62 ? cand.activePairCount >= 55 : true;|sha256=6e16b10f9d0b7f71ee55a5ff32406da4ad6aed42aeb110b0a0cacacd070fb6a3

## S3 pool — ordered 30

Append one POOL|... record for each advanced-eligible S3 candidate, in ordinal
order 1 through 30. The fields are the exact registered path, source body,
SHA, familyKey, and mechanism lineage.

## Frozen finalists — ordered 10

Append one FINAL|... record for each human-approved finalist, in ordinal order
1 through 10. The designated rule above must appear as one of these ten records.

F4|B8|outcomeOrdinal=5|poolCount=30|finalCount=10|poolDigest=FILL_AFTER_FREEZE|finalDigest=FILL_AFTER_FREEZE|designatedKey=q26_sibling_low_breadth_coverage_floor_55|designatedSha256=FILL_AFTER_FREEZE|audit=PASS|humanApproved=yes
