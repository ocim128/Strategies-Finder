/**
 * Headless settings schema, defaults, and normalization helpers.
 */

import type { ChartMode } from "./state";
import { parseInputNumber } from "./dom-input-readers";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "./strategy-defaults";

import type { BacktestSettings, ExecutionModel, MarketMode, PercentageTakeProfitMode, TradeDirection, TradeFilterMode } from "./types/strategies";
import { isTradeSizingMode, type TradeSizingMode } from "./types/backtest";
import { EFFECTIVE_BACKTEST_DEFAULTS, resolveBacktestSettingsFromRaw, SNAPSHOT_CONFIGS } from "./backtest-settings-resolver";
import { getLegacyCompatibleTradeFilterModeValue, getLegacyCompatibleTradeFilterToggleValue } from "./legacy-settings-compat";

// ============================================================================
// Types
// ============================================================================

export interface BacktestSettingsData {
    // Capital settings
    initialCapital: number;
    positionSize: number;
    commission: number;
    fixedTradeToggle: boolean;
    sizingMode: TradeSizingMode;
    fixedTradeAmount: number;

    // Engine preference
    useRustEngine: boolean;

    // Risk management
    riskSettingsToggle: boolean;
    riskMode: NonNullable<BacktestSettings['riskMode']>;
    atrPeriod: number;
    stopLossAtr: number;
    takeProfitAtr: number;
    trailingAtr: number;
    partialTakeProfitAtR: number;
    partialTakeProfitPercent: number;
    breakEvenAtR: number;
    breakEvenPercent: number;
    timeStopBars: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    takeProfitMode: PercentageTakeProfitMode;
    takeProfitMfeLookbackTrades: number;
    takeProfitMfePercentile: number;
    takeProfitShrinkageStrength: number;
    takeProfitMomentumRsiPeriod: number;
    takeProfitMomentumRsiPauseLevel: number;
    takeProfitMomentumDecayPercentPerBar: number;
    takeProfitVelocityFastBars: number;
    takeProfitVelocitySlowBars: number;
    takeProfitVelocityProgressPercent: number;
    takeProfitVelocityExpandMultiplier: number;
    takeProfitVelocityShrinkMultiplier: number;
    takeProfitAtrScaledMultiplier: number;
    takeProfitRangeScaledLookback: number;
    takeProfitRangeScaledFraction: number;
    takeProfitMedianBarLookback: number;
    takeProfitMedianBarMultiplier: number;
    takeProfitMfeBootstrapPercentile: number;
    stopLossEnabled: boolean;
    takeProfitEnabled: boolean;
    riskMaxHoldBars: number;
    riskMaxHoldEnabled: boolean;
    riskWinStreakStopLossEnabled: boolean;
    riskWinStreakStopLossAfterWins: number;
    riskWinStreakStopLossPercent: number;
    marketMode: MarketMode;

    // Trade direction
    tradeDirection: TradeDirection;
    invertSignals: boolean;
    flipAfterConsecutiveLosses: number;
    flipCooldownTrades: number;
    minTradesBeforeFirstFlip: number;

