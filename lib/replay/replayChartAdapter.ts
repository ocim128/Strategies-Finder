/**
 * Replay Chart Adapter
 * 
 * Bridges the ReplayManager and ChartManager, subscribing to replay events
 * and updating the chart accordingly. Handles incremental data display,
 * signal highlighting, and auto-scrolling.
 */

import type { ChartManager } from '../chartManager';
import type { ReplayManager } from './replayManager';
import type { ReplayEvent, SignalWithAnnotation } from './replayTypes';
import type { OHLCVData } from '../strategies/types';
import { state } from '../state';

// ============================================================================
// Replay Chart Adapter
// ============================================================================

export class ReplayChartAdapter {
    private chartManager: ChartManager;
    private replayManager: ReplayManager;
    private unsubscribe: (() => void) | null = null;
    private fullData: OHLCVData[] = [];
    private isConnected: boolean = false;

    constructor(chartManager: ChartManager, replayManager: ReplayManager) {
        this.chartManager = chartManager;
        this.replayManager = replayManager;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Connection Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Connect to the replay manager and start updating the chart
     */
    public connect(): void {
        if (this.isConnected) {
            console.warn('[ReplayChartAdapter] Already connected');
            return;
        }

        this.unsubscribe = this.replayManager.subscribe(this.handleReplayEvent);
        this.isConnected = true;
        console.log('[ReplayChartAdapter] Connected to replay manager');
    }

    /**
     * Disconnect from the replay manager
     */
    public disconnect(): void {
        if (!this.isConnected) return;

        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }

        this.isConnected = false;
        console.log('[ReplayChartAdapter] Disconnected from replay manager');
    }

    /**
     * Set the full data for replay (called before starting replay)
     */
    public setFullData(data: OHLCVData[]): void {
        this.fullData = data;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Event Handler
    // ─────────────────────────────────────────────────────────────────────────

    private handleReplayEvent = (event: ReplayEvent): void => {
        switch (event.type) {
            case 'bar-advance':
                this.onBarAdvance(event);
                break;
            case 'signal-triggered':
                this.onSignalTriggered(event);
                break;
            case 'replay-complete':
                this.onReplayComplete();
                break;
            case 'status-change':
                this.onStatusChange(event);
                break;
            case 'seek':
                this.onSeek(event);
                break;
            case 'reset':
                this.onReset();
                break;
            case 'speed-change':
                // Speed changes don't affect chart display
                break;
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Event Handlers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Handle bar advance event - update visible data
     */
    private onBarAdvance(event: ReplayEvent): void {
        if (this.fullData.length === 0) {
            // Use data from state if not explicitly set
            this.fullData = state.ohlcvData;
        }

        if (this.fullData.length === 0) {
            console.warn('[ReplayChartAdapter] No data available for replay');
            return;
        }

        // Update chart with visible data up to current bar
        this.chartManager.setReplayData(this.fullData, event.barIndex);

        // Highlight current bar
        if (event.bar) {
            this.chartManager.highlightCurrentBar(event.bar);
        }

        // Update state
        state.set('replayMode', true);
        state.set('replayBarIndex', event.barIndex);
    }

    /**
     * Handle signal triggered event - display the signal marker
     */
    private onSignalTriggered(event: ReplayEvent): void {
        if (!event.signal) return;

        const signal = event.signal;

        // Display the signal on the chart with animation
        this.chartManager.displayReplaySignal({
            time: signal.time,
            type: signal.type,
            price: signal.price,
            annotation: signal.annotation,
        }, true);

        // Log for debugging
        console.log(`[ReplayChartAdapter] Signal: ${signal.type.toUpperCase()} at bar ${signal.barIndex}`, {
            annotation: signal.annotation,
            price: signal.price,
        });
    }

    /**
     * Handle replay complete event - show all data and signals
     */
    private onReplayComplete(): void {
        console.log('[ReplayChartAdapter] Replay complete');

        // Restore full data
        if (this.fullData.length > 0) {
            this.chartManager.restoreFullData(this.fullData);
        }

        // Get all signals from replay state
        const replayState = this.replayManager.getState();
        if (replayState.visibleSignals.length > 0) {
            this.displayAllSignals(replayState.visibleSignals);
        }

        // Update state
        state.set('replayMode', false);
    }

    /**
     * Handle status change event
     */
    private onStatusChange(event: ReplayEvent): void {
        if (event.status === 'playing') {
            // Entering replay mode
            state.set('replayMode', true);

            // Ensure we have data
            if (this.fullData.length === 0) {
                this.fullData = state.ohlcvData;
            }

            // If starting fresh, set initial data
            if (event.barIndex === 0 && this.fullData.length > 0) {
                this.chartManager.clearReplayState();
                this.chartManager.setReplayData(this.fullData, 0);
            }
        } else if (event.status === 'stopped' || event.status === 'idle') {
            // Exiting replay mode
            state.set('replayMode', false);
            state.set('replayBarIndex', 0);
        }
    }

    /**
     * Handle seek event - update chart to new position
     */
    private onSeek(event: ReplayEvent): void {
        if (this.fullData.length === 0) {
            this.fullData = state.ohlcvData;
        }

        // Update chart to show data up to seek position
        this.chartManager.setReplayData(this.fullData, event.barIndex);

        // Highlight current bar
        if (event.bar) {
            this.chartManager.highlightCurrentBar(event.bar);
        }

        // Update visible signals
        const replayState = this.replayManager.getState();
        this.displayAllSignals(replayState.visibleSignals);

        // Update state
        state.set('replayBarIndex', event.barIndex);
    }

    /**
     * Handle reset event - restore chart to normal state
     */
    private onReset(): void {
        console.log('[ReplayChartAdapter] Replay reset');

        // Clear all replay visuals
        this.chartManager.clearReplayState();

        // Restore full data
        if (this.fullData.length > 0) {
            this.chartManager.restoreFullData(this.fullData);
        } else if (state.ohlcvData.length > 0) {
            this.chartManager.restoreFullData(state.ohlcvData);
        }

        // Reset state
        state.set('replayMode', false);
        state.set('replayBarIndex', 0);

        // Clear stored data
        this.fullData = [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Display all signals on the chart
     */
    private displayAllSignals(signals: SignalWithAnnotation[]): void {
        this.chartManager.displayReplaySignals(
            signals.map(s => ({
                time: s.time,
                type: s.type,
                price: s.price,
                annotation: s.annotation,
            }))
        );
    }

    /**
     * Check if connected
     */
    public isActive(): boolean {
        return this.isConnected;
    }

    /**
     * Destroy and clean up
     */
    public destroy(): void {
        this.disconnect();
        this.fullData = [];
    }
}
