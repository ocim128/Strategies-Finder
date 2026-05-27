import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildStrategyDebuggerDiagnostic,
    buildStrategyDebuggerMetrics,
    buildStrategyDebuggerTradeOverlap,
} from "../lib/strategy-debugger-analysis";
import type { BacktestResult, Trade } from "../lib/types/strategies";
import type { BacktestPolymarketTradeSummary } from "../lib/types/polymarket-outcomes";

function makeTrade(
    id: number,
    eventStartTs: number,
    entryPrice: number,
    isWin: boolean,
    type: "long" | "short" = "long"
): Trade {
    const payout = isWin ? 1 - entryPrice : -entryPrice;
    return {
        id,
        type,
        entryTime: eventStartTs + 100,
        entryPrice: 100,
        exitTime: eventStartTs + 300,
        exitPrice: 101,
        pnl: 0,
        pnlPercent: 0,
        size: 1,
        polymarketOutcome: {
            eventStartTs,
            eventEndTs: eventStartTs + 300,
            eventSlug: `event-${eventStartTs}`,
            marketSlug: `market-${eventStartTs}`,
            prediction: type === "long" ? "yes" : "no",
            actualOutcomeUp: isWin ? 1 : 0,
            isWin,
            marketEntryPrice: entryPrice,
            marketExitPrice: isWin ? 1 : 0,
            marketExitSource: "resolution",
            marketPnl: payout,
        },
    };
}

function makeSummary(trades: readonly Trade[]): BacktestPolymarketTradeSummary {
    const payouts = trades.map((trade) => trade.polymarketOutcome?.marketPnl ?? 0);
    const wins = payouts.filter((value) => value > 0).length;
    const losses = payouts.filter((value) => value < 0).length;
    const grossProfit = payouts.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(payouts.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    return {
        seriesId: "test",
        outcomeRowsLoaded: trades.length,
        scoredTrades: trades.length,
        missingOutcomeTrades: 0,
        unscoredTrades: 0,
        evaluationMode: "resolve_hold",
        profitableTrades: wins,
        losingTrades: losses,
        netPnl: grossProfit - grossLoss,
        grossProfit,
        grossLoss,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
        expectancy: trades.length > 0 ? (grossProfit - grossLoss) / trades.length : 0,
        sizedNetProfit: (grossProfit - grossLoss) * 100,
        sizedNetProfitPercent: grossProfit - grossLoss,
        sizedTrades: trades.length,
    };
}

function makeResult(trades: Trade[]): BacktestResult {
    return {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        polymarketTradeSummary: makeSummary(trades),
    };
}

describe("strategy debugger analysis", () => {
    it("builds Polymarket metrics in AI-friendly units", () => {
        const result = makeResult([
            makeTrade(1, 1000, 0.6, true),
            makeTrade(2, 1300, 0.5, false),
        ]);

        const metrics = buildStrategyDebuggerMetrics({
            strategyKey: "candidate",
            strategyName: "Candidate",
            params: {},
            paramSource: "strategy_default",
            result,
        });

        expect(metrics.scoredTrades).to.equal(2);
        expect(metrics.scoredTradeShare).to.equal(1);
        expect(metrics.winRate).to.equal(0.5);
        expect(metrics.expectancyCents).to.equal(-5);
        expect(metrics.sizedNet).to.equal(-10);
    });

    it("does not report infinite profit factor as zero", () => {
        const result = makeResult([
            makeTrade(1, 1000, 0.6, true),
            makeTrade(2, 1300, 0.5, true),
        ]);

        const metrics = buildStrategyDebuggerMetrics({
            strategyKey: "candidate",
            strategyName: "Candidate",
            params: {},
            paramSource: "strategy_default",
            result,
        });

        expect(metrics.profitFactor).to.equal(null);
    });

    it("separates matched, added, and skipped trade effects", () => {
        const baselineTrades = [
            makeTrade(1, 1000, 0.6, true),
            makeTrade(2, 1300, 0.55, true),
        ];
        const candidateTrades = [
            makeTrade(3, 1000, 0.8, true),
            makeTrade(4, 1600, 0.7, false),
        ];

        const overlap = buildStrategyDebuggerTradeOverlap(baselineTrades, candidateTrades);

        expect(overlap.matchQuality).to.equal("medium");
        expect(overlap.bothTook.count).to.equal(1);
        expect(overlap.bothTook.avgDeltaCents).to.equal(-20);
        expect(overlap.candidateAdded.expectancyCents).to.equal(-70);
        expect(overlap.candidateSkipped.baselineExpectancyCents).to.equal(45);
    });

    it("builds a worse diagnostic when candidate adds bad trades and skips winners", () => {
        const baseline = {
            strategyKey: "polymarket_event_direction_follow",
            strategyName: "Polymarket Event Direction Follow",
            params: {},
            paramSource: "strategy_default" as const,
            result: makeResult([
                makeTrade(1, 1000, 0.6, true),
                makeTrade(2, 1300, 0.55, true),
            ]),
        };
        const candidate = {
            strategyKey: "candidate",
            strategyName: "Candidate",
            params: {},
            paramSource: "strategy_default" as const,
            result: makeResult([
                makeTrade(3, 1000, 0.8, true),
                makeTrade(4, 1600, 0.7, false),
            ]),
        };

        const diagnostic = buildStrategyDebuggerDiagnostic({
            run: {
                symbol: "BTCUSDT",
                interval: "1s",
                executionModel: "signal_close",
                polymarketExitMode: "resolve_hold",
                riskManagement: {
                    chart: {
                        riskMode: "percentage",
                        takeProfitEnabled: true,
                        takeProfitPercent: 2,
                        stopLossEnabled: true,
                        stopLossPercent: 1,
                    },
                    polymarketProtection: {
                        takeProfitEnabled: true,
                        takeProfitCents: 20,
                        stopLossEnabled: true,
                        stopLossCents: 20,
                    },
                },
                generatedAtIso: "2026-05-27T00:00:00.000Z",
                singleRangeOnly: true,
            },
            baseline,
            candidate,
            minScoredTrades: 1,
        });

        expect(diagnostic.diagnosis.verdict).to.equal("worse");
        expect(diagnostic.run.riskManagement?.chart.takeProfitPercent).to.equal(2);
        expect(diagnostic.run.riskManagement?.polymarketProtection.stopLossCents).to.equal(20);
        expect(diagnostic.delta.expectancyCents).to.equal(-67.5);
        expect(diagnostic.tradeOverlap.candidateAdded.expectancyCents).to.equal(-70);
        expect(diagnostic.tradeOverlap.candidateSkipped.baselineExpectancyCents).to.equal(45);
        expect(diagnostic.diagnosis.nextPromptHint).to.contain("candidate-only trades");
    });
});
