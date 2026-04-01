import type { StrategyParams } from "../types/strategies";
export { createSeededRandom } from "../param-math-utils";

type ParamRangeOptions = {
    includeFinderExtraBounds?: boolean;
};

type ParamNormalizationOptions = {
    min?: number;
    max?: number;
    includeFinderExtraBounds?: boolean;
};

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function isToggleParam(key: string, value: number): boolean {
    return /^use[A-Z]/.test(key) && (value === 0 || value === 1);
}

export function computeParamRange(
    key: string,
    baseValue: number,
    rangePercent: number,
    options: ParamRangeOptions = {}
): { min: number; max: number } {
    const rangeRatio = Math.max(0, rangePercent) / 100;
    const rawRange = Math.abs(baseValue) * rangeRatio;
    const range = rawRange > 0 ? rawRange : rangeRatio > 0 ? 1 : 0;
    let min = baseValue - range;
    let max = baseValue + range;

    if (key === "clusterChoice") {
        min = 0;
        max = 2;
    } else if (options.includeFinderExtraBounds && key === "midpointBars") {
        min = Math.max(1, min);
        max = Math.min(6, max);
    } else if (options.includeFinderExtraBounds && key === "crossThreshold") {
        min = Math.max(0, min);
        max = Math.min(0.05, max);
    } else if (options.includeFinderExtraBounds && key === "minRangePct") {
        min = Math.max(0, min);
        max = Math.min(0.05, max);
    } else if (/(iteration|iterations|interval|alpha)/i.test(key)) {
        min = Math.max(1, min);
    } else if (key === "warmupBars") {
        min = Math.max(0, min);
    }

    if (key === "stopLossPercent") {
        min = Math.max(0, min);
        max = Math.min(15, max);
    } else if (key === "takeProfitMfeBootstrapPercentile") {
        min = Math.max(1, min);
        max = Math.min(99, max);
    } else if (key === "takeProfitPercent") {
        min = Math.max(0, min);
        max = Math.min(100, max);
    }

    return { min, max };
}

export function normalizeParamValue(
    key: string,
    value: number,
    defaultValue: number,
    options: ParamNormalizationOptions = {}
): number {
    const hasExplicitBounds = options.min !== undefined && options.max !== undefined;
    let next = hasExplicitBounds ? clamp(value, options.min!, options.max!) : value;
    const isRsiThreshold = /(rsi(bullish|bearish|overbought|oversold)|overbought|oversold)/i.test(key);
    const isRsiPeriod = /rsi/i.test(key) && !isRsiThreshold;
    const periodLike = /(period|lookback|bars|bins|length|iteration|iterations|interval|alpha)/i.test(key) || isRsiPeriod;
    const percentLike = /(percent|pct)/i.test(key) || isRsiThreshold;
    const nonNegative = /(std|dev|factor|multiplier|atr|adx)/i.test(key);

    if (key === "warmupBars") {
        next = Math.max(0, Math.round(next));
    } else if (key === "clusterChoice") {
        next = Math.min(2, Math.max(0, Math.round(next)));
    } else if (options.includeFinderExtraBounds && key === "midpointBars") {
        next = Math.min(6, Math.max(1, Math.round(next)));
    } else if (key === "takeProfitMfeBootstrapPercentile") {
        next = Math.min(99, Math.max(1, Number(next.toFixed(2))));
    } else if (options.includeFinderExtraBounds && (key === "crossThreshold" || key === "minRangePct")) {
        next = Math.min(0.05, Math.max(0, Number(next.toFixed(4))));
    } else if (periodLike) {
        next = Math.max(1, Math.round(next));
    } else if (key === "stopLossPercent") {
        next = Math.min(15, Math.max(0, Number(next.toFixed(2))));
    } else if (key === "takeProfitPercent") {
        next = Math.min(100, Math.max(0, Number(next.toFixed(2))));
    } else if (percentLike) {
        next = Math.min(100, Math.max(0, next));
    } else if (nonNegative) {
        next = Math.max(0, next);
    }

    if (/(multiplier|factor)/i.test(key) && defaultValue > 0) {
        next = Math.max(0.1, next);
    }
    if (/z(entry|exit)/i.test(key) || key === "bufferAtr") {
        next = Math.max(0, next);
    }

    if (
        !periodLike &&
        Number.isInteger(defaultValue) &&
        !percentLike &&
        key !== "stopLossPercent" &&
        key !== "takeProfitPercent" &&
        key !== "takeProfitMfeBootstrapPercentile"
    ) {
        next = Math.round(next);
    } else if (
        key === "stopLossPercent" ||
        key === "takeProfitPercent" ||
        key === "takeProfitMfeBootstrapPercentile"
    ) {
        next = Number(next.toFixed(2));
    } else if (!Number.isInteger(defaultValue)) {
        next = Number(next.toFixed(4));
    }

    return hasExplicitBounds ? clamp(next, options.min!, options.max!) : next;
}

export function validateParams(params: StrategyParams): boolean {
    const fast = params.fastPeriod;
    const slow = params.slowPeriod;
    const medium = params.mediumPeriod;
    if (fast !== undefined && slow !== undefined && fast >= slow) return false;
    if (fast !== undefined && medium !== undefined && fast >= medium) return false;
    if (medium !== undefined && slow !== undefined && medium >= slow) return false;

    const oversold = params.oversold;
    const overbought = params.overbought;
    if (oversold !== undefined && overbought !== undefined && oversold >= overbought) return false;

    const rsiOversold = params.rsiOversold;
    const rsiOverbought = params.rsiOverbought;
    if (rsiOversold !== undefined && rsiOverbought !== undefined && rsiOversold >= rsiOverbought) return false;

    const kPeriod = params.kPeriod;
    const dPeriod = params.dPeriod;
    if (kPeriod !== undefined && dPeriod !== undefined && kPeriod < dPeriod) return false;

    const macdFast = params.macdFast;
    const macdSlow = params.macdSlow;
    if (macdFast !== undefined && macdSlow !== undefined && macdFast >= macdSlow) return false;

    const minFactor = params.minFactor;
    const maxFactor = params.maxFactor;
    if (minFactor !== undefined && maxFactor !== undefined && minFactor > maxFactor) return false;
    if (params.factorStep !== undefined && params.factorStep <= 0) return false;

    if (params.kMeansIterations !== undefined && params.kMeansIterations <= 0) return false;
    if (params.kMeansInterval !== undefined && params.kMeansInterval <= 0) return false;
    if (params.perfAlpha !== undefined && params.perfAlpha <= 0) return false;
    if (params.clusterChoice !== undefined && (params.clusterChoice < 0 || params.clusterChoice > 2)) return false;

    const zEntry = params.zEntry;
    const zExit = params.zExit;
    if (zEntry !== undefined && zExit !== undefined && zExit >= zEntry) return false;

    const entryExposurePct = params.entryExposurePct;
    const exitExposurePct = params.exitExposurePct;
    if (entryExposurePct !== undefined && exitExposurePct !== undefined && exitExposurePct >= entryExposurePct) return false;

    return true;
}

export function serializeParams(params: StrategyParams): string {
    return Object.keys(params)
        .sort()
        .map((key) => `${key}:${params[key]}`)
        .join("|");
}
