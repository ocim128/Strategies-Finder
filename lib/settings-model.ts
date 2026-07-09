/**
 * Headless settings schema, defaults, and normalization helpers.
 */

import type { BinanceMarketType } from "./binance-market";
import { resolveBinanceMarketType } from "./binance-market";
import type { ChartMode } from "./state";
import { parseInputNumber } from "./dom-input-readers";
import { readBoolean as readBooleanValue, readNumber as readNumberValue } from "./settings-parse-utils";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "./strategy-defaults";
import { ADVANCED_SIZING_DEFAULTS, coerceAdvancedSizingFieldValue } from "./advanced-sizing-settings";
import { coerceAdaptiveTakeProfitFieldValue, resolveTakeProfitMode } from "./take-profit-settings";
import { clampPolymarketBacktestSlippageCents } from "./polymarket-backtest-slippage";
import type { PolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";
import type { PolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import type { PolymarketExitMode } from "./polymarket-exit-mode";
import {
    resolvePolymarketPostSignalLimitSettingFields,
    type PolymarketLimitEntryPriceMode,
    type PolymarketLimitExitPriceMode,
} from "./polymarket-post-signal-limit-entry";

import type { BacktestSettings, ConfirmationMode, ExecutionModel, MarketMode, PercentageTakeProfitMode, StrategyParams, TradeDirection, PathExitMode } from "./types/strategies";
import { isTradeSizingMode, type AdvancedSizingSettings, type TradeSizingMode } from "./types/backtest";
import {
    CAPITAL_DEFAULTS,
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw,
} from "./backtest-settings-resolver";

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
    kellyFraction: NonNullable<AdvancedSizingSettings["kellyFraction"]>;
    kellyWinRateCap: number;
    kellyProfitFactorCap: number;
    volTargetAnnual: number;
    volLookbackBars: number;
    volScalingMethod: NonNullable<AdvancedSizingSettings["volScalingMethod"]>;
    riskParityLookback: number;
    riskParityMethod: NonNullable<AdvancedSizingSettings["riskParityMethod"]>;
    martingaleMultiplier: number;
    martingaleMaxSequence: number;
    martingaleResetOnWin: boolean;
    martingaleResetOnLoss: boolean;
    martingaleBaseSize: NonNullable<AdvancedSizingSettings["martingaleBaseSize"]>;
    optimalFLookback: number;
    optimalFBootstrapSamples: number;
    secureFConfidence: number;
    secureFMethod: NonNullable<AdvancedSizingSettings["secureFMethod"]>;

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
    takeProfitMfeBootstrapPercentile: number;
    takeProfitAdaptiveLookbackTrades: number;
    takeProfitAdaptiveRecentWindow: number;
    takeProfitAdaptiveMinMultiplier: number;
    takeProfitAdaptiveMaxMultiplier: number;
    takeProfitAdaptiveGridSteps: number;
    takeProfitAdaptiveRegimeBlend: number;
    takeProfitAdaptiveIcScale: number;
    stopLossEnabled: boolean;
    takeProfitEnabled: boolean;
    riskMinHoldBars: number;
    riskMinHoldEnabled: boolean;
    riskMaxHoldBars: number;
    riskMaxHoldEnabled: boolean;
    riskWinStreakStopLossEnabled: boolean;
    riskWinStreakStopLossAfterWins: number;
    riskWinStreakStopLossPercent: number;
    disableSignalExits: boolean;
    /** When true and disableSignalExits is on, use exitStrategyKey's signals as close-only exits. */
    exitStrategyOverrideEnabled: boolean;
    /** Registry key of the strategy whose signals act as close-only exits when override is enabled. */
    exitStrategyKey: string;
    /** Params for the exit strategy referenced by exitStrategyKey. */
    exitStrategyParams: Record<string, number>;
    pathExitEnabled: boolean;
    pathExitMode: PathExitMode;
    pathExitMinBars: number;
    pathExitMinMfePercent: number;
    pathExitGivebackPercent: number;
    pathExitLookbackBars: number;
    pathExitThreshold: number;
    pathExitMinSamples: number;
    pathExitHorizonBars: number;
    marketMode: MarketMode;

    // Trade direction
    tradeDirection: TradeDirection;
    invertSignals: boolean;
    flipAfterConsecutiveLosses: number;
    flipCooldownTrades: number;
    minTradesBeforeFirstFlip: number;

    // Signal confirmation
    confirmationStrategiesToggle: boolean;
    confirmationStrategies: string[];
    confirmationMode: ConfirmationMode;
    confirmationWindowBars: number;
    confirmationStrategyParams: Record<string, StrategyParams>;

    // Execution realism
    executionModel: ExecutionModel;
    allowSameBarExit: boolean;
    slippageBps: number;
    maxOpenTrades: number;
    strategyTimeframeEnabled: boolean;
    strategyTimeframeMinutes: number;
    polymarketAnnotationEnabled: boolean;
    polymarketOutcomeSymbol: string;
    polymarketOutcomeInterval: PolymarketOutcomeInterval;
    polymarketEntrySelectionMode: PolymarketEntrySelectionMode;
    polymarketEntryOffset: number;
    polymarketEntryDelayBars: number;
    polymarketEntryPriceFilterCents: number;
    polymarketBacktestSlippageCents: number;
    polymarketEntryCutoffEnabled: boolean;
    polymarketEntryCutoffSeconds: number;
    polymarketExitMode: PolymarketExitMode;
    polymarketSignalExitAllowMultipleTradesPerEvent: boolean;
    polymarketPostSignalLimitEntryEnabled: boolean;
    polymarketPostSignalLimitEntryMode: PolymarketLimitEntryPriceMode;
    polymarketPostSignalLimitEntryPriceCents: number;
    polymarketPostSignalLimitEntryOffsetCents: number;
    polymarketPostSignalLimitExitEnabled: boolean;
    polymarketPostSignalLimitExitMode: PolymarketLimitExitPriceMode;
    polymarketPostSignalLimitExitPriceCents: number;
    polymarketPostSignalLimitExitOffsetCents: number;
    polymarketProtectionTakeProfitEnabled: boolean;
    polymarketProtectionTakeProfitCents: number;
    polymarketProtectionStopLossEnabled: boolean;
    polymarketProtectionStopLossCents: number;
    /** Resolved secondary symbol for cross-symbol strategies. Empty string means use strategy default. */
    crossSymbolSecondary: string;

    /**
     * Where the Batch Backtest tab runs its heavy per-symbol workload.
     * - "server": the Vite dev server (Node) — keeps the browser tab bounded
     *   regardless of pair count. Default since moving the workload off-browser
     *   is the whole point of the server-side path.
     * - "browser": the original in-tab path. Retained as a fallback for
     *   environments without the dev server (e.g. `vite preview`).
     *
     * UI-only: not consumed by Rust or worker surfaces.
     */
    batchExecutionMode: "server" | "browser";

    /**
     * Where the Finder Symbol Universe runs its heavy multi-symbol evaluation.
     * - "server": the Vite dev server (Node) — keeps the browser tab bounded
     *   for large universes (N full OHLCV datasets held for the whole loop).
     *   Default, matching batchExecutionMode's rationale.
     * - "browser": the original in-tab path. Retained as a fallback for
     *   environments without the dev server.
     *
     * UI-only: not consumed by Rust or worker surfaces. Applies to the
     * Symbol Universe scope only; the current-chart Finder is always in-tab.
     */
    finderUniverseExecutionMode: "server" | "browser";
}

export interface StrategyConfig {
    name: string;
    createdAt: string;
    updatedAt: string;
    symbol?: string;
    interval?: string;
    strategyKey: string;
    strategyParams: Record<string, number>;
    backtestSettings: BacktestSettingsData;
    syntheticPair?: {
        baseSymbol: string;
        quoteSymbol: string;
    };
}

export type EnsembleSignalRecipeMode =
    | "target_conflict_filter"
    | "primary_veto"
    | "secondary_override"
    | "best_side_owner";

export type EnsembleSignalRecipeDirectionSlice = "all" | "long_only" | "short_only";

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
    directionSlice: EnsembleSignalRecipeDirectionSlice;
    anchorConfigName: string;
    anchorConfig: StrategyConfig;
    componentConfigs: StrategyConfig[];
    primaryConfigName?: string;
    secondaryConfigName?: string;
    vetoConfigName?: string;
    longOwnerConfigName?: string;
    shortOwnerConfigName?: string;
    notes: string;
    metrics: EnsembleSignalRecipeMetrics;
}

