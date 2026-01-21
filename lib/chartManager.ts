import {
    createChart,
    CandlestickSeries,
    AreaSeries,
    LineSeries,
    HistogramSeries,
    DeepPartial,
    ChartOptions,
    Time,
    createSeriesMarkers,
    SeriesMarker,
} from "lightweight-charts";
import { state } from "./state";
import { darkTheme, lightTheme } from "./constants";

import { Trade } from "./strategies/index";


export class ChartManager {
    public initCharts() {
        const container = document.getElementById('main-chart')!;
        const equityContainer = document.getElementById('equity-chart')!;

        state.chart = createChart(container, {
            ...darkTheme,
            autoSize: true,
            handleScroll: {
                mouseWheel: false,
                pressedMouseMove: true,
                vertTouchDrag: true,
                horzTouchDrag: true,
            },
            handleScale: {
                axisPressedMouseMove: true,
                mouseWheel: true,
                pinch: true,
            },
        } as DeepPartial<ChartOptions>);

        state.candlestickSeries = state.chart.addSeries(CandlestickSeries, {
            upColor: "#26a69a",
            downColor: "#ef5350",
            borderVisible: false,
            wickUpColor: "#26a69a",
            wickDownColor: "#ef5350",
        });

        state.equityChart = createChart(equityContainer, {
            ...darkTheme,
            autoSize: true,
            rightPriceScale: {
                borderColor: '#2a2e39',
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            handleScale: {
                axisPressedMouseMove: false,
                mouseWheel: false,
                pinch: false,
            },
            handleScroll: {
                mouseWheel: false,
                pressedMouseMove: false,
                vertTouchDrag: false,
                horzTouchDrag: false,
            },
        } as DeepPartial<ChartOptions>);

        state.equitySeries = state.equityChart.addSeries(AreaSeries, {
            lineColor: '#2962ff',
            topColor: 'rgba(41, 98, 255, 0.4)',
            bottomColor: 'rgba(41, 98, 255, 0.0)',
            lineWidth: 2,
            priceLineVisible: false,
        });

        this.syncTimeScales();
    }

    private syncTimeScales() {
        let isSyncing = false;
        state.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            if (!isSyncing && range) {
                isSyncing = true;
                state.equityChart.timeScale().setVisibleLogicalRange(range);
                isSyncing = false;
            }
        });

