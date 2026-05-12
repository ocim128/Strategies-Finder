import { OHLCVData, Signal, type TradeDirection } from '../../types/index';
import {
    AdvancedSizingSettings,
    NormalizedSettings,
    PositionState,
    isDirectFractionTradeSizingMode,
    isSmartTradeSizingMode,
    usesFixedDollarSizing,
    type TradeSizingMode
} from '../../types/backtest';
import { allowsSignalAsEntry, applySlippage, directionFactorFor, entrySideForDirection, signalToPositionDirection } from './backtest-utils';
import { calculateKelly, type KellySizingState } from '../sizing/kelly-criterion';
import { type MartingaleState, resolveMartingaleMultiplier } from '../sizing/martingale';
import { type OptimalFState, calculateSecureF } from '../sizing/optimal-f';
import { resolveRiskParityMultiplier } from '../sizing/risk-parity';
import { average, clamp } from '../sizing/shared';
import { resolveVolTargetingMultiplier } from '../sizing/volatility-targeting';
import { resolveHistoricalLevelTargets } from './historical-levels';
const VELOCITY_MEMORY_MIN_MULTIPLIER = 0.75;
const VELOCITY_MEMORY_MAX_MULTIPLIER = 1.2;
const QUALITY_X_VELOCITY_MIN_MULTIPLIER = 0.72;
const QUALITY_X_VELOCITY_MAX_MULTIPLIER = 1.28;

export interface SmartSizingState {
    recentVelocityScores: number[];
    kellyState?: KellySizingState;
    martingaleState?: MartingaleState;
    optimalFState?: OptimalFState;
}

export interface PositionBuilderParams {
    signal: Signal;
    barIndex: number;
    capital: number;
    initialCapital: number;
    positionSizePercent: number;
    commissionRate: number;
    slippageRate: number;
    settings: NormalizedSettings;
    data: OHLCVData[];
    atrArray: (number | null)[];
    tradeDirection: TradeDirection;
    sizingMode: TradeSizingMode;
    fixedTradeAmount: number;
    advancedSizing?: AdvancedSizingSettings;
    smartSizingState?: SmartSizingState;
    effectiveStopLossPercent?: number;
    enablePercentageStopLoss?: boolean;
    effectiveTakeProfitPercent?: number | null;
}

export interface BuiltPosition {
    nextPosition: PositionState;
    entryCommission: number;
}

function resolveVelocityMemoryMultiplier(smartSizingState?: SmartSizingState): number {
    if (!smartSizingState || smartSizingState.recentVelocityScores.length === 0) {
        return 1;
    }

    const avgScore = average(smartSizingState.recentVelocityScores);
    const multiplier = 1 + avgScore * 0.2;
    return clamp(multiplier, VELOCITY_MEMORY_MIN_MULTIPLIER, VELOCITY_MEMORY_MAX_MULTIPLIER);
}

function computeDirectionalCloseLocation(candle: OHLCVData, direction: 'long' | 'short'): number {
    const range = candle.high - candle.low;
    if (!Number.isFinite(range) || range <= 0) return 0.5;
    const location = direction === 'short'
        ? (candle.high - candle.close) / range
        : (candle.close - candle.low) / range;
    return clamp(location, 0, 1);
}

function computeOppositeWickPenalty(candle: OHLCVData, direction: 'long' | 'short'): number {
    const range = candle.high - candle.low;
    if (!Number.isFinite(range) || range <= 0) return 0.5;

    const bodyTop = Math.max(candle.open, candle.close);
    const bodyBottom = Math.min(candle.open, candle.close);
    const oppositeWick = direction === 'short'
        ? Math.max(0, bodyBottom - candle.low)
        : Math.max(0, candle.high - bodyTop);
    return clamp(oppositeWick / range, 0, 1);
}

