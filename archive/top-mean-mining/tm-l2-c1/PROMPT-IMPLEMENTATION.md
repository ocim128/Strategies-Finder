You are working in this repository:
C:\Users\user\Documents\Repo\Experimental\lightweight-charts\debug\playground\Strategies-Finder

You are the TM-L2-C1 TOP_MEAN rule IMPLEMENTATION agent for Batch 1, labeled L2D1. You receive an approved 50-idea JSON object after the IDEAS marker at the end of this prompt.

You materialize, screen, register, audit, and evaluate the approved ideas exactly. You are the only agent authorized by this prompt to append TM-L2-C1 records to archive/top-mean-mining/idea-log.txt.

Do not modify the frozen ledger, strategy engine, feature builder, checker semantics, feature formulas, campaign gates, historical log lines, or the idea bodies.

GOVERNING FILES

Read:

- AGENTS.md
- archive/top-mean-mining/tm-l2-c1/LOOP-CONTRACT.md
- archive/top-mean-mining/tm-l2-c1/FEATURE-SET.md
- archive/top-mean-mining/tm-l2-c1/LEDGER-REGISTRATION.md
- archive/top-mean-mining/tm-l2-c1/MINING-GUIDE.md

Do not reread the full idea log for routine context.

Generate the bounded standings digest:

$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts/top-mean-v2-campaign-standings.ts archive/top-mean-mining

For an empty successor campaign, nextBatch=L2D means L2D1. Otherwise stop unless the digest identifies L2D1 as the next discovery batch. Confirm:

- campaign TM-L2-C1 is open;
- outcomeBatches=0;
- nextOutcomeOrdinal=1;
- NDsurface=0;
- NG=57;
- validationViews=0.

The complete log may be read only by deterministic clone/audit tooling and human auditors.

ACTIVE LEDGER

Read-only path:

archive/batch-open-score/sp500_top_mean_1788560534200_jedw

Frozen identities:

- schema: top_mean_archive.v3
- runId: sp500_top_mean_1788560534200_jedw
- content ledger fingerprint:
  ce1a30c3218f1d27d1b4851e64d53b0a91b673872cfb2b2d9e96bbc27a3a38c9
- non-distinguishing coordinator runFingerprint:
  ec81193124e572237acdcd826c6fe688da3adf2156e2abac17052a1c1838b887
- relationship execution-order SHA:
  8d773e596c99581ba3c4b9c26cb58118ca6c2cbf702e840e1a7b82dd002a1094
- relationship sorted-set SHA:
  13bd3ea446bd647b2e79a122af4d1c6e05f2f0183f73f9d90e22965dc76fa3f2
- candidate-features.jsonl SHA:
  d3848d9373c5b39431ae0729b3737e5e5af7be2979ffa03a3e1bbc45f04db67a
- candidate-feature rows: 130696

The runFingerprint alone must never identify this ledger in a new registration or result record.

PRECONDITIONS

1. Check git status and preserve unrelated work.
2. Confirm the exact L6 record supplied below is present once in idea-log.txt. If absent, append it once only after human approval. If a different L6 exists, stop.
3. Run the archive self-check:

$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts/top-mean-rule-checker.ts archive/batch-open-score/sp500_top_mean_1788560534200_jedw --self-check

If SELF_CHECK FAIL appears or the command exits nonzero, stop without screening or outcomes.

4. Run the infrastructure audit:

..\..\..\node_modules\.bin\esno scripts/top-mean-v2-campaign-audit.ts archive/top-mean-mining

It must report passed=yes. The batch must also have deterministic audit coverage for L6 identity, B1 registration counts, source bytes, C5, and the V2 admission gate before discovery. If the installed audit does not report those checks, stop before outcomes and report the tooling gap. Do not substitute manual approval for a missing deterministic audit.

L6 RECORD

