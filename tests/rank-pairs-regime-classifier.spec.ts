/**
 * Tests for the pure pair-regime classifier.
 *
 * Fixtures are generated synthetically with candle timestamps spaced so that
 * the 30-calendar-day anchor selection resolves cleanly. The goal of these
 * tests is to lock the metric definitions, null/reason behavior, anchor
 * extraction, reciprocal-pair invariants, classification precedence, boundary
 * thresholds, and deterministic sorting.
 *
 * What these tests do NOT cover: real-chart threshold calibration. The chosen
 * thresholds are documented starting points; validating them against
 * user-labeled real charts (Uptrend / Chop / Downtrend) is a plan prerequisite
 * (plan §Phase 2 dependencies) that requires user input and is tracked as an
 * open item in docs/rank-pairs.md, not something these unit tests can settle.
 */

import { expect } from "chai";
import { describe, it } from "node:test";
import {
    ANCHOR_INTERVAL_DAYS,
    TOTAL_ANCHORS,
    MIN_VALID_ANCHORS,
    MIN_ELAPSED_DAYS,
    RECENT_ANCHOR_COUNT,
    DRIFT_THRESHOLD,
    TREND_EFFICIENCY_THRESHOLD,
    RECENT_DRIFT_THRESHOLD,
    OSCILLATING_EFFICIENCY_THRESHOLD,
    OSCILLATING_REVERSAL_RATE_THRESHOLD,
    ENDPOINT_BAND,
    VOL_FLOOR_EPS,
    MAX_NORMALIZED_DRIFT,
    classifyPairRegime,
    comparePairRegimeResults,
    directionFromDrift,
    formatPercent,
    type PairRegimeResult,
} from "../lib/rank-pairs/pair-regime-classifier";
import type { OHLCVData, Time } from "../lib/types/strategies";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const DAY = 86_400;
const ANCHOR_SPACING = ANCHOR_INTERVAL_DAYS * DAY;

function candle(timeSec: number, close: number): OHLCVData {
    return { time: timeSec as Time, open: close, high: close, low: close, close, volume: 1 };
}

/**
 * Build a fixture whose candles sit exactly on the 30-day anchor grid so the
 * anchor selector picks one candle per anchor with no gaps. `priceAt(i)`
 * returns the close for anchor index `i` (0 = earliest). The latest candle is
 * anchored at `endTime`. Produces `count` anchors.
 */
function anchorGridSeries(
    count: number,
    endTime: number,
    priceAt: (i: number) => number,
): OHLCVData[] {
    const out: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        // index i = earliest; latest candle = endTime.
        const t = endTime - (count - 1 - i) * ANCHOR_SPACING;
        out.push(candle(t, priceAt(i)));
    }
    return out;
}

/** Smooth exponential trend: price grows by factor per anchor. */
function smoothTrendSeries(
    count: number,
    startPrice: number,
    perAnchorGrowth: number,
    endTime: number,
): OHLCVData[] {
    return anchorGridSeries(count, endTime, (i) =>
        startPrice * Math.pow(perAnchorGrowth, i),
    );
}

/**
 * Oscillating series around a flat midline with given amplitude. Uses a period
 * of 4 anchors (one full cycle every 4 anchors) so the recent 7-anchor window
 * spans nearly two full cycles and the 30-day reversal rate clears 0.50. The
 * endpoint returns near the start (inside the band), efficiency is near zero.
 */
function oscillatingSeries(
    count: number,
    midline: number,
    amplitude: number,
    endTime: number,
): OHLCVData[] {
    return anchorGridSeries(count, endTime, (i) =>
        midline * (1 + amplitude * Math.sin((i * Math.PI) / 2)),
    );
}

/**
 * Round trip that completes WELL before the recent window, then settles into a
 * gentle oscillation around the start price. This is the MIXED signature: the
 * full window has low efficiency (net ~zero) and moderate reversal rate, the
 * recent window is flat (no clean trend → not TRANSITION), and reversal rate
 * stays under 0.50 (not OSCILLATING).
 */
function roundTripSeries(count: number, startPrice: number, endTime: number): OHLCVData[] {
    const tripEnd = count - 9; // complete the round trip 9 anchors before the end
    return anchorGridSeries(count, endTime, (i) => {
        if (i < tripEnd) {
            const f = i / (tripEnd - 1);
            const bell = (1 - Math.cos(f * Math.PI * 2)) / 2; // 0..1..0
            return startPrice * (1 + 2 * bell);
        }
        // Last 9 anchors: gentle oscillation around the start price so the
        // recent window has no clean trend.
        const ri = i - tripEnd;
        return startPrice * (1 + 0.03 * Math.sin((ri * Math.PI) / 2));
    });
}

/**
 * Recent reversal: a long, clean, strong exponential base-trend (so the full
 * window still shows strong directional drift), with a gentle but clean recent
 * reversal. REVERSAL requires |full drift| >= 0.50 AND a recent opposite drift,
 * so the older trend must be strong enough to survive the recent counter-move —
 * this models an established trend that is starting to reverse, not a violent
 * round trip (which would land on TRANSITION/MIXED).
 */
