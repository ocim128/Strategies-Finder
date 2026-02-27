import { ISeriesApi, Time, ISeriesMarkersPluginApi, IChartApi } from "lightweight-charts";
import { BacktestResult, OHLCVData } from "./strategies";
import type { BacktestResultSource, TwoHourParityBacktestResults } from "../state";

export * from './strategies';
export * from './backtest';
export * from './finder';

export * from './scanner';
export * from './data-providers';
export * from './feature-lab';

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
    isDarkTheme: boolean;
    mockChartModel: string;
    mockChartBars: number;
    ohlcvData: OHLCVData[];
    indicators: Indicator[];
    currentBacktestResult: BacktestResult | null;
    currentBacktestResultSource: BacktestResultSource;
    twoHourParityBacktestResults: TwoHourParityBacktestResults | null;
    currentStrategyKey: string;
}
