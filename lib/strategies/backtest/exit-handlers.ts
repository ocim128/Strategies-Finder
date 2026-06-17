
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
    openOnly?: boolean;
}

const DEFAULT_POSITION_EXIT_OPTIONS: PositionExitOptions = {};
export const OPEN_ONLY_POSITION_EXIT_OPTIONS: PositionExitOptions = { openOnly: true };
export const STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS: PositionExitOptions = { stopLossOnly: true };

export function canExitAfterMinimumHold(position: PositionState, config: NormalizedSettings): boolean {
    return !config.riskMinHoldEnabled
        || config.riskMinHoldBars <= 0
        || position.barsInTrade >= config.riskMinHoldBars;
}

function comparisonTolerance(left: number, right: number): number {
    const magnitude = Math.max(Math.abs(left), Math.abs(right));
    // Use relative tolerance (1e-10 of magnitude) so micro-prices like 4.5e-11
    // don't get a 1e-9 absolute floor that dwarfs the actual price differences.
    return magnitude > 0 ? magnitude * 1e-10 : 1e-12;
}

function greaterThanOrNearlyEqual(left: number, right: number): boolean {
    return left > right || Math.abs(left - right) <= comparisonTolerance(left, right);
}

function lessThanOrNearlyEqual(left: number, right: number): boolean {
    return left < right || Math.abs(left - right) <= comparisonTolerance(left, right);
}

function resolveStopLossExitPrice(
    candle: OHLCVData,
    stopLoss: number,
    isShortPosition: boolean
): number {
    if (!Number.isFinite(candle.open)) {
        return stopLoss;
    }

    // If the bar opens beyond the stop, the best available fill is the open.
    if (isShortPosition && greaterThanOrNearlyEqual(candle.open, stopLoss)) {
        return candle.open;
    }
    if (!isShortPosition && lessThanOrNearlyEqual(candle.open, stopLoss)) {
        return candle.open;
    }

    return stopLoss;
}

function resolveTakeProfitExitPrice(takeProfit: number): number {
    // Conservative fill model: once the target is touched, take-profit exits are
    // capped at the configured target instead of assuming favorable overshoot.
    return takeProfit;
}

function isStopLossHitAtOpen(
    candle: OHLCVData,
    stopLoss: number,
    isShortPosition: boolean
): boolean {
    if (!Number.isFinite(candle.open)) {
        return false;
    }

    return isShortPosition
        ? greaterThanOrNearlyEqual(candle.open, stopLoss)
        : lessThanOrNearlyEqual(candle.open, stopLoss);
}

function isTakeProfitHitAtOpen(
    candle: OHLCVData,
    takeProfit: number,
    isShortPosition: boolean
): boolean {
    if (!Number.isFinite(candle.open)) {
        return false;
    }

    return isShortPosition
        ? lessThanOrNearlyEqual(candle.open, takeProfit)
        : greaterThanOrNearlyEqual(candle.open, takeProfit);
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
    options: PositionExitOptions = DEFAULT_POSITION_EXIT_OPTIONS
): PositionExitTrigger | null {
    const isShortPosition = position.direction === 'short';
    const exitSide = exitSideForDirection(position.direction);

    // Check stop loss
    const stopLoss = position.stopLossPrice;
    if (stopLoss !== null) {
        const stopHit = options.openOnly
            ? isStopLossHitAtOpen(candle, stopLoss, isShortPosition)
            : isShortPosition
                ? greaterThanOrNearlyEqual(candle.high, stopLoss)
                : lessThanOrNearlyEqual(candle.low, stopLoss);
        if (stopHit) {
            const stopExitPrice = resolveStopLossExitPrice(candle, stopLoss, isShortPosition);
            return {
                exitPrice: applySlippage(stopExitPrice, exitSide, slippageRate),
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
        const takeHit = options.openOnly
            ? isTakeProfitHitAtOpen(candle, position.takeProfitPrice, isShortPosition)
            : isShortPosition
                ? lessThanOrNearlyEqual(candle.low, position.takeProfitPrice)
                : greaterThanOrNearlyEqual(candle.high, position.takeProfitPrice);
        if (takeHit) {
            const takeProfitExitPrice = resolveTakeProfitExitPrice(position.takeProfitPrice);
            return {
                exitPrice: applySlippage(takeProfitExitPrice, exitSide, slippageRate),
                exitSize: position.size,
                exitReason: 'take_profit',
            };
        }
    }

    if (options.openOnly) {
        return null;
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

    // Global max hold cap, gated by the minimum hold guard.
    if (
        canExitAfterMinimumHold(position, config) &&
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
    if (
        canExitAfterMinimumHold(position, config) &&
        config.timeStopBars > 0 &&
        position.barsInTrade >= config.timeStopBars
    ) {
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
