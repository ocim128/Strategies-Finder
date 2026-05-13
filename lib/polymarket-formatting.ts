import type { PolymarketFillScope } from "./polymarket-fill-analysis";
import {
    formatPolymarketCents,
    formatProfitFactor as formatUiProfitFactor,
    formatRatioPercent,
} from "./ui-formatters";

export { formatPolymarketCents };

export function formatScopeLabel(scope: PolymarketFillScope): string {
    if (scope === "long") return "YES-only fills";
    if (scope === "short") return "NO-only fills";
    return "All executed trades";
}

export function formatPercent(value: number): string {
    return formatRatioPercent(value);
}

export function formatProbability(value: number): string {
    return `${(Math.abs(value) * 100).toFixed(1)}c`;
}

export function formatProfitFactor(value: number | null): string {
    return formatUiProfitFactor(value, "∞");
}

export function formatSignedUsd(value: number): string {
    if (!Number.isFinite(value)) return "-";
    const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${prefix}$${Math.abs(value).toFixed(2)}`;
}