function recentReversalSeries(
    count: number,
    startPrice: number,
    endTime: number,
    recentCount = RECENT_ANCHOR_COUNT,
): OHLCVData[] {
    const peak = startPrice * Math.pow(1.08, count - recentCount);
    return anchorGridSeries(count, endTime, (i) => {
        if (i < count - recentCount) {
            return startPrice * Math.pow(1.08, i); // strong clean base trend
        }
        // recent window: clean gentle reversal (quote direction)
        const rIdx = i - (count - recentCount);
        const frac = (rIdx + 1) / recentCount;
        return peak * (1 - 0.15 * frac); // ~15% pullback over recent window
    });
}

/**
 * Recent transition: high-amplitude oscillating older history (defeats full-
 * window trending — low efficiency, drift diluted across many oscillations),
 * then a clean strong recent move. Full window is NOT trending; recent window
 * IS. This is the TRANSITION signature.
 */
function recentTransitionSeries(count: number, startPrice: number, endTime: number): OHLCVData[] {
    const olderCount = count - RECENT_ANCHOR_COUNT;
    return anchorGridSeries(count, endTime, (i) => {
        if (i < olderCount) {
            // Large oscillations over the older history: high variance keeps
            // full-window efficiency low and normalized drift under threshold.
            return startPrice * (1 + 0.30 * Math.sin((i * Math.PI) / 2));
        }
        // Recent window: clean strong trend from the midline.
        const rIdx = i - olderCount;
        const frac = rIdx / (RECENT_ANCHOR_COUNT - 1);
        return startPrice * (1 + 0.9 * frac); // +90% over recent window
    });
}

/** Invert every close (1/close) to build the reciprocal pair fixture. */
function invertCloses(bars: OHLCVData[]): OHLCVData[] {
    return bars.map((b) => candle(b.time as unknown as number, 1 / b.close));
}

/**
 * IBKR-style 1d sessions: the same logical anchor-grid prices, but realized as
 * weekday-only candles. Each anchor's target day is snapped backward to the
 * nearest weekday so the 30-day anchor selector still resolves one candle per
 * anchor (within the 7-day tolerance). This models stock sessions where no
 * weekend bar exists, while keeping the calendar path equivalent to the crypto
 * version.
 */
function stockSessionSeries(count: number, endTime: number, priceAt: (i: number) => number): OHLCVData[] {
    const out: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        const anchorIdx = count - 1 - i; // index 0 = earliest
        let t = endTime - (count - 1 - anchorIdx) * ANCHOR_SPACING;
        let dow = new Date(t * 1000).getUTCDay(); // 0=Sun..6=Sat
        // Snap backward to the nearest weekday (at most 2 days).
        while (dow === 0 || dow === 6) {
            t -= DAY;
            dow = new Date(t * 1000).getUTCDay();
        }
        out.push(candle(t, priceAt(anchorIdx)));
    }
    return out.sort((a, b) => (a.time as unknown as number) - (b.time as unknown as number));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const FIXED_END = Date.UTC(2025, 0, 15) / 1000; // stable anchor for all fixtures

describe("pair-regime-classifier — anchor extraction & coverage", () => {
    it("rejects empty input with NO_VALID_CLOSES", () => {
        const r = classifyPairRegime([]);
        expect(r.direction).to.equal("THIN");
        expect(r.structure).to.equal("THIN");
        expect(r.reason).to.equal("NO_VALID_CLOSES");
        expect(r.metrics.anchorCount).to.equal(0);
    });

    it("rejects invalid timestamps with INVALID_TIME when closes are valid", () => {
        const bars: OHLCVData[] = [
            { time: "not-a-time" as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        ];
        const r = classifyPairRegime(bars);
        expect(r.reason).to.equal("INVALID_TIME");
        expect(r.structure).to.equal("THIN");
    });

    it("returns INSUFFICIENT_ANCHORS when fewer than MIN_VALID_ANCHORS resolve", () => {
        // 20 anchors — below the 33 minimum.
        const bars = smoothTrendSeries(20, 100, 1.01, FIXED_END);
        const r = classifyPairRegime(bars);
        expect(r.reason).to.equal("INSUFFICIENT_ANCHORS");
        expect(r.structure).to.equal("THIN");
        expect(r.metrics.anchorCount).to.equal(20);
    });

    it("returns INSUFFICIENT_ANCHORS when the 30-day anchors are reachable but densely packed candles can't span the window", () => {
        // Candles 1 day apart for only 100 days. The 30-day anchor selector
        // finds just a handful of anchors (latest + ~3 prior), so the anchor
        // count guard fires well before the elapsed-days guard.
        const out: OHLCVData[] = [];
        for (let i = 0; i < 100; i++) {
            out.push(candle(FIXED_END - (99 - i) * DAY, 100 + i));
        }
        const r = classifyPairRegime(out);
        expect(r.reason).to.equal("INSUFFICIENT_ANCHORS");
        expect(r.metrics.anchorCount).to.be.lessThan(MIN_VALID_ANCHORS);
        expect(r.metrics.elapsedDays ?? 0).to.be.lessThan(MIN_ELAPSED_DAYS);
    });

    it("dedupes duplicate timestamps last-write-wins and sorts ascending", () => {
        // Build a valid series then duplicate the latest timestamp with a
        // different close; the duplicate must win.
        const base = smoothTrendSeries(TOTAL_ANCHORS, 100, 1.02, FIXED_END);
        const lastTime = base[base.length - 1].time as unknown as number;
        const dup: OHLCVData[] = base.concat([candle(lastTime, 999)]);
        const r = classifyPairRegime(dup);
        expect(r.reason).to.equal("OK");
        // The last anchor close should be 999 (dup wins), so endpointRatio is
        // anchored at 999.
        expect(r.metrics.endpointRatio).to.be.closeTo(999 / 100, 0.05);
    });
});

describe("pair-regime-classifier — reason: ZERO_VARIANCE on constant series", () => {
    it("classifies a perfectly constant ratio as THIN / ZERO_VARIANCE, never OSCILLATING", () => {
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, () => 100);
        const r = classifyPairRegime(bars);
        expect(r.reason).to.equal("ZERO_VARIANCE");
        expect(r.structure).to.equal("THIN");
        expect(r.structure).to.not.equal("OSCILLATING");
    });
});

