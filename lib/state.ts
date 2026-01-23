import { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time } from "lightweight-charts";
import { BacktestResult, OHLCVData } from "./strategies/index";
import { Indicator } from "./types";

export type StateKey = keyof State;
export type MockChartModel = 'simple' | 'hard' | 'v3' | 'v4';

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
    public isDarkTheme = true;
    public ohlcvData: OHLCVData[] = [];
    public indicators: Indicator[] = [];
    public currentBacktestResult: BacktestResult | null = null;
    public currentStrategyKey = 'sma_crossover';

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
        this.set('indicators', []);
        this.set('markersPlugin', null);
    }
}

export const state = new State();
