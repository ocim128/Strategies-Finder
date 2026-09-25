import { expect } from "chai";
import { describe, it } from "node:test";
import {
    parseAssetOpportunityArchiveText,
} from "../lib/asset-opportunity-explorer/archive-parser";
import {
    ExplorerAnalysisError,
    buildExplorerView,
    buildHeatmapSnapshot,
    buildRangeDetails,
    keepLatestCompactBlock,
    compactRunRecord,
    resolveExplorerColumns,
    summarizeRunCatalog,
} from "../lib/asset-opportunity-explorer/analysis";

function archiveRow(args: {
    rank: number;
    horizons: Array<{ bars: number; averagePnlPercent: number | null; sampleSize: number }>;
    symbol?: string;
    strategyId?: string;
    strategyName?: string;
    candidateFingerprint?: string;
    basis?: string;
}): Record<string, unknown> {
    return {
        scope: "asset_opportunity",
        rank: args.rank,
        symbol: args.symbol ?? "AAA",
        strategyId: args.strategyId ?? "strategy_a",
        strategyName: args.strategyName ?? "Strategy A",
        ...(args.candidateFingerprint === undefined ? {} : { candidateFingerprint: args.candidateFingerprint }),
        forwardOosPerformance: {
            ignoreLastBars: 12,
            ...(args.basis === undefined ? {} : { basis: args.basis }),
            horizons: args.horizons.map((horizon) => ({
                bars: horizon.bars,
                pnlPercent: horizon.averagePnlPercent,
                averagePnlPercent: horizon.averagePnlPercent,
                winRatePercent: null,
                sampleSize: horizon.sampleSize,
            })),
        },
    };
}

function block(args: {
    timestamp: string;
    runId: string;
    holdoutBars: number;
    sortMetric: string;
    rows: unknown[];
    baseline?: unknown;
    measurementMode?: string;
}): string {
    return [
        "=".repeat(80),
        `Timestamp: ${args.timestamp}`,
        `Batch run id: ${args.runId}`,
        `OOS holdout: ${args.holdoutBars} bars`,
        `Archive sort: ${args.sortMetric}`,
        ...(args.measurementMode === undefined ? [] : [`Forward measurement: ${args.measurementMode}`]),
        ...(args.baseline === undefined ? [] : [`Archive baseline: ${JSON.stringify(args.baseline)}`]),
        "=".repeat(80),
        JSON.stringify(args.rows),
        "=".repeat(80),
    ].join("\n");
}

function baseline(horizons: Array<{ bars: number; averagePnlPercent: number | null }>): unknown {
    return {
        eligibleCandidateCount: 50,
        horizons: horizons.map((horizon) => ({
            bars: horizon.bars,
            averagePnlPercent: horizon.averagePnlPercent,
            sampleWeightedAveragePnlPercent: horizon.averagePnlPercent,
            positiveResults: 1,
            observedResults: 2,
            totalSamples: 2,
        })),
    };
}