describe("pair-regime-classifier — metrics definitions", () => {
    it("computes ratioReturn = last/first - 1 on a clean trend", () => {
        // price goes 100 -> 200 → ratioReturn = 1.0
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) =>
            100 + (100 * i) / (TOTAL_ANCHORS - 1),
        );
        const r = classifyPairRegime(bars);
        expect(r.metrics.ratioReturn).to.be.closeTo(1.0, 1e-9);
        expect(r.metrics.endpointRatio).to.be.closeTo(2.0, 1e-9);
    });

    it("computes logReturn = ln(last) - ln(first)", () => {
        const bars = smoothTrendSeries(TOTAL_ANCHORS, 100, 1.01, FIXED_END);
        const r = classifyPairRegime(bars);
        const expected = Math.log(100 * Math.pow(1.01, TOTAL_ANCHORS - 1)) - Math.log(100);
        expect(r.metrics.logReturn).to.be.closeTo(expected, 1e-6);
    });

    it("reports anchorCount, barCount, asOf, and elapsedDays", () => {
        const bars = smoothTrendSeries(TOTAL_ANCHORS, 100, 1.01, FIXED_END);
        const r = classifyPairRegime(bars);
        expect(r.metrics.anchorCount).to.equal(TOTAL_ANCHORS);
        expect(r.metrics.barCount).to.equal(TOTAL_ANCHORS);
        expect(r.metrics.asOf).to.equal(FIXED_END);
        expect(r.metrics.elapsedDays).to.be.closeTo(
            (TOTAL_ANCHORS - 1) * ANCHOR_INTERVAL_DAYS,
            1,
        );
    });

    it("annualizedSlope is positive for an uptrend and negative for a downtrend", () => {
        const up = classifyPairRegime(smoothTrendSeries(TOTAL_ANCHORS, 100, 1.03, FIXED_END));
        const down = classifyPairRegime(smoothTrendSeries(TOTAL_ANCHORS, 100, 0.97, FIXED_END));
        expect(up.metrics.annualizedSlope!).to.be.greaterThan(0);
        expect(down.metrics.annualizedSlope!).to.be.lessThan(0);
    });

    it("annualizes 30-day return volatility by sqrt(periods per year)", () => {
        const periodicReturns = Array.from(
            { length: TOTAL_ANCHORS - 1 },
            (_, i) => i % 2 === 0 ? 0.08 : -0.03,
        );
        const logCloses = [Math.log(100)];
        for (const value of periodicReturns) {
            logCloses.push(logCloses[logCloses.length - 1] + value);
        }
        const bars = anchorGridSeries(
            TOTAL_ANCHORS,
            FIXED_END,
            (i) => Math.exp(logCloses[i]),
        );
        const result = classifyPairRegime(bars);

        const meanReturn = periodicReturns.reduce((sum, value) => sum + value, 0)
            / periodicReturns.length;
        const sampleVariance = periodicReturns.reduce(
            (sum, value) => sum + (value - meanReturn) ** 2,
            0,
        ) / (periodicReturns.length - 1);
        const expected = Math.sqrt(sampleVariance)
            * Math.sqrt(365 / ANCHOR_INTERVAL_DAYS);

        // Volatility grows with sqrt(time). Scaling each return by 365/30
        // before taking stdev would overstate risk and suppress trend labels.
        expect(result.metrics.annualizedVolatility!).to.be.closeTo(expected, 1e-12);
    });

    it("normalizedDrift = slope / vol for a well-conditioned (noisy) series and is never null when variance > floor", () => {
        // A noisy trend has variance well above VOL_FLOOR_EPS, so the drift
        // formula holds exactly (no clamping). This is the real-metric path.
        let s = 0x5eed >>> 0;
        const rand = () => {
            s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
            return (s / 0xffffffff) * 2 - 1;
        };
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) =>
            100 * Math.pow(1.012, i) * (1 + 0.05 * rand()),
        );
        const r = classifyPairRegime(bars);
        expect(r.metrics.annualizedVolatility!).to.be.greaterThan(VOL_FLOOR_EPS * 100);
        expect(r.metrics.normalizedDrift).to.not.equal(null);
        const expected = r.metrics.annualizedSlope! / r.metrics.annualizedVolatility!;
        expect(r.metrics.normalizedDrift).to.be.closeTo(expected, 1e-6);
    });

    it("normalizedDrift is clamped to MAX_NORMALIZED_DRIFT for a deterministic (near-zero-variance) trend", () => {
        // A perfectly exponential trend has floating-point-residue variance,
        // which without clamping produces drift ~1e15. The cap keeps it bounded.
        const r = classifyPairRegime(smoothTrendSeries(TOTAL_ANCHORS, 100, 1.02, FIXED_END));
        expect(r.metrics.normalizedDrift).to.not.equal(null);
        expect(Math.abs(r.metrics.normalizedDrift!)).to.be.at.most(MAX_NORMALIZED_DRIFT);
        expect(r.metrics.normalizedDrift).to.equal(MAX_NORMALIZED_DRIFT);
    });

    it("pathEfficiency is 1 for a perfectly monotonic series", () => {
        const r = classifyPairRegime(smoothTrendSeries(TOTAL_ANCHORS, 100, 1.02, FIXED_END));
        expect(r.metrics.pathEfficiency).to.be.closeTo(1, 1e-6);
    });

    it("pathEfficiency is near 0 for a full round trip", () => {
        const r = classifyPairRegime(roundTripSeries(TOTAL_ANCHORS, 100, FIXED_END));
        // net log change ~0, sum|changes| large → efficiency near 0
        expect(r.metrics.pathEfficiency!).to.be.lessThan(0.05);
    });

    it("reversalRate is null when fewer than 2 eligible transitions", () => {
        // monotonic trend → all same-sign returns → eligible transitions exist
        // but sign changes = 0 → reversalRate = 0, not null. To force null we
        // need <2 eligible transitions, which requires a near-constant series
        // (excluded by ZERO_VARIANCE). So instead verify a monotonic series
        // yields reversalRate === 0.
        const r = classifyPairRegime(smoothTrendSeries(TOTAL_ANCHORS, 100, 1.02, FIXED_END));
        expect(r.metrics.reversalRate).to.equal(0);
    });

    it("endpointInsideBand tracks the reciprocal [1/1.30, 1.30] band", () => {
        // endpoint ratio = 1 → inside band
        const flat = classifyPairRegime(
            anchorGridSeries(TOTAL_ANCHORS, FIXED_END, () => 100),
        );
        // constant → ZERO_VARIANCE path, but endpoint is still computed before
        // the variance guard? No — guard fires first. Build a barely-varying
        // series that ends at 1.0.
        const barely = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) =>
            100 * (1 + 1e-6 * Math.sin(i)),
        );
        const r = classifyPairRegime(barely);
        expect(r.metrics.endpointRatio).to.be.closeTo(1, 1e-4);
        expect(r.metrics.endpointInsideBand).to.equal(true);
        expect(flat.reason).to.equal("ZERO_VARIANCE");
    });

    it("endpointInsideBand is false when the ratio moves beyond the band", () => {
        // 100 -> 250 → endpoint 2.5, outside 1.30
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) =>
            100 + (150 * i) / (TOTAL_ANCHORS - 1),
        );
        const r = classifyPairRegime(bars);
        expect(r.metrics.endpointRatio!).to.be.greaterThan(ENDPOINT_BAND);
        expect(r.metrics.endpointInsideBand).to.equal(false);
    });
});

