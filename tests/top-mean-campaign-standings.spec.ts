import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
    buildCampaignStandings,
    checkCampaignIdeas,
    renderCampaignStandings,
    type CampaignStandingsOptions,
} from "../scripts/top-mean-campaign-standings";
import { sha256Bytes } from "../scripts/top-mean-campaign-audit";

interface Fixture {
    miningDir: string;
    options: CampaignStandingsOptions;
}

const ALPHA_SOURCE = "export default (cand, event) => cand.score + (cand.ema200Above ? 0.1 : 0);";
const ALPHA_SHA = sha256Bytes(ALPHA_SOURCE + "\n");

function registrationLine(marker: string, source: string): string {
    return [
        marker,
        "ordinal=1",
        "candidate=01",
        "key=alpha_rule",
        "kind=ranking",
        "family=interaction:alpha_family",
        "familyKey=alpha_family",
        "mechanism=ranking-reorder",
        "mechanismLineage=alpha_lineage",
        "path=rules/alpha.ts",
        "sourceBody=" + source,
        "sha256=" + sha256Bytes(source + "\n"),
    ].join("|");
}

function makeFixture(longTail = false, closed = false): Fixture {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "top-mean-campaign-standings-"));
    const miningDir = path.join(tempRoot, "archive", "top-mean-mining");
    const rulesDir = path.join(miningDir, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, "alpha.ts"), ALPHA_SOURCE + "\n", "utf8");
    writeFileSync(path.join(miningDir, "B8-REGISTRATION.md"), [
        "REGISTRATION|schema=top_mean_campaign_registration.v1|batchLabel=B8|outcomeOrdinal=5|humanApproved=yes",
        registrationLine("POOL", ALPHA_SOURCE),
        registrationLine("FINAL", ALPHA_SOURCE),
    ].join("\n") + "\n", "utf8");
    const betaSource = "export default (cand, event) => cand.signedVotes - 0.5;";
    const betaSha = sha256Bytes(betaSource + "\n");
    const oldSha = sha256Bytes("old-rule");
    const logLines = [
        `P2|Q1|B0|key=legacy_rule|family=identity:identity|sha256=${oldSha}`,
        "FORMAT5|effective=pre-B9|contract=v1.4|adds=X5|prefixSha256=fixture|legacy-records-immutable",
        `S3|B5|candidate=01|key=old_rule|kind=ranking|family=identity:identity|sha256=${oldSha}|impact=MATERIAL|advanced=no|reason=quarantined`,
        `S3|B8|candidate=01|key=alpha_rule|kind=ranking|family=interaction:alpha_family|sha256=${ALPHA_SHA}|impact=MATERIAL|advanced=yes|reason=fixture`,
        "F4|B8|outcomeOrdinal=5|poolCount=1|finalCount=1|audit=PASS|humanApproved=yes",
        `I2|Q2|B1|key=alpha_rule|kind=ranking|family=interaction:alpha_family|parents=-|sha256=${ALPHA_SHA}|ledger=fixture|thesis=Alpha support thesis|D=EDGE primary=+0.60pp ci=[+0.10pp,+1.00pp] blocks=6/10 sec=+0.70pp keep=10.00% dominant=AAA share=50.00% exDom=+0.20pp`,
        `I2|Q3|B8|key=beta_rule|kind=ranking|family=interaction:beta_family|parents=-|sha256=${betaSha}|ledger=fixture|thesis=Beta support thesis|D=NO-EDGE primary=+0.10pp ci=[-0.20pp,+0.40pp] blocks=3/10 sec=+0.20pp keep=100.00% dominant=AAA share=50.00% exDom=-0.10pp`,
    ];
    if (closed) logLines.push("CLOSED|campaign=TM-L1-C1|disposition=DONE-NO-PROMOTION|outcomeBatches=2|NDsurface=3|NG=3|L1V=0/30|leads=0|finalReport=FINAL-REPORT.md|humanApproved=yes");
    if (longTail) logLines.push(`TAIL|${"x".repeat(8_300)}`);
    writeFileSync(path.join(miningDir, "idea-log.txt"), logLines.join("\n") + "\n", "utf8");
    return { miningDir, options: { campaign: "TM-L1-C1", miningDir } };
}

function cleanIdeas(): { ideas: Array<Record<string, string>> } {
    return {
        ideas: [
            { key: "new_one", rule: "cand.signedVotes - Math.pow(Math.max(0, 55 - cand.activePairCount), 2) / 22", kind: "ranking", familyKey: "score-shape:new_one", mechanism: "ranking-reorder", flipArgument: "A 20/40=.50 to 21/50=.42 reverses", thesis: "Could a nonlinear support deficit reorder the frontier?" },
            { key: "new_two", rule: "event.regime === \"bearish\" ? cand.activePairCount >= 50 : true", kind: "filter", familyKey: "regime-breadth:new_two", mechanism: "candidate-filter:new_two", flipArgument: "A 18/45 is rejected and B 25/55 retained", thesis: "Could a bear filter remove low-support candidates?" },
        ],
    };
}

