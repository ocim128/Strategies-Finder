import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    computeTopMeanCalibrationStats,
    evaluateTopMeanRule,
    getTopMeanRuleWindow,
    normalizeTopMeanArchive,
    type TopMeanRule,
    type TopMeanNormalizedArchive,
} from "../scripts/top-mean-rule-checker";
import {
    bootstrapBlockMeans,
    splitChronologicalBlocks,
    type PoolRuleArchive,
    type PoolRuleValuePoint,
} from "../scripts/analyze-pool-rules";
import {
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
    MAX_ACTIVE_TIE_VERSION,
    PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC,
    PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC,
    PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC,
    PAIRLIST_POOL_RULE_VALIDATION_TO_SEC,
    tieBreakDigest,
} from "../lib/batch-backtest/max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

const ASSETS = ["AAA", "BBB", "CCC"] as const;

function meta(runId: string): PoolRuleArchive["meta"] {
    return {
        schema: "top_mean_archive.v2",
        runId,
        interval: "4h",
        horizons: [24],
        canonicalAssets: [...ASSETS],
        manifest: {
            catalog: { assets: [...ASSETS] },
            researchContract: {
                tieVersion: MAX_ACTIVE_TIE_VERSION,
                blockCount: MAX_ACTIVE_BLOCK_COUNT,
                bootstrapSamples: MAX_ACTIVE_BOOTSTRAP_SAMPLES,
                bootstrapSeed: MAX_ACTIVE_BOOTSTRAP_SEED,
            },
        },
    } as PoolRuleArchive["meta"];
}

function snapshot(
    eventId: string,
    decisionTimeSec: number,
    asset: string,
    signedVotes: number,
    longEligible = signedVotes > 0,
    breadth: number | null = 0.6,
    inPool = true,
): PoolSnapshotRecord {
    const activePairCount = 10;
    return {
        eventId,
        decisionTimeSec,
        interval: "4h",
        poolVersion: null,
        asset,
        inPool,
        activePairCount,
        signedVotes,
        score: signedVotes / activePairCount,
        longEligible,
        shortEligible: false,
        ema200Above: breadth !== null && breadth > 0.5,
        breadth,
        regime: breadth === null ? "unavailable" : breadth > 0.5 ? "bullish" : "bearish",
    };
}

function outcome(
    eventId: string,
    decisionTimeSec: number,
    asset: string,
    value: number | null,
    eligible = value !== null,
): CandidateOutcomeRecord {
    return {
        eventId,
        decisionTimeSec,
        horizonBars: 24,
        direction: "long",
        asset,
        inPool: true,
        eligible,
        return: value,
        entryTimeSec: value === null ? null : decisionTimeSec + 1,
        exitTimeSec: value === null ? null : decisionTimeSec + 25,
        status: value === null ? "missing_target" : "ok",
    };
}

function makeArchive(options: {
    count?: number;
    startSec?: number;
    missing?: ReadonlySet<string>;
    noBaseIndex?: number;
    tied?: boolean;
} = {}): TopMeanNormalizedArchive {
    const count = options.count ?? 12;
    const startSec = options.startSec ?? PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC + 86_400;
    const missing = options.missing ?? new Set<string>();
    const snapshots: PoolSnapshotRecord[] = [];
    const outcomes: CandidateOutcomeRecord[] = [];
    for (let index = 0; index < count; index += 1) {
        const decisionTimeSec = startSec + index * 86_400;
        const eventId = `4h:${decisionTimeSec}`;
        const scores = options.noBaseIndex === index
            ? [0, 0, 0]
            : options.tied
                ? [5, 5, 2]
                : index % 2 === 0 ? [8, 5, 2] : [5, 8, 2];
        for (let assetIndex = 0; assetIndex < ASSETS.length; assetIndex += 1) {
            const asset = ASSETS[assetIndex]!;
            const candidate = snapshot(eventId, decisionTimeSec, asset, scores[assetIndex]!, true, index % 3 === 0 ? 0.4 : 0.6);
            if (options.noBaseIndex === index) candidate.longEligible = false;
            snapshots.push(candidate);
            const missingKey = `${eventId}|${asset}`;
            const value = missing.has(missingKey) ? null : asset === "AAA" ? 0.1 : asset === "BBB" ? 0.2 : 0.05;
            outcomes.push(outcome(eventId, decisionTimeSec, asset, value));
        }
    }
    const archive: PoolRuleArchive = {
        meta: meta("fixture"),
        snapshots,
        outcomes,
        eventRows: [],
    };
    return normalizeTopMeanArchive({ archive, reportText: "fixture report" });
}

