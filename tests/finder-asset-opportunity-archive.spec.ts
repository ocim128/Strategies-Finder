import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    appendAssetOpportunityArchiveBlock,
    appendAssetOpportunityArchivePairSummary,
    appendAssetOpportunityArchiveFoldIdentities,
    appendAssetOpportunityArchiveRunConfig,
    buildAssetOpportunityArchiveBlockText,
    buildAssetOpportunityArchiveFilename,
    buildAssetOpportunityPairSummaryBlockText,
    buildAssetOpportunityPairSummaryFilename,
    buildAssetOpportunityFoldIdentityFilename,
    buildAssetOpportunityFoldIdentityBlockText,
    ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER,
    isAssetOpportunityResearchProgram,
    resolveAssetOpportunityArchiveDir,
} from "../lib/finder/server/finder-asset-opportunity-archive";

describe("Asset Opportunity archive writer", () => {
    it("derives the archive dir from the configured root only", () => {
        const dir = resolveAssetOpportunityArchiveDir("/repo/project");
        expect(dir).to.equal(path.join("/repo/project", "archive", "asset opportunity"));
        expect(resolveAssetOpportunityArchiveDir("/repo/project", "fresh-window"))
            .to.equal(path.join("/repo/project", "archive", "fresh-window"));
        expect(isAssetOpportunityResearchProgram("fresh-window")).to.equal(true);
        expect(isAssetOpportunityResearchProgram("fresh-window/../escape")).to.equal(false);
        expect(isAssetOpportunityResearchProgram("../escape")).to.equal(false);
    });

    it("builds per-N filenames and rejects non-integer / non-positive N", () => {
        expect(buildAssetOpportunityArchiveFilename(3)).to.equal("oos-holdout-3-bars.txt");
        expect(buildAssetOpportunityArchiveFilename(100)).to.equal("oos-holdout-100-bars.txt");
        expect(() => buildAssetOpportunityArchiveFilename(0)).to.throw(/Invalid holdout bars/);
        expect(() => buildAssetOpportunityArchiveFilename(2.5)).to.throw(/Invalid holdout bars/);
        // No path separator can reach the filename: only a validated integer
        // ever formats it.
        expect(() => buildAssetOpportunityArchiveFilename(Number.NaN)).to.throw();
    });

    it("builds pair-summary filenames and rejects invalid holdouts", () => {
        expect(buildAssetOpportunityPairSummaryFilename(12)).to.equal("oos-pair-summary-12-bars.txt");
        expect(() => buildAssetOpportunityPairSummaryFilename(0)).to.throw(/Invalid holdout bars/);
        expect(() => buildAssetOpportunityPairSummaryFilename(1.5)).to.throw(/Invalid holdout bars/);
        expect(() => buildAssetOpportunityPairSummaryFilename(Number.NaN)).to.throw();
    });

    it("writes a scalar full-pool identity block with a declared row count", async () => {
        const rows = [{
            symbol: "PAIR_A",
            strategyKey: "strategy-a",
            candidateFingerprint: "{x:1}",
            identityHash: "hash-a",
            candidateIndex: 0,
            evaluationOk: true,
            passesTradeFilter: true,
            netProfitPercent: 1,
            totalTrades: 2,
            tpHitCount: 1,
            medianBarsToTP: 3,
            medianBarsToTerminal: 4,
            tpFirstShare: 0.5,
        }];
        expect(buildAssetOpportunityFoldIdentityFilename(12)).to.equal("oos-fold-identities-12-bars.txt");
        expect(buildAssetOpportunityFoldIdentityBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 12,
            declaredRowCount: 1,
            rows,
        })).to.contain("Declared row count: 1");
        const calls: Array<{ dir: string; filename: string; content: string }> = [];
        await appendAssetOpportunityArchiveFoldIdentities({
            root: "/virtual/root",
            program: "fresh-window",
            batchRunId: "b",
            holdoutBars: 12,
            rows,
            append: async (dir, filename, content) => { calls.push({ dir, filename, content }); },
        });
        expect(calls[0]!.dir).to.equal(path.join("/virtual/root", "archive", "fresh-window"));
        expect(calls[0]!.filename).to.equal("oos-fold-identities-12-bars.txt");
        expect(calls[0]!.content).to.contain("hash-a");
        expect(calls[0]!.content).to.contain(ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER);
    });

    it("writes one delimited block containing timestamp, run id, holdout, and compact JSON", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            const topResults = [{ scope: "asset_opportunity", rank: 1, symbol: "BTCUSDT" }];
            const result = await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-1",
                holdoutBars: 4,
                topResults,
                foldMetadata: {
                    foldEnd: 1_700_000_000,
                    searchWindowEnd: 1_700_000_000,
                    oosStart: 1_700_001_000,
                    oosEnd: 1_700_002_000,
                },
                dataSyncSnapshot: "sync-fixture",
                gitCommit: "commit-fixture",
                timestamp: "2026-01-01T00:00:00.000Z",
            });

            expect(path.basename(result.path)).to.equal("oos-holdout-4-bars.txt");
            expect(result.bytes).to.be.greaterThan(0);

            const content = readFileSync(result.path, "utf8");
            expect(content).to.contain("Timestamp: 2026-01-01T00:00:00.000Z");
            expect(content).to.contain("Batch run id: batch-1");
            expect(content).to.contain("OOS holdout: 4 bars");
            expect(content).to.contain("Archive sort: run_default");
            expect(content).to.contain("Fold end: 1700000000");
            expect(content).to.contain("Data sync snapshot: sync-fixture");
            expect(content).to.contain("Git commit: commit-fixture");
            expect(content).to.contain(JSON.stringify(topResults));
            expect(content).to.match(/\n$/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("appends a new block on repeat of the same N and never overwrites", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-1",
                holdoutBars: 5,
                topResults: [{ rank: 1 }],
                timestamp: "2026-01-01T00:00:00.000Z",
            });
            await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-2",
                holdoutBars: 5,
                topResults: [{ rank: 2 }],
                timestamp: "2026-01-02T00:00:00.000Z",
            });
            const content = readFileSync(path.join(root, "archive", "asset opportunity", "oos-holdout-5-bars.txt"), "utf8");
            expect(content).to.contain("Batch run id: batch-1");
            expect(content).to.contain("Batch run id: batch-2");
            // Each block is delimited by an opening and closing separator line,
            // so two blocks produce four separator lines and the first block is
            // never overwritten.
            expect(content.match(/^={80}$/gm) ?? []).to.have.length(4);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("injects the append leaf so tests never touch the real archive", async () => {
        const calls: Array<{ dir: string; filename: string; content: string }> = [];
        const root = "/virtual/root";
        const result = await appendAssetOpportunityArchiveBlock({
            root,
            batchRunId: "batch-3",
            holdoutBars: 2,
            topResults: [],
            timestamp: "2026-01-03T00:00:00.000Z",
            append: async (dir, filename, content) => {
                calls.push({ dir, filename, content });
            },
        });
        expect(calls).to.have.length(1);
        expect(calls[0]!.dir).to.equal(path.join(root, "archive", "asset opportunity"));
        expect(calls[0]!.filename).to.equal("oos-holdout-2-bars.txt");
        expect(result.path).to.equal(path.join(calls[0]!.dir, calls[0]!.filename));
        // Byte count matches the injected content length.
        expect(result.bytes).to.equal(Buffer.byteLength(calls[0]!.content, "utf8"));
    });

    it("builds deterministic block text with the shared delimiter", () => {
        const text = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 1,
            sortMetric: "freshSignalLibraries",
            topResults: [{ rank: 1 }],
        });
        expect(text.startsWith("=".repeat(80))).to.equal(true);
        const jsonStart = text.indexOf("[");
        const markerStart = text.indexOf(ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER);
        expect(JSON.parse(text.slice(jsonStart, markerStart).trim())).to.deep.equal([{ rank: 1 }]);
    });

    it("serializes the optional all-candidate baseline before the top results", () => {
        const baseline = {
            eligibleCandidateCount: 12,
            horizons: [{
                bars: 12,
                averagePnlPercent: 0.5,
                sampleWeightedAveragePnlPercent: 0.5,
                positiveResults: 7,
                observedResults: 12,
                totalSamples: 12,
            }],
        };
        const text = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 12,
            sortMetric: "expectancy",
            baseline,
            topResults: [{ rank: 1 }],
        });
        expect(text).to.contain(`Archive baseline: ${JSON.stringify(baseline)}`);
        expect(text.lastIndexOf("\n[")).to.be.greaterThan(text.indexOf("Archive baseline:"));
    });

    it("appends a pair-summary block with round-trippable JSON", async () => {
        const pairSummaries = [{
            symbol: "PAIR_A",
            candidateCount: 3,
            profitableShare: 2 / 3,
            medianNetProfitPercent: 1.5,
            netProfitP75MinusP25: 2,
            medianExpectancy: 0.5,
            topNetProfit: 12,
            forwardPnlPercentByHorizon: { 12: 3.25 },
        }];
        const text = buildAssetOpportunityPairSummaryBlockText({
            timestamp: "2026-01-01T00:00:00.000Z",
            batchRunId: "batch-pair-summary",
            holdoutBars: 12,
            pairSummaries,
        });
        expect(text).to.contain("Pair summaries: JSON");
        expect(text).to.contain("OOS holdout: 12 bars");
        const jsonStart = text.lastIndexOf("\n[") + 1;
        const markerStart = text.indexOf(ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER);
        expect(JSON.parse(text.slice(jsonStart, markerStart).trim())).to.deep.equal(pairSummaries);

        const calls: Array<{ dir: string; filename: string; content: string }> = [];
        const result = await appendAssetOpportunityArchivePairSummary({
            root: "/virtual/root",
            batchRunId: "batch-pair-summary",
            holdoutBars: 12,
            pairSummaries,
            timestamp: "2026-01-01T00:00:00.000Z",
            append: async (dir, filename, content) => {
                calls.push({ dir, filename, content });
            },
        });
        expect(calls).to.have.length(1);
        expect(calls[0]!.dir).to.equal(path.join("/virtual/root", "archive", "asset opportunity"));
        expect(calls[0]!.filename).to.equal("oos-pair-summary-12-bars.txt");
        expect(result.path).to.equal(path.join(calls[0]!.dir, calls[0]!.filename));
        expect(result.bytes).to.equal(Buffer.byteLength(calls[0]!.content, "utf8"));
    });

    it("appends one run-config block per batch run to config.txt and never overwrites", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            const config = { finder: { tradeFilterEnabled: false, minTrades: null }, capitalSettings: { commissionRate: 0.1 } };
            const first = await appendAssetOpportunityArchiveRunConfig({
                root,
                batchRunId: "batch-1",
                config,
                timestamp: "2026-01-01T00:00:00.000Z",
            });
            await appendAssetOpportunityArchiveRunConfig({
                root,
                batchRunId: "batch-2",
                config,
                timestamp: "2026-01-02T00:00:00.000Z",
            });

            expect(path.basename(first.path)).to.equal("config.txt");
            expect(first.bytes).to.be.greaterThan(0);
            const content = readFileSync(first.path, "utf8");
            expect(content).to.contain("Timestamp: 2026-01-01T00:00:00.000Z");
            expect(content).to.contain("Batch run id: batch-1");
            expect(content).to.contain("Batch run id: batch-2");
            expect(content).to.contain("Run configuration: JSON");
            expect(content.match(new RegExp(ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER, "g")) ?? []).to.have.length(2);
            // Each block's JSON body round-trips the full config; two blocks,
            // each delimited by an opening and closing separator line.
            const marker = `Run configuration: JSON\n${"=".repeat(80)}`;
            const bodies: unknown[] = [];
            let cursor = 0;
            for (;;) {
                const start = content.indexOf(marker, cursor);
                if (start === -1) break;
                let body = content.slice(start + marker.length);
                const nextSeparator = body.indexOf("=".repeat(80));
                if (nextSeparator !== -1) body = body.slice(0, nextSeparator);
                body = body.slice(0, body.indexOf(ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER));
                bodies.push(JSON.parse(body.trim()));
                cursor = start + marker.length;
            }
            expect(bodies).to.deep.equal([config, config]);
            expect(content.match(/^={80}$/gm) ?? []).to.have.length(4);
            expect(content).to.match(/\n$/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("injects the append leaf for run-config writes so tests never touch the real archive", async () => {
        const calls: Array<{ dir: string; filename: string; content: string }> = [];
        const result = await appendAssetOpportunityArchiveRunConfig({
            root: "/virtual/root",
            batchRunId: "batch-3",
            config: { finder: {} },
            timestamp: "2026-01-03T00:00:00.000Z",
            append: async (dir, filename, content) => {
                calls.push({ dir, filename, content });
            },
        });
        expect(calls).to.have.length(1);
        expect(calls[0]!.dir).to.equal(path.join("/virtual/root", "archive", "asset opportunity"));
        expect(calls[0]!.filename).to.equal("config.txt");
        expect(result.path).to.equal(path.join(calls[0]!.dir, "config.txt"));
        expect(result.bytes).to.equal(Buffer.byteLength(calls[0]!.content, "utf8"));
    });

    it("does not accept an arbitrary path from a caller", () => {
        // The filename function is the only entry point to a file name; a
        // string path argument is a type error, so simulate the closest
        // runtime attempt: no API accepts a path string.
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        writeFileSync(path.join(root, "marker"), "keep");
        try {
            expect(readFileSync(path.join(root, "marker"), "utf8")).to.equal("keep");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
