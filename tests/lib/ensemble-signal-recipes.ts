import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import { resolveCapitalSettingsFromRaw } from "./backtest-capital-settings";
import type { EntrySignalCapitalSettings, EntrySignalEvaluationResult } from "./signal-entry-evaluator";
import { evaluateLatestEntrySignalFromPreparedSignals } from "./signal-entry-evaluator";
import type {
    EnsembleSignalRecipe,
    StrategyConfig,
} from "./settings-model";
import {
    applySignalPolarity,
    runBacktest,
    timeKey,
    type BacktestSettings,
    type OHLCVData,
    type Signal,
    type Strategy,
    type TradeDirection,
} from "./strategies";
import {
    normalizeTradeDirection,
} from "./strategy-ensemble-engine";
import { resolveContextVote } from "./strategy-ensemble-rules";
import type { EnsembleEntryPresence } from "./strategy-ensemble-types";

export interface EnsembleRecipeSignalArtifact {
    config: StrategyConfig;
    strategy: Strategy;
    familyLabel: string;
    tradeDirection: TradeDirection;
    preparedSignals: Signal[];
    entryPresenceByTime: Map<string, EnsembleEntryPresence>;
    backtestSettings: BacktestSettings;
}

export function buildEnsembleRecipeSignalArtifact(
    config: StrategyConfig,
    strategy: Strategy,
    candles: OHLCVData[]
): EnsembleRecipeSignalArtifact {
    const backtestSettings = resolveBacktestSettingsFromRaw(
        config.backtestSettings as unknown as BacktestSettings,
        { captureSnapshots: false, coerceWithoutUiToggles: true }
    );
    const tradeDirection = normalizeTradeDirection(backtestSettings);
    const rawSignals = applySignalPolarity(
        strategy.execute(candles, config.strategyParams ?? strategy.defaultParams),
        backtestSettings
    );
    const capitalSettings = resolveCapitalSettingsFromRaw(config.backtestSettings as unknown as Record<string, unknown>);
    const result = runBacktest(
        candles,
        rawSignals,
        capitalSettings.initialCapital,
        capitalSettings.positionSize,
        capitalSettings.commission,
        backtestSettings,
        {
            mode: capitalSettings.sizingMode,
            fixedTradeAmount: capitalSettings.fixedTradeAmount,
        }
    );
    const entrySignals = buildExecutedEntrySignals(result.trades, candles);

    return {
        config,
        strategy,
        familyLabel: strategy.name,
        tradeDirection,
        preparedSignals: entrySignals,
        entryPresenceByTime: buildEntryPresenceLookup(entrySignals),
        backtestSettings,
    };
}

export function buildPreparedSignalsForEnsembleRecipe(args: {
    recipe: EnsembleSignalRecipe;
    candles: OHLCVData[];
    getStrategy: (strategyKey: string) => Strategy | undefined;
}): { preparedSignals: Signal[]; anchorConfig: StrategyConfig; anchorBacktestSettings: BacktestSettings; description: string } {
    const { recipe, candles, getStrategy } = args;
    const artifactByName = new Map<string, EnsembleRecipeSignalArtifact>();

    for (const config of recipe.componentConfigs) {
        const strategy = getStrategy(config.strategyKey);
        if (!strategy) {
            throw new Error(`Recipe component strategy "${config.strategyKey}" is not available.`);
        }
        artifactByName.set(config.name, buildEnsembleRecipeSignalArtifact(config, strategy, candles));
    }

    const anchorArtifact = artifactByName.get(recipe.anchorConfigName);
    if (!anchorArtifact) {
        throw new Error(`Recipe anchor config "${recipe.anchorConfigName}" is missing.`);
    }

    if (recipe.mode === "primary_veto") {
        const vetoName = recipe.vetoConfigName?.trim();
        if (!vetoName) {
            throw new Error("Primary-veto recipe is missing the veto config name.");
        }

        const vetoArtifact = artifactByName.get(vetoName);
        if (!vetoArtifact) {
            throw new Error(`Recipe veto config "${vetoName}" is missing.`);
        }

        return {
            preparedSignals: buildPrimaryVetoPreparedSignals(anchorArtifact, vetoArtifact),
            anchorConfig: buildRecipeReplayConfig(
                anchorArtifact.config,
                buildPrimaryVetoPreparedSignals(anchorArtifact, vetoArtifact)
            ),
            anchorBacktestSettings: buildRecipeReplayBacktestSettings(
                anchorArtifact.backtestSettings,
                buildPrimaryVetoPreparedSignals(anchorArtifact, vetoArtifact)
            ),
            description: `${anchorArtifact.config.name} vetoed by ${vetoArtifact.config.name}`,
        };
    }

    const contextArtifacts = Array.from(artifactByName.values())
        .filter((artifact) => artifact.config.name !== anchorArtifact.config.name);
    const overlaySignals = buildTargetConflictFilterPreparedSignals(anchorArtifact, contextArtifacts);

    return {
        preparedSignals: overlaySignals,
        anchorConfig: buildRecipeReplayConfig(anchorArtifact.config, overlaySignals),
        anchorBacktestSettings: buildRecipeReplayBacktestSettings(anchorArtifact.backtestSettings, overlaySignals),
        description: `aligned one-side conflict-filter overlay across ${artifactByName.size} config${artifactByName.size === 1 ? "" : "s"}`,
    };
}

