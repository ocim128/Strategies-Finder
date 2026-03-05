import type {
    BacktestSettings,
    ExecutionModel,
    MarketMode,
    StrategyParams,
    TradeDirection,
    TradeFilterMode,
} from "./types/strategies";

export const CAPITAL_DEFAULTS = Object.freeze({
    initialCapital: 10000,
    positionSize: 100,
    commission: 0.1,
    fixedTradeAmount: 1000,
});

export const EFFECTIVE_BACKTEST_DEFAULTS = Object.freeze({
    atrPeriod: 14,
    stopLossAtr: 1.5,
    takeProfitAtr: 3,
    trailingAtr: 2,
    partialTakeProfitAtR: 1,
    partialTakeProfitPercent: 50,
    breakEvenAtR: 1,
    breakEvenPercent: 0,
    timeStopBars: 0,
    riskMode: "simple" as NonNullable<BacktestSettings["riskMode"]>,
    stopLossPercent: 5,
    takeProfitPercent: 10,
    stopLossEnabled: true,
    takeProfitEnabled: true,
    riskMaxHoldBars: 10,
    riskMaxHoldEnabled: false,
    riskProbationBars: 3,
    riskProbationMinR: 0.2,
    riskProbationCooldownBars: 5,
    riskProbationEnabled: false,
    riskLossStreakConsecutive: 2,
    riskLossStreakWindowSize: 5,
    riskLossStreakWindowLosses: 3,
    riskLossStreakCooldownBars: 5,
    riskLossStreakEnabled: false,
    marketMode: "all" as MarketMode,
    tradeFilterMode: "none" as TradeFilterMode,
    htfBiasEmaPeriod: 200,
    confirmLookback: 1,
    volumeSmaPeriod: 20,
    volumeMultiplier: 1.5,
    rsiPeriod: 14,
    rsiBullish: 55,
    rsiBearish: 45,
    tradeDirection: "short" as TradeDirection,
    flipAfterConsecutiveLosses: 2,
    flipCooldownTrades: 0,
    minTradesBeforeFirstFlip: 0,
    executionModel: "next_open" as ExecutionModel,
    allowSameBarExit: false,
    slippageBps: 5,
    maxOpenTrades: 1,
    strategyTimeframeEnabled: false,
    strategyTimeframeMinutes: 120,
    twoHourCloseParity: "odd" as const,
});

type SnapshotConfig = {
    toggleKey: string;
    minKey?: string;
    maxKey: string;
};

