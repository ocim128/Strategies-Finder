import { expect } from "chai";
import { describe, it } from "node:test";
import { DEFAULT_BACKTEST_SETTINGS, type StrategyConfig } from "../lib/settings-model";
import {
    determineEnsemblePolymarketVerdict,
    runEnsemblePolymarket,
    type EnsemblePolymarketRunResult,
} from "../lib/strategy-ensemble-polymarket-engine";
import type { StrategyEnsembleEngineDeps } from "../lib/strategy-ensemble-engine";
import type { CapitalSettings } from "../lib/types/backtest";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";
import type {
    BacktestResult,
    OHLCVData,
    Strategy,
    Trade,
} from "../lib/types/strategies";

function createCandle(time: number): OHLCVData {
    return {
        time,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1_000,
    };
}

function createTrade(entryTime: number, type: "long" | "short"): Trade {
    return {
        id: entryTime,
        type,
        entryTime,
        exitTime: entryTime + 300,
        entryPrice: 100,
        exitPrice: type === "long" ? 101 : 99,
        pnl: type === "long" ? 1 : -1,
        pnlPercent: type === "long" ? 0.01 : -0.01,
        size: 1,
        exitReason: "signal",
    };
}

function createOutcome(eventStartTs: number, resolvedOutcomeUp: 0 | 1): PolymarketOutcomeRow {
    return {
        series_id: "10684",
        event_slug: `event-${eventStartTs}`,
        market_slug: `market-${eventStartTs}`,
        interval: "5m",
        event_start_ts: eventStartTs,
        event_end_ts: eventStartTs + 300,
        yes_token_id: "yes",
        no_token_id: "no",
        yes_open_price: 0.5,
        yes_entry_minute_1_price: 0.5,
        yes_entry_minute_2_price: 0.5,
        yes_entry_minute_3_price: 0.5,
        yes_entry_minute_4_price: 0.5,
        resolved_outcome_up: resolvedOutcomeUp,
        resolution_source: "test",
        updated_at: 1,
    };
}

function createConfig(name: string, strategyKey = name): StrategyConfig {
    return {
        name,
        createdAt: "2026-03-28T00:00:00.000Z",
        updatedAt: "2026-03-28T00:00:00.000Z",
        strategyKey,
        strategyParams: {},
        backtestSettings: {
            ...DEFAULT_BACKTEST_SETTINGS,
            executionModel: "next_open",
        },
    };
}

function createStrategy(strategyKey: string): Strategy {
    return {
        name: strategyKey,
        description: `${strategyKey} test strategy`,
        defaultParams: {},
        paramLabels: {},
        execute: () => [],
    };
}

