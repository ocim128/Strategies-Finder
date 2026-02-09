



export type DataProvider = 'binance' | 'bybit-tradfi';

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
};

export interface BybitTradFiKlineResponse {
    ret_code?: number;
    ret_msg?: string;
    retCode?: number;
    retMsg?: string;
    result?: {
        list?: any[]; // using any[] to avoid circular dep or redefinition, or define types clearly
    };
}

export type BybitTradFiKline = [string, string, string, string, string];
export type BinanceKline = [number, string, string, string, string, string, ...any[]];
