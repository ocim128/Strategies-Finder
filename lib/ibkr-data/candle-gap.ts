import type { OHLCVData } from "../types/strategies";

export type CandleGap = {
    from: number;
    to: number;
    seconds: number;
};

const DEFAULT_WARNING_THRESHOLD_DAYS = 30;

export function findLargestCandleGap(candles: readonly OHLCVData[]): CandleGap | null {
    let previous: number | null = null;
    let largest: CandleGap | null = null;
    for (const candle of candles) {
        const time = Number(candle.time);
        if (!Number.isFinite(time)) continue;
        if (previous !== null && time > previous) {
            const seconds = time - previous;
            if (!largest || seconds > largest.seconds) {
                largest = { from: previous, to: time, seconds };
            }
        }
        previous = time;
    }
    return largest;
}

export function describeLargeCandleGap(
    candles: readonly OHLCVData[],
    thresholdDays = DEFAULT_WARNING_THRESHOLD_DAYS,
): string | null {
    const gap = findLargestCandleGap(candles);
    if (!gap || gap.seconds <= thresholdDays * 24 * 60 * 60) return null;
    const days = Math.round(gap.seconds / (24 * 60 * 60));
    const from = new Date(gap.from * 1000).toISOString();
    const to = new Date(gap.to * 1000).toISOString();
    return `Source contains a ${days}-day candle gap from ${from} to ${to}; missing bars were not reconstructed.`;
}
