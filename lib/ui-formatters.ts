export function formatSignedCurrency(value: number, decimals = 2): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(decimals)}`;
}

export function formatDollarAmount(value: number, decimals = 2): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    const prefix = value < 0 ? "-" : "";
    return `${prefix}$${Math.abs(value).toFixed(decimals)}`;
}

export function formatPercentPoints(value: number, decimals = 2): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return `${value.toFixed(decimals)}%`;
}

export function formatRatioPercent(value: number, decimals = 1): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return `${(value * 100).toFixed(decimals)}%`;
}

export function formatSignedPercentPoints(value: number, decimals = 2): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(decimals)}%`;
}

export function formatSignedRatioPercent(value: number, decimals = 1): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return `${value >= 0 ? "+" : "-"}${Math.abs(value * 100).toFixed(decimals)}%`;
}

export function formatDecimal(value: number, decimals = 3): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return value.toFixed(decimals);
}

export function formatProfitFactor(
    value: number | null | undefined,
    infinityLabel = "Inf",
    emptyLabel = "n/a"
): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return emptyLabel;
    }
    if (value === Infinity) {
        return infinityLabel;
    }
    if (!Number.isFinite(value)) {
        return emptyLabel;
    }
    return value.toFixed(2);
}

export function formatPolymarketCents(value: number): string {
    const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${prefix}${(Math.abs(value) * 100).toFixed(1)}c`;
}

export function formatProbabilityCents(value: number): string {
    return `${(Math.abs(value) * 100).toFixed(1)}c`;
}

export function formatCount(value: number): string {
    if (!Number.isFinite(value)) {
        return "n/a";
    }
    return Math.round(value).toLocaleString("en-US");
}

export function formatCompactMagnitude(value: number): string {
    const abs = Math.abs(value);
    if (!Number.isFinite(abs)) {
        return "n/a";
    }
    if (abs >= 1e15) {
        const [mantissa, exponent] = abs.toExponential(2).split("e");
        return `${mantissa ?? abs.toFixed(2)}x10^${Number(exponent ?? 0)}`;
    }
    if (abs >= 1e12) return `${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1_000) return abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return abs.toFixed(2);
}

export function formatSignedCompactDollar(value: number): string {
    if (Number.isNaN(value)) return "n/a";
    if (!Number.isFinite(value)) return value > 0 ? "+$Inf" : "-$Inf";
    const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${prefix}$${formatCompactMagnitude(value)}`;
}

export function formatSignedCompactPercentPoints(value: number): string {
    if (Number.isNaN(value)) return "n/a";
    if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
    const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
    const suffix = Math.abs(value) >= 1e15 ? "" : "%";
    return `${prefix}${formatCompactMagnitude(value)}${suffix}`;
}
