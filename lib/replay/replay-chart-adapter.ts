/**
 * Replay Chart Adapter
 * 
 * Bridges the ReplayManager and ChartManager, subscribing to replay events
 * and and updating the chart accordingly. Handles incremental data display,
 * signal highlighting, and auto-scrolling.
 */


import type { ReplayManager } from './replay-manager';
import type { ReplayEvent, SignalWithAnnotation } from '../types/replay';
import type { OpenPosition } from '../types/replay';
import type { OHLCVData } from '../types/strategies';
import { state } from '../state';
import { chartManager } from '../chart-manager';
import { LineSeries, type SeriesMarker, type Time } from "lightweight-charts";

// ============================================================================
// Replay Chart Adapter
// ============================================================================

export class ReplayChartAdapter {

    private replayManager: ReplayManager;
    private unsubscribe: (() => void) | null = null;
    private fullData: OHLCVData[] = [];
    private isConnected: boolean = false;

    /** Reference to current replay highlight line series */
    private replayHighlightSeries: any = null;

    /** Reference to current replay signal markers */
    private replayMarkers: SeriesMarker<Time>[] = [];

    /** Price line series for SL/TP/Entry visualization */
    private entryPriceLine: any = null;
    private stopLossPriceLine: any = null;
    private takeProfitPriceLine: any = null;

