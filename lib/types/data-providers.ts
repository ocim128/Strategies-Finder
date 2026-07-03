import type { BinanceDataProvider } from "../binance-market";

export type DataProvider = BinanceDataProvider | 'bybit-tradfi' | 'polymarket' | 'local-daily' | 'ibkr-local';

export type HistoricalFetchProgress = {
    fetched: number;
    total: number;
    requestCount: number;
};

export type HistoricalFetchOptions = {
    signal?: AbortSignal;
    onProgress?: (progress: HistoricalFetchProgress) => void;
    requestDelayMs?: number;
    maxRequests?: number;
    /**
     * When true, satisfy the request only from local sources (imported, SQLite,
     * IndexedDB cache, bundled seed) and skip the remote Binance gap-fill tail.
     *
     * Batch research workloads (e.g. Symbol Universe Finder) read thousands of
     * already-cached historical bars per symbol; paying for interactive-chart
     * freshness on each one dominates runtime without changing backtest input.
     *
     * If no local data exists at all, the remote path is still used so cold
     * symbols remain correct.
     */
    offline?: boolean;
};

export interface BybitTradFiKlineResponse {
    ret_code?: number;
    ret_msg?: string;
    retCode?: number;
    retMsg?: string;
    result?: {
        list?: any[];
    };
}

export type BybitTradFiKline = [string, string, string, string, string];
export type BinanceKline = [number, string, string, string, string, string, ...any[]];