function assertRuleFailure(rule: TopMeanRule): void {
    assert.throws(() => evaluateTopMeanRule({ archive: makeArchive({ count: 2 }), window: "validation", rule }), /RULE FAIL/);
}

describe("top-mean-rule-checker semantics", () => {
    it("uses the exact frozen discovery and validation fences", () => {
        assert.deepEqual(getTopMeanRuleWindow("discovery"), {
            name: "discovery",
            fromSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC,
            toSec: PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC,
        });
        assert.deepEqual(getTopMeanRuleWindow("validation"), {
            name: "validation",
            fromSec: PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC,
            toSec: PAIRLIST_POOL_RULE_VALIDATION_TO_SEC,
        });
        const archive = makeArchive({ count: 1, startSec: PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC });
        assert.equal(evaluateTopMeanRule({ archive, window: "discovery", rule: () => 1 }).rawEventCount, 0);
        assert.equal(evaluateTopMeanRule({ archive, window: "validation", rule: () => 1 }).rawEventCount, 1);
    });

    it("recomputes the score and forms the causal positive long base", () => {
        const archive = makeArchive({ count: 1 });
        const event = archive.events[0]!;
        assert.equal(event.baseCandidates.length, 3);
        assert.deepEqual(event.baseCandidates.map((candidate) => candidate.score), [0.8, 0.5, 0.2]);
        assert.equal(event.ruleEvent.poolSize, 3);
        assert.equal(event.ruleEvent.dow, new Date(event.decisionTimeSec * 1000).getUTCDay());
        assert.equal(event.ruleEvent.hour, new Date(event.decisionTimeSec * 1000).getUTCHours());
    });

    it("selects ranking and filter rules before applying the all-base outcome gate", () => {
        const archive = makeArchive({ count: 12 });
        const ranking = evaluateTopMeanRule({ archive, window: "validation", rule: (candidate) => candidate.asset === "BBB" ? 2 : 1 });
        assert.equal(ranking.kind, "ranking");
        assert.equal(ranking.candidateKeepRate, 1);
        assert.equal(ranking.eventKeepRate, 1);
        assert.ok(ranking.points.every((point) => point.selectedAsset === "BBB"));
        assert.ok(Math.abs((ranking.primary.mean ?? 0) - 0.05) < 1e-12);
        assert.ok(Math.abs((ranking.secondary.mean ?? 0) - 0.125) < 1e-12);

        const filter = evaluateTopMeanRule({ archive, window: "validation", rule: (candidate) => candidate.asset !== "CCC" });
        assert.equal(filter.kind, "filter");
        assert.equal(filter.candidateKeepRate, 2 / 3);
        assert.equal(filter.eventKeepRate, 1);
        assert.equal(filter.primary.mean, 0);

        let calls = 0;
        const incomplete = makeArchive({ count: 1, missing: new Set([`${archive.events[0]!.eventId}|AAA`]) });
        const result = evaluateTopMeanRule({ archive: incomplete, window: "validation", rule: () => { calls += 1; return 1; } });
        assert.equal(calls, 3);
        assert.equal(result.primary.n, 0);
        assert.equal(result.secondary.n, 0);
        assert.equal(result.eventKeepRate, 0);
    });

    it("uses frozen FNV tie-breaking for rankings and filters", () => {
        const archive = makeArchive({ count: 1, tied: true });
        const first = archive.events[0]!;
        const expected = ["AAA", "BBB"].sort((left, right) =>
            tieBreakDigest(first.decisionTimeSec, left).localeCompare(tieBreakDigest(first.decisionTimeSec, right)) || left.localeCompare(right))[0]!;
        const ranking = evaluateTopMeanRule({ archive, window: "validation", rule: (candidate) => candidate.asset === "CCC" ? 0 : 1 });
        const filter = evaluateTopMeanRule({ archive, window: "validation", rule: (candidate) => candidate.asset !== "CCC" });
        assert.equal(ranking.points[0]!.selectedAsset, expected);
        assert.equal(filter.points[0]!.selectedAsset, expected);
    });

    it("rejects mixed, non-finite, object, promise, and exception rule results", () => {
        assertRuleFailure((candidate) => candidate.asset === "AAA" ? 1 : true);
        assertRuleFailure(() => Number.NaN);
        assertRuleFailure(() => ({}) as unknown as number);
        assertRuleFailure(() => Promise.resolve(1) as unknown as number);
        assertRuleFailure(() => { throw new Error("boom"); });
    });

    it("refuses outcome leakage through reads, membership, enumeration, descriptors, and mutation", () => {
        const probes: TopMeanRule[] = [
            (candidate) => (candidate as unknown as Record<string, unknown>).return as number,
            (candidate) => ("return" in candidate ? 1 : 0),
            (candidate) => Object.keys(candidate).length,
            (candidate) => Object.entries(candidate).length,
            (candidate) => ({ ...candidate }).asset === "AAA" ? 1 : 0,
            (candidate) => Object.getOwnPropertyDescriptor(candidate, "return") ? 1 : 0,
            (candidate) => Object.getPrototypeOf(candidate) ? 1 : 0,
            (_candidate, event) => Object.getPrototypeOf(event) ? 1 : 0,
            (candidate) => { (candidate as unknown as Record<string, unknown>).asset = "LEAK"; return 1; },
            (_candidate, event) => (event as unknown as Record<string, unknown>).return as number,
        ];
        for (const probe of probes) assertRuleFailure(probe);
    });

    it("reuses ten chronological blocks and marks smaller samples inconclusive", () => {
        const archive = makeArchive({ count: 12 });
        const result = evaluateTopMeanRule({ archive, window: "validation", rule: (candidate) => candidate.asset === "BBB" ? 2 : 1 });
        assert.equal(result.primary.totalBlocks, 10);
        assert.equal(result.primary.status, "CONCLUSIVE");
        const expectedPrimaryBlocks = splitChronologicalBlocks(result.points.map((point) => ({ eventId: point.eventId, decisionTimeSec: point.decisionTimeSec, value: point.primary })))
            .map((block) => block.reduce((sum, value) => sum + value, 0) / block.length);
        assert.deepEqual(result.primary.blockMeans, expectedPrimaryBlocks);
        const small = evaluateTopMeanRule({ archive: makeArchive({ count: 9 }), window: "validation", rule: () => true });
        assert.equal(small.primary.ciLower, null);
        assert.equal(small.primary.ciUpper, null);
        assert.equal(small.primary.status, "INCONCLUSIVE");
    });

    it("computes causal calibration percentiles, regimes, daily counts, and exclusions", () => {
        const archive = makeArchive({ count: 12, noBaseIndex: 11 });
        const stats = computeTopMeanCalibrationStats(archive, "validation");
        assert.equal(stats.rawEventCount, 12);
        assert.equal(stats.baseCandidateEventCount, 11);
        assert.equal(stats.outcomeCompleteEventCount, 11);
        assert.equal(stats.exclusions.NO_BASE_CANDIDATES, 1);
        assert.equal(stats.exclusions.OUTCOME_INCOMPLETE, 0);
        assert.equal(stats.candidateSignedVotes.n, 33);
        assert.equal(stats.candidateScore.p0, 0.2);
        assert.equal(stats.eventPoolSize.p100, 3);
        assert.equal(stats.eventsPerUtcDay.p50, 1);
        assert.equal(stats.regimes.bullish.events, 8);
        assert.equal(stats.regimes.bearish.events, 4);
        assert.equal(stats.regimes.unavailable.events, 0);
    });

    it("reports concentration rows and dominant-asset exclusion on the same event set", () => {
        const archive = makeArchive({ count: 12 });
        const result = evaluateTopMeanRule({ archive, window: "validation", rule: (candidate) => candidate.asset === "BBB" ? 2 : 1 });
        assert.equal(result.selectedAssets[0]!.asset, "BBB");
        assert.equal(result.selectedAssets[0]!.events, 12);
        assert.equal(result.dominantExclusionPrimary.n, 0);
        assert.equal(result.dominantExclusionSecondary.n, 0);
        assert.equal(result.dominantExclusionPrimary.ciLower, null);
    });

    it("keeps the imported bootstrap contract deterministic", () => {
        const points: PoolRuleValuePoint[] = Array.from({ length: 20 }, (_, index) => ({ eventId: String(index), decisionTimeSec: index, value: index % 2 ? -0.002 : 0.01 }));
        const blocks = splitChronologicalBlocks(points).map((block) => block.reduce((sum, value) => sum + value, 0) / block.length);
        assert.deepEqual(bootstrapBlockMeans(blocks), bootstrapBlockMeans(blocks));
    });
});