function createBacktestResult(trades: Trade[]): BacktestResult {
    const winningTrades = trades.filter((trade) => trade.pnl >= 0).length;
    const losingTrades = trades.length - winningTrades;

    return {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: trades.length > 0 ? (winningTrades / trades.length) * 100 : 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 1,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades,
        losingTrades,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function createDeps(
    configs: readonly StrategyConfig[],
    tradesByStrategyKey: ReadonlyMap<string, Trade[]>
): StrategyEnsembleEngineDeps {
    const configByName = new Map(configs.map((config) => [config.name, config] as const));
    const strategyByKey = new Map(
        configs.map((config) => [config.strategyKey, createStrategy(config.strategyKey)] as const)
    );
    const capitalSettings: CapitalSettings = {
        initialCapital: 10_000,
        positionSize: 10,
        commission: 0,
        sizingMode: "fixed",
        fixedTradeAmount: 100,
    };

    return {
        interval: "5m",
        loadStrategyConfig: (configName) => configByName.get(configName) ?? null,
        getStrategy: (strategyKey) => strategyByKey.get(strategyKey),
        resolveCapitalFromConfig: () => capitalSettings,
        evaluateStrategyOnData: async (_candles, _interval, strategy) => ({
            result: createBacktestResult(tradesByStrategyKey.get(strategy.name) ?? []),
            engineUsed: "typescript",
        }),
        evaluateSignalsOnData: async () => ({
            result: createBacktestResult([]),
            engineUsed: "typescript",
        }),
        warn: () => {},
    };
}

function buildFixture(input: {
    symbol?: string;
    interval?: string;
    targetName?: string;
    contextNames?: string[];
    configs?: StrategyConfig[];
    tradesByStrategyKey: ReadonlyMap<string, Trade[]>;
    outcomes: readonly PolymarketOutcomeRow[];
    candles?: OHLCVData[];
}): {
    candles: OHLCVData[];
    resultPromise: Promise<EnsemblePolymarketRunResult>;
} {
    const candles = input.candles ?? [
        createCandle(0),
        createCandle(300),
        createCandle(600),
        createCandle(900),
    ];
    const configs = input.configs ?? [
        createConfig("target"),
        createConfig("context"),
    ];

    return {
        candles,
        resultPromise: runEnsemblePolymarket({
            targetName: input.targetName ?? configs[0]!.name,
            contextNames: input.contextNames ?? configs.slice(1).map((config) => config.name),
            candles,
            symbol: input.symbol ?? "BTCUSDT",
            interval: input.interval ?? "5m",
            outcomes: [...input.outcomes],
            deps: createDeps(configs, input.tradesByStrategyKey),
        }),
    };
}

describe("Strategy Ensemble Polymarket engine", () => {
    it("rejects non-5m intervals early", async () => {
        const { resultPromise } = buildFixture({
            interval: "1h",
            tradesByStrategyKey: new Map<string, Trade[]>(),
            outcomes: [],
        });

        await resultPromise.then(
            () => {
                throw new Error("Expected runEnsemblePolymarket to reject.");
            },
            (error: unknown) => {
                expect(error).to.be.instanceOf(Error);
                expect((error as Error).message).to.include("supports BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT on 5m");
            }
        );
    });

    it("scores each selected config against the shared Polymarket outcome set", async () => {
        const configs = [
            createConfig("Target Alpha", "target_alpha"),
            createConfig("Context Beta", "context_beta"),
        ];
        const tradesByStrategyKey = new Map<string, Trade[]>([
            ["target_alpha", [createTrade(300, "long"), createTrade(600, "short"), createTrade(900, "long")]],
            ["context_beta", [createTrade(300, "short"), createTrade(600, "short"), createTrade(900, "long")]],
        ]);
        const outcomes = [
            createOutcome(300, 1),
            createOutcome(600, 0),
            createOutcome(900, 0),
        ];

        const { resultPromise } = buildFixture({
            configs,
            targetName: "Target Alpha",
            contextNames: ["Context Beta"],
            tradesByStrategyKey,
            outcomes,
        });
        const result = await resultPromise;

        expect(result.configResults).to.have.length(2);
        expect(result.configResults[0]?.configName).to.equal("Target Alpha");
        expect(result.configResults[0]?.evalResult.scoredPredictions).to.equal(3);
        expect(result.configResults[0]?.evalResult.wins).to.equal(2);
        expect(result.configResults[0]?.evalResult.losses).to.equal(1);
        expect(result.configResults[0]?.evalResult.coverage).to.equal(1);
        expect(result.configResults[1]?.evalResult.wins).to.equal(1);
        expect(result.ensembleSummary.bestBaseline).to.equal(2 / 3);
    });

    it("computes Wilson lower bounds for each config result", async () => {
        const eventCount = 100;
        const candles = Array.from({ length: eventCount + 1 }, (_, index) => createCandle(index * 300));
        const entries = candles.slice(1).map((candle) => Number(candle.time));
        const trades = entries.map((entryTime, index) => createTrade(entryTime, index < 64 ? "long" : "short"));
        const outcomes = entries.map((entryTime, index) => createOutcome(entryTime, index < 64 ? 1 : 1));
        const configs = [createConfig("Wilson Config", "wilson_config")];
        const tradesByStrategyKey = new Map<string, Trade[]>([["wilson_config", trades]]);

        const { resultPromise } = buildFixture({
            candles,
            configs,
            targetName: "Wilson Config",
            contextNames: [],
            tradesByStrategyKey,
            outcomes,
        });
        const result = await resultPromise;

        expect(result.configResults[0]?.evalResult.wins).to.equal(64);
        expect(result.configResults[0]?.wilsonLowerBound).to.be.closeTo(0.5422, 0.001);
    });

    it("assigns verdict thresholds consistently", () => {
        expect(determineEnsemblePolymarketVerdict(0.60, 0.55, 29)).to.equal("insufficient");
        expect(determineEnsemblePolymarketVerdict(0.551, 0.55, 30)).to.equal("marginal");
        expect(determineEnsemblePolymarketVerdict(0.571, 0.55, 30)).to.equal("edge");
        expect(determineEnsemblePolymarketVerdict(0.54, 0.55, 30)).to.equal("no_edge");
    });

    it("aggregates ensemble summary metrics using weighted scored-trade totals", async () => {
        const configs = [
            createConfig("Target Alpha", "target_alpha"),
            createConfig("Context Beta", "context_beta"),
            createConfig("Context Gamma", "context_gamma"),
        ];
        const tradesByStrategyKey = new Map<string, Trade[]>([
            ["target_alpha", [createTrade(300, "long"), createTrade(600, "short"), createTrade(900, "long")]],
            ["context_beta", [createTrade(300, "short"), createTrade(600, "short"), createTrade(900, "long")]],
            ["context_gamma", [createTrade(300, "long"), createTrade(600, "short"), createTrade(900, "short")]],
        ]);
        const outcomes = [
            createOutcome(300, 1),
            createOutcome(600, 0),
            createOutcome(900, 0),
        ];

        const { resultPromise } = buildFixture({
            configs,
            targetName: "Target Alpha",
            contextNames: ["Context Beta", "Context Gamma"],
            tradesByStrategyKey,
            outcomes,
        });
        const result = await resultPromise;

        expect(result.ensembleSummary.totalScoredTrades).to.equal(9);
        expect(result.ensembleSummary.ensembleWinRate).to.be.closeTo(6 / 9, 1e-12);
        expect(result.ensembleSummary.bestConfigName).to.equal("Context Gamma");
        expect(result.ensembleSummary.bestConfigWinRate).to.be.closeTo(1, 1e-12);
        expect(result.conflictFilteredOverlay.scoredEvents).to.equal(1);
        expect(result.conflictFilteredOverlay.wins).to.equal(1);
        expect(result.conflictFilteredOverlay.losses).to.equal(0);
        expect(result.conflictFilteredOverlay.eventsWithVotes).to.equal(3);
        expect(result.conflictFilteredOverlay.mixedDirectionEvents).to.equal(2);
        expect(result.conflictFilteredOverlay.noSignalEvents).to.equal(0);
        expect(result.conflictFilteredOverlay.skipRate).to.equal(2 / 3);
        expect(result.majorityVoteOverlay.scoredEvents).to.equal(3);
        expect(result.majorityVoteOverlay.wins).to.equal(2);
        expect(result.majorityVoteOverlay.losses).to.equal(1);
        expect(result.majorityVoteOverlay.conflictedEvents).to.equal(0);
    });

    it("reports a conflict-filtered overlay that skips mixed long-vs-short events", async () => {
        const configs = [
            createConfig("Short X", "short_x"),
            createConfig("Long Y", "long_y"),
        ];
        const tradesByStrategyKey = new Map<string, Trade[]>([
            ["short_x", [createTrade(300, "short"), createTrade(600, "short")]],
            ["long_y", [createTrade(300, "long"), createTrade(900, "long")]],
        ]);
        const outcomes = [
            createOutcome(300, 0),
            createOutcome(600, 0),
            createOutcome(900, 1),
            createOutcome(1200, 1),
        ];
        const candles = [
            createCandle(0),
            createCandle(300),
            createCandle(600),
            createCandle(900),
            createCandle(1200),
        ];

        const { resultPromise } = buildFixture({
            configs,
            targetName: "Short X",
            contextNames: ["Long Y"],
            tradesByStrategyKey,
            outcomes,
            candles,
        });
        const result = await resultPromise;

        expect(result.conflictFilteredOverlay.scoredEvents).to.equal(2);
        expect(result.conflictFilteredOverlay.wins).to.equal(2);
        expect(result.conflictFilteredOverlay.losses).to.equal(0);
        expect(result.conflictFilteredOverlay.eventsWithVotes).to.equal(3);
        expect(result.conflictFilteredOverlay.mixedDirectionEvents).to.equal(1);
        expect(result.conflictFilteredOverlay.noSignalEvents).to.equal(1);
        expect(result.conflictFilteredOverlay.noSignalRate).to.equal(1 / 4);
        expect(result.conflictFilteredOverlay.skippedEvents).to.equal(2);
        expect(result.conflictFilteredOverlay.coverage).to.equal(2 / 4);
        expect(result.majorityVoteOverlay.scoredEvents).to.equal(2);
        expect(result.majorityVoteOverlay.conflictedEvents).to.equal(1);
        expect(result.majorityVoteOverlay.noSignalEvents).to.equal(1);
    });
});