describe("pair-regime-classifier — crypto vs stock session parity", () => {
    it("produces equivalent metrics for the same logical path at different bar densities", () => {
        // The same anchor-grid prices realized two ways:
        //  - crypto: dense daily candles (continuous session), with the close
        //    held at the anchor price between anchor marks
        //  - stock: weekday-only candles snapped to the anchor grid
        // Both must resolve the SAME 37 anchors and therefore produce the SAME
        // metrics — that is the whole point of calendar anchoring.
        //
        // A noisy trend (not a clean exponential) keeps variance non-degenerate
        // so the metrics are well-conditioned and comparable.
        let s = 0x5eed >>> 0;
        const rand = () => {
            s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
            return s / 0xffffffff;
        };
        const prices: number[] = [];
        for (let i = 0; i < TOTAL_ANCHORS; i++) {
            const trend = 100 * Math.pow(1.012, i);
            const noise = 1 + 0.03 * (rand() * 2 - 1);
            prices.push(trend * noise);
        }

        // Crypto: daily candles; close held at the most recent anchor price
        // between anchor marks.
        const cryptoBars: OHLCVData[] = [];
        const totalDays = (TOTAL_ANCHORS - 1) * ANCHOR_INTERVAL_DAYS;
        for (let d = 0; d <= totalDays; d++) {
            const t = FIXED_END - (totalDays - d) * DAY;
            const anchorIdx = Math.round(d / ANCHOR_INTERVAL_DAYS);
            cryptoBars.push(candle(t, prices[Math.min(anchorIdx, prices.length - 1)]));
        }

        // Stock: weekday candles snapped to the anchor grid.
        const stockBars = stockSessionSeries(TOTAL_ANCHORS, FIXED_END, (i) => prices[i]);

        const rc = classifyPairRegime(cryptoBars);
        const rs = classifyPairRegime(stockBars);

        expect(rc.metrics.anchorCount).to.equal(TOTAL_ANCHORS);
        expect(rs.metrics.anchorCount).to.equal(TOTAL_ANCHORS);
        // Ratio/log return depend only on the first & last anchor closes.
        expect(rc.metrics.ratioReturn).to.be.closeTo(rs.metrics.ratioReturn!, 1e-9);
        expect(rc.metrics.logReturn).to.be.closeTo(rs.metrics.logReturn!, 1e-9);
        // Path efficiency and reversal rate are scale-free and depend only on
        // the sequence of anchor closes (not their exact times) → identical.
        expect(rc.metrics.pathEfficiency).to.be.closeTo(rs.metrics.pathEfficiency!, 1e-9);
        expect(rc.metrics.reversalRate).to.equal(rs.metrics.reversalRate);
        // Slope, volatility, and normalized drift depend on the exact anchor
        // times. Crypto anchors land exactly on 30-day marks; stock anchors are
        // snapped to weekdays (±1–2 days). The metrics are therefore CLOSE but
        // not bit-identical — within a few percent, which is the whole point of
        // calendar anchoring making 30m/4h/1d sessions comparable.
        expect(rc.metrics.annualizedSlope!).to.be.closeTo(rs.metrics.annualizedSlope!, 0.05);
        expect(rc.metrics.annualizedVolatility!).to.be.closeTo(
            rs.metrics.annualizedVolatility!, 0.05,
        );
        // Same structure + direction: the classification is stable across the
        // two session types.
        expect(rc.structure).to.equal(rs.structure);
        expect(rc.direction).to.equal(rs.direction);
    });
});

