/**
 * Replay Trade Engine
 * 
 * Bar-by-bar trade simulation engine for the replay system.
 * Tracks open positions, calculates unrealized PnL, and manages exits.
 */

import type { OHLCVData, Signal, Trade, Time } from '../strategies/types';
import type {
    OpenPosition,
    LiveTradeState,
    TradeEngineConfig,
    TradeEvent,
} from './liveTradeTypes';
import { createInitialTradeState } from './liveTradeTypes';
import { calculateATR } from '../strategies/indicators';

// ============================================================================
// Helper Functions (mirroring backtest.ts logic)
// ============================================================================

function signalToPositionDirection(type: Signal['type']): 'long' | 'short' {
    return type === 'buy' ? 'long' : 'short';
}

function directionFactorFor(direction: 'long' | 'short'): number {
    return direction === 'short' ? -1 : 1;
}

function entrySideForDirection(direction: 'long' | 'short'): 'buy' | 'sell' {
    return direction === 'short' ? 'sell' : 'buy';
}

function exitSideForDirection(direction: 'long' | 'short'): 'buy' | 'sell' {
    return direction === 'short' ? 'buy' : 'sell';
}

function applySlippage(price: number, side: 'buy' | 'sell', slippageRate: number): number {
    if (!Number.isFinite(slippageRate) || slippageRate <= 0) return price;
    return side === 'buy' ? price * (1 + slippageRate) : price * (1 - slippageRate);
}

function allowsSignalAsEntry(signalType: Signal['type'], tradeDirection: 'long' | 'short' | 'both'): boolean {
    if (tradeDirection === 'both') return true;
    if (tradeDirection === 'short') return signalType === 'sell';
    return signalType === 'buy';
}

// ============================================================================
// Replay Trade Engine
// ============================================================================

export class ReplayTradeEngine {
    private config: TradeEngineConfig;
    private state: LiveTradeState;
    private tradeId: number = 0;
    private atrSeries: (number | null)[] = [];
    private eventListeners: ((event: TradeEvent) => void)[] = [];
    private slippageRate: number = 0;
    private commissionRate: number = 0;

