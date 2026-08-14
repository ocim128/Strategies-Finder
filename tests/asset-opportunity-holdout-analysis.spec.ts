import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    analyzeAssetOpportunityArchive,
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
}): string {
    return [
        "=".repeat(80),
        `Timestamp: ${args.timestamp}`,
        `Batch run id: ${args.runId}`,
        `OOS holdout: ${args.holdoutBars} bars`,
        `Archive sort: ${args.sortMetric}`,
        ...(args.baseline === undefined ? [] : [`Archive baseline: ${JSON.stringify(args.baseline)}`]),
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