const SNAPSHOT_CONFIGS: readonly SnapshotConfig[] = [
    { toggleKey: "snapshotAtrFilterToggle", minKey: "snapshotAtrPercentMin", maxKey: "snapshotAtrPercentMax" },
    { toggleKey: "snapshotVolumeFilterToggle", minKey: "snapshotVolumeRatioMin", maxKey: "snapshotVolumeRatioMax" },
    { toggleKey: "snapshotAdxFilterToggle", minKey: "snapshotAdxMin", maxKey: "snapshotAdxMax" },
    { toggleKey: "snapshotEmaFilterToggle", minKey: "snapshotEmaDistanceMin", maxKey: "snapshotEmaDistanceMax" },
    { toggleKey: "snapshotRsiFilterToggle", minKey: "snapshotRsiMin", maxKey: "snapshotRsiMax" },
    { toggleKey: "snapshotPriceRangePosFilterToggle", minKey: "snapshotPriceRangePosMin", maxKey: "snapshotPriceRangePosMax" },
    { toggleKey: "snapshotBarsFromHighFilterToggle", maxKey: "snapshotBarsFromHighMax" },
    { toggleKey: "snapshotBarsFromLowFilterToggle", maxKey: "snapshotBarsFromLowMax" },
    { toggleKey: "snapshotTrendEfficiencyFilterToggle", minKey: "snapshotTrendEfficiencyMin", maxKey: "snapshotTrendEfficiencyMax" },
    { toggleKey: "snapshotAtrRegimeFilterToggle", minKey: "snapshotAtrRegimeRatioMin", maxKey: "snapshotAtrRegimeRatioMax" },
    { toggleKey: "snapshotBodyPercentFilterToggle", minKey: "snapshotBodyPercentMin", maxKey: "snapshotBodyPercentMax" },
    { toggleKey: "snapshotWickSkewFilterToggle", minKey: "snapshotWickSkewMin", maxKey: "snapshotWickSkewMax" },
    { toggleKey: "snapshotVolumeTrendFilterToggle", minKey: "snapshotVolumeTrendMin", maxKey: "snapshotVolumeTrendMax" },
    { toggleKey: "snapshotVolumeBurstFilterToggle", minKey: "snapshotVolumeBurstMin", maxKey: "snapshotVolumeBurstMax" },
    { toggleKey: "snapshotVolumePriceDivergenceFilterToggle", minKey: "snapshotVolumePriceDivergenceMin", maxKey: "snapshotVolumePriceDivergenceMax" },
    { toggleKey: "snapshotVolumeConsistencyFilterToggle", minKey: "snapshotVolumeConsistencyMin", maxKey: "snapshotVolumeConsistencyMax" },
    { toggleKey: "snapshotCloseLocationFilterToggle", minKey: "snapshotCloseLocationMin", maxKey: "snapshotCloseLocationMax" },
    { toggleKey: "snapshotOppositeWickFilterToggle", minKey: "snapshotOppositeWickMin", maxKey: "snapshotOppositeWickMax" },
    { toggleKey: "snapshotRangeAtrFilterToggle", minKey: "snapshotRangeAtrMultipleMin", maxKey: "snapshotRangeAtrMultipleMax" },
    { toggleKey: "snapshotMomentumFilterToggle", minKey: "snapshotMomentumConsistencyMin", maxKey: "snapshotMomentumConsistencyMax" },
    { toggleKey: "snapshotBreakQualityFilterToggle", minKey: "snapshotBreakQualityMin", maxKey: "snapshotBreakQualityMax" },
    { toggleKey: "snapshotTf60PerfFilterToggle", minKey: "snapshotTf60PerfMin", maxKey: "snapshotTf60PerfMax" },
    { toggleKey: "snapshotTf90PerfFilterToggle", minKey: "snapshotTf90PerfMin", maxKey: "snapshotTf90PerfMax" },
    { toggleKey: "snapshotTf120PerfFilterToggle", minKey: "snapshotTf120PerfMin", maxKey: "snapshotTf120PerfMax" },
    { toggleKey: "snapshotTf480PerfFilterToggle", minKey: "snapshotTf480PerfMin", maxKey: "snapshotTf480PerfMax" },
    { toggleKey: "snapshotTfConfluencePerfFilterToggle", minKey: "snapshotTfConfluencePerfMin", maxKey: "snapshotTfConfluencePerfMax" },
    { toggleKey: "snapshotEntryQualityScoreFilterToggle", minKey: "snapshotEntryQualityScoreMin", maxKey: "snapshotEntryQualityScoreMax" },
];

export const BACKTEST_DOM_SETTING_IDS: readonly string[] = Object.freeze([
    "riskSettingsToggle",
    "tradeFilterSettingsToggle",
    "entrySettingsToggle",
    "confirmationStrategiesToggle",
    "riskMode",
    "atrPeriod",
    "stopLossAtr",
    "takeProfitAtr",
    "trailingAtr",
    "partialTakeProfitAtR",
    "partialTakeProfitPercent",
    "breakEvenAtR",
    "breakEvenPercent",
    "timeStopBars",
    "stopLossPercent",
    "takeProfitPercent",
    "stopLossToggle",
    "takeProfitToggle",
    "riskMaxHoldBars",
    "riskMaxHoldToggle",
    "riskProbationBars",
    "riskProbationMinR",
    "riskProbationCooldownBars",
    "riskProbationToggle",
    "riskLossStreakConsecutive",
    "riskLossStreakWindowSize",
    "riskLossStreakWindowLosses",
    "riskLossStreakCooldownBars",
    "riskLossStreakToggle",
    "marketMode",
    "tradeFilterMode",
    "htfBiasEmaPeriod",
    "confirmLookback",
    "volumeSmaPeriod",
    "volumeMultiplier",
    "confirmRsiPeriod",
    "confirmRsiBullish",
    "confirmRsiBearish",
    "tradeDirection",
    "flipAfterConsecutiveLosses",
    "flipCooldownTrades",
    "minTradesBeforeFirstFlip",
    "executionModel",
    "allowSameBarExitToggle",
    "slippageBps",
    "maxOpenTrades",
    "strategyTimeframeToggle",
    "strategyTimeframeMinutes",
    "twoHourCloseParity",
    ...SNAPSHOT_CONFIGS.flatMap(({ toggleKey, minKey, maxKey }) =>
        [toggleKey, minKey, maxKey].filter((key): key is string => Boolean(key))
    ),
]);

