import { expect } from "chai";
import { describe, it } from "node:test";
import { DEFAULT_BACKTEST_SETTINGS, type StrategyConfig } from "../lib/settings-model";
import {
    selectEnsembleRuleSelection,
    type EnsembleRuleEvaluation,
} from "../lib/strategy-ensemble-rule-selection";
import type { ConfigRunArtifact, EnsembleEntryPresence } from "../lib/strategy-ensemble-types";
import type { BacktestResult, OHLCVData, Signal, Strategy, Trade } from "../lib/strategies";
import { buildEnsembleRows, type StrategyEnsembleRulesRuntime } from "../lib/strategy-ensemble-rules";

function createSignal(time: number, type: Signal["type"], barIndex: number): Signal {
    return {
        time,
        type,
        price: 100,
        barIndex,
    };
}

function createTrade(entryTime: number, type: Trade["type"], pnl: number, pnlPercent: number): Trade {
    return {
        entryTime,
        exitTime: entryTime + 1,
        entryPrice: 100,
        exitPrice: 100 + pnl,
        type,
        pnl,
        pnlPercent,
        barsHeld: 1,
        entryReason: "test",
        exitReason: "test",
        runUp: pnl,
        drawdown: Math.min(0, pnl),
        runUpPercent: pnlPercent,
        drawdownPercent: Math.min(0, pnlPercent),
        maePercent: Math.min(0, pnlPercent),
        mfePercent: Math.max(0, pnlPercent),
    };
}

function createBacktestResult(trades: Trade[], expectancy: number, netProfitPercent: number): BacktestResult {
    const winningTrades = trades.filter((trade) => trade.pnl >= 0).length;
    const losingTrades = trades.length - winningTrades;

    return {
        trades,
        netProfit: trades.reduce((sum, trade) => sum + trade.pnl, 0),
        netProfitPercent,
        winRate: trades.length > 0 ? (winningTrades / trades.length) * 100 : 0,
        expectancy,
        avgTrade: trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length : 0,
        profitFactor: losingTrades > 0 ? 1.5 : winningTrades > 0 ? Infinity : 0,
        maxDrawdown: -10,
        maxDrawdownPercent: -2,
        totalTrades: trades.length,
        winningTrades,
        losingTrades,
        avgWin: 1,
        avgLoss: -1,
        sharpeRatio: 1,
        equityCurve: [],
    };
}

function createConfig(name: string, strategyKey: string): StrategyConfig {
    return {
        name,
        createdAt: "2026-03-28T00:00:00.000Z",
        updatedAt: "2026-03-28T00:00:00.000Z",
        strategyKey,
        strategyParams: {},
        backtestSettings: {
            ...DEFAULT_BACKTEST_SETTINGS,
            executionModel: "next_open",
            tradeDirection: "long",
        },
    };
}

function createStrategy(name: string): Strategy {
    return {
        name,
        description: `${name} strategy`,
        defaultParams: {},
        paramLabels: {},
        execute: () => [],
    };
}

function createPresenceLookup(entries: Array<{ time: number; longEntry?: boolean; shortEntry?: boolean }>): Map<string, EnsembleEntryPresence> {
    return new Map(
        entries.map((entry) => [
            String(entry.time),
            {
                longEntry: entry.longEntry === true,
                shortEntry: entry.shortEntry === true,
            },
        ])
    );
}

function createArtifact(args: {
    name: string;
    strategyKey: string;
    preparedSignals: Signal[];
    result: BacktestResult;
    entryPresenceByTime?: Map<string, EnsembleEntryPresence>;
}): ConfigRunArtifact {
    const config = createConfig(args.name, args.strategyKey);

    return {
        config,
        strategy: createStrategy(args.strategyKey),
        familyKey: args.strategyKey,
        familyLabel: args.strategyKey,
        tradeDirection: "long",
        rawSignals: args.preparedSignals,
        preparedSignals: args.preparedSignals,
        entrySignals: args.preparedSignals.filter((signal) => signal.type === "buy"),
        entryPresenceByTime: args.entryPresenceByTime ?? new Map<string, EnsembleEntryPresence>(),
        backtestSettings: config.backtestSettings,
        result: args.result,
        engineUsed: "typescript",
    };
}

function signalSignature(signals: readonly Signal[]): string {
    return signals.map((signal) => `${signal.type}@${signal.time}`).join("|");
}

function createEvaluation(overrides: Partial<EnsembleRuleEvaluation>): EnsembleRuleEvaluation {
    return {
        rule: {
            id: "rule",
            label: "Rule",
        },
        trainSamples: 100,
        trainExpectancy: 5,
        validationSamples: 80,
        validationExpectancy: 4,
        fullTrades: 180,
        fullExpectancy: 4.5,
        validated: false,
        ...overrides,
    };
}

