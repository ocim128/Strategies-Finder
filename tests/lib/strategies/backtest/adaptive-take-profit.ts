import { OHLCVData, Trade } from "../../types/index";
import { IndicatorSeries, NormalizedSettings, PositionState } from "../../types/backtest";
import {
    computeAtrRegimeRatio,
    computeBreakQuality,
    computeDirectionalCloseLocation,
    computeDirectionalConfluencePercent,
    computeEntryQualityScore,
    computeMomentumConsistency,
    computeOppositeWickPercent,
    computeRangeAtrMultiple,
    computeTrendEfficiency,
} from "./snapshot-derived-metrics";

export interface AdaptiveTakeProfitOverrides {
    takeProfitPercent: number | null;
}

export interface AdaptiveTakeProfitExitSignal {
    exitPrice: number;
    exitReason: NonNullable<Trade["exitReason"]>;
    deferExecutionToNextBarOpen?: boolean;
}

type Direction = "long" | "short";

type AdaptiveEntryContext = {
    signalQuality: number;
    signalStrength: number;
    regimeKey: string;
};

type AdaptiveTradeRecord = {
    signalQuality: number;
    signalStrength: number;
    regimeKey: string;
    mfePercent: number;
    maePercent: number;
    realizedPercent: number;
    targetPercent: number;
    barsHeld: number;
    win: boolean;
    targetHit: boolean;
};

interface AdaptivePositionTakeProfitState {
    registered: true;
    direction: Direction;
    entryBarIndex: number;
    entryContext: AdaptiveEntryContext;
    resolvedTakeProfitPercent: number | null;
    maxFavorablePercent: number;
    maxAdversePercent: number;
}

export interface AdaptiveTakeProfitState {
    data: OHLCVData[];
    atr: (number | null)[];
    positionStates: WeakMap<PositionState, AdaptivePositionTakeProfitState>;
    mfeBootstrapPercent: number | null;
    tradeHistory: AdaptiveTradeRecord[];
}

const DEFAULT_FALLBACK_QUALITY = 0.5;
const DEFAULT_HISTORY_CAP = 250;
const MIN_CORRELATION_SAMPLES = 6;
const MIN_REGIME_SAMPLES = 5;
const EPSILON = 1e-9;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function clampNonNegative(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampMultiplier(minMultiplier: number, maxMultiplier: number, value: number): number {
    const floor = Math.max(0.1, Math.min(minMultiplier, maxMultiplier));
    const ceiling = Math.max(floor, Math.max(minMultiplier, maxMultiplier));
    return clamp(value, floor, ceiling);
}

function calculatePercentile(values: readonly number[], percentile: number): number | null {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];

    const rank = (Math.max(1, Math.min(99, percentile)) / 100) * (sorted.length - 1);
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);
    if (lowerIndex === upperIndex) return sorted[lowerIndex];

    const weight = rank - lowerIndex;
    return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
}

function average(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number | null {
    if (xs.length !== ys.length || xs.length < MIN_CORRELATION_SAMPLES) return null;
    const meanX = average(xs);
    const meanY = average(ys);
    if (meanX === null || meanY === null) return null;

    let numerator = 0;
    let varianceX = 0;
    let varianceY = 0;
    for (let i = 0; i < xs.length; i++) {
        const dx = xs[i] - meanX;
        const dy = ys[i] - meanY;
        numerator += dx * dy;
        varianceX += dx * dx;
        varianceY += dy * dy;
    }

    if (varianceX <= 0 || varianceY <= 0) return null;
    return numerator / Math.sqrt(varianceX * varianceY);
}

function computeSignedMovePercent(entryPrice: number, price: number, direction: Direction): number {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(price)) return 0;
    const rawPercent = ((price - entryPrice) / entryPrice) * 100;
    return direction === "short" ? -rawPercent : rawPercent;
}

