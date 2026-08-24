import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    computeTiedSetEventMetrics,
    extractTieGroup,
    meanOkReturns,
} from "../scripts/analyze-tied-set";
import { bootstrapBlockMeans } from "../scripts/analyze-pool-rules";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

function snapshot(asset: string, score: number | null, longEligible = true): PoolSnapshotRecord {
    return {
        eventId: "event-1",
        decisionTimeSec: 1,
        interval: "4h",
        poolVersion: "BAL679.v1",
        asset,
        inPool: true,
        activePairCount: 1,
        signedVotes: score ?? 0,
        score,
        longEligible,
        shortEligible: false,
        ema200Above: true,
        breadth: 0.8,
        regime: "bullish",
    };
}

function outcome(asset: string, value: number | null, status: CandidateOutcomeRecord["status"] = value === null ? "missing_target" : "ok"): CandidateOutcomeRecord {
    return {
        eventId: "event-1",
        decisionTimeSec: 1,
        horizonBars: 48,
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

function outcomeMap(rows: readonly CandidateOutcomeRecord[]): Map<string, CandidateOutcomeRecord> {
    return new Map(rows.map((row) => [`${row.eventId}|${row.horizonBars}|${row.asset}`, row]));
}

describe("analyze-tied-set", () => {
    it("extracts every eligible asset at the maximum score", () => {
        const group = extractTieGroup([
            snapshot("A", 2),
            snapshot("B", 2),
            snapshot("C", 1),
            snapshot("D", 2, false),
        ]);
        assert.deepEqual(group.eligibleAssets, ["A", "B", "C"]);
        assert.deepEqual(group.tiedAssets, ["A", "B"]);
        assert.equal(group.maxScore, 2);
    });

    it("computes equal-weight means from ok returns only", () => {
        const outcomes = outcomeMap([
            outcome("A", 0.1),
            outcome("B", null),
            outcome("C", 0.3),
        ]);
        assert.equal(meanOkReturns(outcomes, "event-1", 48, ["A", "B", "C"]), 0.2);
    });

    it("computes T1, T2, T3 and the exact set/pick reconciliation", () => {
        const outcomes = outcomeMap([
            outcome("A", 0.2),
            outcome("B", 0.4),
            outcome("C", 0.1),
        ]);
        const metrics = computeTiedSetEventMetrics({
            eventId: "event-1",
            horizonBars: 48,
            snapshots: [snapshot("A", 2), snapshot("B", 2), snapshot("C", 1)],
            outcomes,
            enginePickAsset: "A",
        });
        assert.ok(Math.abs(metrics.t1! - (0.3 - (0.2 + 0.4 + 0.1) / 3)) < 1e-12);
        assert.ok(Math.abs(metrics.t2! - 0.2) < 1e-12);
        assert.ok(Math.abs(metrics.t3! - -0.1) < 1e-12);
        assert.ok(Math.abs(metrics.engineDelta! - -0.05) < 1e-12);
        assert.ok(Math.abs(metrics.setComponent! - 0.05) < 1e-12);
        assert.ok(Math.abs(metrics.pickWithinSetComponent! - -0.1) < 1e-12);
        assert.ok(Math.abs(metrics.engineDelta! - (metrics.setComponent! + metrics.pickWithinSetComponent!)) < 1e-12);
    });

    it("rejects an engine pick outside the computed tie group", () => {
        assert.throws(
            () => computeTiedSetEventMetrics({
                eventId: "event-1",
                horizonBars: 48,
                snapshots: [snapshot("A", 2), snapshot("B", 2), snapshot("C", 1)],
                outcomes: new Map(),
                enginePickAsset: "C",
            }),
            /outside the computed tied set/,
        );
    });

    it("matched-filters T1 and T2 when the tie group has fewer than two ok returns", () => {
        const outcomes = outcomeMap([
            outcome("A", 0.2),
            outcome("B", null),
            outcome("C", 0.1),
        ]);
        const metrics = computeTiedSetEventMetrics({
            eventId: "event-1",
            horizonBars: 48,
            snapshots: [snapshot("A", 2), snapshot("B", 2), snapshot("C", 1)],
            outcomes,
            enginePickAsset: "A",
        });
        assert.equal(metrics.tiedOkCount, 1);
        assert.equal(metrics.t1, null);
        assert.equal(metrics.t2, null);
        assert.equal(metrics.t3, 0);
    });

    it("leaves T2 undefined when the tie group is the entire eligible pool", () => {
        const metrics = computeTiedSetEventMetrics({
            eventId: "event-1",
            horizonBars: 48,
            snapshots: [snapshot("A", 2), snapshot("B", 2)],
            outcomes: outcomeMap([outcome("A", 0.2), outcome("B", 0.4)]),
            enginePickAsset: "A",
        });
        assert.equal(metrics.t1, 0);
        assert.equal(metrics.t2, null);
    });

    it("keeps the frozen block bootstrap deterministic", () => {
        const blockMeans = [0.01, -0.002, 0.004, 0.007, -0.001, 0.003, 0.002, -0.004, 0.005, 0.006];
        assert.deepEqual(bootstrapBlockMeans(blockMeans), bootstrapBlockMeans(blockMeans));
    });
});

console.log("PASS: analyze-tied-set.spec.ts");