const VALID_TRADE_FILTER_MODES = new Set<TradeFilterMode>([
    "none",
    "close",
    "volume",
    "rsi",
    "trend",
    "adx",
    "htf_drift",
    "trend_htf_bias",
    "trend_exec_alignment",
    "trend_no_chase",
    "trend_hysteresis",
    "trend_mtf_stack",
]);
const VALID_TRADE_DIRECTIONS = new Set<TradeDirection>(["long", "short", "both", "both_flip_loss_2", "combined"]);

function toBooleanLike(rawValue: unknown): boolean | null {
    if (typeof rawValue === "boolean") return rawValue;
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) return rawValue !== 0;
    if (typeof rawValue !== "string") return null;

    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
    return null;
}

function toFiniteNumber(rawValue: unknown): number | null {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) return rawValue;
    if (typeof rawValue !== "string") return null;

    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function coerceScalar(rawValue: unknown): unknown {
    const asBoolean = toBooleanLike(rawValue);
    if (asBoolean !== null) return asBoolean;
    const asNumber = toFiniteNumber(rawValue);
    if (asNumber !== null) return asNumber;
    return rawValue;
}

function coerceDeepValue(rawValue: unknown): unknown {
    if (Array.isArray(rawValue)) {
        return rawValue.map((value) => coerceDeepValue(value));
    }
    if (rawValue && typeof rawValue === "object") {
        const record = rawValue as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            normalized[key] = coerceDeepValue(value);
        }
        return normalized;
    }
    return coerceScalar(rawValue);
}

function readNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
    const parsed = toFiniteNumber(raw[key]);
    return parsed !== null ? parsed : fallback;
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const parsed = toBooleanLike(raw[key]);
    return parsed !== null ? parsed : fallback;
}

function readBooleanAny(raw: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
    for (const key of keys) {
        if (!(key in raw)) continue;
        const parsed = toBooleanLike(raw[key]);
        if (parsed !== null) return parsed;
    }
    return fallback;
}

function readTradeFilterMode(rawValue: unknown, fallback: TradeFilterMode): TradeFilterMode {
    if (typeof rawValue === "string") {
        const mode = rawValue.trim().toLowerCase() as TradeFilterMode;
        if (VALID_TRADE_FILTER_MODES.has(mode)) return mode;
    }
    return fallback;
}

function readTradeDirection(rawValue: unknown, fallback: TradeDirection): TradeDirection {
    if (typeof rawValue === "string") {
        const direction = rawValue.trim().toLowerCase() as TradeDirection;
        if (VALID_TRADE_DIRECTIONS.has(direction)) return direction;
    }
    return fallback;
}

