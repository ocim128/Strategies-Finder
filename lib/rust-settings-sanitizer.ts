import type { BacktestSettings } from "./types/strategies";

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
    "confirmationStrategies",
    "confirmationStrategyParams",
    "executionModel",
    "allowSameBarExit",
    "slippageBps",
    "marketMode",
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
