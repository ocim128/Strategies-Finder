import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import { resolveCapitalSettingsFromRaw } from "./backtest-capital-settings";
import type { EntrySignalCapitalSettings, EntrySignalEvaluationResult } from "./signal-entry-evaluator";
import { evaluateLatestEntrySignalFromPreparedSignals } from "./signal-entry-evaluator";
import {
    normalizeEnsembleRecipeReplayDirectionOverride,
    type EnsembleRecipeReplayDirectionOverride,
} from "./ensemble-signal-direction";
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
import type { EnsembleEntryPresence } from "./strategy-ensemble-types";
import {
    buildPrimaryVetoPreparedSignals,
    buildPrimarySecondaryOverridePreparedSignals,
    buildBestSideOwnerPreparedSignals,
    buildTargetConflictFilterPreparedSignals,
} from "./strategy-ensemble-signal-filters";

export {
    buildBestSideOwnerPreparedSignals,
    buildPrimaryVetoPreparedSignals,
    buildPrimarySecondaryOverridePreparedSignals,
    buildTargetConflictFilterPreparedSignals,
} from "./strategy-ensemble-signal-filters";

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
    if (strategy.crossSymbolConfig) {
        throw new Error(`Ensemble recipes do not support cross-symbol strategy "${config.strategyKey}". Remove it from the recipe or use a non-cross-symbol strategy.`);
    }
        const backtestSettings = resolveBacktestSettingsFromRaw(
            config.backtestSettings as unknown as BacktestSettings,
            { coerceWithoutUiToggles: true }
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
            advancedSizing: capitalSettings.advancedSizing,
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
    directionOverride?: EnsembleRecipeReplayDirectionOverride;
}): { preparedSignals: Signal[]; anchorConfig: StrategyConfig; anchorBacktestSettings: BacktestSettings; description: string } {
    const { recipe, candles, getStrategy } = args;
    const directionOverride = normalizeEnsembleRecipeReplayDirectionOverride(args.directionOverride);
    const artifactByName = new Map<string, EnsembleRecipeSignalArtifact>();

    for (const config of recipe.componentConfigs) {
        const strategy = getStrategy(config.strategyKey);
        if (!strategy) {
            throw new Error(`Recipe component strategy "${config.strategyKey}" is not available.`);
        }
        artifactByName.set(config.name, buildEnsembleRecipeSignalArtifact(config, strategy, candles));
    }

    const getRequiredArtifact = (configName: string, role: string): EnsembleRecipeSignalArtifact => {
        const artifact = artifactByName.get(configName);
        if (!artifact) {
            throw new Error(`Recipe ${role} config "${configName}" is missing.`);
        }
        return artifact;
    };

    const anchorArtifact = artifactByName.get(recipe.anchorConfigName);
    if (!anchorArtifact) {
        throw new Error(`Recipe anchor config "${recipe.anchorConfigName}" is missing.`);
    }

    if (recipe.mode === "primary_veto") {
        const vetoName = recipe.vetoConfigName?.trim();
        if (!vetoName) {
            throw new Error("Primary-veto recipe is missing the veto config name.");
        }

        const vetoArtifact = getRequiredArtifact(vetoName, "veto");

        const preparedSignals = applyEnsembleRecipeReplayDirectionOverride(
            buildPrimaryVetoPreparedSignals(anchorArtifact, vetoArtifact),
            directionOverride
        );
        return {
            preparedSignals,
            anchorConfig: buildRecipeReplayConfig(
                anchorArtifact.config,
                preparedSignals,
                directionOverride
            ),
            anchorBacktestSettings: buildRecipeReplayBacktestSettings(
                anchorArtifact.backtestSettings,
                preparedSignals,
                directionOverride
            ),
            description: `${anchorArtifact.config.name} vetoed by ${vetoArtifact.config.name} (${directionOverride === "auto" ? "auto" : `${directionOverride} override`})`,
        };
    }

    if (recipe.mode === "secondary_override") {
        const secondaryName = recipe.secondaryConfigName?.trim();
        if (!secondaryName) {
            throw new Error("Secondary-override recipe is missing the secondary config name.");
        }

        const secondaryArtifact = getRequiredArtifact(secondaryName, "secondary");
        const preparedSignals = applyEnsembleRecipeReplayDirectionOverride(
            buildPrimarySecondaryOverridePreparedSignals(anchorArtifact, secondaryArtifact),
            directionOverride
        );
        return {
            preparedSignals,
            anchorConfig: buildRecipeReplayConfig(
                anchorArtifact.config,
                preparedSignals,
                directionOverride
            ),
            anchorBacktestSettings: buildRecipeReplayBacktestSettings(
                anchorArtifact.backtestSettings,
                preparedSignals,
                directionOverride
            ),
            description: `${anchorArtifact.config.name} overridden by ${secondaryArtifact.config.name} on opposite-side conflicts (${directionOverride === "auto" ? "auto" : `${directionOverride} override`})`,
        };
    }

    if (recipe.mode === "best_side_owner") {
        const longOwnerName = recipe.longOwnerConfigName?.trim() || "";
        const shortOwnerName = recipe.shortOwnerConfigName?.trim() || "";
        const longArtifact = longOwnerName ? getRequiredArtifact(longOwnerName, "long-owner") : null;
        const shortArtifact = shortOwnerName ? getRequiredArtifact(shortOwnerName, "short-owner") : null;
        if (!longArtifact && !shortArtifact) {
            throw new Error("Best-side-owner recipe is missing both owner configs.");
        }

        const preparedSignals = applyEnsembleRecipeReplayDirectionOverride(
            buildBestSideOwnerPreparedSignals({
                longArtifact,
                shortArtifact,
            }),
            directionOverride
        );
        const ownerParts = [
            longArtifact ? `long ${longArtifact.config.name}` : "",
            shortArtifact ? `short ${shortArtifact.config.name}` : "",
        ].filter((part) => part.length > 0);
        return {
            preparedSignals,
            anchorConfig: buildRecipeReplayConfig(anchorArtifact.config, preparedSignals, directionOverride),
            anchorBacktestSettings: buildRecipeReplayBacktestSettings(anchorArtifact.backtestSettings, preparedSignals, directionOverride),
            description: `best-side-owner replay using ${ownerParts.join(" + ")} (${directionOverride === "auto" ? "auto" : `${directionOverride} override`})`,
        };
    }

    const contextArtifacts = Array.from(artifactByName.values())
        .filter((artifact) => artifact.config.name !== anchorArtifact.config.name);
    const overlaySignals = applyEnsembleRecipeReplayDirectionOverride(
        buildTargetConflictFilterPreparedSignals(anchorArtifact, contextArtifacts),
        directionOverride
    );

        return {
            preparedSignals: overlaySignals,
            anchorConfig: buildRecipeReplayConfig(anchorArtifact.config, overlaySignals, directionOverride),
            anchorBacktestSettings: buildRecipeReplayBacktestSettings(anchorArtifact.backtestSettings, overlaySignals, directionOverride),
            description: `target-anchored conflict-filter overlay from ${anchorArtifact.config.name} across ${contextArtifacts.length} context config${contextArtifacts.length === 1 ? "" : "s"} (${directionOverride === "auto" ? "auto" : `${directionOverride} override`})`,
        };
    }