function buildAdaptiveGrid(basePercent: number, config: NormalizedSettings): number[] {
    const base = clampNonNegative(basePercent);
    if (base <= 0) return [];

    const minTarget = Math.max(0.1, base * Math.max(0.1, config.takeProfitAdaptiveMinMultiplier));
    const maxTarget = Math.max(minTarget, base * Math.max(config.takeProfitAdaptiveMinMultiplier, config.takeProfitAdaptiveMaxMultiplier));
    const steps = Math.max(3, Math.round(config.takeProfitAdaptiveGridSteps));
    if (steps === 1 || Math.abs(maxTarget - minTarget) <= EPSILON) {
        return [minTarget];
    }

    const values: number[] = [];
    const step = (maxTarget - minTarget) / (steps - 1);
    for (let i = 0; i < steps; i++) {
        values.push(Number((minTarget + step * i).toFixed(4)));
    }
    return Array.from(new Set(values));
}

function selectHistoryWindow(
    history: readonly AdaptiveTradeRecord[],
    config: NormalizedSettings
): AdaptiveTradeRecord[] {
    const lookback = Math.max(5, Math.round(config.takeProfitAdaptiveLookbackTrades));
    return history.slice(-lookback);
}

function normalizeSignalStrength(value: number | null): number {
    if (value === null || !Number.isFinite(value)) return DEFAULT_FALLBACK_QUALITY;
    return clamp(0.5 + value / 8, 0, 1);
}

function resolveRegimeKey(atrRegimeRatio: number | null, trendEfficiency: number | null, tfConfluencePerf: number | null): string {
    const volatilityBucket = atrRegimeRatio === null
        ? "vol_mid"
        : atrRegimeRatio < 0.9
            ? "vol_low"
            : atrRegimeRatio > 1.1
                ? "vol_high"
                : "vol_mid";

    const trendBucket = tfConfluencePerf === null
        ? "trend_neutral"
        : tfConfluencePerf > 0.75
            ? "trend_aligned"
            : tfConfluencePerf < -0.75
                ? "trend_counter"
                : "trend_neutral";

    const efficiencyBucket = trendEfficiency === null
        ? "eff_mixed"
        : trendEfficiency >= 0.55
            ? "eff_clean"
            : trendEfficiency <= 0.3
                ? "eff_choppy"
                : "eff_mixed";

    return `${volatilityBucket}:${trendBucket}:${efficiencyBucket}`;
}

function buildEntryContext(
    data: OHLCVData[],
    atrSeries: (number | null)[],
    entryBarIndex: number,
    direction: Direction,
    triggerPrice: number
): AdaptiveEntryContext {
    const candle = data[entryBarIndex];
    if (!candle) {
        return {
            signalQuality: DEFAULT_FALLBACK_QUALITY,
            signalStrength: DEFAULT_FALLBACK_QUALITY,
            regimeKey: "vol_mid:trend_neutral:eff_mixed",
        };
    }

    const atrValue = atrSeries[entryBarIndex] ?? null;
    const trendEfficiency = computeTrendEfficiency(data, entryBarIndex);
    const atrRegimeRatio = computeAtrRegimeRatio(atrSeries, entryBarIndex);
    const closeLocation = computeDirectionalCloseLocation(candle, direction);
    const oppositeWickPercent = computeOppositeWickPercent(candle, direction);
    const rangeAtrMultiple = computeRangeAtrMultiple(candle, atrValue);
    const momentumConsistency = computeMomentumConsistency(data, entryBarIndex, direction);
    const breakQuality = computeBreakQuality(candle, direction, triggerPrice);
    const tfConfluencePerf = computeDirectionalConfluencePercent(data, entryBarIndex, direction);
    const entryQualityScore = computeEntryQualityScore({
        bodyPercent: Math.abs(candle.close - candle.open) <= EPSILON || candle.high - candle.low <= EPSILON
            ? 0
            : (Math.abs(candle.close - candle.open) / (candle.high - candle.low)) * 100,
        closeLocation,
        oppositeWickPercent,
        rangeAtrMultiple,
        momentumConsistency,
        breakQuality,
    });

    const signalQuality = clamp((entryQualityScore ?? 50) / 100, 0, 1);
    const strength = clamp(
        signalQuality * 0.55
        + normalizeSignalStrength(tfConfluencePerf) * 0.25
        + clamp(trendEfficiency ?? DEFAULT_FALLBACK_QUALITY, 0, 1) * 0.2,
        0,
        1
    );

    return {
        signalQuality,
        signalStrength: strength,
        regimeKey: resolveRegimeKey(atrRegimeRatio, trendEfficiency, tfConfluencePerf),
    };
}