function computeRelativeVolume(data: OHLCVData[], barIndex: number): number {
    const start = Math.max(0, barIndex - 19);
    let sum = 0;
    let count = 0;
    for (let i = start; i <= barIndex; i++) {
        const value = data[i]?.volume;
        if (!Number.isFinite(value) || value <= 0) continue;
        sum += value;
        count += 1;
    }
    if (count === 0) return 1;
    const avgVolume = sum / count;
    const currentVolume = data[barIndex]?.volume;
    if (!Number.isFinite(currentVolume) || currentVolume <= 0 || avgVolume <= 0) return 1;
    return clamp(currentVolume / avgVolume, 0.5, 2);
}

function computeEntryQualityScore(
    data: OHLCVData[],
    sizingBarIndex: number,
    direction: 'long' | 'short',
    atrValue: number | null
): number {
    const candle = data[sizingBarIndex];
    if (!candle) return 0.5;

    const range = Math.max(candle.high - candle.low, 0);
    const bodyPercent = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
    const directionalClose = computeDirectionalCloseLocation(candle, direction);
    const oppositeWickPenalty = computeOppositeWickPenalty(candle, direction);
    const relativeVolume = computeRelativeVolume(data, sizingBarIndex);
    const volumeScore = clamp((relativeVolume - 0.75) / 0.85, 0, 1);
    const atrRangeScore = atrValue && atrValue > 0
        ? clamp((range / atrValue) / 1.8, 0, 1)
        : 0.5;
    const previousClose = sizingBarIndex > 0 ? data[sizingBarIndex - 1]?.close ?? candle.close : candle.close;
    const momentumScore = direction === 'short'
        ? (candle.close <= previousClose ? 1 : 0.2)
        : (candle.close >= previousClose ? 1 : 0.2);

    return clamp(
        bodyPercent * 0.2
        + directionalClose * 0.28
        + (1 - oppositeWickPenalty) * 0.16
        + volumeScore * 0.16
        + atrRangeScore * 0.1
        + momentumScore * 0.1,
        0,
        1
    );
}

function resolveQualityVelocityMultiplier(
    smartSizingState: SmartSizingState | undefined,
    data: OHLCVData[],
    sizingBarIndex: number,
    direction: 'long' | 'short',
    atrValue: number | null
): number {
    const velocityMultiplier = resolveVelocityMemoryMultiplier(smartSizingState);
    const entryQualityScore = computeEntryQualityScore(data, sizingBarIndex, direction, atrValue);
    const qualityMultiplier = 0.88 + entryQualityScore * 0.24;
    return clamp(
        velocityMultiplier * qualityMultiplier,
        QUALITY_X_VELOCITY_MIN_MULTIPLIER,
        QUALITY_X_VELOCITY_MAX_MULTIPLIER
    );
}

function resolveSizingMultiplier(
    sizingMode: TradeSizingMode,
    smartSizingState: SmartSizingState | undefined,
    data: OHLCVData[],
    sizingBarIndex: number,
    direction: 'long' | 'short',
    _triggerPrice: number | null,
    atrValue: number | null,
    advancedSizing?: AdvancedSizingSettings
): number {
    switch (sizingMode) {
        case 'smart_fixed_velocity_memory':
            return resolveVelocityMemoryMultiplier(smartSizingState);
        case 'smart_fixed_quality_x_velocity':
            return resolveQualityVelocityMultiplier(
                smartSizingState,
                data,
                sizingBarIndex,
                direction,
                atrValue
            );
        case 'volatility_targeting':
            return resolveVolTargetingMultiplier(data, sizingBarIndex, advancedSizing);
        case 'risk_parity':
            return resolveRiskParityMultiplier(data, sizingBarIndex, advancedSizing);
        case 'martingale':
            return resolveMartingaleMultiplier(smartSizingState?.martingaleState, advancedSizing);
        case 'anti_martingale':
            return resolveMartingaleMultiplier(smartSizingState?.martingaleState, advancedSizing);
        default:
            return 1;
    }
}