describe("pair-regime-classifier — reciprocal pair invariants", () => {
    it("inversion flips direction while preserving efficiency and reversal rate", () => {
        const base = smoothTrendSeries(TOTAL_ANCHORS, 100, 1.04, FIXED_END);
        const inv = invertCloses(base);

        const rb = classifyPairRegime(base);
        const ri = classifyPairRegime(inv);

        // direction flips
        expect(rb.direction).to.not.equal(ri.direction);
        if (rb.direction === "BASE") expect(ri.direction).to.equal("QUOTE");
        if (rb.direction === "QUOTE") expect(ri.direction).to.equal("BASE");

        // scale-free path metrics preserved
        expect(ri.metrics.pathEfficiency).to.be.closeTo(rb.metrics.pathEfficiency!, 1e-6);
        expect(ri.metrics.reversalRate).to.be.closeTo(rb.metrics.reversalRate!, 1e-6);
        // volatility is the same (stdev of log returns is sign-invariant)
        expect(ri.metrics.annualizedVolatility).to.be.closeTo(
            rb.metrics.annualizedVolatility!,
            1e-6,
        );
        // structure preserved
        expect(ri.structure).to.equal(rb.structure);
    });

    it("reciprocal of an oscillating series stays oscillating with flipped nothing (flat direction)", () => {
        const base = oscillatingSeries(TOTAL_ANCHORS, 100, 0.08, FIXED_END);
        const inv = invertCloses(base);
        const rb = classifyPairRegime(base);
        const ri = classifyPairRegime(inv);
        expect(rb.structure).to.equal(ri.structure);
        expect(ri.metrics.pathEfficiency).to.be.closeTo(rb.metrics.pathEfficiency!, 1e-6);
    });
});

