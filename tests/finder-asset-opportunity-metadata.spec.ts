import { expect } from "chai";
import { describe, it } from "node:test";
import {
    ASSET_OPPORTUNITY_POOL_SELECTION_METRIC_KEYS,
    assetOpportunityNearestRankPercentile,
    buildAssetOpportunityCandidateFingerprint,
    buildAssetOpportunityForwardOosBaseline,
    buildAssetOpportunityForwardOosBaselinesByBasis,
    buildAssetOpportunityNextExitOosBaseline,
    buildAssetOpportunityMetadataPayload,
    buildAssetOpportunityPerformancePayload,
    buildAssetOpportunityPoolDistribution,
} from "../lib/finder/finder-asset-opportunity-metadata";
import type { FinderAssetOpportunityResult } from "../lib/types/finder";
import type { Time } from "../lib/types/strategies";

function makeAssetResult(overrides: Partial<FinderAssetOpportunityResult> = {}): FinderAssetOpportunityResult {
    const backtest = {
        trades: [],
        equityCurve: [],
        netProfit: 10,
        netProfitPercent: 1,
        winRate: 50,
        expectancy: 1,
        avgTrade: 1,
        profitFactor: 1.2,
        maxDrawdown: 2,
        maxDrawdownPercent: 1,
        totalTrades: 2,
        winningTrades: 1,
        losingTrades: 1,
        avgWin: 2,
        avgLoss: 1,
        sharpeRatio: 0.5,
    };
    return {
        symbol: "BTCUSDT",
        strategyKey: "momentum",
        strategyName: "Momentum",
        params: { lookback: 21 },
        exitStrategyKey: "trailing_exit",
        exitStrategyName: "Trailing Exit",
        exitStrategyParams: { trailPercent: 2 },
        historicalRank: 3,
        totalCandidatesEvaluated: 120,
        isHistoricalBest: false,
        freshStatus: "fresh",
        direction: "long",
        latestSignalTime: 1_700_000_000 as Time,
        signalAgeBars: 0,
        fillTiming: "signal_close",
        selectionResult: backtest,
        oosResult: { ...backtest, totalTrades: 1 },
        oosVerdict: "pass",
        oosHorizonMetrics: {
            ignoreLastBars: 5,
            horizons: [
                { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
            ],
        },
        support: {
            freshLongCandidates: 2,
            freshShortCandidates: 0,
            freshSameDirection: 2,
            poolSize: 10,
            bestFreshRank: 1,
            directionAgreementRatio: 1,
        },
        grade: "select",
        ...overrides,
    };
}

describe("Asset Opportunity metadata payload serializer", () => {
    it("serializes the full Copy Top Results shape with interval and strategy metadata", () => {
        const payload = buildAssetOpportunityMetadataPayload({
            result: makeAssetResult(),
            rank: 1,
            interval: "15m",
            strategyMetadata: { author: "tester" },
        });
        expect(payload).to.deep.equal({
            scope: "asset_opportunity",
            rank: 1,
            symbol: "BTCUSDT",
            strategyId: "momentum",
            strategyName: "Momentum",
            interval: "15m",
            params: { lookback: 21 },
            metadata: { author: "tester" },
            direction: "long",
            freshStatus: "fresh",
            latestSignalTime: 1_700_000_000,
            signalAgeBars: 0,
            fillTiming: "signal_close",
            historicalRank: 3,
            totalCandidatesEvaluated: 120,
            selectionMetrics: {
                trades: [],
                equityCurve: [],
                netProfit: 10,
                netProfitPercent: 1,
                winRate: 50,
                expectancy: 1,
                avgTrade: 1,
                profitFactor: 1.2,
                maxDrawdown: 2,
                maxDrawdownPercent: 1,
                totalTrades: 2,
                winningTrades: 1,
                losingTrades: 1,
                avgWin: 2,
                avgLoss: 1,
                sharpeRatio: 0.5,
            },
            support: {
                freshLongCandidates: 2,
                freshShortCandidates: 0,
                freshSameDirection: 2,
                poolSize: 10,
                bestFreshRank: 1,
                directionAgreementRatio: 1,
            },
            grade: "select",
            oos: {
                metrics: {
                    trades: [],
                    equityCurve: [],
                    netProfit: 10,
                    netProfitPercent: 1,
                    winRate: 50,
                    expectancy: 1,
                    avgTrade: 1,
                    profitFactor: 1.2,
                    maxDrawdown: 2,
                    maxDrawdownPercent: 1,
                    totalTrades: 1,
                    winningTrades: 1,
                    losingTrades: 1,
                    avgWin: 2,
                    avgLoss: 1,
                    sharpeRatio: 0.5,
                },
                verdict: "pass",
            },
            oosHorizonMetrics: {
                ignoreLastBars: 5,
                horizons: [
                    { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
                ],
            },
            activePositionContinuationMetrics: null,
            oosNextExitMetrics: null,
            exitStrategy: {
                key: "trailing_exit",
                name: "Trailing Exit",
                params: { trailPercent: 2 },
            },
        });
    });

    it("nulls missing OOS, strategy metadata, and exit strategy fields", () => {
        const result = makeAssetResult({
            oosResult: undefined,
            oosVerdict: undefined,
            oosHorizonMetrics: undefined,
            exitStrategyKey: undefined,
            exitStrategyName: undefined,
            exitStrategyParams: undefined,
        });
        const payload = buildAssetOpportunityMetadataPayload({
            result,
            rank: 2,
            interval: "5m",
            strategyMetadata: undefined,
        });
        expect(payload.metadata).to.equal(null);
        expect(payload.oos).to.equal(null);
        expect(payload.oosHorizonMetrics).to.equal(null);
        expect(payload.activePositionContinuationMetrics).to.equal(null);
        expect(payload.exitStrategy).to.equal(null);
    });

    it("includes the median TP scalar in Copy Top Results when available", () => {
        const payload = buildAssetOpportunityMetadataPayload({
            result: makeAssetResult({ medianBarsToTp: 4.5 }),
            rank: 1,
            interval: "1h",
            strategyMetadata: null,
        });
        expect(payload.medianBarsToTp).to.equal(4.5);
    });

    it("carries every thesis scalar through Copy Top Results and the archive row", () => {
        const result = makeAssetResult({
            medianBarsToTp: 4.5,
            priorTupleRecurrenceCount: 2,
            barrierExitShare: 0.8,
            entryHourConcentration: 0.75,
            tradeGapUniformity: 1.25,
            topDecileProfitShare: 0.4,
            winnerLoserHoldGapBars: -2,
            entryPriceRegimeMembership: 0.9,
            equityPathLinearity: 0.85,
        });
        const copy = buildAssetOpportunityMetadataPayload({
            result,
            rank: 1,
            interval: "1h",
            strategyMetadata: null,
        });
        expect(copy).to.include({
            medianBarsToTp: 4.5,
            priorTupleRecurrenceCount: 2,
            barrierExitShare: 0.8,
            entryHourConcentration: 0.75,
            tradeGapUniformity: 1.25,
            topDecileProfitShare: 0.4,
            winnerLoserHoldGapBars: -2,
            entryPriceRegimeMembership: 0.9,
            equityPathLinearity: 0.85,
        });
        const archive = buildAssetOpportunityPerformancePayload({ result, rank: 1 });
        expect(archive.selectionPerformance).to.include({
            medianBarsToTp: 4.5,
            priorTupleRecurrenceCount: 2,
            barrierExitShare: 0.8,
            entryHourConcentration: 0.75,
            tradeGapUniformity: 1.25,
            topDecileProfitShare: 0.4,
            winnerLoserHoldGapBars: -2,
            entryPriceRegimeMembership: 0.9,
            equityPathLinearity: 0.85,
        });
    });

    it("builds a compact performance-only archive row", () => {
        const payload = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult(),
            rank: 1,
        });
        expect(payload).to.deep.equal({
            scope: "asset_opportunity",
            rank: 1,
            symbol: "BTCUSDT",
            strategyId: "momentum",
            strategyName: "Momentum",
            candidateFingerprint: buildAssetOpportunityCandidateFingerprint(makeAssetResult()),
            signalCandleHourUtc: 22,
            signalCandleHourJakarta: 5,
            selectionPerformance: {
                netProfit: 10,
                netProfitPercent: 1,
                winRate: 50,
                expectancy: 1,
                avgTrade: 1,
                profitFactor: 1.2,
                maxDrawdown: 2,
                maxDrawdownPercent: 1,
                totalTrades: 2,
                winningTrades: 1,
                losingTrades: 1,
                avgWin: 2,
                avgLoss: 1,
                sharpeRatio: 0.5,
            },
            oosPerformance: {
                verdict: "pass",
                metrics: {
                    netProfit: 10,
                    netProfitPercent: 1,
                    winRate: 50,
                    expectancy: 1,
                    avgTrade: 1,
                    profitFactor: 1.2,
                    maxDrawdown: 2,
                    maxDrawdownPercent: 1,
                    totalTrades: 1,
                    winningTrades: 1,
                    losingTrades: 1,
                    avgWin: 2,
                    avgLoss: 1,
                    sharpeRatio: 0.5,
                },
            },
            forwardOosPerformance: {
                ignoreLastBars: 5,
                horizons: [
                    { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
                ],
            },
            nextExitOosPerformance: null,
        });
        expect(JSON.stringify(payload)).to.not.contain("lookback");
        expect(JSON.stringify(payload)).to.not.contain("trades");
        expect(JSON.stringify(payload)).to.not.contain("equityCurve");
    });

    it("persists medianBarsToTp when present and leaves legacy rows missing", () => {
        const withMetric = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult({ medianBarsToTp: 4.5 }),
            rank: 1,
        });
        expect(withMetric.selectionPerformance.medianBarsToTp).to.equal(4.5);

        const legacy = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult(),
            rank: 1,
        });
        expect(Object.prototype.hasOwnProperty.call(legacy.selectionPerformance, "medianBarsToTp")).to.equal(false);
        expect(legacy.selectionPerformance.medianBarsToTp).to.not.equal(0);
    });

    it("persists resort-supplied thesis values needed by later archive analysis", () => {
        const payload = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult({
                freshSignalLibraryCount: 4,
                totalTradesCappedValue: 120,
            }),
            rank: 1,
        });

        expect(payload.freshSignalLibraryCount).to.equal(4);
        expect(payload.totalTradesCappedValue).to.equal(120);
    });

    it("persists the consensus rank weight when present and leaves legacy rows missing", () => {
        const payload = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult({ consensusRankWeight: 35 }),
            rank: 1,
        });
        expect(payload.consensusRankWeight).to.equal(35);

        // A symbol that failed the coverage floor carries the explicit null.
        const missing = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult({ consensusRankWeight: null }),
            rank: 1,
        });
        expect(missing.consensusRankWeight).to.equal(null);

        // Legacy rows/snapshots without the field stay valid and omit it entirely.
        const legacy = buildAssetOpportunityPerformancePayload({ result: makeAssetResult(), rank: 1 });
        expect(Object.prototype.hasOwnProperty.call(legacy, "consensusRankWeight")).to.equal(false);

        // The browser copy payload mirrors the archive payload.
        const metadata = buildAssetOpportunityMetadataPayload({
            result: makeAssetResult({ consensusRankWeight: 12 }),
            rank: 1,
            interval: "1d",
            strategyMetadata: null,
        });
        expect(metadata.consensusRankWeight).to.equal(12);
    });

    it("ranks are passed through 1-based per displayed row", () => {
        const rows = [makeAssetResult(), makeAssetResult({ symbol: "ETHUSDT" })];
        const payloads = rows.map((result, index) => buildAssetOpportunityMetadataPayload({
            result,
            rank: index + 1,
            interval: "1d",
            strategyMetadata: null,
        }));
        expect(payloads.map((payload) => payload.rank)).to.deep.equal([1, 2]);
    });

    it("builds a baseline from all available result rows before top-N slicing", () => {
        const baseline = buildAssetOpportunityForwardOosBaseline([
            makeAssetResult(),
            makeAssetResult({
                symbol: "ETHUSDT",
                oosHorizonMetrics: {
                    ignoreLastBars: 5,
                    horizons: [
                        { bars: 1, pnlPercent: -2, averagePnlPercent: -2, winRatePercent: 0, sampleSize: 1 },
                    ],
                },
            }),
        ]);
        expect(baseline.eligibleCandidateCount).to.equal(2);
        expect(baseline.horizons).to.deep.equal([{
            bars: 1,
            averagePnlPercent: -0.5,
            sampleWeightedAveragePnlPercent: -0.5,
            positiveResults: 1,
            observedResults: 2,
            totalSamples: 2,
        }]);
    });

    it("merges per-basis forward measurements into the archive row", () => {
        const pairMetrics = {
            ignoreLastBars: 5,
            basis: "pair" as const,
            horizons: [
                { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
            ],
        };
        const quoteMetrics = {
            ignoreLastBars: 5,
            basis: "quote_only" as const,
            horizons: [
                { bars: 1, pnlPercent: -3, averagePnlPercent: -3, winRatePercent: 0, sampleSize: 1 },
            ],
        };
        const baseContinuation = {
            ignoreLastBars: 5,
            basis: "base_only" as const,
            horizons: [
                { bars: 1, pnlPercent: 2, averagePnlPercent: 2, winRatePercent: 100, sampleSize: 1 },
            ],
        };
        const payload = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult({
                oosHorizonMetrics: pairMetrics,
                oosHorizonMetricsByBasis: { pair: pairMetrics, quote_only: quoteMetrics },
                activePositionContinuationMetricsByBasis: { base_only: baseContinuation },
            }),
            rank: 1,
        });
        // Fresh-entry metrics win per basis; OPEN continuation fills the gap.
        expect(payload.forwardOosPerformanceByBasis).to.deep.equal({
            pair: pairMetrics,
            quote_only: quoteMetrics,
            base_only: baseContinuation,
        });

        // Single-basis results keep the row shape unchanged for old consumers.
        const legacy = buildAssetOpportunityPerformancePayload({ result: makeAssetResult(), rank: 1 });
        expect(Object.prototype.hasOwnProperty.call(legacy, "forwardOosPerformanceByBasis")).to.equal(false);
    });

    it("builds per-basis baselines from the same-pass measurements", () => {
        const quoteMetrics = (pnlPercent: number, sampleSize: number) => ({
            ignoreLastBars: 5,
            basis: "quote_only" as const,
            horizons: [
                { bars: 1, pnlPercent, averagePnlPercent: pnlPercent, winRatePercent: pnlPercent > 0 ? 100 : 0, sampleSize },
            ],
        });
        const results = [
            makeAssetResult({
                oosHorizonMetricsByBasis: {
                    pair: { ignoreLastBars: 5, basis: "pair", horizons: [{ bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 }] },
                    quote_only: quoteMetrics(-3, 1),
                },
            }),
            makeAssetResult({
                symbol: "ETHUSDT",
                oosHorizonMetricsByBasis: {
                    quote_only: quoteMetrics(6, 2),
                },
            }),
        ];
        const baseline = buildAssetOpportunityForwardOosBaseline(results, "quote_only");
        expect(baseline.eligibleCandidateCount).to.equal(2);
        expect(baseline.horizons).to.deep.equal([{
            bars: 1,
            averagePnlPercent: 1.5,
            sampleWeightedAveragePnlPercent: ( -3 * 1 + 6 * 2 ) / 3,
            positiveResults: 1,
            observedResults: 2,
            totalSamples: 3,
        }]);
        const byBasis = buildAssetOpportunityForwardOosBaselinesByBasis(results);
        expect([...Object.keys(byBasis ?? {})].sort()).to.deep.equal(["pair", "quote_only"]);
        expect(byBasis?.quote_only).to.deep.equal(baseline);

        // No per-basis data keeps the unscoped baseline only.
        expect(buildAssetOpportunityForwardOosBaselinesByBasis([makeAssetResult()])).to.equal(null);
    });

    it("keeps next-exit archive metrics separate from fixed horizons", () => {
        const result = makeAssetResult({
            oosHorizonMetrics: undefined,
            oosNextExitMetrics: {
                ignoreLastBars: 5,
                status: "exited",
                pnlPercent: 1.5,
                exitReason: "take_profit",
                unavailableReason: null,
                barsHeld: 2,
                exitTime: 1_700_000_600 as Time,
            },
        });
        const payload = buildAssetOpportunityPerformancePayload({ result, rank: 1 });
        expect(payload.forwardOosPerformance).to.equal(null);
        expect(payload.nextExitOosPerformance).to.deep.equal(result.oosNextExitMetrics);
        expect(buildAssetOpportunityNextExitOosBaseline([
            result,
            makeAssetResult({
                symbol: "ETHUSDT",
                oosHorizonMetrics: undefined,
                oosNextExitMetrics: {
                    ignoreLastBars: 5,
                    status: "censored",
                    pnlPercent: null,
                    exitReason: "end_of_data",
                    unavailableReason: null,
                    barsHeld: 5,
                    exitTime: 1_700_001_500 as Time,
                },
            }),
            makeAssetResult({
                symbol: "BTCUSDT",
                oosHorizonMetrics: undefined,
                oosNextExitMetrics: {
                    ignoreLastBars: 5,
                    status: "unavailable",
                    pnlPercent: null,
                    exitReason: null,
                    unavailableReason: "no_boundary_trade",
                    barsHeld: null,
                    exitTime: null,
                },
            }),
        ])).to.deep.equal({
            eligibleCandidateCount: 3,
            observedExits: 1,
            censoredResults: 1,
            unavailableResults: 1,
            averagePnlPercent: 1.5,
            exitReasonCounts: { take_profit: 1, end_of_data: 1 },
            unavailableReasonCounts: { no_boundary_trade: 1 },
        });
    });

    it("builds a pool distribution whose horizon mean equals the baseline", () => {
        const rows = [1, 4, 2, 8, 5].map((netProfit, index) => makeAssetResult({
            symbol: `SYM${index}USDT`,
            selectionResult: { ...makeAssetResult().selectionResult, netProfit, expectancy: netProfit / 2 },
            oosHorizonMetrics: {
                ignoreLastBars: 5,
                horizons: [
                    { bars: 1, pnlPercent: netProfit, averagePnlPercent: netProfit, winRatePercent: 50, sampleSize: 1 },
                ],
            },
        }));
        const baseline = buildAssetOpportunityForwardOosBaseline(rows);
        const distribution = buildAssetOpportunityPoolDistribution(rows);
        expect(distribution.eligibleCandidateCount).to.equal(5);
        expect(distribution.horizons).to.have.lengthOf(1);
        const horizon = distribution.horizons[0]!;
        expect(horizon.bars).to.equal(1);
        expect(horizon.averagePnlPercent).to.equal(baseline.horizons[0]!.averagePnlPercent);
        expect(horizon.observedResults).to.equal(baseline.horizons[0]!.observedResults);
        expect(horizon.totalSamples).to.equal(baseline.horizons[0]!.totalSamples);
        // Nearest-rank percentiles over the sorted pool values [1, 2, 4, 5, 8].
        expect([horizon.p10, horizon.p25, horizon.p50, horizon.p75, horizon.p90])
            .to.deep.equal([1, 2, 4, 5, 8]);
        // Selection scalars: frozen key set only, count over finite values.
        expect(Object.keys(distribution.selection)).to.deep.equal([...ASSET_OPPORTUNITY_POOL_SELECTION_METRIC_KEYS]);
        expect(distribution.selection.netProfit).to.deep.equal({
            count: 5,
            p10: 1,
            p25: 2,
            p50: 4,
            p75: 5,
            p90: 8,
        });
        expect(distribution.selection.expectancy).to.deep.equal({
            count: 5,
            p10: 0.5,
            p25: 1,
            p50: 2,
            p75: 2.5,
            p90: 4,
        });
    });

    it("returns empty horizons and zero-count scalars for an empty pool", () => {
        const distribution = buildAssetOpportunityPoolDistribution([]);
        expect(distribution.eligibleCandidateCount).to.equal(0);
        expect(distribution.horizons).to.deep.equal([]);
        for (const key of ASSET_OPPORTUNITY_POOL_SELECTION_METRIC_KEYS) {
            expect(distribution.selection[key]).to.deep.equal({
                count: 0,
                p10: null,
                p25: null,
                p50: null,
                p75: null,
                p90: null,
            });
        }
    });

    it("computes per-basis horizon distributions with the baseline's eligibility", () => {
        const results = [
            makeAssetResult({
                oosHorizonMetricsByBasis: {
                    pair: { ignoreLastBars: 5, basis: "pair", horizons: [{ bars: 1, pnlPercent: 3, averagePnlPercent: 3, winRatePercent: 100, sampleSize: 1 }] },
                    quote_only: { ignoreLastBars: 5, basis: "quote_only", horizons: [{ bars: 1, pnlPercent: -5, averagePnlPercent: -5, winRatePercent: 0, sampleSize: 1 }] },
                },
            }),
            makeAssetResult({
                symbol: "ETHUSDT",
                oosHorizonMetricsByBasis: {
                    quote_only: { ignoreLastBars: 5, basis: "quote_only", horizons: [{ bars: 1, pnlPercent: 7, averagePnlPercent: 7, winRatePercent: 100, sampleSize: 2 }] },
                },
            }),
        ];
        const distribution = buildAssetOpportunityPoolDistribution(results);
        expect(Object.keys(distribution.horizonsByBasis ?? {}).sort()).to.deep.equal(["pair", "quote_only"]);
        const quote = distribution.horizonsByBasis!.quote_only![0]!;
        expect(quote.averagePnlPercent).to.equal(buildAssetOpportunityForwardOosBaseline(results, "quote_only").horizons[0]!.averagePnlPercent);
        expect(quote.observedResults).to.equal(2);
        expect(quote.totalSamples).to.equal(3);
        // Nearest-rank over [-5, 7]: p10 = index round(0.1) = -5, p50/p90 = index 1 = 7.
        expect([quote.p10, quote.p50, quote.p90]).to.deep.equal([-5, 7, 7]);

        // Selection-only mode (next-exit runs) keeps scalars and drops horizons.
        const selectionOnly = buildAssetOpportunityPoolDistribution(results, undefined, { includeHorizons: false });
        expect(selectionOnly.horizons).to.deep.equal([]);
        expect(selectionOnly.horizonsByBasis).to.equal(undefined);
        expect(selectionOnly.selection.netProfit.count).to.equal(2);
    });

    it("pins the nearest-rank percentile to the scripts/lib method", () => {
        const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        expect(assetOpportunityNearestRankPercentile(values, 0)).to.equal(10);
        // 10 values: index round((n-1)*fraction); p90 = index 8, only p100 = index 9.
        expect(assetOpportunityNearestRankPercentile(values, 0.1)).to.equal(20);
        expect(assetOpportunityNearestRankPercentile(values, 0.5)).to.equal(60);
        expect(assetOpportunityNearestRankPercentile(values, 0.9)).to.equal(90);
        expect(assetOpportunityNearestRankPercentile(values, 0.95)).to.equal(100);
        expect(assetOpportunityNearestRankPercentile(values, 1)).to.equal(100);
        // Nearest-rank, not interpolated: nearby fractions do not blend values.
        expect(assetOpportunityNearestRankPercentile(values, 0.55)).to.equal(60);
        expect(assetOpportunityNearestRankPercentile(values, 0.54)).to.equal(60);
        expect(assetOpportunityNearestRankPercentile([], 0.5)).to.equal(null);
        expect(assetOpportunityNearestRankPercentile(values, Number.NaN)).to.equal(null);
    });

});
