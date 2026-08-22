import type { OHLCVData, Time } from "../../lib/types/strategies";

export function bar(
    time: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume = 1000,
): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

export function barsFromCloses(
    closes: readonly number[],
    volume: number | ((index: number) => number) = 1000,
): OHLCVData[] {
    return closes.map((close, index) => bar(
        index,
        close - 0.5,
        close + 1,
        close - 1,
        close,
        typeof volume === "function" ? volume(index) : volume,
    ));
}

export function oscillatingBars(count: number, base: number): OHLCVData[] {
    return barsFromCloses(
        Array.from({ length: count }, (_, index) => base + (index % 2 === 0 ? 0 : 0.5)),
    );
}
