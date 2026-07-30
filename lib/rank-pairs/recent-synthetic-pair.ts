import type { OHLCVData } from "../types/strategies";
import { parseIntervalSeconds } from "../interval-utils";

export interface RecentSyntheticLeg {
    times: number[];
    opens: number[];
    closes: number[];
}

function finiteNumber(value: unknown): number | null {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Keep only the fields needed to classify the latest ratio window. The batch
 * loader already returns normalized candles in practice, but sorting/deduping
 * here preserves the full classifier's input contract for direct callers.
 */
export function normalizeRecentSyntheticLeg(bars: OHLCVData[]): RecentSyntheticLeg {
    const byTime = new Map<number, { open: number; close: number }>();
    for (const bar of bars) {
        const time = finiteNumber(bar.time);
        const open = finiteNumber(bar.open);
        const close = finiteNumber(bar.close);
        if (time === null || open === null || close === null) continue;
        byTime.set(time, { open, close });
    }
    const points = [...byTime.entries()].sort(([a], [b]) => a - b);
    return {
        times: points.map(([time]) => time),
        opens: points.map(([, point]) => point.open),
        closes: points.map(([, point]) => point.close),
    };
}

/**
 * Build only the latest target close bars for Recent-200 classification.
 *
 * The full synthetic builder must materialize every OHLC ratio bar before it
 * can aggregate. Rank Pairs only consumes timestamps and closes, so a reverse
 * two-pointer intersection stops as soon as the requested target buckets are
 * complete. For subdivided sources, the first reverse hit in a bucket is the
 * same final close that aggregateSyntheticBars would emit.
 */
export function buildRecentSyntheticPairCloseBars(
    base: RecentSyntheticLeg,
    quote: RecentSyntheticLeg,
    sourceInterval: string,
    targetInterval: string,
    targetBars: number,
): OHLCVData[] {
    const limit = Math.max(1, Math.floor(targetBars));
    const sourceSeconds = parseIntervalSeconds(sourceInterval);
    const targetSeconds = parseIntervalSeconds(targetInterval);
    const aggregate = sourceSeconds !== null
        && targetSeconds !== null
        && sourceSeconds > 0
        && targetSeconds > sourceSeconds;
    const targetBucketSeconds = targetSeconds ?? 0;
    const output: OHLCVData[] = [];
    let baseIndex = base.times.length - 1;
    let quoteIndex = quote.times.length - 1;
    let lastBucket: number | null = null;

    while (baseIndex >= 0 && quoteIndex >= 0 && output.length < limit) {
        const baseTime = base.times[baseIndex];
        const quoteTime = quote.times[quoteIndex];
        if (baseTime > quoteTime) {
            baseIndex -= 1;
            continue;
        }
        if (quoteTime > baseTime) {
            quoteIndex -= 1;
            continue;
        }

        const baseOpen = base.opens[baseIndex];
        const quoteOpen = quote.opens[quoteIndex];
        const baseClose = base.closes[baseIndex];
        const quoteClose = quote.closes[quoteIndex];
        const open = baseOpen / quoteOpen;
        const close = baseClose / quoteClose;
        if (Number.isFinite(open) && Number.isFinite(close)) {
            const bucket = aggregate
                ? Math.floor(baseTime / targetBucketSeconds) * targetBucketSeconds
                : baseTime;
            if (bucket !== lastBucket) {
                output.push({
                    time: bucket as OHLCVData["time"],
                    open: close,
                    high: close,
                    low: close,
                    close,
                    volume: 0,
                });
                lastBucket = bucket;
            }
        }
        baseIndex -= 1;
        quoteIndex -= 1;
    }

    output.reverse();
    return output;
}
