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
        ...(args.nextExitBaseline === undefined ? [] : [`Next-exit archive baseline: ${JSON.stringify(args.nextExitBaseline)}`]),
        "=".repeat(80),
        JSON.stringify(args.rows),
        "=".repeat(80),
    ].join("\n");
}

function row(rank: number, pnl: number, sampleSize: number): Record<string, unknown> {
    return {
        scope: "asset_opportunity",
        rank,
        symbol: "PAIR•",
        strategyId: "strategy_a",
        strategyName: "Strategy A",
        forwardOosPerformance: {
            ignoreLastBars: 12,
            horizons: [{ bars: 12, pnlPercent: pnl, averagePnlPercent: pnl, winRatePercent: pnl > 0 ? 100 : 0, sampleSize }],
        },
    };
}

describe("Asset Opportunity holdout analysis", () => {
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
