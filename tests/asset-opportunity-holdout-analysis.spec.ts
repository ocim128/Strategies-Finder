import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    analyzeAssetOpportunityArchive,
    colorizeAssetOpportunityHoldoutReport,
    parseAssetOpportunityArchiveText,
    readAssetOpportunityArchive,
    renderAssetOpportunityHoldoutReport,
} from "../scripts/analyze-asset-opportunity-holdouts";

function block(args: {
    timestamp: string;
    runId: string;
    holdoutBars: number;
    sortMetric: string;
    rows: unknown[];
    baseline?: unknown;
    baselineByBasis?: unknown;
    measurementMode?: string;
    nextExitBaseline?: unknown;
}): string {
    return [
        "=".repeat(80),
        `Timestamp: ${args.timestamp}`,
        `Batch run id: ${args.runId}`,
        `OOS holdout: ${args.holdoutBars} bars`,
        `Archive sort: ${args.sortMetric}`,
        ...(args.measurementMode === undefined ? [] : [`Forward measurement: ${args.measurementMode}`]),
        ...(args.baseline === undefined ? [] : [`Archive baseline: ${JSON.stringify(args.baseline)}`]),
        ...(args.baselineByBasis === undefined ? [] : [`Archive baseline by basis: ${JSON.stringify(args.baselineByBasis)}`]),
        ...(args.nextExitBaseline === undefined ? [] : [`Next-exit archive baseline: ${JSON.stringify(args.nextExitBaseline)}`]),
        "=".repeat(80),
        JSON.stringify(args.rows),
        "=".repeat(80),
    ].join("\n");
}

function row(rank: number, pnl: number, sampleSize: number, symbol = "PAIR•"): Record<string, unknown> {
    return {
        scope: "asset_opportunity",
        rank,
        symbol,
        strategyId: "strategy_a",
        strategyName: "Strategy A",
        forwardOosPerformance: {
            ignoreLastBars: 12,
            horizons: [{ bars: 12, pnlPercent: pnl, averagePnlPercent: pnl, winRatePercent: pnl > 0 ? 100 : 0, sampleSize }],
        },
    };
}

