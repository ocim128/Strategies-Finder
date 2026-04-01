import type { OHLCVData } from "../../types/strategies";
import { parseTimeToUnixSeconds } from "../../time-normalization";

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function average(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: readonly number[], fraction: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = clamp(Math.round((sorted.length - 1) * fraction), 0, sorted.length - 1);
    return sorted[index];
}

export function buildCloseReturns(data: OHLCVData[], endIndex: number, lookbackBars: number): number[] {
    const returns: number[] = [];
    const startIndex = Math.max(1, endIndex - Math.max(1, lookbackBars) + 1);
    for (let i = startIndex; i <= endIndex; i++) {
        const previousClose = data[i - 1]?.close;
        const currentClose = data[i]?.close;
        if (!Number.isFinite(previousClose) || !Number.isFinite(currentClose) || previousClose <= 0) {
            continue;
        }
        returns.push((currentClose - previousClose) / previousClose);
    }
    return returns;
}

export function inferBarsPerYear(data: OHLCVData[], endIndex: number): number {
    const deltas: number[] = [];
    for (let i = Math.max(1, endIndex - 20); i <= endIndex; i++) {
        const previous = parseTimeToUnixSeconds(data[i - 1]?.time);
        const current = parseTimeToUnixSeconds(data[i]?.time);
        if (previous === null || current === null) continue;
        const delta = current - previous;
        if (delta > 0) {
            deltas.push(delta);
        }
    }
    if (deltas.length === 0) {
        return 252;
    }
    const medianDelta = percentile(deltas, 0.5);
    if (!Number.isFinite(medianDelta) || medianDelta <= 0) {
        return 252;
    }
    return Math.max(1, Math.round(31_557_600 / medianDelta));
}
