import { expect } from "chai";
import { describe, it } from "node:test";
import { DEFAULT_BACKTEST_SETTINGS, type StrategyConfig } from "../lib/settings-model";
import {
    collectEnsemblePolymarketOverlayVotes,
    determineEnsemblePolymarketVerdict,
    determineEnsemblePolymarketVetoVerdict,
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
    tradesByStrategyKey: ReadonlyMap<string, Trade[]>,
    capturedSignalExecutionModels?: string[]
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
        evaluateSignalsOnData: async (_candles, _interval, signals, settings) => {
            if (capturedSignalExecutionModels) {
                capturedSignalExecutionModels.push(settings.executionModel);
            }

            return {
                result: createBacktestResult(
                    signals
                        .filter((signal) => signal.type === "buy" || signal.type === "sell")
                        .map((signal) => createTrade(Number(signal.time), signal.type === "buy" ? "long" : "short"))
                ),
                engineUsed: "typescript",
            };
        },
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
    conflictPolicy?: Parameters<typeof runEnsemblePolymarket>[0]["conflictPolicy"];
    directionSlice?: Parameters<typeof runEnsemblePolymarket>[0]["directionSlice"];
    capturedSignalExecutionModels?: string[];
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
            deps: createDeps(configs, input.tradesByStrategyKey, input.capturedSignalExecutionModels),
            conflictPolicy: input.conflictPolicy,
            directionSlice: input.directionSlice,
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
        expect(result.configResults[0]?.evalResult.expectancy).to.be.closeTo(1 / 6, 1e-12);
        expect(result.configResults[1]?.evalResult.wins).to.equal(1);
        expect(result.ensembleSummary.bestBaseline).to.equal(2 / 3);
    });

    it("collects exact scored conflict-filter overlay votes from config results", async () => {
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

        expect(
            collectEnsemblePolymarketOverlayVotes(result.configResults, "conflict_filtered")
        ).to.deep.equal([
            {
                eventStartTs: 600,
                prediction: "no",
                actualOutcomeUp: 0,
                yesVotes: 0,
                noVotes: 2,
            },
            {
                eventStartTs: 900,
                prediction: "yes",
                actualOutcomeUp: 0,
                yesVotes: 2,
                noVotes: 0,
            },
        ]);
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
        expect(determineEnsemblePolymarketVetoVerdict(0.03, 0.05, 30)).to.equal("interesting");
        expect(determineEnsemblePolymarketVetoVerdict(0.005, 0.01, 30)).to.equal("marginal");
        expect(determineEnsemblePolymarketVetoVerdict(-0.01, -0.02, 30)).to.equal("neutral");
        expect(determineEnsemblePolymarketVetoVerdict(0.10, 0.20, 29)).to.equal("insufficient");
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

    it("ranks asymmetric veto pairs by post-veto lift versus the primary config", async () => {
        const eventCount = 60;
        const candles = Array.from({ length: eventCount + 1 }, (_, index) => createCandle(index * 300));
        const entries = candles.slice(1).map((candle) => Number(candle.time));
        const configs = [
            createConfig("Primary Long", "primary_long"),
            createConfig("Short Veto", "short_veto"),
        ];
        const tradesByStrategyKey = new Map<string, Trade[]>([
            ["primary_long", entries.map((entryTime) => createTrade(entryTime, "long"))],
            ["short_veto", entries.slice(0, 30).map((entryTime) => createTrade(entryTime, "short"))],
        ]);
        const outcomes = entries.map((entryTime, index) => createOutcome(entryTime, index < 30 ? 0 : 1));

        const { resultPromise } = buildFixture({
            candles,
            configs,
            targetName: "Primary Long",
            contextNames: ["Short Veto"],
            tradesByStrategyKey,
            outcomes,
        });
        const result = await resultPromise;

        expect(result.vetoScan.pairResults).to.have.length(1);
        expect(result.vetoScan.positivePairCount).to.equal(1);
        expect(result.vetoScan.bestPair?.primaryConfigName).to.equal("Primary Long");
        expect(result.vetoScan.bestPair?.vetoConfigName).to.equal("Short Veto");
        expect(result.vetoScan.bestPair?.keptEvents).to.equal(30);
        expect(result.vetoScan.bestPair?.pricedTrades).to.equal(30);
        expect(result.vetoScan.bestPair?.vetoedEvents).to.equal(30);
        expect(result.vetoScan.bestPair?.retentionRate).to.equal(0.5);
        expect(result.vetoScan.bestPair?.postVetoWinRate).to.equal(1);
        expect(result.vetoScan.bestPair?.expectancy).to.equal(0.5);
        expect(result.vetoScan.bestPair?.winRateLift).to.equal(0.5);
        expect(result.vetoScan.bestPair?.verdict).to.equal("interesting");
    });

    it("supports long-only directional slicing for selected policies", async () => {
        const configs = [
            createConfig("Long Bias", "long_bias"),
            createConfig("Mixed Context", "mixed_context"),
        ];
        const tradesByStrategyKey = new Map<string, Trade[]>([
            ["long_bias", [createTrade(300, "long"), createTrade(600, "short"), createTrade(900, "long")]],
            ["mixed_context", [createTrade(300, "short"), createTrade(600, "short"), createTrade(900, "long")]],
        ]);
        const outcomes = [
            createOutcome(300, 1),
            createOutcome(600, 0),
            createOutcome(900, 1),
        ];

        const { resultPromise } = buildFixture({
            configs,
            targetName: "Long Bias",
            contextNames: ["Mixed Context"],
            tradesByStrategyKey,
            outcomes,
            directionSlice: "long_only",
            conflictPolicy: "skip_conflicts",
        });
        const result = await resultPromise;

        expect(result.directionSlice).to.equal("long_only");
        expect(result.ensembleSummary.bestBaseline).to.equal(result.ensembleSummary.alwaysYesBaseline);
        expect(result.configResults[0]?.evalResult.shortPredictions).to.equal(0);
        expect(result.selectedPolicyResult?.policy).to.equal("skip_conflicts");
    });

    it("ranks executable secondary-override pairs and exposes the selected policy result", async () => {
        const eventCount = 60;
        const candles = Array.from({ length: eventCount + 1 }, (_, index) => createCandle(index * 300));
        const entries = candles.slice(1).map((candle) => Number(candle.time));
        const configs = [
            createConfig("Primary Long", "primary_long"),
            createConfig("Short Override", "short_override"),
        ];
        const tradesByStrategyKey = new Map<string, Trade[]>([
            ["primary_long", entries.map((entryTime) => createTrade(entryTime, "long"))],
            ["short_override", entries.slice(0, 30).map((entryTime) => createTrade(entryTime, "short"))],
        ]);
        const outcomes = entries.map((entryTime, index) => createOutcome(entryTime, index < 30 ? 0 : 1));

        const { resultPromise } = buildFixture({
            candles,
            configs,
            targetName: "Primary Long",
            contextNames: ["Short Override"],
            tradesByStrategyKey,
            outcomes,
            conflictPolicy: "secondary_override",
        });
        const result = await resultPromise;

        expect(result.overrideScan.bestPair?.primaryConfigName).to.equal("Primary Long");
        expect(result.overrideScan.bestPair?.secondaryConfigName).to.equal("Short Override");
        expect(result.overrideScan.bestPair?.overriddenEvents).to.equal(30);
        expect(result.selectedPolicyResult?.policy).to.equal("secondary_override");
        expect(result.selectedPolicyResult?.expectancy).to.equal(0.5);
        expect(result.selectedPolicyResult?.winRate).to.equal(1);
        expect(result.selectedPolicyResult?.retentionRate).to.equal(1);
    });

    it("replays ensemble polymarket policies on next-open execution", async () => {
        const capturedSignalExecutionModels: string[] = [];
        const configs = [
            createConfig("Primary Long", "primary_long"),
            createConfig("Short Override", "short_override"),
        ];
        const tradesByStrategyKey = new Map<string, Trade[]>([
            ["primary_long", [createTrade(300, "long"), createTrade(600, "long")]],
            ["short_override", [createTrade(300, "short")]],
        ]);
        const outcomes = [
            createOutcome(300, 0),
            createOutcome(600, 1),
        ];
        const candles = [
            createCandle(0),
            createCandle(300),
            createCandle(600),
        ];

        const { resultPromise } = buildFixture({
            candles,
            configs,
            targetName: "Primary Long",
            contextNames: ["Short Override"],
            tradesByStrategyKey,
            outcomes,
            conflictPolicy: "secondary_override",
            capturedSignalExecutionModels,
        });
        await resultPromise;

        expect(capturedSignalExecutionModels.length).to.be.greaterThan(0);
        expect(new Set(capturedSignalExecutionModels)).to.deep.equal(new Set(["next_open"]));
    });

    it("builds a best-side-owner policy from the strongest long and short specialists", async () => {
        const configs = [
            createConfig("Long Specialist", "long_specialist"),
            createConfig("Short Specialist", "short_specialist"),
            createConfig("Weak Mixed", "weak_mixed"),
        ];
        const tradesByStrategyKey = new Map<string, Trade[]>([
            ["long_specialist", [createTrade(300, "long"), createTrade(900, "long")]],
            ["short_specialist", [createTrade(600, "short"), createTrade(1200, "short")]],
            ["weak_mixed", [createTrade(300, "long"), createTrade(600, "short"), createTrade(900, "short"), createTrade(1200, "long")]],
        ]);
        const outcomes = [
            createOutcome(300, 1),
            createOutcome(600, 0),
            createOutcome(900, 1),
            createOutcome(1200, 0),
        ];
        const candles = [
            createCandle(0),
            createCandle(300),
            createCandle(600),
            createCandle(900),
            createCandle(1200),
        ];

        const { resultPromise } = buildFixture({
            candles,
            configs,
            targetName: "Weak Mixed",
            contextNames: ["Long Specialist", "Short Specialist"],
            tradesByStrategyKey,
            outcomes,
            conflictPolicy: "best_side_owner",
        });
        const result = await resultPromise;

        expect(result.policyResults.bestSideOwner?.longOwnerConfigName).to.equal("Long Specialist");
        expect(result.policyResults.bestSideOwner?.shortOwnerConfigName).to.equal("Short Specialist");
        expect(result.selectedPolicyResult?.policy).to.equal("best_side_owner");
        expect(result.selectedPolicyResult?.winRate).to.equal(1);
    });
});
