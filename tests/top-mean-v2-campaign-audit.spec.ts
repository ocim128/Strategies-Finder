import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { auditTmL2C1, type V2CampaignAuditResult } from "../scripts/top-mean-v2-campaign-audit";
import { sha256Bytes } from "../scripts/top-mean-campaign-log";

const repositoryRoot = process.cwd();
const sourceMiningDir = path.join(repositoryRoot, "archive", "top-mean-mining");

interface FixtureOptions {
    featureHashTamper?: boolean;
    missingUsage?: boolean;
    pipeBody?: boolean;
    identityBody?: boolean;
    l2d1Registration?: boolean;
}

interface Fixture {
    root: string;
    miningDir: string;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
    const root = mkdtempSync(path.join(tmpdir(), "top-mean-v2-audit-"));
    const miningDir = path.join(root, "archive", "top-mean-mining");
    const successorDir = path.join(miningDir, "tm-l2-c1");
    const registrationSource = readFileSync(path.join(sourceMiningDir, "tm-l2-c1", "LEDGER-REGISTRATION.md"), "utf8");
    const registrationLines = registrationSource.trimEnd().split(/\r?\n/).filter((line) => !line.startsWith("REGISTRATION_BYTES|"));
    if (options.featureHashTamper) {
        const sourceIndex = registrationLines.findIndex((line) => line.startsWith("FEATURE_SOURCE|"));
        registrationLines[sourceIndex] = registrationLines[sourceIndex]!.replace(/builderSourceSha256=[0-9a-f]{64}/, `builderSourceSha256=${"f".repeat(64)}`);
    }
    const sourceBody = options.identityBody
        ? "export default (cand, event) => cand.asset === \"AAA\" ? 1 : 0;"
        : options.pipeBody
            ? "export default (cand, event) => cand.priorCoverageSlope5 | 0;"
            : options.missingUsage
                ? "export default (cand, event) => cand.score;"
                : "export default (cand, event) => cand.priorCoverageSlope5 ?? cand.score;";
    registrationLines.push(`RULE|key=fixture_feature_rule|kind=ranking|family=feature:fixture|sourceBody=${sourceBody}|sha256=${sha256Bytes(`${sourceBody}\n`)}`);
    const canonicalRegistration = `${registrationLines.join("\n")}\n`;
    const registrationBytesCanonical = `${canonicalRegistration}\n`;
    const registrationText = `${canonicalRegistration}REGISTRATION_BYTES|path=archive/top-mean-mining/tm-l2-c1/LEDGER-REGISTRATION.md|sha256=${sha256Bytes(registrationBytesCanonical)}\n`;
    mkdirSync(successorDir, { recursive: true });
    const registrationPath = path.join(successorDir, "LEDGER-REGISTRATION.md");
    writeFileSync(registrationPath, registrationText, "utf8");
    writeFileSync(
        path.join(successorDir, "FEATURE-SET.md"),
        readFileSync(path.join(sourceMiningDir, "tm-l2-c1", "FEATURE-SET.md")),
    );
    const sourceLog = readFileSync(path.join(sourceMiningDir, "idea-log.txt"), "utf8");
    let logText = sourceLog.replace(
        /(C6\|[^\r\n]*registrationSha256=)[0-9a-f]{64}/,
        `$1${sha256Bytes(readFileSync(registrationPath, "utf8"))}`,
    );
    if (options.l2d1Registration) {
        mkdirSync(path.join(successorDir, "rules"), { recursive: true });
        const pool = Array.from({ length: 30 }, (_, index) => {
            const candidate = String(index + 1).padStart(2, "0");
            const familyKey = `family_${index % 6}`;
            const key = `l2d1_rule_${candidate}`;
            const sourceBody = `export default (cand, event) => cand.priorCoverageSlope5 ?? cand.score;`;
            const rulePath = `rules/l2d1-${candidate}-${key}.ts`;
            writeFileSync(path.join(successorDir, rulePath), `${sourceBody}\n`, "utf8");
            return { ordinal: index + 1, candidate, key, familyKey, sourceBody, rulePath, sha256: sha256Bytes(`${sourceBody}\n`) };
        });
        const final = pool.slice(0, 10).map((rule, index) => ({ ...rule, ordinal: index + 1 }));
        const registrationRule = (marker: string, rule: typeof pool[number]) => `${marker}|ordinal=${rule.ordinal}|candidate=${rule.candidate}|key=${rule.key}|kind=ranking|family=feature:${rule.familyKey}|familyKey=${rule.familyKey}|mechanism=ranking-reorder|mechanismLineage=${rule.familyKey}|path=${rule.rulePath}|sourceBody=${rule.sourceBody}|sha256=${rule.sha256}`;
        const digest = (rules: readonly (typeof pool[number])[]) => sha256Bytes(rules.map((rule) => [
            `ordinal=${rule.ordinal}`,
            `candidate=${rule.candidate}`,
            `key=${rule.key}`,
            "kind=ranking",
            `family=feature:${rule.familyKey}`,
            `familyKey=${rule.familyKey}`,
            "mechanism=ranking-reorder",
            `mechanismLineage=${rule.familyKey}`,
            `path=${rule.rulePath}`,
            `sourceBody=${rule.sourceBody}`,
            `sha256=${rule.sha256}`,
        ].join("|")).join("\n") + "\n");
        const registrationLines = [
            "REGISTRATION|schema=top_mean_campaign_registration.v1|batchLabel=L2D1|campaign=TM-L2-C1|outcomeOrdinal=1|humanApproved=yes",
            ...pool.map((rule) => registrationRule("POOL", rule)),
            ...final.map((rule) => registrationRule("FINAL", rule)),
            `F4|L2D1|outcomeOrdinal=1|poolCount=30|finalCount=10|poolDigest=${digest(pool)}|finalDigest=${digest(final)}|audit=PASS|humanApproved=yes`,
        ];
        writeFileSync(path.join(successorDir, "L2D1-REGISTRATION.md"), `${registrationLines.join("\n")}\n`, "utf8");
        logText += pool.map((rule) => `S3|L2D1|campaign=TM-L2-C1|candidate=${rule.candidate}|key=${rule.key}|kind=ranking|family=feature:${rule.familyKey}|sha256=${rule.sha256}|changed=60/566|impact=MATERIAL|advanced=yes`).join("\n") + "\n";
    }
    writeFileSync(path.join(miningDir, "idea-log.txt"), logText, "utf8");
    return { root, miningDir };
}

