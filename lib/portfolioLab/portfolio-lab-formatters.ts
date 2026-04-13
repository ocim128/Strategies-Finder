export { escapeHtml } from "../html-escape";

export function formatCurrency(value: number | null): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }
    return `${value >= 0 ? "+" : ""}$${value.toFixed(2)}`;
}

export function formatPercent(value: number | null): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatDrawdownPercent(value: number | null): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }
    return `-${Math.abs(value).toFixed(2)}%`;
}

export function formatCorrelation(value: number | null): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }
    return value.toFixed(2);
}

export function formatNullableRate(value: number | null): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }
    return `${value.toFixed(1)}%`;
}

export function formatProfitFactor(value: number): string {
    if (value === Infinity) {
        return "Inf";
    }
    return Number.isFinite(value) ? value.toFixed(2) : "-";
}

export function getCorrelationCellColor(value: number | null): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "rgba(255,255,255,0.03)";
    }
    const intensity = 0.08 + (Math.abs(value) * 0.28);
    if (value >= 0) {
        return `rgba(0, 200, 83, ${intensity.toFixed(3)})`;
    }
    return `rgba(255, 82, 82, ${intensity.toFixed(3)})`;
}

export function toDisplaySymbol(symbol: string): string {
    if (symbol.endsWith("USDT") && symbol.length > 4) {
        return `${symbol.slice(0, -4)}/USDT`;
    }
    return symbol;
}

export function renderSummaryCard(label: string, value: string, delta: string): string {
    return `
        <div class="sim-card">
            <div class="sim-card-label">${label}</div>
            <div class="sim-card-value">${value}</div>
            <div class="sim-card-delta">${delta}</div>
        </div>
    `;
}
