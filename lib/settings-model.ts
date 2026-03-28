/**
 * Headless settings schema, defaults, and normalization helpers.
 */

import type { ChartMode } from "./state";
import { parseInputNumber } from "./dom-input-readers";
import { readBoolean as readBooleanValue, readNumber as readNumberValue } from "./settings-parse-utils";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "./strategy-defaults";

import type { BacktestSettings, ExecutionModel, MarketMode, PercentageTakeProfitMode, TradeDirection, TradeFilterMode } from "./types/strategies";
import { isTradeSizingMode, type TradeSizingMode } from "./types/backtest";
import { CAPITAL_DEFAULTS, EFFECTIVE_BACKTEST_DEFAULTS, resolveBacktestSettingsFromRaw, SNAPSHOT_CONFIGS } from "./backtest-settings-resolver";
import { getLegacyCompatibleTradeFilterModeValue, getLegacyCompatibleTradeFilterToggleValue } from "./legacy-settings-compat";

// ============================================================================
// Types
// ============================================================================

type SnapshotConfigEntry = typeof SNAPSHOT_CONFIGS[number];
type SnapshotConfigProp<T, K extends PropertyKey> = T extends Record<K, infer V> ? V : never;
type SnapshotToggleKey = Extract<SnapshotConfigProp<SnapshotConfigEntry, "toggleKey">, string>;
type SnapshotMinKey = Extract<SnapshotConfigProp<SnapshotConfigEntry, "minKey">, string>;
type SnapshotMaxKey = Extract<SnapshotConfigProp<SnapshotConfigEntry, "maxKey">, string>;
type SnapshotFilterFields = Record<SnapshotToggleKey, boolean>
    & Record<SnapshotMinKey, number>
    & Record<SnapshotMaxKey, number>;

