import { expect } from "chai";
import { describe, it } from "node:test";
import type { BacktestResult, Time } from "./lib/strategies";
import type { ParameterRange, WalkForwardResult, WalkForwardWindow } from "./lib/strategies/walk-forward";
import { buildWalkForwardDecayMonitoring, withWalkForwardDecayMonitoring } from "./lib/strategies/walk-forward-decay";

function makeBacktestResult(
    netProfitPercent: number,
    sharpeRatio: number,
    sortinoRatio: number,
    totalTrades = 12
): BacktestResult {
    const netProfit = netProfitPercent * 100;
    const winningTrades = netProfit > 0 ? Math.ceil(totalTrades * 0.58) : Math.floor(totalTrades * 0.42);
    const losingTrades = Math.max(0, totalTrades - winningTrades);

    return {
        trades: [],
        netProfit,
        netProfitPercent,
        winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
        expectancy: totalTrades > 0 ? netProfit / totalTrades : 0,
        avgTrade: totalTrades > 0 ? netProfit / totalTrades : 0,
        profitFactor: netProfitPercent > 0 ? 1.6 : 0.85,
        maxDrawdown: Math.abs(netProfit) * 0.4,
        maxDrawdownPercent: Math.max(1, Math.abs(netProfitPercent) * 0.5),
        totalTrades,
        winningTrades,
        losingTrades,
        avgWin: winningTrades > 0 ? Math.abs(netProfit) / Math.max(1, winningTrades) : 0,
        avgLoss: losingTrades > 0 ? Math.abs(netProfit) / Math.max(1, losingTrades) : 0,
        sharpeRatio,
        equityCurve: [],
        performanceAnalytics: {
            sortinoRatio,
            calmarRatio: 0,
            sterlingRatio: 0,
            tailRatio: 0,
            skewness: 0,
            kurtosis: 0,
            valueAtRisk95: 0,
            conditionalValueAtRisk95: 0,
            ulcerIndex: 0,
            serenityIndex: 0,
            cagr: 0,
            confidenceLevelPct: 95,
            riskFreeRateAnnual: 0,
            sampleCount: totalTrades,
        },
    };
}

function makeWindow(
    windowIndex: number,
    lookback: number,
    sharpeRatio: number,
    sortinoRatio: number,
    netProfitPercent: number
): WalkForwardWindow {
    return {
        windowIndex,
        optimizationStart: windowIndex * 60,
        optimizationEnd: windowIndex * 60 + 40,
        testStart: windowIndex * 60 + 40,
        testEnd: windowIndex * 60 + 60,
        optimizedParams: { lookback },
        inSampleResult: makeBacktestResult(netProfitPercent + 2, sharpeRatio + 0.35, sortinoRatio + 0.4),
        outOfSampleResult: makeBacktestResult(netProfitPercent, sharpeRatio, sortinoRatio),
        sharpeDegradation: 0.35,
        performanceDegradationPercent: 18,
    };
}

function makeWalkForwardResult(windows: WalkForwardWindow[]): WalkForwardResult {
    return {
        windows,
        combinedOOSTrades: makeBacktestResult(
            windows.reduce((sum, window) => sum + window.outOfSampleResult.netProfitPercent, 0),
            0.55,
            0.62,
            windows.reduce((sum, window) => sum + window.outOfSampleResult.totalTrades, 0)
        ),
        avgInSampleSharpe: 1.1,
        avgOutOfSampleSharpe: 0.55,
        walkForwardEfficiency: 0.5,
        robustnessScore: 58,
        totalWindows: windows.length,
        optimizationTimeMs: 125,
        parameterStability: 52,
    };
}

