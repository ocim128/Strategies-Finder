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
    state.set('currentSymbol', symbol);
}

export function setCurrentInterval(interval: string): void {
    state.set('currentInterval', interval);
}

export function setBinanceMarketType(marketType: BinanceMarketType): void {
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
    state.set('currentStrategyKey', strategyKey);
}

export function setDarkTheme(isDarkTheme: boolean): void {
    state.set('isDarkTheme', isDarkTheme);
}

export function setBlockRange(blockRange: { from: number; to: number } | null): void {
    state.set('blockRange', blockRange);
}

export function clearBlockRange(): void {
    setBlockRange(null);
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
    state.set('ohlcvData', data);
    syncDataManagerCache(state.currentSymbol, state.currentInterval, data);
}