    constructor(replayManager: ReplayManager) {
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
            case 'position-opened':
            case 'pnl-update':
                this.onPositionUpdate(event);
                break;
            case 'position-closed':
                this.onPositionClosed();
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
        this.setReplayData(this.fullData, event.barIndex);

        // Highlight current bar
        if (event.bar) {
            this.highlightCurrentBar(event.bar);
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
        this.displayReplaySignal({
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
            this.restoreFullData(this.fullData);
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

            // Clear ALL backtest markers (plugin and series)
            chartManager.clearTradeMarkers();
            if (state.candlestickSeries) {
                (state.candlestickSeries as any).setMarkers([]);
            }

            // Clear any previous position lines
            this.clearPositionLines();

            // Ensure we have data
            if (this.fullData.length === 0) {
                this.fullData = state.ohlcvData;
            }

            // If starting fresh, set initial data
            if (event.barIndex === 0 && this.fullData.length > 0) {
                this.clearReplayState(); // Fully reset replay state (markers: [])
                this.setReplayData(this.fullData, 0);
            } else {
                // If resuming or starting mid-way, just ensure our Replay markers are active
                // (In case they were cleared or overwritten)
                this.updateMarkers();
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
        chartManager.clearTradeMarkers();

        if (this.fullData.length === 0) {
            this.fullData = state.ohlcvData;
        }

        // Update chart to show data up to seek position
        this.setReplayData(this.fullData, event.barIndex);

        // Highlight current bar
        if (event.bar) {
            this.highlightCurrentBar(event.bar);
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
        this.clearReplayState();

        // Restore full data
        if (this.fullData.length > 0) {
            this.restoreFullData(this.fullData);
        } else if (state.ohlcvData.length > 0) {
            this.restoreFullData(state.ohlcvData);
        }

        // Reset state
        state.set('replayMode', false);
        state.set('replayBarIndex', 0);

        // Clear stored data
        this.fullData = [];
    }

    /**
     * Handle position opened/updated event - render SL/TP lines
     */
    private onPositionUpdate(event: ReplayEvent): void {
        const position = event.position;
        if (!position) {
            this.clearPositionLines();
            return;
        }

        this.drawPositionLines(position);
    }

    /**
     * Handle position closed event - clear lines
     */
    private onPositionClosed(): void {
        this.clearPositionLines();
    }

    /**
     * Draw entry, stop loss, and take profit price lines
     */
    private drawPositionLines(position: OpenPosition): void {
        this.clearPositionLines();

        if (!state.candlestickSeries) return;

        // Entry price line (amber/gold)
        this.entryPriceLine = (state.candlestickSeries as any).createPriceLine({
            price: position.entryPrice,
            color: '#ffc107',
            lineWidth: 1,
            lineStyle: 0, // Solid
            axisLabelVisible: true,
            title: `Entry`,
        });

        // Stop loss line (red)
        if (position.stopLossPrice !== null) {
            this.stopLossPriceLine = (state.candlestickSeries as any).createPriceLine({
                price: position.stopLossPrice,
                color: '#ef5350',
                lineWidth: 1,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: `SL`,
            });
        }

        // Take profit line (green)
        if (position.takeProfitPrice !== null) {
            this.takeProfitPriceLine = (state.candlestickSeries as any).createPriceLine({
                price: position.takeProfitPrice,
                color: '#26a69a',
                lineWidth: 1,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: `TP`,
            });
        }
    }

    /**
     * Clear all position price lines
     */
    private clearPositionLines(): void {
        if (!state.candlestickSeries) return;

        if (this.entryPriceLine) {
            (state.candlestickSeries as any).removePriceLine(this.entryPriceLine);
            this.entryPriceLine = null;
        }
        if (this.stopLossPriceLine) {
            (state.candlestickSeries as any).removePriceLine(this.stopLossPriceLine);
            this.stopLossPriceLine = null;
        }
        if (this.takeProfitPriceLine) {
            (state.candlestickSeries as any).removePriceLine(this.takeProfitPriceLine);
            this.takeProfitPriceLine = null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Display all signals on the chart
     */
    private displayAllSignals(signals: SignalWithAnnotation[]): void {
        this.displayReplaySignals(
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

    // ─────────────────────────────────────────────────────────────────────────
    // Replay Rendering Methods
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Set the visible data for replay mode (incremental reveal)
     * @param data Full OHLCV dataset
     * @param endIndex Last bar index to show (0-based, inclusive)
     */
    private setReplayData(data: OHLCVData[], endIndex: number): void {
        if (endIndex < 0 || endIndex >= data.length) {
            console.warn('[ReplayChartAdapter] Invalid replay endIndex:', endIndex);
            return;
        }

        // Show only data up to endIndex (inclusive)
        const visibleData = data.slice(0, endIndex + 1);
        state.candlestickSeries.setData(visibleData as any); // Cast to any as OHLCVData might not perfectly match lib types

        // CRITICAL: Markers are cleared when setData is called. We must restore them.
        this.updateMarkers();

        // Auto-scroll to keep current bar visible
        this.scrollToBar(endIndex, data.length);
    }

    /**
     * Display a signal marker during replay with optional animation
     */
    private displayReplaySignal(
        signal: { time: any; type: 'buy' | 'sell'; price: number; annotation?: string },
        _animate: boolean = true
    ): void {
        const isBuy = signal.type === 'buy';

        const marker: SeriesMarker<Time> = {
            time: signal.time,
            position: isBuy ? 'belowBar' : 'aboveBar',
            color: isBuy ? '#26a69a' : '#ef5350',
            shape: isBuy ? 'arrowUp' : 'arrowDown',
            text: signal.annotation || `${isBuy ? 'Buy' : 'Sell'} @ ${this.formatPrice(signal.price)}`,
        };

        // Add to replay markers collection
        this.replayMarkers.push(marker);

        // Update markers on chart
        this.updateMarkers();
    }

    /**
     * Display all replay signals up to a certain bar
     */
    private displayReplaySignals(
        signals: { time: any; type: 'buy' | 'sell'; price: number; annotation?: string }[]
    ): void {
        this.replayMarkers = signals.map(signal => {
            const isBuy = signal.type === 'buy';
            return {
                time: signal.time,
                position: isBuy ? 'belowBar' : 'aboveBar',
                color: isBuy ? '#26a69a' : '#ef5350',
                shape: isBuy ? 'arrowUp' : 'arrowDown',
                text: signal.annotation || `${isBuy ? 'Buy' : 'Sell'} @ ${this.formatPrice(signal.price)}`,
            } as SeriesMarker<Time>;
        });

        this.updateMarkers();
    }

    /**
     * Update markers on the chart via state
     */
    private updateMarkers(): void {
        if (!state.candlestickSeries) return;

        // Ensure backtest markers are cleared
        chartManager.clearTradeMarkers();

        // Sort markers by time as required by Lightweight Charts
        const sortedMarkers = [...this.replayMarkers].sort((a, b) => {
            const timeA = a.time as number; // Assuming numeric timestamps
            const timeB = b.time as number;
            return timeA - timeB;
        });

        // Use any cast since the type definition might be outdated for setMarkers
        (state.candlestickSeries as any).setMarkers(sortedMarkers);
    }


    /**
     * Highlight the current replay bar with a vertical line
     */
    private highlightCurrentBar(barData: OHLCVData): void {
        // Remove existing highlight
        this.clearReplayHighlight();

        // Create a thin vertical line series for the highlight
        this.replayHighlightSeries = state.chart.addSeries(LineSeries, {
            color: 'rgba(255, 193, 7, 0.6)', // Amber color
            lineWidth: 2,
            lineStyle: 2, // Dashed
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });

        // Create vertical line from low to high
        this.replayHighlightSeries.setData([
            { time: barData.time, value: barData.low },
            { time: barData.time, value: barData.high },
        ]);
    }

    /**
     * Scroll the chart to keep a specific bar visible
     */
    private scrollToBar(barIndex: number, totalBars: number): void {
        // Keep the current bar near the right edge with some padding
        const visibleRange = state.chart.timeScale().getVisibleLogicalRange();
        if (!visibleRange) return;

        const visibleBars = visibleRange.to - visibleRange.from;
        const padding = Math.max(5, Math.floor(visibleBars * 0.1)); // 10% padding or at least 5 bars

        // If current bar is near the right edge, shift the view
        if (barIndex > visibleRange.to - padding) {
            const newFrom = Math.max(0, barIndex - visibleBars + padding);
            const newTo = Math.min(totalBars - 1, newFrom + visibleBars);
            state.chart.timeScale().setVisibleLogicalRange({
                from: newFrom,
                to: newTo,
            });
        }
    }

    /**
     * Clear replay highlight line
     */
    private clearReplayHighlight(): void {
        if (this.replayHighlightSeries) {
            state.chart.removeSeries(this.replayHighlightSeries);
            this.replayHighlightSeries = null;
        }
    }

    /**
     * Clear all replay-related state (markers, highlights)
     */
    private clearReplayState(): void {
        // Clear highlight
        this.clearReplayHighlight();

        // Clear markers
        this.replayMarkers = [];
        chartManager.clearTradeMarkers();

        // Also explicitly clear built-in markers if any
        (state.candlestickSeries as any).setMarkers([]);
    }

    /**
     * Restore full data after replay ends
     */
    private restoreFullData(fullData: OHLCVData[]): void {
        state.candlestickSeries.setData(fullData as any);
        state.chart.timeScale().fitContent();
    }

    /**
     * Format price for display
     */
    private formatPrice(price: number): string {
        if (price >= 1000) return price.toFixed(2);
        if (price >= 1) return price.toFixed(4);
        return price.toFixed(6);
    }
}



