
import { OHLCVData, Trade } from '../../types/index';
import { NormalizedSettings, PositionState } from '../../types/backtest';
import { applySlippage, directionFactorFor, exitSideForDirection } from './backtest-utils';

export type ExitCallback = (exitPrice: number, exitSize: number, exitReason: Trade['exitReason']) => void;

/**
 * Checks and processes various exit conditions for a position.
 * Returns true if the position was fully closed.
 */
export function processPositionExits(
    candle: OHLCVData,
    position: PositionState,
    config: NormalizedSettings,
    slippageRate: number,
    onExit: ExitCallback
): boolean {
    const isShortPosition = position.direction === 'short';
    const exitSide = exitSideForDirection(position.direction);

    // Check stop loss
    const stopLoss = position.stopLossPrice;
    if (stopLoss !== null) {
        const stopHit = isShortPosition ? candle.high >= stopLoss : candle.low <= stopLoss;
        if (stopHit) {
            const exitPrice = applySlippage(stopLoss, exitSide, slippageRate);
            onExit(exitPrice, position.size, 'stop_loss');
            return true; // Exit fully
        }
    }

    // Check take profit (independent of stop loss)
    if (position.takeProfitPrice !== null) {
        const takeHit = isShortPosition ? candle.low <= position.takeProfitPrice : candle.high >= position.takeProfitPrice;
        if (takeHit) {
            const exitPrice = applySlippage(position.takeProfitPrice, exitSide, slippageRate);
            onExit(exitPrice, position.size, 'take_profit');
            return true; // Exit fully
        }
    }

    // Check partial take profit
    if (!position.partialTaken && position.partialTargetPrice !== null) {
        const partialHit = isShortPosition ? candle.low <= position.partialTargetPrice : candle.high >= position.partialTargetPrice;
        if (partialHit) {
            const partialSize = position.size * (config.partialTakeProfitPercent / 100);
            if (partialSize > 0) {
                const exitPrice = applySlippage(position.partialTargetPrice, exitSide, slippageRate);
                onExit(exitPrice, partialSize, 'partial');
                // Position size is updated by the engine callback.
                if (position.size > 0) position.partialTaken = true;

                if (position.size <= 0) return true;
            }
        }
    }

    // Time stop
    if (config.timeStopBars > 0 && position.barsInTrade >= config.timeStopBars) {
        const isLosing = isShortPosition ? candle.close >= position.entryPrice : candle.close <= position.entryPrice;
        if (!position.partialTaken && isLosing) {
            const exitPrice = applySlippage(candle.close, exitSide, slippageRate);
            onExit(exitPrice, position.size, 'time_stop');
            return true;
        }
    }

    return false;
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
            const breakEvenHit = isShortPosition ? candle.low <= breakEvenTarget : candle.high >= breakEvenTarget;
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

    // Extreme price update
    position.extremePrice = isShortPosition
        ? Math.min(position.extremePrice, candle.low)
        : Math.max(position.extremePrice, candle.high);
}
