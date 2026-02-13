import { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time } from "lightweight-charts";
import { BacktestResult, OHLCVData } from "./strategies/index";
import type { PairAnalysisResults } from "./pairCombiner";
import { Indicator } from './types/index';

export type StateKey = keyof State;
export type MockChartModel = 'simple' | 'hard' | 'v3' | 'v4' | 'v5' | 'v6';
export type ChartMode = 'candlestick' | 'heikin-ashi';
export type TwoHourCloseParity = 'odd' | 'even';

export interface TwoHourParityBacktestResults {
    odd: BacktestResult;
    even: BacktestResult;
    baseline: TwoHourCloseParity;
}

export class State {
    public chart!: IChartApi;
    public equityChart!: IChartApi;
    public candlestickSeries!: ISeriesApi<"Candlestick">;
    public equitySeries!: ISeriesApi<"Area">;
    public markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
    public currentSymbol = 'ETHUSDT';
    public currentInterval = '1d';
    public mockChartModel: MockChartModel = 'simple';
    public mockChartBars = 30000;
    public chartMode: ChartMode = 'candlestick';
    public isDarkTheme = true;
    public ohlcvData: OHLCVData[] = [];
    public indicators: Indicator[] = [];
    public currentBacktestResult: BacktestResult | null = null;
    public twoHourParityBacktestResults: TwoHourParityBacktestResults | null = null;
    public currentStrategyKey = 'sma_crossover';

    // Pair Combiner state
    public pairCombinerEnabled = false;
    public secondarySymbol: string | null = null;
    public secondaryInterval: string | null = null;
    public secondaryOhlcvData: OHLCVData[] = [];
    public pairAnalysisResults: PairAnalysisResults | null = null;

    // Replay state
    public replayMode: boolean = false;
    public replayBarIndex: number = 0;

    private listeners: Map<string, Set<(value: any) => void>> = new Map();

    public set<K extends StateKey>(key: K, value: this[K]): void {
        if (this[key] === value) return;
        (this as any)[key] = value;
        this.emit(key, value);
    }

    public subscribe<K extends StateKey>(key: K, callback: (value: this[K]) => void): () => void {
        if (!this.listeners.has(key)) {
            this.listeners.set(key, new Set());
        }
        this.listeners.get(key)!.add(callback);
        return () => this.listeners.get(key)!.delete(callback);
    }

    public emit(key: string, value: any): void {
        if (this.listeners.has(key)) {
            this.listeners.get(key)!.forEach(cb => cb(value));
        }
    }

    // Helper to reset trade-related state
    public clearTradeResults() {
        this.set('currentBacktestResult', null);
        this.set('twoHourParityBacktestResults', null);
        this.set('indicators', []);
        this.set('markersPlugin', null);
    }
}

export const state = new State();

