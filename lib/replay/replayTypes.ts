/**
 * Replay Bar Candle Feature - Type Definitions
 * 
 * Provides types for the bar-by-bar replay system that visualizes
 * how strategies generate buy and sell signals over historical data.
 */


import type { OHLCVData, Signal, StrategyParams, Trade } from "../strategies/types";
import type { OpenPosition } from "./liveTradeTypes";

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
    backtestSettings?: import('../strategies/types').BacktestSettings;
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
