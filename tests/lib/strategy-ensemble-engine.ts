import type { StrategyConfig } from "./settings-manager";
import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import {
    applySignalPolarity,
    prepareSignalsForScanner,
    timeKey,
    type BacktestResult,
    type BacktestSettings,
    type OHLCVData,
    type Signal,
    type Strategy,
    type StrategyParams,
    type TradeDirection,
} from "./strategies";
import type {
    ConfigRunArtifact,
    ConfigSignalArtifact,
    EnsembleEntryPresence,
} from "./strategy-ensemble-types";
import type { CapitalSettings } from "./types/backtest";

export type StrategyEnsembleCapitalSettings = CapitalSettings;

export interface StrategyEnsembleEngineDeps {
    interval: string;
    loadStrategyConfig(configName: string): StrategyConfig | null;
    getStrategy(strategyKey: string): Strategy | undefined;
    resolveCapitalFromConfig(config: StrategyConfig): StrategyEnsembleCapitalSettings;
    evaluateStrategyOnData(
        candles: OHLCVData[],
        interval: string,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings,
        capitalSettings: StrategyEnsembleCapitalSettings
    ): Promise<{ result: BacktestResult; engineUsed: "rust" | "typescript" }>;
    evaluateSignalsOnData(
        candles: OHLCVData[],
        interval: string,
        signals: Signal[],
        settings: BacktestSettings,
        capitalSettings: StrategyEnsembleCapitalSettings
    ): Promise<{ result: BacktestResult; engineUsed: "rust" | "typescript" }>;
    warn(message: string, details?: unknown): void;
}

export async function buildSignalArtifact(
    configName: string,
    candles: OHLCVData[],
    deps: StrategyEnsembleEngineDeps
): Promise<ConfigSignalArtifact | null> {
    const config = deps.loadStrategyConfig(configName);
    if (!config) {
        return null;
    }

    const strategy = deps.getStrategy(config.strategyKey);
    if (!strategy) {
        deps.warn(
            `[StrategyEnsembleLab] Strategy "${config.strategyKey}" from config "${configName}" is not registered.`
        );
        return null;
    }

    const params = config.strategyParams ?? strategy.defaultParams;
    const backtestSettings = resolveBacktestSettingsFromRaw(
        config.backtestSettings as unknown as BacktestSettings,
        { coerceWithoutUiToggles: true }
    );
    const tradeDirection = normalizeTradeDirection(backtestSettings);

    try {
        const rawSignals = applySignalPolarity(strategy.execute(candles, params), backtestSettings);
        const preparedSignals = prepareSignalsForScanner(candles, rawSignals, backtestSettings);
        const entrySignals = extractEntrySignals(preparedSignals, tradeDirection);

        return {
            config,
            strategy,
            familyKey: config.strategyKey,
            familyLabel: strategy.name,
            tradeDirection,
            rawSignals,
            preparedSignals,
            entrySignals,
            entryPresenceByTime: buildEntryPresenceLookup(entrySignals),
            backtestSettings,
        };
    } catch (error) {
        deps.warn(`[StrategyEnsembleLab] Failed to evaluate "${configName}"`, {
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

export async function runConfig(
    configName: string,
    candles: OHLCVData[],
    deps: StrategyEnsembleEngineDeps
): Promise<ConfigRunArtifact | null> {
    const artifact = await buildSignalArtifact(configName, candles, deps);
    if (!artifact) {
        return null;
    }

    try {
        const runResult = await deps.evaluateStrategyOnData(
            candles,
            deps.interval,
            artifact.strategy,
            artifact.config.strategyParams ?? artifact.strategy.defaultParams,
            artifact.backtestSettings,
            deps.resolveCapitalFromConfig(artifact.config)
        );

        return {
            ...artifact,
            result: runResult.result,
            engineUsed: runResult.engineUsed,
        };
    } catch (error) {
        deps.warn(`[StrategyEnsembleLab] Failed to backtest "${configName}"`, {
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

export function normalizeTradeDirection(settings: BacktestSettings): TradeDirection {
    return settings.tradeDirection === "short"
        || settings.tradeDirection === "both"
        || settings.tradeDirection === "both_flip_loss_2"
        || settings.tradeDirection === "combined"
        ? settings.tradeDirection
        : "long";
}

export function isBothLikeTradeDirection(tradeDirection: TradeDirection): boolean {
    return tradeDirection === "both"
        || tradeDirection === "both_flip_loss_2"
        || tradeDirection === "combined";
}

export function extractEntrySignals(signals: Signal[], tradeDirection: TradeDirection): Signal[] {
    if (isBothLikeTradeDirection(tradeDirection)) {
        return signals.filter((signal) => signal.type === "buy" || signal.type === "sell");
    }

    const entryType: Signal["type"] = tradeDirection === "short" ? "sell" : "buy";
    return signals.filter((signal) => signal.type === entryType);
}

export function buildEntryPresenceLookup(signals: Signal[]): Map<string, EnsembleEntryPresence> {
    const lookup = new Map<string, EnsembleEntryPresence>();
    for (const signal of signals) {
        const key = timeKey(signal.time);
        const existing = lookup.get(key) ?? { longEntry: false, shortEntry: false };
        if (signal.type === "buy") {
            existing.longEntry = true;
        } else if (signal.type === "sell") {
            existing.shortEntry = true;
        }
        lookup.set(key, existing);
    }
    return lookup;
}

export function countDistinctFamilies(artifacts: Array<{ familyKey: string }>): number {
    return new Set(artifacts.map((artifact) => artifact.familyKey)).size;
}

export async function runFilteredBacktest(
    targetArtifact: ConfigRunArtifact,
    signals: Signal[],
    candles: OHLCVData[],
    deps: StrategyEnsembleEngineDeps
): Promise<{ result: BacktestResult; engineUsed: "rust" | "typescript" } | null> {
    if (signals.length < 2) {
        return null;
    }

    try {
        return await deps.evaluateSignalsOnData(
            candles,
            deps.interval,
            signals,
            targetArtifact.backtestSettings,
            deps.resolveCapitalFromConfig(targetArtifact.config)
        );
    } catch (error) {
        deps.warn("[StrategyEnsembleLab] Filtered backtest failed", {
            config: targetArtifact.config.name,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

export function isTargetEntrySignal(targetArtifact: ConfigRunArtifact, signal: Signal): boolean {
    if (isBothLikeTradeDirection(targetArtifact.tradeDirection)) {
        return signal.type === "buy" || signal.type === "sell";
    }

    const entryType: Signal["type"] = targetArtifact.tradeDirection === "short" ? "sell" : "buy";
    return signal.type === entryType;
}

export function filterSignalsToCandles(signals: Signal[], candles: OHLCVData[]): Signal[] {
    if (signals.length === 0 || candles.length === 0) {
        return [];
    }

    const keys = new Set(candles.map((candle) => timeKey(candle.time)));
    return signals.filter((signal) => keys.has(timeKey(signal.time)));
}

export function splitCandles(candles: OHLCVData[]): { train: OHLCVData[]; validation: OHLCVData[] } {
    if (candles.length < 2) {
        return { train: candles.slice(), validation: [] };
    }

    const splitIndex = Math.min(candles.length - 1, Math.max(1, Math.floor(candles.length * 0.7)));
    return {
        train: candles.slice(0, splitIndex),
        validation: candles.slice(splitIndex),
    };
}