export interface BacktestSettingsData extends SnapshotFilterFields {
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

export type EnsembleSignalRecipeMode = "target_conflict_filter" | "primary_veto";

export interface EnsembleSignalRecipeMetrics {
    keptTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    retentionRate: number | null;
    coverage: number | null;
    overlapRate: number | null;
    winRateLift: number | null;
    wilsonLift: number | null;
}

export interface EnsembleSignalRecipe {
    name: string;
    createdAt: string;
    updatedAt: string;
    source: "ensemble_polymarket";
    symbol: string;
    interval: string;
    mode: EnsembleSignalRecipeMode;
    anchorConfigName: string;
    anchorConfig: StrategyConfig;
    componentConfigs: StrategyConfig[];
    primaryConfigName?: string;
    vetoConfigName?: string;
    notes: string;
    metrics: EnsembleSignalRecipeMetrics;
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

const SNAPSHOT_DEFAULTS = Object.fromEntries(
    SNAPSHOT_CONFIGS.flatMap((snapshot) => {
        const minKey = "minKey" in snapshot ? snapshot.minKey : undefined;
        return [
            [snapshot.toggleKey, false] as const,
            ...(minKey ? [[minKey, 0] as const] : []),
            [snapshot.maxKey, 0] as const,
        ];
    })
) as SnapshotFilterFields;

const {
    rsiPeriod: DEFAULT_CONFIRM_RSI_PERIOD,
    rsiBullish: DEFAULT_CONFIRM_RSI_BULLISH,
    rsiBearish: DEFAULT_CONFIRM_RSI_BEARISH,
    ...DEFAULT_SHARED_BACKTEST_SETTINGS
} = EFFECTIVE_BACKTEST_DEFAULTS;

export const DEFAULT_BACKTEST_SETTINGS: BacktestSettingsData = {
    ...DEFAULT_SHARED_BACKTEST_SETTINGS,
    ...SNAPSHOT_DEFAULTS,

    // Capital settings
    initialCapital: CAPITAL_DEFAULTS.initialCapital,
    positionSize: CAPITAL_DEFAULTS.positionSize,
    commission: CAPITAL_DEFAULTS.commission,
    fixedTradeToggle: true,
    sizingMode: "fixed",
    fixedTradeAmount: CAPITAL_DEFAULTS.fixedTradeAmount,
    useRustEngine: true,

    // Risk management
    riskSettingsToggle: false,
    stopLossEnabled: false,
    takeProfitEnabled: false,

    // Trade filter
    tradeFilterSettingsToggle: false,
    confirmRsiPeriod: DEFAULT_CONFIRM_RSI_PERIOD,
    confirmRsiBullish: DEFAULT_CONFIRM_RSI_BULLISH,
    confirmRsiBearish: DEFAULT_CONFIRM_RSI_BEARISH,
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
    return readBooleanValue(value, fallback);
}

function readNumber(value: unknown, fallback: number): number {
    return readNumberValue(value, fallback, { parseString: parseInputNumber });
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
    toggleKey: SnapshotToggleKey,
    minKey: SnapshotMinKey | null,
    maxKey: SnapshotMaxKey
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

    for (const snapshot of SNAPSHOT_CONFIGS) {
        const minKey: SnapshotMinKey | null = "minKey" in snapshot ? snapshot.minKey : null;
        normalizedRecord[snapshot.toggleKey] = resolveSnapshotToggle(
            source,
            snapshot.toggleKey,
            minKey,
            snapshot.maxKey
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

export function normalizeStoredEnsembleSignalRecipe(raw: unknown): EnsembleSignalRecipe | null {
    const source = toRecord(raw);
    if (!source) return null;

    const name = readString(source.name, "");
    if (!name) return null;

    const anchorConfig = normalizeStoredStrategyConfig(source.anchorConfig);
    if (!anchorConfig) return null;

    const componentConfigs = Array.isArray(source.componentConfigs)
        ? source.componentConfigs
            .map((config) => normalizeStoredStrategyConfig(config))
            .filter((config): config is StrategyConfig => config !== null)
        : [];
    if (componentConfigs.length === 0) {
        return null;
    }

    const mode = source.mode === "primary_veto" ? "primary_veto" : "target_conflict_filter";
    const metricsSource = toRecord(source.metrics) ?? {};
    const nowIso = new Date().toISOString();

    return {
        name,
        createdAt: readString(source.createdAt, nowIso),
        updatedAt: readString(source.updatedAt, readString(source.createdAt, nowIso)),
        source: "ensemble_polymarket",
        symbol: readString(source.symbol, DEFAULT_APP_SETTINGS.currentSymbol),
        interval: readString(source.interval, DEFAULT_APP_SETTINGS.currentInterval),
        mode,
        anchorConfigName: readString(source.anchorConfigName, anchorConfig.name),
        anchorConfig,
        componentConfigs,
        primaryConfigName: readString(source.primaryConfigName, ""),
        vetoConfigName: readString(source.vetoConfigName, ""),
        notes: readString(source.notes, ""),
        metrics: {
            keptTrades: Math.max(0, Math.floor(readNumber(metricsSource.keptTrades, 0))),
            wins: Math.max(0, Math.floor(readNumber(metricsSource.wins, 0))),
            losses: Math.max(0, Math.floor(readNumber(metricsSource.losses, 0))),
            winRate: readNumber(metricsSource.winRate, 0),
            retentionRate: metricsSource.retentionRate == null ? null : readNumber(metricsSource.retentionRate, 0),
            coverage: metricsSource.coverage == null ? null : readNumber(metricsSource.coverage, 0),
            overlapRate: metricsSource.overlapRate == null ? null : readNumber(metricsSource.overlapRate, 0),
            winRateLift: metricsSource.winRateLift == null ? null : readNumber(metricsSource.winRateLift, 0),
            wilsonLift: metricsSource.wilsonLift == null ? null : readNumber(metricsSource.wilsonLift, 0),
        },
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

