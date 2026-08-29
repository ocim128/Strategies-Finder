import type { BacktestSettings } from "./types/strategies";
import type { RustCapabilities } from "./rust-engine-client";
import { isSameEventPolymarketExitMode } from "./polymarket-exit-mode";

export const RUST_NEXT_OPEN_CAPABILITY = "backtest.next_open.v1";
export const RUST_RISK_MAX_HOLD_CAPABILITY = "backtest.risk_max_hold.v1";
export const RUST_RISK_COOLDOWN_CAPABILITY = "backtest.risk_cooldown.v1";
export const RUST_EXIT_REASON_CAPABILITY = "backtest.exit_reason.v1";

export function hasRustCapability(capabilities: RustCapabilities | undefined, capability: string): boolean {
    return capabilities instanceof Set
        ? capabilities.has(capability)
        : Array.isArray(capabilities)
            ? capabilities.includes(capability)
            : false;
}

export function hasRequiredRustCapabilities(
    capabilities: RustCapabilities | undefined,
    settings: BacktestSettings,
): boolean {
    return getRequiredRustCapabilities(settings).every((capability) => hasRustCapability(capabilities, capability));
}

export function getRequiredRustCapabilities(settings: BacktestSettings): string[] {
    const required = new Set<string>();
    if (settings.executionModel === "next_open") {
        required.add(RUST_NEXT_OPEN_CAPABILITY);
        required.add(RUST_EXIT_REASON_CAPABILITY);
    }
    if (settings.riskMaxHoldEnabled === true && (settings.riskMaxHoldBars ?? 0) > 0) {
        required.add(RUST_RISK_MAX_HOLD_CAPABILITY);
        required.add(RUST_EXIT_REASON_CAPABILITY);
    }
    if (settings.riskCooldownEnabled === true && (settings.riskCooldownBars ?? 0) > 0) {
        required.add(RUST_RISK_COOLDOWN_CAPABILITY);
    }
    return [...required];
}

export function getTypescriptEngineRequirementReasons(
    settings: BacktestSettings,
    capabilities?: RustCapabilities,
): string[] {
    const executionModel = settings.executionModel ?? 'signal_close';
    const marketMode = settings.marketMode ?? 'all';

    const usesCombinedDirection =
        settings.tradeDirection === 'both'
        || settings.tradeDirection === 'both_no_flip'
        || settings.tradeDirection === 'combined';

    const usesNonAllMarketMode = marketMode !== 'all';

    const usesRiskMaxHold =
        settings.riskMaxHoldEnabled === true
        && (settings.riskMaxHoldBars ?? 0) > 0;
    const usesRiskMinHold =
        settings.riskMinHoldEnabled === true
        && (settings.riskMinHoldBars ?? 0) > 0;
    const usesRiskCooldown =
        settings.riskCooldownEnabled === true
        && (settings.riskCooldownBars ?? 0) > 0;
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
    const usesSlippage = (settings.slippageBps ?? 0) > 0;

    const reasons: string[] = [];
    if (executionModel !== 'signal_close') {
        if (executionModel === "next_open") {
            if (!hasRustCapability(capabilities, RUST_NEXT_OPEN_CAPABILITY)
                || !hasRustCapability(capabilities, RUST_EXIT_REASON_CAPABILITY)) {
                if (!reasons.includes('rust_capability_missing')) reasons.push('rust_capability_missing');
            }
        } else {
            reasons.push('execution model is not signal_close');
        }
    }
    if (usesCombinedDirection) reasons.push('combined trade direction is enabled');
    if (usesNonAllMarketMode) reasons.push('market-mode filtering is enabled');
    if (usesRiskMaxHold
        && (!hasRustCapability(capabilities, RUST_RISK_MAX_HOLD_CAPABILITY)
            || !hasRustCapability(capabilities, RUST_EXIT_REASON_CAPABILITY))) {
        if (!reasons.includes('rust_capability_missing')) reasons.push('rust_capability_missing');
    }
    if (usesRiskMinHold) reasons.push('minimum hold bars are enabled');
    if (usesRiskCooldown && !hasRustCapability(capabilities, RUST_RISK_COOLDOWN_CAPABILITY)) {
        if (!reasons.includes('rust_capability_missing')) reasons.push('rust_capability_missing');
    }
    if (usesAdaptivePercentageTakeProfit) reasons.push('adaptive take profit is enabled');
    if (usesMultiPosition) reasons.push('multiple open positions are enabled');
    if (usesSignalExitMode) reasons.push('same-event Polymarket exits are enabled');
    if (usesDisableSignalExits) reasons.push('signal exits are disabled');
    if (usesPolymarketProtection) reasons.push('Polymarket protection is enabled');
    if (usesPathExit) reasons.push('path exits are enabled');
    if (usesSlippage) reasons.push('slippage is enabled');
    return reasons;
}

export function requiresTypescriptEngine(settings: BacktestSettings, capabilities?: RustCapabilities): boolean {
    return getTypescriptEngineRequirementReasons(settings, capabilities).length > 0;
}

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
    "maxOpenTrades",
    "marketMode",
    "riskMinHoldBars",
    "riskMinHoldEnabled",
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

const CAPABILITY_GATED_KEYS = new Set([
    "executionModel",
    "riskMaxHoldBars",
    "riskMaxHoldEnabled",
    "riskCooldownBars",
    "riskCooldownEnabled",
]);

export function sanitizeBacktestSettingsForRust(
    settings: BacktestSettings,
    capabilities?: RustCapabilities,
): BacktestSettings {
    const canPreserveNextOpen = hasRustCapability(capabilities, RUST_NEXT_OPEN_CAPABILITY)
        && hasRustCapability(capabilities, RUST_EXIT_REASON_CAPABILITY);
    const canPreserveMaxHold = hasRustCapability(capabilities, RUST_RISK_MAX_HOLD_CAPABILITY)
        && hasRustCapability(capabilities, RUST_EXIT_REASON_CAPABILITY);
    const canPreserveRiskCooldown = hasRustCapability(capabilities, RUST_RISK_COOLDOWN_CAPABILITY);
    const sanitizedEntries = Object.entries(settings).filter(([key]) => {
        if (UNSUPPORTED_KEYS.has(key)) return false;
        if (!CAPABILITY_GATED_KEYS.has(key)) return true;
        if (key === "executionModel") return canPreserveNextOpen && settings.executionModel === "next_open";
        if (key === "riskMaxHoldBars" || key === "riskMaxHoldEnabled") return canPreserveMaxHold;
        return canPreserveRiskCooldown;
    });
    return Object.fromEntries(sanitizedEntries) as BacktestSettings;
}
