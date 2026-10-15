import { getDefaultAlertMinClosedCandles } from "../alert-evaluation-window";
import { pickSourceInterval, resolveSyntheticAvailableIntervals } from "../../scripts/lib/synthetic-pair";

export function scanPrimarySourceInterval(asset: string, interval: string): string {
    return pickSourceInterval(interval, 12, resolveSyntheticAvailableIntervals(asset, asset))?.sourceInterval ?? interval;
}
export function scanSourceIntervals(asset: string, interval: string): string[] {
    // Track primary and fallback files, including absent files whose creation
    // could change the loader's source selection during a scan.
    return [...new Set(["30m", scanPrimarySourceInterval(asset, interval), interval])];
}

/** Retain only per-timestamp support counts, never every asset's history. */
export class ScanEndpointCoverage {
    private counts = new Map<number, number>();
    private assets = 0;
    add(times: readonly number[]): void {
        this.assets++;
        for (const time of new Set(times.slice(getDefaultAlertMinClosedCandles() - 1))) this.counts.set(time, (this.counts.get(time) ?? 0) + 1);
    }
    /** Newest candle held with 200 bars of history by every asset; otherwise
     * the newest candle held by the most assets, so stale sources shrink the
     * scanned universe instead of rejecting the run. */
    select(): { asOf: number; support: number; complete: boolean } | null {
        let asOf: number | null = null, support = 0;
        for (const [time, count] of this.counts) if (count > support || (count === support && time > asOf!)) { asOf = time; support = count; }
        if (asOf === null) return null;
        return { asOf, support, complete: support === this.assets };
    }
}

export function hasScanEndpointHistory(times: readonly number[], asOf: number): boolean {
    return times.indexOf(asOf) >= getDefaultAlertMinClosedCandles() - 1;
}

/** Prefer the prevalent closed-bar phase on the freshest observed day, so a
 * few extended-hours candles do not classify regular-session stocks as stale. */
export function scanSyncReference(endpoints: readonly number[], intervalSeconds: number): number | null {
    if (!endpoints.length) return null;
    const latest = Math.max(...endpoints);
    if (intervalSeconds >= 86400) return latest;
    const day = Math.floor(latest / 86400), counts = new Map<number, number>();
    for (const time of endpoints) if (Math.floor(time / 86400) === day) counts.set(time, (counts.get(time) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
}