export function evaluateEnsembleRecipeLatestEntry(args: {
    recipe: EnsembleSignalRecipe;
    candles: OHLCVData[];
    getStrategy: (strategyKey: string) => Strategy | undefined;
    freshnessBars?: number;
    capitalSettings?: EntrySignalCapitalSettings;
}): EntrySignalEvaluationResult {
    const resolved = buildPreparedSignalsForEnsembleRecipe({
        recipe: args.recipe,
        candles: args.candles,
        getStrategy: args.getStrategy,
    });

    return evaluateLatestEntrySignalFromPreparedSignals({
        strategyKey: `ensemble_recipe:${args.recipe.mode}`,
        strategyName: args.recipe.name,
        candles: args.candles,
        preparedSignals: resolved.preparedSignals,
        backtestSettings: resolved.anchorConfig.backtestSettings as unknown as BacktestSettings,
        capitalSettings: args.capitalSettings,
        freshnessBars: args.freshnessBars,
    });
}

export function buildTargetConflictFilterPreparedSignals(
    targetArtifact: EnsembleRecipeSignalArtifact,
    contextArtifacts: readonly EnsembleRecipeSignalArtifact[]
): Signal[] {
    const signalBuckets = new Map<string, { buySignals: Signal[]; sellSignals: Signal[] }>();
    const artifacts = [targetArtifact, ...contextArtifacts];

    for (const artifact of artifacts) {
        for (const signal of artifact.preparedSignals) {
            if (!isEntrySignal(signal, artifact.tradeDirection)) {
                continue;
            }
            const bucket = signalBuckets.get(timeKey(signal.time)) ?? { buySignals: [], sellSignals: [] };
            if (signal.type === "buy") {
                bucket.buySignals.push(signal);
            } else {
                bucket.sellSignals.push(signal);
            }
            signalBuckets.set(timeKey(signal.time), bucket);
        }
    }

    const overlaySignals: Signal[] = [];
    for (const bucket of signalBuckets.values()) {
        if (bucket.buySignals.length > 0 && bucket.sellSignals.length > 0) {
            continue;
        }
        const sameSideSignals = bucket.buySignals.length > 0 ? bucket.buySignals : bucket.sellSignals;
        if (sameSideSignals.length === 0) {
            continue;
        }
        overlaySignals.push(buildOverlaySignal(sameSideSignals));
    }

    return overlaySignals.sort(compareSignalsByBarIndexThenTime);
}

export function buildPrimaryVetoPreparedSignals(
    primaryArtifact: EnsembleRecipeSignalArtifact,
    vetoArtifact: EnsembleRecipeSignalArtifact
): Signal[] {
    return primaryArtifact.preparedSignals.filter((signal) => {
        if (!isEntrySignal(signal, primaryArtifact.tradeDirection)) {
            return true;
        }

        const direction = signal.type === "buy" ? "long" : "short";
        const vote = resolveContextVote(direction, vetoArtifact.entryPresenceByTime.get(timeKey(signal.time)));
        return vote !== "oppose" && vote !== "conflict";
    });
}

