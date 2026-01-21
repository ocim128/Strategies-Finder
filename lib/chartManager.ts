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
    MouseEventParams,
} from "lightweight-charts";
import { state } from "./state";
import { darkTheme, lightTheme, ENHANCED_CANDLE_COLORS } from "./constants";

import { Trade, OHLCVData } from "./strategies/index";

// ============================================================================
// Chart Manager - Enhanced Trade Charting
// ============================================================================

export class ChartManager {
    private tooltip: HTMLElement | null = null;
    private zoomIndicator: HTMLElement | null = null;
    private equityOverlay: HTMLElement | null = null;
    private zoomTimeout: ReturnType<typeof setTimeout> | null = null;
    private lastZoomLevel: number = 0;

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
            crosshair: {
                ...darkTheme.crosshair,
                vertLine: {
                    ...darkTheme.crosshair?.vertLine,
                    labelVisible: true,
                },
                horzLine: {
                    ...darkTheme.crosshair?.horzLine,
                    labelVisible: true,
                },
            },
        } as DeepPartial<ChartOptions>);

        // Enhanced candlestick styling with better colors
        state.candlestickSeries = state.chart.addSeries(CandlestickSeries, {
            upColor: ENHANCED_CANDLE_COLORS.up,
            downColor: ENHANCED_CANDLE_COLORS.down,
            borderVisible: true,
            borderUpColor: ENHANCED_CANDLE_COLORS.upBorder,
            borderDownColor: ENHANCED_CANDLE_COLORS.downBorder,
            wickUpColor: ENHANCED_CANDLE_COLORS.wickUp,
            wickDownColor: ENHANCED_CANDLE_COLORS.wickDown,
        });

        state.equityChart = createChart(equityContainer, {
            ...darkTheme,
            autoSize: true,
            rightPriceScale: {
                borderColor: '#2a2e39',
                scaleMargins: { top: 0.15, bottom: 0.1 },
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

        // Enhanced equity curve with better gradient
        state.equitySeries = state.equityChart.addSeries(AreaSeries, {
            lineColor: '#2962ff',
            topColor: 'rgba(41, 98, 255, 0.5)',
            bottomColor: 'rgba(41, 98, 255, 0.05)',
            lineWidth: 2,
            priceLineVisible: false,
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 4,
        });

        this.syncTimeScales();
        this.initTooltip();
        this.initZoomIndicator();
        this.initEquityOverlay();
        this.setupZoomTracking();
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

    // ========================================================================
    // Enhanced Crosshair Tooltip
    // ========================================================================

    private initTooltip() {
        const container = document.getElementById('main-chart');
        if (!container) return;

        this.tooltip = document.createElement('div');
        this.tooltip.className = 'chart-tooltip';
        this.tooltip.innerHTML = `
            <div class="tooltip-header">
                <span class="tooltip-date" id="tooltipDate"></span>
                <span class="tooltip-change" id="tooltipChange"></span>
            </div>
            <div class="tooltip-grid">
                <div class="tooltip-item">
                    <span class="tooltip-label">Open</span>
                    <span class="tooltip-value open" id="tooltipOpen"></span>
                </div>
                <div class="tooltip-item">
                    <span class="tooltip-label">High</span>
                    <span class="tooltip-value high" id="tooltipHigh"></span>
                </div>
                <div class="tooltip-item">
                    <span class="tooltip-label">Low</span>
                    <span class="tooltip-value low" id="tooltipLow"></span>
                </div>
                <div class="tooltip-item">
                    <span class="tooltip-label">Close</span>
                    <span class="tooltip-value close" id="tooltipClose"></span>
                </div>
                <div class="tooltip-divider"></div>
                <div class="tooltip-item" style="grid-column: span 2;">
                    <span class="tooltip-label">Volume</span>
                    <span class="tooltip-value volume" id="tooltipVolume"></span>
                </div>
                <div class="tooltip-indicators" id="tooltipIndicators"></div>
            </div>
        `;
        container.appendChild(this.tooltip);
    }

    public updateTooltip(param: MouseEventParams<Time>, data: OHLCVData) {
        if (!this.tooltip) return;

        const container = document.getElementById('main-chart');
        if (!container) return;

        // Calculate position
        const containerRect = container.getBoundingClientRect();
        const x = param.point?.x ?? 0;
        const y = param.point?.y ?? 0;

        // Show tooltip
        this.tooltip.classList.add('visible');

        // Position tooltip - keep it within bounds
        const tooltipWidth = 220;
        const tooltipHeight = 200;
        let left = x + 20;
        let top = y - tooltipHeight / 2;

        if (left + tooltipWidth > containerRect.width) {
            left = x - tooltipWidth - 20;
        }
        if (top < 0) top = 10;
        if (top + tooltipHeight > containerRect.height) {
            top = containerRect.height - tooltipHeight - 10;
        }

        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top = `${top}px`;

        // Update content
        const formatPrice = (p: number) => {
            if (p >= 1000) return p.toFixed(2);
            if (p >= 1) return p.toFixed(4);
            return p.toFixed(6);
        };

        const formatVolume = (v: number) => {
            if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
            if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
            if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
            return v.toFixed(2);
        };

        const formatDate = (time: Time) => {
            if (typeof time === 'number') {
                const date = new Date(time * 1000);
                return date.toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }
            return String(time);
        };

        const change = ((data.close - data.open) / data.open) * 100;
        const isPositive = change >= 0;

        const dateEl = this.tooltip.querySelector('#tooltipDate');
        const changeEl = this.tooltip.querySelector('#tooltipChange');
        const openEl = this.tooltip.querySelector('#tooltipOpen');
        const highEl = this.tooltip.querySelector('#tooltipHigh');
        const lowEl = this.tooltip.querySelector('#tooltipLow');
        const closeEl = this.tooltip.querySelector('#tooltipClose');
        const volumeEl = this.tooltip.querySelector('#tooltipVolume');

        if (dateEl) dateEl.textContent = formatDate(data.time);
        if (changeEl) {
            changeEl.textContent = `${isPositive ? '+' : ''}${change.toFixed(2)}%`;
            changeEl.className = `tooltip-change ${isPositive ? 'positive' : 'negative'}`;
        }
        if (openEl) openEl.textContent = formatPrice(data.open);
        if (highEl) highEl.textContent = formatPrice(data.high);
        if (lowEl) lowEl.textContent = formatPrice(data.low);
        if (closeEl) closeEl.textContent = formatPrice(data.close);
        if (volumeEl && data.volume !== undefined) {
            volumeEl.textContent = formatVolume(data.volume);
        }

        // Update indicator values
        this.updateTooltipIndicators(data.time);
    }

    private updateTooltipIndicators(time: Time) {
        const indicatorsEl = this.tooltip?.querySelector('#tooltipIndicators');
        if (!indicatorsEl) return;

        const indicators = state.indicators;
        if (indicators.length === 0) {
            indicatorsEl.innerHTML = '';
            return;
        }

        const indicatorHtml = indicators.map(ind => {
            // Get the value at this time from the series
            const series = ind.series[0];
            if (!series) return '';

            // Try to get data at this time point
            const data = series.data();
            const point = data.find((d: any) => d.time === time);
            if (!point || (point as any).value === undefined) return '';

            const value = (point as any).value;
            return `
                <div class="tooltip-indicator">
                    <span class="tooltip-indicator-name">
                        <span class="tooltip-indicator-dot" style="background: ${ind.color}"></span>
                        ${ind.type}
                    </span>
                    <span class="tooltip-indicator-value">${value.toFixed(2)}</span>
                </div>
            `;
        }).join('');

        indicatorsEl.innerHTML = indicatorHtml;
    }

    public hideTooltip() {
        if (this.tooltip) {
            this.tooltip.classList.remove('visible');
        }
    }

    // ========================================================================
    // Zoom Indicator
    // ========================================================================

    private initZoomIndicator() {
        const container = document.querySelector('.chart-container');
        if (!container) return;

        this.zoomIndicator = document.createElement('div');
        this.zoomIndicator.className = 'zoom-indicator';
        container.appendChild(this.zoomIndicator);
    }

    private setupZoomTracking() {
        state.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            if (!range || !this.zoomIndicator) return;

            const currentZoom = range.to - range.from;
            const totalBars = state.ohlcvData.length;

            if (totalBars > 0) {
                const zoomPercent = Math.round((currentZoom / totalBars) * 100);

                // Only show if zoom changed significantly
                if (Math.abs(currentZoom - this.lastZoomLevel) > 2) {
                    this.lastZoomLevel = currentZoom;
                    this.zoomIndicator.textContent = `${Math.round(currentZoom)} bars (${zoomPercent}%)`;
                    this.zoomIndicator.classList.add('visible');

                    // Clear existing timeout
                    if (this.zoomTimeout) {
                        clearTimeout(this.zoomTimeout);
                    }

                    // Hide after delay
                    this.zoomTimeout = setTimeout(() => {
                        this.zoomIndicator?.classList.remove('visible');
                    }, 1500);
                }
            }
        });
    }

    // ========================================================================
    // Enhanced Zoom Controls
    // ========================================================================

    public zoomIn(factor: number = 0.7) {
        const range = state.chart.timeScale().getVisibleLogicalRange();
        if (range) {
            const center = (range.from + range.to) / 2;
            const newWidth = (range.to - range.from) * factor;
            const minWidth = 10; // Minimum 10 bars visible

            if (newWidth >= minWidth) {
                state.chart.timeScale().setVisibleLogicalRange({
                    from: center - newWidth / 2,
                    to: center + newWidth / 2
                });
            }
        }
    }

    public zoomOut(factor: number = 1.4) {
        const range = state.chart.timeScale().getVisibleLogicalRange();
        if (range) {
            const center = (range.from + range.to) / 2;
            const newWidth = (range.to - range.from) * factor;
            const maxWidth = state.ohlcvData.length;

            if (newWidth <= maxWidth * 1.1) {
                state.chart.timeScale().setVisibleLogicalRange({
                    from: center - newWidth / 2,
                    to: center + newWidth / 2
                });
            }
        }
    }

    public zoomToRange(startIndex: number, endIndex: number) {
        state.chart.timeScale().setVisibleLogicalRange({
            from: startIndex,
            to: endIndex
        });
    }

    // ========================================================================
    // Equity Overlay Stats
    // ========================================================================

    private initEquityOverlay() {
        const container = document.getElementById('equity-chart');
        if (!container) return;

        this.equityOverlay = document.createElement('div');
        this.equityOverlay.className = 'equity-overlay';
        this.equityOverlay.innerHTML = `
            <div class="equity-stat">
                <span class="equity-stat-label">P&L</span>
                <span class="equity-stat-value" id="equityPnl">-</span>
            </div>
            <div class="equity-stat">
                <span class="equity-stat-label">Max DD</span>
                <span class="equity-stat-value negative" id="equityDrawdown">-</span>
            </div>
            <div class="equity-stat">
                <span class="equity-stat-label">Peak</span>
                <span class="equity-stat-value" id="equityPeak">-</span>
            </div>
        `;
        container.style.position = 'relative';
        container.appendChild(this.equityOverlay);
    }

    private updateEquityOverlay(equityCurve: { time: Time; value: number }[], initialCapital: number) {
        if (!this.equityOverlay || equityCurve.length === 0) return;

        const finalValue = equityCurve[equityCurve.length - 1].value;
        const pnl = finalValue - initialCapital;
        const pnlPercent = (pnl / initialCapital) * 100;
        const isPositive = pnl >= 0;

        // Calculate max drawdown
        let peak = initialCapital;
        let maxDrawdown = 0;
        for (const point of equityCurve) {
            if (point.value > peak) peak = point.value;
            const drawdown = (peak - point.value) / peak * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }

        const pnlEl = this.equityOverlay.querySelector('#equityPnl');
        const ddEl = this.equityOverlay.querySelector('#equityDrawdown');
        const peakEl = this.equityOverlay.querySelector('#equityPeak');

        if (pnlEl) {
            pnlEl.textContent = `${isPositive ? '+' : ''}${pnlPercent.toFixed(2)}%`;
            pnlEl.className = `equity-stat-value ${isPositive ? 'positive' : 'negative'}`;
        }
        if (ddEl) {
            ddEl.textContent = `-${maxDrawdown.toFixed(2)}%`;
        }
        if (peakEl) {
            peakEl.textContent = `$${peak.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        }
    }

    // ========================================================================
    // Screenshot Functionality
    // ========================================================================

    public async captureScreenshot(): Promise<string> {
        const container = document.querySelector('.chart-wrapper') as HTMLElement;
        if (!container) throw new Error('Chart container not found');

        // Add flash effect
        const chartContainer = document.querySelector('.chart-container');
        chartContainer?.classList.add('screenshot-flash');

        try {
            // Use the chart's built-in takeScreenshot method for best results
            const canvas = state.chart.takeScreenshot();
            const dataUrl = canvas.toDataURL('image/png');

            // Remove flash effect after animation
            setTimeout(() => {
                chartContainer?.classList.remove('screenshot-flash');
            }, 400);

            return dataUrl;
        } catch (error) {
            chartContainer?.classList.remove('screenshot-flash');
            throw error;
        }
    }

    public downloadScreenshot(dataUrl: string, filename?: string) {
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = filename || `chart-${state.currentSymbol}-${state.currentInterval}-${Date.now()}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    public async copyScreenshotToClipboard(dataUrl: string) {
        try {
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]);
            return true;
        } catch (error) {
            console.error('Failed to copy to clipboard:', error);
            return false;
        }
    }

    // ========================================================================
    // Theme & Display
    // ========================================================================

    public updateTheme() {
        const theme = state.isDarkTheme ? darkTheme : lightTheme;
        state.chart.applyOptions(theme);
        state.equityChart.applyOptions(theme);

        // Update candlestick colors based on theme
        const colors = state.isDarkTheme ? ENHANCED_CANDLE_COLORS : {
            up: '#089981',
            down: '#f23645',
            upBorder: '#089981',
            downBorder: '#f23645',
            wickUp: '#089981',
            wickDown: '#f23645',
        };

        state.candlestickSeries.applyOptions({
            upColor: colors.up,
            downColor: colors.down,
            borderUpColor: colors.upBorder,
            borderDownColor: colors.downBorder,
            wickUpColor: colors.wickUp,
            wickDownColor: colors.wickDown,
        });
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
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 3,
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

    // ========================================================================
    // Enhanced Trade Markers
    // ========================================================================

    public displayTradeMarkers(trades: Trade[], formatPrice: (p: number) => string) {
        const markers: SeriesMarker<Time>[] = [];
        const entryMarkerTimes = new Set<string>();

        for (const trade of trades) {
            const isShort = trade.type === 'short';
            const entryKey = typeof trade.entryTime === 'object'
                ? JSON.stringify(trade.entryTime)
                : String(trade.entryTime);

            if (!entryMarkerTimes.has(entryKey)) {
                // Entry marker with enhanced styling
                markers.push({
                    time: trade.entryTime,
                    position: isShort ? 'aboveBar' : 'belowBar',
                    color: isShort ? ENHANCED_CANDLE_COLORS.down : ENHANCED_CANDLE_COLORS.up,
                    shape: isShort ? 'arrowDown' : 'arrowUp',
                    text: `${isShort ? '🔻 SELL' : '🔹 BUY'} @ ${formatPrice(trade.entryPrice)}`,
                    size: 2,
                });
                entryMarkerTimes.add(entryKey);
            }

            // Exit marker with P&L info
            const isProfit = trade.pnl >= 0;
            const exitEmoji = isProfit ? '✅' : '❌';
            const pnlText = `${isProfit ? '+' : ''}${trade.pnlPercent.toFixed(2)}%`;

            markers.push({
                time: trade.exitTime,
                position: isShort ? 'belowBar' : 'aboveBar',
                color: isProfit ? ENHANCED_CANDLE_COLORS.up : ENHANCED_CANDLE_COLORS.down,
                shape: isShort ? 'arrowUp' : 'arrowDown',
                text: `${exitEmoji} ${isShort ? 'COVER' : 'CLOSE'} @ ${formatPrice(trade.exitPrice)} (${pnlText})`,
                size: 2,
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

    public clearTradeMarkers() {
        if (state.markersPlugin) {
            state.markersPlugin.detach();
            state.markersPlugin = null;
        }
    }

    // ========================================================================
    // Enhanced Equity Curve
    // ========================================================================

    public displayEquityCurve(equityCurve: { time: Time; value: number }[], initialCapital: number = 10000) {
        if (equityCurve.length === 0) {
            state.equitySeries.setData([]);
            return;
        }

        const startValue = equityCurve[0].value;
        const endValue = equityCurve[equityCurve.length - 1].value;
        const isPositive = endValue >= startValue;

        // Enhanced gradient colors
        state.equitySeries.applyOptions({
            lineColor: isPositive ? '#00c087' : '#ff4976',
            topColor: isPositive
                ? 'rgba(0, 192, 135, 0.45)'
                : 'rgba(255, 73, 118, 0.45)',
            bottomColor: isPositive
                ? 'rgba(0, 192, 135, 0.02)'
                : 'rgba(255, 73, 118, 0.02)',
            lineWidth: 2,
        });

        state.equitySeries.setData(equityCurve);
        state.equityChart.timeScale().fitContent();

        // Update equity overlay stats
        this.updateEquityOverlay(equityCurve, initialCapital);
    }

    // ========================================================================
    // Jump to Trade
    // ========================================================================

    public jumpToTime(time: Time) {
        // Find the index of this time in the data
        const index = state.ohlcvData.findIndex(d => d.time === time);
        if (index === -1) return;

        // Center the view around this point
        const range = state.chart.timeScale().getVisibleLogicalRange();
        if (range) {
            const visibleBars = range.to - range.from;
            const halfVisible = visibleBars / 2;
            state.chart.timeScale().setVisibleLogicalRange({
                from: index - halfVisible,
                to: index + halfVisible
            });
        }
    }
}

export const chartManager = new ChartManager();