L6|campaign=TM-L2-C1|predecessorB8RegistrationSha256=5ce93eb6a6bbb4b2f1bd3f4a83e98a0a1ad21203d4dc58a50598e78b96a7baac|registrationFingerprint=4bb07f7552ffe7f0a8c41c835651fabe30de030c273494495d08883f354e512f|registrationPayloadSha256=4543343bd437a5241fe23c91a57f0d8e2c69c5cecbbc27eb9024d478a1c3b427|ledgerRunId=sp500_top_mean_1788560534200_jedw|ledgerFingerprint=ce1a30c3218f1d27d1b4851e64d53b0a91b673872cfb2b2d9e96bbc27a3a38c9|relationshipExecutionOrderSha256=8d773e596c99581ba3c4b9c26cb58118ca6c2cbf702e840e1a7b82dd002a1094|relationshipSortedSetSha256=13bd3ea446bd647b2e79a122af4d1c6e05f2f0183f73f9d90e22965dc76fa3f2|featureFileSha256=d3848d9373c5b39431ae0729b3737e5e5af7be2979ffa03a3e1bbc45f04db67a|featureRowCount=130696|humanApproved=yes

INPUT FREEZE

Save the approved JSON unchanged as:

archive/top-mean-mining/tm-l2-c1/L2D1-IDEAS.json

It must contain exactly 50 ideas. Its first four entries must exactly match the four fixed B1 hypothesis tests from the approved ideas prompt.

Do not repair or reinterpret an idea. A malformed approved set invalidates the preflight and must be replaced before screening.

PREFLIGHT

Perform all checks before assigning Q ids:

- exactly 50 candidates;
- exactly the seven required string fields per candidate;
- unique keys;
- unique exact and whitespace-canonicalized rule bodies;
- kind is ranking or filter;
- ranking mechanism is exactly ranking-reorder;
- filter mechanism is candidate-filter:<lineage>;
- familyKey contains one namespace separator;
- no familyKey occurs more than twice among the 50;
- no U+007C byte in a rule or generated source;
- no cand.asset, event identity, asset list, timestamp identity, dynamic property, randomness, mutation, or external access;
- each rule reads at least one V2 field;
- each nullable V2 read has an explicit neutral branch;
- every flipArgument contains feasible arithmetic or an explicit filter rejection/retention witness;
- no parameter sweep or semantic near-duplicate;
- no combination in L2D1.

Run the complete L1-history clone checker without manually reading the log:

..\..\..\node_modules\.bin\esno scripts/top-mean-campaign-standings.ts --campaign TM-L1-C1 --tail 0 --check-ideas archive/top-mean-mining/tm-l2-c1/L2D1-IDEAS.json

The tool does not decide semantic V2 novelty. Apply these frozen rulings:

- a temporal V2 mechanism that L1 could not express is not automatically a clone;
- a proxy substitution preserving an L1 causal question or decision boundary is a clone;
- exact, canonical, algebraic, threshold, and coefficient variants are clones;
- within-batch near-duplicates retain the lowest input ordinal and the later entry must be replaced before any screening.

If any preflight check fails, do not screen a partial set. Stop and report the exact offending ordinal and rule.

MATERIALIZATION

For candidate 01 through 50, create:

archive/top-mean-mining/tm-l2-c1/rules/l2d1-candidate-<NN>-<key>.ts

The exact UTF-8 file body is:

export default (cand, event) => <rule>;

The file must end with one LF. The sourceBody used in registration is that exact line without its final LF. Compute SHA-256 from the complete file bytes.

Do not change an expression to make it compile. A materialization or import failure invalidates the preflight and requires a newly approved candidate before screening.

CAUSAL S3 SCREEN

Screen all 50 files on L2D only:

$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts/top-mean-rule-checker.ts archive/batch-open-score/sp500_top_mean_1788560534200_jedw archive/top-mean-mining/tm-l2-c1/rules/l2d1-candidate-<NN>-<key>.ts --screen --window discovery

The screen must:

- read metadata, snapshots, and candidate-features.jsonl only;
- never read candidate outcomes;
- report at least one accessed V2 field;
- report nullNeutralViolations=0.

The L2 admission minimum for 566 base events is:

max(60, ceil(0.10 * 566)) = 60 changed selections

A candidate is admission-qualified only when changed is at least 60. The checker’s older ZERO, THIN, or MATERIAL label does not override this gate.

Append one S3 line per successfully screened candidate after the deterministic pool decision. Use one physical UTF-8 line and no embedded newline:

