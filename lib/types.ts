import { ISeriesApi, Time, ISeriesMarkersPluginApi, IChartApi } from "lightweight-charts";
import { BacktestResult, OHLCVData } from "../../../../src/strategies/index";

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
    ohlcvData: OHLCVData[];
    indicators: Indicator[];
    currentBacktestResult: BacktestResult | null;
    currentStrategyKey: string;
}