        state.equityChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            if (!isSyncing && range) {
                isSyncing = true;
                state.chart.timeScale().setVisibleLogicalRange(range);
                isSyncing = false;
            }
        });
    }

    public updateTheme() {
        const theme = state.isDarkTheme ? darkTheme : lightTheme;
        state.chart.applyOptions(theme);
        state.equityChart.applyOptions(theme);
    }

    public clearIndicators() {
        state.indicators.forEach(ind => ind.series.forEach(s => state.chart.removeSeries(s)));
        state.indicators = [];
    }

    public addIndicatorLine(type: string, period: number, data: { time: Time; value: number }[], color: string) {
        const series = state.chart.addSeries(LineSeries, {
            color,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });

        series.setData(data);
        const id = `${type}_${period}_${Math.random().toString(36).substr(2, 9)}`;
        state.indicators.push({ id, type, series: [series], color });
        return id;
    }

    public addIndicatorHistogram(type: string, period: number, data: { time: Time; value: number }[], color: string) {
        const series = state.chart.addSeries(HistogramSeries, {
            color,
            priceLineVisible: false,
            lastValueVisible: false,
        });

        series.setData(data);
        const id = `${type}_${period}_${Math.random().toString(36).substr(2, 9)}`;
        state.indicators.push({ id, type, series: [series], color });
        return id;
    }

    public displayTradeMarkers(trades: Trade[], formatPrice: (p: number) => string) {
        const markers: SeriesMarker<Time>[] = [];
        const entryMarkerTimes = new Set<string>();

        for (const trade of trades) {
            const isShort = trade.type === 'short';
            const entryKey = typeof trade.entryTime === 'object'
                ? JSON.stringify(trade.entryTime)
                : String(trade.entryTime);
            if (!entryMarkerTimes.has(entryKey)) {
                markers.push({
                    time: trade.entryTime,
                    position: isShort ? 'aboveBar' : 'belowBar',
                    color: isShort ? '#ef5350' : '#26a69a',
                    shape: isShort ? 'arrowDown' : 'arrowUp',
                    text: `${isShort ? 'Sell' : 'Buy'} @ ${formatPrice(trade.entryPrice)}`,
                });
                entryMarkerTimes.add(entryKey);
            }

            const exitColor = trade.pnl >= 0 ? '#26a69a' : '#ef5350';
            markers.push({
                time: trade.exitTime,
                position: isShort ? 'belowBar' : 'aboveBar',
                color: exitColor,
                shape: isShort ? 'arrowUp' : 'arrowDown',
                text: `${isShort ? 'Buy' : 'Sell'} @ ${formatPrice(trade.exitPrice)} (${trade.pnl >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(2)}%)`,
            });
        }

        if (state.markersPlugin) {
            state.markersPlugin.detach();
        }

        // If in replay mode, we don't display backtest markers automatically
        if (state.replayMode) {
            console.log('[ChartManager] Replay mode active, skipping backtest marker display');
            return;
        }

        state.markersPlugin = createSeriesMarkers(state.candlestickSeries, markers);
    }

    public displayEquityCurve(equityCurve: { time: Time; value: number }[]) {
        if (equityCurve.length === 0) {
            state.equitySeries.setData([]);
            return;
        }

        const isPositive = equityCurve[equityCurve.length - 1].value >= equityCurve[0].value;
        state.equitySeries.applyOptions({
            lineColor: isPositive ? '#26a69a' : '#ef5350',
            topColor: isPositive ? 'rgba(38, 166, 154, 0.4)' : 'rgba(239, 83, 80, 0.4)',
            bottomColor: isPositive ? 'rgba(38, 166, 154, 0.0)' : 'rgba(239, 83, 80, 0.0)',
        });

        state.equitySeries.setData(equityCurve);
        state.equityChart.timeScale().fitContent();
    }

    // =========================================================================
    // Replay Methods
    // =========================================================================

    /** Reference to current replay highlight line series */
    private replayHighlightSeries: any = null;

    /** Reference to current replay signal markers */
    private replayMarkers: SeriesMarker<Time>[] = [];

    /**
     * Set the visible data for replay mode (incremental reveal)
     * @param data Full OHLCV dataset
     * @param endIndex Last bar index to show (0-based, inclusive)
     */
    public setReplayData(data: { time: Time; open: number; high: number; low: number; close: number }[], endIndex: number): void {
        if (endIndex < 0 || endIndex >= data.length) {
            console.warn('[ChartManager] Invalid replay endIndex:', endIndex);
            return;
        }

        // Show only data up to endIndex (inclusive)
        const visibleData = data.slice(0, endIndex + 1);
        state.candlestickSeries.setData(visibleData);

        // Auto-scroll to keep current bar visible
        this.scrollToBar(endIndex, data.length);
    }

    /**
     * Display a signal marker during replay with optional animation
     * @param signal Signal with annotation
     * @param animate Whether to add animation effect
     */
    public displayReplaySignal(
        signal: { time: Time; type: 'buy' | 'sell'; price: number; annotation?: string },
        _animate: boolean = true // Reserved for future animation enhancements
    ): void {
        const isBuy = signal.type === 'buy';

        const marker: SeriesMarker<Time> = {
            time: signal.time,
            position: isBuy ? 'belowBar' : 'aboveBar',
            color: isBuy ? '#26a69a' : '#ef5350',
            shape: isBuy ? 'arrowUp' : 'arrowDown',
            text: signal.annotation || `${isBuy ? 'Buy' : 'Sell'} @ ${this.formatPriceInternal(signal.price)}`,
        };

        // Add to replay markers collection
        this.replayMarkers.push(marker);

        // Update markers on chart
        if (state.markersPlugin) {
            state.markersPlugin.detach();
            state.markersPlugin = null; // Important to null out before re-creating
        }
        state.markersPlugin = createSeriesMarkers(state.candlestickSeries, this.replayMarkers);
    }

    /**
     * Display all replay signals up to a certain bar
     * @param signals Array of signals to display
     */
    public displayReplaySignals(
        signals: { time: Time; type: 'buy' | 'sell'; price: number; annotation?: string }[]
    ): void {
        this.replayMarkers = signals.map(signal => {
            const isBuy = signal.type === 'buy';
            return {
                time: signal.time,
                position: isBuy ? 'belowBar' : 'aboveBar',
                color: isBuy ? '#26a69a' : '#ef5350',
                shape: isBuy ? 'arrowUp' : 'arrowDown',
                text: signal.annotation || `${isBuy ? 'Buy' : 'Sell'} @ ${this.formatPriceInternal(signal.price)}`,
            } as SeriesMarker<Time>;
        });

        if (state.markersPlugin) {
            state.markersPlugin.detach();
        }
        state.markersPlugin = createSeriesMarkers(state.candlestickSeries, this.replayMarkers);
    }

    /**
     * Highlight the current replay bar with a vertical line
     * @param barIndex Bar index to highlight
     * @param barData The bar data for price reference
     */
    public highlightCurrentBar(barData: { time: Time; high: number; low: number }): void {
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
     * @param barIndex Current bar index
     * @param totalBars Total number of bars
     */
    public scrollToBar(barIndex: number, totalBars: number): void {
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
    public clearReplayState(): void {
        // Clear highlight
        this.clearReplayHighlight();

        // Clear markers
        this.replayMarkers = [];
        if (state.markersPlugin) {
            state.markersPlugin.detach();
            state.markersPlugin = null;
        }

        // Also explicitly clear built-in markers if any
        (state.candlestickSeries as any).setMarkers([]);
    }

    /**
     * Restore full data after replay ends
     * @param fullData The complete dataset
     */
    public restoreFullData(fullData: { time: Time; open: number; high: number; low: number; close: number }[]): void {
        state.candlestickSeries.setData(fullData);
        state.chart.timeScale().fitContent();
    }

    /**
     * Format price for display (internal helper)
     */
    private formatPriceInternal(price: number): string {
        if (price >= 1000) return price.toFixed(2);
        if (price >= 1) return price.toFixed(4);
        return price.toFixed(6);
    }
}

export const chartManager = new ChartManager();

