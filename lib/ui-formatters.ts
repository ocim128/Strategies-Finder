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

export function formatSignedPercentPoints(value: number, decimals = 2): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(decimals)}%`;
}

export function formatDecimal(value: number, decimals = 3): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return value.toFixed(decimals);
}

export function formatNullableFixed(
    value: number | null | undefined,
    decimals = 2,
    emptyLabel = "--",
    positiveInfinityLabel?: string,
): string {
    if (value === Number.POSITIVE_INFINITY && positiveInfinityLabel !== undefined) {
        return positiveInfinityLabel;
    }
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return emptyLabel;
    }
    return value.toFixed(decimals);
}

export function formatNullablePercentPoints(
    value: number | null | undefined,
    decimals = 2,
    emptyLabel = "--",
): string {
    const formatted = formatNullableFixed(value, decimals, emptyLabel);
    return formatted === emptyLabel ? formatted : `${formatted}%`;
}

export function formatNullableSignedFixed(
    value: number | null | undefined,
    decimals = 2,
    emptyLabel = "--",
    includePlusForZero = false,
): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return emptyLabel;
    }
    const prefix = value > 0 || (includePlusForZero && value === 0) ? "+" : "";
    return `${prefix}${value.toFixed(decimals)}`;
}

export function formatNullableSignedPercentPoints(
    value: number | null | undefined,
    decimals = 2,
    emptyLabel = "--",
    includePlusForZero = true,
): string {
    const formatted = formatNullableSignedFixed(value, decimals, emptyLabel, includePlusForZero);
    return formatted === emptyLabel ? formatted : `${formatted}%`;
}

export function formatNullableCurrency(
    value: number | null | undefined,
    decimals = 2,
    emptyLabel = "--",
): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return emptyLabel;
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}$${value.toFixed(decimals)}`;
}

export function formatNullableAdaptivePercentPoints(
    value: number | null | undefined,
    emptyLabel = "--",
): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return emptyLabel;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatNullableAdaptiveSignedPercentPoints(
    value: number | null | undefined,
    emptyLabel = "--",
): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return emptyLabel;
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}

export function formatScore(
    value: number | null | undefined,
    decimals = 1,
    emptyLabel = "--",
): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return emptyLabel;
    }
    return Number.isInteger(value) ? value.toString() : value.toFixed(decimals);
}

export function formatProfitFactor(
    value: number | null | undefined,
    infinityLabel = "Inf",
    emptyLabel = "n/a"
): string {
    return formatNullableFixed(value, 2, emptyLabel, infinityLabel);
}

export function formatVolume(volume: number): string {
    if (volume >= 1e9) return (volume / 1e9).toFixed(2) + 'B';
    if (volume >= 1e6) return (volume / 1e6).toFixed(2) + 'M';
    if (volume >= 1e3) return (volume / 1e3).toFixed(2) + 'K';
    return volume.toFixed(2);
}