function readConfirmationStrategies(rawValue: unknown): string[] {
    if (!Array.isArray(rawValue)) return [];
    return rawValue.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function readConfirmationParams(rawValue: unknown): Record<string, StrategyParams> {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return {};
    const normalized: Record<string, StrategyParams> = {};
    for (const [strategyKey, params] of Object.entries(rawValue as Record<string, unknown>)) {
        if (!params || typeof params !== "object" || Array.isArray(params)) continue;
        const normalizedParams: StrategyParams = {};
        for (const [paramKey, paramValue] of Object.entries(params as Record<string, unknown>)) {
            const parsed = toFiniteNumber(paramValue);
            if (parsed !== null) normalizedParams[paramKey] = parsed;
        }
        normalized[strategyKey] = normalizedParams;
    }
    return normalized;
}

function resolveSnapshotValue(raw: Record<string, unknown>, toggleKey: string, valueKey: string): number {
    return readBoolean(raw, toggleKey, false) ? readNumber(raw, valueKey, 0) : 0;
}

export function hasUiToggleSettings(raw: Record<string, unknown>): boolean {
    return [
        "riskSettingsToggle",
        "tradeFilterSettingsToggle",
        "entrySettingsToggle",
        "confirmationStrategiesToggle",
        "riskProbationToggle",
        "riskLossStreakToggle",
        ...SNAPSHOT_CONFIGS.map((snapshot) => snapshot.toggleKey),
    ].some((key) => key in raw);
}

export function resolveBacktestSettingsFromRaw(
    settings?: BacktestSettings,
    options?: {
        captureSnapshots?: boolean;
        coerceWithoutUiToggles?: boolean;
    }
): BacktestSettings {
    if (!settings) return {};

    const raw = settings as Record<string, unknown>;
    if (options?.coerceWithoutUiToggles !== false && !hasUiToggleSettings(raw)) {
        return coerceDeepValue(settings) as BacktestSettings;
    }

    const riskEnabled = readBoolean(raw, "riskSettingsToggle", false);
    const riskModeRaw = raw["riskMode"];
    const riskMode: BacktestSettings["riskMode"] =
        riskModeRaw === "advanced" || riskModeRaw === "percentage"
            ? riskModeRaw
            : EFFECTIVE_BACKTEST_DEFAULTS.riskMode;
    const useAtrRisk = riskEnabled && (riskMode === "simple" || riskMode === "advanced");
    const usePercentRisk = riskEnabled && riskMode === "percentage";
    const useAdvancedRisk = riskEnabled && riskMode === "advanced";

    const tradeFilterEnabled = readBoolean(
        raw,
        "tradeFilterSettingsToggle",
        readBoolean(raw, "entrySettingsToggle", false)
    );
    const tradeFilterMode = tradeFilterEnabled
        ? readTradeFilterMode(
            raw["tradeFilterMode"] ?? raw["entryConfirmation"],
            EFFECTIVE_BACKTEST_DEFAULTS.tradeFilterMode
        )
        : "none";

    const confirmationEnabled = readBoolean(raw, "confirmationStrategiesToggle", false);
    const confirmationStrategies = confirmationEnabled ? readConfirmationStrategies(raw["confirmationStrategies"]) : [];
    const confirmationStrategyParams = confirmationEnabled ? readConfirmationParams(raw["confirmationStrategyParams"]) : {};

    const executionModelRaw = raw["executionModel"];
    const executionModel: ExecutionModel =
        executionModelRaw === "signal_close" || executionModelRaw === "next_open" || executionModelRaw === "next_close"
            ? executionModelRaw
            : EFFECTIVE_BACKTEST_DEFAULTS.executionModel;
    const tradeDirection = readTradeDirection(raw["tradeDirection"], EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection);

    const marketModeRaw = raw["marketMode"];
    const marketMode: MarketMode =
        marketModeRaw === "uptrend" || marketModeRaw === "downtrend" || marketModeRaw === "sideway"
            ? marketModeRaw
            : EFFECTIVE_BACKTEST_DEFAULTS.marketMode;
    const parityRaw = raw["twoHourCloseParity"];
    const twoHourCloseParity = parityRaw === "even" || parityRaw === "both" ? parityRaw : "odd";

    const resolved: BacktestSettings = {
        atrPeriod: readNumber(raw, "atrPeriod", EFFECTIVE_BACKTEST_DEFAULTS.atrPeriod),
        stopLossAtr: useAtrRisk ? readNumber(raw, "stopLossAtr", EFFECTIVE_BACKTEST_DEFAULTS.stopLossAtr) : 0,
        takeProfitAtr: useAtrRisk ? readNumber(raw, "takeProfitAtr", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAtr) : 0,
        trailingAtr: useAtrRisk ? readNumber(raw, "trailingAtr", EFFECTIVE_BACKTEST_DEFAULTS.trailingAtr) : 0,
        partialTakeProfitAtR: useAdvancedRisk ? readNumber(raw, "partialTakeProfitAtR", EFFECTIVE_BACKTEST_DEFAULTS.partialTakeProfitAtR) : 0,
        partialTakeProfitPercent: useAdvancedRisk ? readNumber(raw, "partialTakeProfitPercent", EFFECTIVE_BACKTEST_DEFAULTS.partialTakeProfitPercent) : 0,
        breakEvenAtR: useAdvancedRisk ? readNumber(raw, "breakEvenAtR", EFFECTIVE_BACKTEST_DEFAULTS.breakEvenAtR) : 0,
        breakEvenPercent: usePercentRisk ? readNumber(raw, "breakEvenPercent", EFFECTIVE_BACKTEST_DEFAULTS.breakEvenPercent) : 0,
        timeStopBars: useAdvancedRisk ? readNumber(raw, "timeStopBars", EFFECTIVE_BACKTEST_DEFAULTS.timeStopBars) : 0,
        riskMode,
        stopLossPercent: usePercentRisk ? readNumber(raw, "stopLossPercent", EFFECTIVE_BACKTEST_DEFAULTS.stopLossPercent) : 0,
        takeProfitPercent: usePercentRisk ? readNumber(raw, "takeProfitPercent", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitPercent) : 0,
        stopLossEnabled: usePercentRisk ? readBooleanAny(raw, ["stopLossEnabled", "stopLossToggle"], EFFECTIVE_BACKTEST_DEFAULTS.stopLossEnabled) : false,
        takeProfitEnabled: usePercentRisk ? readBooleanAny(raw, ["takeProfitEnabled", "takeProfitToggle"], EFFECTIVE_BACKTEST_DEFAULTS.takeProfitEnabled) : false,
        riskMaxHoldBars: usePercentRisk ? readNumber(raw, "riskMaxHoldBars", EFFECTIVE_BACKTEST_DEFAULTS.riskMaxHoldBars) : 0,
        riskMaxHoldEnabled: usePercentRisk ? readBooleanAny(raw, ["riskMaxHoldEnabled", "riskMaxHoldToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskMaxHoldEnabled) : false,
        riskProbationBars: usePercentRisk ? readNumber(raw, "riskProbationBars", EFFECTIVE_BACKTEST_DEFAULTS.riskProbationBars) : 0,
        riskProbationMinR: usePercentRisk ? readNumber(raw, "riskProbationMinR", EFFECTIVE_BACKTEST_DEFAULTS.riskProbationMinR) : 0,
        riskProbationCooldownBars: usePercentRisk ? readNumber(raw, "riskProbationCooldownBars", EFFECTIVE_BACKTEST_DEFAULTS.riskProbationCooldownBars) : 0,
        riskProbationEnabled: usePercentRisk ? readBooleanAny(raw, ["riskProbationEnabled", "riskProbationToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskProbationEnabled) : false,
        riskLossStreakConsecutive: usePercentRisk ? readNumber(raw, "riskLossStreakConsecutive", EFFECTIVE_BACKTEST_DEFAULTS.riskLossStreakConsecutive) : 0,
        riskLossStreakWindowSize: usePercentRisk ? readNumber(raw, "riskLossStreakWindowSize", EFFECTIVE_BACKTEST_DEFAULTS.riskLossStreakWindowSize) : 0,
        riskLossStreakWindowLosses: usePercentRisk ? readNumber(raw, "riskLossStreakWindowLosses", EFFECTIVE_BACKTEST_DEFAULTS.riskLossStreakWindowLosses) : 0,
        riskLossStreakCooldownBars: usePercentRisk ? readNumber(raw, "riskLossStreakCooldownBars", EFFECTIVE_BACKTEST_DEFAULTS.riskLossStreakCooldownBars) : 0,
        riskLossStreakEnabled: usePercentRisk ? readBooleanAny(raw, ["riskLossStreakEnabled", "riskLossStreakToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskLossStreakEnabled) : false,
        marketMode,
        trendEmaPeriod: 0,
        trendEmaSlopeBars: 0,
        atrPercentMin: 0,
        atrPercentMax: 0,
        adxPeriod: 14,
        adxMin: 0,
        adxMax: 0,
        tradeFilterMode,
        entryConfirmation: tradeFilterMode,
        htfBiasEmaPeriod: tradeFilterEnabled
            ? readNumber(raw, "htfBiasEmaPeriod", EFFECTIVE_BACKTEST_DEFAULTS.htfBiasEmaPeriod)
            : EFFECTIVE_BACKTEST_DEFAULTS.htfBiasEmaPeriod,
        confirmLookback: tradeFilterEnabled ? readNumber(raw, "confirmLookback", EFFECTIVE_BACKTEST_DEFAULTS.confirmLookback) : EFFECTIVE_BACKTEST_DEFAULTS.confirmLookback,
        volumeSmaPeriod: tradeFilterEnabled ? readNumber(raw, "volumeSmaPeriod", EFFECTIVE_BACKTEST_DEFAULTS.volumeSmaPeriod) : EFFECTIVE_BACKTEST_DEFAULTS.volumeSmaPeriod,
        volumeMultiplier: tradeFilterEnabled ? readNumber(raw, "volumeMultiplier", EFFECTIVE_BACKTEST_DEFAULTS.volumeMultiplier) : EFFECTIVE_BACKTEST_DEFAULTS.volumeMultiplier,
        rsiPeriod: tradeFilterEnabled
            ? readNumber(raw, "rsiPeriod", readNumber(raw, "confirmRsiPeriod", EFFECTIVE_BACKTEST_DEFAULTS.rsiPeriod))
            : EFFECTIVE_BACKTEST_DEFAULTS.rsiPeriod,
        rsiBullish: tradeFilterEnabled
            ? readNumber(raw, "rsiBullish", readNumber(raw, "confirmRsiBullish", EFFECTIVE_BACKTEST_DEFAULTS.rsiBullish))
            : EFFECTIVE_BACKTEST_DEFAULTS.rsiBullish,
        rsiBearish: tradeFilterEnabled
            ? readNumber(raw, "rsiBearish", readNumber(raw, "confirmRsiBearish", EFFECTIVE_BACKTEST_DEFAULTS.rsiBearish))
            : EFFECTIVE_BACKTEST_DEFAULTS.rsiBearish,
        confirmationStrategies,
        confirmationStrategyParams,
        tradeDirection,
        flipAfterConsecutiveLosses: readNumber(raw, "flipAfterConsecutiveLosses", EFFECTIVE_BACKTEST_DEFAULTS.flipAfterConsecutiveLosses),
        flipCooldownTrades: readNumber(raw, "flipCooldownTrades", EFFECTIVE_BACKTEST_DEFAULTS.flipCooldownTrades),
        minTradesBeforeFirstFlip: readNumber(raw, "minTradesBeforeFirstFlip", EFFECTIVE_BACKTEST_DEFAULTS.minTradesBeforeFirstFlip),
        executionModel,
        allowSameBarExit: readBooleanAny(raw, ["allowSameBarExit", "allowSameBarExitToggle"], EFFECTIVE_BACKTEST_DEFAULTS.allowSameBarExit),
        slippageBps: readNumber(raw, "slippageBps", EFFECTIVE_BACKTEST_DEFAULTS.slippageBps),
        maxOpenTrades: Math.max(1, Math.min(2, Math.round(readNumber(raw, "maxOpenTrades", EFFECTIVE_BACKTEST_DEFAULTS.maxOpenTrades)))),
        strategyTimeframeEnabled: readBooleanAny(raw, ["strategyTimeframeEnabled", "strategyTimeframeToggle"], EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeEnabled),
        strategyTimeframeMinutes: readNumber(raw, "strategyTimeframeMinutes", EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeMinutes),
        captureSnapshots: options?.captureSnapshots ?? false,
        twoHourCloseParity,
    };

    for (const snapshot of SNAPSHOT_CONFIGS) {
        if (snapshot.minKey) {
            (resolved as Record<string, number>)[snapshot.minKey] = resolveSnapshotValue(raw, snapshot.toggleKey, snapshot.minKey);
        }
        if (snapshot.maxKey) {
            (resolved as Record<string, number>)[snapshot.maxKey] = resolveSnapshotValue(raw, snapshot.toggleKey, snapshot.maxKey);
        }
    }

    return resolved;
}
