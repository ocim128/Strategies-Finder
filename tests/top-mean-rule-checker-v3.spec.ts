import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    computeTopMeanFeatureStats,
    evaluateTopMeanCausalScreen,
    loadCausalTopMeanArchiveFromDirectory,
    loadNormalizedTopMeanArchiveFromDirectory,
    normalizeTopMeanArchive,
    type TopMeanRuleArchiveMeta,
} from "../scripts/top-mean-rule-checker";
import {
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
    MAX_ACTIVE_TIE_VERSION,
} from "../lib/batch-backtest/max-active-research-contract";
import {
    TOP_MEAN_CANDIDATE_FEATURES_SCHEMA,
    TOP_MEAN_CAUSAL_FEATURE_FIELDS,
    TOP_MEAN_FEATURE_AVAILABILITY_POLICY,
    TOP_MEAN_FEATURE_CONTRACT_VERSION,
    TOP_MEAN_FEATURE_FORMULA_VERSION,
    type TopMeanCandidateFeatureRow,
} from "../lib/batch-backtest/sp500-top-mean-causal-features";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { PoolRuleArchive } from "../scripts/analyze-pool-rules";

const DECISION_TIME = Math.floor(Date.parse("2025-06-01T00:00:00.000Z") / 1000);
const EVENT_ID = `4h:${DECISION_TIME}`;

function snapshot(asset: string, signedVotes: number): PoolSnapshotRecord {
    return {
        eventId: EVENT_ID,
        decisionTimeSec: DECISION_TIME,
        interval: "4h",
        poolVersion: null,
        asset,
        inPool: true,
        activePairCount: 10,
        signedVotes,
        score: signedVotes / 10,
        longEligible: true,
        shortEligible: false,
        ema200Above: true,
        breadth: 0.6,
        regime: "bullish",
    };
}

function outcome(asset: string, returnValue: number): CandidateOutcomeRecord {
    return {
        eventId: EVENT_ID,
        decisionTimeSec: DECISION_TIME,
        horizonBars: 24,
        direction: "long",
        asset,
        inPool: true,
        eligible: true,
        return: returnValue,
        entryTimeSec: DECISION_TIME + 1,
        exitTimeSec: DECISION_TIME + 25,
        status: "ok",
    };
}

function features(): TopMeanCandidateFeatureRow[] {
    return [
        {
            eventId: EVENT_ID,
            decisionTimeSec: DECISION_TIME,
            asset: "AAA",
            priorCoverageSlope5: null,
            priorSignedVoteDelta3: null,
            priorScoreStdDev5: null,
            priorTopMeanReturnMean3: null,
        },
        {
            eventId: EVENT_ID,
            decisionTimeSec: DECISION_TIME,
            asset: "BBB",
            priorCoverageSlope5: 1,
            priorSignedVoteDelta3: 2,
            priorScoreStdDev5: 0.1,
            priorTopMeanReturnMean3: 0.2,
        },
    ];
}

function meta(schema: "top_mean_archive.v2" | "top_mean_archive.v3" = "top_mean_archive.v3"): TopMeanRuleArchiveMeta {
    return {
        schema,
        runId: "fixture-v3",
        interval: "4h",
        horizons: [24],
        fingerprint: "fixture-fingerprint",
        ...(schema === "top_mean_archive.v3" ? {
            runFingerprint: "fixture-fingerprint",
            fingerprintVersion: "top_mean_ledger_fingerprint.v2",
            postAssemblyFingerprint: "0".repeat(64),
            files: {},
            featureSet: {
                schema: TOP_MEAN_CANDIDATE_FEATURES_SCHEMA,
                contractVersion: TOP_MEAN_FEATURE_CONTRACT_VERSION,
                formulaVersion: TOP_MEAN_FEATURE_FORMULA_VERSION,
                availabilityPolicy: TOP_MEAN_FEATURE_AVAILABILITY_POLICY,
                file: "candidate-features.jsonl",
                rowCount: 2,
                sha256: "0".repeat(64),
                builderSourceSha256: "1".repeat(64),
                sources: {
                    poolSnapshotsSha256: "2".repeat(64),
                    candidateOutcomesSha256: "3".repeat(64),
                },
                fields: [...TOP_MEAN_CAUSAL_FEATURE_FIELDS],
            },
        } : {}),
        canonicalAssets: ["AAA", "BBB"],
        manifest: {
            catalog: { assets: ["AAA", "BBB"] },
            researchContract: {
                tieVersion: MAX_ACTIVE_TIE_VERSION,
                blockCount: MAX_ACTIVE_BLOCK_COUNT,
                bootstrapSamples: MAX_ACTIVE_BOOTSTRAP_SAMPLES,
                bootstrapSeed: MAX_ACTIVE_BOOTSTRAP_SEED,
            },
        },
    };
}