function computeMfeBootstrapPercent(
    data: OHLCVData[],
    config: NormalizedSettings
): number | null {
    if (data.length < 20) return null;

    const mfePercents: number[] = [];
    const lookforward = Math.max(5, Math.min(50, Math.round(data.length * 0.02)));

    for (let i = 1; i < data.length - lookforward; i++) {
        const entryPrice = data[i].close;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

        let bestLongMfe = 0;
        let bestShortMfe = 0;
        for (let j = i + 1; j <= i + lookforward && j < data.length; j++) {
            const longMfe = ((data[j].high - entryPrice) / entryPrice) * 100;
            const shortMfe = ((entryPrice - data[j].low) / entryPrice) * 100;
            if (longMfe > bestLongMfe) bestLongMfe = longMfe;
            if (shortMfe > bestShortMfe) bestShortMfe = shortMfe;
        }
        if (bestLongMfe > 0) mfePercents.push(bestLongMfe);
        if (bestShortMfe > 0) mfePercents.push(bestShortMfe);
    }

    return calculatePercentile(mfePercents, config.takeProfitMfeBootstrapPercentile);
}

function scoreSimulatedReturn(record: AdaptiveTradeRecord, candidatePercent: number): number {
    if (record.mfePercent >= candidatePercent - EPSILON) {
        return candidatePercent;
    }
    return record.realizedPercent;
}

function optimizeTakeProfitByExpectancy(
    history: readonly AdaptiveTradeRecord[],
    basePercent: number,
    config: NormalizedSettings
): number | null {
    if (history.length < MIN_REGIME_SAMPLES) return null;

    const candidates = buildAdaptiveGrid(basePercent, config);
    let bestPercent: number | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
        let score = 0;
        for (const record of history) {
            const simulated = scoreSimulatedReturn(record, candidate);
            score += Math.log(Math.max(0.01, 1 + simulated / 100));
        }
        if (score > bestScore) {
            bestScore = score;
            bestPercent = candidate;
        }
    }

    return bestPercent;
}

function optimizeTakeProfitBySurprisal(
    history: readonly AdaptiveTradeRecord[],
    basePercent: number,
    config: NormalizedSettings
): number | null {
    if (history.length < MIN_REGIME_SAMPLES) return null;

    const candidates = buildAdaptiveGrid(basePercent, config);
    let bestPercent: number | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
        let surprisal = 0;
        for (const record of history) {
            const probability = clamp(0.05 + record.signalQuality * 0.9, 0.05, 0.95);
            const hit = record.mfePercent >= candidate - EPSILON;
            surprisal += hit ? -Math.log(probability) : -Math.log(1 - probability);
        }
        if (surprisal < bestScore) {
            bestScore = surprisal;
            bestPercent = candidate;
        }
    }

    return bestPercent;
}

