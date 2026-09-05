import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    TOP_MEAN_PRICE_MIN_CATALOG_PEERS,
    buildTopMeanLeaveOneOutCatalogReturns,
    buildTopMeanRegularSessionSchedule,
    computeTopMeanPriceFeatureValues,
    summarizeTopMeanPriceSession,
    type TopMeanPriceBar,
    type TopMeanPriceSessionSummary,
    type TopMeanRegularSessionSchedule,
} from "../scripts/lib/top-mean-price-features";

function schedule(index: number, slots = 3): TopMeanRegularSessionSchedule {
    const openSec = index * 100_000;
    return { date: `2025-01-${String(index + 1).padStart(2, "0")}`, openSec, closeSec: openSec + slots * 1_800, slotStartSec: Array.from({ length: slots }, (_, slot) => openSec + slot * 1_800) };
}

function session(s: TopMeanRegularSessionSchedule, close = 100, volumes: readonly (number | null)[] = [10, 10, 10], open = 100): TopMeanPriceSessionSummary {
    return { date: s.date, openSec: s.openSec, closeSec: s.closeSec, expectedSlotCount: s.slotStartSec.length, open, close, slotCloses: [close, close, close], slotVolumes: volumes, complete: true, maxBarEndSec: s.closeSec };
}

function fixture(count = 70): { schedules: TopMeanRegularSessionSchedule[]; sessions: Map<string, TopMeanPriceSessionSummary> } {
    const schedules = Array.from({ length: count }, (_, index) => schedule(index));
    const sessions = new Map(schedules.map((item, index) => [item.date, session(item, 100 + index)] as const));
    return { schedules, sessions };
}

function catalogFor(schedules: readonly TopMeanRegularSessionSchedule[], sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>): ReadonlyMap<string, { mean: number | null; peerCount: number }> {
    const assets = Array.from({ length: TOP_MEAN_PRICE_MIN_CATALOG_PEERS + 1 }, (_, index) => `A${index}`);
    const byAsset = new Map(assets.map((asset) => [asset, sessions] as const));
    return buildTopMeanLeaveOneOutCatalogReturns({ assets, schedules, sessionsByAsset: byAsset }).get("A0")!;
}

function makeBar(timeSec: number, close: number, volume = 10): TopMeanPriceBar {
    return { timeSec, open: close, high: close, low: close, close, volume };
}

describe("TOP_MEAN price feature infrastructure", () => {
    it("freezes DST, regular holidays, and early-close session boundaries", () => {
        const beforeSpring = buildTopMeanRegularSessionSchedule("2025-03-07", "2025-03-10");
        assert.equal(beforeSpring[0]!.openSec, Math.floor(Date.parse("2025-03-07T14:30:00Z") / 1000));
        assert.equal(beforeSpring[1]!.openSec, Math.floor(Date.parse("2025-03-10T13:30:00Z") / 1000));
        const thanksgiving = buildTopMeanRegularSessionSchedule("2025-11-27", "2025-11-28");
        assert.equal(thanksgiving.length, 1);
        assert.equal(thanksgiving[0]!.slotStartSec.length, 7);
    });

    it("summarizes only the scheduled bars and marks missing bars incomplete", () => {
        const item = buildTopMeanRegularSessionSchedule("2025-01-02", "2025-01-02")[0]!;
        const bars = item.slotStartSec.map((time, index) => makeBar(time, 100 + index));
        assert.equal(summarizeTopMeanPriceSession(item, bars).complete, true);
        assert.equal(summarizeTopMeanPriceSession(item, bars.slice(1)).complete, false);
    });

    it("computes reversal, volume, gap, and catalog fields without using future sessions", () => {
        const { schedules, sessions } = fixture(71);
        for (const item of schedules.slice(-5)) sessions.set(item.date, { ...session(item, 100), slotCloses: [101, 100, 102], open: 100 });
        const catalog = catalogFor(schedules, sessions);
        const latest = schedules[69]!;
        const input = { asset: "A0", decisionTimeSec: latest.closeSec + 1, schedules, sessions, catalogReturns: catalog };
        const values = computeTopMeanPriceFeatureValues(input);
        assert.equal(values.priceReversalRate5, 1);
        assert.equal(values.priceRelativeVolume1, 0);
        assert.ok(values.priceGapFollowThrough20 !== null);
        assert.ok(values.priceCatalogCorrelation20 !== null);

        const future = new Map(sessions);
        future.set(schedules[70]!.date, session(schedules[70]!, 1_000_000));
        assert.deepEqual(computeTopMeanPriceFeatureValues({ ...input, sessions: future }), values);
    });

    it("requires exact scheduled history and excludes a session at close-time equality", () => {
        const { schedules, sessions } = fixture();
        for (const item of schedules.slice(-6, -1)) sessions.set(item.date, { ...session(item, 100), slotCloses: [101, 100, 102], open: 100 });
        const latest = schedules[69]!;
        const input = { asset: "A0", decisionTimeSec: latest.closeSec, schedules, sessions, catalogReturns: catalogFor(schedules, sessions) };
        const atClose = computeTopMeanPriceFeatureValues(input);
        assert.equal(atClose.priceReversalRate5, 1, "the previous session is the latest strictly prior complete session");
        sessions.delete(schedules[60]!.date);
        const withGap = computeTopMeanPriceFeatureValues({ ...input, decisionTimeSec: latest.closeSec + 1 });
        assert.equal(withGap.priceResidualMomentum5, null);
        assert.equal(withGap.priceVolExpansion5, null);
    });

    it("returns null for zero volume baselines and is deterministic", () => {
        const { schedules, sessions } = fixture();
        const current = schedules[69]!;
        sessions.set(current.date, session(current, 200, [10, 10, 10]));
        for (let index = 49; index < 69; index += 1) sessions.set(schedules[index]!.date, session(schedules[index]!, 100, [0, 0, 0]));
        const input = { asset: "A0", decisionTimeSec: current.closeSec + 1, schedules, sessions, catalogReturns: catalogFor(schedules, sessions) };
        const first = computeTopMeanPriceFeatureValues(input);
        const second = computeTopMeanPriceFeatureValues(input);
        assert.equal(first.priceRelativeVolume1, null);
        assert.deepEqual(second, first);
    });
});
