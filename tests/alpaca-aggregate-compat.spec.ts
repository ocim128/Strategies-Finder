/**
 * Phase 3 — Alpaca 30m → 4h aggregation compatibility.
 *
 * Validates that Alpaca-shaped 30m CSVs flow through the UNMODIFIED
 * `scripts/ibkr-aggregate-csv.ts` pipeline correctly: bucket alignment,
 * OHLC rollup, volume summation, missing-session gaps (no fabricated bars),
 * and idempotence. The aggregator itself is not changed here — Phase 3 is
 * validation-only per the plan. Stock sessions contain gaps (no overnight
 * bars); the test confirms aggregation does NOT synthesize bars across the
 * gap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateSyntheticBars } from "../scripts/lib/synthetic-pair";
import { describeLargeCandleGap } from "../lib/ibkr-data/candle-gap";
import type { OHLCVData } from "../lib/types/strategies";

// 30m bar interval in seconds.
const T30 = 30 * 60;
// 4h bar interval in seconds.
const T4H = 4 * 60 * 60;

/**
 * Builds a synthetic 30m series for one trading session day (no overnight
 * bars — mirrors US stock sessions). `dayStartEpoch` is the open of the first
 * 30m bucket; `sessions` is a list of [openEpoch, barsInSession] pairs. Bars
 * outside a session are skipped, leaving realistic session gaps.
 */
function buildSession30mBars(dayStartEpoch: number, barsPerSession = 13): OHLCVData[] {
    // 13 30m bars = 6.5h regular session (9:30–16:00 ET). Use UTC for
    // determinism; the aggregator bucket-aligns to UTC midnight and 4h
    // divides 24h evenly, so the bucket math is timezone-agnostic.
    const bars: OHLCVData[] = [];
    for (let i = 0; i < barsPerSession; i += 1) {
        const epoch = dayStartEpoch + i * T30;
        bars.push({
            time: epoch as OHLCVData["time"],
            open: 100 + i,
            high: 101 + i,
            low: 99 + i,
            close: 100.5 + i,
            volume: 1000 + i * 10,
        });
    }
    return bars;
}

