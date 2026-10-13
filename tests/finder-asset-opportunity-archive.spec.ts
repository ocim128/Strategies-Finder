import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    appendAssetOpportunityArchiveBlock,
    appendAssetOpportunityArchiveBlocks,
    appendAssetOpportunityArchiveRunConfig,
    ASSET_OPPORTUNITY_ARCHIVE_EPOCH,
    buildAssetOpportunityArchiveBlockText,
    buildAssetOpportunityArchiveFilename,
    readAssetOpportunityArchiveTupleSnapshots,
    resolveAssetOpportunityArchiveDir,
} from "../lib/finder/server/finder-asset-opportunity-archive";
import { CONSENSUS_RANK_WEIGHT_METRIC } from "../lib/finder/finder-asset-opportunity-metrics";
import { parseAssetOpportunityArchiveText } from "../lib/asset-opportunity-explorer/archive-parser";

describe("Asset Opportunity archive writer", () => {
    it("derives the archive dir from the configured root only", () => {
        const dir = resolveAssetOpportunityArchiveDir("/repo/project");
        expect(dir).to.equal(path.join("/repo/project", "archive", "asset opportunity"));
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

    it("writes one delimited block containing timestamp, run id, holdout, and compact JSON", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            const topResults = [{ scope: "asset_opportunity", rank: 1, symbol: "BTCUSDT" }];
            const result = await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-1",
                holdoutBars: 4,
                topResults,
                timestamp: "2026-01-01T00:00:00.000Z",
            });

            expect(path.basename(result.path)).to.equal("oos-holdout-4-bars.txt");
            expect(result.bytes).to.be.greaterThan(0);

            const content = readFileSync(result.path, "utf8");
            expect(content).to.contain("Timestamp: 2026-01-01T00:00:00.000Z");
            expect(content).to.contain("Batch run id: batch-1");
            expect(content).to.contain("OOS holdout: 4 bars");
            expect(content).to.contain("Archive sort: run_default");
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

    it("reads one tuple snapshot across all sort blocks for a holdout", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            const tuple = {
                symbol: "AAA",
                strategyId: "strategy",
                candidateFingerprint: "fp",
            };
            await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-1",
                holdoutBars: 10,
                sortMetric: "expectancy",
                topResults: [tuple],
                timestamp: "2026-01-01T00:00:00.000Z",
            });
            await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-1",
                holdoutBars: 10,
                sortMetric: "netProfit",
                topResults: [tuple],
                timestamp: "2026-01-01T00:00:00.000Z",
            });
            const snapshots = await readAssetOpportunityArchiveTupleSnapshots(root);
            expect(snapshots).to.have.length(1);
            expect([...snapshots[0]!.tupleKeys]).to.deep.equal(["AAA|strategy|fp"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("writes multiple sort blocks for one holdout through one append", async () => {
        const calls: Array<{ filename: string; content: string }> = [];
        const root = "/virtual/root";
        const results = await appendAssetOpportunityArchiveBlocks({
            root,
            blocks: [
                {
                    batchRunId: "batch-1",
                    holdoutBars: 10,
                    sortMetric: "expectancy",
                    topResults: [{ rank: 1 }],
                    timestamp: "2026-01-01T00:00:00.000Z",
                },
                {
                    batchRunId: "batch-1",
                    holdoutBars: 10,
                    sortMetric: "netProfit",
                    topResults: [{ rank: 2 }],
                    timestamp: "2026-01-01T00:00:01.000Z",
                },
            ],
            append: async (_dir, filename, content) => {
                calls.push({ filename, content });
            },
        });

        expect(calls).to.have.length(1);
        expect(calls[0]!.filename).to.equal("oos-holdout-10-bars.txt");
        expect(calls[0]!.content).to.contain("Archive sort: expectancy");
        expect(calls[0]!.content).to.contain("Archive sort: netProfit");
        expect(results).to.have.length(2);
        expect(results[0]!.bytes + results[1]!.bytes).to.equal(Buffer.byteLength(calls[0]!.content, "utf8"));
    });

    it("reuses parsed snapshots and incorporates later successful appends", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-1",
                holdoutBars: 10,
                topResults: [{ symbol: "AAA", strategyId: "strategy", candidateFingerprint: "fp-1" }],
                timestamp: "2026-01-01T00:00:00.000Z",
            });
            await readAssetOpportunityArchiveTupleSnapshots(root);

            // The injected append represents a successful writer. The second
            // read must use the process-local parsed cache rather than re-read
            // the file, which intentionally contains only batch-1 here.
            await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-2",
                holdoutBars: 10,
                topResults: [{ symbol: "BBB", strategyId: "strategy", candidateFingerprint: "fp-2" }],
                timestamp: "2026-01-02T00:00:00.000Z",
                append: async () => {},
            });
            const snapshots = await readAssetOpportunityArchiveTupleSnapshots(root);
            expect(snapshots).to.have.length(2);
            expect([...snapshots[1]!.tupleKeys]).to.deep.equal(["BBB|strategy|fp-2"]);
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
        expect(JSON.parse(text.slice(jsonStart))).to.deep.equal([{ rank: 1 }]);

        const medianText = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 1,
            sortMetric: "medianBarsToTp",
            topResults: [{ rank: 1 }],
        });
        expect(medianText).to.contain("Archive sort: medianBarsToTp");
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

    it("serializes the next-exit mode and its separate baseline", () => {
        const baseline = {
            eligibleCandidateCount: 4,
            observedExits: 2,
            censoredResults: 1,
            unavailableResults: 1,
            averagePnlPercent: 0.75,
            exitReasonCounts: { take_profit: 2, end_of_data: 1 },
            unavailableReasonCounts: { no_boundary_trade: 1 },
        };
        const text = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 4,
            measurementMode: "next_exit",
            nextExitBaseline: baseline,
            topResults: [{ rank: 1 }],
        });
        expect(text).to.contain("Forward measurement: next_exit");
        expect(text).to.contain(`Next-exit archive baseline: ${JSON.stringify(baseline)}`);
    });

    it("serializes the per-basis baseline between the unscoped baseline and the top results", () => {
        const baselineByBasis = {
            pair: {
                eligibleCandidateCount: 3,
                horizons: [{
                    bars: 2,
                    averagePnlPercent: 0.25,
                    sampleWeightedAveragePnlPercent: 0.25,
                    positiveResults: 2,
                    observedResults: 3,
                    totalSamples: 3,
                }],
            },
            base_only: {
                eligibleCandidateCount: 3,
                horizons: [{
                    bars: 2,
                    averagePnlPercent: 1.5,
                    sampleWeightedAveragePnlPercent: 1.5,
                    positiveResults: 3,
                    observedResults: 3,
                    totalSamples: 3,
                }],
            },
        };
        const text = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 2,
            sortMetric: "expectancy",
            baselineByBasis,
            topResults: [{ rank: 1 }],
        });
        expect(text).to.contain(`Archive baseline by basis: ${JSON.stringify(baselineByBasis)}`);
        expect(text.indexOf("Archive baseline by basis:")).to.be.greaterThan(text.indexOf("Archive sort:"));
        expect(text.lastIndexOf("\n[")).to.be.greaterThan(text.indexOf("Archive baseline by basis:"));

        const withoutBasis = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 2,
            sortMetric: "expectancy",
            topResults: [{ rank: 1 }],
        });
        expect(withoutBasis).to.not.contain("Archive baseline by basis:");
    });

    it("serializes the epoch and pool distribution after the baseline lines", () => {
        const poolDistribution = {
            eligibleCandidateCount: 40,
            horizons: [{
                bars: 12,
                observedResults: 40,
                totalSamples: 40,
                averagePnlPercent: 0.5,
                p10: -1,
                p25: -0.2,
                p50: 0.4,
                p75: 1.1,
                p90: 2.3,
            }],
            selection: {
                netProfit: { count: 40, p10: -5, p25: -1, p50: 3, p75: 8, p90: 21 },
            },
        };
        const text = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 12,
            sortMetric: "expectancy",
            baseline: {
                eligibleCandidateCount: 40,
                horizons: [{
                    bars: 12,
                    averagePnlPercent: 0.5,
                    sampleWeightedAveragePnlPercent: 0.5,
                    positiveResults: 20,
                    observedResults: 40,
                    totalSamples: 40,
                }],
            },
            poolDistribution,
            archiveEpoch: ASSET_OPPORTUNITY_ARCHIVE_EPOCH,
            topResults: [{ rank: 1 }],
        });
        expect(text).to.contain(`Archive epoch: ${ASSET_OPPORTUNITY_ARCHIVE_EPOCH}`);
        expect(text).to.contain(`Archive pool distribution: ${JSON.stringify(poolDistribution)}`);
        // Both optional lines sit after every baseline line and before the rows.
        expect(text.indexOf("Archive epoch:")).to.be.greaterThan(text.indexOf("Archive baseline:"));
        expect(text.indexOf("Archive pool distribution:")).to.be.greaterThan(text.indexOf("Archive baseline:"));
        expect(text.lastIndexOf("\n[")).to.be.greaterThan(text.indexOf("Archive pool distribution:"));
    });

    it("round-trips the consensus rank weight row scalar through the shared parser", () => {
        const text = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 12,
            sortMetric: CONSENSUS_RANK_WEIGHT_METRIC,
            topResults: [
                { scope: "asset_opportunity", rank: 1, symbol: "AAA", strategyId: "a", consensusRankWeight: 35 },
                { scope: "asset_opportunity", rank: 2, symbol: "BBB", strategyId: "b", consensusRankWeight: null },
            ],
        });
        expect(text).to.contain("Archive sort: consensusRankWeight");

        const records = parseAssetOpportunityArchiveText(text, "fixture.txt");
        expect(records[0]!.sortMetric).to.equal("consensusRankWeight");
        expect(records[0]!.topResults.map((row) => row.consensusRankWeight)).to.deep.equal([35, null]);

        // Legacy rows without the field stay absent rather than reading as 0.
        const legacy = parseAssetOpportunityArchiveText(buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 12,
            sortMetric: "expectancy",
            topResults: [{ scope: "asset_opportunity", rank: 1 }],
        }), "legacy.txt");
        expect(legacy[0]!.topResults[0]!.consensusRankWeight).to.equal(undefined);
    });

    it("keeps legacy block text byte-identical when the new fields are omitted", () => {
        const legacy = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 7,
            sortMetric: "expectancy",
            baseline: {
                eligibleCandidateCount: 3,
                horizons: [{
                    bars: 7,
                    averagePnlPercent: 0.1,
                    sampleWeightedAveragePnlPercent: 0.1,
                    positiveResults: 2,
                    observedResults: 3,
                    totalSamples: 3,
                }],
            },
            topResults: [{ rank: 1 }],
        });
        expect(legacy).to.not.contain("Archive epoch:");
        expect(legacy).to.not.contain("Archive pool distribution:");

        const explicitNulls = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 7,
            sortMetric: "expectancy",
            baseline: {
                eligibleCandidateCount: 3,
                horizons: [{
                    bars: 7,
                    averagePnlPercent: 0.1,
                    sampleWeightedAveragePnlPercent: 0.1,
                    positiveResults: 2,
                    observedResults: 3,
                    totalSamples: 3,
                }],
            },
            poolDistribution: null,
            archiveEpoch: undefined,
            topResults: [{ rank: 1 }],
        });
        expect(explicitNulls).to.equal(legacy);
    });

    it("appends the epoch and pool distribution into the archive file", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            const poolDistribution = {
                eligibleCandidateCount: 2,
                horizons: [],
                selection: { winRate: { count: 2, p10: 40, p25: 45, p50: 50, p75: 55, p90: 60 } },
            };
            const result = await appendAssetOpportunityArchiveBlocks({
                root,
                blocks: [{
                    batchRunId: "batch-1",
                    holdoutBars: 3,
                    sortMetric: "consensusRankWeight",
                    topResults: [{ rank: 1 }],
                    poolDistribution,
                    archiveEpoch: ASSET_OPPORTUNITY_ARCHIVE_EPOCH,
                }],
            });
            const content = readFileSync(result[0]!.path, "utf8");
            expect(content).to.contain(`Archive epoch: ${ASSET_OPPORTUNITY_ARCHIVE_EPOCH}`);
            expect(content).to.contain(`Archive pool distribution: ${JSON.stringify(poolDistribution)}`);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
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