export function evaluateEnsembleRecipeLatestEntry(args: {
    recipe: EnsembleSignalRecipe;
    candles: OHLCVData[];
    getStrategy: (strategyKey: string) => Strategy | undefined;
    freshnessBars?: number;
    capitalSettings?: EntrySignalCapitalSettings;
    directionOverride?: EnsembleRecipeReplayDirectionOverride;
}): EntrySignalEvaluationResult {
    const resolved = buildPreparedSignalsForEnsembleRecipe({
        recipe: args.recipe,
        candles: args.candles,
        getStrategy: args.getStrategy,
        directionOverride: args.directionOverride,
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

function buildExecutedEntrySignals(
    trades: readonly { entryTime: Signal["time"]; entryPrice: number; type: "long" | "short" }[],
    candles: OHLCVData[]
): Signal[] {
    const barIndexByTime = new Map<string, number>();
    candles.forEach((candle, index) => {
        barIndexByTime.set(timeKey(candle.time), index);
    });
    const dedupedByEventSide = new Map<string, Signal>();

    for (const trade of trades) {
        const type: Signal["type"] = trade.type === "long" ? "buy" : "sell";
        const eventKey = `${timeKey(trade.entryTime)}:${type}`;
        if (dedupedByEventSide.has(eventKey)) {
            continue;
        }
        dedupedByEventSide.set(eventKey, {
            time: trade.entryTime,
            type,
            price: trade.entryPrice,
            triggerPrice: trade.entryPrice,
            barIndex: barIndexByTime.get(timeKey(trade.entryTime)),
        });
    }

    return Array.from(dedupedByEventSide.values()).sort(compareSignalsByBarIndexThenTime);
}

function buildRecipeReplayBacktestSettings(
    anchorBacktestSettings: BacktestSettings,
    preparedSignals: readonly Signal[],
    directionOverride: EnsembleRecipeReplayDirectionOverride
): BacktestSettings {
    const tradeDirection = resolveReplayTradeDirection(preparedSignals, directionOverride);

    return {
        ...anchorBacktestSettings,
        executionModel: "next_open",
        tradeDirection,
        tradeFilterMode: "none",
        entrySettingsToggle: false,
        slippageBps: 0,
    };
}

function buildRecipeReplayConfig(
    anchorConfig: StrategyConfig,
    preparedSignals: readonly Signal[],
    directionOverride: EnsembleRecipeReplayDirectionOverride
): StrategyConfig {
    return {
        ...anchorConfig,
        strategyParams: { ...anchorConfig.strategyParams },
        backtestSettings: {
            ...anchorConfig.backtestSettings,
            executionModel: "next_open",
            tradeDirection: resolveReplayTradeDirection(preparedSignals, directionOverride),
            tradeFilterMode: "none",
            tradeFilterSettingsToggle: false,
            entrySettingsToggle: false,
            slippageBps: 0,
        },
    };
}

export function applyEnsembleRecipeReplayDirectionOverride(
    preparedSignals: readonly Signal[],
    directionOverride: EnsembleRecipeReplayDirectionOverride
): Signal[] {
    if (directionOverride === "auto" || directionOverride === "combined") {
        return [...preparedSignals];
    }
    const signalType = directionOverride === "short" ? "sell" : "buy";
    return preparedSignals.filter((signal) => signal.type === signalType);
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

function resolveReplayTradeDirection(
    preparedSignals: readonly Signal[],
    directionOverride: EnsembleRecipeReplayDirectionOverride
): TradeDirection {
    if (directionOverride === "short") {
        return "short";
    }
    if (directionOverride === "long") {
        return "long";
    }
    if (directionOverride === "combined") {
        return "combined";
    }
    return inferReplayTradeDirection(preparedSignals);
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