    // Trade filter
    tradeFilterSettingsToggle: boolean;
    tradeFilterMode: TradeFilterMode;
    /** @deprecated Legacy key retained for backward compatibility when loading old configs */
    entrySettingsToggle?: boolean;
    htfBiasEmaPeriod: number;
    executionTrendEmaPeriod: number;
    confirmLookback: number;
    trendPersistenceWindow: number;
    trendPersistenceMinBars: number;
    trendSlopeLookback: number;
    trendSlopeMinPercent: number;
    volumeSmaPeriod: number;
    volumeMultiplier: number;
    confirmRsiPeriod: number;
    confirmRsiBullish: number;
    confirmRsiBearish: number;
    snapshotAtrFilterToggle: boolean;
    snapshotAtrPercentMin: number;
    snapshotAtrPercentMax: number;
    snapshotVolumeFilterToggle: boolean;
    snapshotVolumeRatioMin: number;
    snapshotVolumeRatioMax: number;
    snapshotAdxFilterToggle: boolean;
    snapshotAdxMin: number;
    snapshotAdxMax: number;
    snapshotEmaFilterToggle: boolean;
    snapshotEmaDistanceMin: number;
    snapshotEmaDistanceMax: number;
    snapshotRsiFilterToggle: boolean;
    snapshotRsiMin: number;
    snapshotRsiMax: number;
    snapshotPriceRangePosFilterToggle: boolean;
    snapshotPriceRangePosMin: number;
    snapshotPriceRangePosMax: number;
    snapshotBarsFromHighFilterToggle: boolean;
    snapshotBarsFromHighMax: number;
    snapshotBarsFromLowFilterToggle: boolean;
    snapshotBarsFromLowMax: number;
    snapshotTrendEfficiencyFilterToggle: boolean;
    snapshotTrendEfficiencyMin: number;
    snapshotTrendEfficiencyMax: number;
    snapshotAtrRegimeFilterToggle: boolean;
    snapshotAtrRegimeRatioMin: number;
    snapshotAtrRegimeRatioMax: number;
    snapshotBodyPercentFilterToggle: boolean;
    snapshotBodyPercentMin: number;
    snapshotBodyPercentMax: number;
    snapshotWickSkewFilterToggle: boolean;
    snapshotWickSkewMin: number;
    snapshotWickSkewMax: number;
    snapshotVolumeTrendFilterToggle: boolean;
    snapshotVolumeTrendMin: number;
    snapshotVolumeTrendMax: number;
    snapshotVolumeBurstFilterToggle: boolean;
    snapshotVolumeBurstMin: number;
    snapshotVolumeBurstMax: number;
    snapshotVolumePriceDivergenceFilterToggle: boolean;
    snapshotVolumePriceDivergenceMin: number;
    snapshotVolumePriceDivergenceMax: number;
    snapshotVolumeConsistencyFilterToggle: boolean;
    snapshotVolumeConsistencyMin: number;
    snapshotVolumeConsistencyMax: number;
    snapshotCloseLocationFilterToggle: boolean;
    snapshotCloseLocationMin: number;
    snapshotCloseLocationMax: number;
    snapshotOppositeWickFilterToggle: boolean;
    snapshotOppositeWickMin: number;
    snapshotOppositeWickMax: number;
    snapshotRangeAtrFilterToggle: boolean;
    snapshotRangeAtrMultipleMin: number;
    snapshotRangeAtrMultipleMax: number;
    snapshotMomentumFilterToggle: boolean;
    snapshotMomentumConsistencyMin: number;
    snapshotMomentumConsistencyMax: number;
    snapshotBreakQualityFilterToggle: boolean;
    snapshotBreakQualityMin: number;
    snapshotBreakQualityMax: number;
    snapshotTf60PerfFilterToggle: boolean;
    snapshotTf60PerfMin: number;
    snapshotTf60PerfMax: number;
    snapshotTf90PerfFilterToggle: boolean;
    snapshotTf90PerfMin: number;
    snapshotTf90PerfMax: number;
    snapshotTf120PerfFilterToggle: boolean;
    snapshotTf120PerfMin: number;
    snapshotTf120PerfMax: number;
    snapshotTf480PerfFilterToggle: boolean;
    snapshotTf480PerfMin: number;
    snapshotTf480PerfMax: number;
    snapshotTfConfluencePerfFilterToggle: boolean;
    snapshotTfConfluencePerfMin: number;
    snapshotTfConfluencePerfMax: number;
    snapshotEntryQualityScoreFilterToggle: boolean;
    snapshotEntryQualityScoreMin: number;
    snapshotEntryQualityScoreMax: number;

    // Execution realism
    executionModel: ExecutionModel;
    allowSameBarExit: boolean;
    slippageBps: number;
    maxOpenTrades: number;
    warmUpEntryEnabled: boolean;
    strategyTimeframeEnabled: boolean;
    strategyTimeframeMinutes: number;
    twoHourCloseParity: 'odd' | 'even' | 'both';
}

export interface StrategyConfig {
    name: string;
    createdAt: string;
    updatedAt: string;
    strategyKey: string;
    strategyParams: Record<string, number>;
    backtestSettings: BacktestSettingsData;
}

export interface AppSettings {
    currentSymbol: string;
    currentInterval: string;
    isDarkTheme: boolean;
    currentStrategyKey: string;
    chartMode: ChartMode;
    backtestSettings: BacktestSettingsData;
}

