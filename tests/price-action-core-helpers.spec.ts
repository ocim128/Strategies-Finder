import test from "node:test";
import assert from "node:assert/strict";
import { OHLCVData, Time } from "../lib/types/strategies";
import {
    buildAdjacentRangeOverlapSeries,
    buildExtremeAgeSeries,
    buildSweepReclaimScoreSeries,
    buildWindowGivebackRatio,
} from "../lib/strategies/lib/price-action-frequency-core";
import { buildVarianceRatio } from "../lib/strategies/lib/price-action-statistics-core";

function bar(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as Time, open, high, low, close, volume: 1000 };
}

function closeSeries(closes: number[]): OHLCVData[] {
    return closes.map((close, i) => bar(i, close, close, close, close));
}

test("buildVarianceRatio reads persistence as > 1 and alternation as < 1", () => {
    // Steps +1,+1,+1,+1,-1,-1,-1,-1 repeating: lag-1 changes are persistent, so
    // 2-bar variance (3) grows faster than linear (2 * 1) -> VR = 1.5 exactly.
    const trending = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 0];
    const vr = buildVarianceRatio(trending, 8, 2);
    assert.equal(vr[16], 1.5, `persistent steps must give VR 1.5, got ${vr[16]}`);

    // Perfect alternation: 2-bar changes are identically zero -> VR collapses to 0.
    const alternating = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
    const vrAlt = buildVarianceRatio(alternating, 4, 2);
    assert.equal(vrAlt[10], 0, `alternating steps must give VR 0, got ${vrAlt[10]}`);
});

test("buildVarianceRatio is scale-free and null during warmup or on flat data", () => {
    const trending = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 0];
    const vr = buildVarianceRatio(trending, 8, 2);
    const vrScaled = buildVarianceRatio(trending.map((v) => v * 10), 8, 2);
    assert.ok(
        Math.abs(vr[16]! - vrScaled[16]!) < 1e-12,
        "a 10x rescale must leave the variance ratio unchanged"
    );

    // Warmup: first defined bar is lookback + horizon - 1 = 9.
    for (let i = 0; i < 9; i++) {
        assert.equal(vr[i], null, `bar ${i} is inside the warmup and must be null`);
    }
    // First defined bar: window r1[2..9] holds four +1 and four -1 (var 1),
    // window r2[2..9] = 2,2,2,-2,-2,-2,0,0 (var 3) -> VR = 1.5 here too.
    assert.equal(vr[9], 1.5, `first defined bar must compute immediately, got ${vr[9]}`);

    const flat = buildVarianceRatio([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 4, 2);
    assert.ok(flat.every((v) => v === null), "flat window has zero 1-bar variance -> all null");
});

test("buildSweepReclaimScoreSeries scores spring positive and upthrust negative", () => {
    // Prior bar spans 10..20 (range 10).
    const prior = bar(1, 12, 20, 10, 18);
    // Spring: sweeps the prior low to 9 then closes at 15 (range 19-9 = 10).
    // depth = 1/10, reclaim = (15-10)/10 -> score +0.05.
    const spring = buildSweepReclaimScoreSeries([
        prior,
        bar(2, 16, 19, 9, 15),
    ]);
    assert.equal(spring[0], 0, "first bar falls back to 0");
    assert.ok(Math.abs(spring[1] - 0.05) < 1e-12, `spring must score +0.05, got ${spring[1]}`);

    // Upthrust: pokes the prior high to 21 then closes at 15 (range 21-11 = 10).
    // depth = 1/10, reclaim = (20-15)/10 -> score -0.05.
    const upthrust = buildSweepReclaimScoreSeries([
        prior,
        bar(2, 14, 21, 11, 15),
    ]);
    assert.ok(Math.abs(upthrust[1] + 0.05) < 1e-12, `upthrust must score -0.05, got ${upthrust[1]}`);

    // Inside bar violates neither extreme -> zero.
    const inside = buildSweepReclaimScoreSeries([
        prior,
        bar(2, 14, 19, 11, 15),
    ]);
    assert.equal(inside[1], 0, "inside bar must not score");
});

