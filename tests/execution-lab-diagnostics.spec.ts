import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildExecutionLabDiagnostics,
    createExecutionLabDiagnosticAccumulator,
    recordExecutionLabDiagnosticStats,
    resolveExecutionLabCandleSequenceWarning,
    type ExecutionLabDiagnosticSample,
} from "../lib/execution-lab/execution-lab-diagnostics";

function sample(ts: number, repeated: boolean): ExecutionLabDiagnosticSample {
    const warnings = [
        "binance_zero_volume_candle",
        "binance_fill_candle",
        repeated ? "binance_repeated_candle" : null,
    ].filter((warning): warning is string => warning !== null);
    return {
        recordedAtIso: new Date(ts * 1000).toISOString(),
        mode: "miner",
        symbol: "BTCUSDT",
        marketType: "futures",
        candle: {
            timeSec: ts,
            open: 101,
            high: 101,
            low: 101,
            close: 101,
            volume: 0,
            tradeCount: 0,
            source: "binance_1s_fill",
            updatedAtIso: new Date(ts * 1000).toISOString(),
        },
        feedLagSec: repeated ? 3 : 2,
        quote: {
            sampleTs: ts,
            sampleMinusCandleSec: 0,
            quoteAgeSec: 0.25,
            source: "polymarket_clob_live",
            sourceAgeSec: 0.3,
            yesBid: 0.2,
            yesAsk: 0.21,
            yesMid: 0.205,
            noBid: 0.79,
            noAsk: 0.8,
            noMid: 0.795,
            qualityFlags: [],
        },
        event: {
            marketSlug: "btc-event",
            eventStartTs: ts - 10,
            eventEndTs: ts + 290,
            secondsToEnd: 290,
            startClose: 100,
            moveFromStart: 1,
            moveFromStartPct: 1,
        },
        warnings,
    };
}

function healthySample(
    ts: number,
    secondsToEnd: number,
    quoteOverrides: Partial<NonNullable<ExecutionLabDiagnosticSample["quote"]>> = {}
): ExecutionLabDiagnosticSample {
    const base = sample(ts, false);
    return {
        ...base,
        candle: {
            timeSec: ts,
            open: 101,
            high: 101,
            low: 101,
            close: 101,
            volume: 1,
            tradeCount: 1,
            source: "binance_1s",
            updatedAtIso: new Date(ts * 1000).toISOString(),
        },
        event: {
            marketSlug: "btc-event",
            eventStartTs: ts - (300 - secondsToEnd),
            eventEndTs: ts + secondsToEnd,
            secondsToEnd,
            startClose: 100,
            moveFromStart: 1,
            moveFromStartPct: 1,
        },
        quote: base.quote ? { ...base.quote, ...quoteOverrides } : null,
        warnings: [],
    };
}

