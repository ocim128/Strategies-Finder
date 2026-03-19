
import { OHLCVData, Trade } from '../../types/index';
import { NormalizedSettings, PositionState } from '../../types/backtest';
import { applySlippage, directionFactorFor, exitSideForDirection } from './backtest-utils';

export interface PositionExitTrigger {
    exitPrice: number;
    exitSize: number;
    exitReason: NonNullable<Trade['exitReason']>;
}

export interface PositionExitOptions {
    stopLossOnly?: boolean;
}

function comparisonTolerance(left: number, right: number): number {
    return Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right), 1) * 1e-12);
}

function greaterThanOrNearlyEqual(left: number, right: number): boolean {
    return left > right || Math.abs(left - right) <= comparisonTolerance(left, right);
}

function lessThanOrNearlyEqual(left: number, right: number): boolean {
    return left < right || Math.abs(left - right) <= comparisonTolerance(left, right);
}

/**
 * Checks and processes various exit conditions for a position.
 * Returns the first exit trigger for this bar, if any.
 */
export function processPositionExits(
    candle: OHLCVData,
    position: PositionState,
    config: NormalizedSettings,
    slippageRate: number,
    options: PositionExitOptions = {}
): PositionExitTrigger | null {
    const isShortPosition = position.direction === 'short';
    const exitSide = exitSideForDirection(position.direction);

    // Check stop loss
    const stopLoss = position.stopLossPrice;
    if (stopLoss !== null) {
        const stopHit = isShortPosition
            ? greaterThanOrNearlyEqual(candle.high, stopLoss)
            : lessThanOrNearlyEqual(candle.low, stopLoss);
        if (stopHit) {
            return {
                exitPrice: applySlippage(stopLoss, exitSide, slippageRate),
                exitSize: position.size,
                exitReason: 'stop_loss',
            };
        }
    }

    if (options.stopLossOnly) {
        return null;
    }

    // Check take profit (independent of stop loss)
    if (position.takeProfitPrice !== null) {
        const takeHit = isShortPosition
            ? lessThanOrNearlyEqual(candle.low, position.takeProfitPrice)
            : greaterThanOrNearlyEqual(candle.high, position.takeProfitPrice);
        if (takeHit) {
            return {
                exitPrice: applySlippage(position.takeProfitPrice, exitSide, slippageRate),
                exitSize: position.size,
                exitReason: 'take_profit',
            };
        }
    }

    // Check partial take profit
    if (!position.partialTaken && position.partialTargetPrice !== null) {
        const partialHit = isShortPosition
            ? lessThanOrNearlyEqual(candle.low, position.partialTargetPrice)
            : greaterThanOrNearlyEqual(candle.high, position.partialTargetPrice);
        if (partialHit) {
            const partialSize = position.size * (config.partialTakeProfitPercent / 100);
            if (partialSize > 0) {
                position.partialTaken = partialSize < position.size;
                return {
                    exitPrice: applySlippage(position.partialTargetPrice, exitSide, slippageRate),
                    exitSize: partialSize,
                    exitReason: 'partial',
                };
            }
        }
    }

    // Global max hold cap (hard exit regardless of PnL)
    if (
        config.riskMaxHoldEnabled &&
        config.riskMaxHoldBars > 0 &&
        position.barsInTrade >= config.riskMaxHoldBars
    ) {
        return {
            exitPrice: applySlippage(candle.close, exitSide, slippageRate),
            exitSize: position.size,
            exitReason: 'time_stop',
        };
    }

    // Time stop
    if (config.timeStopBars > 0 && position.barsInTrade >= config.timeStopBars) {
        const isLosing = isShortPosition ? candle.close >= position.entryPrice : candle.close <= position.entryPrice;
        if (!position.partialTaken && isLosing) {
            return {
                exitPrice: applySlippage(candle.close, exitSide, slippageRate),
                exitSize: position.size,
                exitReason: 'time_stop',
            };
        }
    }

    return null;
}


/**
 * Updates position state variables like trailing stops and extreme prices.
 * Should be called after exit checks if the position is still open.
 */
export function updatePositionState(
    candle: OHLCVData,
    position: PositionState,
    config: NormalizedSettings,
    atrValue: number | null | undefined
): void {
    const directionFactor = directionFactorFor(position.direction);
    const isShortPosition = position.direction === 'short';

    if (atrValue !== null && atrValue !== undefined) {
        // Break-even
        if (config.breakEvenAtR > 0 && position.riskPerShare > 0 && !position.breakEvenApplied) {
            const breakEvenTarget = position.entryPrice + directionFactor * position.riskPerShare * config.breakEvenAtR;
            const breakEvenHit = isShortPosition
                ? lessThanOrNearlyEqual(candle.low, breakEvenTarget)
                : greaterThanOrNearlyEqual(candle.high, breakEvenTarget);
            if (breakEvenHit) {
                position.stopLossPrice = position.stopLossPrice === null
                    ? position.entryPrice
                    : isShortPosition
                        ? Math.min(position.stopLossPrice, position.entryPrice)
                        : Math.max(position.stopLossPrice, position.entryPrice);
                position.breakEvenApplied = true;
            }
        }

        // Trailing stop
        if (config.trailingAtr > 0) {
            const trailStop = position.extremePrice - directionFactor * atrValue * config.trailingAtr;
            const shouldUpdateStop = position.stopLossPrice === null
                || (isShortPosition ? trailStop < position.stopLossPrice : trailStop > position.stopLossPrice);
            if (shouldUpdateStop) {
                position.stopLossPrice = trailStop;
            }
        }
    }

    // Percentage-based break-even (works without ATR or stop loss)
    if (config.breakEvenPercent > 0 && !position.breakEvenApplied) {
        const targetMove = position.entryPrice * (config.breakEvenPercent / 100);
        const breakEvenTarget = position.entryPrice + directionFactor * targetMove;
        const breakEvenHit = isShortPosition
            ? lessThanOrNearlyEqual(candle.low, breakEvenTarget)
            : greaterThanOrNearlyEqual(candle.high, breakEvenTarget);
        if (breakEvenHit) {
            position.stopLossPrice = position.entryPrice;
            position.breakEvenApplied = true;
        }
    }

    // Extreme price update
    position.extremePrice = isShortPosition
        ? Math.min(position.extremePrice, candle.low)
        : Math.max(position.extremePrice, candle.high);
}