S3|L2D1|campaign=TM-L2-C1|batchOrdinal=1|candidate=<NN>|key=<key>|kind=<ranking-or-filter>|family=<namespace>:<familyKey>|familyKey=<familyKey>|mechanism=<mechanism>|mechanismLineage=<lineage>|sha256=<64hex>|ledger=ce1a30c3218f1d27d1b4851e64d53b0a91b673872cfb2b2d9e96bbc27a3a38c9|changed=<n>/<baseEvents>|dropped=<n>/<baseEvents>|admissionMin=60|impact=<ZERO-or-THIN-or-MATERIAL>|advanced=<yes-or-no>|reason=<short_text>

advanced=yes means the SHA entered the ordered registered pool of 30. An admission-qualified candidate outside the first 30 records advanced=no with reason=QUALIFIED_NOT_SELECTED. A candidate below 60 has advanced=no with reason=BELOW_V2_ADMISSION. Screen errors use impact=ERROR, advanced=no, and the checker error as a single-line reason.

S3 carries no outcome metrics, receives no Q id, and consumes neither NDsurface nor NG. Every screened body, thesis, and SHA remains clone-blocked.

DETERMINISTIC 30-RULE POOL

Rank admission-qualified candidates by:

1. fixed hypothesis-test status, with input ordinals 01-04 first in that order;
2. descending changed-selection count;
3. ascending input ordinal.

Take the first 30. The pool must include every admission-qualified fixed candidate. If fewer than 30 qualify, stop before outcomes. Do not lower the gate or add unapproved top-ups.

DETERMINISTIC 10-RULE FINAL

From the registered pool, enumerate the valid 10-rule subsets that:

- contain every admission-qualified fixed candidate;
- contain at least six distinct familyKey suffixes;
- contain at most two rules from one familyKey;
- contain at least four rankings and at least four filters;
- contain no combination;
- satisfy the 60-change admission gate for every member.

Choose the subset with the greatest sum of changed-selection counts. Break ties by the lexicographically smallest ascending vector of input ordinals. Preserve the selected rules in ascending input-ordinal order in the FINAL records.

If no compliant subset exists, stop before outcomes.

L2D1 REGISTRATION

Create:

archive/top-mean-mining/tm-l2-c1/L2D1-REGISTRATION.md

Use the existing campaign registration schema:

REGISTRATION|schema=top_mean_campaign_registration.v1|campaign=TM-L2-C1|batchLabel=L2D1|batchOrdinal=1|outcomeOrdinal=1|ideasSha256=<sha256-of-L2D1-IDEAS.json>|humanApproved=yes

Then write 30 ordered POOL records:

POOL|ordinal=<1-through-30>|candidate=<NN>|key=<key>|kind=<ranking-or-filter>|family=<namespace>:<familyKey>|familyKey=<familyKey>|mechanism=<mechanism>|mechanismLineage=<lineage>|path=tm-l2-c1/rules/l2d1-candidate-<NN>-<key>.ts|sourceBody=<exact-source-without-final-LF>|sha256=<64hex>

Then write 10 ordered FINAL records with the same field order:

FINAL|ordinal=<1-through-10>|candidate=<NN>|key=<key>|kind=<ranking-or-filter>|family=<namespace>:<familyKey>|familyKey=<familyKey>|mechanism=<mechanism>|mechanismLineage=<lineage>|path=tm-l2-c1/rules/l2d1-candidate-<NN>-<key>.ts|sourceBody=<exact-source-without-final-LF>|sha256=<64hex>

Compute poolDigest and finalDigest using the existing registration canonicalization. For every POOL or FINAL rule, canonicalize exactly:

ordinal=<ordinal>|candidate=<candidate>|key=<key>|kind=<kind>|family=<family>|familyKey=<familyKey>|mechanism=<mechanism>|mechanismLineage=<mechanismLineage>|path=<path>|sourceBody=<sourceBody>|sha256=<sha256>

Join the ordered canonical records with LF and include one final LF, then SHA-256 the UTF-8 bytes.

After the batch audit passes, append:

F4|L2D1|campaign=TM-L2-C1|batchOrdinal=1|outcomeOrdinal=1|poolCount=30|finalCount=10|poolDigest=<64hex>|finalDigest=<64hex>|admissionMinChanged=60|fixedQualified=<comma-separated-candidate-numbers-or-none>|audit=PASS|humanApproved=yes

