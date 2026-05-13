import { expect } from "chai";
import { describe, it } from "node:test";
import { strategyRegistry, type Strategy } from "../strategyRegistry";
import {
    DEFAULT_HUNT_RUN_SETTINGS,
    type HuntProfile,
    type HuntProfileRunResult,
} from "../lib/hunt/hunt-model";
import {
    buildHuntFinderOptions,
    formatHuntMetricValue,
    groupHuntSurvivors,
    sortHuntProfileResults,
    tagProfileResults,
} from "../lib/hunt/hunt-results";
import type { FinderResult } from "../lib/types/finder";
import type { BacktestResult } from "../lib/types/strategies";

function makeBacktestResult(expectancy: number, profitFactor: number, totalTrades: number, maxDrawdownPercent: number): BacktestResult {
    return {
        trades: [],
        netProfit: expectancy * totalTrades,
        netProfitPercent: expectancy * 10,
        winRate: 50,
        expectancy,
        avgTrade: expectancy,
        profitFactor,
        maxDrawdown: maxDrawdownPercent,
        maxDrawdownPercent,
        totalTrades,
        winningTrades: Math.round(totalTrades / 2),
        losingTrades: Math.floor(totalTrades / 2),
        avgWin: expectancy * 2,
        avgLoss: expectancy,
        sharpeRatio: 1.2,
        equityCurve: [],
    };
}

function makeFinderResult(input: {
    key: string;
    name: string;
    params: Record<string, number>;
    expectancy: number;
    totalTrades: number;
    localProfitFactor?: number;
    maxDrawdownPercent?: number;
}): FinderResult {
    const selectionResult = makeBacktestResult(
        input.expectancy,
        input.localProfitFactor ?? 1.6,
        input.totalTrades,
        input.maxDrawdownPercent ?? 8
    );

    return {
        key: input.key,
        name: input.name,
        params: input.params,
        result: selectionResult,
        selectionResult,
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
    };
}

function makeProfile(id: string, name: string): HuntProfile {
    return {
        id,
        name,
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        source: "current_ui",
        symbol: "ETHUSDT",
        interval: "5m",
        blockRange: null,
        backtestSettings: {
            initialCapital: 1_000,
            positionSize: 10,
            commission: 0.1,
            fixedTradeToggle: false,
        },
        capitalSettings: {
            initialCapital: 1_000,
            positionSize: 10,
            commission: 0.1,
            sizingMode: "percent",
        },
    };
}

describe("Hunt results", () => {
    it("groups survivors by normalized params across profiles", () => {
        strategyRegistry.clear();

        const strategy: Strategy = {
            name: "Normalized Survivor",
            description: "Test-only Hunt strategy",
            defaultParams: { lookback: 10, threshold: 1.23 },
            paramLabels: { lookback: "Lookback", threshold: "Threshold" },
            normalizeParams: (params) => ({
                lookback: Math.round(Number(params.lookback)),
                threshold: Number(Number(params.threshold).toFixed(2)),
            }),
            execute: () => [],
        };

        strategyRegistry.register("hunt_test", strategy);

        const finderOptions = buildHuntFinderOptions({
            ...DEFAULT_HUNT_RUN_SETTINGS,
            selectedStrategyKeys: ["hunt_test"],
        });
        const profileA = makeProfile("profile-a", "Alpha");
        const profileB = makeProfile("profile-b", "Beta");

        const tagged = [
            ...tagProfileResults(profileA, [
                makeFinderResult({
                    key: "hunt_test",
                    name: "Normalized Survivor",
                    params: { lookback: 9.6, threshold: 1.2344 },
                    expectancy: 1.4,
                    totalTrades: 42,
                }),
            ], finderOptions, 5),
            ...tagProfileResults(profileB, [
                makeFinderResult({
                    key: "hunt_test",
                    name: "Normalized Survivor",
                    params: { lookback: 10.4, threshold: 1.23449 },
                    expectancy: 1.2,
                    totalTrades: 38,
                }),
            ], finderOptions, 5),
        ];

        const survivors = groupHuntSurvivors(tagged, "expectancy");

        expect(survivors).to.have.length(1);
        expect(survivors[0]!.appearances).to.equal(2);
        expect(survivors[0]!.params).to.deep.equal({ lookback: 10, threshold: 1.23 });
        expect(survivors[0]!.bestCandidate.profileId).to.equal("profile-a");
        expect(survivors[0]!.profileNames).to.deep.equal(["Alpha", "Beta"]);

        strategyRegistry.clear();
    });

    it("sorts tagged results by profile name then local rank", () => {
        const results: HuntProfileRunResult[] = [
            {
                profileId: "b",
                profileName: "Beta",
                symbol: "ETHUSDT",
                interval: "5m",
                blockRange: null,
                localRank: 2,
                result: makeFinderResult({
                    key: "two",
                    name: "Two",
                    params: { p: 2 },
                    expectancy: 0.9,
                    totalTrades: 30,
                }),
            },
            {
                profileId: "a",
                profileName: "Alpha",
                symbol: "ETHUSDT",
                interval: "5m",
                blockRange: null,
                localRank: 1,
                result: makeFinderResult({
                    key: "one",
                    name: "One",
                    params: { p: 1 },
                    expectancy: 1.1,
                    totalTrades: 32,
                }),
            },
        ];

        expect(sortHuntProfileResults(results).map((entry) => `${entry.profileName}:${entry.localRank}`)).to.deep.equal([
            "Alpha:1",
            "Beta:2",
        ]);
    });

    it("formats polymarket metrics in the same units used by Finder and Quick View", () => {
        expect(formatHuntMetricValue("polyExpectancy", 0.097)).to.equal("+9.7c");
        expect(formatHuntMetricValue("polyWinRate", 0.878)).to.equal("87.8%");
        expect(formatHuntMetricValue("polyCoverage", 0.257)).to.equal("25.7%");
        expect(formatHuntMetricValue("polyScore", 0.734)).to.equal("73.4%");
    });

    it("normalizes unsupported Hunt signal-exit rank modes before delegating to Finder", () => {
        const finderOptions = buildHuntFinderOptions({
            ...DEFAULT_HUNT_RUN_SETTINGS,
            polymarketScoringEnabled: true,
            polymarketExitMode: "signal_exit_same_event",
            polymarketSignalExitAllowMultipleTradesPerEvent: true,
            polymarketRankMode: "balanced",
            selectedStrategyKeys: ["hunt_test"],
        });

        expect(finderOptions.polymarketExitMode).to.equal("signal_exit_same_event");
        expect(finderOptions.polymarketSignalExitAllowMultipleTradesPerEvent).to.equal(true);
        expect(finderOptions.polymarketRankMode).to.equal("expectancy");
    });
});