function removeFixture(fixture: Fixture): void {
    rmSync(fixture.root, { recursive: true, force: true });
}

function assertFailed(result: V2CampaignAuditResult, name: string): void {
    const check = result.checks.find((candidate) => candidate.name === name);
    assert.ok(check, `missing check ${name}`);
    assert.equal(check.passed, false, `${name} unexpectedly passed`);
}

describe("TM-L2-C1 audit discrimination", () => {
    it("passes a compliant registered feature rule", () => {
        const fixture = makeFixture();
        try {
            const result = auditTmL2C1({ root: repositoryRoot, miningDir: fixture.miningDir });
            assert.equal(result.passed, true, result.checks.map((check) => `${check.name}=${check.passed}:${check.detail}`).join("\n"));
        } finally {
            removeFixture(fixture);
        }
    });

    it("rejects a feature-source hash tamper", () => {
        const fixture = makeFixture({ featureHashTamper: true });
        try {
            assertFailed(auditTmL2C1({ root: repositoryRoot, miningDir: fixture.miningDir }), "FEATURE_HASHES");
        } finally {
            removeFixture(fixture);
        }
    });

    it("rejects a registered rule with no V2 feature usage", () => {
        const fixture = makeFixture({ missingUsage: true });
        try {
            assertFailed(auditTmL2C1({ root: repositoryRoot, miningDir: fixture.miningDir }), "V2_FIELD_USAGE");
        } finally {
            removeFixture(fixture);
        }
    });

    it("validates a complete L2D1 registration and skips it before materialization", () => {
        const skipped = makeFixture();
        try {
            const result = auditTmL2C1({ root: repositoryRoot, miningDir: skipped.miningDir });
            assert.equal(result.checks.find((check) => check.name === "L2D1_REGISTRATION")?.detail, "skipped: L2D1-REGISTRATION.md does not exist");
        } finally {
            removeFixture(skipped);
        }

        const materialized = makeFixture({ l2d1Registration: true });
        try {
            const result = auditTmL2C1({ root: repositoryRoot, miningDir: materialized.miningDir });
            assert.equal(result.passed, true, result.checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`).join("\n"));
            for (const name of ["L2D1_REGISTRATION", "L2D1_POOL_COUNT", "L2D1_FINAL_COUNT", "L2D1_C5_COMPOSITION", "L2D1_POOL_BYTES", "L2D1_FINAL_BYTES", "L2D1_V2_FIELD_USAGE", "L2D1_ADMISSION_GATE", "L2D1_DIGESTS"]) {
                assert.equal(result.checks.find((check) => check.name === name)?.passed, true, name);
            }
        } finally {
            removeFixture(materialized);
        }
    });

    it("rejects a pipe in a registered source body", () => {
        const fixture = makeFixture({ pipeBody: true });
        try {
            assertFailed(auditTmL2C1({ root: repositoryRoot, miningDir: fixture.miningDir }), "RULE_GRAMMAR");
        } finally {
            removeFixture(fixture);
        }
    });

    it("rejects an identity reference in a registered source body", () => {
        const fixture = makeFixture({ identityBody: true });
        try {
            assertFailed(auditTmL2C1({ root: repositoryRoot, miningDir: fixture.miningDir }), "NO_IDENTITY_BODY");
        } finally {
            removeFixture(fixture);
        }
    });
});