function resolveModeSpecificTakeProfitPercent(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    context: AdaptiveEntryContext,
    basePercent: number
): number | null {
    const base = clampNonNegative(basePercent);
    if (base <= 0) return null;

    const history = selectHistoryWindow(state.tradeHistory, config);
    const minMultiplier = Math.max(0.1, Math.min(config.takeProfitAdaptiveMinMultiplier, config.takeProfitAdaptiveMaxMultiplier));
    const maxMultiplier = Math.max(minMultiplier, Math.max(config.takeProfitAdaptiveMinMultiplier, config.takeProfitAdaptiveMaxMultiplier));

    switch (config.takeProfitMode) {
        case "fixed":
            return base;
        case "mfe_bootstrap":
            return state.mfeBootstrapPercent !== null && state.mfeBootstrapPercent > 0
                ? state.mfeBootstrapPercent
                : base;
        case "edge_weighted": {
            const multiplier = minMultiplier + (maxMultiplier - minMultiplier) * context.signalStrength;
            return base * multiplier;
        }
        case "expectancy_optimal":
            return optimizeTakeProfitByExpectancy(history, base, config) ?? base;
        case "regime_calibrated": {
            const globalOptimal = optimizeTakeProfitByExpectancy(history, base, config) ?? base;
            const regimeHistory = history.filter((record) => record.regimeKey === context.regimeKey);
            const regimeOptimal = optimizeTakeProfitByExpectancy(regimeHistory, base, config);
            if (regimeOptimal === null) return globalOptimal;

            const maturity = clamp(regimeHistory.length / Math.max(MIN_REGIME_SAMPLES, config.takeProfitAdaptiveRecentWindow), 0, 1);
            const blend = clamp(config.takeProfitAdaptiveRegimeBlend * maturity, 0, 1);
            return globalOptimal * (1 - blend) + regimeOptimal * blend;
        }
        case "information_coefficient": {
            const xs = history.map((record) => record.signalQuality);
            const ys = history.map((record) => record.mfePercent);
            const ic = pearsonCorrelation(xs, ys);
            if (ic === null) return base;
            const multiplier = clampMultiplier(minMultiplier, maxMultiplier, 1 + ic * config.takeProfitAdaptiveIcScale);
            return base * multiplier;
        }
        case "path_efficiency": {
            const winners = history.filter((record) => record.mfePercent > 0 && record.realizedPercent > 0);
            const efficiency = average(
                winners
                    .map((record) => clamp(record.realizedPercent / Math.max(record.mfePercent, EPSILON), 0, 1))
            );
            if (efficiency === null) return base;
            const multiplier = minMultiplier + (maxMultiplier - minMultiplier) * efficiency;
            return base * multiplier;
        }
        case "serial_dependency": {
            if (history.length < MIN_REGIME_SAMPLES) return base;
            const recentWindow = Math.max(3, Math.min(history.length, config.takeProfitAdaptiveRecentWindow));
            const recent = history.slice(-recentWindow);
            const recentWinRate = recent.filter((record) => record.win).length / recent.length;
            const overallWinRate = history.filter((record) => record.win).length / history.length;
            const delta = clamp(recentWinRate - overallWinRate, -0.5, 0.5);
            const multiplier = clampMultiplier(minMultiplier, maxMultiplier, 1 + delta * 0.9);
            return base * multiplier;
        }
        case "minimum_surprisal":
            return optimizeTakeProfitBySurprisal(history, base, config) ?? base;
        default:
            return base;
    }
}

function updatePositionExtremes(
    position: PositionState,
    positionState: AdaptivePositionTakeProfitState,
    candle: OHLCVData
): void {
    const favorablePrice = position.direction === "short" ? candle.low : candle.high;
    const adversePrice = position.direction === "short" ? candle.high : candle.low;

    positionState.maxFavorablePercent = Math.max(
        positionState.maxFavorablePercent,
        clampNonNegative(computeSignedMovePercent(position.entryPrice, favorablePrice, position.direction))
    );
    positionState.maxAdversePercent = Math.max(
        positionState.maxAdversePercent,
        clampNonNegative(-computeSignedMovePercent(position.entryPrice, adversePrice, position.direction))
    );
}

