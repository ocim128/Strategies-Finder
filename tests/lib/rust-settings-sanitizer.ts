import type { BacktestSettings } from "./types/strategies";

const RUST_UNSUPPORTED_TRADE_FILTER_MODES = new Set([
    "trend_htf_bias",
    "trend_exec_alignment",
]);

export function requiresTypescriptEngine(settings: BacktestSettings): boolean {
    const executionModel = settings.executionModel ?? 'signal_close';
    const allowSameBarExit = false;
    const slippageBps = settings.slippageBps ?? 0;
    const marketMode = 'all';
    const tradeFilterMode = settings.tradeFilterMode ?? 'none';

    const usesRealismConstraints =
        executionModel !== 'signal_close'
        || slippageBps > 0
        || !allowSameBarExit;

    const usesCombinedDirection =
        settings.tradeDirection === 'both'
        || settings.tradeDirection === 'both_flip_loss_2'
        || settings.tradeDirection === 'combined';

    const usesNonAllMarketMode = marketMode !== 'all';
    const usesUnsupportedTradeFilterMode = RUST_UNSUPPORTED_TRADE_FILTER_MODES.has(tradeFilterMode);

    const usesRiskMaxHold =
        settings.riskMaxHoldEnabled === true
        && (settings.riskMaxHoldBars ?? 0) > 0;
    const usesRiskMinHold =
        settings.riskMinHoldEnabled === true
        && (settings.riskMinHoldBars ?? 0) > 0;
    const usesHistoricalLevels =
        ((settings.historicalLevelTakeProfitEnabled === true)
            || (settings.historicalLevelStopLossEnabled === true))
        && (settings.historicalLevelLookbackBars ?? 0) > 0;
    const usesPercentageWinStreakStopLoss = false;
    const usesAdaptivePercentageTakeProfit =
        settings.riskMode === 'percentage'
        && settings.takeProfitEnabled === true
        && settings.takeProfitMode !== undefined
        && settings.takeProfitMode !== 'fixed';

    const usesMultiPosition = (settings.maxOpenTrades ?? 1) > 1;

    const usesSignalExitMode = settings.polymarketExitMode === "signal_exit_same_event";

    return usesRealismConstraints
        || usesCombinedDirection
        || usesNonAllMarketMode
        || usesUnsupportedTradeFilterMode
        || usesRiskMaxHold
        || usesRiskMinHold
        || usesHistoricalLevels
        || usesPercentageWinStreakStopLoss
        || usesAdaptivePercentageTakeProfit
        || usesMultiPosition
        || usesSignalExitMode;
}

export const SNAPSHOT_FILTER_SETTING_KEYS = [] as const;

export const RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS = [
    "executionModel",
    "allowSameBarExit",
    "slippageBps",
    "executionTrendEmaPeriod",
    "maxOpenTrades",
    "marketMode",
    "riskMinHoldBars",
    "riskMinHoldEnabled",
    "riskMaxHoldBars",
    "riskMaxHoldEnabled",
    "historicalLevelTakeProfitEnabled",
    "historicalLevelStopLossEnabled",
    "historicalLevelLookbackBars",
    "riskWinStreakStopLossEnabled",
    "riskWinStreakStopLossAfterWins",
    "riskWinStreakStopLossPercent",
    "takeProfitMfeBootstrapPercentile",
    "takeProfitAdaptiveLookbackTrades",
    "takeProfitAdaptiveRecentWindow",
    "takeProfitAdaptiveMinMultiplier",
    "takeProfitAdaptiveMaxMultiplier",
    "takeProfitAdaptiveGridSteps",
    "takeProfitAdaptiveRegimeBlend",
    "takeProfitAdaptiveIcScale",
    "invertSignals",
    "flipAfterConsecutiveLosses",
    "flipCooldownTrades",
    "minTradesBeforeFirstFlip",
    "strategyTimeframeEnabled",
    "strategyTimeframeMinutes",
    "polymarketOutcomeSymbol",
    "polymarketOutcomeInterval",
    "polymarketEntrySelectionMode",
    "polymarketEntryPriceFilterCents",
    "polymarketExitMode",
    "polymarketSignalExitAllowMultipleTradesPerEvent",
    "polymarketPostSignalLimitEntryEnabled",
    "polymarketPostSignalLimitEntryMode",
    "polymarketPostSignalLimitEntryPriceCents",
    "polymarketPostSignalLimitEntryOffsetCents",
    "polymarketPostSignalLimitExitEnabled",
    "polymarketPostSignalLimitExitMode",
    "polymarketPostSignalLimitExitPriceCents",
    "polymarketPostSignalLimitExitOffsetCents",
    "crossSymbolSecondary",
] as const;

const UNSUPPORTED_KEYS = new Set<string>(RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS);

export function sanitizeBacktestSettingsForRust(settings: BacktestSettings): BacktestSettings {
    const sanitizedEntries = Object.entries(settings).filter(([key]) => !UNSUPPORTED_KEYS.has(key));
    return Object.fromEntries(sanitizedEntries) as BacktestSettings;
}

export function hasNonZeroSnapshotFilter(_settings: BacktestSettings): boolean {
    return false;
}
