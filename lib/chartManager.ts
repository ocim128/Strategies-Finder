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
}

export const chartManager = new ChartManager();