describe("Asset Opportunity holdout analysis", () => {
    it("excludes gains at or above 100 per horizon while retaining large losses and source archives", () => {
        const records = [100, 150, 99.9, -150].flatMap((pnl, index) => parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-26T00:00:00.000Z", runId: "robust", holdoutBars: 12 + index,
            sortMetric: "averageGain",
            rows: [{ ...row(1, pnl, 1), forwardOosPerformance: {
                horizons: [{ bars: 12, averagePnlPercent: pnl, sampleSize: 1 }, { bars: 3, averagePnlPercent: 10, sampleSize: 1 }],
            } }],
            baseline: { eligibleCandidateCount: 2, horizons: [{ bars: 12, averagePnlPercent: 80,
                sampleWeightedAveragePnlPercent: 80, positiveResults: 2, observedResults: 2, totalSamples: 2 }] },
        }), "fixture.txt"));
        const original = JSON.stringify(records);
        const regular = analyzeAssetOpportunityArchive(records, { topK: 1 });
        const filtered = analyzeAssetOpportunityArchive(records, { topK: 1, excludeGains100: true });
        expect(regular.sorts[0]!.horizons.find(h => h.horizonBars === 12)!.observedRows).to.equal(4);
        const horizon = filtered.sorts[0]!.horizons.find(h => h.horizonBars === 12)!;
        expect(horizon.observedRows).to.equal(2);
        expect(horizon.totalSamples).to.equal(2);
        expect(horizon.positiveRatePercent).to.equal(50);
        expect(horizon.averagePnlPercent).to.be.closeTo(-25.05, 1e-9);
        expect(horizon.sampleWeightedAveragePnlPercent).to.be.closeTo(-25.05, 1e-9);
        expect(horizon.medianPnlPercent).to.be.closeTo(-25.05, 1e-9);
        expect(horizon.worstPnlPercent).to.equal(-150);
        expect(filtered.sorts[0]!.horizons.find(h => h.horizonBars === 3)!.observedRows).to.equal(4);
        expect(filtered.gainExclusion?.excludedObservations).to.equal(2);
        expect(regular.baselineAvailable).to.equal(true);
        expect(filtered.baselineAvailable).to.equal(false);
        expect(horizon.baselineAveragePnlPercent).to.equal(null);
        expect(renderAssetOpportunityHoldoutReport(filtered)).to.include("Gain exclusion: >= +100%");
        expect(JSON.stringify(records)).to.equal(original);
    });

    it("does not replace an excluded rank-one gain with rank two or a zero return", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-26T00:00:00.000Z", runId: "robust", holdoutBars: 12,
            sortMetric: "averageGain", rows: [row(1, 100, 1), row(2, 5, 1)],
        }), "fixture.txt");
        const report = analyzeAssetOpportunityArchive(records, { topK: 1, excludeGains100: true });
        expect(report.sorts[0]!.horizons[0]!.observedRows).to.equal(0);
        expect(report.sorts[0]!.horizons[0]!.averagePnlPercent).to.equal(null);
    });

    it("excludes next-exit gains without promoting lower ranks or classifying exclusions as missing data", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-09-26T00:00:00.000Z", runId: "robust", holdoutBars: 12,
            sortMetric: "averageGain", measurementMode: "next_exit",
            rows: [100, 250, -150, 10].map((pnl, index) => ({ ...row(index + 1, pnl, 1),
                nextExitOosPerformance: { status: "exited", pnlPercent: pnl, exitReason: "signal", barsHeld: 2 },
            })),
        }), "fixture.txt");
        const report = analyzeAssetOpportunityArchive(records, { topK: 3, excludeGains100: true });
        expect(report.nextExit!.sorts[0]!.observedRows).to.equal(1);
        expect(report.nextExit!.sorts[0]!.unavailableRows).to.equal(0);
        expect(report.nextExit!.sorts[0]!.averagePnlPercent).to.equal(-150);
        expect(report.archiveMaximumRank).to.equal(4);
        expect(report.gainExclusion?.excludedObservations).to.equal(2);
    });

    it("parses repeated delimited archive blocks", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-a",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [row(1, 4, 1)],
        }), "fixture.txt");

        expect(records).to.have.length(1);
        expect(records[0]!.topResults[0]!.symbol).to.equal("PAIR•");
        expect(records[0]!.sortMetric).to.equal("expectancy");
    });

    it("parses the optional all-candidate baseline and candidate fingerprint", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-a",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [{ ...row(1, 4, 1), candidateFingerprint: "fp-1" }],
            baseline: {
                eligibleCandidateCount: 25,
                horizons: [{
                    bars: 12,
                    averagePnlPercent: 0.5,
                    sampleWeightedAveragePnlPercent: 0.5,
                    positiveResults: 13,
                    observedResults: 25,
                    totalSamples: 25,
                }],
            },
        }), "fixture.txt");

        expect(records[0]!.topResults[0]!.candidateFingerprint).to.equal("fp-1");
        expect(records[0]!.baseline?.eligibleCandidateCount).to.equal(25);
        expect(records[0]!.baseline?.horizons[0]!.averagePnlPercent).to.equal(0.5);
    });

    it("parses per-basis forward maps and the per-basis baseline header", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-10-11T00:00:00.000Z",
            runId: "run-all-bases",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [{
                ...row(1, 4, 1),
                forwardOosPerformanceByBasis: {
                    pair: { ignoreLastBars: 12, basis: "pair", horizons: [{ bars: 12, averagePnlPercent: 1, sampleSize: 1 }] },
                    base_only: { ignoreLastBars: 12, basis: "base_only", horizons: [{ bars: 12, averagePnlPercent: 2, sampleSize: 1 }] },
                    quote_only: { ignoreLastBars: 12, basis: "quote_only", horizons: [{ bars: 12, averagePnlPercent: 3, sampleSize: 1, ongoing: true }] },
                },
            }],
            baseline: { eligibleCandidateCount: 9, horizons: [] },
            baselineByBasis: {
                pair: { eligibleCandidateCount: 9, horizons: [{ bars: 12, averagePnlPercent: 0.5, sampleWeightedAveragePnlPercent: 0.5, positiveResults: 5, observedResults: 9, totalSamples: 9 }] },
                base_only: { eligibleCandidateCount: 9, horizons: [{ bars: 12, averagePnlPercent: 1.5, sampleWeightedAveragePnlPercent: 1.5, positiveResults: 6, observedResults: 9, totalSamples: 9 }] },
            },
        }), "fixture.txt");

        expect(records[0]!.baselineByBasis?.pair?.horizons[0]!.averagePnlPercent).to.equal(0.5);
        expect(records[0]!.baselineByBasis?.base_only?.horizons[0]!.averagePnlPercent).to.equal(1.5);
        expect(records[0]!.baselineByBasis?.quote_only).to.equal(undefined);
        const byBasis = records[0]!.topResults[0]!.forwardOosPerformanceByBasis;
        expect(byBasis?.pair?.horizons?.[0]!.averagePnlPercent).to.equal(1);
        expect(byBasis?.base_only?.horizons?.[0]!.averagePnlPercent).to.equal(2);
        expect(byBasis?.quote_only?.horizons?.[0]!.averagePnlPercent).to.equal(3);
        expect(byBasis?.quote_only?.horizons?.[0]!.ongoing).to.equal(true);
        expect(byBasis?.pair?.horizons?.[0]!.ongoing).to.equal(undefined);
    });

    it("re-bases every forward outcome and baseline to the requested horizon basis", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-10-11T00:00:00.000Z",
            runId: "run-all-bases",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [
                {
                    ...row(1, 999, 1),
                    forwardOosPerformance: {
                        ignoreLastBars: 12,
                        basis: "base_only",
                        horizons: [{ bars: 12, pnlPercent: 4, averagePnlPercent: 4, winRatePercent: 100, sampleSize: 1 }],
                    },
                    forwardOosPerformanceByBasis: {
                        pair: { ignoreLastBars: 12, basis: "pair", horizons: [{ bars: 12, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 }] },
                        base_only: { ignoreLastBars: 12, basis: "base_only", horizons: [{ bars: 12, pnlPercent: 4, averagePnlPercent: 4, winRatePercent: 100, sampleSize: 1 }] },
                    },
                },
                {
                    ...row(2, 2, 1),
                    forwardOosPerformance: {
                        ignoreLastBars: 12,
                        basis: "pair",
                        horizons: [{ bars: 12, pnlPercent: 2, averagePnlPercent: 2, winRatePercent: 100, sampleSize: 1 }],
                    },
                },
            ],
            baseline: { eligibleCandidateCount: 5, horizons: [{ bars: 12, averagePnlPercent: 77, sampleWeightedAveragePnlPercent: 77, positiveResults: 5, observedResults: 5, totalSamples: 5 }] },
            baselineByBasis: {
                pair: { eligibleCandidateCount: 5, horizons: [{ bars: 12, averagePnlPercent: 0.25, sampleWeightedAveragePnlPercent: 0.25, positiveResults: 1, observedResults: 5, totalSamples: 5 }] },
            },
        }), "fixture.txt");

        const report = analyzeAssetOpportunityArchive(records, { topK: 2, horizonBasis: "pair" });
        expect(report.horizonBasis).to.equal("pair");
        const horizon = report.sorts[0]!.horizons.find(h => h.horizonBars === 12)!;
        // Rank 1 contributes its per-basis pair outcome (1); rank 2 keeps its
        // legacy pair-labeled row (2).
        expect(horizon.observedRows).to.equal(2);
        expect(horizon.averagePnlPercent).to.equal(1.5);
        // The baseline swaps to the per-basis aggregate, not the primary (77).
        expect(horizon.baselineAveragePnlPercent).to.equal(0.25);
        expect(renderAssetOpportunityHoldoutReport(report)).to.include("Forward horizon basis: pair");
        expect(report.notes.join("\n"))
            .to.include("Forward horizon basis filter: pair")
            .and.to.include("1 row outcomes came from per-basis maps")
            .and.to.include("1 from legacy single-basis rows");
    });

    it("drops rows and baselines that lack the requested horizon basis", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-10-11T00:00:00.000Z",
            runId: "run-base-only",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [
                {
                    ...row(1, 4, 1),
                    forwardOosPerformance: {
                        ignoreLastBars: 12,
                        basis: "base_only",
                        horizons: [{ bars: 12, pnlPercent: 4, averagePnlPercent: 4, winRatePercent: 100, sampleSize: 1 }],
                    },
                },
                row(2, 6, 1),
            ],
            baseline: { eligibleCandidateCount: 2, horizons: [{ bars: 12, averagePnlPercent: 77, sampleWeightedAveragePnlPercent: 77, positiveResults: 2, observedResults: 2, totalSamples: 2 }] },
        }), "fixture.txt");

        const report = analyzeAssetOpportunityArchive(records, { topK: 2, horizonBasis: "base_only" });
        const horizon = report.sorts[0]!.horizons.find(h => h.horizonBars === 12)!;
        expect(horizon.observedRows).to.equal(1);
        expect(horizon.averagePnlPercent).to.equal(4);
        // The legacy aggregate cannot be re-based → unavailable, never mixed.
        expect(horizon.baselineAveragePnlPercent).to.equal(null);
        expect(report.baselineAvailable).to.equal(false);
        expect(report.notes.join("\n"))
            .to.include("1 selected rows had no base_only measurement")
            .and.to.include("could not be re-based to base_only");
    });

    it("renders a basis report without crashing when no row measures that basis", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-10-11T00:00:00.000Z",
            runId: "run-base-only",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [
                {
                    ...row(1, 4, 1),
                    forwardOosPerformance: {
                        ignoreLastBars: 12,
                        basis: "base_only",
                        horizons: [{ bars: 12, pnlPercent: 4, averagePnlPercent: 4, winRatePercent: 100, sampleSize: 1 }],
                    },
                },
                row(2, 6, 1),
            ],
        }), "fixture.txt");

        // Every forward outcome is dropped, leaving no horizon keys anywhere;
        // candidate ranking and the rendered report must survive that.
        const report = analyzeAssetOpportunityArchive(records, { topK: 2, horizonBasis: "pair" });
        expect(report.horizonBasis).to.equal("pair");
        expect(report.sorts[0]!.horizons).to.deep.equal([]);
        expect(report.sorts[0]!.candidates.length).to.be.greaterThan(0);
        expect(renderAssetOpportunityHoldoutReport(report)).to.include("Forward horizon basis: pair");
    });

    it("keeps ongoing forward observations out of completed-horizon aggregates and reports them separately", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-10-11T00:00:00.000Z",
            runId: "run-ongoing",
            holdoutBars: 5,
            sortMetric: "expectancy",
            rows: [
                {
                    ...row(1, 4, 1),
                    forwardOosPerformance: {
                        ignoreLastBars: 5,
                        horizons: [
                            { bars: 36, pnlPercent: 2, averagePnlPercent: 2, winRatePercent: 100, sampleSize: 1, ongoing: true },
                            { bars: 48, pnlPercent: 6, averagePnlPercent: 6, winRatePercent: 100, sampleSize: 1 },
                        ],
                    },
                },
                {
                    ...row(2, -2, 1),
                    forwardOosPerformance: {
                        ignoreLastBars: 5,
                        horizons: [
                            { bars: 36, pnlPercent: -2, averagePnlPercent: -2, winRatePercent: 0, sampleSize: 1, ongoing: true },
                        ],
                    },
                },
            ],
        }), "fixture.txt");

        const report = analyzeAssetOpportunityArchive(records, { topK: 2 });
        // The 36-bar horizon has no completed observations: the main columns
        // stay empty instead of reporting last-candle mark-to-market.
        const horizon36 = report.sorts[0]!.horizons.find(horizon => horizon.horizonBars === 36)!;
        expect(horizon36.observedRows).to.equal(0);
        expect(horizon36.averagePnlPercent).to.equal(null);
        expect(horizon36.ongoingRows).to.equal(2);
        expect(horizon36.ongoingAveragePnlPercent).to.equal(0);
        expect(horizon36.ongoingPositiveRatePercent).to.equal(50);
        // The 48-bar horizon is completed: only the main columns carry it.
        const horizon48 = report.sorts[0]!.horizons.find(horizon => horizon.horizonBars === 48)!;
        expect(horizon48.observedRows).to.equal(1);
        expect(horizon48.averagePnlPercent).to.equal(6);
        expect(horizon48.ongoingRows).to.equal(0);
        expect(horizon48.ongoingAveragePnlPercent).to.equal(null);
        // The report still discloses how many observations were ongoing.
        expect(report.notes.join("\n")).to.include("2 forward observations were ongoing");
        expect(report.notes.join("\n")).to.include("Aggregates use completed horizons only");
        expect(renderAssetOpportunityHoldoutReport(report)).to.include("Ongoing n | Ongoing avg | Samples (completed)");
    });

    it("parses next-exit archive headers and baseline separately from horizons", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-next-exit",
            holdoutBars: 5,
            sortMetric: "expectancy",
            measurementMode: "next_exit",
            rows: [{
                ...row(1, 0, 0),
                forwardOosPerformance: null,
                nextExitOosPerformance: {
                    status: "exited",
                    pnlPercent: 1.25,
                    exitReason: "take_profit",
                },
            }],
            nextExitBaseline: {
                eligibleCandidateCount: 1,
                observedExits: 1,
                censoredResults: 0,
                unavailableResults: 0,
                averagePnlPercent: 1.25,
                exitReasonCounts: { take_profit: 1 },
                unavailableReasonCounts: {},
            },
        }), "next-exit.txt");

        expect(records[0]!.measurementMode).to.equal("next_exit");
        expect(records[0]!.baseline).to.equal(null);
        expect(records[0]!.nextExitBaseline?.averagePnlPercent).to.equal(1.25);
        expect(records[0]!.nextExitBaseline?.unavailableReasonCounts).to.deep.equal({});
        expect(records[0]!.topResults[0]!.nextExitOosPerformance?.status).to.equal("exited");
        expect(records[0]!.topResults[0]!.nextExitOosPerformance?.pnlPercent).to.equal(1.25);
    });

    it("analyzes next-exit rows separately from fixed horizons", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-next-exit",
            holdoutBars: 5,
            sortMetric: "expectancy",
            measurementMode: "next_exit",
            rows: [
                {
                    ...row(1, 0, 0),
                    forwardOosPerformance: null,
                    nextExitOosPerformance: { status: "exited", pnlPercent: 2, exitReason: "take_profit", barsHeld: 2 },
                },
                {
                    ...row(2, 0, 0),
                    forwardOosPerformance: null,
                    nextExitOosPerformance: { status: "exited", pnlPercent: -2, exitReason: "stop_loss", barsHeld: 1 },
                },
                {
                    ...row(3, 0, 0),
                    forwardOosPerformance: null,
                    nextExitOosPerformance: { status: "censored", pnlPercent: null, exitReason: "end_of_data" },
                },
                {
                    ...row(4, 0, 0),
                    forwardOosPerformance: null,
                    nextExitOosPerformance: {
                        status: "unavailable",
                        pnlPercent: null,
                        exitReason: null,
                        unavailableReason: "no_boundary_trade",
                    },
                },
            ],
            nextExitBaseline: {
                eligibleCandidateCount: 4,
                observedExits: 2,
                censoredResults: 1,
                unavailableResults: 1,
                averagePnlPercent: 0,
                exitReasonCounts: { take_profit: 1, stop_loss: 1, end_of_data: 1 },
            },
        }));
        const report = analyzeAssetOpportunityArchive(records, { topK: 4 });
        const sort = report.nextExit?.sorts[0]!;

        expect(report.measurementMode).to.equal("next_exit");
        expect(report.sorts).to.deep.equal([]);
        expect(sort.totalRows).to.equal(4);
        expect(sort.observedRows).to.equal(2);
        expect(sort.positiveRows).to.equal(1);
        expect(sort.censoredRows).to.equal(1);
        expect(sort.unavailableRows).to.equal(1);
        expect(sort.averagePnlPercent).to.equal(0);
        expect(sort.averageBarsHeld).to.equal(1.5);
        expect(sort.exitReasonCounts).to.deep.equal({ end_of_data: 1, stop_loss: 1, take_profit: 1 });
        expect(sort.unavailableReasonCounts).to.deep.equal({ no_boundary_trade: 1 });
        expect(report.nextExit?.baseline?.unavailableReasonCounts).to.deep.equal({ unknown_legacy: 1 });
        expect(renderAssetOpportunityHoldoutReport(report)).to.contain("NEXT EXIT OOS SUMMARY");
        expect(renderAssetOpportunityHoldoutReport(report)).to.contain("no_boundary_trade=1");
    });

    it("marks unavailable and degenerate thesis sorts instead of presenting fallback PnL as measured evidence", () => {
        const records = parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-08-11T00:00:00.000Z",
                runId: "run-next-exit",
                holdoutBars: 5,
                sortMetric: "medianBarsToTp",
                measurementMode: "next_exit",
                rows: [{
                    ...row(1, 2, 1),
                    selectionPerformance: { medianBarsToTp: null },
                    nextExitOosPerformance: { status: "exited", pnlPercent: 2, exitReason: "time_stop" },
                }],
            }),
            block({
                timestamp: "2026-08-11T00:00:01.000Z",
                runId: "run-next-exit",
                holdoutBars: 5,
                sortMetric: "priorTupleRecurrence",
                measurementMode: "next_exit",
                rows: [{
                    ...row(1, 2, 1),
                    selectionPerformance: { priorTupleRecurrenceCount: 0 },
                    nextExitOosPerformance: { status: "exited", pnlPercent: 2, exitReason: "time_stop" },
                }],
            }),
            block({
                timestamp: "2026-08-11T00:00:02.000Z",
                runId: "run-next-exit",
                holdoutBars: 5,
                sortMetric: "barrierExitShare",
                measurementMode: "next_exit",
                rows: [
                    {
                        ...row(1, 2, 1),
                        selectionPerformance: { barrierExitShare: 0 },
                        nextExitOosPerformance: { status: "exited", pnlPercent: 2, exitReason: "time_stop" },
                    },
                    {
                        ...row(2, -1, 1),
                        selectionPerformance: { barrierExitShare: 0 },
                        nextExitOosPerformance: { status: "exited", pnlPercent: -1, exitReason: "time_stop" },
                    },
                ],
            }),
        ].join("\n"));
        const report = analyzeAssetOpportunityArchive(records, { topK: 1 });
        const sorts = report.nextExit!.sorts;

        expect(sorts.find((sort) => sort.sortMetric === "medianBarsToTp")!.thesisMetricEvidence).to.deep.equal({
            status: "unavailable",
            totalRows: 1,
            validRows: 0,
            distinctValues: 0,
            positiveRows: null,
            comparableHoldouts: 0,
            differentiatedHoldouts: 0,
            totalHoldouts: 1,
        });
        expect(sorts.find((sort) => sort.sortMetric === "priorTupleRecurrence")!.thesisMetricEvidence).to.deep.equal({
            status: "insufficient_data",
            totalRows: 1,
            validRows: 1,
            distinctValues: 1,
            positiveRows: 0,
            comparableHoldouts: 0,
            differentiatedHoldouts: 0,
            totalHoldouts: 1,
        });
        expect(sorts.find((sort) => sort.sortMetric === "barrierExitShare")!.thesisMetricEvidence.status).to.equal("degenerate");

        const text = renderAssetOpportunityHoldoutReport(report);
        expect(text).to.contain("Outcome rows: cumulative ranks 1–1 requested (archive maximum rank: 2)");
        expect(text).to.contain("medianBarsToTp | 0/1 valid, varied=0/0 comparable holdouts, distinct=0 (UNAVAILABLE)");
        expect(text).to.contain("priorTupleRecurrence | 1/1 valid, recurring=0/1, varied=0/0 comparable holdouts, distinct=1 (INSUFFICIENT DATA)");
        expect(text).to.contain("cannot establish that this thesis chose the winner rather than a tiebreak");
    });

    it("audits persisted inverted metrics across the whole archived shortlist, not only outcome top-K", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-next-exit",
            holdoutBars: 5,
            sortMetric: "invertedSharpeRatio",
            measurementMode: "next_exit",
            rows: [-2, -1, 0].map((sharpeRatio, index) => ({
                ...row(index + 1, 3 - index, 1),
                selectionPerformance: { sharpeRatio },
                nextExitOosPerformance: { status: "exited", pnlPercent: 3 - index, exitReason: "time_stop" },
            })),
        }));
        const report = analyzeAssetOpportunityArchive(records, { topK: 1 });
        const sort = report.nextExit!.sorts[0]!;

        expect(sort.totalRows).to.equal(1);
        expect(sort.thesisMetricEvidence).to.deep.equal({
            status: "measured",
            totalRows: 3,
            validRows: 3,
            distinctValues: 3,
            positiveRows: null,
            comparableHoldouts: 1,
            differentiatedHoldouts: 1,
            totalHoldouts: 1,
        });
        expect(renderAssetOpportunityHoldoutReport(report)).to.contain(
            "invertedSharpeRatio | 3/3 valid, varied=1/1 comparable holdouts, distinct=3 (MEASURED)",
        );
    });

    it("audits the exact capped-trade thesis value when newer archives provide it", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-capped-trades",
            holdoutBars: 5,
            sortMetric: "totalTradesCapped",
            measurementMode: "next_exit",
            rows: [120, 95].map((totalTradesCappedValue, index) => ({
                ...row(index + 1, 1, 1),
                totalTradesCappedValue,
                nextExitOosPerformance: { status: "exited", pnlPercent: 1, exitReason: "time_stop" },
            })),
        }));
        const evidence = analyzeAssetOpportunityArchive(records, { topK: 1 })
            .nextExit!.sorts[0]!.thesisMetricEvidence;

        expect(evidence.status).to.equal("measured");
        expect(evidence.differentiatedHoldouts).to.equal(1);
        expect(evidence.distinctValues).to.equal(2);
    });

    it("reports signal-candle hour outcomes for next-exit archives", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-next-exit-hours",
            holdoutBars: 5,
            sortMetric: "expectancy",
            measurementMode: "next_exit",
            rows: [
                {
                    ...row(1, 2, 1),
                    signalCandleHourUtc: 12,
                    signalCandleHourJakarta: 19,
                    selectionPerformance: { expectancy: 2 },
                    nextExitOosPerformance: { status: "exited", pnlPercent: 2, exitReason: "time_stop" },
                },
                {
                    ...row(2, -1, 1),
                    signalCandleHourUtc: 16,
                    signalCandleHourJakarta: 23,
                    selectionPerformance: { expectancy: 1 },
                    nextExitOosPerformance: { status: "exited", pnlPercent: -1, exitReason: "time_stop" },
                },
            ],
        }));
        const report = analyzeAssetOpportunityArchive(records, { topK: 2 });

        expect(report.signalCandleHoursAvailable).to.equal(true);
        expect(report.nextExit!.signalCandleHourPerformance.utc.map((hour) => ({
            hour: hour.hour,
            averagePnlPercent: hour.averagePnlPercent,
        }))).to.deep.equal([
            { hour: 12, averagePnlPercent: 2 },
            { hour: 16, averagePnlPercent: -1 },
        ]);
        const text = renderAssetOpportunityHoldoutReport(report);
        expect(text).to.contain("NEXT-EXIT SIGNAL CANDLE HOUR — UTC");
        expect(text).to.contain("12:00 | 1 | 1 | 1 | 1/1 | 1/1");
    });

    it("renders next-exit sorts best to worst and colorizes console output only", () => {
        const records = parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-08-11T00:00:00.000Z",
                runId: "run-next-exit",
                holdoutBars: 5,
                sortMetric: "worst_sort",
                measurementMode: "next_exit",
                rows: [{
                    ...row(1, 0, 0),
                    forwardOosPerformance: null,
                    nextExitOosPerformance: { status: "exited", pnlPercent: -1, exitReason: "stop_loss" },
                }],
            }),
            block({
                timestamp: "2026-08-11T00:00:01.000Z",
                runId: "run-next-exit",
                holdoutBars: 5,
                sortMetric: "best_sort",
                measurementMode: "next_exit",
                rows: [{
                    ...row(1, 0, 0),
                    forwardOosPerformance: null,
                    nextExitOosPerformance: { status: "exited", pnlPercent: 2, exitReason: "take_profit" },
                }],
            }),
        ].join("\n"));
        const report = analyzeAssetOpportunityArchive(records);
        const text = renderAssetOpportunityHoldoutReport(report);
        const bestIndex = text.indexOf("best_sort |");
        const worstIndex = text.indexOf("worst_sort |");

        expect(bestIndex).to.be.greaterThan(-1);
        expect(bestIndex).to.be.lessThan(worstIndex);
        expect(text).to.contain("Holdout windows: 5 (1)");

        const colored = colorizeAssetOpportunityHoldoutReport(text, true);
        expect(colored).to.contain("\u001b[92m2.00%\u001b[0m");
        expect(colored).to.contain("\u001b[91m-1.00%\u001b[0m");
        expect(colored).to.contain("\u001b[96mNEXT EXIT OOS SUMMARY");
        expect(colorizeAssetOpportunityHoldoutReport(text, false)).to.equal(text);
    });

    it("selects the most complete run and calculates descriptive OOS averages", () => {
        const text = [
            block({ timestamp: "2026-08-11T00:00:00.000Z", runId: "old", holdoutBars: 12, sortMetric: "expectancy", rows: [row(1, 99, 1)] }),
            block({ timestamp: "2026-08-12T00:00:00.000Z", runId: "new", holdoutBars: 12, sortMetric: "expectancy", rows: [row(1, 10, 2)] }),
            block({ timestamp: "2026-08-12T00:00:01.000Z", runId: "new", holdoutBars: 13, sortMetric: "expectancy", rows: [row(2, -2, 1)] }),
        ].join("\n");
        const report = analyzeAssetOpportunityArchive(parseAssetOpportunityArchiveText(text), {
            archiveDirectory: "archive",
            generatedAt: "2026-08-12T00:00:02.000Z",
        });
        const sort = report.sorts[0]!;
        const candidate = sort.candidates[0]!;
        const horizon = candidate.horizons["12"]!;

        expect(report.selectedBatchRunId).to.equal("new");
        expect(report.excludedBatchRunIds).to.deep.equal(["old"]);
        expect(candidate.holdoutCount).to.equal(2);
        expect(candidate.longestContiguousHoldoutRun).to.equal(2);
        expect(horizon.positiveWindows).to.equal(1);
        expect(horizon.observedWindows).to.equal(2);
        expect(horizon.sampleWeightedAveragePnlPercent).to.equal(6);
        expect(sort.horizons[0]!.worstPnlPercent).to.equal(-2);
    });

    it("renders a human-readable report with the interpretation warning", () => {
        const report = analyzeAssetOpportunityArchive(parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-a",
            holdoutBars: 12,
            sortMetric: "freshSignalLibraries",
            rows: [row(1, 4, 1)],
        })));
        const text = renderAssetOpportunityHoldoutReport(report);

        expect(text).to.contain("FORWARD OOS SUMMARY");
        expect(text).to.contain("freshSignalLibraries");
        expect(text).to.contain("Research status: DISCOVERY ONLY");
        expect(text).to.contain("must not be treated as independent experiments");
        expect(text).to.contain("QUESTIONS ANSWERED BY THIS REPORT");
    });

    it("compares parameter fingerprints for recurring symbol-strategy candidates", () => {
        const records = parseAssetOpportunityArchiveText([
            block({
                timestamp: "2026-08-11T00:00:00.000Z",
                runId: "run-a",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [{ ...row(1, 4, 1), candidateFingerprint: "fp-1" }],
            }),
            block({
                timestamp: "2026-08-11T00:00:01.000Z",
                runId: "run-a",
                holdoutBars: 13,
                sortMetric: "expectancy",
                rows: [{ ...row(1, 3, 1), candidateFingerprint: "fp-2" }],
            }),
        ].join("\n"));
        const report = analyzeAssetOpportunityArchive(records);
        const variants = report.parameterVariants[0]!;

        expect(variants.candidateKey).to.contain("strategy_a");
        expect(variants.distinctFingerprints).to.equal(2);
        expect(variants.totalAppearances).to.equal(2);
        expect(variants.dominantFingerprintAppearanceRatePercent).to.equal(50);
        expect(renderAssetOpportunityHoldoutReport(report)).to.contain("PARAMETER FINGERPRINT STABILITY");
    });

    it("reports strategy contribution, worst-strategy removal, and signal candle hours", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-08-11T00:00:00.000Z",
            runId: "run-a",
            holdoutBars: 12,
            sortMetric: "expectancy",
            rows: [
                {
                    ...row(1, 4, 1),
                    strategyId: "good_strategy",
                    strategyName: "Good Strategy",
                    signalCandleHourUtc: 10,
                    signalCandleHourJakarta: 17,
                },
                {
                    ...row(2, -2, 1),
                    strategyId: "bad_strategy",
                    strategyName: "Bad Strategy",
                    signalCandleHourUtc: 11,
                    signalCandleHourJakarta: 18,
                },
            ],
        }));
        const report = analyzeAssetOpportunityArchive(records);

        expect(report.strategyPerformance.map((strategy) => strategy.strategyId)).to.deep.equal([
            "good_strategy",
            "bad_strategy",
        ]);
        expect(report.oosWithoutWorstStrategy?.removedStrategyId).to.equal("bad_strategy");
        expect(report.oosWithoutWorstStrategy?.before[0]!.averagePnlPercent).to.equal(1);
        expect(report.oosWithoutWorstStrategy?.after[0]!.averagePnlPercent).to.equal(4);
        expect(report.signalCandleHoursAvailable).to.equal(true);
        expect(report.signalCandleHourPerformance.utc.map((hour) => hour.hour)).to.deep.equal([10, 11]);
        expect(renderAssetOpportunityHoldoutReport(report)).to.contain("OOS COUNTERFACTUAL");
        expect(renderAssetOpportunityHoldoutReport(report)).to.contain("SIGNAL CANDLE HOUR — UTC");
    });

    it("builds non-overlapping rank-1 tenures in hold-until-change mode", () => {
        const holdoutRow = (rank: number, symbol: string, pnl12: number, pnl36: number, ongoing36 = false) => ({
            ...row(rank, pnl12, 1, symbol),
            forwardOosPerformance: {
                ignoreLastBars: 12,
                horizons: [
                    { bars: 12, averagePnlPercent: pnl12, sampleSize: 1 },
                    { bars: 36, averagePnlPercent: pnl36, sampleSize: 1, ...(ongoing36 ? { ongoing: true } : {}) },
                ],
            },
        });
        const baseline = {
            eligibleCandidateCount: 2,
            horizons: [
                { bars: 12, averagePnlPercent: 0.5, sampleWeightedAveragePnlPercent: 0.5, positiveResults: 1, observedResults: 2, totalSamples: 2 },
                { bars: 36, averagePnlPercent: 0.25, sampleWeightedAveragePnlPercent: 0.25, positiveResults: 1, observedResults: 2, totalSamples: 2 },
            ],
        };
        // Chronological order is DESCENDING holdout bars: A leads twice, then B,
        // then A again. The last tenure stays open.
        const records = [15, 14, 13, 12].flatMap((holdoutBars, index) => {
            const rankOne = [
                holdoutRow(1, "AAA•", 4, 2),
                holdoutRow(1, "AAA•", 6, 5),
                holdoutRow(1, "BBB•", -2, 6),
                holdoutRow(1, "AAA•", 1, 3, true),
            ][index]!;
            return parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-11T00:00:00.000Z",
                runId: "run-hold",
                holdoutBars,
                sortMetric: "winRate",
                rows: [rankOne, holdoutRow(2, "OTHER•", 9, 9)],
                baseline,
            }), "fixture.txt");
        });

        const report = analyzeAssetOpportunityArchive(records, { topK: 2, calculationMode: "hold_until_change" });
        expect(report.calculationMode).to.equal("hold_until_change");
        const sort = report.sorts[0]!;
        expect(sort.holdUntilChange?.tenures.map((tenure) => ({
            symbol: tenure.symbol,
            entry: tenure.entryHoldoutBars,
            exit: tenure.exitHoldoutBars,
            steps: tenure.tenureSteps,
            pnl12: tenure.horizons["12"]?.averagePnlPercent ?? null,
        }))).to.deep.equal([
            { symbol: "AAA•", entry: 15, exit: 13, steps: 2, pnl12: 4 },
            { symbol: "BBB•", entry: 13, exit: 12, steps: 1, pnl12: -2 },
            { symbol: "AAA•", entry: 12, exit: null, steps: 1, pnl12: 1 },
        ]);
        // The 12-bar horizon sees one trade per tenure, not one per boundary:
        // entry PnLs 4, -2, 1 with the pooled all-candidate baseline.
        const horizon12 = sort.holdUntilChange!.horizons.find((horizon) => horizon.horizonBars === 12)!;
        expect(horizon12.observedRows).to.equal(3);
        expect(horizon12.positiveRows).to.equal(2);
        expect(horizon12.averagePnlPercent).to.equal(1);
        expect(horizon12.medianPnlPercent).to.equal(1);
        expect(horizon12.worstPnlPercent).to.equal(-2);
        expect(horizon12.baselineAveragePnlPercent).to.equal(0.5);
        // The 36-bar horizon separates the ongoing entry from completed trades.
        const horizon36 = sort.holdUntilChange!.horizons.find((horizon) => horizon.horizonBars === 36)!;
        expect(horizon36.observedRows).to.equal(2);
        expect(horizon36.averagePnlPercent).to.equal(4);
        expect(horizon36.ongoingRows).to.equal(1);
        expect(horizon36.ongoingAveragePnlPercent).to.equal(3);
        // Fixed-horizon rows still aggregate every boundary (8 rank<=2 rows).
        expect(sort.horizons.find((horizon) => horizon.horizonBars === 12)!.observedRows).to.equal(8);

        const text = renderAssetOpportunityHoldoutReport(report);
        expect(text).to.contain("Calculation mode: hold_until_change (non-overlapping rank-1 leader tenures)");
        expect(text).to.contain("HOLD-UNTIL-CHANGE OOS SUMMARY");
        expect(text).to.contain("Positive trades | Average PnL");
        expect(text).to.contain("HOLD-UNTIL-CHANGE LEADER PATH");
        expect(text).to.not.contain("FORWARD OOS SUMMARY");
        // No 1-bar horizon in this archive: no exact hold return anywhere.
        expect(report.sorts[0]!.holdUntilChange!.tenures.every((tenure) => tenure.holdReturnPercent === null)).to.equal(true);
        expect(report.sorts[0]!.holdUntilChange!.hold).to.equal(undefined);
        // The path header advertises the column, but the summary says why it is empty.
        expect(text).to.contain("Hold PnL (entry→exit)");
        expect(text).to.contain("no usable 1-bar horizon");
        expect(text).to.not.contain("| entry→exit |");

        // Default mode keeps the original overlapping summary.
        const fixedReport = analyzeAssetOpportunityArchive(records, { topK: 2 });
        expect(fixedReport.calculationMode).to.equal("fixed_horizon");
        expect(fixedReport.sorts[0]!.holdUntilChange).to.equal(undefined);
        const fixedText = renderAssetOpportunityHoldoutReport(fixedReport);
        expect(fixedText).to.contain("FORWARD OOS SUMMARY");
        expect(fixedText).to.not.contain("HOLD-UNTIL-CHANGE");
    });

    it("keeps a hold-until-change tenure open across strategy changes and empty boundaries", () => {
        const records = [
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-11T00:00:00.000Z",
                runId: "run-hold",
                holdoutBars: 14,
                sortMetric: "winRate",
                rows: [{ ...row(1, 5, 1, "AAA•"), strategyId: "strategy_one", strategyName: "Strategy One" }],
            }), "fixture.txt"),
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-11T00:00:01.000Z",
                runId: "run-hold",
                holdoutBars: 13,
                sortMetric: "winRate",
                rows: [{ ...row(1, 4, 1, "AAA•"), strategyId: "strategy_two", strategyName: "Strategy Two" }],
            }), "fixture.txt"),
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-11T00:00:02.000Z",
                runId: "run-hold",
                holdoutBars: 12,
                sortMetric: "winRate",
                rows: [],
            }), "fixture.txt"),
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-11T00:00:03.000Z",
                runId: "run-hold",
                holdoutBars: 11,
                sortMetric: "winRate",
                rows: [row(1, -1, 1, "BBB•")],
            }), "fixture.txt"),
        ];

        const report = analyzeAssetOpportunityArchive(records, { topK: 3, calculationMode: "hold_until_change" });
        const tenures = report.sorts[0]!.holdUntilChange!.tenures;
        expect(tenures.map((tenure) => ({
            symbol: tenure.symbol,
            strategyId: tenure.strategyId,
            entry: tenure.entryHoldoutBars,
            exit: tenure.exitHoldoutBars,
            steps: tenure.tenureSteps,
        }))).to.deep.equal([
            // Same symbol with a different strategy does not close the tenure,
            // and a boundary without a usable rank-1 keeps it open.
            { symbol: "AAA•", strategyId: "strategy_one", entry: 14, exit: 11, steps: 3 },
            { symbol: "BBB•", strategyId: "strategy_a", entry: 11, exit: null, steps: 1 },
        ]);
        const horizon12 = report.sorts[0]!.holdUntilChange!.horizons.find((horizon) => horizon.horizonBars === 12)!;
        expect(horizon12.observedRows).to.equal(2);
        expect(horizon12.averagePnlPercent).to.equal(2);
    });

    it("chains 1-bar horizons into the exact entry-to-exit hold return when the archive stores them", () => {
        const holdoutRow = (rank: number, symbol: string, horizons: Array<Record<string, unknown>>) => ({
            ...row(rank, 0, 1, symbol),
            forwardOosPerformance: { ignoreLastBars: 12, horizons },
        });
        const bars = (averagePnlPercent: number, ongoing = false) => (
            { bars: 1, averagePnlPercent, sampleSize: 1, ...(ongoing ? { ongoing: true } : {}) }
        );
        // Chronological order is DESCENDING holdout bars: A leads two consecutive
        // boundaries, then B takes over and stays held at the sweep end.
        const records = [
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-12T00:00:00.000Z",
                runId: "run-chain",
                holdoutBars: 13,
                sortMetric: "winRate",
                rows: [holdoutRow(1, "AAA•", [bars(2), { bars: 36, averagePnlPercent: 10, sampleSize: 1 }])],
            }), "fixture.txt"),
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-12T00:00:01.000Z",
                runId: "run-chain",
                holdoutBars: 12,
                sortMetric: "winRate",
                rows: [holdoutRow(1, "AAA•", [bars(-1), { bars: 36, averagePnlPercent: 20, sampleSize: 1 }])],
            }), "fixture.txt"),
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-12T00:00:02.000Z",
                runId: "run-chain",
                holdoutBars: 11,
                sortMetric: "winRate",
                rows: [holdoutRow(1, "BBB•", [bars(1, true), { bars: 36, averagePnlPercent: -5, sampleSize: 1 }])],
            }), "fixture.txt"),
        ];

        const report = analyzeAssetOpportunityArchive(records, { calculationMode: "hold_until_change" });
        const tenures = report.sorts[0]!.holdUntilChange!.tenures;
        expect(tenures.map((tenure) => ({
            symbol: tenure.symbol,
            steps: tenure.tenureSteps,
            exit: tenure.exitHoldoutBars,
            holdType: typeof tenure.holdReturnPercent,
            holdOngoing: tenure.holdReturnOngoing === true,
        }))).to.deep.equal([
            // (1.02 * 0.99 - 1) compounded over the two held boundaries.
            { symbol: "AAA•", steps: 2, exit: 11, holdType: "number", holdOngoing: false },
            // Still held: the last 1-bar step is mark-to-market (ongoing).
            { symbol: "BBB•", steps: 1, exit: null, holdType: "number", holdOngoing: true },
        ]);
        expect(tenures[0]!.holdReturnPercent).to.be.closeTo(0.98, 1e-9);
        expect(tenures[1]!.holdReturnPercent).to.be.closeTo(1, 1e-9);

        // The hold aggregation keeps the open tenure in the Ongoing columns.
        const hold = report.sorts[0]!.holdUntilChange!.hold!;
        expect(hold.observedRows).to.equal(1);
        expect(hold.averagePnlPercent).to.be.closeTo(0.98, 1e-9);
        expect(hold.ongoingRows).to.equal(1);
        expect(hold.ongoingAveragePnlPercent).to.be.closeTo(1, 1e-9);

        const text = renderAssetOpportunityHoldoutReport(report);
        expect(text).to.contain("BEST TO WORST BY ENTRY→EXIT AVG PNL");
        // The printed summary shows only the entry→exit row for the sort.
        expect(text).to.contain("winRate | 1/1 | 0.98%");
        expect(text).to.not.contain("entry→exit |");
        expect(text).to.contain("Hold PnL (entry→exit)");
        expect(text).to.contain("chain the archive's 1-bar horizon");
    });

    it("marks hold chains unusable when a tenure step is missing", () => {
        const holdoutRow = (rank: number, symbol: string, oneBar: number | null) => ({
            ...row(rank, 0, 1, symbol),
            forwardOosPerformance: {
                ignoreLastBars: 12,
                horizons: oneBar === null
                    ? [{ bars: 36, averagePnlPercent: 3, sampleSize: 1 }]
                    : [{ bars: 1, averagePnlPercent: oneBar, sampleSize: 1 }],
            },
        });
        const records = [
            // 15: A enters (1-bar +2). 14: A continues but its 1-bar value is
            // missing, so the chain loses a measured step.
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-12T00:00:00.000Z",
                runId: "run-gap",
                holdoutBars: 15,
                sortMetric: "winRate",
                rows: [holdoutRow(1, "AAA•", 2)],
            }), "fixture.txt"),
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-12T00:00:01.000Z",
                runId: "run-gap",
                holdoutBars: 14,
                sortMetric: "winRate",
                rows: [holdoutRow(1, "AAA•", null)],
            }), "fixture.txt"),
            // 13: B appears — a tenure starting after the break chains cleanly.
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-12T00:00:02.000Z",
                runId: "run-gap",
                holdoutBars: 13,
                sortMetric: "winRate",
                rows: [holdoutRow(1, "BBB•", 1)],
            }), "fixture.txt"),
        ];

        const report = analyzeAssetOpportunityArchive(records, { calculationMode: "hold_until_change" });
        const tenures = report.sorts[0]!.holdUntilChange!.tenures;
        // A's tenure lost a measured bar; B's fresh tenure holds one measured step.
        expect(tenures[0]!.holdReturnPercent).to.equal(null);
        expect(tenures[1]!.holdReturnPercent).to.be.closeTo(1, 1e-9);
        // Only B's tenure feeds the hold aggregation, and it is still held (ongoing).
        const hold = report.sorts[0]!.holdUntilChange!.hold!;
        expect(hold.observedRows).to.equal(0);
        expect(hold.ongoingRows).to.equal(1);
    });

    it("breaks the outgoing tenure when the leader changes across a boundary gap", () => {
        const holdoutRow = (rank: number, symbol: string, oneBar: number) => ({
            ...row(rank, 0, 1, symbol),
            forwardOosPerformance: {
                ignoreLastBars: 12,
                horizons: [{ bars: 1, averagePnlPercent: oneBar, sampleSize: 1 }],
            },
        });
        // 14: AAA enters (+2). Boundary 13 is missing from the sweep. 12: BBB
        // is rank 1 — AAA's hold spans the unmeasured bar 13, so its chain is
        // unusable even though the change itself happened on a present boundary.
        const records = [
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-12T00:00:00.000Z",
                runId: "run-change-gap",
                holdoutBars: 14,
                sortMetric: "winRate",
                rows: [holdoutRow(1, "AAA•", 2)],
            }), "fixture.txt"),
            ...parseAssetOpportunityArchiveText(block({
                timestamp: "2026-10-12T00:00:01.000Z",
                runId: "run-change-gap",
                holdoutBars: 12,
                sortMetric: "winRate",
                rows: [holdoutRow(1, "BBB•", 1)],
            }), "fixture.txt"),
        ];

        const report = analyzeAssetOpportunityArchive(records, { calculationMode: "hold_until_change" });
        const tenures = report.sorts[0]!.holdUntilChange!.tenures;
        // AAA's exit is at 12 and bar 13 was never measured: the truncated
        // 1-bar product must not be published as a complete entry→exit return.
        expect(tenures[0]!.symbol).to.equal("AAA•");
        expect(tenures[0]!.exitHoldoutBars).to.equal(12);
        expect(tenures[0]!.holdReturnPercent).to.equal(null);
        // BBB starts fresh at the boundary where it appeared.
        expect(tenures[1]!.holdReturnPercent).to.be.closeTo(1, 1e-9);
        expect(tenures[1]!.holdReturnOngoing).to.equal(true);
    });

    it("rejects hold-until-change mode on next-exit archives", () => {
        const records = parseAssetOpportunityArchiveText(block({
            timestamp: "2026-10-11T00:00:00.000Z",
            runId: "run-next-exit",
            holdoutBars: 5,
            sortMetric: "expectancy",
            measurementMode: "next_exit",
            rows: [{
                ...row(1, 0, 0),
                forwardOosPerformance: null,
                nextExitOosPerformance: { status: "exited", pnlPercent: 2, exitReason: "take_profit" },
            }],
        }));
        expect(() => analyzeAssetOpportunityArchive(records, { calculationMode: "hold_until_change" }))
            .to.throw(/hold_until_change requires fixed-horizon archives/);
    });

    it("does not analyze matching files inside archive subfolders", () => {
        const directory = mkdtempSync(path.join(process.cwd(), "asset-opportunity-analysis-"));
        try {
            const archiveText = block({
                timestamp: "2026-08-11T00:00:00.000Z",
                runId: "run-a",
                holdoutBars: 12,
                sortMetric: "expectancy",
                rows: [row(1, 4, 1)],
            });
            writeFileSync(path.join(directory, "oos-holdout-12-bars.txt"), archiveText);
            mkdirSync(path.join(directory, "nested"));
            writeFileSync(path.join(directory, "nested", "oos-holdout-13-bars.txt"), archiveText);
            mkdirSync(path.join(directory, "oos-holdout-14-bars.txt"));

            const records = readAssetOpportunityArchive(directory);
            expect(records).to.have.length(1);
            expect(readFileSync(path.join(directory, "oos-holdout-12-bars.txt"), "utf8")).to.equal(archiveText);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
