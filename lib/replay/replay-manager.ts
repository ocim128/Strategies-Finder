/**
 * Replay Manager - Core Replay Engine
 * 
 * Controls bar-by-bar playback of historical data to visualize
 * how strategies generate signals.
 */

import type {
    IReplayManager,
    ReplayState,
    ReplayEvent,
    ReplayEventListener,
    ReplayStartOptions,
    ReplaySeekOptions,
    ReplayTimingState,
    SignalWithAnnotation,
} from '../types/replay';
import type { OHLCVData, Signal, StrategyParams, Strategy } from '../types/strategies';
import { strategyRegistry } from '../../strategyRegistry';
import { ReplayTradeEngine } from './replay-trade-engine';
import { createTradeEngineConfig } from '../types/replay';

// ============================================================================
// Constants
// ============================================================================

/** Base interval in milliseconds for 1x speed (1 bar per second) */
const BASE_INTERVAL_MS = 1000;

/** Minimum speed multiplier */
const MIN_SPEED = 0.1;

/** Maximum speed multiplier */
const MAX_SPEED = 20;

/** Default speed multiplier */
const DEFAULT_SPEED = 1;

// ============================================================================
// Replay Manager Implementation
// ============================================================================

export class ReplayManager implements IReplayManager {
    // ─────────────────────────────────────────────────────────────────────────
    // Private State
    // ─────────────────────────────────────────────────────────────────────────

    /** Current replay state */
    private state: ReplayState;

    /** Full dataset for replay */
    private fullData: OHLCVData[] = [];

    /** All signals from the strategy (computed once at start) */
    private allSignals: Signal[] = [];

    /** Strategy being replayed */
    private strategy: Strategy | null = null;

    /** Timing state for animation loop */
    private timing: ReplayTimingState = {
        lastFrameTime: 0,
        accumulatedTime: 0,
        animationFrameId: null,
    };

    /** Event listeners */
    private listeners: Set<ReplayEventListener> = new Set();

