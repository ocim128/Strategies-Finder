import { debugLogger } from "./debug-logger";
import {
    clearCurrentUiBacktestEndpointSnapshot,
    setCurrentUiBacktestEndpointCandles,
    setCurrentUiBacktestEndpointSnapshot,
    type UiBacktestEndpointSnapshot,
} from "./backtest-endpoint-copy";
import { state, type BacktestResultSource, type ChartMode } from "./state";
import type { BinanceMarketType } from "./binance-market";
import type { Indicator } from "./types/index";
import type { BacktestResult, OHLCVData } from "./strategies/index";
import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time } from "lightweight-charts";
import { timeKey } from "./strategies/backtest/backtest-utils";

/**
 * Build the O(1) time->candle lookup used by the crosshair tooltip and other
 * hot paths. Centralized so the key format and dedupe semantics live in one
 * place; previously this expression was duplicated across chart-manager.ts
 * and handlers/state-subscriptions.ts.
 */
export function buildOhlcvTimeMap(data: readonly OHLCVData[]): Map<string, OHLCVData> {
    return new Map(data.map((candle) => [timeKey(candle.time), candle]));
}

let dataManagerModulePromise: Promise<typeof import("./data-manager")> | null = null;

function syncDataManagerCache(symbol: string, interval: string, candles: OHLCVData[]): void {
    dataManagerModulePromise ??= import("./data-manager");
    void dataManagerModulePromise
        .then(({ dataManager }) => {
            dataManager.updateCacheEntryFor(symbol, interval, candles);
        })
        .catch((error: unknown) => {
            debugLogger.warn("state.commit.ohlcv_cache_sync_failed", {
                symbol,
                interval,
                error: error instanceof Error ? error.message : String(error),
            });
        });
}

export function bindChartRuntime(runtime: {
    chart: IChartApi;
    equityChart: IChartApi;
    candlestickSeries: ISeriesApi<"Candlestick">;
    equitySeries: ISeriesApi<"Area">;
}): void {
    state.chart = runtime.chart;
    state.equityChart = runtime.equityChart;
    state.candlestickSeries = runtime.candlestickSeries;
    state.equitySeries = runtime.equitySeries;
}

export function setCurrentSymbol(symbol: string): void {
    advanceBacktestPublicationRevision('current_symbol');
    state.set('currentSymbol', symbol);
}

export function setCurrentInterval(interval: string): void {
    advanceBacktestPublicationRevision('current_interval');
    state.set('currentInterval', interval);
}

export function setBinanceMarketType(marketType: BinanceMarketType): void {
    advanceBacktestPublicationRevision('binance_market_type');
    state.set('binanceMarketType', marketType);
}

export function setMarketSelection(selection: {
    symbol?: string;
    interval?: string;
    binanceMarketType?: BinanceMarketType;
}): void {
    if (selection.symbol !== undefined) {
        state.set('currentSymbol', selection.symbol);
    }
    if (selection.interval !== undefined) {
        state.set('currentInterval', selection.interval);
    }
    if (selection.binanceMarketType !== undefined) {
        state.set('binanceMarketType', selection.binanceMarketType);
    }
    advanceBacktestPublicationRevision('market_selection');
}

export function setChartMode(mode: ChartMode): void {
    state.set('chartMode', mode);
}

export function setMockChartBars(bars: number): void {
    state.set('mockChartBars', bars);
}

export function setIndicators(indicators: Indicator[]): void {
    state.set('indicators', indicators);
}

export function setMarkersPlugin(markersPlugin: ISeriesMarkersPluginApi<Time> | null): void {
    state.set('markersPlugin', markersPlugin);
}

export function setCurrentStrategyKey(strategyKey: string): void {
    advanceBacktestPublicationRevision('current_strategy_key');
    state.set('currentStrategyKey', strategyKey);
}

export function setDarkTheme(isDarkTheme: boolean): void {
    state.set('isDarkTheme', isDarkTheme);
}

export function setBlockRange(blockRange: { from: number; to: number } | null): void {
    advanceBacktestPublicationRevision('block_range');
    state.set('blockRange', blockRange);
}

export function clearBlockRange(): void {
    setBlockRange(null);
}

/**
 * Transient publication-ownership counter for interactive backtest runs. Any
 * state change that could make an in-flight run's output obsolete advances
 * it: market/symbol/interval/strategy/block-range context changes (including
 * change-away-and-back), explicit result clears, replacement datasets, and
 * each committed result. Runs capture the value with their request and
 * re-check it before publishing. Transient by design — no localStorage.
 */
let backtestPublicationRevision = 0;

export function getBacktestPublicationRevision(): number {
    return backtestPublicationRevision;
}

export function advanceBacktestPublicationRevision(reason: string): number {
    backtestPublicationRevision += 1;
    debugLogger.event('state.advance.backtest_publication_revision', {
        revision: backtestPublicationRevision,
        reason,
    });
    return backtestPublicationRevision;
}

export function setStrategyTimeframeSettings(settings: {
    enabled?: boolean;
    minutes?: number;
}): void {
    if (settings.enabled !== undefined) {
        state.set('strategyTimeframeEnabled', settings.enabled);
    }
    if (settings.minutes !== undefined) {
        state.set('strategyTimeframeMinutes', settings.minutes);
    }
}

export function clearBacktestResults(reason?: string): void {
    debugLogger.event('state.clear.backtest_result', { reason });
    advanceBacktestPublicationRevision('clear_backtest_results');
    clearCurrentUiBacktestEndpointSnapshot();
    state.set('currentBacktestResult', null);
    state.set('currentBacktestResultSource', 'backtest');
}

export function commitBacktestResult(
    result: BacktestResult,
    source: BacktestResultSource,
    options?: {
        reason?: string;
        endpointCopySnapshot?: UiBacktestEndpointSnapshot | null;
        endpointCopyCandles?: OHLCVData[] | null;
    }
): void {
    debugLogger.event('state.commit.backtest_result', {
        source,
        trades: result.totalTrades,
        reason: options?.reason,
    });
    // Competing result commits own publication from here on: an older run
    // that captured the previous revision must not publish over this one.
    advanceBacktestPublicationRevision(`commit_backtest_result:${source}`);
    if (options?.endpointCopySnapshot) {
        setCurrentUiBacktestEndpointSnapshot(options.endpointCopySnapshot);
        setCurrentUiBacktestEndpointCandles(options.endpointCopyCandles ?? null);
    } else {
        clearCurrentUiBacktestEndpointSnapshot();
    }
    state.set('currentBacktestResultSource', source);
    state.set('currentBacktestResult', result);
}

export function commitOhlcvData(
    data: OHLCVData[],
    reason?: string
): void {
    debugLogger.event('state.commit.ohlcv', {
        symbol: state.currentSymbol,
        interval: state.currentInterval,
        candles: data.length,
        reason,
    });
    advanceBacktestPublicationRevision('commit_ohlcv_data');
    state.set('ohlcvData', data);
    syncDataManagerCache(state.currentSymbol, state.currentInterval, data);
}
