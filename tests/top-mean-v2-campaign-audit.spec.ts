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
    const logText = sourceLog.replace(
        /(C6\|[^\r\n]*registrationSha256=)[0-9a-f]{64}/,
        `$1${sha256Bytes(readFileSync(registrationPath, "utf8"))}`,
    );
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