describe("pair-regime-classifier — classification labels", () => {
    it("labels a strong smooth base trend as BASE / TREND", () => {
        const bars = smoothTrendSeries(TOTAL_ANCHORS, 100, 1.05, FIXED_END);
        const r = classifyPairRegime(bars);
        expect(r.structure).to.equal("TREND");
        expect(r.direction).to.equal("BASE");
        expect(r.label).to.equal("BASE / TREND");
        expect(r.metrics.currentNormalizedDrift).to.be.gte(DRIFT_THRESHOLD);
    });

    it("labels a strong smooth quote trend as QUOTE / TREND", () => {
        const bars = smoothTrendSeries(TOTAL_ANCHORS, 100, 0.95, FIXED_END);
        const r = classifyPairRegime(bars);
        expect(r.structure).to.equal("TREND");
        expect(r.direction).to.equal("QUOTE");
    });

    it("labels a clean oscillation around a flat midline as OSCILLATING", () => {
        // Tight amplitude, 6 full cycles, endpoint near 1.0.
        const bars = oscillatingSeries(TOTAL_ANCHORS, 100, 0.06, FIXED_END);
        const r = classifyPairRegime(bars);
        expect(r.structure).to.equal("OSCILLATING");
        expect(r.metrics.pathEfficiency!).to.be.lte(OSCILLATING_EFFICIENCY_THRESHOLD);
        expect(r.metrics.reversalRate!).to.be.gte(OSCILLATING_REVERSAL_RATE_THRESHOLD);
    });

    it("labels a violent round trip as MIXED (not TREND, not OSCILLATING)", () => {
        const r = classifyPairRegime(roundTripSeries(TOTAL_ANCHORS, 100, FIXED_END));
        // Round trip: endpoint ~1 (inside band), low efficiency, but reversal
        // rate is low (one big swing each way) → falls through to MIXED.
        expect(r.structure).to.equal("MIXED");
    });

    it("labels a recent hard reversal (opposite direction) as REVERSAL", () => {
        const bars = recentReversalSeries(TOTAL_ANCHORS, 100, FIXED_END);
        const r = classifyPairRegime(bars);
        expect(r.structure).to.equal("REVERSAL");
        // Recent direction should be QUOTE (dropping).
        expect(r.direction).to.equal("QUOTE");
        expect(r.metrics.currentNormalizedDrift).to.equal(
            r.metrics.recentNormalizedDrift,
        );
    });

    it("labels a strong recent move out of flat history as TRANSITION", () => {
        const bars = recentTransitionSeries(TOTAL_ANCHORS, 100, FIXED_END);
        const r = classifyPairRegime(bars);
        expect(r.structure).to.equal("TRANSITION");
        // recent drift drives direction for TRANSITION
        expect(r.metrics.hasRecentWindow).to.equal(true);
        expect(Math.abs(r.metrics.recentNormalizedDrift!)).to.be.gte(
            RECENT_DRIFT_THRESHOLD,
        );
    });

    it("uses the pre-recent baseline so a new move is not relabeled as a mature trend", () => {
        const recentStart = TOTAL_ANCHORS - RECENT_ANCHOR_COUNT;
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) => {
            if (i < recentStart) {
                return 100 * (1 + 0.08 * Math.sin((i * Math.PI) / 2));
            }
            return 100 * Math.pow(1.4, i - recentStart);
        });
        const result = classifyPairRegime(bars);

        // The recent move makes the combined full window satisfy TREND. It
        // remains TRANSITION because the earlier baseline was oscillating.
        expect(Math.abs(result.metrics.normalizedDrift!)).to.be.gte(DRIFT_THRESHOLD);
        expect(result.metrics.pathEfficiency!).to.be.gte(TREND_EFFICIENCY_THRESHOLD);
        expect(result.structure).to.equal("TRANSITION");
    });

    it("does not call recent direction a transition when the baseline is mixed", () => {
        const recentStart = TOTAL_ANCHORS - RECENT_ANCHOR_COUNT;
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) => {
            if (i < recentStart) {
                const fraction = i / recentStart;
                const roundTrip = (1 - Math.cos(fraction * Math.PI * 2)) / 2;
                return 100 * (1 + 1.5 * roundTrip);
            }
            return 100 * Math.pow(1.4, i - recentStart);
        });
        const result = classifyPairRegime(bars);

        expect(Math.abs(result.metrics.recentNormalizedDrift!)).to.be.gte(
            RECENT_DRIFT_THRESHOLD,
        );
        // A one-swing round trip is neither an established trend nor repeated
        // oscillation. Recent momentum therefore remains MIXED evidence.
        expect(result.structure).to.equal("MIXED");
    });

    it("THIN structure forces THIN direction and a THIN / THIN label", () => {
        const r = classifyPairRegime([]);
        expect(r.direction).to.equal("THIN");
        expect(r.label).to.equal("THIN / THIN");
    });
});

describe("pair-regime-classifier — direction thresholds", () => {
    it("directionFromDrift maps to BASE / NEUTRAL / QUOTE at the threshold", () => {
        expect(directionFromDrift(DRIFT_THRESHOLD)).to.equal("BASE");
        expect(directionFromDrift(DRIFT_THRESHOLD - 1e-9)).to.equal("NEUTRAL");
        expect(directionFromDrift(-DRIFT_THRESHOLD)).to.equal("QUOTE");
        expect(directionFromDrift(0)).to.equal("NEUTRAL");
        expect(directionFromDrift(null)).to.equal("NEUTRAL");
    });
});

describe("pair-regime-classifier — recent window gating", () => {
    it("TRANSITION and REVERSAL are impossible without a gap-free recent window", () => {
        // Take a reversal fixture and punch a gap in the recent window by
        // removing the most-recent-but-one candle so the latest 7 anchors
        // cannot all resolve.
        const bars = recentReversalSeries(TOTAL_ANCHORS, 100, FIXED_END);
        // Remove a candle near the end that one of the recent anchors needs.
        // The latest 7 anchors are spaced 30 days apart ending at FIXED_END; we
        // remove the candle 30 days before the end.
        const target = FIXED_END - ANCHOR_SPACING;
        const pruned = bars.filter(
            (b) => (b.time as unknown as number) !== target,
        );
        const r = classifyPairRegime(pruned);
        expect(r.structure).to.not.equal("REVERSAL");
        expect(r.structure).to.not.equal("TRANSITION");
    });
});

