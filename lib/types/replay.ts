import type { Time } from "lightweight-charts";
import type { Signal, StrategyParams, Trade, BacktestSettings, OHLCVData } from "./strategies";

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
    const replayTradeDirection = settings.tradeDirection === 'combined'
        ? 'both'
        : (settings.tradeDirection ?? 'both');

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
        tradeDirection: replayTradeDirection,
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

// ============================================================================
// Replay Status & Speed
// ============================================================================

/** Current state of the replay playback */
export type ReplayStatus = 'idle' | 'playing' | 'paused' | 'stopped';

/** Speed multiplier range (0.1x to 20x via slider) */
export interface ReplaySpeedConfig {
    min: number;      // 0.1
    max: number;      // 20
    default: number;  // 1
    step: number;     // 0.1
}

export const DEFAULT_SPEED_CONFIG: ReplaySpeedConfig = {
    min: 0.1,
    max: 20,
    default: 1,
    step: 0.1,
};

// ============================================================================
// Replay State
// ============================================================================

/** Complete state of the replay system */
export interface ReplayState {
    /** Current playback status */
    status: ReplayStatus;

    /** Speed multiplier (1 = normal, 2 = 2x faster, etc.) */
    speed: number;

    /** Current bar index being displayed (0-based) */
    currentBarIndex: number;

    /** Total number of bars available for replay */
    totalBars: number;

    /** Signals that have been triggered up to currentBarIndex */
    visibleSignals: SignalWithAnnotation[];

    /** Strategy being replayed (key from registry) */
    strategyKey: string;

    /** Strategy parameters being used */
    strategyParams: StrategyParams;

    // ─────────────────────────────────────────────────────────────────────────
    // Live Trade Tracking (Phase 2)
    // ─────────────────────────────────────────────────────────────────────────

    /** Currently open position (null if flat) */
    position: OpenPosition | null;

    /** Current account equity (capital + unrealized PnL) */
    equity: number;

    /** Current unrealized PnL (0 if no position) */
    unrealizedPnL: number;

    /** List of completed trades during this replay */
    completedTrades: Trade[];
}

// ============================================================================
// Signal with Annotation
// ============================================================================

/** Extended signal with annotation for display */
export interface SignalWithAnnotation extends Signal {
    /** Human-readable reason for the signal */
    annotation: string;

    /** Bar index where this signal occurred */
    barIndex: number;

    /** The bar data at the time of the signal */
    bar: OHLCVData;


}

// ============================================================================
// Replay Events
// ============================================================================

/** Types of events emitted by the replay system */
export type ReplayEventType =
    | 'bar-advance'       // Moved to a new bar
    | 'signal-triggered'  // A signal was detected at current bar
    | 'replay-complete'   // Reached the end of data
    | 'status-change'     // Playback status changed
    | 'speed-change'      // Speed was adjusted
    | 'seek'              // User seeked to a different position
    | 'reset'             // Replay was reset/stopped
    | 'position-opened'   // New trade opened
    | 'position-closed'   // Trade closed (SL/TP/signal)
    | 'pnl-update';       // Unrealized PnL changed

/** Event object emitted by the replay system */
export interface ReplayEvent {
    /** Type of event */
    type: ReplayEventType;

    /** Current bar index */
    barIndex: number;

    /** Total bars available */
    totalBars: number;

    /** Current replay status */
    status: ReplayStatus;

    /** Current speed */
    speed: number;

    /** Signal that was just triggered (for 'signal-triggered' events) */
    signal?: SignalWithAnnotation;

    /** Current bar data */
    bar?: OHLCVData;

    /** Timestamp of the event */
    timestamp: number;

    /** Current position state (for position events) */
    position?: OpenPosition | null;

    /** Trade that was just closed (for position-closed events) */
    trade?: Trade;

    /** Current equity */
    equity?: number;

    /** Current unrealized PnL */
    unrealizedPnL?: number;
}

/** Callback type for replay event listeners */
export type ReplayEventListener = (event: ReplayEvent) => void;

// ============================================================================
// Replay Options
// ============================================================================

/** Options for starting a replay session */
export interface ReplayStartOptions {
    /** Strategy key from the registry */
    strategyKey: string;

    /** Strategy parameters to use */
    params: StrategyParams;

    /** OHLCV data to replay */
    data: OHLCVData[];

    /** Starting bar index (default: 0) */
    startIndex?: number;

    /** Initial speed (default: 1) */
    initialSpeed?: number;

    // ─────────────────────────────────────────────────────────────────────────
    // Trade Engine Configuration (Phase 2)
    // ─────────────────────────────────────────────────────────────────────────

    /** Initial capital for simulated trading */
    initialCapital?: number;

    /** Position size as percentage of capital */
    positionSizePercent?: number;

    /** Commission rate in percentage */
    commissionPercent?: number;

    /** Backtest settings for SL/TP/trailing configuration */
    backtestSettings?: BacktestSettings;
}

/** Options for seeking to a specific position */
export interface ReplaySeekOptions {
    /** Bar index to seek to */
    barIndex: number;

    /** Whether to recompute all signals up to this point */
    recomputeSignals?: boolean;
}

// ============================================================================
// Helper Types
// ============================================================================

/** Internal timing state for animation loop */
export interface ReplayTimingState {
    /** Last frame timestamp from requestAnimationFrame */
    lastFrameTime: number;

    /** Accumulated time since last bar advance */
    accumulatedTime: number;

    /** Animation frame request ID (for cancellation) */
    animationFrameId: number | null;
}

/** Factory function type for creating replay manager instances */
export type ReplayManagerFactory = () => IReplayManager;

// ============================================================================
// Replay Manager Interface
// ============================================================================

/** Public interface for the replay manager */
export interface IReplayManager {
    // Lifecycle
    start(options: ReplayStartOptions): void;
    pause(): void;
    resume(): void;
    stop(): void;

    // Navigation
    seekTo(options: ReplaySeekOptions): void;
    stepForward(): void;
    stepBackward(): void;

    // Speed control
    setSpeed(speed: number): void;
    getSpeed(): number;

    // State access
    getState(): Readonly<ReplayState>;
    isPlaying(): boolean;
    isPaused(): boolean;

    // Event subscription
    subscribe(listener: ReplayEventListener): () => void;

    // Cleanup
    destroy(): void;
}
