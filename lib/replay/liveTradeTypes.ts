/**
 * Live Trade Types
 * 
 * Type definitions for tracking open positions and trade state
 * during replay and live signal modes.
 */

import type { Time, Trade, Signal, BacktestSettings } from '../strategies/types';

// ============================================================================
// Open Position State
// ============================================================================

/**
 * Represents a currently open trade position.
 * Updated each bar with latest PnL calculations.
 */
export interface OpenPosition {
    /** Position direction */
    direction: 'long' | 'short';

    /** Time when position was opened */
    entryTime: Time;

    /** Entry fill price (after slippage) */
    entryPrice: number;

    /** Position size in units */
    size: number;

    /** Current stop loss price (may trail) */
    stopLossPrice: number | null;

    /** Take profit target price */
    takeProfitPrice: number | null;

    /** Mark-to-market unrealized PnL */
    unrealizedPnL: number;

    /** Unrealized PnL as percentage of entry value */
    unrealizedPnLPercent: number;

    /** Number of bars since entry */
    barsInTrade: number;

    /** Highest (long) or lowest (short) price since entry for trailing stop */
    extremePrice: number;

    /** Risk per share for R-multiple calculations */
    riskPerShare: number;

    /** Partial take profit target (if using R-based partials) */
    partialTargetPrice: number | null;

    /** Whether partial profit has been taken */
    partialTaken: boolean;

    /** Whether stop has been moved to break-even */
    breakEvenApplied: boolean;
}

// ============================================================================
// Live Trade State
// ============================================================================

/**
 * Complete bar-by-bar trade state for replay/live modes.
 * This is the full snapshot of trading state at any point in time.
 */
export interface LiveTradeState {
    /** Currently open position (null if flat) */
    position: OpenPosition | null;

    /** Current account equity (capital + unrealized PnL) */
    equity: number;

    /** Total realized PnL from closed trades */
    realizedPnL: number;

    /** Current unrealized PnL (0 if no position) */
    unrealizedPnL: number;

    /** List of completed trades */
    trades: Trade[];

    /** Signal waiting to be executed (for next-bar execution models) */
    pendingSignal: Signal | null;

    /** Current bar index in the dataset */
    currentBarIndex: number;

    /** Current price (last close) */
    currentPrice: number;
}

// ============================================================================
// Trade Engine Configuration
// ============================================================================

/**
 * Configuration for the replay trade engine.
 * Mirrors relevant fields from BacktestSettings.
 */
export interface TradeEngineConfig {
    /** Initial account capital */
    initialCapital: number;

    /** Position size as percentage of capital */
    positionSizePercent: number;

    /** Commission rate in percentage */
    commissionPercent: number;

    /** Slippage in basis points */
    slippageBps: number;

    /** ATR period for volatility-based exits */
    atrPeriod: number;

    /** Stop loss in ATR multiples (0 = disabled) */
    stopLossAtr: number;

    /** Take profit in ATR multiples (0 = disabled) */
    takeProfitAtr: number;

    /** Trailing stop in ATR multiples (0 = disabled) */
    trailingAtr: number;

    /** Partial take profit at R-multiple (0 = disabled) */
    partialTakeProfitAtR: number;

    /** Percent of position to close at partial target */
    partialTakeProfitPercent: number;

    /** Move stop to break-even at R-multiple (0 = disabled) */
    breakEvenAtR: number;

    /** Time-based stop in bars (0 = disabled) */
    timeStopBars: number;

    /** Risk mode for percentage-based stops */
    riskMode: 'simple' | 'advanced' | 'percentage';

    /** Stop loss as percentage (for percentage mode) */
    stopLossPercent: number;

    /** Take profit as percentage (for percentage mode) */
    takeProfitPercent: number;

    /** Whether stop loss is enabled (percentage mode) */
    stopLossEnabled: boolean;

    /** Whether take profit is enabled (percentage mode) */
    takeProfitEnabled: boolean;

    /** Execution model: when signals are filled */
    executionModel: 'signal_close' | 'next_open' | 'next_close';

    /** Allow exits on the same bar as entry */
    allowSameBarExit: boolean;

    /** Trade direction filter */
    tradeDirection: 'long' | 'short' | 'both';
}

// ============================================================================
// Trade Events
// ============================================================================

/**
 * Event emitted when a position is opened or closed.
 */
export interface TradeEvent {
    type: 'position-opened' | 'position-closed' | 'partial-closed' | 'stop-updated';

    /** The position state at time of event */
    position: OpenPosition;

    /** For close events, the completed trade */
    trade?: Trade;

    /** Bar index when event occurred */
    barIndex: number;

    /** Exit reason for close events */
    exitReason?: 'signal' | 'stop-loss' | 'take-profit' | 'partial' | 'time-stop' | 'end-of-data';
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create default trade engine configuration from backtest settings.
 */
export function createTradeEngineConfig(
    settings: BacktestSettings,
    capital: number = 10000,
    positionSize: number = 100,
    commission: number = 0.1
): TradeEngineConfig {
    return {
        initialCapital: capital,
        positionSizePercent: positionSize,
        commissionPercent: commission,
        slippageBps: settings.slippageBps ?? 0,
        atrPeriod: settings.atrPeriod ?? 14,
        stopLossAtr: settings.stopLossAtr ?? 0,
        takeProfitAtr: settings.takeProfitAtr ?? 0,
        trailingAtr: settings.trailingAtr ?? 0,
        partialTakeProfitAtR: settings.partialTakeProfitAtR ?? 0,
        partialTakeProfitPercent: settings.partialTakeProfitPercent ?? 50,
        breakEvenAtR: settings.breakEvenAtR ?? 0,
        timeStopBars: settings.timeStopBars ?? 0,
        riskMode: settings.riskMode ?? 'simple',
        stopLossPercent: settings.stopLossPercent ?? 0,
        takeProfitPercent: settings.takeProfitPercent ?? 0,
        stopLossEnabled: settings.stopLossEnabled ?? false,
        takeProfitEnabled: settings.takeProfitEnabled ?? false,
        executionModel: settings.executionModel ?? 'signal_close',
        allowSameBarExit: settings.allowSameBarExit ?? false,
        tradeDirection: settings.tradeDirection ?? 'both',
    };
}

/**
 * Create initial empty trade state.
 */
export function createInitialTradeState(initialCapital: number): LiveTradeState {
    return {
        position: null,
        equity: initialCapital,
        realizedPnL: 0,
        unrealizedPnL: 0,
        trades: [],
        pendingSignal: null,
        currentBarIndex: 0,
        currentPrice: 0,
    };
}