describe("pair-regime-classifier — boundary thresholds", () => {
    it("TREND requires |normalizedDrift| >= DRIFT_THRESHOLD AND efficiency >= TREND_EFFICIENCY_THRESHOLD", () => {
        // A trend right at the threshold: build a series whose drift is exactly
        // tuned to land near the boundary. We assert the structure changes when
        // efficiency drops below threshold.
        const strong = classifyPairRegime(smoothTrendSeries(TOTAL_ANCHORS, 100, 1.05, FIXED_END));
        expect(strong.structure).to.equal("TREND");
        expect(Math.abs(strong.metrics.normalizedDrift!)).to.be.gte(DRIFT_THRESHOLD);

        // High drift but very low efficiency (round trip) → NOT trend.
        const lowEff = classifyPairRegime(roundTripSeries(TOTAL_ANCHORS, 100, FIXED_END));
        expect(lowEff.metrics.pathEfficiency!).to.be.lt(TREND_EFFICIENCY_THRESHOLD);
        expect(lowEff.structure).to.not.equal("TREND");
    });

    it("OSCILLATING is rejected when the endpoint is outside the band even with high reversal rate", () => {
        // Construct an oscillating series (period-4, high reversal rate, low
        // efficiency) whose net drift pushes the endpoint OUTSIDE the reciprocal
        // 30% band. The band condition is a hard requirement: ending outside the
        // band must NOT produce OSCILLATING regardless of the other metrics.
        // A trending sine: each cycle slightly higher than the last so the
        // endpoint clears the band while keeping reversal rate high.
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) =>
            100 * Math.pow(1.018, i) * (1 + 0.05 * Math.sin((i * Math.PI) / 2)),
        );
        const r = classifyPairRegime(bars);
        // Precondition: the endpoint really is outside the band.
        expect(r.metrics.endpointInsideBand).to.equal(false);
        // Therefore OSCILLATING is impossible regardless of reversal rate.
        expect(r.structure).to.not.equal("OSCILLATING");
    });

    it("OSCILLATING is rejected when reversal rate is below threshold even inside the band", () => {
        // Inside the band + low efficiency is NOT enough: reversal rate must
        // also clear 0.50. A slow single arc (one long swing) returns to start
        // (inside band, low efficiency) but has very few sign changes.
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) => {
            const frac = i / (TOTAL_ANCHORS - 1);
            const arc = (1 - Math.cos(frac * Math.PI * 2)) / 2; // 0..1..0
            return 100 * (1 + 0.2 * arc);
        });
        const r = classifyPairRegime(bars);
        expect(r.metrics.endpointInsideBand).to.equal(true);
        expect(r.metrics.reversalRate!).to.be.lt(OSCILLATING_REVERSAL_RATE_THRESHOLD);
        expect(r.structure).to.not.equal("OSCILLATING");
    });
});

describe("pair-regime-classifier — deterministic sorting", () => {
    function mk(symbol: string, structure: PairRegimeResult["structure"], drift = 0, reversal = 0, eff = 0): PairRegimeResult {
        return {
            symbol,
            direction: "NEUTRAL",
            structure,
            label: `NEUTRAL / ${structure}`,
            reason: "OK",
            metrics: {
                anchorCount: 37,
                barCount: 37,
                asOf: FIXED_END,
                elapsedDays: MIN_ELAPSED_DAYS,
                ratioReturn: 0,
                logReturn: 0,
                annualizedSlope: 0,
                annualizedVolatility: 0,
                normalizedDrift: drift,
                pathEfficiency: eff,
                reversalRate: reversal,
                hasRecentWindow: true,
                recentNormalizedDrift: drift,
                recentPathEfficiency: eff,
                endpointRatio: 1,
                endpointInsideBand: true,
                currentNormalizedDrift: drift,
            },
        };
    }

    it("orders groups TRANSITION > REVERSAL > TREND > OSCILLATING > MIXED > THIN", () => {
        const results = [
            mk("A", "THIN"),
            mk("B", "MIXED"),
            mk("C", "OSCILLATING"),
            mk("D", "TREND"),
            mk("E", "REVERSAL"),
            mk("F", "TRANSITION"),
        ];
        const sorted = [...results].sort(comparePairRegimeResults);
        expect(sorted.map((r) => r.structure)).to.deep.equal([
            "TRANSITION",
            "REVERSAL",
            "TREND",
            "OSCILLATING",
            "MIXED",
            "THIN",
        ]);
    });

    it("within TREND/REVERSAL/TRANSITION sorts by |currentNormalizedDrift| descending", () => {
        const results = [
            mk("low", "TREND", 0.6),
            mk("high", "TREND", 1.2),
            mk("mid", "TREND", 0.8),
        ];
        const sorted = [...results].sort(comparePairRegimeResults);
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["high", "mid", "low"]);
    });

    it("within OSCILLATING sorts by reversalRate desc then efficiency asc", () => {
        const results = [
            mk("a", "OSCILLATING", 0, 0.5, 0.10),
            mk("b", "OSCILLATING", 0, 0.7, 0.15),
            mk("c", "OSCILLATING", 0, 0.7, 0.05),
        ];
        const sorted = [...results].sort(comparePairRegimeResults);
        // b and c share reversalRate 0.7 → efficiency asc: c (0.05) before b (0.15)
        // then a (0.5) last.
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["c", "b", "a"]);
    });

    it("symbol is the final tie-breaker (ascending)", () => {
        const results = [
            mk("ZZZ", "TREND", 0.8),
            mk("AAA", "TREND", 0.8),
            mk("MMM", "TREND", 0.8),
        ];
        const sorted = [...results].sort(comparePairRegimeResults);
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["AAA", "MMM", "ZZZ"]);
    });

    it("formatPercent renders signed percent and n/a for null", () => {
        expect(formatPercent(0.123)).to.equal("+12.3%");
        expect(formatPercent(-0.05)).to.equal("-5.0%");
        expect(formatPercent(null)).to.equal("n/a");
        expect(formatPercent(NaN)).to.equal("n/a");
    });
});