AUDIT BEFORE OUTCOMES

Run:

..\..\..\node_modules\.bin\esno scripts/top-mean-v2-campaign-audit.ts archive/top-mean-mining

The deterministic audit must verify, not merely assume:

- L6 identity and hashes;
- one approved L2D1 registration;
- exactly 30 POOL and 10 FINAL records;
- ordered ordinals;
- ideas, sourceBody, file bytes, and SHA agreement;
- no pipe bytes or identity access;
- every registered rule accesses a V2 field;
- each advanced rule changed at least 60 of 566 base events;
- every FINAL belongs to POOL;
- C5 and the B1 rank/filter constraint;
- digest agreement;
- F4 agreement;
- NDsurface and NG starting counters.

Do not begin the first outcome-bearing checker invocation unless all named checks report PASS. If the current audit lacks any check, report the missing coverage and stop.

OUTCOME-BEARING L2D1 RUNS

Assign Q58 through Q67 to the ten FINAL rules in registered order.

For each finalist, run:

$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts/top-mean-rule-checker.ts archive/batch-open-score/sp500_top_mean_1788560534200_jedw archive/top-mean-mining/tm-l2-c1/rules/l2d1-candidate-<NN>-<key>.ts --window discovery

The mandatory self-check runs automatically. On SELF_CHECK FAIL, stop immediately and do not run later rules.

Record:

- kind;
- rule SHA;
- candidate keep rate;
- event keep rate;
- PRIMARY mean and CI95;
- PRIMARY positive blocks;
- SECONDARY mean;
- selected-assets distribution;
- dominant asset and share;
- dominant-exclusion PRIMARY;
- accessed V2 fields and null-neutral status.

C1 LABEL AND V2 LEAD ARE SEPARATE

First assign D using unchanged C1 labels:

- EDGE: conclusive result, PRIMARY at least +0.30pp, event keep at least 5%, and CI95 lower bound greater than 0.
- WORSE: conclusive PRIMARY below 0.
- NO-EDGE: conclusive result that is neither EDGE nor WORSE.
- INCONCLUSIVE: checker error, insufficient evidence, non-conclusive block result, or unavailable required metric.

Then calculate v2Lead independently. v2Lead=yes only when all conditions hold:

- PRIMARY at least +1.00pp;
- CI95 lower bound at least +0.15pp;
- positive blocks at least 8/10, including 8/10, 9/10, and 10/10;
- candidate keep rate at least 20%;
- event keep rate at least 5%;
- dominant-exclusion PRIMARY at least +0.30pp;
- full C2 is yes.

A C1 EDGE can have v2Lead=no. Never rewrite D to encode the V2 gate.

I2 RECORDS

Append exactly one I2 line per started outcome-bearing finalist. Use independent pipe-delimited fields so standings tooling can parse every gate:

I2|Q<id>|L2D1|campaign=TM-L2-C1|batchOrdinal=1|key=<key>|kind=<ranking-or-filter>|family=<namespace>:<familyKey>|familyKey=<familyKey>|mechanism=<mechanism>|mechanismLineage=<lineage>|parents=-|sha256=<64hex>|ledger=ce1a30c3218f1d27d1b4851e64d53b0a91b673872cfb2b2d9e96bbc27a3a38c9|thesis=<single-line-text>|D=<EDGE-or-NO-EDGE-or-WORSE-or-INCONCLUSIVE>|primary=<signed-or-n/a>pp|ciLower=<signed-or-n/a>pp|ciUpper=<signed-or-n/a>pp|blocks=<p-or-n/a>/10|secondary=<signed-or-n/a>pp|keep=<candidate-pct-or-n/a>%|eventKeep=<event-pct-or-n/a>%|dominant=<asset-or-n/a>|dominantShare=<pct-or-n/a>%|exDom=<signed-or-n/a>pp|fullC2=<yes-or-no>|v2Lead=<yes-or-no>|NDsurface=<running-1-through-10>|NG=<running-58-through-67>

For an outcome-mode rule failure after evaluation starts, append D=INCONCLUSIVE, n/a metrics, fullC2=no, and v2Lead=no. It still consumes one NDsurface and NG count.

