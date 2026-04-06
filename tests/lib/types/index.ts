import { ISeriesApi, Time, ISeriesMarkersPluginApi, IChartApi } from "lightweight-charts";
import { BacktestResult, OHLCVData } from "./strategies";
import type { BacktestResultSource } from "../state";
import type { BinanceMarketType } from "../binance-market";

export * from './strategies';
export * from './backtest';
export * from './finder';

export * from './scanner';
export * from './data-providers';

export interface Indicator {
    id: string;
    type: string;
    series: ISeriesApi<any>[];
    color: string;
}

export interface AppState {
    chart: IChartApi;
    equityChart: IChartApi;
    candlestickSeries: ISeriesApi<"Candlestick">;
    equitySeries: ISeriesApi<"Area">;
    markersPlugin: ISeriesMarkersPluginApi<Time> | null;
    currentSymbol: string;
    currentInterval: string;
    binanceMarketType: BinanceMarketType;
    isDarkTheme: boolean;
    mockChartModel: string;
    mockChartBars: number;
    ohlcvData: OHLCVData[];
    indicators: Indicator[];
    currentBacktestResult: BacktestResult | null;
    currentBacktestResultSource: BacktestResultSource;
    currentStrategyKey: string;
}
