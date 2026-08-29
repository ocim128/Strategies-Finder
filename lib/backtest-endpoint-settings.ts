import { BacktestSettings } from "./types/strategies";

export const ENDPOINT_IGNORED_BACKTEST_SETTING_KEYS = [
    "allowSameBarExit",
    "partialTakeProfitAtR",
    "partialTakeProfitPercent",
    "breakEvenAtR",
    "breakEvenPercent",
    "timeStopBars",
    "riskWinStreakStopLossEnabled",
    "riskWinStreakStopLossAfterWins",
    "riskWinStreakStopLossPercent",
    "marketMode",
    "polymarketOutcomeInterval",
    "polymarketEntryDelayBars",
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
] as const;

const ENDPOINT_IGNORED_BACKTEST_SETTING_KEY_SET = new Set<string>(ENDPOINT_IGNORED_BACKTEST_SETTING_KEYS);

export function stripEndpointIgnoredBacktestSettings(
    settings: BacktestSettings | Record<string, unknown> | null | undefined
): Record<string, unknown> {
    const source = settings ?? {};
    return Object.fromEntries(
        Object.entries(source).filter(([key]) => !ENDPOINT_IGNORED_BACKTEST_SETTING_KEY_SET.has(key))
    );
}