export function createAdaptiveTakeProfitState(
    data: OHLCVData[],
    config: NormalizedSettings,
    indicators: IndicatorSeries,
    _initialCapital: number
): AdaptiveTakeProfitState {
    let mfeBootstrapPercent: number | null = null;
    if (config.takeProfitMode === "mfe_bootstrap" && config.riskMode === "percentage" && config.takeProfitEnabled) {
        mfeBootstrapPercent = computeMfeBootstrapPercent(data, config);
    }
    return {
        data,
        atr: indicators.atr,
        positionStates: new WeakMap<PositionState, AdaptivePositionTakeProfitState>(),
        mfeBootstrapPercent,
        tradeHistory: [],
    };
}

export function resolveAdaptiveTakeProfitOverrides(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    direction: Direction,
    triggerPrice: number,
    entryBarIndex: number
): AdaptiveTakeProfitOverrides | null {
    if (config.riskMode !== "percentage" || config.takeProfitEnabled !== true) {
        return null;
    }

    const entryContext = buildEntryContext(state.data, state.atr, entryBarIndex, direction, triggerPrice);
    return {
        takeProfitPercent: resolveModeSpecificTakeProfitPercent(config, state, entryContext, config.takeProfitPercent),
    };
}

export function registerAdaptiveTakeProfitPosition(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    entryBarIndex: number
): void {
    if (config.riskMode !== "percentage" || config.takeProfitEnabled !== true) return;

    const entryContext = buildEntryContext(state.data, state.atr, entryBarIndex, position.direction, position.entryPrice);
    const resolvedTakeProfitPercent = position.takeProfitPrice !== null && Number.isFinite(position.takeProfitPrice) && position.entryPrice > 0
        ? clampNonNegative(Math.abs(((position.takeProfitPrice - position.entryPrice) / position.entryPrice) * 100))
        : null;

    const positionState: AdaptivePositionTakeProfitState = {
        registered: true,
        direction: position.direction,
        entryBarIndex,
        entryContext,
        resolvedTakeProfitPercent,
        maxFavorablePercent: 0,
        maxAdversePercent: 0,
    };

    state.positionStates.set(position, positionState);

    const entryCandle = state.data[entryBarIndex];
    if (entryCandle) {
        updatePositionExtremes(position, positionState, entryCandle);
    }
}

export function updateAdaptiveTakeProfitPosition(
    _config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    candle: OHLCVData,
    _barIndex: number
): AdaptiveTakeProfitExitSignal | null {
    const positionState = state.positionStates.get(position);
    if (!positionState) return null;
    updatePositionExtremes(position, positionState, candle);
    return null;
}

export function updateAdaptiveTakeProfitHistory(
    _config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    exitPrice: number,
    exitReason: NonNullable<Trade["exitReason"]>,
    _candle: OHLCVData,
    _closedCapital: number
): void {
    const positionState = state.positionStates.get(position);
    state.positionStates.delete(position);
    if (!positionState) return;

    const realizedPercent = computeSignedMovePercent(position.entryPrice, exitPrice, position.direction);
    const targetPercent = positionState.resolvedTakeProfitPercent ?? 0;
    const targetHit = exitReason === "take_profit"
        || (targetPercent > 0 && positionState.maxFavorablePercent >= targetPercent - EPSILON);

    state.tradeHistory.push({
        signalQuality: positionState.entryContext.signalQuality,
        signalStrength: positionState.entryContext.signalStrength,
        regimeKey: positionState.entryContext.regimeKey,
        mfePercent: positionState.maxFavorablePercent,
        maePercent: positionState.maxAdversePercent,
        realizedPercent,
        targetPercent,
        barsHeld: Math.max(0, position.barsInTrade),
        win: realizedPercent > 0,
        targetHit,
    });

    if (state.tradeHistory.length > DEFAULT_HISTORY_CAP) {
        state.tradeHistory.splice(0, state.tradeHistory.length - DEFAULT_HISTORY_CAP);
    }
}