test("buildAdjacentRangeOverlapSeries measures shared territory and goes negative on gaps", () => {
    const data = [
        bar(1, 5, 10, 0, 8),
        bar(2, 8, 10, 0, 9), // identical span -> 1
        bar(3, 12, 15, 5, 14), // half overlap: inter 5 / union 15 -> 1/3
        bar(4, 20, 35, 18, 30), // disjoint: inter -3 / union 30 -> -0.1
    ];
    const overlap = buildAdjacentRangeOverlapSeries(data);
    assert.equal(overlap[0], 1, "first bar falls back to neutral 1");
    assert.equal(overlap[1], 1, "identical spans share all territory");
    assert.ok(Math.abs(overlap[2] - 1 / 3) < 1e-12, `half overlap must be 1/3, got ${overlap[2]}`);
    assert.ok(Math.abs(overlap[3] + 0.1) < 1e-12, `disjoint ranges must score -0.1, got ${overlap[3]}`);
});

test("buildWindowGivebackRatio measures retracement completeness of the window excursion", () => {
    const closes = [100, 102, 106, 110, 105, 100, 108];
    const giveback = buildWindowGivebackRatio(closeSeries(closes), 3);
    // Warmup: window [i-3, i] needs i >= 3.
    for (let i = 0; i < 3; i++) {
        assert.equal(giveback[i], null, `bar ${i} is inside the warmup and must be null`);
    }
    assert.equal(giveback[3], 0, "closing at the excursion's peak surrenders nothing");
    assert.ok(Math.abs(giveback[4]! - 0.625) < 1e-12, `expected 0.625, got ${giveback[4]}`);
    assert.equal(giveback[5], 0, "down leg closing at its own trough surrenders nothing");
    assert.ok(Math.abs(giveback[6]! - 0.8) < 1e-12, `expected 0.8, got ${giveback[6]}`);

    // Down window: start 100, trough 90, close back at 96 -> (96-90)/10 = 0.6.
    const down = buildWindowGivebackRatio(closeSeries([100, 96, 92, 90, 92, 96]), 5);
    assert.ok(Math.abs(down[5]! - 0.6) < 1e-12, `down-window giveback must be 0.6, got ${down[5]}`);
});

test("buildExtremeAgeSeries reports bars since the window's extremes with recent-tie wins", () => {
    // Fresh extremes every bar: rising highs AND falling lows keep both ages at 0.
    const rising = closeSeries([10, 11, 12, 13, 14, 15, 16]).map((b, i) => ({
        ...b,
        high: 10 + i,
        low: 20 - i,
    }));
    const fresh = buildExtremeAgeSeries(rising, 4);
    assert.equal(fresh.sinceHigh[5], 0, "a fresh window high resets the age");
    assert.equal(fresh.sinceLow[5], 0, "a fresh window low resets the age");

    // Stale high set at index 1 with lookback 5: at i=5 the window [1..5] still
    // holds it -> age 4 (window length - 1).
    const staleData = [
        bar(0, 5, 10, 1, 8),
        bar(1, 20, 50, 0.5, 40),
        bar(2, 8, 11, 1, 9),
        bar(3, 8, 11, 1, 9),
        bar(4, 8, 11, 1, 9),
        bar(5, 8, 11, 1, 9),
    ];
    const stale = buildExtremeAgeSeries(staleData, 5);
    assert.equal(stale.sinceHigh[5], 4, "stale ceiling age spans the whole window");
    assert.equal(stale.sinceLow[5], 4, "stale floor age spans the whole window");

    // Tie: equal highs at indices 1 and 3 -> the MOST RECENT one wins.
    const tieData = [
        bar(0, 5, 10, 1, 8),
        bar(1, 20, 50, 1, 40),
        bar(2, 8, 11, 1, 9),
        bar(3, 20, 50, 1, 40),
        bar(4, 8, 11, 1, 9),
    ];
    const tie = buildExtremeAgeSeries(tieData, 5);
    assert.equal(tie.sinceHigh[4], 1, "tied extremes resolve to the most recent bar");
    // All lows in the tie window equal 1, so the low tie must also resolve to
    // the most recent bar (guards the low deque's pop condition).
    assert.equal(tie.sinceLow[4], 0, "tied lows must resolve to the most recent bar");

    // Warmup: window not full before lookback - 1.
    assert.equal(tie.sinceHigh[3], null, "bars inside the warmup must be null");
});
