import { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time } from "lightweight-charts";
import { BacktestResult, OHLCVData } from "./strategies/index";

import { Indicator } from './types/index';
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "./strategy-defaults";

type NonFunctionPropertyKeys<T> = {
    [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : K;
}[keyof T];

export type StateKey = NonFunctionPropertyKeys<State>;
export type MockChartModel = 'simple' | 'hard' | 'v3' | 'v4' | 'v5' | 'v6';
export type ChartMode = 'candlestick' | 'heikin-ashi';
export type TwoHourCloseParity = 'odd' | 'even';
export type TwoHourCloseParityMode = TwoHourCloseParity | 'both';
export type BacktestResultSource = 'backtest' | 'ensemble_preview' | 'finder_selection' | 'finder_robust_oos' | 'walk_forward_oos';

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
    public blockRange: { from: number; to: number } | null = null;
    public indicators: Indicator[] = [];
    public currentBacktestResult: BacktestResult | null = null;
    public currentBacktestResultSource: BacktestResultSource = 'backtest';
    public twoHourParityBacktestResults: TwoHourParityBacktestResults | null = null;
    public currentStrategyKey = DEFAULT_BUILT_IN_STRATEGY_KEY;
    public strategyTimeframeEnabled = false;
    public strategyTimeframeMinutes = 120;
    public twoHourCloseParity: TwoHourCloseParityMode = 'odd';

    // Pair Combiner state
    private listeners = new Map<StateKey, Set<(value: unknown) => void>>();

    public set<K extends StateKey>(key: K, value: this[K]): void {
        if (this[key] === value) return;
        this[key] = value;
        this.emit(key, value);
    }

    public subscribe<K extends StateKey>(key: K, callback: (value: this[K]) => void): () => void {
        if (!this.listeners.has(key)) {
            this.listeners.set(key, new Set());
        }
        const listeners = this.listeners.get(key)!;
        const wrapped = (value: unknown) => callback(value as this[K]);
        listeners.add(wrapped);
        return () => listeners.delete(wrapped);
    }

    public emit<K extends StateKey>(key: K, value: this[K]): void {
        const listeners = this.listeners.get(key);
        listeners?.forEach(cb => cb(value));
    }

    // Helper to reset trade-related state
    public clearTradeResults() {
        this.set('currentBacktestResult', null);
        this.set('currentBacktestResultSource', 'backtest');
        this.set('twoHourParityBacktestResults', null);
        this.set('indicators', []);
        this.set('markersPlugin', null);
    }
}

export const state = new State();
