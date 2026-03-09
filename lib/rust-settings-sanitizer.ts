import type { BacktestSettings } from "./types/strategies";

const RUST_UNSUPPORTED_TRADE_FILTER_MODES = new Set([
    "trend_htf_bias",
    "trend_exec_alignment",
    "trend_no_chase",
    "trend_hysteresis",
    "trend_mtf_stack",
]);

/**
 * Determines if TypeScript engine is required for given backtest settings.
 * This is the single-source-of-truth for Rust eligibility decisions.
 * 
 * Returns true if any setting is incompatible with Rust backend, including:
 * - Non-default executionModel (not 'signal_close')
 * - Slippage (slippageBps > 0)
 * - Disabled same-bar exit (!allowSameBarExit)
 * - tradeDirection 'both', 'both_flip_loss_2', or 'combined'
 * - marketMode !== 'all'
 * - Any non-zero snapshot filter
 * - Percentage-based risk extras (max hold, win-streak stop-loss override)
 */
export function requiresTypescriptEngine(settings: BacktestSettings): boolean {
    const executionModel = settings.executionModel ?? 'signal_close';
    const allowSameBarExit = settings.allowSameBarExit ?? true;
    const slippageBps = settings.slippageBps ?? 0;
    const marketMode = settings.marketMode ?? 'all';
    const tradeFilterMode = settings.tradeFilterMode ?? 'none';

    // Realism constraints
    const usesRealismConstraints =
        executionModel !== 'signal_close'
        || slippageBps > 0
        || !allowSameBarExit;

    // Trade direction constraints
    const usesCombinedDirection =
        settings.tradeDirection === 'both'
        || settings.tradeDirection === 'both_flip_loss_2'
        || settings.tradeDirection === 'combined';

    // Market mode constraint (Rust only supports 'all')
    const usesNonAllMarketMode = marketMode !== 'all';
    const usesUnsupportedTradeFilterMode = RUST_UNSUPPORTED_TRADE_FILTER_MODES.has(tradeFilterMode);

    // Percentage-based risk guards
    const usesPercentageMaxHold =
        settings.riskMode === 'percentage'
        && settings.riskMaxHoldEnabled === true
        && (settings.riskMaxHoldBars ?? 0) > 0;
    const usesPercentageWinStreakStopLoss =
        settings.riskMode === 'percentage'
        && settings.riskWinStreakStopLossEnabled === true
        && (settings.riskWinStreakStopLossAfterWins ?? 0) > 0
        && (settings.riskWinStreakStopLossPercent ?? 0) > 0;

    // Snapshot filters
    const hasSnapshotFilters = hasNonZeroSnapshotFilter(settings);

    // Multi-position constraint
    const usesMultiPosition = (settings.maxOpenTrades ?? 1) > 1;
    const usesWarmUpEntry = settings.warmUpEntryEnabled === true;

    return usesRealismConstraints
        || usesCombinedDirection
        || usesNonAllMarketMode
        || usesUnsupportedTradeFilterMode
        || usesPercentageMaxHold
        || usesPercentageWinStreakStopLoss
        || hasSnapshotFilters
        || usesMultiPosition
        || usesWarmUpEntry;
}

export const SNAPSHOT_FILTER_SETTING_KEYS = [
    "snapshotAtrPercentMin",
    "snapshotAtrPercentMax",
    "snapshotVolumeRatioMin",
    "snapshotVolumeRatioMax",
    "snapshotAdxMin",
    "snapshotAdxMax",
    "snapshotEmaDistanceMin",
    "snapshotEmaDistanceMax",
    "snapshotRsiMin",
    "snapshotRsiMax",
    "snapshotPriceRangePosMin",
    "snapshotPriceRangePosMax",
    "snapshotBarsFromHighMax",
    "snapshotBarsFromLowMax",
    "snapshotTrendEfficiencyMin",
    "snapshotTrendEfficiencyMax",
    "snapshotAtrRegimeRatioMin",
    "snapshotAtrRegimeRatioMax",
    "snapshotBodyPercentMin",
    "snapshotBodyPercentMax",
    "snapshotWickSkewMin",
    "snapshotWickSkewMax",
    "snapshotVolumeTrendMin",
    "snapshotVolumeTrendMax",
    "snapshotVolumeBurstMin",
    "snapshotVolumeBurstMax",
    "snapshotVolumePriceDivergenceMin",
    "snapshotVolumePriceDivergenceMax",
    "snapshotVolumeConsistencyMin",
    "snapshotVolumeConsistencyMax",
    "snapshotCloseLocationMin",
    "snapshotCloseLocationMax",
    "snapshotOppositeWickMin",
    "snapshotOppositeWickMax",
    "snapshotRangeAtrMultipleMin",
    "snapshotRangeAtrMultipleMax",
    "snapshotMomentumConsistencyMin",
    "snapshotMomentumConsistencyMax",
    "snapshotBreakQualityMin",
    "snapshotBreakQualityMax",
    "snapshotTf60PerfMin",
    "snapshotTf60PerfMax",
    "snapshotTf90PerfMin",
    "snapshotTf90PerfMax",
    "snapshotTf120PerfMin",
    "snapshotTf120PerfMax",
    "snapshotTf480PerfMin",
    "snapshotTf480PerfMax",
    "snapshotTfConfluencePerfMin",
    "snapshotTfConfluencePerfMax",
    "snapshotEntryQualityScoreMin",
    "snapshotEntryQualityScoreMax",
] as const satisfies readonly (keyof BacktestSettings)[];

export const RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS = [
    "executionModel",
    "allowSameBarExit",
    "slippageBps",
    "maxOpenTrades",
    "warmUpEntryEnabled",
    "marketMode",
    "riskMaxHoldBars",
    "riskMaxHoldEnabled",
    "riskWinStreakStopLossEnabled",
    "riskWinStreakStopLossAfterWins",
    "riskWinStreakStopLossPercent",
    "invertSignals",
    "flipAfterConsecutiveLosses",
    "flipCooldownTrades",
    "minTradesBeforeFirstFlip",
    "strategyTimeframeEnabled",
    "strategyTimeframeMinutes",
    "twoHourCloseParity",
    "captureSnapshots",
    ...SNAPSHOT_FILTER_SETTING_KEYS,
] as const satisfies readonly (keyof BacktestSettings)[];

const UNSUPPORTED_KEYS = new Set<string>(RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS);

export function sanitizeBacktestSettingsForRust(settings: BacktestSettings): BacktestSettings {
    const sanitizedEntries = Object.entries(settings).filter(([key]) => !UNSUPPORTED_KEYS.has(key));
    return Object.fromEntries(sanitizedEntries) as BacktestSettings;
}

export function hasNonZeroSnapshotFilter(settings: BacktestSettings): boolean {
    return SNAPSHOT_FILTER_SETTING_KEYS.some((key) => {
        const value = settings[key];
        return typeof value === "number" && Number.isFinite(value) && value !== 0;
    });
}