describe("pair-regime-classifier — performance & linearity", () => {
    it("a 50,000-bar fixture classifies without retaining duplicate arrays", () => {
        // Dense 1h bars over ~5.7 years (50k bars × 3600s ≈ 2083 days) so the
        // 960-day / 33-anchor window is comfortably satisfied.
        const bars: OHLCVData[] = [];
        const totalBars = 50_000;
        for (let i = 0; i < totalBars; i++) {
            const t = FIXED_END - (totalBars - 1 - i) * 3600; // 1h bars
            const close = 100 * (1 + 0.0001 * i); // gentle trend
            bars.push(candle(t, close));
        }
        const start = Date.now();
        const r = classifyPairRegime(bars);
        const elapsed = Date.now() - start;
        expect(r.metrics.barCount).to.equal(totalBars);
        expect(r.reason).to.equal("OK");
        expect(r.metrics.anchorCount).to.equal(TOTAL_ANCHORS);
        // Linear-time sanity: 50k bars should classify well under 500ms.
        expect(elapsed).to.be.lessThan(500);
    });
});

describe("pair-regime-classifier — missing-anchor handling", () => {
    it("interior gaps do not corrupt metrics: slope is invariant, coverage holds", () => {
        // The core gap-correctness invariant: removing interior anchors (so the
        // return between the two neighbors now spans 60+ days) must NOT change
        // the annualized slope, because slope regresses on actual calendar time.
        // Before the duration-weighted volatility fix, this same probe showed
        // volatility swinging from ~1e-15 to ~7% on an unchanged price path.
        const complete = classifyPairRegime(smoothTrendSeries(TOTAL_ANCHORS, 100, 1.03, FIXED_END));
        const bars = smoothTrendSeries(TOTAL_ANCHORS, 100, 1.03, FIXED_END);
        // Remove 4 interior anchor candles so those anchors become gaps.
        const toRemove = new Set<number>();
        for (let k = 10; k < 14; k++) {
            toRemove.add(FIXED_END - k * ANCHOR_SPACING);
        }
        const pruned = bars.filter((b) => !toRemove.has(b.time as unknown as number));
        const gapped = classifyPairRegime(pruned);

        // Coverage: 4 anchors dropped but still above the minimum.
        expect(gapped.metrics.anchorCount).to.equal(TOTAL_ANCHORS - 4);
        expect(gapped.metrics.anchorCount).to.be.gte(MIN_VALID_ANCHORS);
        expect(gapped.reason).to.equal("OK");

        // Slope is gap-invariant: it depends only on (time, logClose) pairs,
        // which are unchanged for the surviving anchors.
        expect(gapped.metrics.annualizedSlope).to.be.closeTo(
            complete.metrics.annualizedSlope!, 1e-9,
        );
        // ratioReturn depends only on first/last close — unchanged.
        expect(gapped.metrics.ratioReturn).to.be.closeTo(
            complete.metrics.ratioReturn!, 1e-9,
        );
        // Both classify the same way (a deterministic trend clamps to the drift
        // cap in both cases, so the label is stable).
        expect(gapped.structure).to.equal(complete.structure);
        expect(gapped.direction).to.equal(complete.direction);
    });

    it("interior gaps do not corrupt a well-conditioned noisy trend's structure", () => {
        // On a noisy series, removing interior anchors changes which points the
        // OLS slope fits, so slope shifts slightly — but the shift is small and
        // the classification must be stable. This guards against the pre-fix
        // behavior where gap-collapsed returns were treated as 30-day returns,
        // which moved drift across a threshold and flipped the label.
        let s = 0x1234 >>> 0;
        const rand = () => {
            s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
            return (s / 0xffffffff) * 2 - 1;
        };
        const bars = anchorGridSeries(TOTAL_ANCHORS, FIXED_END, (i) =>
            100 * Math.pow(1.02, i) * (1 + 0.04 * rand()),
        );
        const complete = classifyPairRegime(bars);
        // Remove 3 interior anchors.
        const toRemove = new Set<number>();
        for (let k = 12; k < 15; k++) toRemove.add(FIXED_END - k * ANCHOR_SPACING);
        const pruned = bars.filter((b) => !toRemove.has(b.time as unknown as number));
        const gapped = classifyPairRegime(pruned);

        // ratioReturn depends only on first/last close — exactly invariant.
        expect(gapped.metrics.ratioReturn).to.be.closeTo(
            complete.metrics.ratioReturn!, 1e-9,
        );
        // Slope shifts slightly (removed points no longer contribute to OLS)
        // but stays close — within a few percent, not the orders-of-magnitude
        // swing the pre-fix duration bug produced.
        expect(gapped.metrics.annualizedSlope!).to.be.closeTo(
            complete.metrics.annualizedSlope!, 0.05,
        );
        // Structure should be stable: removing a few interior anchors does not
        // flip the regime label.
        expect(gapped.structure).to.equal(complete.structure);
    });
});
