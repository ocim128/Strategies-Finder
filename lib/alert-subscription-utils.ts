import {
    EFFECTIVE_BACKTEST_DEFAULTS,
    hasUiToggleSettings,
    resolveBacktestSettingsFromRaw,
} from "./backtest-settings-resolver";
import { extractAdvancedSizingRaw, writeAdvancedSizingIntoRecord } from "./advanced-sizing-settings";
import { toBooleanLike, toFiniteNumber } from "./settings-parse-utils";
import { resolveTakeProfitMode } from "./take-profit-settings";
import { builtInStrategySummary } from "./strategies/manifest-summary";
import type { BacktestSettings, TradeDirection } from "./types/strategies";
import { isTradeSizingMode } from "./types/backtest";

function isValidTradeDirection(value: unknown): value is TradeDirection {
    return value === "long"
        || value === "short"
        || value === "both"
        || value === "both_flip_loss_2"
        || value === "combined";
}

function isValidExecutionModel(value: unknown): value is NonNullable<BacktestSettings["executionModel"]> {
    return value === "signal_close" || value === "next_open" || value === "next_close";
}

export interface WorkerStrategySupportSnapshot {
    supportedStrategyKeys: string[];
    supportedStrategyCount: number;
    strategyManifestFingerprint: string;
}

export function getWorkerSupportedStrategyKeys(): string[] {
    return builtInStrategySummary
        .filter((strategy) => !strategy.crossSymbolConfig && !strategy.polymarket1sConfig)
        .map((strategy) => strategy.key)
        .sort((a, b) => a.localeCompare(b));
}

export function buildWorkerStrategyManifestFingerprint(strategyKeys: readonly string[] = getWorkerSupportedStrategyKeys()): string {
    return strategyKeys.join("|");
}

export function getWorkerStrategySupportSnapshot(): WorkerStrategySupportSnapshot {
    const supportedStrategyKeys = getWorkerSupportedStrategyKeys();
    return {
        supportedStrategyKeys,
        supportedStrategyCount: supportedStrategyKeys.length,
        strategyManifestFingerprint: buildWorkerStrategyManifestFingerprint(supportedStrategyKeys),
    };
}

export function isWorkerSupportedStrategyKey(strategyKey: string): boolean {
    const key = strategyKey.trim();
    if (key.length === 0) return false;
    const strategy = builtInStrategySummary.find((entry) => entry.key === key);
    if (!strategy) return false;
    return !strategy.crossSymbolConfig && !strategy.polymarket1sConfig;
}

/**
 * Normalize stored subscription settings for worker/local execution while
 * preserving subscription-only payload fields such as capital settings.
 */
export function resolveSubscriptionExecutionBacktestSettings(settings?: BacktestSettings): BacktestSettings {
    const raw = (settings && typeof settings === "object")
        ? { ...(settings as Record<string, unknown>) }
        : {};
    const resolved = hasUiToggleSettings(raw)
        ? resolveBacktestSettingsFromRaw(raw as BacktestSettings, {
            coerceWithoutUiToggles: true,
        }) as Record<string, unknown>
        : {};
    const merged: Record<string, unknown> = { ...raw, ...resolved };

    merged.tradeDirection = isValidTradeDirection(merged.tradeDirection)
        ? merged.tradeDirection
        : EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
    merged.executionModel = isValidExecutionModel(merged.executionModel)
        ? merged.executionModel
        : EFFECTIVE_BACKTEST_DEFAULTS.executionModel;
    merged.riskMode = merged.riskMode === "percentage" ? "percentage" : EFFECTIVE_BACKTEST_DEFAULTS.riskMode;
    merged.takeProfitMode = resolveTakeProfitMode(merged.takeProfitMode);
    merged.partialTakeProfitAtR = 0;
    merged.partialTakeProfitPercent = 0;
    merged.breakEvenAtR = 0;
    merged.breakEvenPercent = 0;
    merged.timeStopBars = 0;
    merged.riskWinStreakStopLossEnabled = false;
    merged.riskWinStreakStopLossAfterWins = EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossAfterWins;
    merged.riskWinStreakStopLossPercent = 0;
    merged.marketMode = EFFECTIVE_BACKTEST_DEFAULTS.marketMode;
    merged.allowSameBarExit = EFFECTIVE_BACKTEST_DEFAULTS.allowSameBarExit;
    merged.invertSignals = toBooleanLike(merged.invertSignals)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.invertSignals;
    merged.flipAfterConsecutiveLosses = toFiniteNumber(merged.flipAfterConsecutiveLosses)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.flipAfterConsecutiveLosses;
    merged.flipCooldownTrades = toFiniteNumber(merged.flipCooldownTrades)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.flipCooldownTrades;
    merged.minTradesBeforeFirstFlip = toFiniteNumber(merged.minTradesBeforeFirstFlip)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.minTradesBeforeFirstFlip;
    merged.slippageBps = toFiniteNumber(merged.slippageBps)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.slippageBps;
    merged.maxOpenTrades = toFiniteNumber(merged.maxOpenTrades)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.maxOpenTrades;
    merged.strategyTimeframeEnabled = toBooleanLike(merged.strategyTimeframeEnabled)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeEnabled;
    merged.strategyTimeframeMinutes = toFiniteNumber(merged.strategyTimeframeMinutes)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeMinutes;
    merged.takeProfitMfeBootstrapPercentile = Math.max(
        1,
        Math.min(
            99,
            toFiniteNumber(merged.takeProfitMfeBootstrapPercentile) ?? EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeBootstrapPercentile
        )
    );

    const initialCapital = toFiniteNumber(raw.initialCapital);
    if (initialCapital !== null) {
        merged.initialCapital = initialCapital;
    }
    const positionSize = toFiniteNumber(raw.positionSize);
    if (positionSize !== null) {
        merged.positionSize = positionSize;
    }
    const commission = toFiniteNumber(raw.commission);
    if (commission !== null) {
        merged.commission = commission;
    }
    const fixedTradeToggle = toBooleanLike(raw.fixedTradeToggle);
    if (fixedTradeToggle !== null) {
        merged.fixedTradeToggle = fixedTradeToggle;
    }
    if (raw.sizingMode === 'smart_fixed') {
        merged.sizingMode = 'smart_fixed_velocity_memory';
    } else if (
        raw.sizingMode === 'smart_fixed_early_heat_filter'
        || raw.sizingMode === 'smart_fixed_adverse_memory'
        || raw.sizingMode === 'smart_fixed_mfe_ancestor'
        || raw.sizingMode === 'smart_fixed_tp_distance_fit'
    ) {
        merged.sizingMode = 'smart_fixed_quality_x_velocity';
    } else if (isTradeSizingMode(raw.sizingMode)) {
        merged.sizingMode = raw.sizingMode;
    }
    const fixedTradeAmount = toFiniteNumber(raw.fixedTradeAmount);
    if (fixedTradeAmount !== null) {
        merged.fixedTradeAmount = fixedTradeAmount;
    }
    const advancedSizingRaw = extractAdvancedSizingRaw(raw);
    if (Object.keys(advancedSizingRaw).length > 0) {
        writeAdvancedSizingIntoRecord(merged, advancedSizingRaw as any);
    }

    return merged as BacktestSettings;
}
