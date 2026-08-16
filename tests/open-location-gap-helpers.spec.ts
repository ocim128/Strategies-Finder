import test from "node:test";
import assert from "node:assert/strict";
import { OHLCVData } from "../lib/types/strategies";
import {
    buildOpenLocationSeries,
    buildOpenGapPctSeries,
} from "../lib/strategies/lib/price-action-frequency-core";

function bar(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time, open, high, low, close, volume: 1000 };
}

test("buildOpenLocationSeries measures the open against the PRIOR bar's range", () => {
    // Prior bar spans 10..20. Open of the next bar at 15 must sit at 0.5.
    const data = [bar(1, 12, 20, 10, 18), bar(2, 15, 16, 14, 15.5)];
    const loc = buildOpenLocationSeries(data);
    assert.equal(loc[0], 0.5, "first bar falls back to mid");
    assert.equal(loc[1], 0.5, "open at prior mid maps to 0.5");
});

test("buildOpenLocationSeries preserves out-of-range extremes (no clamping)", () => {
    // Prior bar spans 10..20. Open above the prior high (25) must exceed 1;
    // open below the prior low (5) must be negative. These extremes are the
    // failed-breakout signal — clamping them away would break the mechanism.
    const data = [
        bar(1, 12, 20, 10, 18),
        bar(2, 25, 26, 24, 25.5),
        bar(3, 20, 21, 19, 20.5),
        bar(4, 5, 6, 4, 5.5),
    ];
    const loc = buildOpenLocationSeries(data);
    assert.ok(loc[1] > 1, `open above prior high must exceed 1, got ${loc[1]}`);
    assert.ok(loc[3] < 0, `open below prior low must be negative, got ${loc[3]}`);
});

test("buildOpenLocationSeries falls back to 0.5 when the prior bar has no range", () => {
    const data = [bar(1, 10, 10, 10, 10), bar(2, 12, 13, 11, 12.5)];
    const loc = buildOpenLocationSeries(data);
    assert.equal(loc[1], 0.5, "zero-range prior bar keeps the neutral fallback");
});

test("buildOpenGapPctSeries signs the gap relative to the prior close", () => {
    const data = [
        bar(1, 100, 110, 95, 105),
        bar(2, 110.25, 120, 108, 115), // gap up: 110.25 / 105 - 1 = +5%
        bar(3, 103.5, 112, 100, 108), // gap down: 103.5 / 115 - 1 = -10%
    ];
    const gap = buildOpenGapPctSeries(data);
    assert.equal(gap[0], 0, "first bar falls back to 0");
    assert.ok(Math.abs(gap[1] - 0.05) < 1e-9, `gap up ≈ +5%, got ${gap[1]}`);
    assert.ok(Math.abs(gap[2] + 0.1) < 1e-9, `gap down ≈ -10%, got ${gap[2]}`);
});