function removeFixture(fixture: Fixture): void {
    rmSync(path.dirname(path.dirname(fixture.miningDir)), { recursive: true, force: true });
}

describe("top-mean campaign standings", () => {
    it("renders a closed campaign state and does not offer another batch", () => {
        const fixture = makeFixture(false, true);
        try {
            const output = renderCampaignStandings(buildCampaignStandings({ ...fixture.options, tail: 0 }));
            assert.match(output, /^STATE\|nextBatch=CLOSED\|nextOutcomeOrdinal=6\|completed=2\/20\|NDsurface=3\/201\|NG=3\|L1V=0\/30\|L2=unregistered\|closed=DONE-NO-PROMOTION$/m);
        } finally {
            removeFixture(fixture);
        }
    });

    it("renders deterministic fixture digest lines and state counters", () => {
        const fixture = makeFixture();
        try {
            const first = renderCampaignStandings(buildCampaignStandings({ ...fixture.options, tail: 1 }));
            const second = renderCampaignStandings(buildCampaignStandings({ ...fixture.options, tail: 1 }));
            assert.equal(first, second);
            assert.match(first, /^TOP_MEAN_STANDINGS\|schema=top_mean_standings\.v1\|campaign=TM-L1-C1\|contract=v1\.5\|hashConvention=crlf-stripped\|logSha256=[0-9a-f]{64}$/m);
            assert.match(first, /^STATE\|nextBatch=B9\|nextOutcomeOrdinal=6\|completed=2\/20\|NDsurface=3\/201\|NG=3\|L1V=0\/30\|L2=unregistered$/m);
            assert.match(first, /^COUNTS\|I2=2\|S3=2\|tested=3\|quarantined=1$/m);
            assert.match(first, /^ROUTES\|strictOpen=1\|replicationOpen=0\|confirmationOpen=0$/m);
            assert.match(first, /^TAIL\|line=I2\|Q3\|B8\|/m);
            assert.match(first, /^END\|lines=\d+\|bytes=\d+$/m);
            assert.ok(first.split("\n").filter(Boolean).length <= 40);
            assert.ok(Buffer.byteLength(first, "utf8") <= 8192);
        } finally {
            removeFixture(fixture);
        }
    });

    it("prints full detail for a requested family", () => {
        const fixture = makeFixture();
        try {
            const output = renderCampaignStandings(buildCampaignStandings({ ...fixture.options, family: "interaction:alpha_family", tail: 0 }));
            assert.match(output, /FAMILY_DETAIL\|key=alpha_family\|outcomes=1\|screens=1/);
            assert.match(output, /FAMILY_OUTCOME\|id=Q2\|batch=B1\|key=alpha_rule/);
            assert.match(output, /FAMILY_SCREEN\|batch=B8\|candidate=01\|key=alpha_rule/);
        } finally {
            removeFixture(fixture);
        }
    });

    it("fails loudly instead of truncating an oversized digest", () => {
        const fixture = makeFixture(true);
        try {
            assert.throws(() => renderCampaignStandings(buildCampaignStandings({ ...fixture.options, tail: 1 })), /DIGEST OVERFLOW/);
        } finally {
            removeFixture(fixture);
        }
    });

    it("reports complete-history idea violations and accepts a clean candidate set", () => {
        const fixture = makeFixture();
        try {
            const duplicate = { key: "dup", rule: "cand.score + (cand.ema200Above ? 0.1 : 0)", kind: "ranking", familyKey: "interaction:dup", mechanism: "ranking-reorder", flipArgument: "20/40=.50 reverses 21/50=.42", thesis: "Alpha support thesis" };
            const violations = checkCampaignIdeas({ ideas: [
                duplicate,
                { ...duplicate, thesis: "A second duplicate?" },
                { ...duplicate, key: "pipe", rule: "cand.ema200Above || cand.signedVotes > 10", thesis: "Pipe idea" },
                { ...duplicate, key: "identity", rule: "cand.asset === \"AAA\" ? 1 : 0", thesis: "Identity idea" },
            ] }, fixture.options);
            const codes = new Set(violations.violations.map((violation) => violation.code));
            assert.equal(violations.valid, false);
            for (const code of ["duplicate-key", "duplicate-body", "canonical-duplicate-body", "sha-collision", "known-thesis", "banned-grammar", "identity-reference", "family-cap"]) assert.ok(codes.has(code), code);
            const clean = checkCampaignIdeas(cleanIdeas(), fixture.options);
            assert.deepEqual(clean, { valid: true, violations: [] });
        } finally {
            removeFixture(fixture);
        }
    });
});
