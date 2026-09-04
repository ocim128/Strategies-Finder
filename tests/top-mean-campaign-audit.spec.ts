import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
    auditCampaignBatch,
    computeRegistrationDigest,
    runCampaignAuditCli,
    sha256Bytes,
    type CampaignRegistrationRule,
} from "../scripts/top-mean-campaign-audit";

const DESIGNATED_SOURCE = "export default (cand, event) => event.breadth < 0.62 ? cand.activePairCount >= 55 : true;";
const DESIGNATED_KEY = "q26_sibling_low_breadth_coverage_floor_55";
const DESIGNATED_SHA = sha256Bytes(DESIGNATED_SOURCE + "\n");
const BATCH_LABEL = "B8";
const FINAL_FAMILY_KEYS = [
    "low_breadth_coverage_floor",
    "final_family_b",
    "final_family_c",
    "final_family_d",
    "final_family_e",
    "final_family_f",
    "final_family_g",
    "final_family_b",
    "final_family_c",
    "final_family_d",
] as const;

interface FixtureOptions {
    wrongPoolCount?: boolean;
    compositionBreach?: boolean;
    identityBody?: boolean;
    shaMismatch?: boolean;
    designatedDrift?: boolean;
    quarantinedAdvance?: boolean;
}

interface Fixture {
    miningDir: string;
}

function recordLine(marker: string, record: CampaignRegistrationRule): string {
    return [
        marker,
        "ordinal=" + record.ordinal,
        "candidate=" + record.candidate,
        "key=" + record.key,
        "kind=" + record.kind,
        "family=" + record.family,
        "familyKey=" + record.familyKey,
        "mechanism=" + record.mechanism,
        "mechanismLineage=" + record.mechanismLineage,
        "path=" + record.path,
        "sourceBody=" + record.sourceBody,
        "sha256=" + record.sha256,
    ].join("|");
}

function makeRule(index: number): CampaignRegistrationRule {
    const candidate = String(index + 1).padStart(2, "0");
    const sourceBody = index === 0
        ? DESIGNATED_SOURCE
        : "export default (cand, event) => cand.signedVotes + " + index + ";";
    const familyKey = index < FINAL_FAMILY_KEYS.length
        ? FINAL_FAMILY_KEYS[index]!
        : "pool_family_" + index;
    return {
        ordinal: index + 1,
        candidate,
        key: index === 0 ? DESIGNATED_KEY : "rule_" + candidate,
        kind: index === 0 ? "filter" : "ranking",
        family: "interaction:" + familyKey,
        familyKey,
        mechanism: index === 0 ? "candidate-filter" : "ranking-reorder",
        mechanismLineage: index === 0 ? "low_breadth_coverage_floor" : "lineage_" + index,
        path: index === 0 ? "rules/b8-designated-q26-sibling.ts" : "rules/b8-rule-" + candidate + ".ts",
        sourceBody,
        sha256: sha256Bytes(sourceBody + "\n"),
    };
}

function makeFinals(pool: readonly CampaignRegistrationRule[]): CampaignRegistrationRule[] {
    return pool.slice(0, 10).map((record, index) => ({
        ...record,
        ordinal: index + 1,
        familyKey: FINAL_FAMILY_KEYS[index]!,
        mechanismLineage: record.mechanismLineage,
    }));
}

function s3Line(record: CampaignRegistrationRule): string {
    return [
        "S3",
        BATCH_LABEL,
        "candidate=" + record.candidate,
        "key=" + record.key,
        "kind=" + record.kind,
        "family=" + record.family,
        "sha256=" + record.sha256,
        "ledger=fixture-ledger",
        "changed=10/568",
        "dropped=0/568",
        "impact=MATERIAL",
        "advanced=yes",
        "reason=fixture",
    ].join("|");
}

