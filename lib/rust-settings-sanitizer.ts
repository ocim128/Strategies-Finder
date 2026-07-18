import type { BacktestSettings } from "./types/strategies";
import { isSameEventPolymarketExitMode } from "./polymarket-exit-mode";

export function getTypescriptEngineRequirementReasons(settings: BacktestSettings): string[] {
    const executionModel = settings.executionModel ?? 'signal_close';
    const allowSameBarExit = false;
    const slippageBps = settings.slippageBps ?? 0;
    const marketMode = 'all';

    const usesCombinedDirection =
        settings.tradeDirection === 'both'
        || settings.tradeDirection === 'both_no_flip'
        || settings.tradeDirection === 'both_flip_loss_2'
        || settings.tradeDirection === 'combined';

    const usesNonAllMarketMode = marketMode !== 'all';

    const usesRiskMaxHold =
        settings.riskMaxHoldEnabled === true
        && (settings.riskMaxHoldBars ?? 0) > 0;
    const usesRiskMinHold =
        settings.riskMinHoldEnabled === true
        && (settings.riskMinHoldBars ?? 0) > 0;
    const usesPercentageWinStreakStopLoss = false;
    const usesAdaptivePercentageTakeProfit =
        settings.riskMode === 'percentage'
        && settings.takeProfitEnabled === true
        && settings.takeProfitMode !== undefined
        && settings.takeProfitMode !== 'fixed';

    const usesMultiPosition = (settings.maxOpenTrades ?? 1) > 1;

    const usesSignalExitMode = isSameEventPolymarketExitMode(settings.polymarketExitMode);
    const usesDisableSignalExits = settings.disableSignalExits === true;
    const usesPolymarketProtection =
        (settings.polymarketProtectionTakeProfitEnabled === true && (settings.polymarketProtectionTakeProfitCents ?? 0) > 0)
        || (settings.polymarketProtectionStopLossEnabled === true && (settings.polymarketProtectionStopLossCents ?? 0) > 0);

    const usesPathExit =
        settings.pathExitEnabled === true
        && settings.pathExitMode !== undefined
        && settings.pathExitMode !== 'off';

    const reasons: string[] = [];
    if (executionModel !== 'signal_close') reasons.push('execution model is not signal_close');
    if (slippageBps > 0) reasons.push('slippage is enabled');
    if (!allowSameBarExit) reasons.push('same-bar exits are disabled');
    if (usesCombinedDirection) reasons.push('combined trade direction is enabled');
    if (usesNonAllMarketMode) reasons.push('market-mode filtering is enabled');
    if (usesRiskMaxHold) reasons.push('maximum hold bars are enabled');
    if (usesRiskMinHold) reasons.push('minimum hold bars are enabled');
    if (usesPercentageWinStreakStopLoss) reasons.push('win-streak stop loss is enabled');
    if (usesAdaptivePercentageTakeProfit) reasons.push('adaptive take profit is enabled');
    if (usesMultiPosition) reasons.push('multiple open positions are enabled');
    if (usesSignalExitMode) reasons.push('same-event Polymarket exits are enabled');
    if (usesDisableSignalExits) reasons.push('signal exits are disabled');
    if (usesPolymarketProtection) reasons.push('Polymarket protection is enabled');
    if (usesPathExit) reasons.push('path exits are enabled');
    return reasons;
}

export function requiresTypescriptEngine(settings: BacktestSettings): boolean {
    return getTypescriptEngineRequirementReasons(settings).length > 0;
}

export const SNAPSHOT_FILTER_SETTING_KEYS = [] as const;

export const RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS = [
    "pathExitEnabled",
    "pathExitMode",
    "pathExitMinBars",
    "pathExitMinMfePercent",
    "pathExitGivebackPercent",
    "pathExitLookbackBars",
    "pathExitThreshold",
    "pathExitMinSamples",
    "pathExitHorizonBars",
    "executionModel",
    "allowSameBarExit",
    "slippageBps",
    "maxOpenTrades",
    "marketMode",
    "riskMinHoldBars",
    "riskMinHoldEnabled",
    "riskMaxHoldBars",
    "riskMaxHoldEnabled",
    "riskWinStreakStopLossEnabled",
    "riskWinStreakStopLossAfterWins",
    "riskWinStreakStopLossPercent",
    "disableSignalExits",
    "exitStrategyOverrideEnabled",
    "exitStrategyKey",
    "exitStrategyParams",
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
    "tradeFilterMode",
    "tradeFilterSettingsToggle",
    "entrySettingsToggle",
    "entryConfirmation",
    "htfBiasEmaPeriod",
    "executionTrendEmaPeriod",
    "confirmLookback",
    "volumeSmaPeriod",
    "volumeMultiplier",
    "confirmRsiPeriod",
    "confirmRsiBullish",
    "confirmRsiBearish",
    "rsiPeriod",
    "rsiBullish",
    "rsiBearish",
    "confirmationStrategiesToggle",
    "confirmationStrategies",
    "confirmationMode",
    "confirmationWindowBars",
    "confirmationStrategyParams",
    "strategyTimeframeEnabled",
    "strategyTimeframeMinutes",
    "kellyFraction",
    "kellyWinRateCap",
    "kellyProfitFactorCap",
    "volTargetAnnual",
    "volLookbackBars",
    "volScalingMethod",
    "riskParityLookback",
    "riskParityMethod",
    "martingaleMultiplier",
    "martingaleMaxSequence",
    "martingaleResetOnWin",
    "martingaleResetOnLoss",
    "martingaleBaseSize",
    "optimalFLookback",
    "optimalFBootstrapSamples",
    "secureFConfidence",
    "secureFMethod",
    "polymarketAnnotationEnabled",
    "polymarketOutcomeSymbol",
    "polymarketOutcomeInterval",
    "polymarketEntrySelectionMode",
    "polymarketEntryOffset",
    "polymarketEntryDelayBars",
    "polymarketEntryPriceFilterCents",
    "polymarketBacktestSlippageCents",
    "polymarketEntryCutoffEnabled",
    "polymarketEntryCutoffSeconds",
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
    "polymarketProtectionTakeProfitEnabled",
    "polymarketProtectionTakeProfitCents",
    "polymarketProtectionStopLossEnabled",
    "polymarketProtectionStopLossCents",
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
