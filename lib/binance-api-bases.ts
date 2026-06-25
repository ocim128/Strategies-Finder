import type { BinanceMarketType } from "./binance-market";

export const DEFAULT_BINANCE_SPOT_API_BASES = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
    "https://api.binance.us",
] as const;

export const DEFAULT_BINANCE_FUTURES_API_BASES = [
    "https://fapi.binance.com",
] as const;

export function parseBinanceApiBases(value: string | undefined | null): string[] {
    return (value ?? "")
        .split(",")
        .map((base) => base.trim().replace(/\/+$/, ""))
        .filter(Boolean);
}

export function resolveBinanceApiBases(
    marketType: BinanceMarketType,
    configuredBases?: string | null
): string[] {
    const configured = parseBinanceApiBases(configuredBases);
    if (configured.length > 0) return configured;
    return marketType === "futures"
        ? [...DEFAULT_BINANCE_FUTURES_API_BASES]
        : [...DEFAULT_BINANCE_SPOT_API_BASES];
}