function buildExecutedEntrySignals(
    trades: readonly { entryTime: Signal["time"]; entryPrice: number; type: "long" | "short" }[],
    candles: OHLCVData[]
): Signal[] {
    const barIndexByTime = new Map<string, number>();
    candles.forEach((candle, index) => {
        barIndexByTime.set(timeKey(candle.time), index);
    });

    return trades.map((trade) => ({
        time: trade.entryTime,
        type: trade.type === "long" ? "buy" : "sell",
        price: trade.entryPrice,
        triggerPrice: trade.entryPrice,
        barIndex: barIndexByTime.get(timeKey(trade.entryTime)),
    }));
}

function buildRecipeReplayBacktestSettings(
    anchorBacktestSettings: BacktestSettings,
    preparedSignals: readonly Signal[]
): BacktestSettings {
    const tradeDirection = inferReplayTradeDirection(preparedSignals);

    return {
        ...anchorBacktestSettings,
        executionModel: "signal_close",
        tradeDirection,
        tradeFilterMode: "none",
        entrySettingsToggle: false,
        slippageBps: 0,
    };
}

function buildRecipeReplayConfig(
    anchorConfig: StrategyConfig,
    preparedSignals: readonly Signal[]
): StrategyConfig {
    return {
        ...anchorConfig,
        strategyParams: { ...anchorConfig.strategyParams },
        backtestSettings: {
            ...anchorConfig.backtestSettings,
            executionModel: "signal_close",
            tradeDirection: inferReplayTradeDirection(preparedSignals),
            tradeFilterMode: "none",
            tradeFilterSettingsToggle: false,
            entrySettingsToggle: false,
            slippageBps: 0,
        },
    };
}

function buildOverlaySignal(signals: readonly Signal[]): Signal {
    const first = signals[0]!;
    const averagePrice = signals.reduce((sum, signal) => sum + signal.price, 0) / signals.length;
    const triggerPrice = signals.reduce((sum, signal) => sum + (signal.triggerPrice ?? signal.price), 0) / signals.length;

    return {
        time: first.time,
        type: first.type,
        price: averagePrice,
        triggerPrice,
        barIndex: first.barIndex,
        reason: `ensemble_conflict_filtered_${first.type}`,
    };
}

function compareSignalsByBarIndexThenTime(left: Signal, right: Signal): number {
    const leftBarIndex = Number.isFinite(left.barIndex as number) ? Math.trunc(left.barIndex as number) : null;
    const rightBarIndex = Number.isFinite(right.barIndex as number) ? Math.trunc(right.barIndex as number) : null;
    if (leftBarIndex !== null && rightBarIndex !== null && leftBarIndex !== rightBarIndex) {
        return leftBarIndex - rightBarIndex;
    }

    const leftKey = timeKey(left.time);
    const rightKey = timeKey(right.time);
    if (leftKey === rightKey) {
        return 0;
    }
    return leftKey < rightKey ? -1 : 1;
}

function inferReplayTradeDirection(preparedSignals: readonly Signal[]): TradeDirection {
    const hasBuy = preparedSignals.some((signal) => signal.type === "buy");
    const hasSell = preparedSignals.some((signal) => signal.type === "sell");
    if (hasBuy && hasSell) {
        return "combined";
    }
    if (hasSell) {
        return "short";
    }
    return "long";
}

function isEntrySignal(signal: Signal, tradeDirection: TradeDirection): boolean {
    if (
        tradeDirection === "both"
        || tradeDirection === "both_flip_loss_2"
        || tradeDirection === "combined"
    ) {
        return signal.type === "buy" || signal.type === "sell";
    }

    return tradeDirection === "short" ? signal.type === "sell" : signal.type === "buy";
}

function buildEntryPresenceLookup(signals: Signal[]): Map<string, EnsembleEntryPresence> {
    const lookup = new Map<string, EnsembleEntryPresence>();

    for (const signal of signals) {
        const existing = lookup.get(timeKey(signal.time)) ?? { longEntry: false, shortEntry: false };
        if (signal.type === "buy") {
            existing.longEntry = true;
        } else if (signal.type === "sell") {
            existing.shortEntry = true;
        }
        lookup.set(timeKey(signal.time), existing);
    }

    return lookup;
}