function archive(): PoolRuleArchive {
    return {
        meta: meta(),
        snapshots: [snapshot("AAA", 5), snapshot("BBB", 4)],
        outcomes: [outcome("AAA", 0.1), outcome("BBB", 0.2)],
        eventRows: [],
    };
}

function hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashLines(lines: readonly string[]): string {
    return hash(`${lines.join("\n")}\n`);
}

function writeV3Archive(root: string): string {
    const runDir = join(root, "archive", "batch-open-score", "fixture-v3");
    mkdirSync(runDir, { recursive: true });
    const snapshots = archive().snapshots.map((row) => `${JSON.stringify(row)}\n`).join("");
    const outcomes = archive().outcomes.map((row) => `${JSON.stringify(row)}\n`).join("");
    const featureText = features().map((row) => `${JSON.stringify(row)}\n`).join("");
    const fileText: Record<string, string> = {
        "candidate-features.jsonl": featureText,
        "candidate-outcomes.jsonl": outcomes,
        "events-full.jsonl": "",
        "pool-snapshots.jsonl": snapshots,
        "report.txt": "fixture report",
    };
    for (const [filename, text] of Object.entries(fileText)) {
        writeFileSync(join(runDir, filename), text, "utf8");
    }
    const files: Record<string, string> = {};
    for (const filename of Object.keys(fileText).sort()) files[filename] = hash(fileText[filename]!);
    const archiveMeta = {
        ...meta(),
        files,
        postAssemblyFingerprint: hashLines(Object.keys(files).sort().map((filename) => `${filename}=${files[filename]}`)),
        featureSet: {
            schema: TOP_MEAN_CANDIDATE_FEATURES_SCHEMA,
            contractVersion: TOP_MEAN_FEATURE_CONTRACT_VERSION,
            formulaVersion: TOP_MEAN_FEATURE_FORMULA_VERSION,
            availabilityPolicy: TOP_MEAN_FEATURE_AVAILABILITY_POLICY,
            file: "candidate-features.jsonl",
            rowCount: 2,
            sha256: files["candidate-features.jsonl"],
            builderSourceSha256: "1".repeat(64),
            sources: {
                poolSnapshotsSha256: files["pool-snapshots.jsonl"],
                candidateOutcomesSha256: files["candidate-outcomes.jsonl"],
            },
            fields: [...TOP_MEAN_CAUSAL_FEATURE_FIELDS],
        },
    };
    writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(archiveMeta)}\n`, "utf8");
    return runDir;
}

describe("top-mean rule checker v3 feature join", () => {
    it("joins v3 rows, applies null-neutral ranking/filter semantics, and tracks reads", () => {
        const normalized = normalizeTopMeanArchive({
            archive: archive(),
            reportText: "fixture report",
            features: features(),
        });
        assert.equal(normalized.events[0]!.baseCandidates[0]!.features!.asset, "AAA");
        assert.equal(normalized.events[0]!.baseCandidates.find((candidate) => candidate.row.asset === "BBB")!.features!.priorCoverageSlope5, 1);
        const ranking = evaluateTopMeanCausalScreen({
            archive: normalized,
            window: "discovery",
            rule: (candidate) => candidate.priorCoverageSlope5 ?? candidate.score ?? 0,
        });
        assert.deepEqual(ranking.accessedV2Fields, ["priorCoverageSlope5"]);
        assert.equal(ranking.nullReads, 1);
        assert.equal(ranking.nullNeutralViolations, 0);
        assert.equal(ranking.changedEvents, 1);
        assert.equal(ranking.changedFullyObservedEvents, 0);
        assert.equal(ranking.changedPartiallyObservedEvents, 1);

        const filter = evaluateTopMeanCausalScreen({
            archive: normalized,
            window: "discovery",
            rule: (candidate) => candidate.priorSignedVoteDelta3 == null ? true : candidate.priorSignedVoteDelta3 > 0,
        });
        assert.deepEqual(filter.accessedV2Fields, ["priorSignedVoteDelta3"]);
        assert.equal(filter.nullReads, 1);
        assert.equal(filter.nullNeutralViolations, 0);

        const nonNeutral = evaluateTopMeanCausalScreen({
            archive: normalized,
            window: "discovery",
            rule: (candidate) => candidate.priorCoverageSlope5! > 0,
        });
        assert.deepEqual(nonNeutral.accessedV2Fields, ["priorCoverageSlope5"]);
        assert.equal(nonNeutral.nullReads, 1);
        assert.equal(nonNeutral.nullNeutralViolations, 1);

    });

    it("rejects a successor screen with zero V2 feature access", () => {
        const normalized = normalizeTopMeanArchive({ archive: archive(), reportText: "fixture report", features: features() });
        assert.throws(
            () => evaluateTopMeanCausalScreen({ archive: normalized, window: "discovery", rule: (candidate) => candidate.score! }),
            /RULE FAIL[\s\S]*check=rule\.v2\.no_feature_access/,
        );
    });

    it("keeps v2 archives closed to v2 properties and reports causal-only feature stats", () => {
        const v2 = normalizeTopMeanArchive({ archive: { ...archive(), meta: meta("top_mean_archive.v2") }, reportText: "fixture report" });
        assert.throws(
            () => evaluateTopMeanCausalScreen({ archive: v2, window: "discovery", rule: (candidate) => candidate.priorCoverageSlope5 ?? candidate.score ?? 0 }),
            /RULE FAIL.*forbidden candidate field.*priorCoverageSlope5/s,
        );
        const normalized = normalizeTopMeanArchive({ archive: archive(), reportText: "fixture report", features: features() });
        const stats = computeTopMeanFeatureStats({
            runId: normalized.runId,
            meta: normalized.meta,
            catalogAssets: normalized.catalogAssets,
            events: normalized.events,
        }, "discovery");
        assert.equal(stats.baseCandidateCount, 2);
        assert.equal(stats.fields.priorCoverageSlope5.nonNull, 1);
        assert.equal(stats.fields.priorCoverageSlope5.nullCount, 1);
        assert.equal(stats.priorTopMeanReturnMean3Availability.zero, 0);
        assert.equal(Object.keys(stats.crossFeatureCorrelations).length, 12);
    });

    it("validates v3 hashes on normal loads and does not open outcomes for causal loads", () => {
        const root = mkdtempSync(join(tmpdir(), "top-mean-checker-v3-"));
        try {
            const runDir = writeV3Archive(root);
            const normalized = loadNormalizedTopMeanArchiveFromDirectory(runDir);
            assert.equal(normalized.events[0]!.baseCandidates.find((candidate) => candidate.row.asset === "BBB")!.features!.priorScoreStdDev5, 0.1);
            const featurePath = join(runDir, "candidate-features.jsonl");
            const originalFeatureBytes = readFileSync(featurePath);
            const tamperedFeatureBytes = Buffer.from(originalFeatureBytes);
            tamperedFeatureBytes[0] = tamperedFeatureBytes[0] === 0x7b ? 0x5b : 0x7b;
            writeFileSync(featurePath, tamperedFeatureBytes);
            assert.throws(() => loadNormalizedTopMeanArchiveFromDirectory(runDir), /meta\.files\.candidate-features\.jsonl\.sha256/);
            writeFileSync(featurePath, originalFeatureBytes);
            const esno = join(process.cwd(), "../../../node_modules/esno/esno.js");
            const checker = join(process.cwd(), "scripts/top-mean-rule-checker.ts");
            const ruleFile = join(root, "v2-rule.ts");
            writeFileSync(ruleFile, "export default (cand) => cand.priorCoverageSlope5 ?? cand.score;\n", "utf8");
            unlinkSync(join(runDir, "candidate-outcomes.jsonl"));
            const featureStats = spawnSync(process.execPath, [esno, checker, runDir, "--feature-stats", "--window", "discovery"], { encoding: "utf8" });
            assert.equal(featureStats.status, 0, featureStats.stderr);
            assert.match(featureStats.stdout, /TOP_MEAN RULE CHECKER \| mode=feature-stats/);
            assert.match(featureStats.stdout, /FEATURE \| name=priorCoverageSlope5/);
            const causal = loadCausalTopMeanArchiveFromDirectory(runDir);
            const stats = computeTopMeanFeatureStats(causal, "discovery");
            assert.equal(stats.baseCandidateCount, 2);
            const screen = spawnSync(process.execPath, [esno, checker, runDir, ruleFile, "--screen", "--window", "discovery"], { encoding: "utf8" });
            assert.equal(screen.status, 0, screen.stderr);
            assert.match(screen.stdout, /access \| v2Fields=priorCoverageSlope5/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
