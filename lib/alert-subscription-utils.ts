import {
    EFFECTIVE_BACKTEST_DEFAULTS,
    hasUiToggleSettings,
    resolveBacktestSettingsFromRaw,
} from "./backtest-settings-resolver";
import { strategies } from "./strategies/library";
import type { BacktestSettings, TradeDirection } from "./types/strategies";

export interface WorkerStrategySupportSnapshot {
    supportedStrategyKeys: string[];
    supportedStrategyCount: number;
    strategyManifestFingerprint: string;
}

const VALID_TAKE_PROFIT_MODES = new Set<NonNullable<BacktestSettings["takeProfitMode"]>>([
    "fixed",
    "shrinkage",
    "momentum_gated",
    "velocity",
]);

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

function isValidTakeProfitMode(value: unknown): value is NonNullable<BacktestSettings["takeProfitMode"]> {
    return typeof value === "string" && VALID_TAKE_PROFIT_MODES.has(value as NonNullable<BacktestSettings["takeProfitMode"]>);
}

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
        return Number.isFinite(value) ? value !== 0 : null;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
        if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
    }
    return null;
}

export function getWorkerSupportedStrategyKeys(): string[] {
    return Object.keys(strategies).sort((a, b) => a.localeCompare(b));
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
    return key.length > 0 && Object.prototype.hasOwnProperty.call(strategies, key);
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
            captureSnapshots: false,
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
    merged.takeProfitMode = isValidTakeProfitMode(merged.takeProfitMode)
        ? merged.takeProfitMode
        : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMode;
    merged.allowSameBarExit = toBooleanLike(merged.allowSameBarExit)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.allowSameBarExit;
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
    merged.warmUpEntryEnabled = toBooleanLike(merged.warmUpEntryEnabled)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.warmUpEntryEnabled;
    merged.strategyTimeframeEnabled = toBooleanLike(merged.strategyTimeframeEnabled)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeEnabled;
    merged.strategyTimeframeMinutes = toFiniteNumber(merged.strategyTimeframeMinutes)
        ?? EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeMinutes;
    merged.twoHourCloseParity = merged.twoHourCloseParity === "even" || merged.twoHourCloseParity === "both"
        ? merged.twoHourCloseParity
        : EFFECTIVE_BACKTEST_DEFAULTS.twoHourCloseParity;
    merged.takeProfitVelocityFastBars = Math.max(
        1,
        Math.round(toFiniteNumber(merged.takeProfitVelocityFastBars) ?? EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityFastBars)
    );
    merged.takeProfitVelocitySlowBars = Math.max(
        1,
        Math.round(toFiniteNumber(merged.takeProfitVelocitySlowBars) ?? EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocitySlowBars)
    );
    merged.takeProfitVelocityProgressPercent = Math.max(
        1,
        Math.min(100, toFiniteNumber(merged.takeProfitVelocityProgressPercent) ?? EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityProgressPercent)
    );
    merged.takeProfitVelocityExpandMultiplier = Math.max(
        0.1,
        toFiniteNumber(merged.takeProfitVelocityExpandMultiplier) ?? EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityExpandMultiplier
    );
    merged.takeProfitVelocityShrinkMultiplier = Math.max(
        0.1,
        toFiniteNumber(merged.takeProfitVelocityShrinkMultiplier) ?? EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityShrinkMultiplier
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

    if (raw.captureSnapshots === true) {
        merged.captureSnapshots = true;
    }

    return merged as BacktestSettings;
}
import { isTradeSizingMode } from "./types/backtest";