A usage error, campaign audit failure, archive self-check failure, or cancellation before an outcome evaluation starts does not consume a count and receives no I2.

Do not retry a changed rule body. Any changed body is a new SHA and a new future-batch idea.

CORROBORATION

A rule is corroborated only by a rule that:

- runs in a later outcome batch;
- has a different SHA;
- has the same familyKey;
- has the same mechanismLineage;
- independently has v2Lead=yes under the same V2 bar.

Two different families cannot cross-corroborate. Same-batch siblings cannot corroborate. A failed sibling cannot be replaced or tuned after seeing its outcome.

B1 can identify a provisional V2 lead but can never corroborate it.

VALIDATION

Do not run --window validation during L2D1.

A later validation is permitted only after:

1. a corroborated V2 lead exists;
2. a human-approved G2 line for the exact SHA is appended before invocation;
3. the validation-view budget is below 6.

G2 format:

G2|Q<id>|L2V|campaign=TM-L2-C1|familyKey=<familyKey>|mechanismLineage=<lineage>|sha256=<64hex>|budgetBefore=<used>/6|humanApproved=yes

Authorized validation command:

$env:NODE_OPTIONS = "--max-old-space-size=8192"
..\..\..\node_modules\.bin\esno scripts/top-mean-rule-checker.ts archive/batch-open-score/sp500_top_mean_1788560534200_jedw archive/top-mean-mining/tm-l2-c1/rules/<exact-frozen-rule>.ts --window validation

Validation record:

V2|Q<id>|L2V<view-number>|campaign=TM-L2-C1|surface=L2V|familyKey=<familyKey>|mechanismLineage=<lineage>|sha256=<64hex>|ledger=ce1a30c3218f1d27d1b4851e64d53b0a91b673872cfb2b2d9e96bbc27a3a38c9|validationViews=<used-after-run>|spent=1|result=<PASS-or-FAIL-or-ERROR>|primary=<signed-or-n/a>pp|ciLower=<signed-or-n/a>pp|ciUpper=<signed-or-n/a>pp|blocks=<p-or-n/a>/10|keep=<candidate-pct-or-n/a>%|eventKeep=<event-pct-or-n/a>%|dominant=<asset-or-n/a>|dominantShare=<pct-or-n/a>%|exDom=<signed-or-n/a>pp|fullC2=<yes-or-no>

A validation failure is final for the rule and family. Do not tune validation. Promotion still requires the separately preregistered future L3-like graph; L2V alone cannot promote an engine change.

PILOT STOPPING RULE

The campaign permits:

- at most three outcome batches: L2D1, L2D2, L2D3;
- at most 30 outcome SHAs;
- at most six validation views.

If no same-family, same-lineage, different-SHA, later-batch pair has independently passed the V2 bar after L2D3, append the campaign closure required by the contract and stop honestly. Do not add a fourth batch or redefine corroboration.

FINAL RESPONSE

Start with a table:

Q id | candidate | key | kind | changed | candidate keep | event keep | PRIMARY | CI95 | blocks | SECONDARY | exDom | C1 D | V2 lead

Then report:

- which fixed hypothesis tests passed the 60-change admission gate;
- which fixed tests reached the final ten;
- all provisional V2 leads;
- corroboration status, which must be NONE after L2D1;
- NDsurface ending value and NG ending value;
- validation usage, which must remain 0/6 after L2D1;
- audit result;
- failures or unrun candidates;
- one sentence identifying the mechanism family that should receive a preregistered later-batch sibling.

HARD RULES

- The ledger is read-only.
- The checker is the only outcome evaluation surface.
- Do not run a backtest.
- Do not modify an idea.
- Do not bypass SELF_CHECK FAIL.
- Do not begin outcomes before deterministic audit coverage passes.
- Do not view L2V without a corroborated lead and prior G2.
- Do not rewrite historical log bytes.
- Campaign hashes use canonical UTF-8 with CRLF pairs stripped; the historical CR byte on log line 209 remains untouched.
- Never identify the jedw ledger solely by ec81193124e572237acdcd826c6fe688da3adf2156e2abac17052a1c1838b887.
- Report every skipped or failed action.

IDEAS:
<paste the approved 50-idea JSON here>
