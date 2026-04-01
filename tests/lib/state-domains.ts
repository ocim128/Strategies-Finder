import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time } from "lightweight-charts";
import type { Indicator } from "./types/index";
import { state, type BacktestResultSource, type MockChartModel, type State, type TwoHourCloseParityMode, type TwoHourParityBacktestResults, type ChartMode } from "./state";
import type { BinanceMarketType } from "./binance-market";
import type { BacktestResult, OHLCVData } from "./strategies/index";

export interface MarketState {
    currentSymbol: string;
    currentInterval: string;
    binanceMarketType: BinanceMarketType;
    ohlcvData: OHLCVData[];
    twoHourCloseParity: TwoHourCloseParityMode;
}

export interface ChartState {
    chart: IChartApi;
    equityChart: IChartApi;
    candlestickSeries: ISeriesApi<"Candlestick">;
    equitySeries: ISeriesApi<"Area">;
    markersPlugin: ISeriesMarkersPluginApi<Time> | null;
    mockChartModel: MockChartModel;
    mockChartBars: number;
    chartMode: ChartMode;
    indicators: Indicator[];
}

export interface BacktestState {
    currentBacktestResult: BacktestResult | null;
    currentBacktestResultSource: BacktestResultSource;
    twoHourParityBacktestResults: TwoHourParityBacktestResults | null;
    strategyTimeframeEnabled: boolean;
    strategyTimeframeMinutes: number;
}

export interface LayoutState {
    currentStrategyKey: string;
    isDarkTheme: boolean;
    blockRange: { from: number; to: number } | null;
}

export function selectMarketState(source: State = state): Readonly<MarketState> {
    return {
        currentSymbol: source.currentSymbol,
        currentInterval: source.currentInterval,
        binanceMarketType: source.binanceMarketType,
        ohlcvData: source.ohlcvData,
        twoHourCloseParity: source.twoHourCloseParity,
    };
}

export function selectChartState(source: State = state): Readonly<ChartState> {
    return {
        chart: source.chart,
        equityChart: source.equityChart,
        candlestickSeries: source.candlestickSeries,
        equitySeries: source.equitySeries,
        markersPlugin: source.markersPlugin,
        mockChartModel: source.mockChartModel,
        mockChartBars: source.mockChartBars,
        chartMode: source.chartMode,
        indicators: source.indicators,
    };
}

export function selectBacktestState(source: State = state): Readonly<BacktestState> {
    return {
        currentBacktestResult: source.currentBacktestResult,
        currentBacktestResultSource: source.currentBacktestResultSource,
        twoHourParityBacktestResults: source.twoHourParityBacktestResults,
        strategyTimeframeEnabled: source.strategyTimeframeEnabled,
        strategyTimeframeMinutes: source.strategyTimeframeMinutes,
    };
}

export function selectLayoutState(source: State = state): Readonly<LayoutState> {
    return {
        currentStrategyKey: source.currentStrategyKey,
        isDarkTheme: source.isDarkTheme,
        blockRange: source.blockRange,
    };
}