describe("alpaca 30m -> 4h aggregation compatibility", () => {
    it("reports a multi-year source gap instead of treating it as continuous history", () => {
        const first = Math.floor(Date.UTC(2023, 5, 19, 14, 30) / 1000);
        const second = Math.floor(Date.UTC(2026, 1, 12, 12) / 1000);
        const candles: OHLCVData[] = [
            { time: first as OHLCVData["time"], open: 1816, high: 1817, low: 1815, close: 1816.9, volume: 1 },
            { time: second as OHLCVData["time"], open: 5070, high: 5071, low: 5069, close: 5070.815, volume: 1 },
        ];
        const warning = describeLargeCandleGap(candles);
        assert.match(warning ?? "", /gap/);
        assert.match(warning ?? "", /missing bars were not reconstructed/);
    });

    it("buckets 8 contiguous 30m bars into one 4h bar with summed volume + correct OHLC", () => {
        // 8 contiguous 30m bars starting at a 4h boundary (00:00 UTC).
        const start = Math.floor(Date.UTC(2026, 0, 5) / 1000 / T4H) * T4H;
        const bars: OHLCVData[] = [];
        for (let i = 0; i < 8; i += 1) {
            bars.push({
                time: (start + i * T30) as OHLCVData["time"],
                open: 100 + i,
                high: 105 + i,
                low: 95 + i,
                close: 102 + i,
                volume: 1000 + i,
            });
        }
        const aggregated = aggregateSyntheticBars(bars, "4h");
        assert.equal(aggregated.length, 1);
        const bar = aggregated[0]!;
        assert.equal(bar.time, start);
        // Open = first bar's open; close = last bar's close.
        assert.equal(bar.open, 100);
        assert.equal(bar.close, 109);
        // High = max of highs; low = min of lows.
        assert.equal(bar.high, 105 + 7);
        assert.equal(bar.low, 95);
        // Volume = sum of all sub-bar volumes.
        assert.equal(bar.volume, 8 * 1000 + (0 + 7) * 8 / 2);
    });

    it("aligns 4h buckets to UTC midnight (stock sessions land in their calendar bucket)", () => {
        // Two non-overlapping US-session days (each 13 30m bars = 6.5h,
        // regular session). The 4h aggregator must NOT span them and must
        // NOT fabricate the overnight gap.
        const day1 = buildSession30mBars(Math.floor(Date.UTC(2026, 0, 5, 14, 30) / 1000)); // 14:30 UTC
        const day2 = buildSession30mBars(Math.floor(Date.UTC(2026, 0, 6, 14, 30) / 1000));
        const aggregated = aggregateSyntheticBars([...day1, ...day2], "4h");
        // Each 6.5h session spans at most 2 distinct 4h buckets (14:30 is in
        // the 12:00–16:00 bucket; 16:00–20:00 holds the remainder).
        const bucketStarts = aggregated.map((b) => Number(b.time));
        for (const start of bucketStarts) {
            // Every bucket start is a multiple of T4H from the epoch.
            assert.equal(start % T4H, 0, `bucket ${start} is not 4h-aligned`);
        }
        // No fabricated overnight bar between the two sessions: every bucket
        // contains real sub-bars from one of the sessions.
        assert.ok(aggregated.every((bar) => bar.volume > 0), "no empty buckets should be fabricated");
        // Sanity: we got at least 2 buckets per day (4 total minimum).
        assert.ok(aggregated.length >= 4, `expected >= 4 buckets, got ${aggregated.length}`);
    });

    it("does NOT fabricate bars across missing intraday intervals", () => {
        // Two 30m bars at 00:00 and 03:30 (skipping 7 bars in between). The
        // 4h bucket still aggregates to ONE bar (00:00–04:00 window), but
        // its volume is the sum of the 2 present bars only — the missing 7
        // are NOT zero-filled into the OHLC rollup.
        const start = Math.floor(Date.UTC(2026, 0, 5) / 1000 / T4H) * T4H;
        const bars: OHLCVData[] = [
            { time: start as OHLCVData["time"], open: 100, high: 105, low: 95, close: 102, volume: 500 },
            { time: (start + 7 * T30) as OHLCVData["time"], open: 200, high: 205, low: 195, close: 202, volume: 700 },
        ];
        const aggregated = aggregateSyntheticBars(bars, "4h");
        assert.equal(aggregated.length, 1);
        assert.equal(aggregated[0]!.volume, 1200); // 500 + 700, no fabricated volume
        assert.equal(aggregated[0]!.open, 100);    // first present bar
        assert.equal(aggregated[0]!.close, 202);   // last present bar
    });

    it("is idempotent: aggregating already-4h data returns it unchanged", () => {
        const start = Math.floor(Date.UTC(2026, 0, 5) / 1000 / T4H) * T4H;
        const fourHourBars: OHLCVData[] = [
            { time: start as OHLCVData["time"], open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
            { time: (start + T4H) as OHLCVData["time"], open: 2, high: 3, low: 1.5, close: 2.5, volume: 200 },
        ];
        const aggregated = aggregateSyntheticBars(fourHourBars, "4h");
        // Idempotent: 4h input through a 4h aggregator is a no-op.
        assert.equal(aggregated.length, 2);
        assert.deepEqual(aggregated, fourHourBars);
    });

    it("produces finite OHLCV values for a realistic Alpaca 30m CSV shape", () => {
        // Mirror what normalizeAlpacaBars produces: Unix-second times,
        // volume-0 fallback for missing/null volumes. The aggregator must
        // accept these without NaN propagation.
        const start = Math.floor(Date.UTC(2026, 0, 5) / 1000 / T4H) * T4H;
        const bars: OHLCVData[] = [];
        for (let i = 0; i < 8; i += 1) {
            bars.push({
                time: (start + i * T30) as OHLCVData["time"],
                open: 100 + i * 0.1,
                high: 100.5 + i * 0.1,
                low: 99.5 + i * 0.1,
                close: 100.2 + i * 0.1,
                volume: i % 2 === 0 ? 0 : 250, // alternating 0/250 like IEX odd-lots
            });
        }
        const aggregated = aggregateSyntheticBars(bars, "4h");
        assert.equal(aggregated.length, 1);
        const bar = aggregated[0]!;
        for (const value of [bar.open, bar.high, bar.low, bar.close, bar.volume]) {
            assert.ok(Number.isFinite(value), `expected finite value, got ${value}`);
        }
        assert.equal(bar.volume, 4 * 250); // the 4 odd-index bars summed; 0s don't add
    });
});
