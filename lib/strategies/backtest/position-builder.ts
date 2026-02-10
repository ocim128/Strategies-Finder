
import { Signal } from '../../types/index';
import { NormalizedSettings, PositionState } from '../../types/backtest';
import { allowsSignalAsEntry, applySlippage, directionFactorFor, entrySideForDirection, signalToPositionDirection } from './backtest-utils';

export interface PositionBuilderParams {
    signal: Signal;
    barIndex: number;
    capital: number;
    initialCapital: number;
    positionSizePercent: number;
    commissionRate: number;
    slippageRate: number;
    settings: NormalizedSettings;
    atrArray: (number | null)[];
    tradeDirection: 'long' | 'short' | 'both' | 'combined';
    sizingMode: 'percent' | 'fixed';
    fixedTradeAmount: number;
}

export interface BuiltPosition {
    nextPosition: PositionState;
    entryCommission: number;
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
        atrArray,
        tradeDirection,
        sizingMode,
        fixedTradeAmount
    } = params;

    if (!allowsSignalAsEntry(signal.type, tradeDirection)) return null;

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

    const atrValue = needsAtr ? atrArray[barIndex] : null;

    if (needsAtr && (atrValue === null || atrValue === undefined)) return null;

    const allocatedCapital = (sizingMode === 'fixed' && fixedTradeAmount > 0)
        ? fixedTradeAmount
        : capital * (positionSizePercent / 100);

    if (!Number.isFinite(allocatedCapital) || allocatedCapital <= 0) return null;

    const tradeValue = allocatedCapital / (1 + commissionRate);
    const entryCommission = tradeValue * commissionRate;
    const direction = signalToPositionDirection(signal.type);
    const directionFactor = directionFactorFor(direction);
    const entrySide = entrySideForDirection(direction);
    const entryFillPrice = applySlippage(signal.price, entrySide, slippageRate);

    if (!Number.isFinite(entryFillPrice) || entryFillPrice <= 0 || !Number.isFinite(tradeValue) || tradeValue <= 0) return null;

    const shares = tradeValue / entryFillPrice;
    if (!Number.isFinite(shares) || shares <= 0) return null;

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
        if (config.stopLossEnabled && config.stopLossPercent > 0) {
            riskPerShare = entryFillPrice * (config.stopLossPercent / 100);
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
        if (config.stopLossEnabled && config.stopLossPercent > 0) {
            finalStopLossPrice = entryFillPrice * (1 - directionFactor * (config.stopLossPercent / 100));
        }
        if (config.takeProfitEnabled && config.takeProfitPercent > 0) {
            finalTakeProfitPrice = entryFillPrice * (1 + directionFactor * (config.takeProfitPercent / 100));
        }
    }

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
            breakEvenApplied: false
        },
        entryCommission
    };
}