describe("Execution Lab diagnostics", () => {
    it("treats repeated real Binance candles as cadence, not quality warnings", () => {
        expect(resolveExecutionLabCandleSequenceWarning({
            currentTimeSec: 1_700_000_000,
            previousTimeSec: 1_700_000_000,
            currentHasNoTrades: false,
            currentIsFill: false,
        })).to.equal(null);

        expect(resolveExecutionLabCandleSequenceWarning({
            currentTimeSec: 1_700_000_000,
            previousTimeSec: 1_700_000_000,
            currentHasNoTrades: true,
            currentIsFill: true,
        })).to.equal("binance_repeated_candle");
    });

    it("keeps healthy event runs split into readable phase segments", () => {
        const samples = [
            healthySample(1_700_000_000, 91),
            healthySample(1_700_000_001, 90),
            healthySample(1_700_000_031, 60),
            healthySample(1_700_000_061, 30),
            healthySample(1_700_000_091, 0),
        ];
        const stats = createExecutionLabDiagnosticAccumulator();
        for (const item of samples) recordExecutionLabDiagnosticStats(stats, item);

        const diagnostics = buildExecutionLabDiagnostics(samples, stats, {
            retainedSampleLimit: 300,
            segmentLimit: 12,
            maxLiveCandleLagSec: 10,
        });

        expect(diagnostics?.segments).to.have.length(4);
        expect(diagnostics?.segments.map((segment) => [segment.secondsToEndMin, segment.secondsToEndMax])).to.deep.equal([
            [90, 91],
            [60, 60],
            [30, 30],
            [0, 0],
        ]);
        expect(diagnostics?.summary.health.status).to.equal("ok");
    });

    it("keeps rare historical inverted spreads visible without failing current health", () => {
        const samples = Array.from({ length: 100 }, (_, index) => healthySample(
            1_700_000_000 + index,
            200 - index,
            index === 0 ? { yesBid: 0.22, yesAsk: 0.21 } : {}
        ));
        const stats = createExecutionLabDiagnosticAccumulator();
        for (const item of samples) recordExecutionLabDiagnosticStats(stats, item);

        const diagnostics = buildExecutionLabDiagnostics(samples, stats, {
            retainedSampleLimit: 300,
            segmentLimit: 12,
            maxLiveCandleLagSec: 10,
        });

        expect(diagnostics?.summary.invertedYesSpreadCount).to.equal(1);
        expect(diagnostics?.summary.invertedYesSpreadPct).to.equal(1);
        expect(diagnostics?.summary.health.status).to.equal("ok");
    });

    it("flags the latest inverted spread as current health risk", () => {
        const samples = Array.from({ length: 100 }, (_, index) => healthySample(
            1_700_000_000 + index,
            200 - index,
            index === 99 ? { yesBid: 0.22, yesAsk: 0.21 } : {}
        ));
        const stats = createExecutionLabDiagnosticAccumulator();
        for (const item of samples) recordExecutionLabDiagnosticStats(stats, item);

        const diagnostics = buildExecutionLabDiagnostics(samples, stats, {
            retainedSampleLimit: 300,
            segmentLimit: 12,
            maxLiveCandleLagSec: 10,
        });

        expect(diagnostics?.summary.invertedYesSpreadPct).to.equal(1);
        expect(diagnostics?.summary.health.status).to.equal("warning");
        expect(diagnostics?.summary.health.issues.map((issue) => issue.code)).to.deep.equal(["inverted_yes_spread"]);
    });

    it("copies compact v6 diagnostics with cumulative health instead of raw retained samples", () => {
        const samples = [sample(1_700_000_000, false), sample(1_700_000_000, true)];
        const stats = createExecutionLabDiagnosticAccumulator();
        for (const item of samples) recordExecutionLabDiagnosticStats(stats, item);

        const diagnostics = buildExecutionLabDiagnostics(samples, stats, {
            retainedSampleLimit: 300,
            segmentLimit: 12,
            maxLiveCandleLagSec: 10,
        });

        expect(diagnostics?.schema).to.equal("execution_lab.price_alignment.v6");
        expect(diagnostics).to.not.have.property("samples");
        expect(diagnostics).to.not.have.property("transitionSamples");
        expect(diagnostics?.latest?.candle).to.include({ open: 101, close: 101 });
        expect(diagnostics?.segments).to.have.length(2);
        expect(diagnostics?.segments[0]).to.include({
            candleUniqueTimeCount: 1,
            closeAvg: 101,
            quoteCoveragePct: 100,
            yesMidAvg: 0.205,
            noMidAvg: 0.795,
            latestYesBid: 0.2,
            latestYesAsk: 0.21,
        });
        expect(diagnostics?.segments[0]).to.not.have.property("quote");
        expect(diagnostics?.summary).to.include({
            totalSamples: 2,
            retainedSampleCount: 2,
            quoteCoveragePct: 100,
            fillCandlePct: 100,
            zeroVolumeCandlePct: 100,
        });
        expect(diagnostics?.summary.warningCounts.binance_repeated_candle).to.equal(1);
        expect(diagnostics?.summary.health.status).to.equal("critical");
        expect(diagnostics?.summary.health.issues.map((issue) => issue.code)).to.include("binance_fill_only");
    });
});