export interface AppSettings {
    currentSymbol: string;
    currentInterval: string;
    binanceMarketType: BinanceMarketType;
    isDarkTheme: boolean;
    currentStrategyKey: string;
    chartMode: ChartMode;
    backtestSettings: BacktestSettingsData;
}

// ============================================================================
// Default Values
// ============================================================================

export const DEFAULT_BACKTEST_SETTINGS: BacktestSettingsData = {
    ...EFFECTIVE_BACKTEST_DEFAULTS,

    // Capital settings
    initialCapital: CAPITAL_DEFAULTS.initialCapital,
    positionSize: CAPITAL_DEFAULTS.positionSize,
    commission: CAPITAL_DEFAULTS.commission,
    fixedTradeToggle: true,
    sizingMode: "fixed",
    fixedTradeAmount: CAPITAL_DEFAULTS.fixedTradeAmount,
    ...ADVANCED_SIZING_DEFAULTS,
    useRustEngine: false,

    // Risk management
    riskSettingsToggle: false,
    stopLossEnabled: false,
    takeProfitEnabled: false,

    // Exit strategy override
    exitStrategyOverrideEnabled: false,
    exitStrategyKey: "",
    exitStrategyParams: {},

    // Path-dependent exits
    pathExitEnabled: false,
    pathExitMode: "off",
    pathExitMinBars: 10,
    pathExitMinMfePercent: 2.0,
    pathExitGivebackPercent: 25,
    pathExitLookbackBars: 20,
    pathExitThreshold: 0,
    pathExitMinSamples: 30,
    pathExitHorizonBars: 50,

    // Cross-symbol
    crossSymbolSecondary: "",

    // Batch execution mode (server vs browser). Server is the default; see
    // field doc on BacktestSettingsData for rationale.
    batchExecutionMode: "server",

    // Finder Symbol Universe execution mode. Server is the default, matching
    // batchExecutionMode (off-browser is the whole point of the server path).
    finderUniverseExecutionMode: "server",

    // Signal confirmation
    confirmationStrategiesToggle: false,
    confirmationStrategies: [],
    confirmationMode: EFFECTIVE_BACKTEST_DEFAULTS.confirmationMode,
    confirmationWindowBars: EFFECTIVE_BACKTEST_DEFAULTS.confirmationWindowBars,
    confirmationStrategyParams: {},
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
    currentSymbol: 'ETHUSDT',
    currentInterval: '1d',
    binanceMarketType: 'spot',
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

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

const UI_ONLY_BACKTEST_SETTING_KEYS = new Set<keyof BacktestSettingsData>([
    'initialCapital',
    'positionSize',
    'commission',
    'fixedTradeToggle',
    'sizingMode',
    'fixedTradeAmount',
    'kellyFraction',
    'kellyWinRateCap',
    'kellyProfitFactorCap',
    'volTargetAnnual',
    'volLookbackBars',
    'volScalingMethod',
    'riskParityLookback',
    'riskParityMethod',
    'martingaleMultiplier',
    'martingaleMaxSequence',
    'martingaleResetOnWin',
    'martingaleResetOnLoss',
    'martingaleBaseSize',
    'optimalFLookback',
    'optimalFBootstrapSamples',
    'secureFConfidence',
    'secureFMethod',
    'takeProfitAdaptiveLookbackTrades',
    'takeProfitAdaptiveRecentWindow',
    'takeProfitAdaptiveMinMultiplier',
    'takeProfitAdaptiveMaxMultiplier',
    'takeProfitAdaptiveGridSteps',
    'takeProfitAdaptiveRegimeBlend',
    'takeProfitAdaptiveIcScale',
    'useRustEngine',
    'riskSettingsToggle',
    'confirmationStrategiesToggle',
    'batchExecutionMode',
    'finderUniverseExecutionMode',
]);

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

        const resolvedKey = key;
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
    normalized.kellyFraction = coerceAdvancedSizingFieldValue("kellyFraction", source.kellyFraction) as BacktestSettingsData["kellyFraction"];
    normalized.kellyWinRateCap = coerceAdvancedSizingFieldValue("kellyWinRateCap", source.kellyWinRateCap) as number;
    normalized.kellyProfitFactorCap = coerceAdvancedSizingFieldValue("kellyProfitFactorCap", source.kellyProfitFactorCap) as number;
    normalized.volTargetAnnual = coerceAdvancedSizingFieldValue("volTargetAnnual", source.volTargetAnnual) as number;
    normalized.volLookbackBars = coerceAdvancedSizingFieldValue("volLookbackBars", source.volLookbackBars) as number;
    normalized.volScalingMethod = coerceAdvancedSizingFieldValue("volScalingMethod", source.volScalingMethod) as BacktestSettingsData["volScalingMethod"];
    normalized.riskParityLookback = coerceAdvancedSizingFieldValue("riskParityLookback", source.riskParityLookback) as number;
    normalized.riskParityMethod = coerceAdvancedSizingFieldValue("riskParityMethod", source.riskParityMethod) as BacktestSettingsData["riskParityMethod"];
    normalized.martingaleMultiplier = coerceAdvancedSizingFieldValue("martingaleMultiplier", source.martingaleMultiplier) as number;
    normalized.martingaleMaxSequence = coerceAdvancedSizingFieldValue("martingaleMaxSequence", source.martingaleMaxSequence) as number;
    normalized.martingaleResetOnWin = coerceAdvancedSizingFieldValue("martingaleResetOnWin", source.martingaleResetOnWin) as boolean;
    normalized.martingaleResetOnLoss = coerceAdvancedSizingFieldValue("martingaleResetOnLoss", source.martingaleResetOnLoss) as boolean;
    normalized.martingaleBaseSize = coerceAdvancedSizingFieldValue("martingaleBaseSize", source.martingaleBaseSize) as BacktestSettingsData["martingaleBaseSize"];
    normalized.optimalFLookback = coerceAdvancedSizingFieldValue("optimalFLookback", source.optimalFLookback) as number;
    normalized.optimalFBootstrapSamples = coerceAdvancedSizingFieldValue("optimalFBootstrapSamples", source.optimalFBootstrapSamples) as number;
    normalized.secureFConfidence = coerceAdvancedSizingFieldValue("secureFConfidence", source.secureFConfidence) as number;
    normalized.secureFMethod = coerceAdvancedSizingFieldValue("secureFMethod", source.secureFMethod) as BacktestSettingsData["secureFMethod"];
    normalized.takeProfitAdaptiveLookbackTrades = coerceAdaptiveTakeProfitFieldValue("takeProfitAdaptiveLookbackTrades", source.takeProfitAdaptiveLookbackTrades);
    normalized.takeProfitAdaptiveRecentWindow = coerceAdaptiveTakeProfitFieldValue("takeProfitAdaptiveRecentWindow", source.takeProfitAdaptiveRecentWindow);
    normalized.takeProfitAdaptiveMinMultiplier = coerceAdaptiveTakeProfitFieldValue("takeProfitAdaptiveMinMultiplier", source.takeProfitAdaptiveMinMultiplier);
    normalized.takeProfitAdaptiveMaxMultiplier = coerceAdaptiveTakeProfitFieldValue("takeProfitAdaptiveMaxMultiplier", source.takeProfitAdaptiveMaxMultiplier);
    normalized.takeProfitAdaptiveGridSteps = coerceAdaptiveTakeProfitFieldValue("takeProfitAdaptiveGridSteps", source.takeProfitAdaptiveGridSteps);
    normalized.takeProfitAdaptiveRegimeBlend = coerceAdaptiveTakeProfitFieldValue("takeProfitAdaptiveRegimeBlend", source.takeProfitAdaptiveRegimeBlend);
    normalized.takeProfitAdaptiveIcScale = coerceAdaptiveTakeProfitFieldValue("takeProfitAdaptiveIcScale", source.takeProfitAdaptiveIcScale);
    normalized.useRustEngine = readBoolean(source.useRustEngine, DEFAULT_BACKTEST_SETTINGS.useRustEngine);
    normalized.riskSettingsToggle = readBoolean(source.riskSettingsToggle, DEFAULT_BACKTEST_SETTINGS.riskSettingsToggle);
    normalized.polymarketBacktestSlippageCents = clampPolymarketBacktestSlippageCents(
        source.polymarketBacktestSlippageCents
    );
    normalized.confirmationStrategiesToggle = readBoolean(
        source.confirmationStrategiesToggle,
        Array.isArray(normalized.confirmationStrategies) && normalized.confirmationStrategies.length > 0
    );
    Object.assign(normalized, resolvePolymarketPostSignalLimitSettingFields(
        source,
        (key, fallback) => readBoolean(source[key], fallback)
    ));

    // Cross-symbol
    normalized.crossSymbolSecondary = typeof source.crossSymbolSecondary === 'string'
        ? source.crossSymbolSecondary.trim().toUpperCase()
        : '';

    // Exit strategy override
    normalized.exitStrategyOverrideEnabled = readBoolean(
        source.exitStrategyOverrideEnabled,
        DEFAULT_BACKTEST_SETTINGS.exitStrategyOverrideEnabled
    );
    normalized.exitStrategyKey = typeof source.exitStrategyKey === 'string'
        ? source.exitStrategyKey.trim()
        : '';
    normalized.exitStrategyParams = normalizeStrategyParams(source.exitStrategyParams);

    // Batch execution mode: accept "browser" verbatim; anything else (including
    // missing) falls back to the default "server". Kept narrow so an unknown
    // future value never silently switches a user to the in-browser path.
    normalized.batchExecutionMode = source.batchExecutionMode === "browser"
        ? "browser"
        : DEFAULT_BACKTEST_SETTINGS.batchExecutionMode;

    // Finder Symbol Universe execution mode: same rule as batchExecutionMode.
    normalized.finderUniverseExecutionMode = source.finderUniverseExecutionMode === "browser"
        ? "browser"
        : DEFAULT_BACKTEST_SETTINGS.finderUniverseExecutionMode;

    return normalized;
}

