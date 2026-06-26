import {
    createChart,
    CandlestickSeries,
    AreaSeries,
    LineSeries,
    HistogramSeries,
    DeepPartial,
    Time,
    createSeriesMarkers,
    SeriesMarker,
    ISeriesMarkersPluginApi,
    MouseEventParams,
    ISeriesApi,
    TickMarkType,
    TimeChartOptions,
} from "lightweight-charts";
import { state } from "./state";
import { debugLogger } from "./debug-logger";
import { darkTheme, lightTheme, ENHANCED_CANDLE_COLORS, LIGHT_CANDLE_COLORS, EQUITY_CURVE_COLORS } from "./constants";
import { toHeikinAshi } from "./heikin-ashi-utils";
import { formatJakartaTickMark, formatJakartaTime } from "./timezone-utils";
import { formatDisplayPrice } from "./price-format";
import { bindChartRuntime, buildOhlcvTimeMap, setIndicators, setMarkersPlugin } from "./state-actions";
import { createChartManagerDom } from "./chart-manager-dom";

import { Trade, OHLCVData } from "./strategies/index";
import { getTimeIndex, timeKey } from "./strategies/backtest/backtest-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";

type IndicatorTooltipPoint = {
    time: Time;
    value?: number | null;
};

export type ExecutionLabPolymarketPricePoint = {
    time: Time;
    yes: number | null;
    no: number | null;
};

// ============================================================================
// Chart Manager - Enhanced Trade Charting
// ============================================================================

export class ChartManager {
    private static readonly COMPACT_MARKER_LABEL_THRESHOLD = 100;
    private static readonly MAX_VISIBLE_TRADE_MARKERS = 250;

    private mainChartContainer: HTMLElement | null = null;
    private equityChartContainer: HTMLElement | null = null;
    private tooltip: HTMLElement | null = null;
    private tooltipDateEl: HTMLElement | null = null;
    private tooltipChangeEl: HTMLElement | null = null;
    private tooltipOpenEl: HTMLElement | null = null;
    private tooltipHighEl: HTMLElement | null = null;
    private tooltipLowEl: HTMLElement | null = null;
    private tooltipCloseEl: HTMLElement | null = null;
    private tooltipVolumeEl: HTMLElement | null = null;
    private tooltipIndicatorsEl: HTMLElement | null = null;
    private zoomIndicator: HTMLElement | null = null;
    private equityOverlay: HTMLElement | null = null;
    private equityPnlEl: HTMLElement | null = null;
    private equityDrawdownEl: HTMLElement | null = null;
    private equityPeakEl: HTMLElement | null = null;
    private indicatorTooltipValues = new Map<string, Map<string, number>>();
    private zoomTimeout: ReturnType<typeof setTimeout> | null = null;
    private lastZoomLevel: number = 0;
    private secondarySeries: ISeriesApi<"Line"> | null = null;
    private spreadSeries: ISeriesApi<"Line"> | null = null;
    private correlationUpperSeries: ISeriesApi<"Line"> | null = null;
    private correlationLowerSeries: ISeriesApi<"Line"> | null = null;
    private executionLabYesSeries: ISeriesApi<"Line"> | null = null;
    private executionLabNoSeries: ISeriesApi<"Line"> | null = null;
    private executionLabMarkersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
    private committeeScoreMarkersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
    private paperStreamFirstTimeSec: number | null = null;
    private paperStreamLastTimeSec: number | null = null;
    private paperStreamDataLength = 0;
    private indicatorDomCache = new Map<string, { node: HTMLElement; valNode: HTMLElement }>();
    private tooltipIndicatorSetRef: typeof state.indicators | null = null;
    private cachedContainerRect: DOMRect | null = null;
    private readonly MIN_BAR_SPACING = 2;
    private readonly jakartaTimeFormatter = (time: Time): string => (
        formatJakartaTime(
            time,
            {
                month: 'short',
                day: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            }
        )
    );
    private readonly jakartaTickMarkFormatter = (time: Time, tickMarkType: TickMarkType, locale: string): string | null => (
        formatJakartaTickMark(time, tickMarkType, locale)
    );