describe("walk-forward decay monitoring", () => {
    it("detects parameter drift, alpha decay, structural change, and half-life on a deteriorating series", () => {
        const windows = [
            makeWindow(0, 10, 1.8, 2.0, 8.4),
            makeWindow(1, 12, 1.6, 1.8, 7.2),
            makeWindow(2, 14, 1.2, 1.3, 4.5),
            makeWindow(3, 16, -0.4, -0.5, -0.8),
            makeWindow(4, 18, -1.4, -1.6, -6.2),
            makeWindow(5, 20, -1.8, -2.1, -9.4),
        ];
        const result = makeWalkForwardResult(windows);
        const ranges: ParameterRange[] = [
            { name: "lookback", min: 10, max: 20, step: 1 }
        ];

        const monitoring = buildWalkForwardDecayMonitoring(result, ranges);

        expect(monitoring.parameterMetrics).to.have.length(1);
        expect(monitoring.parameterMetrics[0]?.driftPercentOfRange).to.be.greaterThan(90);
        expect(monitoring.parameterMetrics[0]?.slopePerWindow).to.be.greaterThan(0);
        expect(monitoring.alphaDecay.status).to.equal("decaying");
        expect(monitoring.alphaDecay.recentVsEarlyDelta).to.be.lessThan(0);
        expect(monitoring.cusum.detected).to.equal(true);
        expect(monitoring.cusum.direction).to.equal("negative_shift");
        expect(monitoring.rollingRisk.length).to.be.greaterThan(0);
        expect((monitoring.rollingRisk[monitoring.rollingRisk.length - 1]?.sharpe ?? 0))
            .to.be.lessThan(monitoring.rollingRisk[0]?.sharpe ?? 0);
        expect(monitoring.halfLife.halfLifeWindows).to.not.equal(null);
        expect((monitoring.halfLife.halfLifeWindows ?? 0) > 0).to.equal(true);
    });

    it("returns conservative defaults when there is not enough window history", () => {
        const windows = [
            makeWindow(0, 12, 0.8, 0.9, 3.2),
            makeWindow(1, 12, 0.7, 0.8, 2.9),
        ];
        const result = makeWalkForwardResult(windows);

        const monitoring = buildWalkForwardDecayMonitoring(result, []);

        expect(monitoring.parameterMetrics).to.deep.equal([]);
        expect(monitoring.alphaDecay.status).to.equal("insufficient_data");
        expect(monitoring.cusum.detected).to.equal(false);
        expect(monitoring.halfLife.halfLifeWindows).to.equal(null);
    });

    it("classifies soft but meaningful deterioration as weakening instead of stable", () => {
        const windows = Array.from({ length: 12 }, (_, index) => {
            const lookback = 220 - (index * 6);
            const sharpe = 2.9 - (index * 0.08);
            const sortino = 4.4 - (index * 0.12);
            const net = 7.5 - (index * 0.35);
            return makeWindow(index, lookback, sharpe, sortino, net);
        });
        const result = makeWalkForwardResult(windows);
        const ranges: ParameterRange[] = [
            { name: "lookback", min: 120, max: 260, step: 1 }
        ];

        const monitoring = buildWalkForwardDecayMonitoring(result, ranges);

        expect(monitoring.alphaDecay.status).to.equal("weakening");
        expect(monitoring.alphaDecay.recentVsEarlyDelta).to.be.lessThan(0);
        expect(monitoring.rollingComparison.sharpeLatestVsPeak).to.be.lessThan(0);
        expect(monitoring.rollingComparison.comparisonWindowSize).to.be.greaterThan(0);
        expect(typeof monitoring.halfLife.reason).to.equal("string");
        expect(monitoring.halfLife.reason.length).to.be.greaterThan(0);
    });

    it("suppresses half-life when the decay fit is too weak", () => {
        const sharpeSeries = [3.0, 1.4, 3.1, 1.5, 3.0, 1.6, 3.2, 1.5, 3.1, 1.4, 3.0, 1.5];
        const sortinoSeries = [5.1, 2.0, 5.2, 2.2, 5.0, 2.4, 5.4, 2.3, 5.3, 2.1, 5.0, 2.2];
        const windows = sharpeSeries.map((sharpe, index) =>
            makeWindow(index, 100 - (index * 2), sharpe, sortinoSeries[index] ?? sharpe + 1.5, 6.5 - (index * 0.2))
        );
        const monitoring = buildWalkForwardDecayMonitoring(makeWalkForwardResult(windows), [
            { name: "lookback", min: 60, max: 120, step: 1 }
        ]);

        expect(monitoring.halfLife.halfLifeWindows).to.equal(null);
        expect(monitoring.halfLife.reason.length).to.be.greaterThan(0);
    });

    it("applies a bounded robustness penalty when decay signals stack up", () => {
        const windows = [
            makeWindow(0, 12, 3.8, 6.5, 9.5),
            makeWindow(1, 11, 3.4, 5.8, 8.1),
            makeWindow(2, 10, 2.9, 4.9, 6.8),
            makeWindow(3, 9, 1.8, 3.1, 4.0),
            makeWindow(4, 8, 0.4, 1.2, 1.1),
            makeWindow(5, 7, -0.9, -0.3, -2.7),
            makeWindow(6, 6, -1.6, -0.8, -5.0),
        ];
        const baseResult: WalkForwardResult = {
            ...makeWalkForwardResult(windows),
            robustnessScore: 74,
            parameterStability: 34,
        };

        const enriched = withWalkForwardDecayMonitoring(baseResult, [
            { name: "lookback", min: 6, max: 12, step: 1 }
        ]);

        expect(enriched.decayMonitoring?.robustnessPenalty).to.be.greaterThan(0);
        expect((enriched.decayMonitoring?.robustnessPenaltyReasons.length ?? 0)).to.be.greaterThan(0);
        expect(enriched.robustnessScore).to.be.lessThan(baseResult.robustnessScore);
    });
});