function resolveDirectAllocation(
    sizingMode: TradeSizingMode,
    capital: number,
    smartSizingState: SmartSizingState | undefined,
    advancedSizing?: AdvancedSizingSettings
): number | null {
    if (sizingMode === 'kelly_criterion') {
        const result = calculateKelly(smartSizingState?.kellyState, advancedSizing);
        return result.isValid ? capital * result.appliedFraction : null;
    }

    if (sizingMode === 'optimal_f' || sizingMode === 'secure_f') {
        const optimalFState = smartSizingState?.optimalFState;
        const cachedFraction = sizingMode === 'optimal_f'
            ? optimalFState?.calculatedOptimalF
            : optimalFState?.calculatedSecureF;

        if (Number.isFinite(cachedFraction) && (cachedFraction ?? 0) > 0) {
            return capital * Number(cachedFraction);
        }

        const tradeHistory = optimalFState?.tradeHistory ?? [];
        const result = calculateSecureF(tradeHistory, advancedSizing);
        const fraction = sizingMode === 'optimal_f' ? result.optimalF : result.secureF;
        return result.isValid ? capital * fraction : null;
    }

    return null;
}

export function resolveAllocatedCapital(
    sizingMode: TradeSizingMode,
    capital: number,
    positionSizePercent: number,
    fixedTradeAmount: number,
    data: OHLCVData[],
    sizingBarIndex: number,
    direction: 'long' | 'short',
    triggerPrice: number | null,
    atrValue: number | null,
    smartSizingState?: SmartSizingState,
    advancedSizing?: AdvancedSizingSettings
): number {
    const directAllocation = resolveDirectAllocation(
        sizingMode,
        capital,
        smartSizingState,
        advancedSizing
    );
    if (directAllocation !== null) {
        return directAllocation;
    }

    const usePercentBase = (sizingMode === 'martingale' || sizingMode === 'anti_martingale')
        && advancedSizing?.martingaleBaseSize === 'percent';
    const preferFixedFallback = isDirectFractionTradeSizingMode(sizingMode) && fixedTradeAmount > 0;
    const baseAllocation = !usePercentBase && (usesFixedDollarSizing(sizingMode) || preferFixedFallback) && fixedTradeAmount > 0
        ? fixedTradeAmount
        : capital * (positionSizePercent / 100);

    if ((!isSmartTradeSizingMode(sizingMode) && !isDirectFractionTradeSizingMode(sizingMode)) || baseAllocation <= 0) {
        return baseAllocation;
    }

    return baseAllocation * resolveSizingMultiplier(
        sizingMode,
        smartSizingState,
        data,
        sizingBarIndex,
        direction,
        triggerPrice,
        atrValue,
        advancedSizing
    );
}

/**
 * Constructs a new position based on a signal and current backtest state.
 * Handles sizing, risk management setup (SL/TP), and commission calculation.
 */