describe("Asset Opportunity Explorer analysis", () => {
    it("keeps legacy parsing behavior including CRLF normalization", () => {
        const text = block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run-a",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [archiveRow({ rank: 1, horizons: [{ bars: 12, averagePnlPercent: 1.5, sampleSize: 1 }] })],
        }).replace(/\n/g, "\r\n");
        const records = parseAssetOpportunityArchiveText(text, "fixture.txt");

        expect(records).to.have.length(1);
        expect(records[0]!.holdoutBars).to.equal(12);
        const legacyHorizons = records[0]!.topResults[0]!.forwardOosPerformance?.horizons ?? [];
        expect(legacyHorizons[0]?.averagePnlPercent).to.equal(1.5);
        // Legacy rows carry no explicit basis; it must stay absent, not guessed.
        expect(records[0]!.topResults[0]!.forwardOosPerformance?.basis).to.equal(undefined);
    });

    it("preserves the optional forwardOosPerformance.basis measurement metadata", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run-a",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [archiveRow({
                rank: 1,
                basis: "base_only",
                horizons: [{ bars: 12, averagePnlPercent: 1, sampleSize: 1 }],
            })],
        }));

        expect(records[0]!.topResults[0]!.forwardOosPerformance?.basis).to.equal("base_only");
    });

    it("deduplicates blocks only after filtering by batch run, keeping the latest timestamp", () => {
        const records = parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-09-25T00:00:00.000Z",
                runId: "run-old",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 12, averagePnlPercent: 99, sampleSize: 1 }] })],
            }),
            block({
                timestamp: "2026-09-25T01:00:00.000Z",
                runId: "run-new",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 12, averagePnlPercent: 5, sampleSize: 1 }] })],
            }),
            // Same block repeated inside one run: latest wins.
            block({
                timestamp: "2026-09-25T02:00:00.000Z",
                runId: "run-new",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 12, averagePnlPercent: 7, sampleSize: 1 }] })],
            }),
            block({
                timestamp: "2026-09-25T01:30:00.000Z",
                runId: "run-new",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 12, averagePnlPercent: 3, sampleSize: 1 }] })],
            }),
        ].join("\n"));

        const view = buildExplorerView(records, "run-new");
        expect(view.blocks).to.have.length(1);
        expect(view.blocks[0]!.rows[0]!.horizons[0]!.averagePnlPercent).to.equal(7);
        // Equal timestamps keep the last-encountered block under filename order.
        const tiedBlocks = new Map<string, ReturnType<typeof compactRunRecord>>();
        for (const record of parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-09-25T01:00:00.000Z",
                runId: "run",
                holdoutBars: 6,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] })],
            }),
            block({
                timestamp: "2026-09-25T01:00:00.000Z",
                runId: "run",
                holdoutBars: 6,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 2, sampleSize: 1 }] })],
            }),
        ].join("\n"))) {
            keepLatestCompactBlock(tiedBlocks, compactRunRecord(record));
        }
        const tied = [...tiedBlocks.values()];
        expect(tied).to.have.length(1);
        expect(tied[0]!.rows[0]!.horizons[0]!.averagePnlPercent).to.equal(2);
    });

    it("catalogs runs newest-first with support, horizons, and rank limits", () => {
        const catalog = summarizeRunCatalog(parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-09-25T00:00:00.000Z",
                runId: "run-old",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] })],
            }),
            block({
                timestamp: "2026-09-25T02:00:00.000Z",
                runId: "run-next-exit",
                holdoutBars: 5,
                sortMetric: "expectancy",
                measurementMode: "next_exit",
                rows: [],
            }),
            block({
                timestamp: "2026-09-25T03:00:00.000Z",
                runId: "run-mixed",
                holdoutBars: 5,
                sortMetric: "expectancy",
                measurementMode: "next_exit",
                rows: [],
            }),
            block({
                timestamp: "2026-09-25T03:30:00.000Z",
                runId: "run-mixed",
                holdoutBars: 6,
                sortMetric: "expectancy",
                rows: [],
            }),
        ].join("\n")));

        expect(catalog.map((run) => run.batchRunId)).to.deep.equal(["run-mixed", "run-next-exit", "run-old"]);
        expect(catalog.find((run) => run.batchRunId === "run-mixed")!.support).to.equal("mixed_modes");
        expect(catalog.find((run) => run.batchRunId === "run-next-exit")!.support).to.equal("next_exit");
        expect(catalog.find((run) => run.batchRunId === "run-old")!.support).to.equal("fixed_horizon");
    });

    it("distinguishes null (unobserved) from zero (observed) cell outcomes", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [
                archiveRow({
                    rank: 1,
                    horizons: [
                        { bars: 6, averagePnlPercent: null, sampleSize: 0 },
                        { bars: 12, averagePnlPercent: null, sampleSize: 0 },
                    ],
                }),
                archiveRow({
                    rank: 2,
                    horizons: [
                        { bars: 6, averagePnlPercent: 0, sampleSize: 2 },
                        { bars: 12, averagePnlPercent: null, sampleSize: 3 },
                    ],
                }),
            ],
        }), "fixture.txt");
        const view = buildExplorerView(records, "run");
        const snapshot = buildHeatmapSnapshot(view, {
            batchRunId: "run",
            horizonBars: 6,
            topK: 2,
            spacing: "all",
            snapshotId: "s1",
        });

        const cell6 = snapshot.cells[0]!;
        expect(cell6.holdoutBars).to.equal(12);
        expect(cell6.actual).to.equal(0);
        expect(cell6.observedRows).to.equal(1);
        // The 12-bar horizon has no observable outcome: unavailable, never zero-filled.
        const cell12 = buildHeatmapSnapshot(view, {
            batchRunId: "run",
            horizonBars: 12,
            topK: 2,
            spacing: "all",
            snapshotId: "s2",
        }).cells[0]!;
        expect(cell12.actual).to.equal(null);
        expect(cell12.observedRows).to.equal(0);
    });

    it("selects ranks <= K with the array-position fallback and never backfills missing top ranks", () => {
        const records = parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-09-25T00:00:00.000Z",
                runId: "run",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [
                    // Rank 1 unobserved at the horizon; rank 2/3 observed.
                    archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: null, sampleSize: 0 }] }),
                    archiveRow({ rank: 2, horizons: [{ bars: 6, averagePnlPercent: 4, sampleSize: 1 }], candidateFingerprint: "fp-1" }),
                    archiveRow({ rank: 3, horizons: [{ bars: 6, averagePnlPercent: 6, sampleSize: 1 }], candidateFingerprint: "fp-2" }),
                ],
                baseline: baseline([{ bars: 6, averagePnlPercent: 1 }]),
            }),
        ].join("\n"));
        const view = buildExplorerView(records, "run");
        const snapshot = buildHeatmapSnapshot(view, {
            batchRunId: "run",
            horizonBars: 6,
            topK: 2,
            spacing: "all",
            snapshotId: "s1",
        });

        const cell = snapshot.cells[0]!;
        expect(cell.selectedRows).to.equal(2);
        expect(cell.observedRows).to.equal(1);
        expect(cell.actual).to.equal(4);
        expect(cell.baseline).to.equal(1);
        expect(cell.delta).to.equal(3);
        expect(snapshot.diagnostics.missingRows).to.equal(1);
        // Rank 3 stayed out: missing rank-2 outcome is not replaced by a lower rank.
        const wideK = buildHeatmapSnapshot(view, {
            batchRunId: "run",
            horizonBars: 6,
            topK: 3,
            spacing: "all",
            snapshotId: "s2",
        });
        expect(wideK.cells[0]!.actual).to.equal(5);
    });

    it("leaves delta unavailable without a block baseline while actual stays visible", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 2, sampleSize: 1 }] })],
        }));
        const view = buildExplorerView(records, "run");
        const snapshot = buildHeatmapSnapshot(view, {
            batchRunId: "run",
            horizonBars: 6,
            topK: 1,
            spacing: "all",
            snapshotId: "s1",
        });

        expect(snapshot.cells[0]!.actual).to.equal(2);
        expect(snapshot.cells[0]!.baseline).to.equal(null);
        expect(snapshot.cells[0]!.delta).to.equal(null);
    });

    it("counts missing fingerprints as unknown instead of confirmed matches", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [
                archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }], candidateFingerprint: "fp-1" }),
                archiveRow({ rank: 2, horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] }),
            ],
        }));
        const view = buildExplorerView(records, "run");
        const snapshot = buildHeatmapSnapshot(view, {
            batchRunId: "run",
            horizonBars: 6,
            topK: 2,
            spacing: "all",
            snapshotId: "s1",
        });

        expect(snapshot.diagnostics.unknownFingerprintRows).to.equal(1);
    });

    it("labels an unknown basis and rejects conflicting known bases in a compared run", () => {
        const legacy = buildExplorerView(parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] })],
        })), "run");
        const unknownBasis = buildHeatmapSnapshot(legacy, {
            batchRunId: "run",
            horizonBars: 6,
            topK: 1,
            spacing: "all",
            snapshotId: "s1",
        });
        expect(unknownBasis.basis).to.equal(null);
        expect(unknownBasis.diagnostics.notes.some((note) => note.includes("basis is unknown"))).to.equal(true);

        const conflicting = buildExplorerView(parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-09-25T00:00:00.000Z",
                runId: "run",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }], basis: "pair" })],
            }),
            block({
                timestamp: "2026-09-25T00:00:01.000Z",
                runId: "run",
                holdoutBars: 24,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }], basis: "base_only" })],
            }),
        ].join("\n")), "run");
        try {
            buildHeatmapSnapshot(conflicting, {
                batchRunId: "run",
                horizonBars: 6,
                topK: 1,
                spacing: "all",
                snapshotId: "s2",
            });
            expect.fail("conflicting bases must reject the snapshot");
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerAnalysisError);
            expect((error as ExplorerAnalysisError).status).to.equal(422);
        }
    });

    it("builds horizon-spaced columns greedily from the largest offset and keeps the set stable", () => {
        expect(resolveExplorerColumns([2, 50, 100, 200, 300, 480], "horizon", 100))
            .to.deep.equal([480, 300, 200, 100]);
        expect(resolveExplorerColumns([2, 50, 100, 200, 300, 480], "all", 100))
            .to.deep.equal([480, 300, 200, 100, 50, 2]);
        // Brushing cannot change the anchor: the same run always yields the same set.
        expect(resolveExplorerColumns([480, 300, 200, 100, 50, 2], "horizon", 100))
            .to.deep.equal([480, 300, 200, 100]);
    });

    it("rejects next-exit runs for the heatmap while still cataloging them", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run-next-exit",
            holdoutBars: 5,
            sortMetric: "expectancy",
            measurementMode: "next_exit",
            rows: [],
        }));
        const view = buildExplorerView(records, "run-next-exit");
        expect(view.support).to.equal("next_exit");
        expect(() => buildHeatmapSnapshot(view, {
            batchRunId: "run-next-exit",
            horizonBars: 2,
            topK: 1,
            spacing: "all",
            snapshotId: "s1",
        })).to.throw(ExplorerAnalysisError);
    });

    it("weights each holdout equally so cell means can differ from pooled-row means", () => {
        // Holdout 24: one selected row with value 10.
        // Holdout 12: three selected rows averaging 3 (values 0, 0, 9).
        // Pooled-row mean = (10 + 0 + 0 + 9) / 4 = 4.75.
        // Equal-holdout cell mean = (10 + 3) / 2 = 6.5.
        const records = parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-09-25T00:00:00.000Z",
                runId: "run",
                holdoutBars: 24,
                sortMetric: "expectancy",
                rows: [archiveRow({ rank: 1, symbol: "AAA", candidateFingerprint: "fp-a", horizons: [{ bars: 6, averagePnlPercent: 10, sampleSize: 1 }] })],
            }),
            block({
                timestamp: "2026-09-25T00:00:01.000Z",
                runId: "run",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [
                    archiveRow({ rank: 1, symbol: "BBB", candidateFingerprint: "fp-b", horizons: [{ bars: 6, averagePnlPercent: 0, sampleSize: 1 }] }),
                    archiveRow({ rank: 2, symbol: "CCC", candidateFingerprint: "fp-c", horizons: [{ bars: 6, averagePnlPercent: 0, sampleSize: 1 }] }),
                    archiveRow({ rank: 3, symbol: "DDD", candidateFingerprint: "fp-d", horizons: [{ bars: 6, averagePnlPercent: 9, sampleSize: 1 }] }),
                ],
            }),
        ].join("\n"));
        const view = buildExplorerView(records, "run");
        const details = buildRangeDetails({
            snapshotId: "s1",
            view,
            columns: [24, 12],
            topK: 3,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 12,
            holdoutTo: 24,
            metric: "actual",
            offset: 0,
            limit: 100,
        });

        expect(details.summary.totalHoldouts).to.equal(2);
        expect(details.summary.observedHoldouts).to.equal(2);
        expect(details.summary.mean).to.equal(6.5);
        expect(details.summary.median).to.equal(6.5);
        expect(details.summary.totalRows).to.equal(4);
        expect(details.summary.observedRows).to.equal(4);
        expect(details.summary.uniqueCandidates).to.equal(4);
        expect(details.totalRows).to.equal(4);
        expect(details.histogram.valuesCount).to.equal(2);
        expect(details.histogram.bins.reduce((sum, bin) => sum + bin.count, 0)).to.equal(2);
    });

    it("keeps range detail short of K visible as partial and pages evidence rows", () => {
        const rows = [1, 2, 3].map((rank) => archiveRow({
            rank,
            symbol: `SYM${rank}`,
            horizons: [{ bars: 6, averagePnlPercent: rank, sampleSize: 1 }],
        }));
        // Second holdout archives only two ranks: shorter than K stays partial.
        const records = parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-09-25T00:00:00.000Z",
                runId: "run",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows,
            }),
            block({
                timestamp: "2026-09-25T00:00:01.000Z",
                runId: "run",
                holdoutBars: 24,
                sortMetric: "expectancy",
                rows: rows.slice(0, 2),
            }),
        ].join("\n"));
        const view = buildExplorerView(records, "run");
        const details = buildRangeDetails({
            snapshotId: "s1",
            view,
            columns: [12, 24],
            topK: 3,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 12,
            holdoutTo: 24,
            metric: "actual",
            offset: 0,
            limit: 4,
        });

        expect(details.summary.totalRows).to.equal(5);
        expect(details.rows).to.have.length(4);
        expect(details.hasMore).to.equal(true);
        const rest = buildRangeDetails({
            snapshotId: "s1",
            view,
            columns: [12, 24],
            topK: 3,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 12,
            holdoutTo: 24,
            metric: "actual",
            offset: 4,
            limit: 4,
        });
        expect(rest.rows).to.have.length(1);
        expect(rest.hasMore).to.equal(false);
        // Delta pages report percentage-point units; unobserved rows stay null.
        const deltaDetails = buildRangeDetails({
            snapshotId: "s1",
            view,
            columns: [12, 24],
            topK: 3,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 12,
            holdoutTo: 24,
            metric: "delta",
            offset: 0,
            limit: 4,
        });
        expect(deltaDetails.unit).to.equal("pp");
        expect(deltaDetails.rows.every((row) => row.baseline === null)).to.equal(true);
    });

    it("rejects unknown sorts and empty holdout ranges for details", () => {
        const view = buildExplorerView(parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [archiveRow({ rank: 1, horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] })],
        })), "run");
        expect(() => buildRangeDetails({
            snapshotId: "s1",
            view,
            columns: [12],
            topK: 1,
            horizonBars: 6,
            sortMetric: "unknown_sort",
            holdoutFrom: 12,
            holdoutTo: 12,
            metric: "actual",
            offset: 0,
            limit: 100,
        })).to.throw(ExplorerAnalysisError);
        expect(() => buildRangeDetails({
            snapshotId: "s1",
            view,
            columns: [12],
            topK: 1,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 99,
            holdoutTo: 100,
            metric: "actual",
            offset: 0,
            limit: 100,
        })).to.throw(ExplorerAnalysisError);
    });

    it("counts only fingerprinted rows as confirmed unique candidate identities", () => {
        const records = parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-09-25T00:00:00.000Z",
                runId: "run",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [
                    // Same symbol+strategy twice with a fingerprint: one confirmed identity.
                    archiveRow({ rank: 1, symbol: "AAA", candidateFingerprint: "fp-1", horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] }),
                    archiveRow({ rank: 2, symbol: "AAA", candidateFingerprint: "fp-1", horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] }),
                ],
            }),
            block({
                timestamp: "2026-09-25T00:00:01.000Z",
                runId: "run",
                holdoutBars: 24,
                sortMetric: "expectancy",
                rows: [
                    // Two unknown-identity rows must not merge into a claimed match.
                    archiveRow({ rank: 1, symbol: "BBB", horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] }),
                    archiveRow({ rank: 2, symbol: "BBB", horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] }),
                ],
            }),
        ].join("\n"));
        const view = buildExplorerView(records, "run");
        const details = buildRangeDetails({
            snapshotId: "s1",
            view,
            columns: [12, 24],
            topK: 2,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 12,
            holdoutTo: 24,
            metric: "actual",
            offset: 0,
            limit: 100,
        });

        expect(details.summary.totalRows).to.equal(4);
        expect(details.summary.uniqueCandidates).to.equal(1);
        expect(details.summary.unknownFingerprintRows).to.equal(2);
    });

    it("builds a single valid bin for constant and single-observation ranges", () => {
        const constantRecords = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-25T00:00:00.000Z",
            runId: "run",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [archiveRow({ rank: 1, symbol: "AAA", candidateFingerprint: "fp-1", horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] })],
        }));
        const constantView = buildExplorerView(constantRecords, "run");
        const constant = buildRangeDetails({
            snapshotId: "s1",
            view: constantView,
            columns: [12],
            topK: 1,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 12,
            holdoutTo: 12,
            metric: "actual",
            offset: 0,
            limit: 100,
        });
        expect(constant.histogram.valuesCount).to.equal(1);
        expect(constant.histogram.bins).to.have.length(1);
        expect(constant.histogram.bins[0]).to.deep.equal({ from: 1, to: 1, count: 1 });

        // Several holdouts with the identical cell value: one bin, no inverted intervals.
        const allSame = parseAssetOpportunityArchiveText([12, 24, 36].map((holdoutBars, index) => block({
            timestamp: `2026-09-25T00:00:0${index}.000Z`,
            runId: "run",
            holdoutBars,
            sortMetric: "expectancy",
            rows: [archiveRow({ rank: 1, symbol: "AAA", candidateFingerprint: "fp-1", horizons: [{ bars: 6, averagePnlPercent: 1, sampleSize: 1 }] })],
        })).join("\n"));
        const allSameView = buildExplorerView(allSame, "run");
        const constantMulti = buildRangeDetails({
            snapshotId: "s1",
            view: allSameView,
            columns: [12, 24, 36],
            topK: 1,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 12,
            holdoutTo: 36,
            metric: "actual",
            offset: 0,
            limit: 100,
        });
        expect(constantMulti.histogram.bins).to.have.length(1);
        expect(constantMulti.histogram.bins[0]).to.deep.equal({ from: 1, to: 1, count: 3 });
        expect(constantMulti.summary.mean).to.equal(1);

        // Bins are always well-formed when the values do span.
        const varied = parseAssetOpportunityArchiveText([12, 24].map((holdoutBars, index) => block({
            timestamp: `2026-09-25T00:00:0${index}.000Z`,
            runId: "run",
            holdoutBars,
            sortMetric: "expectancy",
            rows: [archiveRow({ rank: 1, symbol: "AAA", candidateFingerprint: "fp-1", horizons: [{ bars: 6, averagePnlPercent: index * 4, sampleSize: 1 }] })],
        })).join("\n"));
        const variedDetails = buildRangeDetails({
            snapshotId: "s1",
            view: buildExplorerView(varied, "run"),
            columns: [12, 24],
            topK: 1,
            horizonBars: 6,
            sortMetric: "expectancy",
            holdoutFrom: 12,
            holdoutTo: 24,
            metric: "actual",
            offset: 0,
            limit: 100,
        });
        for (const bin of variedDetails.histogram.bins) {
            expect(bin.to).to.be.at.least(bin.from);
        }
    });
});