function buildFixture(options: FixtureOptions = {}): Fixture {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "top-mean-campaign-audit-"));
    const miningDir = path.join(tempRoot, "archive", "top-mean-mining");
    const rulesDir = path.join(miningDir, "rules");
    mkdirSync(rulesDir, { recursive: true });
    const pool = Array.from({ length: 30 }, (_, index) => makeRule(index));
    const finals = makeFinals(pool);

    if (options.identityBody) {
        const identityBody = "export default (cand, event) => cand.asset === \"AAA\" ? 1 : 0;";
        pool[1] = { ...pool[1]!, sourceBody: identityBody, sha256: sha256Bytes(identityBody + "\n") };
        finals[1] = { ...finals[1]!, sourceBody: identityBody, sha256: pool[1]!.sha256 };
    }
    if (options.shaMismatch) {
        finals[1] = { ...finals[1]!, sha256: "a".repeat(64) };
    }
    if (options.quarantinedAdvance) {
        pool[29] = { ...pool[29]!, sha256: sha256Bytes("quarantined-rule\n") };
    }
    const registeredDesignatedSource = options.designatedDrift
        ? "export default (cand, event) => event.breadth < 0.62 ? cand.activePairCount >= 56 : true;"
        : DESIGNATED_SOURCE;
    const registeredDesignatedSha = options.designatedDrift
        ? sha256Bytes(registeredDesignatedSource + "\n")
        : DESIGNATED_SHA;
    const designatedLine = [
        "DESIGNATED",
        "key=" + DESIGNATED_KEY,
        "kind=filter",
        "family=interaction:interaction",
        "familyKey=low_breadth_coverage_floor",
        "mechanism=candidate-filter",
        "mechanismLineage=low_breadth_coverage_floor",
        "path=rules/b8-designated-q26-sibling.ts",
        "sourceBody=" + registeredDesignatedSource,
        "sha256=" + registeredDesignatedSha,
    ].join("|");
    const registeredPool = options.wrongPoolCount ? pool.slice(0, 29) : pool;
    const registrationFinals = options.compositionBreach
        ? finals.map((record) => ({ ...record, familyKey: "one_family" }))
        : finals;
    const registration = [
        "REGISTRATION|schema=top_mean_campaign_registration.v1|batchLabel=B8|outcomeOrdinal=5|humanApproved=yes",
        designatedLine,
        ...registeredPool.map((record) => recordLine("POOL", record)),
        ...registrationFinals.map((record) => recordLine("FINAL", record)),
    ].join("\n") + "\n";
    writeFileSync(path.join(miningDir, "B8-REGISTRATION.md"), registration);
    writeFileSync(path.join(rulesDir, "b8-designated-q26-sibling.ts"), DESIGNATED_SOURCE + "\n");
    for (const record of pool.slice(1)) {
        writeFileSync(path.join(rulesDir, "b8-rule-" + record.candidate + ".ts"), record.sourceBody + "\n");
    }
    const quarantinedSha = sha256Bytes("quarantined");
    const quarantinedLine = [
        "S3|B5|candidate=01|key=old|kind=ranking|family=old:old|sha256=" + quarantinedSha,
        "ledger=fixture-ledger|changed=1/568|dropped=0/568|impact=MATERIAL|advanced=no|reason=quarantined",
    ].join("|");
    const advancedLogPool = pool.map((record) => {
        const effective = options.quarantinedAdvance && record.ordinal === 30
            ? { ...record, sha256: quarantinedSha }
            : record;
        return s3Line(effective);
    });
    const poolDigest = computeRegistrationDigest(registeredPool);
    const finalDigest = computeRegistrationDigest(registrationFinals);
    const log = [
        quarantinedLine,
        "FORMAT4|effective=pre-B8|adds=R4,D4,F4|contract=v1.3|legacy-records-immutable",
        "D4|seed=Q26|role=legacy-hypothesis-only|family=interaction:interaction|mechanism=low_breadth_coverage_floor|freshSiblingRequired=yes|validationTarget=fresh-sibling|humanApproved=yes",
        ...advancedLogPool,
        "F4|B8|outcomeOrdinal=5|poolCount=" + registeredPool.length + "|finalCount=10|poolDigest=" + poolDigest
            + "|finalDigest=" + finalDigest + "|designatedKey=" + DESIGNATED_KEY + "|designatedSha256=" + DESIGNATED_SHA
            + "|audit=PASS|humanApproved=yes",
    ].join("\n") + "\n";
    writeFileSync(path.join(miningDir, "idea-log.txt"), log);
    return { miningDir };
}

function withFixture(options: FixtureOptions, callback: (fixture: Fixture) => void): void {
    const fixture = buildFixture(options);
    try {
        callback(fixture);
    } finally {
        rmSync(path.dirname(path.dirname(fixture.miningDir)), { recursive: true, force: true });
    }
}

function assertFailed(result: ReturnType<typeof auditCampaignBatch>, name: string): void {
    const check = result.checks.find((candidate) => candidate.name === name);
    assert.ok(check, "missing check " + name);
    assert.equal(check.passed, false, name + " unexpectedly passed");
}

describe("top-mean campaign audit", () => {
    it("passes a complete deterministic B8 registration", () => {
        withFixture({}, (fixture) => {
            const result = auditCampaignBatch(BATCH_LABEL, { miningDir: fixture.miningDir });
            assert.equal(result.passed, true);
        });
    });

    it("rejects a wrong S3 pool count", () => {
        withFixture({ wrongPoolCount: true }, (fixture) => {
            assertFailed(auditCampaignBatch(BATCH_LABEL, { miningDir: fixture.miningDir }), "S3_POOL_COUNT");
        });
    });

    it("rejects a C5 family composition breach", () => {
        withFixture({ compositionBreach: true }, (fixture) => {
            assertFailed(auditCampaignBatch(BATCH_LABEL, { miningDir: fixture.miningDir }), "C5_COMPOSITION");
        });
    });

    it("rejects identity source bytes", () => {
        withFixture({ identityBody: true }, (fixture) => {
            assertFailed(auditCampaignBatch(BATCH_LABEL, { miningDir: fixture.miningDir }), "NO_IDENTITY_BODY");
        });
    });

    it("rejects a finalist SHA mismatch", () => {
        withFixture({ shaMismatch: true }, (fixture) => {
            assertFailed(auditCampaignBatch(BATCH_LABEL, { miningDir: fixture.miningDir }), "FINALIST_BYTES");
        });
    });

    it("rejects designated-rule drift", () => {
        withFixture({ designatedDrift: true }, (fixture) => {
            assertFailed(auditCampaignBatch(BATCH_LABEL, { miningDir: fixture.miningDir }), "DESIGNATED_RULE");
        });
    });

    it("rejects advancement of a quarantined-pool SHA", () => {
        withFixture({ quarantinedAdvance: true }, (fixture) => {
            assertFailed(auditCampaignBatch(BATCH_LABEL, { miningDir: fixture.miningDir }), "NO_QUARANTINED_ADVANCE");
        });
    });

    it("returns usage status 2 without a batch label", () => {
        assert.equal(runCampaignAuditCli([], {}), 2);
    });
});