describe("Strategy Ensemble selection", () => {
    it("prefers a genuinely validated rule over a stronger in-sample but invalid candidate", () => {
        const unsafeExtreme = createEvaluation({
            rule: { id: "min18", label: "minFamilyAgree >= 18" },
            trainExpectancy: 25,
            validationExpectancy: -5000,
            fullExpectancy: -4000,
            fullTrades: 25,
            validated: false,
        });
        const safeValidated = createEvaluation({
            rule: { id: "oppose3", label: "maxFamilyOppose <= 3" },
            trainExpectancy: 8,
            validationExpectancy: 6,
            fullExpectancy: 7,
            validated: true,
        });

        const selected = selectEnsembleRuleSelection([unsafeExtreme, safeValidated], 5);

        expect(selected).to.not.equal(null);
        expect(selected?.mode).to.equal("validated");
        expect(selected?.evaluation.rule.id).to.equal("oppose3");
    });

    it("falls back to train-only candidates only when the full backtest remains positive", () => {
        const catastrophic = createEvaluation({
            rule: { id: "min17", label: "minFamilyAgree >= 17" },
            trainExpectancy: 19,
            validationExpectancy: -20,
            fullExpectancy: -300,
            fullTrades: 32,
            validated: false,
        });
        const cautiousPositive = createEvaluation({
            rule: { id: "oppose6", label: "maxFamilyOppose <= 6" },
            trainExpectancy: 6,
            validationExpectancy: 2,
            fullExpectancy: 5.5,
            fullTrades: 220,
            validated: false,
        });

        const selected = selectEnsembleRuleSelection([catastrophic, cautiousPositive], 5);

        expect(selected).to.not.equal(null);
        expect(selected?.mode).to.equal("train_only");
        expect(selected?.evaluation.rule.id).to.equal("oppose6");
    });

    it("returns no recommendation when only catastrophic train-only candidates remain", () => {
        const catastrophicA = createEvaluation({
            rule: { id: "min17", label: "minFamilyAgree >= 17" },
            trainExpectancy: 30,
            validationExpectancy: -100,
            fullExpectancy: -500,
            fullTrades: 30,
            validated: false,
        });
        const catastrophicB = createEvaluation({
            rule: { id: "min18", label: "minFamilyAgree >= 18" },
            trainExpectancy: 35,
            validationExpectancy: -200,
            fullExpectancy: -800,
            fullTrades: 25,
            validated: false,
        });

        const selected = selectEnsembleRuleSelection([catastrophicA, catastrophicB], 5);

        expect(selected).to.equal(null);
    });

    it("adds explicit conflict-skip and best-primary-veto simulations to the builder rows", async () => {
        const candles: OHLCVData[] = [
            { time: 100, open: 100, high: 101, low: 99, close: 100, volume: 1 },
            { time: 200, open: 100, high: 101, low: 99, close: 100, volume: 1 },
            { time: 300, open: 100, high: 101, low: 99, close: 100, volume: 1 },
            { time: 400, open: 100, high: 101, low: 99, close: 100, volume: 1 },
        ];
        const baselineSignals = [
            createSignal(100, "buy", 0),
            createSignal(200, "sell", 1),
            createSignal(300, "buy", 2),
            createSignal(400, "sell", 3),
        ];
        const baselineResult = createBacktestResult([
            createTrade(100, "long", 1, 1),
            createTrade(300, "long", -1, -1),
        ], 1, 2);
        const targetArtifact = createArtifact({
            name: "Target",
            strategyKey: "target_strategy",
            preparedSignals: baselineSignals,
            result: baselineResult,
        });
        const shortVetoArtifact = createArtifact({
            name: "Short Veto",
            strategyKey: "short_veto_strategy",
            preparedSignals: [],
            result: baselineResult,
            entryPresenceByTime: createPresenceLookup([
                { time: 100, shortEntry: true },
            ]),
        });
        const lateVetoArtifact = createArtifact({
            name: "Late Veto",
            strategyKey: "late_veto_strategy",
            preparedSignals: [],
            result: baselineResult,
            entryPresenceByTime: createPresenceLookup([
                { time: 300, shortEntry: true },
            ]),
        });

        const resultsBySignature = new Map<string, BacktestResult>([
            [signalSignature(baselineSignals), baselineResult],
            [signalSignature([createSignal(200, "sell", 1), createSignal(300, "buy", 2), createSignal(400, "sell", 3)]), createBacktestResult([createTrade(300, "long", 2, 2)], 2, 3)],
            [signalSignature([createSignal(100, "buy", 0), createSignal(200, "sell", 1), createSignal(400, "sell", 3)]), createBacktestResult([createTrade(100, "long", 4, 4)], 4, 5)],
            [signalSignature([createSignal(200, "sell", 1), createSignal(400, "sell", 3)]), createBacktestResult([], 5, 6)],
        ]);
        const runtime: StrategyEnsembleRulesRuntime = {
            runFilteredBacktest: async (_targetArtifact, signals) => ({
                result: resultsBySignature.get(signalSignature(signals)) ?? createBacktestResult([], 0, 0),
                engineUsed: "typescript",
            }),
            yieldToUi: async () => {},
        };

        const builder = await buildEnsembleRows(
            targetArtifact,
            [shortVetoArtifact, lateVetoArtifact],
            candles,
            2,
            [],
            null,
            runtime
        );

        const rowLabels = builder.rows.map((row) => row.rule);
        expect(rowLabels).to.include("Baseline (target only)");
        expect(rowLabels).to.include("Conflict Filter (skip opposed/conflicted)");
        expect(rowLabels).to.include("Best Primary Veto (Late Veto)");
        expect(builder.previewByRuleId.get("scenario:conflict_filter")?.row.rule).to.equal("Conflict Filter (skip opposed/conflicted)");
        expect(builder.previewByRuleId.get("scenario:best_primary_veto")?.row.rule).to.equal("Best Primary Veto (Late Veto)");
    });
});