export function buildPositionFromSignal(params: PositionBuilderParams): BuiltPosition | null {
    const {
        signal,
        barIndex,
        capital,
        positionSizePercent,
        commissionRate,
        slippageRate,
        settings: config,
        data,
        atrArray,
        tradeDirection,
        sizingMode,
        fixedTradeAmount,
        advancedSizing,
        smartSizingState,
        effectiveStopLossPercent,
        enablePercentageStopLoss,
        effectiveTakeProfitPercent,
    } = params;

    if (!allowsSignalAsEntry(signal.type, tradeDirection)) return null;

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

    // For next_open entries, the execution bar's high/low are not known at the open.
    // Seed ATR-based risk from the last fully closed bar instead.
    const sizingBarIndex = config.executionModel === 'next_open' ? barIndex - 1 : barIndex;
    const atrBarIndex = sizingBarIndex;
    const atrValue = atrBarIndex >= 0 ? (atrArray[atrBarIndex] ?? null) : null;

    if (needsAtr && (atrValue === null || atrValue === undefined)) return null;

    const direction = signalToPositionDirection(signal.type);
    const directionFactor = directionFactorFor(direction);
    const entrySide = entrySideForDirection(direction);
    const entryFillPrice = applySlippage(signal.price, entrySide, slippageRate);
    if (!Number.isFinite(entryFillPrice) || entryFillPrice <= 0) return null;

    const stopLossPrice = (atrValue !== null && atrValue !== undefined)
        ? (config.stopLossAtr > 0
            ? entryFillPrice - directionFactor * config.stopLossAtr * atrValue
            : config.trailingAtr > 0
                ? entryFillPrice - directionFactor * config.trailingAtr * atrValue
                : null)
        : null;

    const takeProfitPrice = (atrValue !== null && atrValue !== undefined && config.takeProfitAtr > 0)
        ? entryFillPrice + directionFactor * config.takeProfitAtr * atrValue
        : null;

    let riskPerShare = 0;
    if (config.riskMode === 'percentage') {
        const activeStopLossPercent = Math.max(0, effectiveStopLossPercent ?? config.stopLossPercent);
        const stopLossIsEnabled = enablePercentageStopLoss ?? config.stopLossEnabled;
        const percentRiskPerShare = activeStopLossPercent > 0
            ? entryFillPrice * (activeStopLossPercent / 100)
            : 0;
        if (stopLossIsEnabled && percentRiskPerShare > 0) {
            riskPerShare = percentRiskPerShare;
        }
    } else if (atrValue !== null && atrValue !== undefined && config.stopLossAtr > 0) {
        riskPerShare = config.stopLossAtr * atrValue;
    }

    const partialTargetPrice = (riskPerShare > 0 && config.partialTakeProfitAtR > 0)
        ? entryFillPrice + directionFactor * riskPerShare * config.partialTakeProfitAtR
        : null;

    let finalStopLossPrice = stopLossPrice;
    let finalTakeProfitPrice = takeProfitPrice;

    if (config.riskMode === 'percentage') {
        const activeStopLossPercent = Math.max(0, effectiveStopLossPercent ?? config.stopLossPercent);
        const stopLossIsEnabled = enablePercentageStopLoss ?? config.stopLossEnabled;
        if (stopLossIsEnabled && activeStopLossPercent > 0) {
            finalStopLossPrice = entryFillPrice * (1 - directionFactor * (activeStopLossPercent / 100));
        }
        if (effectiveTakeProfitPercent !== undefined) {
            finalTakeProfitPrice = effectiveTakeProfitPercent !== null && effectiveTakeProfitPercent > 0
                ? entryFillPrice * (1 + directionFactor * (effectiveTakeProfitPercent / 100))
                : null;
        } else if (config.takeProfitEnabled && config.takeProfitPercent > 0) {
            finalTakeProfitPrice = entryFillPrice * (1 + directionFactor * (config.takeProfitPercent / 100));
        }
    }

    const historicalTargets = resolveHistoricalLevelTargets({
        data,
        entryBarIndex: barIndex,
        entryPrice: entryFillPrice,
        direction,
        config,
        atrArray,
        baseStopLossPrice: finalStopLossPrice,
        baseTakeProfitPrice: finalTakeProfitPrice,
    });
    finalStopLossPrice = historicalTargets.stopLossPrice;
    finalTakeProfitPrice = historicalTargets.takeProfitPrice;

    const allocatedCapital = resolveAllocatedCapital(
        sizingMode,
        capital,
        positionSizePercent,
        fixedTradeAmount,
        data,
        sizingBarIndex,
        direction,
        (typeof signal.triggerPrice === 'number' && Number.isFinite(signal.triggerPrice) ? signal.triggerPrice : signal.price) ?? null,
        atrValue,
        smartSizingState,
        advancedSizing
    );
    if (!Number.isFinite(allocatedCapital) || allocatedCapital <= 0) return null;

    const tradeValue = allocatedCapital / (1 + commissionRate);
    const entryCommission = tradeValue * commissionRate;
    if (!Number.isFinite(tradeValue) || tradeValue <= 0) return null;

    const shares = tradeValue / entryFillPrice;
    if (!Number.isFinite(shares) || shares <= 0) return null;

    return {
        nextPosition: {
            direction,
            entryTime: signal.time,
            entryPrice: entryFillPrice,
            size: shares,
            entryCommissionPerShare: shares > 0 ? entryCommission / shares : 0,
            stopLossPrice: finalStopLossPrice,
            takeProfitPrice: finalTakeProfitPrice,
            riskPerShare,
            barsInTrade: 0,
            extremePrice: entryFillPrice,
            partialTargetPrice,
            partialTaken: false,
            breakEvenApplied: false,
            realizedPnl: 0,
        },
        entryCommission
    };
}