// ============================================================================
// Default Values
// ============================================================================

export const DEFAULT_BACKTEST_SETTINGS: BacktestSettingsData = {
    // Capital settings
    initialCapital: 10000,
    positionSize: 100,
    commission: 0.1,
    fixedTradeToggle: true,
    sizingMode: "fixed",
    fixedTradeAmount: 1000,
    useRustEngine: true,

    // Risk management
    riskSettingsToggle: false,
    riskMode: EFFECTIVE_BACKTEST_DEFAULTS.riskMode,
    atrPeriod: EFFECTIVE_BACKTEST_DEFAULTS.atrPeriod,
    stopLossAtr: EFFECTIVE_BACKTEST_DEFAULTS.stopLossAtr,
    takeProfitAtr: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAtr,
    trailingAtr: EFFECTIVE_BACKTEST_DEFAULTS.trailingAtr,
    partialTakeProfitAtR: EFFECTIVE_BACKTEST_DEFAULTS.partialTakeProfitAtR,
    partialTakeProfitPercent: EFFECTIVE_BACKTEST_DEFAULTS.partialTakeProfitPercent,
    breakEvenAtR: EFFECTIVE_BACKTEST_DEFAULTS.breakEvenAtR,
    breakEvenPercent: EFFECTIVE_BACKTEST_DEFAULTS.breakEvenPercent,
    timeStopBars: EFFECTIVE_BACKTEST_DEFAULTS.timeStopBars,
    stopLossPercent: EFFECTIVE_BACKTEST_DEFAULTS.stopLossPercent,
    takeProfitPercent: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitPercent,
    takeProfitMode: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMode,
    takeProfitMfeLookbackTrades: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeLookbackTrades,
    takeProfitMfePercentile: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfePercentile,
    takeProfitShrinkageStrength: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitShrinkageStrength,
    takeProfitMomentumRsiPeriod: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumRsiPeriod,
    takeProfitMomentumRsiPauseLevel: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumRsiPauseLevel,
    takeProfitMomentumDecayPercentPerBar: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumDecayPercentPerBar,
    takeProfitVelocityFastBars: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityFastBars,
    takeProfitVelocitySlowBars: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocitySlowBars,
    takeProfitVelocityProgressPercent: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityProgressPercent,
    takeProfitVelocityExpandMultiplier: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityExpandMultiplier,
    takeProfitVelocityShrinkMultiplier: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityShrinkMultiplier,
    takeProfitAtrScaledMultiplier: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAtrScaledMultiplier,
    takeProfitRangeScaledLookback: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitRangeScaledLookback,
    takeProfitRangeScaledFraction: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitRangeScaledFraction,
    takeProfitMedianBarLookback: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMedianBarLookback,
    takeProfitMedianBarMultiplier: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMedianBarMultiplier,
    takeProfitMfeBootstrapPercentile: EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeBootstrapPercentile,
    stopLossEnabled: false,
    takeProfitEnabled: false,
    riskMaxHoldBars: EFFECTIVE_BACKTEST_DEFAULTS.riskMaxHoldBars,
    riskMaxHoldEnabled: EFFECTIVE_BACKTEST_DEFAULTS.riskMaxHoldEnabled,
    riskWinStreakStopLossEnabled: EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossEnabled,
    riskWinStreakStopLossAfterWins: EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossAfterWins,
    riskWinStreakStopLossPercent: EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossPercent,
    marketMode: EFFECTIVE_BACKTEST_DEFAULTS.marketMode,

    // Trade direction
    tradeDirection: EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection,
    invertSignals: EFFECTIVE_BACKTEST_DEFAULTS.invertSignals,
    flipAfterConsecutiveLosses: EFFECTIVE_BACKTEST_DEFAULTS.flipAfterConsecutiveLosses,
    flipCooldownTrades: EFFECTIVE_BACKTEST_DEFAULTS.flipCooldownTrades,
    minTradesBeforeFirstFlip: EFFECTIVE_BACKTEST_DEFAULTS.minTradesBeforeFirstFlip,

    // Trade filter
    tradeFilterSettingsToggle: false,
    tradeFilterMode: EFFECTIVE_BACKTEST_DEFAULTS.tradeFilterMode,
    htfBiasEmaPeriod: EFFECTIVE_BACKTEST_DEFAULTS.htfBiasEmaPeriod,
    executionTrendEmaPeriod: EFFECTIVE_BACKTEST_DEFAULTS.executionTrendEmaPeriod,
    confirmLookback: EFFECTIVE_BACKTEST_DEFAULTS.confirmLookback,
    trendPersistenceWindow: EFFECTIVE_BACKTEST_DEFAULTS.trendPersistenceWindow,
    trendPersistenceMinBars: EFFECTIVE_BACKTEST_DEFAULTS.trendPersistenceMinBars,
    trendSlopeLookback: EFFECTIVE_BACKTEST_DEFAULTS.trendSlopeLookback,
    trendSlopeMinPercent: EFFECTIVE_BACKTEST_DEFAULTS.trendSlopeMinPercent,
    volumeSmaPeriod: EFFECTIVE_BACKTEST_DEFAULTS.volumeSmaPeriod,
    volumeMultiplier: EFFECTIVE_BACKTEST_DEFAULTS.volumeMultiplier,
    confirmRsiPeriod: EFFECTIVE_BACKTEST_DEFAULTS.rsiPeriod,
    confirmRsiBullish: EFFECTIVE_BACKTEST_DEFAULTS.rsiBullish,
    confirmRsiBearish: EFFECTIVE_BACKTEST_DEFAULTS.rsiBearish,
    snapshotAtrFilterToggle: false,
    snapshotAtrPercentMin: 0,
    snapshotAtrPercentMax: 0,
    snapshotVolumeFilterToggle: false,
    snapshotVolumeRatioMin: 0,
    snapshotVolumeRatioMax: 0,
    snapshotAdxFilterToggle: false,
    snapshotAdxMin: 0,
    snapshotAdxMax: 0,
    snapshotEmaFilterToggle: false,
    snapshotEmaDistanceMin: 0,
    snapshotEmaDistanceMax: 0,
    snapshotRsiFilterToggle: false,
    snapshotRsiMin: 0,
    snapshotRsiMax: 0,
    snapshotPriceRangePosFilterToggle: false,
    snapshotPriceRangePosMin: 0,
    snapshotPriceRangePosMax: 0,
    snapshotBarsFromHighFilterToggle: false,
    snapshotBarsFromHighMax: 0,
    snapshotBarsFromLowFilterToggle: false,
    snapshotBarsFromLowMax: 0,
    snapshotTrendEfficiencyFilterToggle: false,
    snapshotTrendEfficiencyMin: 0,
    snapshotTrendEfficiencyMax: 0,
    snapshotAtrRegimeFilterToggle: false,
    snapshotAtrRegimeRatioMin: 0,
    snapshotAtrRegimeRatioMax: 0,
    snapshotBodyPercentFilterToggle: false,
    snapshotBodyPercentMin: 0,
    snapshotBodyPercentMax: 0,
    snapshotWickSkewFilterToggle: false,
    snapshotWickSkewMin: 0,
    snapshotWickSkewMax: 0,
    snapshotVolumeTrendFilterToggle: false,
    snapshotVolumeTrendMin: 0,
    snapshotVolumeTrendMax: 0,
    snapshotVolumeBurstFilterToggle: false,
    snapshotVolumeBurstMin: 0,
    snapshotVolumeBurstMax: 0,
    snapshotVolumePriceDivergenceFilterToggle: false,
    snapshotVolumePriceDivergenceMin: 0,
    snapshotVolumePriceDivergenceMax: 0,
    snapshotVolumeConsistencyFilterToggle: false,
    snapshotVolumeConsistencyMin: 0,
    snapshotVolumeConsistencyMax: 0,
    snapshotCloseLocationFilterToggle: false,
    snapshotCloseLocationMin: 0,
    snapshotCloseLocationMax: 0,
    snapshotOppositeWickFilterToggle: false,
    snapshotOppositeWickMin: 0,
    snapshotOppositeWickMax: 0,
    snapshotRangeAtrFilterToggle: false,
    snapshotRangeAtrMultipleMin: 0,
    snapshotRangeAtrMultipleMax: 0,
    snapshotMomentumFilterToggle: false,
    snapshotMomentumConsistencyMin: 0,
    snapshotMomentumConsistencyMax: 0,
    snapshotBreakQualityFilterToggle: false,
    snapshotBreakQualityMin: 0,
    snapshotBreakQualityMax: 0,
    snapshotTf60PerfFilterToggle: false,
    snapshotTf60PerfMin: 0,
    snapshotTf60PerfMax: 0,
    snapshotTf90PerfFilterToggle: false,
    snapshotTf90PerfMin: 0,
    snapshotTf90PerfMax: 0,
    snapshotTf120PerfFilterToggle: false,
    snapshotTf120PerfMin: 0,
    snapshotTf120PerfMax: 0,
    snapshotTf480PerfFilterToggle: false,
    snapshotTf480PerfMin: 0,
    snapshotTf480PerfMax: 0,
    snapshotTfConfluencePerfFilterToggle: false,
    snapshotTfConfluencePerfMin: 0,
    snapshotTfConfluencePerfMax: 0,
    snapshotEntryQualityScoreFilterToggle: false,
    snapshotEntryQualityScoreMin: 0,
    snapshotEntryQualityScoreMax: 0,

    // Execution realism
    executionModel: EFFECTIVE_BACKTEST_DEFAULTS.executionModel,
    allowSameBarExit: EFFECTIVE_BACKTEST_DEFAULTS.allowSameBarExit,
    slippageBps: EFFECTIVE_BACKTEST_DEFAULTS.slippageBps,
    maxOpenTrades: EFFECTIVE_BACKTEST_DEFAULTS.maxOpenTrades,
    warmUpEntryEnabled: EFFECTIVE_BACKTEST_DEFAULTS.warmUpEntryEnabled,
    strategyTimeframeEnabled: EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeEnabled,
    strategyTimeframeMinutes: EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeMinutes,
    twoHourCloseParity: EFFECTIVE_BACKTEST_DEFAULTS.twoHourCloseParity,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
    currentSymbol: 'ETHUSDT',
    currentInterval: '1d',
    isDarkTheme: true,
    currentStrategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
    chartMode: 'candlestick',
    backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
};

function toRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function readString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
    if (typeof value !== 'string') return fallback;

    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function readNumber(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = parseInputNumber(value);
        if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function normalizeStrategyParams(raw: unknown): Record<string, number> {
    const source = toRecord(raw);
    if (!source) return {};

    const normalized: Record<string, number> = {};
    Object.entries(source).forEach(([key, value]) => {
        const parsed = readNumber(value, Number.NaN);
        if (Number.isFinite(parsed)) {
            normalized[key] = parsed;
        }
    });
    return normalized;
}

function resolveSnapshotToggle(
    raw: Record<string, unknown>,
    toggleKey: keyof BacktestSettingsData,
    minKey: keyof BacktestSettingsData | null,
    maxKey: keyof BacktestSettingsData
): boolean {
    const explicit = raw[toggleKey as string];
    if (explicit !== undefined) {
        return readBoolean(explicit, false);
    }

    const minValue = minKey ? readNumber(raw[minKey as string], 0) : 0;
    const maxValue = readNumber(raw[maxKey as string], 0);
    return minValue !== 0 || maxValue !== 0;
}

const UI_ONLY_BACKTEST_SETTING_KEYS = new Set<keyof BacktestSettingsData>([
    'initialCapital',
    'positionSize',
    'commission',
    'fixedTradeToggle',
    'sizingMode',
    'fixedTradeAmount',
    'useRustEngine',
    'riskSettingsToggle',
    'tradeFilterSettingsToggle',
    'entrySettingsToggle',
]);

const RESOLVED_TO_STORED_SETTING_KEY_MAP: Partial<Record<keyof BacktestSettingsData, keyof BacktestSettings>> = {
    confirmRsiPeriod: 'rsiPeriod',
    confirmRsiBullish: 'rsiBullish',
    confirmRsiBearish: 'rsiBearish',
};

export function normalizeStoredBacktestSettings(raw: unknown): BacktestSettingsData {
    const source = toRecord(raw);
    if (!source) {
        return { ...DEFAULT_BACKTEST_SETTINGS };
    }

    const resolved = resolveBacktestSettingsFromRaw(source as BacktestSettings);
    const fixedTradeToggle = readBoolean(source.fixedTradeToggle, DEFAULT_BACKTEST_SETTINGS.fixedTradeToggle);
    const sizingMode = resolveTradeSizingModeValue(
        source.sizingMode,
        DEFAULT_BACKTEST_SETTINGS,
        fixedTradeToggle ? "fixed" : "percent"
    );

    const normalized: BacktestSettingsData = {
        ...DEFAULT_BACKTEST_SETTINGS,
    };
    const normalizedRecord = normalized as unknown as Record<string, unknown>;

    for (const key of Object.keys(DEFAULT_BACKTEST_SETTINGS) as (keyof BacktestSettingsData)[]) {
        if (UI_ONLY_BACKTEST_SETTING_KEYS.has(key)) {
            continue;
        }

        const resolvedKey = RESOLVED_TO_STORED_SETTING_KEY_MAP[key] ?? key;
        const resolvedValue = (resolved as Record<string, unknown>)[resolvedKey as string];
        if (resolvedValue === undefined) {
            continue;
        }

        normalizedRecord[key as string] = key === 'takeProfitMode'
            ? resolveTakeProfitModeValue(resolvedValue, DEFAULT_BACKTEST_SETTINGS)
            : resolvedValue;
    }

    normalized.initialCapital = readNumber(source.initialCapital, DEFAULT_BACKTEST_SETTINGS.initialCapital);
    normalized.positionSize = readNumber(source.positionSize, DEFAULT_BACKTEST_SETTINGS.positionSize);
    normalized.commission = readNumber(source.commission, DEFAULT_BACKTEST_SETTINGS.commission);
    normalized.fixedTradeToggle = fixedTradeToggle;
    normalized.sizingMode = sizingMode;
    normalized.fixedTradeAmount = readNumber(source.fixedTradeAmount, DEFAULT_BACKTEST_SETTINGS.fixedTradeAmount);
    normalized.useRustEngine = readBoolean(source.useRustEngine, DEFAULT_BACKTEST_SETTINGS.useRustEngine);
    normalized.riskSettingsToggle = readBoolean(source.riskSettingsToggle, DEFAULT_BACKTEST_SETTINGS.riskSettingsToggle);
    normalized.tradeFilterSettingsToggle = readBoolean(
        getLegacyCompatibleTradeFilterToggleValue(source),
        resolved.tradeFilterMode !== 'none'
    );
    normalized.entrySettingsToggle = source.entrySettingsToggle === undefined
        ? undefined
        : readBoolean(source.entrySettingsToggle, false);

    for (const { toggleKey, minKey, maxKey } of SNAPSHOT_CONFIGS) {
        normalizedRecord[toggleKey] = resolveSnapshotToggle(
            source,
            toggleKey as keyof BacktestSettingsData,
            (minKey ?? null) as keyof BacktestSettingsData | null,
            maxKey as keyof BacktestSettingsData
        );
    }

    return normalized;
}

export function normalizeStoredAppSettings(raw: unknown): AppSettings | null {
    const source = toRecord(raw);
    if (!source) return null;

    const chartMode = source.chartMode === 'heikin-ashi' ? 'heikin-ashi' : DEFAULT_APP_SETTINGS.chartMode;

    return {
        currentSymbol: readString(source.currentSymbol, DEFAULT_APP_SETTINGS.currentSymbol),
        currentInterval: readString(source.currentInterval, DEFAULT_APP_SETTINGS.currentInterval),
        isDarkTheme: readBoolean(source.isDarkTheme, DEFAULT_APP_SETTINGS.isDarkTheme),
        currentStrategyKey: readString(source.currentStrategyKey, DEFAULT_APP_SETTINGS.currentStrategyKey),
        chartMode,
        backtestSettings: normalizeStoredBacktestSettings(source.backtestSettings),
    };
}

export function normalizeStoredStrategyConfig(raw: unknown): StrategyConfig | null {
    const source = toRecord(raw);
    if (!source) return null;

    const name = readString(source.name, '');
    if (!name) return null;

    const nowIso = new Date().toISOString();
    return {
        name,
        createdAt: readString(source.createdAt, nowIso),
        updatedAt: readString(source.updatedAt, readString(source.createdAt, nowIso)),
        strategyKey: readString(source.strategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY),
        strategyParams: normalizeStrategyParams(source.strategyParams),
        backtestSettings: normalizeStoredBacktestSettings(source.backtestSettings),
    };
}

export function resolveTradeDirection(
    settings: Partial<BacktestSettingsData>,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): TradeDirection {
    if (
        settings.tradeDirection === "long"
        || settings.tradeDirection === "short"
        || settings.tradeDirection === "both"
        || settings.tradeDirection === "both_flip_loss_2"
        || settings.tradeDirection === "combined"
    ) {
        return settings.tradeDirection;
    }

    const legacyShortMode = (settings as { shortModeToggle?: boolean }).shortModeToggle;
    if (legacyShortMode === true) return "short";
    if (legacyShortMode === false) return "long";

    return defaults.tradeDirection;
}

export function resolveMarketMode(
    settings: Partial<BacktestSettingsData>,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): MarketMode {
    if (settings.marketMode === "all" || settings.marketMode === "uptrend" || settings.marketMode === "downtrend" || settings.marketMode === "sideway") {
        return settings.marketMode;
    }
    return defaults.marketMode;
}

export function resolveRiskModeValue(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): NonNullable<BacktestSettings["riskMode"]> {
    if (value === "simple" || value === "advanced" || value === "percentage") {
        return value;
    }
    return defaults.riskMode;
}

export function resolveTakeProfitModeValue(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): PercentageTakeProfitMode {
    if (
        value === "fixed"
        || value === "shrinkage"
        || value === "momentum_gated"
        || value === "velocity"
        || value === "atr_scaled"
        || value === "range_scaled"
        || value === "median_bar"
        || value === "mfe_bootstrap"
    ) {
        return value;
    }
    return defaults.takeProfitMode;
}

export function resolveTradeSizingModeValue(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS,
    fallback?: TradeSizingMode
): TradeSizingMode {
    if (isTradeSizingMode(value)) {
        return value;
    }
    if (
        value === "smart_fixed"
        || value === "smart_fixed_dd_ladder"
        || value === "smart_fixed_loss_cooldown"
        || value === "smart_fixed_entry_quality"
        || value === "smart_fixed_recovery_ramp"
    ) {
        return "smart_fixed_velocity_memory";
    }
    if (
        value === "smart_fixed_early_heat_filter"
        || value === "smart_fixed_adverse_memory"
        || value === "smart_fixed_mfe_ancestor"
        || value === "smart_fixed_tp_distance_fit"
    ) {
        return "smart_fixed_quality_x_velocity";
    }
    return fallback ?? defaults.sizingMode;
}

export function resolveTradeFilterModeValue(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): TradeFilterMode {
    if (
        value === "none"
        || value === "close"
        || value === "volume"
        || value === "rsi"
        || value === "trend"
        || value === "adx"
        || value === "htf_drift"
        || value === "trend_htf_bias"
        || value === "trend_exec_alignment"
        || value === "trend_persistence"
        || value === "trend_slope_strength"
        || value === "trend_no_chase"
        || value === "trend_hysteresis"
        || value === "trend_mtf_stack"
    ) {
        return value;
    }
    return defaults.tradeFilterMode;
}

export function resolveExecutionModelValue(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): ExecutionModel {
    if (value === "signal_close" || value === "next_open" || value === "next_close") {
        return value;
    }
    return defaults.executionModel;
}

export function resolveTradeFilterMode(
    settings: Partial<BacktestSettingsData> & { entryConfirmation?: string },
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): TradeFilterMode {
    return resolveTradeFilterModeValue(getLegacyCompatibleTradeFilterModeValue(settings), defaults);
}

export function resolveTwoHourCloseParity(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): "odd" | "even" | "both" {
    if (value === "even" || value === "both" || value === "odd") {
        return value;
    }
    return defaults.twoHourCloseParity;
}

export function resolveTradeFilterToggle(
    settings: Partial<BacktestSettingsData>,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): boolean {
    if (typeof settings.tradeFilterSettingsToggle === "boolean") {
        return settings.tradeFilterSettingsToggle;
    }
    if (typeof settings.entrySettingsToggle === "boolean") {
        return settings.entrySettingsToggle;
    }
    return defaults.tradeFilterSettingsToggle;
}

