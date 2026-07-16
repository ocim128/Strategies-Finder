import { expect } from "chai";
import { describe, it } from "node:test";
import { formatDirectionForecastCopy } from "../lib/batch-backtest/batch-direction-forecast-summary";
import type { BatchDirectionForecastResult, BatchDirectionPathMetrics } from "../lib/batch-backtest/batch-signal-lifecycle-types";

function path(overrides: Partial<BatchDirectionPathMetrics> = {}): BatchDirectionPathMetrics {
    return {
        testStartTimeKey: "1700000000",
        testEndTimeKey: "1700003600",
        startEquity: 10_000,
        realizedEquity: 10_500,
        markedEquity: 10_600,
        realizedPnl: 500,
        unrealizedPnl: 100,
        returnPct: 6,
        maxDrawdownPct: 2.5,
        trades: 4,
        winRate: 0.75,
        profitFactor: 2,
        exposurePct: 25,
        turnover: 4,
        ruin: false,
        top1PnlConcentration: 0.4,
        top3PnlConcentration: 0.8,
        worstTradeSymbol: "ETHUSDT",
        worstTradeBias: "DOWN",
        worstTradeEntryTimeKey: "1700000000",
        worstTradeExitTimeKey: "1700003600",
        worstTradeReturnPct: -12.5,
        worstTradePnl: -1250,
        ...overrides,
    };
}

function result(): BatchDirectionForecastResult {
    return {
        schemaVersion: 1,
        interval: "5m",
        fingerprint: "1234567890abcdef",
        strategyKey: "test_strategy",
        generatedAt: 1_700_000_000_000,
        rows: [{
            asset: "BTC",
            symbol: "BTCUSDT",
            aggregateDirection: "long",
            asOfTimeKey: "1700003600",
            asOfPrice: 30_000,
            bias: "UP",
            status: "EDGE",
            reasonCode: "EDGE_CONFIRMED",
            freshness: "FRESH",
            freshnessReason: "DATA_CURRENT",
            lifecycleAge: 3,
            agreementCount: 8,
            oppositionCount: 2,
            candidateCount: 20,
            analogCount: 5,
            probabilityPositive: 0.8,
            probabilityLower: 0.55,
            probabilityUpper: 0.93,
            medianReturnPct: 2.4,
            q1ReturnPct: 1,
            q3ReturnPct: 4,
            medianFavorableExcursionPct: 3,
            medianAdverseExcursionPct: 1,
            averageDistance: 0.4,
            concentrationWarning: false,
            conservativeDirectionProbability: 0.55,
            forecastDirectionReturnPct: 2.4,
            returnToAdverseRatio: 2.4,
        }],
        selectionPath: {
            status: "EXPLORATORY",
            reasonCode: "QUALITY_INSUFFICIENT",
            path: path(),
            quality: {
                status: "VALID",
                selectedReturnPercentile: 0.7,
                excessVsEligibleMedianPct: 1.2,
                selectionHitRate: 0.6,
                meanOpportunityRegretPct: 0.5,
                rankIc: 0.3,
                abstentionRate: 0.2,
                comparableDecisions: 10,
                excludedUnresolvedDecisions: 1,
            },
            benchmarks: {
                rawAgreement: path({ markedEquity: 10_200, returnPct: 2 }),
                randomMedianEquity: 10_050,
                randomP05Equity: 9_800,
                randomP95Equity: 10_300,
                cashEquity: 10_000,
            },
        },
        diagnostics: [],
    };
}

describe("Direction Forecast copy", () => {
    it("is deterministic and includes forecast, path, benchmark, quality, and dollar caveat", () => {
        const first = formatDirectionForecastCopy(result());
        expect(formatDirectionForecastCopy(result())).to.equal(first);
        expect(first).to.include("BTC | BTCUSDT | LONG | UP | EDGE");
        expect(first).to.include("Strategy test_strategy");
        expect(first).to.include("RUN FINGERPRINT | 1234567890abcdef");
        expect(first).to.include("PATH | EXPLORATORY | QUALITY_INSUFFICIENT");
        expect(first).to.include("2023-11-14T22:13:20Z..2023-11-14T23:13:20Z");
        expect(first).to.include("Raw Agreement");
        expect(first).to.include("Random | Median");
        expect(first).to.include("QUALITY | VALID");
        expect(first).to.include("Exposure 25.00%");
        expect(first).to.include("Worst ETHUSDT DOWN -12.50% $-1250.00");
        expect(first).to.include("normalized research equity");
    });
});
