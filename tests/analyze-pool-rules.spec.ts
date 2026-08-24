import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    bootstrapBlockMeans,
    buildEma200,
    buildMonthAnchors,
    buildP1Membership,
    buildP2Membership,
    computePoolQualityPoint,
    deterministicSubset,
    topMeanPoint,
    validateEmaAnchor,
    type PoolRuleAssetSeries,
    type PoolRuleEvent,
} from "../scripts/analyze-pool-rules";
import { tieBreakDigest } from "../lib/batch-backtest/max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

const ASSETS = Array.from({ length: 70 }, (_, index) => `A${String(index).padStart(2, "0")}`);

function time(year: number, month: number, day: number): number {
    return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

function snapshot(
    eventId: string,
    decisionTimeSec: number,
    asset: string,
    breadth: number | null,
    ema200Above: boolean,
    score = 0,
    longEligible = false,
): PoolSnapshotRecord {
    return {
        eventId,
        decisionTimeSec,
        interval: "4h",
        poolVersion: "BAL679.v1",
        asset,
        inPool: true,
        activePairCount: 1,
        signedVotes: score,
        score,
        longEligible,
        shortEligible: false,
        ema200Above,
        breadth,
        regime: breadth !== null && breadth > 0.5 ? "bullish" : "bearish",
    };
}

function event(
    eventId: string,
    decisionTimeSec: number,
    breadth: number | null,
    above: readonly string[],
    scores: ReadonlyMap<string, number> = new Map(),
): PoolRuleEvent {
    const snapshots = new Map<string, PoolSnapshotRecord>();
    for (const asset of ASSETS) {
        const score = scores.get(asset) ?? 0;
        snapshots.set(asset, snapshot(eventId, decisionTimeSec, asset, breadth, above.includes(asset), score, score > 0));
    }
    return { eventId, decisionTimeSec, snapshots };
}

function outcome(eventId: string, asset: string, value: number | null, horizonBars = 48, status: CandidateOutcomeRecord["status"] = value === null ? "missing_target" : "ok"): CandidateOutcomeRecord {
    return {
        eventId,
        decisionTimeSec: 1,
        horizonBars,
        direction: "long",
        asset,
        inPool: true,
        eligible: true,
        return: value,
        entryTimeSec: value === null ? null : 2,
        exitTimeSec: value === null ? null : 3,
        status,
    };
}

function constantSeries(close = 100): PoolRuleAssetSeries {
    const bars = Array.from({ length: 321 }, (_, index) => ({ timeSec: index, close }));
    return { bars, ema200: buildEma200(bars) };
}

describe("analyze-pool-rules", () => {
    it("uses the first monthly breadth anchor, strict >0.50, and freezes membership", () => {
        const janFirst = event("jan-first", time(2026, 1, 2), 0.5, [ASSETS[0]!]);
        const janLater = event("jan-later", time(2026, 1, 3), 0.8, [ASSETS[1]!]);
        const feb = event("feb", time(2026, 2, 2), 0.8, [ASSETS[2]!]);
        const anchors = buildMonthAnchors([janFirst, janLater, feb]);
        const result = buildP1Membership(anchors, ASSETS);
        assert.equal(result.activeMonths, 1);
        assert.equal(result.inactiveMonths, 1);
        assert.deepEqual([...result.members.get("2026-01")!], []);
        assert.deepEqual([...result.members.get("2026-02")!], [ASSETS[2]!]);
    });

    it("ranks momentum by return minus cross-sectional median, uses FNV ties, and excludes missing history", () => {
        const anchorTime = 320;
        const eventAtAnchor = event("momentum", anchorTime, 0.8, []);
        const anchors = buildMonthAnchors([eventAtAnchor]);
        const series = new Map<string, PoolRuleAssetSeries>();
        for (const asset of ASSETS) series.set(asset, constantSeries());
        series.set(ASSETS[69]!, { bars: constantSeries().bars.slice(0, 100), ema200: [] });
        const members = buildP2Membership(anchors, ASSETS, series, "strictly_before", 3).members.get("1970-01")!;
        const tieOrder = [...ASSETS.slice(0, 69)].sort((left, right) =>
            tieBreakDigest(anchorTime, left).localeCompare(tieBreakDigest(anchorTime, right)) || left.localeCompare(right));
        assert.deepEqual([...members], tieOrder.slice(0, 3));
        assert.notEqual(members.has(ASSETS[69]!), true);
    });

    it("keys deterministic subsets by event and pool size", () => {
        const first = deterministicSubset(ASSETS, 21, "4h:1700000000");
        assert.deepEqual(first, deterministicSubset(ASSETS, 21, "4h:1700000000"));
        assert.notDeepEqual(first, deterministicSubset(ASSETS, 22, "4h:1700000000"));
        assert.notDeepEqual(first, deterministicSubset(ASSETS, 21, "4h:1700000001"));
        assert.equal(new Set(first).size, 21);
    });

    it("filters pool quality to matched computable events and does not zero-fill missing returns", () => {
        const members = new Set([ASSETS[0]!, ASSETS[1]!]);
        const complete = new Map<string, CandidateOutcomeRecord>([
            ["e|48|A00", outcome("e", ASSETS[0]!, 0.2)],
            ["e|48|A01", outcome("e", ASSETS[1]!, 0.1)],
            ...ASSETS.slice(2).map((asset) => [`e|48|${asset}`, outcome("e", asset, 0)] as const),
        ]);
        assert.ok(Math.abs(computePoolQualityPoint({ catalogAssets: ASSETS, outcomeByKey: complete, eventId: "e", decisionTimeSec: 1, horizonBars: 48, members })!.value - (0.15 - 0.3 / 70)) < 1e-12);
        complete.set("e|48|A00", outcome("e", ASSETS[0]!, null));
        complete.set("e|48|A01", outcome("e", ASSETS[1]!, null));
        assert.equal(computePoolQualityPoint({ catalogAssets: ASSETS, outcomeByKey: complete, eventId: "e", decisionTimeSec: 1, horizonBars: 48, members }), null);
    });

    it("computes restricted TOP_MEAN leave-one-out control", () => {
        const scores = new Map([[ASSETS[0]!, 1], [ASSETS[1]!, 0.5]]);
        const current = event("loo", 1, 0.8, [], scores);
        const outcomeByKey = new Map<string, CandidateOutcomeRecord>([
            ["loo|48|A00", outcome("loo", ASSETS[0]!, 0.2)],
            ["loo|48|A01", outcome("loo", ASSETS[1]!, 0.1)],
        ]);
        const point = topMeanPoint({
            catalogAssets: ASSETS,
            events: [current],
            outcomeByKey,
            seriesByAsset: new Map(),
            anchor: "strictly_before",
        }, current, 48, new Set([ASSETS[0]!, ASSETS[1]!]));
        assert.equal(point?.selectedAsset, ASSETS[0]!);
        assert.equal(point?.value, 0.1);
    });

    it("keeps block bootstrap deterministic", () => {
        const points = Array.from({ length: 20 }, (_, index) => ({
            eventId: String(index),
            decisionTimeSec: index,
            value: index % 2 === 0 ? 0.01 : -0.002,
        }));
        const blockMeans = points.reduce<number[][]>((blocks, point, index) => {
            (blocks[index % 10] ??= []).push(point.value);
            return blocks;
        }, []).map((block) => block.reduce((sum, value) => sum + value, 0) / block.length);
        assert.deepEqual(bootstrapBlockMeans(blockMeans), bootstrapBlockMeans(blockMeans));
    });

    it("accepts the causal EMA anchor and loudly rejects an inconsistent archive", () => {
        const bars = Array.from({ length: 301 }, (_, index) => ({ timeSec: index, close: index < 200 ? 100 : index === 300 ? 99 : 101 }));
        const series: PoolRuleAssetSeries = { bars, ema200: buildEma200(bars) };
        const events = Array.from({ length: 50 }, (_, index) => {
            const decisionTimeSec = 300;
            return event(`ema-${index}`, decisionTimeSec, 0.8, ASSETS);
        });
        const seriesByAsset = new Map(ASSETS.map((asset) => [asset, series] as const));
        const pass = validateEmaAnchor({ events, catalogAssets: ASSETS, seriesByAsset });
        assert.equal(pass.anchor, "strictly_before");
        const inconsistent = events.map((current) => ({
            ...current,
            snapshots: new Map([...current.snapshots].map(([asset, row]) => [asset, { ...row, ema200Above: false }])),
        }));
        const inconsistentBars = bars.map((bar, index) => index === 300 ? { ...bar, close: 101 } : bar);
        const inconsistentSeries = new Map(ASSETS.map((asset) => [asset, { bars: inconsistentBars, ema200: buildEma200(inconsistentBars) }] as const));
        assert.throws(() => validateEmaAnchor({ events: inconsistent, catalogAssets: ASSETS, seriesByAsset: inconsistentSeries }), /EMA anchor self-check failed/);
    });
});

console.log("PASS: analyze-pool-rules.spec.ts");
