import type { AssetProvider } from "./asset-search-service";

function labelForProvider(provider: AssetProvider): string {
    switch (provider) {
        case "binance":
            return "Binance Spot";
        case "binance-futures":
            return "Binance Futures";
        case "bybit-tradfi":
            return "Bybit TradFi";
        case "polymarket":
            return "Polymarket";
        case "local-daily":
            return "Local Daily";
        case "ibkr-local":
            return "IBKR Local";
        case "mock":
            return "Mock";
        default:
            return provider;
    }
}

export function isAlertWorkerProviderCompatible(provider: AssetProvider): boolean {
    return provider === "binance";
}

export function buildAlertWorkerProviderMismatchMessage(symbol: string, provider: AssetProvider): string {
    return `Cloudflare Worker alerts evaluate Binance-compatible candles only. ${symbol} is currently using ${labelForProvider(provider)} data, so live position and Worker results cannot be an exact match.`;
}