    public initCharts() {
        const dom = createChartManagerDom();
        this.mainChartContainer = dom.mainChartContainer;
        this.equityChartContainer = dom.equityChartContainer;
        const container = this.mainChartContainer;
        const equityContainer = this.equityChartContainer;
        if (!container || !equityContainer) {
            throw new Error('Chart containers not found');
        }

        const chart = createChart(container, {
            ...darkTheme,
            autoSize: true,
            localization: {
                timeFormatter: this.jakartaTimeFormatter,
            },
            timeScale: {
                ...darkTheme.timeScale,
                tickMarkFormatter: this.jakartaTickMarkFormatter,
            },
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
        } as DeepPartial<TimeChartOptions>);

        // Enhanced candlestick styling with better colors
        const candlestickSeries = chart.addSeries(CandlestickSeries, {
            upColor: ENHANCED_CANDLE_COLORS.up,
            downColor: ENHANCED_CANDLE_COLORS.down,
            borderVisible: true,
            borderUpColor: ENHANCED_CANDLE_COLORS.upBorder,
            borderDownColor: ENHANCED_CANDLE_COLORS.downBorder,
            wickUpColor: ENHANCED_CANDLE_COLORS.wickUp,
            wickDownColor: ENHANCED_CANDLE_COLORS.wickDown,
        });

        const equityChart = createChart(equityContainer, {
            ...darkTheme,
            autoSize: true,
            localization: {
                timeFormatter: this.jakartaTimeFormatter,
            },
            timeScale: {
                ...darkTheme.timeScale,
                tickMarkFormatter: this.jakartaTickMarkFormatter,
            },
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
        } as DeepPartial<TimeChartOptions>);

        // Enhanced equity curve with better gradient
        const equitySeries = equityChart.addSeries(AreaSeries, {
            lineColor: '#2962ff',
            topColor: 'rgba(41, 98, 255, 0.5)',
            bottomColor: 'rgba(41, 98, 255, 0.05)',
            lineWidth: 2,
            priceLineVisible: false,
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 4,
        });

        bindChartRuntime({
            chart,
            equityChart,
            candlestickSeries,
            equitySeries,
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
        const container = this.mainChartContainer;
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
        this.tooltipDateEl = this.tooltip.querySelector<HTMLElement>('#tooltipDate');
        this.tooltipChangeEl = this.tooltip.querySelector<HTMLElement>('#tooltipChange');
        this.tooltipOpenEl = this.tooltip.querySelector<HTMLElement>('#tooltipOpen');
        this.tooltipHighEl = this.tooltip.querySelector<HTMLElement>('#tooltipHigh');
        this.tooltipLowEl = this.tooltip.querySelector<HTMLElement>('#tooltipLow');
        this.tooltipCloseEl = this.tooltip.querySelector<HTMLElement>('#tooltipClose');
        this.tooltipVolumeEl = this.tooltip.querySelector<HTMLElement>('#tooltipVolume');
        this.tooltipIndicatorsEl = this.tooltip.querySelector<HTMLElement>('#tooltipIndicators');

        const observer = new ResizeObserver(() => {
            this.cachedContainerRect = null;
        });
        observer.observe(container);
    }

    public updateTooltip(param: MouseEventParams<Time>, data: OHLCVData) {
        if (!this.tooltip) return;

        const container = this.mainChartContainer;
        if (!container) return;

        // Calculate position
        let containerRect = this.cachedContainerRect;
        if (!containerRect) {
            containerRect = container.getBoundingClientRect();
            this.cachedContainerRect = containerRect;
        }
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
        const formatPrice = (p: number) => formatDisplayPrice(p);

        const formatVolume = (v: number) => {
            if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
            if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
            if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
            return v.toFixed(2);
        };

        const formatDate = (time: Time) => formatJakartaTime(time, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });

        const change = ((data.close - data.open) / data.open) * 100;
        const isPositive = change >= 0;

        if (this.tooltipDateEl) this.tooltipDateEl.textContent = formatDate(data.time);
        if (this.tooltipChangeEl) {
            this.tooltipChangeEl.textContent = `${isPositive ? '+' : ''}${change.toFixed(2)}%`;
            this.tooltipChangeEl.className = `tooltip-change ${isPositive ? 'positive' : 'negative'}`;
        }
        if (this.tooltipOpenEl) this.tooltipOpenEl.textContent = formatPrice(data.open);
        if (this.tooltipHighEl) this.tooltipHighEl.textContent = formatPrice(data.high);
        if (this.tooltipLowEl) this.tooltipLowEl.textContent = formatPrice(data.low);
        if (this.tooltipCloseEl) this.tooltipCloseEl.textContent = formatPrice(data.close);
        if (this.tooltipVolumeEl && data.volume !== undefined) {
            this.tooltipVolumeEl.textContent = formatVolume(data.volume);
        }

        // Update indicator values
        this.updateTooltipIndicators(data.time);
    }

    private updateTooltipIndicators(time: Time) {
        const indicatorsEl = this.tooltipIndicatorsEl;
        if (!indicatorsEl) return;

        const indicators = state.indicators;
        if (indicators.length === 0) {
            if (this.indicatorDomCache.size > 0) {
                indicatorsEl.innerHTML = '';
                this.indicatorDomCache.clear();
            }
            this.tooltipIndicatorSetRef = indicators;
            return;
        }

        if (this.tooltipIndicatorSetRef !== indicators) {
            this.rebuildTooltipIndicatorDom(indicatorsEl, indicators);
            this.tooltipIndicatorSetRef = indicators;
        }

        const tooltipTimeKey = timeKey(time);

        for (const ind of indicators) {
            const value = this.indicatorTooltipValues.get(ind.id)?.get(tooltipTimeKey);
            const dom = this.indicatorDomCache.get(ind.id);
            if (!dom) continue;

            if (value === undefined || value === null) {
                if (dom.node.style.display !== 'none') {
                    dom.node.style.display = 'none';
                }
            } else {
                if (dom.node.style.display === 'none') {
                    dom.node.style.display = '';
                }
                dom.valNode.textContent = value.toFixed(2);
            }
        }
    }

    private rebuildTooltipIndicatorDom(
        indicatorsEl: HTMLElement,
        indicators: typeof state.indicators
    ): void {
        indicatorsEl.innerHTML = '';
        this.indicatorDomCache.clear();

        for (const ind of indicators) {
            const node = document.createElement('div');
            node.className = 'tooltip-indicator';
            node.style.display = 'none';

            const nameNode = document.createElement('span');
            nameNode.className = 'tooltip-indicator-name';

            const dot = document.createElement('span');
            dot.className = 'tooltip-indicator-dot';
            dot.style.background = ind.color;

            nameNode.appendChild(dot);
            nameNode.appendChild(document.createTextNode(' ' + ind.type));

            const valNode = document.createElement('span');
            valNode.className = 'tooltip-indicator-value';

            node.appendChild(nameNode);
            node.appendChild(valNode);

            indicatorsEl.appendChild(node);
            this.indicatorDomCache.set(ind.id, { node, valNode });
        }
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
                const clampedWidth = Math.max(minWidth, this.clampVisibleBars(newWidth));
                state.chart.timeScale().setVisibleLogicalRange({
                    from: center - clampedWidth / 2,
                    to: center + clampedWidth / 2
                });
            }
        }
    }

    public zoomOut(factor: number = 1.4) {
        const range = state.chart.timeScale().getVisibleLogicalRange();
        if (range) {
            const center = (range.from + range.to) / 2;
            const newWidth = (range.to - range.from) * factor;
            const maxWidth = this.clampVisibleBars(state.ohlcvData.length);

            if (newWidth <= maxWidth * 1.1) {
                const clampedWidth = Math.min(newWidth, maxWidth);
                state.chart.timeScale().setVisibleLogicalRange({
                    from: center - clampedWidth / 2,
                    to: center + clampedWidth / 2
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

    private clampVisibleBars(targetBars: number): number {
        const width = state.chart.timeScale().width();
        if (!Number.isFinite(width) || width <= 0) return targetBars;
        const maxBars = Math.max(10, Math.floor(width / this.MIN_BAR_SPACING));
        return Math.min(targetBars, maxBars);
    }

    // ========================================================================
    // Equity Overlay Stats
    // ========================================================================

    private initEquityOverlay() {
        const container = this.equityChartContainer;
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
        this.equityPnlEl = this.equityOverlay.querySelector<HTMLElement>('#equityPnl');
        this.equityDrawdownEl = this.equityOverlay.querySelector<HTMLElement>('#equityDrawdown');
        this.equityPeakEl = this.equityOverlay.querySelector<HTMLElement>('#equityPeak');
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

        if (this.equityPnlEl) {
            this.equityPnlEl.textContent = `${isPositive ? '+' : ''}${pnlPercent.toFixed(2)}%`;
            this.equityPnlEl.className = `equity-stat-value ${isPositive ? 'positive' : 'negative'}`;
        }
        if (this.equityDrawdownEl) {
            this.equityDrawdownEl.textContent = `-${maxDrawdown.toFixed(2)}%`;
        }
        if (this.equityPeakEl) {
            this.equityPeakEl.textContent = `$${peak.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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
            debugLogger.error("chart.copy_to_clipboard_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
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
        this.applyJakartaTimeFormatting();

        // Update candlestick colors based on theme
        const colors = state.isDarkTheme ? ENHANCED_CANDLE_COLORS : LIGHT_CANDLE_COLORS;

        state.candlestickSeries.applyOptions({
            upColor: colors.up,
            downColor: colors.down,
            borderUpColor: colors.upBorder,
            borderDownColor: colors.downBorder,
            wickUpColor: colors.wickUp,
            wickDownColor: colors.wickDown,
        });
    }

    private applyJakartaTimeFormatting() {
        const options = {
            localization: {
                timeFormatter: this.jakartaTimeFormatter,
            },
            timeScale: {
                tickMarkFormatter: this.jakartaTickMarkFormatter,
            },
        } as DeepPartial<TimeChartOptions>;

        state.chart.applyOptions(options);
        state.equityChart.applyOptions(options);
    }

    /**
     * Updates chart candlestick data with appropriate transformation based on chart mode.
     * When chartMode is 'heikin-ashi', applies Heikin Ashi transformation to the raw data.
     * This is purely visual - the underlying state.ohlcvData remains unchanged for strategies.
     */
    public updateChartData() {
        const rawData = state.ohlcvData;
        if (rawData.length === 0) return;

        // Apply transformation if Heikin Ashi mode is active
        const displayData = state.chartMode === 'heikin-ashi'
            ? toHeikinAshi(rawData)
            : rawData;

        // Update candlestick series with transformed data
        if (state.chartMode === 'heikin-ashi') {
            state.candlestickSeries.setData(displayData.map(d => ({
                time: d.time,
                open: d.open,
                high: d.high,
                low: d.low,
                close: d.close,
            })));
        } else {
            // Avoid array allocation for normal candlestick mode since OHLCVData contains time, open, high, low, close
            state.candlestickSeries.setData(displayData as any);
        }
    }

    public displayPaperStreamData(data: OHLCVData[]): void {
        if (data.length === 0) return;
        const displayData = state.chartMode === 'heikin-ashi'
            ? toHeikinAshi(data)
            : data;

        state._ohlcvTimeMap = buildOhlcvTimeMap(data);
        state.candlestickSeries.setData(displayData.map(d => ({
            time: d.time,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
        })));
        const first = data[0] ?? null;
        const last = data[data.length - 1] ?? null;
        this.paperStreamFirstTimeSec = first ? parseTimeToUnixSeconds(first.time) : null;
        this.paperStreamLastTimeSec = last ? parseTimeToUnixSeconds(last.time) : null;
        this.paperStreamDataLength = data.length;
        state.chart.timeScale().scrollToRealTime();
    }

    public updatePaperStreamData(data: OHLCVData[], changedCandles: readonly OHLCVData[]): void {
        if (data.length === 0) return;
        const nextFirstTimeSec = parseTimeToUnixSeconds(data[0]!.time);
        if (
            state.chartMode === 'heikin-ashi'
            || changedCandles.length === 0
            || this.paperStreamFirstTimeSec === null
            || nextFirstTimeSec === null
            || nextFirstTimeSec !== this.paperStreamFirstTimeSec
            || this.paperStreamLastTimeSec === null
            || this.paperStreamDataLength === 0
            || data.length < this.paperStreamDataLength
            || data.length > this.paperStreamDataLength + changedCandles.length
        ) {
            this.displayPaperStreamData(data);
            return;
        }

        for (const candle of changedCandles) {
            const ts = parseTimeToUnixSeconds(candle.time);
            if (ts === null || ts < this.paperStreamLastTimeSec) {
                this.displayPaperStreamData(data);
                return;
            }
        }

        for (const candle of changedCandles) {
            state._ohlcvTimeMap.set(timeKey(candle.time), candle);
            state.candlestickSeries.update({
                time: candle.time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
            });
        }

        const last = data[data.length - 1] ?? null;
        this.paperStreamFirstTimeSec = nextFirstTimeSec;
        this.paperStreamLastTimeSec = last ? parseTimeToUnixSeconds(last.time) : null;
        this.paperStreamDataLength = data.length;
        state.chart.timeScale().scrollToRealTime();
    }

    public displayExecutionLabPolymarketPrices(points: ExecutionLabPolymarketPricePoint[]): void {
        if (points.length === 0) {
            this.clearExecutionLabPolymarketPrices();
            return;
        }

        if (!this.executionLabYesSeries) {
            this.executionLabYesSeries = state.chart.addSeries(LineSeries, {
                color: ENHANCED_CANDLE_COLORS.up,
                lineWidth: 2,
                priceLineVisible: true,
                lastValueVisible: true,
                crosshairMarkerVisible: true,
                priceScaleId: "execution-lab-polymarket",
                title: "YES",
                priceFormat: {
                    type: "price",
                    precision: 3,
                    minMove: 0.001,
                },
            });
        }

        if (!this.executionLabNoSeries) {
            this.executionLabNoSeries = state.chart.addSeries(LineSeries, {
                color: ENHANCED_CANDLE_COLORS.down,
                lineWidth: 2,
                priceLineVisible: true,
                lastValueVisible: true,
                crosshairMarkerVisible: true,
                priceScaleId: "execution-lab-polymarket",
                title: "NO",
                priceFormat: {
                    type: "price",
                    precision: 3,
                    minMove: 0.001,
                },
            });
        }

        state.chart.priceScale("execution-lab-polymarket").applyOptions({
            scaleMargins: { top: 0.72, bottom: 0.08 },
            visible: false,
        });

        this.executionLabYesSeries.setData(points
            .filter((point) => point.yes !== null)
            .map((point) => ({ time: point.time, value: point.yes as number })));
        this.executionLabNoSeries.setData(points
            .filter((point) => point.no !== null)
            .map((point) => ({ time: point.time, value: point.no as number })));
    }

    public clearExecutionLabPolymarketPrices(): void {
        if (this.executionLabYesSeries) {
            state.chart.removeSeries(this.executionLabYesSeries);
            this.executionLabYesSeries = null;
        }
        if (this.executionLabNoSeries) {
            state.chart.removeSeries(this.executionLabNoSeries);
            this.executionLabNoSeries = null;
        }
    }

    public restoreStateChartData(): void {
        state._ohlcvTimeMap = buildOhlcvTimeMap(state.ohlcvData);
        if (state.ohlcvData.length === 0) {
            state.candlestickSeries.setData([]);
            return;
        }
        this.updateChartData();
    }

    // ========================================================================
    // Pair Overlay & Spread Visualization
    // ========================================================================

    public addSecondaryPairOverlay(data: OHLCVData[], color?: string): void {
        if (!data || data.length === 0) {
            this.removeSecondaryPairOverlay();
            return;
        }

        if (this.secondarySeries) {
            state.chart.removeSeries(this.secondarySeries);
            this.secondarySeries = null;
        }

        const series = state.chart.addSeries(LineSeries, {
            color: color ?? 'rgba(246, 195, 67, 0.9)',
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            priceScaleId: 'pair',
        });

        series.setData(data.map(d => ({ time: d.time, value: d.close })));
        this.secondarySeries = series;

        state.chart.priceScale('pair').applyOptions({
            scaleMargins: { top: 0.1, bottom: 0.1 },
            borderColor: 'rgba(255,255,255,0.1)',
            visible: false,
        });
    }

    public removeSecondaryPairOverlay(): void {
        if (this.secondarySeries) {
            state.chart.removeSeries(this.secondarySeries);
            this.secondarySeries = null;
        }
    }

    public addSecondaryPairLine(data: OHLCVData[], color?: string): void {
        this.addSecondaryPairOverlay(data, color);
    }

    public removeSecondaryPairLine(): void {
        this.removeSecondaryPairOverlay();
    }

    public displaySpreadChart(spread: number[], timestamps: Time[]): void {
        if (!this.spreadSeries) {
            this.spreadSeries = state.equityChart.addSeries(LineSeries, {
                color: 'rgba(0, 192, 135, 0.85)',
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: false,
                priceScaleId: 'spread',
            });
            state.equityChart.priceScale('spread').applyOptions({
                scaleMargins: { top: 0.2, bottom: 0.2 },
                borderColor: 'rgba(255,255,255,0.1)',
                visible: false,
            });
        }

        if (spread.length === 0 || timestamps.length === 0) {
            this.spreadSeries.setData([]);
            return;
        }

        const length = Math.min(spread.length, timestamps.length);
        const data = new Array(length);
        for (let i = 0; i < length; i++) {
            data[i] = { time: timestamps[i], value: spread[i] };
        }
        this.spreadSeries.setData(data);
        state.equityChart.timeScale().fitContent();
    }

    public displaySpreadSeries(spread: number[], timestamps: Time[]): void {
        this.displaySpreadChart(spread, timestamps);
    }

    public displayDivergenceBands(upper: number[], lower: number[], timestamps?: Time[]): void {
        this.displayCorrelationBand(upper, lower, timestamps);
    }

    public displayCorrelationBand(upper: number[], lower: number[], timestamps?: Time[]): void {
        if (!this.correlationUpperSeries) {
            this.correlationUpperSeries = state.equityChart.addSeries(LineSeries, {
                color: 'rgba(100, 149, 237, 0.6)',
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                lineStyle: 1,
                priceScaleId: 'spread',
            });
        }
        if (!this.correlationLowerSeries) {
            this.correlationLowerSeries = state.equityChart.addSeries(LineSeries, {
                color: 'rgba(100, 149, 237, 0.35)',
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                lineStyle: 1,
                priceScaleId: 'spread',
            });
        }

        const timeSeries = timestamps ?? state.ohlcvData.map(d => d.time);
        if (upper.length === 0 || lower.length === 0 || timeSeries.length === 0) {
            this.correlationUpperSeries.setData([]);
            this.correlationLowerSeries.setData([]);
            return;
        }

        const length = Math.min(upper.length, lower.length, timeSeries.length);
        const upperData = new Array(length);
        const lowerData = new Array(length);
        for (let i = 0; i < length; i++) {
            upperData[i] = { time: timeSeries[i], value: upper[i] };
            lowerData[i] = { time: timeSeries[i], value: lower[i] };
        }
        this.correlationUpperSeries.setData(upperData);
        this.correlationLowerSeries.setData(lowerData);
    }

    public clearIndicators() {
        state.indicators.forEach(ind => ind.series.forEach(s => state.chart.removeSeries(s)));
        setIndicators([]);
        this.indicatorTooltipValues.clear();
        this.indicatorDomCache.clear();
        this.tooltipIndicatorSetRef = null;
        if (this.tooltipIndicatorsEl) {
            this.tooltipIndicatorsEl.innerHTML = '';
        }
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
        this.indexIndicatorTooltipData(id, data);
        setIndicators([...state.indicators, { id, type, series: [series], color }]);
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
        this.indexIndicatorTooltipData(id, data);
        setIndicators([...state.indicators, { id, type, series: [series], color }]);
        return id;
    }

    // ========================================================================
    // Signal Committee overlay (score wick markers)
    // ------------------------------------------------------------------------
    // The committee score is projected onto the main candlestick series as a
    // thin set of wick markers — one per bar where the verdict changes, plus
    // the latest bar — so the numeric score (+3, -2, 0) reads directly on the
    // chart instead of being buried in a side-panel badge. Positive scores sit
    // above the bar in green with an up arrow; negative scores sit below in red
    // with a down arrow. A dedicated markers plugin coexists with the trade and
    // execution-lab marker plugins on the same candlestick series.
    // ------------------------------------------------------------------------

    /**
     * Stamp the committee score as wick markers on the candlestick series.
     * Each entry is a `{ time, value }` pair whose `value` is the net vote at
     * that bar (caller picks which bars are worth annotating). Pass an empty
     * array to clear.
     */
    public setCommitteeScoreOverlay(points: { time: Time; value: number }[]): void {
        if (points.length === 0) {
            this.removeCommitteeScoreOverlay();
            return;
        }
        const markers: SeriesMarker<Time>[] = points.map((point) => {
            const score = point.value;
            const isLong = score > 0;
            const isFlat = score === 0;
            const color = isLong ? ENHANCED_CANDLE_COLORS.up
                : score < 0 ? ENHANCED_CANDLE_COLORS.down
                    : "#888888";
            const sign = score > 0 ? `+${score}` : `${score}`;
            return {
                time: point.time,
                position: isLong || isFlat ? 'aboveBar' : 'belowBar',
                color,
                shape: isLong || isFlat ? 'arrowUp' : 'arrowDown',
                text: `Score ${sign}`,
                size: 1,
            };
        });
        this.clearCommitteeScoreMarkers();
        this.committeeScoreMarkersPlugin = createSeriesMarkers(state.candlestickSeries, markers);
    }

    public removeCommitteeScoreOverlay(): void {
        this.clearCommitteeScoreMarkers();
    }

    private clearCommitteeScoreMarkers(): void {
        if (this.committeeScoreMarkersPlugin) {
            this.committeeScoreMarkersPlugin.detach();
            this.committeeScoreMarkersPlugin = null;
        }
    }

    private indexIndicatorTooltipData(id: string, data: IndicatorTooltipPoint[]): void {
        const valuesByTime = new Map<string, number>();
        for (const point of data) {
            if (point.value === undefined || point.value === null) {
                continue;
            }
            valuesByTime.set(timeKey(point.time), point.value);
        }
        this.indicatorTooltipValues.set(id, valuesByTime);
    }

    // ========================================================================
    // Enhanced Trade Markers
    // ========================================================================

    public displayTradeMarkers(trades: Trade[], formatPrice: (p: number) => string) {
        const markerTrades = this.getTradesForMarkerRender(trades);
        const markers: SeriesMarker<Time>[] = [];
        const entryMarkerTimes = new Set<string>();
        const compactLabels = trades.length > ChartManager.COMPACT_MARKER_LABEL_THRESHOLD
            || state.currentStrategyKey === 'dynamic_vix_regime';

        for (const trade of markerTrades) {
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
                    text: compactLabels ? '' : `${isShort ? '🔻 SELL' : '🔹 BUY'} @ ${formatPrice(trade.entryPrice)}`,
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
                text: compactLabels ? '' : `${exitEmoji} ${isShort ? 'COVER' : 'CLOSE'} @ ${formatPrice(trade.exitPrice)} (${pnlText})`,
                size: 2,
            });
        }

        if (state.markersPlugin) {
            state.markersPlugin.detach();
        }
        setMarkersPlugin(createSeriesMarkers(state.candlestickSeries, markers));
    }

    private getTradesForMarkerRender(trades: Trade[]): Trade[] {
        if (trades.length <= ChartManager.MAX_VISIBLE_TRADE_MARKERS) {
            return trades;
        }

        return trades.slice(-ChartManager.MAX_VISIBLE_TRADE_MARKERS);
    }

    public clearTradeMarkers() {
        if (state.markersPlugin) {
            state.markersPlugin.detach();
            setMarkersPlugin(null);
        }
    }

    public displayExecutionLabMarkers(markers: SeriesMarker<Time>[]): void {
        this.clearExecutionLabMarkers();
        this.executionLabMarkersPlugin = createSeriesMarkers(state.candlestickSeries, markers);
    }

    public clearExecutionLabMarkers(): void {
        if (this.executionLabMarkersPlugin) {
            this.executionLabMarkersPlugin.detach();
            this.executionLabMarkersPlugin = null;
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
        const colors = isPositive ? EQUITY_CURVE_COLORS.positive : EQUITY_CURVE_COLORS.negative;

        // Enhanced gradient colors
        state.equitySeries.applyOptions({
            lineColor: colors.lineColor,
            topColor: colors.topColor,
            bottomColor: colors.bottomColor,
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
        const index = this.findTimeIndex(time);
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

    private findTimeIndex(time: Time): number {
        const index = getTimeIndex(state.ohlcvData).get(timeKey(time));
        return index === undefined ? -1 : index;
    }
}

export const chartManager = new ChartManager();