export function normalizeStoredAppSettings(raw: unknown): AppSettings | null {
    const source = toRecord(raw);
    if (!source) return null;

    const chartMode = source.chartMode === 'heikin-ashi' ? 'heikin-ashi' : DEFAULT_APP_SETTINGS.chartMode;

    return {
        currentSymbol: readString(source.currentSymbol, DEFAULT_APP_SETTINGS.currentSymbol),
        currentInterval: readString(source.currentInterval, DEFAULT_APP_SETTINGS.currentInterval),
        binanceMarketType: resolveBinanceMarketType(source.binanceMarketType, DEFAULT_APP_SETTINGS.binanceMarketType),
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
        symbol: readOptionalString(source.symbol)?.toUpperCase(),
        interval: readOptionalString(source.interval),
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

    const mode = source.mode === "primary_veto"
        || source.mode === "secondary_override"
        || source.mode === "best_side_owner"
        || source.mode === "target_conflict_filter"
        ? source.mode
        : "target_conflict_filter";
    const directionSlice = source.directionSlice === "long_only"
        || source.directionSlice === "short_only"
        || source.directionSlice === "all"
        ? source.directionSlice
        : "all";
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
        directionSlice,
        anchorConfigName: readString(source.anchorConfigName, anchorConfig.name),
        anchorConfig,
        componentConfigs,
        primaryConfigName: readString(source.primaryConfigName, ""),
        secondaryConfigName: readString(source.secondaryConfigName, ""),
        vetoConfigName: readString(source.vetoConfigName, ""),
        longOwnerConfigName: readString(source.longOwnerConfigName, ""),
        shortOwnerConfigName: readString(source.shortOwnerConfigName, ""),
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
    void settings;
    return defaults.marketMode;
}

export function resolveRiskModeValue(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): NonNullable<BacktestSettings["riskMode"]> {
    if (value === "simple" || value === "percentage") {
        return value;
    }
    return defaults.riskMode;
}

export function resolveTakeProfitModeValue(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): PercentageTakeProfitMode {
    return resolveTakeProfitMode(value) ?? defaults.takeProfitMode;
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

export function resolveExecutionModelValue(
    value: unknown,
    defaults: BacktestSettingsData = DEFAULT_BACKTEST_SETTINGS
): ExecutionModel {
    if (value === "signal_close" || value === "next_open" || value === "next_close") {
        return value;
    }
    return defaults.executionModel;
}