    /** Trade engine for position tracking */
    private tradeEngine: ReplayTradeEngine | null = null;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor() {
        this.state = this.createInitialState();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle Methods
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Start a new replay session
     */
    public start(options: ReplayStartOptions): void {
        // Stop any existing replay
        this.stop();

        // Validate inputs
        if (!options.data || options.data.length === 0) {
            console.error('[ReplayManager] Cannot start replay: No data provided');
            return;
        }

        // Get strategy
        const strategy = strategyRegistry.get(options.strategyKey);
        if (!strategy) {
            console.error(`[ReplayManager] Strategy not found: ${options.strategyKey}`);
            return;
        }

        // Initialize state
        this.fullData = options.data;
        this.strategy = strategy || null;

        this.state = {
            status: 'playing',
            speed: this.clampSpeed(options.initialSpeed ?? DEFAULT_SPEED),
            currentBarIndex: options.startIndex ?? 0,
            totalBars: options.data.length,
            visibleSignals: [],
            strategyKey: options.strategyKey,
            strategyParams: options.params,
            position: null,
            equity: options.initialCapital ?? 10000,
            unrealizedPnL: 0,
            completedTrades: [],
        };

        // Initialize trade engine for position tracking
        const engineConfig = createTradeEngineConfig(
            options.backtestSettings ?? {},
            options.initialCapital ?? 10000,
            options.positionSizePercent ?? 100,
            options.commissionPercent ?? 0.1
        );
        this.tradeEngine = new ReplayTradeEngine(engineConfig);
        this.tradeEngine.precompute(options.data);

        // Pre-compute all signals from the strategy
        this.computeAllSignals(options.params);

        // Compute visible signals up to current bar
        this.updateVisibleSignals();

        // Process bars up to start index through trade engine
        for (let i = 0; i <= this.state.currentBarIndex; i++) {
            const bar = this.fullData[i];
            const signalsAtBar = this.getSignalsAtBar(i).map(s => ({ time: s.time, type: s.type, price: s.price, reason: s.reason }));
            this.tradeEngine.processBar(bar, i, signalsAtBar);
        }
        this.syncTradeState();

        // Emit status change
        this.emit('status-change');

        // Start animation loop
        this.startAnimationLoop();
    }

    /**
     * Pause the replay
     */
    public pause(): void {
        if (this.state.status !== 'playing') return;

        this.state.status = 'paused';
        this.stopAnimationLoop();
        this.emit('status-change');
    }

    /**
     * Resume a paused replay
     */
    public resume(): void {
        if (this.state.status !== 'paused') return;

        this.state.status = 'playing';
        this.emit('status-change');
        this.startAnimationLoop();
    }

    /**
     * Stop the replay and reset to initial state
     */
    public stop(): void {
        this.stopAnimationLoop();

        const wasPlaying = this.state.status !== 'idle';

        this.state = this.createInitialState();
        this.fullData = [];
        this.allSignals = [];
        this.strategy = null;
        this.tradeEngine?.reset();
        this.tradeEngine = null;

        if (wasPlaying) {
            this.emit('reset');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Navigation Methods
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Seek to a specific bar index
     */
    public seekTo(options: ReplaySeekOptions): void {
        const targetIndex = Math.max(0, Math.min(options.barIndex, this.state.totalBars - 1));

        if (targetIndex === this.state.currentBarIndex) return;

        this.state.currentBarIndex = targetIndex;

        // Always recompute visible signals when seeking
        this.updateVisibleSignals();

        this.emit('seek');
    }

    /**
     * Step forward one bar
     */
    public stepForward(): void {
        if (this.state.currentBarIndex >= this.state.totalBars - 1) {
            // Already at end
            return;
        }

        const wasPaused = this.state.status === 'paused';
        if (this.state.status === 'playing') {
            this.pause();
        }

        this.advanceBar();

        // Keep paused state after stepping
        if (!wasPaused && this.state.status === 'paused') {
            // Remain paused after step
        }
    }

    /**
     * Step backward one bar
     */
    public stepBackward(): void {
        if (this.state.currentBarIndex <= 0) {
            return;
        }

        if (this.state.status === 'playing') {
            this.pause();
        }

        this.state.currentBarIndex--;
        this.updateVisibleSignals();
        this.emit('bar-advance');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Speed Control
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Set the playback speed
     */
    public setSpeed(speed: number): void {
        const clampedSpeed = this.clampSpeed(speed);

        if (clampedSpeed === this.state.speed) return;

        this.state.speed = clampedSpeed;
        this.emit('speed-change');
    }

    /**
     * Get the current playback speed
     */
    public getSpeed(): number {
        return this.state.speed;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State Access
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Get the current replay state (readonly)
     */
    public getState(): Readonly<ReplayState> {
        return { ...this.state };
    }

    /**
     * Check if currently playing
     */
    public isPlaying(): boolean {
        return this.state.status === 'playing';
    }

    /**
     * Check if currently paused
     */
    public isPaused(): boolean {
        return this.state.status === 'paused';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Event Subscription
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Subscribe to replay events
     * @returns Unsubscribe function
     */
    public subscribe(listener: ReplayEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cleanup
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Destroy the replay manager and clean up resources
     */
    public destroy(): void {
        this.stop();
        this.listeners.clear();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private: Animation Loop
    // ─────────────────────────────────────────────────────────────────────────

    private startAnimationLoop(): void {
        this.timing.lastFrameTime = performance.now();
        this.timing.accumulatedTime = 0;
        this.tick();
    }

    private stopAnimationLoop(): void {
        if (this.timing.animationFrameId !== null) {
            cancelAnimationFrame(this.timing.animationFrameId);
            this.timing.animationFrameId = null;
        }
    }

    private tick = (): void => {
        if (this.state.status !== 'playing') return;

        const now = performance.now();
        const deltaTime = now - this.timing.lastFrameTime;
        this.timing.lastFrameTime = now;

        // Accumulate time
        this.timing.accumulatedTime += deltaTime;

        // Calculate interval based on speed
        const interval = BASE_INTERVAL_MS / this.state.speed;

        // Advance bars if enough time has passed
        while (this.timing.accumulatedTime >= interval) {
            this.timing.accumulatedTime -= interval;

            if (!this.advanceBar()) {
                // Reached end of replay
                return;
            }
        }

        // Schedule next frame
        this.timing.animationFrameId = requestAnimationFrame(this.tick);
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Private: Bar Advancement
    // ─────────────────────────────────────────────────────────────────────────

    private advanceBar(): boolean {
        if (this.state.currentBarIndex >= this.state.totalBars - 1) {
            // Close any open position at end
            if (this.tradeEngine) {
                const lastBar = this.fullData[this.state.currentBarIndex];
                this.tradeEngine.closePositionAtMarket(lastBar, this.state.currentBarIndex);
                this.syncTradeState();
            }
            // Reached end
            this.state.status = 'stopped';
            this.stopAnimationLoop();
            this.emit('replay-complete');
            return false;
        }

        this.state.currentBarIndex++;
        const currentBar = this.fullData[this.state.currentBarIndex];

        // Check for new signals at this bar
        const newSignals = this.getSignalsAtBar(this.state.currentBarIndex);

        if (newSignals.length > 0) {
            // Add new signals to visible signals
            this.state.visibleSignals.push(...newSignals);

            // Emit signal events for each new signal
            for (const signal of newSignals) {
                this.emitSignal(signal);
            }
        }

        // Process bar through trade engine
        if (this.tradeEngine) {
            const rawSignals = newSignals.map(s => ({ time: s.time, type: s.type, price: s.price, reason: s.reason }));
            const prevPosition = this.state.position;
            this.tradeEngine.processBar(currentBar, this.state.currentBarIndex, rawSignals);
            this.syncTradeState();

            // Emit position events if state changed
            if (!prevPosition && this.state.position) {
                this.emitPositionEvent('position-opened');
            } else if (prevPosition && !this.state.position) {
                this.emitPositionEvent('position-closed');
            } else if (this.state.position) {
                this.emitPositionEvent('pnl-update');
            }
        }

        this.emit('bar-advance');
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private: Signal Computation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Pre-compute all signals from the strategy
     */
    private computeAllSignals(params: StrategyParams): void {
        if (!this.strategy) {
            this.allSignals = [];
            return;
        }

        try {
            this.allSignals = this.strategy.execute(this.fullData, params);
        } catch (error) {
            console.error('[ReplayManager] Error computing signals:', error);
            this.allSignals = [];
        }
    }

    /**
     * Get signals that occur at a specific bar index
     */
    private getSignalsAtBar(barIndex: number): SignalWithAnnotation[] {
        if (barIndex < 0 || barIndex >= this.fullData.length) {
            return [];
        }

        const currentBar = this.fullData[barIndex];
        const currentTime = currentBar.time;

        // Find signals that match this bar's time
        const matchingSignals = this.allSignals.filter(signal =>
            this.timeEquals(signal.time, currentTime)
        );

        // Convert to SignalWithAnnotation
        return matchingSignals.map(signal => this.enrichSignal(signal, barIndex, currentBar));
    }

    /**
     * Update visible signals up to current bar index
     */
    private updateVisibleSignals(): void {
        const visibleSignals: SignalWithAnnotation[] = [];

        for (let i = 0; i <= this.state.currentBarIndex; i++) {
            const signals = this.getSignalsAtBar(i);
            visibleSignals.push(...signals);
        }

        this.state.visibleSignals = visibleSignals;
    }

    /**
     * Enrich a signal with annotation and bar data
     */
    private enrichSignal(signal: Signal, barIndex: number, bar: OHLCVData): SignalWithAnnotation {
        // Generate annotation based on signal reason or default text
        let annotation = signal.reason || '';

        if (!annotation) {
            // Generate default annotation
            annotation = signal.type === 'buy'
                ? `Buy signal at ${this.formatPrice(signal.price)}`
                : `Sell signal at ${this.formatPrice(signal.price)}`;
        }

        return {
            ...signal,
            annotation,
            barIndex,
            bar,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private: Event Emission
    // ─────────────────────────────────────────────────────────────────────────

    private emit(type: ReplayEvent['type']): void {
        const event = this.createEvent(type);
        this.notifyListeners(event);
    }

    /**
     * Sync state from trade engine to replay state
     */
    private syncTradeState(): void {
        if (!this.tradeEngine) return;

        const engineState = this.tradeEngine.getState();
        this.state.position = engineState.position;
        this.state.equity = engineState.equity;
        this.state.unrealizedPnL = engineState.unrealizedPnL;
        this.state.completedTrades = [...engineState.trades];
    }

    /**
     * Emit a position-related event
     */
    private emitPositionEvent(type: 'position-opened' | 'position-closed' | 'pnl-update'): void {
        const event = this.createEvent(type);
        event.position = this.state.position;
        event.equity = this.state.equity;
        event.unrealizedPnL = this.state.unrealizedPnL;
        if (type === 'position-closed' && this.state.completedTrades.length > 0) {
            event.trade = this.state.completedTrades[this.state.completedTrades.length - 1];
        }
        this.notifyListeners(event);
    }

    private emitSignal(signal: SignalWithAnnotation): void {
        const event = this.createEvent('signal-triggered');
        event.signal = signal;
        this.notifyListeners(event);

        // Send webhook for live signal during replay
        this.sendWebhookForSignal(signal);
    }

    /**
     * Send webhook notification for a signal triggered during replay
     */
    private async sendWebhookForSignal(signal: SignalWithAnnotation): Promise<void> {
        try {
            // Dynamic import to avoid circular dependencies
            const { webhookService } = await import('../webhook-service');
            const strategy = this.strategy;

            if (strategy) {
                await webhookService.sendSignal(
                    signal,
                    strategy.name,
                    this.state.strategyParams
                );
            }
        } catch (error) {
            // Silently fail - webhooks are not critical to replay
            console.debug('[ReplayManager] Webhook send failed:', error);
        }
    }

    private createEvent(type: ReplayEvent['type']): ReplayEvent {
        const currentBar = this.fullData[this.state.currentBarIndex];

        return {
            type,
            barIndex: this.state.currentBarIndex,
            totalBars: this.state.totalBars,
            status: this.state.status,
            speed: this.state.speed,
            bar: currentBar,
            timestamp: Date.now(),
        };
    }

    private notifyListeners(event: ReplayEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                console.error('[ReplayManager] Error in event listener:', error);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private: Utilities
    // ─────────────────────────────────────────────────────────────────────────

    private createInitialState(): ReplayState {
        return {
            status: 'idle',
            speed: DEFAULT_SPEED,
            currentBarIndex: 0,
            totalBars: 0,
            visibleSignals: [],
            strategyKey: '',
            strategyParams: {},
            position: null,
            equity: 0,
            unrealizedPnL: 0,
            completedTrades: [],
        };
    }

    private clampSpeed(speed: number): number {
        return Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));
    }

    private timeEquals(a: any, b: any): boolean {
        // Handle both number timestamps and { year, month, day } objects
        if (typeof a === 'number' && typeof b === 'number') {
            return a === b;
        }

        if (typeof a === 'object' && typeof b === 'object') {
            return a.year === b.year && a.month === b.month && a.day === b.day;
        }

        return false;
    }

    private formatPrice(price: number): string {
        if (price >= 1000) return price.toFixed(2);
        if (price >= 1) return price.toFixed(4);
        return price.toFixed(6);
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const replayManager = new ReplayManager();



