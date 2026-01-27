import { ISeriesApi, Time, ISeriesMarkersPluginApi, IChartApi } from "lightweight-charts";
import { BacktestResult, OHLCVData } from "./strategies/index";
import type { PairAnalysisResults } from "./pairCombiner";

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
    currentStrategyKey: string;
    pairCombinerEnabled: boolean;
    secondarySymbol: string | null;
    secondaryInterval: string | null;
    secondaryOhlcvData: OHLCVData[];
    pairAnalysisResults: PairAnalysisResults | null;
}
