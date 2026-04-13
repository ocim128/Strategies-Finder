import type { PolymarketFillScope } from "./polymarket-fill-analysis";

export function formatScopeLabel(scope: PolymarketFillScope): string {
    if (scope === "long") return "YES-only fills";
    if (scope === "short") return "NO-only fills";
    return "All executed trades";
}

export function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

export function formatProbability(value: number): string {
    return `${(Math.abs(value) * 100).toFixed(1)}c`;
}

export function formatPolymarketCents(value: number): string {
    const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${prefix}${(Math.abs(value) * 100).toFixed(1)}c`;
}

export function formatProfitFactor(value: number | null): string {
    if (value === null || !Number.isFinite(value)) {
        return value === Infinity ? "∞" : "n/a";
    }
    return value.toFixed(2);
}

export function formatSignedUsd(value: number): string {
    const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${prefix}$${Math.abs(value).toFixed(2)}`;
}