    constructor(config: TradeEngineConfig) {
        this.config = config;
        this.state = createInitialTradeState(config.initialCapital);
        this.slippageRate = config.slippageBps / 10000;
        this.commissionRate = config.commissionPercent / 100;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public Methods
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Pre-compute ATR series for the entire dataset.
     * Call this once before processing bars.
     */
    public precompute(data: OHLCVData[]): void {
        const highs = data.map(d => d.high);
        const lows = data.map(d => d.low);
        const closes = data.map(d => d.close);

        const needsAtr =
            this.config.stopLossAtr > 0 ||
            this.config.takeProfitAtr > 0 ||
            this.config.trailingAtr > 0 ||
            this.config.partialTakeProfitAtR > 0 ||
            this.config.breakEvenAtR > 0;

        this.atrSeries = needsAtr
            ? calculateATR(highs, lows, closes, this.config.atrPeriod)
            : [];
    }

    /**
     * Process a single bar and return updated state.
     * This is the core method called during replay advancement.
     */
    public processBar(
        candle: OHLCVData,
        barIndex: number,
        signals: Signal[]
    ): LiveTradeState {
        this.state.currentBarIndex = barIndex;
        this.state.currentPrice = candle.close;

        // 1. Manage existing position (SL/TP checks, trailing, etc.)
        if (this.state.position) {
            this.manageOpenPosition(candle, barIndex);
        }

        // 2. Process signals for this bar
        for (const signal of signals) {
            this.processSignal(signal, candle, barIndex);
        }

        // 3. Update unrealized PnL
        this.updateUnrealizedPnL(candle);

        return this.getState();
    }

    /**
     * Force close any open position (e.g., at end of replay).
     */
    public closePositionAtMarket(candle: OHLCVData, barIndex: number): Trade | null {
        if (!this.state.position) return null;

        const exitPrice = applySlippage(
            candle.close,
            exitSideForDirection(this.state.position.direction),
            this.slippageRate
        );

        return this.closePosition(exitPrice, candle.time, barIndex, 'end-of-data');
    }

    /**
     * Get current trade state (returns a copy).
     */
    public getState(): LiveTradeState {
        return { ...this.state };
    }

    /**
     * Get current open position (or null).
     */
    public getPosition(): OpenPosition | null {
        return this.state.position ? { ...this.state.position } : null;
    }

    /**
     * Reset to initial state.
     */
    public reset(): void {
        this.state = createInitialTradeState(this.config.initialCapital);
        this.tradeId = 0;
        this.atrSeries = [];
    }

    /**
     * Subscribe to trade events.
     */
    public onTradeEvent(listener: (event: TradeEvent) => void): () => void {
        this.eventListeners.push(listener);
        return () => {
            const idx = this.eventListeners.indexOf(listener);
            if (idx >= 0) this.eventListeners.splice(idx, 1);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private: Position Management
    // ─────────────────────────────────────────────────────────────────────────

    private manageOpenPosition(candle: OHLCVData, barIndex: number): void {
        const position = this.state.position!;
        position.barsInTrade += 1;

        const directionFactor = directionFactorFor(position.direction);
        const isShort = position.direction === 'short';
        const exitSide = exitSideForDirection(position.direction);

        // Check stop loss
        if (position.stopLossPrice !== null) {
            const stopHit = isShort
                ? candle.high >= position.stopLossPrice
                : candle.low <= position.stopLossPrice;
            if (stopHit) {
                const exitPrice = applySlippage(position.stopLossPrice, exitSide, this.slippageRate);
                this.closePosition(exitPrice, candle.time, barIndex, 'stop-loss');
                return;
            }
        }

        // Check take profit
        if (position.takeProfitPrice !== null) {
            const tpHit = isShort
                ? candle.low <= position.takeProfitPrice
                : candle.high >= position.takeProfitPrice;
            if (tpHit) {
                const exitPrice = applySlippage(position.takeProfitPrice, exitSide, this.slippageRate);
                this.closePosition(exitPrice, candle.time, barIndex, 'take-profit');
                return;
            }
        }

        // Check partial take profit
        if (!position.partialTaken && position.partialTargetPrice !== null) {
            const partialHit = isShort
                ? candle.low <= position.partialTargetPrice
                : candle.high >= position.partialTargetPrice;
            if (partialHit) {
                this.takePartialProfit(candle, barIndex);
            }
        }

        // Check time stop
        if (this.config.timeStopBars > 0 && position.barsInTrade >= this.config.timeStopBars) {
            const isLosing = isShort
                ? candle.close >= position.entryPrice
                : candle.close <= position.entryPrice;
            if (!position.partialTaken && isLosing) {
                const exitPrice = applySlippage(candle.close, exitSide, this.slippageRate);
                this.closePosition(exitPrice, candle.time, barIndex, 'time-stop');
                return;
            }
        }

        // Update trailing stop and break-even
        const atrValue = this.atrSeries[barIndex];
        if (atrValue !== null && atrValue !== undefined) {
            // Break-even check
            if (this.config.breakEvenAtR > 0 && position.riskPerShare > 0 && !position.breakEvenApplied) {
                const breakEvenTarget = position.entryPrice + directionFactor * position.riskPerShare * this.config.breakEvenAtR;
                const breakEvenHit = isShort
                    ? candle.low <= breakEvenTarget
                    : candle.high >= breakEvenTarget;
                if (breakEvenHit) {
                    position.stopLossPrice = position.stopLossPrice === null
                        ? position.entryPrice
                        : isShort
                            ? Math.min(position.stopLossPrice, position.entryPrice)
                            : Math.max(position.stopLossPrice, position.entryPrice);
                    position.breakEvenApplied = true;
                    this.emitEvent({
                        type: 'stop-updated',
                        position: { ...position },
                        barIndex,
                    });
                }
            }

            // Trailing stop update
            if (this.config.trailingAtr > 0) {
                const trailStop = position.extremePrice - directionFactor * atrValue * this.config.trailingAtr;
                const shouldUpdateStop = position.stopLossPrice === null
                    || (isShort ? trailStop < position.stopLossPrice : trailStop > position.stopLossPrice);
                if (shouldUpdateStop) {
                    position.stopLossPrice = trailStop;
                    this.emitEvent({
                        type: 'stop-updated',
                        position: { ...position },
                        barIndex,
                    });
                }
            }
        }

        // Update extreme price for trailing
        position.extremePrice = isShort
            ? Math.min(position.extremePrice, candle.low)
            : Math.max(position.extremePrice, candle.high);
    }

    private processSignal(signal: Signal, candle: OHLCVData, barIndex: number): void {
        const signalDirection = signalToPositionDirection(signal.type);

        if (!this.state.position) {
            // Try to open position
            if (allowsSignalAsEntry(signal.type, this.config.tradeDirection)) {
                this.openPosition(signal, candle, barIndex);
            }
        } else {
            // Check for exit signal (opposite direction)
            if (this.state.position.direction !== signalDirection) {
                // Check same-bar exit restriction
                const isSameBarEntry = candle.time === this.state.position.entryTime;
                if (!this.config.allowSameBarExit && isSameBarEntry) {
                    return;
                }

                const exitPrice = applySlippage(
                    signal.price,
                    exitSideForDirection(this.state.position.direction),
                    this.slippageRate
                );
                this.closePosition(exitPrice, candle.time, barIndex, 'signal');

                // If tradeDirection is 'both', open new position in opposite direction
                if (this.config.tradeDirection === 'both') {
                    this.openPosition(signal, candle, barIndex);
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private: Open/Close Position
    // ─────────────────────────────────────────────────────────────────────────

    private openPosition(signal: Signal, _candle: OHLCVData, barIndex: number): void {
        const atrValue = this.atrSeries[barIndex];
        const direction = signalToPositionDirection(signal.type);
        const directionFactor = directionFactorFor(direction);
        const entrySide = entrySideForDirection(direction);

        // Calculate position size
        const allocatedCapital = this.state.equity * (this.config.positionSizePercent / 100);
        if (!Number.isFinite(allocatedCapital) || allocatedCapital <= 0) return;

        const tradeValue = allocatedCapital / (1 + this.commissionRate);
        const entryFillPrice = applySlippage(signal.price, entrySide, this.slippageRate);
        if (!Number.isFinite(entryFillPrice) || entryFillPrice <= 0) return;

        const shares = tradeValue / entryFillPrice;
        if (!Number.isFinite(shares) || shares <= 0) return;

        const entryCommission = tradeValue * this.commissionRate;

        // Calculate stop/take profit levels
        let stopLossPrice: number | null = null;
        let takeProfitPrice: number | null = null;
        let riskPerShare = 0;

        if (this.config.riskMode === 'percentage') {
            if (this.config.stopLossEnabled && this.config.stopLossPercent > 0) {
                stopLossPrice = entryFillPrice * (1 - directionFactor * (this.config.stopLossPercent / 100));
                riskPerShare = entryFillPrice * (this.config.stopLossPercent / 100);
            }
            if (this.config.takeProfitEnabled && this.config.takeProfitPercent > 0) {
                takeProfitPrice = entryFillPrice * (1 + directionFactor * (this.config.takeProfitPercent / 100));
            }
        } else if (atrValue !== null && atrValue !== undefined) {
            if (this.config.stopLossAtr > 0) {
                stopLossPrice = entryFillPrice - directionFactor * this.config.stopLossAtr * atrValue;
                riskPerShare = this.config.stopLossAtr * atrValue;
            } else if (this.config.trailingAtr > 0) {
                stopLossPrice = entryFillPrice - directionFactor * this.config.trailingAtr * atrValue;
            }
            if (this.config.takeProfitAtr > 0) {
                takeProfitPrice = entryFillPrice + directionFactor * this.config.takeProfitAtr * atrValue;
            }
        }

        const partialTargetPrice = (riskPerShare > 0 && this.config.partialTakeProfitAtR > 0)
            ? entryFillPrice + directionFactor * riskPerShare * this.config.partialTakeProfitAtR
            : null;

        // Create position
        const position: OpenPosition = {
            direction,
            entryTime: signal.time,
            entryPrice: entryFillPrice,
            size: shares,
            stopLossPrice,
            takeProfitPrice,
            unrealizedPnL: 0,
            unrealizedPnLPercent: 0,
            barsInTrade: 0,
            extremePrice: entryFillPrice,
            riskPerShare,
            partialTargetPrice,
            partialTaken: false,
            breakEvenApplied: false,
        };

        // Apply entry commission
        this.state.equity -= entryCommission;
        this.state.position = position;

        this.emitEvent({
            type: 'position-opened',
            position: { ...position },
            barIndex,
        });
    }

    private closePosition(
        exitPrice: number,
        exitTime: Time,
        barIndex: number,
        exitReason: TradeEvent['exitReason']
    ): Trade | null {
        const position = this.state.position;
        if (!position) return null;

        const directionFactor = directionFactorFor(position.direction);
        const exitValue = position.size * exitPrice;
        const entryValue = position.size * position.entryPrice;
        const commission = exitValue * this.commissionRate;

        const rawPnl = (exitValue - entryValue) * directionFactor;
        const totalPnl = rawPnl - commission; // Entry commission already deducted
        const pnlPercent = entryValue > 0 ? (rawPnl / entryValue) * 100 : 0;

        // Update equity
        this.state.equity += rawPnl - commission;
        this.state.realizedPnL += totalPnl;

        // Create trade record
        const trade: Trade = {
            id: ++this.tradeId,
            type: position.direction,
            entryTime: position.entryTime,
            entryPrice: position.entryPrice,
            exitTime,
            exitPrice,
            pnl: totalPnl,
            pnlPercent,
            size: position.size,
            fees: commission,
        };

        this.state.trades.push(trade);

        this.emitEvent({
            type: 'position-closed',
            position: { ...position },
            trade,
            barIndex,
            exitReason,
        });

        this.state.position = null;
        this.state.unrealizedPnL = 0;

        return trade;
    }

    private takePartialProfit(candle: OHLCVData, barIndex: number): void {
        const position = this.state.position;
        if (!position || position.partialTargetPrice === null) return;

        const partialSize = position.size * (this.config.partialTakeProfitPercent / 100);
        if (partialSize <= 0) return;

        const exitSide = exitSideForDirection(position.direction);
        const exitPrice = applySlippage(position.partialTargetPrice, exitSide, this.slippageRate);

        const directionFactor = directionFactorFor(position.direction);
        const exitValue = partialSize * exitPrice;
        const entryValue = partialSize * position.entryPrice;
        const commission = exitValue * this.commissionRate;

        const rawPnl = (exitValue - entryValue) * directionFactor;
        const totalPnl = rawPnl - commission;
        const pnlPercent = entryValue > 0 ? (rawPnl / entryValue) * 100 : 0;

        // Update equity and position size
        this.state.equity += rawPnl - commission;
        this.state.realizedPnL += totalPnl;
        position.size -= partialSize;
        position.partialTaken = true;

        // Create partial trade record
        const trade: Trade = {
            id: ++this.tradeId,
            type: position.direction,
            entryTime: position.entryTime,
            entryPrice: position.entryPrice,
            exitTime: candle.time,
            exitPrice,
            pnl: totalPnl,
            pnlPercent,
            size: partialSize,
            fees: commission,
        };

        this.state.trades.push(trade);

        this.emitEvent({
            type: 'partial-closed',
            position: { ...position },
            trade,
            barIndex,
            exitReason: 'partial',
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private: PnL Calculation
    // ─────────────────────────────────────────────────────────────────────────

    private updateUnrealizedPnL(candle: OHLCVData): void {
        if (!this.state.position) {
            this.state.unrealizedPnL = 0;
            return;
        }

        const position = this.state.position;
        const directionFactor = directionFactorFor(position.direction);
        const unrealizedPnL = (candle.close - position.entryPrice) * position.size * directionFactor;
        const entryValue = position.size * position.entryPrice;
        const unrealizedPnLPercent = entryValue > 0 ? (unrealizedPnL / entryValue) * 100 : 0;

        position.unrealizedPnL = unrealizedPnL;
        position.unrealizedPnLPercent = unrealizedPnLPercent;
        this.state.unrealizedPnL = unrealizedPnL;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private: Event Emission
    // ─────────────────────────────────────────────────────────────────────────

    private emitEvent(event: TradeEvent): void {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('[ReplayTradeEngine] Error in event listener:', err);
            }
        }
    }
}
