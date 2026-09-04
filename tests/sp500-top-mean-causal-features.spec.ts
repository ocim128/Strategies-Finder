import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    buildCandidateFeatures,
    computePriorCoverageSlope5,
    computePriorScoreStdDev5,
    computePriorSignedVoteDelta3,
    computePriorTopMeanReturnMean3,
} from "../lib/batch-backtest/sp500-top-mean-causal-features";
import { tieBreakDigest } from "../lib/batch-backtest/max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

const ASSETS = ["AAA", "BBB"] as const;

function snapshot(time: number, asset: string, signedVotes: number, activePairCount = 10): PoolSnapshotRecord {
    return {
        eventId: `4h:${time}`,
        decisionTimeSec: time,
        interval: "4h",
        poolVersion: null,
        asset,
        inPool: true,
        activePairCount,
        signedVotes,
        score: activePairCount > 0 ? signedVotes / activePairCount : null,
        longEligible: signedVotes > 0,
        shortEligible: false,
        ema200Above: true,
        breadth: 0.6,
        regime: "bullish",
    };
}

function outcome(time: number, asset: string, returnValue: number | null, exitTimeSec: number | null = time + 1, status: CandidateOutcomeRecord["status"] = "ok"): CandidateOutcomeRecord {
    return {
        eventId: `4h:${time}`,
        decisionTimeSec: time,
        horizonBars: 24,
        direction: "long",
        asset,
        inPool: true,
        eligible: status === "ok" && returnValue !== null,
        return: returnValue,
        entryTimeSec: returnValue === null ? null : time + 1,
        exitTimeSec: returnValue === null ? null : exitTimeSec,
        status,
    };
}

function makeSnapshots(count = 7): PoolSnapshotRecord[] {
    const rows: PoolSnapshotRecord[] = [];
    for (let time = 1; time <= count; time += 1) {
        rows.push(snapshot(time, "AAA", time + 1, 8 + time));
        rows.push(snapshot(time, "BBB", 1, 10));
    }
    return rows;
}

describe("sp500 TOP_MEAN causal feature state machine", () => {
    it("implements the exact formulas and warm-up nulls", () => {
        assert.equal(computePriorCoverageSlope5([1, 2, 3, 4]), null);
        assert.equal(computePriorCoverageSlope5([1, 2, 3, 4, 5]), 1);
        assert.equal(computePriorSignedVoteDelta3([1, 4]), null);
        assert.equal(computePriorSignedVoteDelta3([1, 4, 7]), 6);
        assert.equal(computePriorScoreStdDev5([1, 2, 3, 4]), null);
        assert.equal(computePriorScoreStdDev5([1, 2, 3, 4, 5]), Math.sqrt(2));
        assert.equal(computePriorTopMeanReturnMean3([0.1, 0.2]), null);
        assert.ok(Math.abs(computePriorTopMeanReturnMean3([0.1, 0.2, 0.3])! - 0.2) < 1e-12);
    });

    it("emits before update and isolates all rows at one timestamp", () => {
        const rows = buildCandidateFeatures({ snapshots: makeSnapshots(), outcomes: [] });
        const first = rows.filter((row) => row.decisionTimeSec === 1);
        assert.equal(first.length, 2);
        assert.ok(first.every((row) => row.priorCoverageSlope5 === null && row.priorSignedVoteDelta3 === null && row.priorScoreStdDev5 === null));
        const seventh = rows.find((row) => row.eventId === "4h:7" && row.asset === "AAA")!;
        assert.notEqual(seventh.priorCoverageSlope5, null);
        assert.notEqual(seventh.priorSignedVoteDelta3, null);
        assert.notEqual(seventh.priorScoreStdDev5, null);
    });

    it("isolates shared asset history across two events at one timestamp", () => {
        const snapshots = [
            ...[1, 2, 3, 4].map((time) => snapshot(time, "AAA", time + 1, 10)),
            { ...snapshot(5, "AAA", 99, 10), eventId: "4h:5a" },
            { ...snapshot(5, "AAA", 100, 10), eventId: "4h:5b" },
        ];
        const rows = buildCandidateFeatures({ snapshots, outcomes: [] }).filter((row) => row.decisionTimeSec === 5);
        assert.equal(rows.length, 2);
        assert.deepEqual(
            rows.map((row) => [row.priorCoverageSlope5, row.priorSignedVoteDelta3, row.priorScoreStdDev5, row.priorTopMeanReturnMean3]),
            [[null, 2, null, null], [null, 2, null, null]],
        );
        assert.equal(rows[0]!.priorCoverageSlope5, null);
        assert.notEqual(rows[0]!.priorSignedVoteDelta3, null);
        assert.equal(rows[0]!.priorScoreStdDev5, null);
    });

    it("does not use the current row to complete feature warm-up", () => {
        const snapshots = [
            ...[1, 2, 3, 4, 5].map((time) => snapshot(time, "AAA", time + 1, 10)),
            snapshot(6, "AAA", 7, 10),
        ];
        const rows = buildCandidateFeatures({ snapshots, outcomes: [] });
        const atFive = rows.find((row) => row.eventId === "4h:5")!;
        const atSix = rows.find((row) => row.eventId === "4h:6")!;
        assert.equal(atFive.priorCoverageSlope5, null);
        assert.equal(atFive.priorScoreStdDev5, null);
        assert.notEqual(atSix.priorCoverageSlope5, null);
        assert.notEqual(atSix.priorScoreStdDev5, null);
    });

    it("uses strict prior exit availability and excludes invalid outcomes without zero fill", () => {
        const snapshots = makeSnapshots(6);
        const outcomes = [
            outcome(1, "AAA", 0.1, 2),
            outcome(2, "AAA", 0.2, 3, "missing_target"),
            outcome(3, "AAA", 0.3, 4),
            outcome(4, "AAA", 0.4, 5),
            outcome(5, "AAA", 0.5, 6),
        ];
        const rows = buildCandidateFeatures({ snapshots, outcomes });
        const atTwo = rows.find((row) => row.eventId === "4h:2" && row.asset === "AAA")!;
        const atThree = rows.find((row) => row.eventId === "4h:3" && row.asset === "AAA")!;
        const atSix = rows.find((row) => row.eventId === "4h:6" && row.asset === "AAA")!;
        assert.equal(atTwo.priorTopMeanReturnMean3, null);
        assert.equal(atThree.priorTopMeanReturnMean3, null);
        assert.equal(atSix.priorTopMeanReturnMean3, (0.1 + 0.3 + 0.4) / 3);
        const validRows = buildCandidateFeatures({ snapshots: makeSnapshots(6), outcomes: [
            outcome(1, "AAA", 0.1, 1),
            outcome(2, "AAA", 0.2, 2),
            outcome(3, "AAA", 0.3, 3),
        ] });
        assert.ok(Math.abs(validRows.find((row) => row.eventId === "4h:4" && row.asset === "AAA")!.priorTopMeanReturnMean3! - 0.2) < 1e-12);
    });

    it("excludes absent, invalid, right-censored, and non-finite outcomes", () => {
        const snapshots = makeSnapshots(9).filter((row) => row.asset === "AAA");
        const nonFinite = outcome(5, "AAA", Number.NaN, 6);
        const rows = buildCandidateFeatures({
            snapshots,
            outcomes: [
                outcome(1, "AAA", 0.1, 2),
                outcome(3, "AAA", 0.3, 4, "invalid_price"),
                outcome(4, "AAA", 0.4, 5, "right_censored"),
                nonFinite,
                outcome(6, "AAA", 0.6, 7),
                outcome(7, "AAA", 0.7, 8),
                outcome(8, "AAA", 0.8, 9),
            ],
        });
        const atNine = rows.find((row) => row.eventId === "4h:9")!;
        assert.equal(atNine.priorTopMeanReturnMean3, (0.1 + 0.6 + 0.7) / 3);
    });

    it("orders matured returns by originating decision event, not maturity", () => {
        const snapshots = [1, 2, 3, 4, 101].map((time) => snapshot(time, "AAA", 5, 10));
        const rows = buildCandidateFeatures({
            snapshots,
            outcomes: [
                outcome(1, "AAA", 1, 100),
                outcome(2, "AAA", 2, 3),
                outcome(3, "AAA", 3, 4),
                outcome(4, "AAA", 4, 5),
            ],
        });
        const atCurrent = rows.find((row) => row.eventId === "4h:101")!;
        assert.equal(atCurrent.priorTopMeanReturnMean3, 3);
        assert.notEqual(atCurrent.priorTopMeanReturnMean3, 2.666667);
    });

    it("is invariant to input order and future mutation, and supports prefix replay", () => {
        const snapshots = makeSnapshots();
        const outcomes = [1, 2, 3, 4, 5].map((time) => outcome(time, "AAA", time / 100, time));
        const expected = buildCandidateFeatures({ snapshots, outcomes });
        const permuted = buildCandidateFeatures({ snapshots: [...snapshots].reverse(), outcomes: [...outcomes].reverse() });
        assert.deepEqual(permuted, expected);
        const prefix = expected.filter((row) => row.decisionTimeSec <= 5);
        assert.deepEqual(buildCandidateFeatures({ snapshots: snapshots.filter((row) => row.decisionTimeSec <= 5), outcomes: outcomes.filter((row) => row.decisionTimeSec <= 5) }), prefix);
        const mutated = buildCandidateFeatures({
            snapshots: [...snapshots, snapshot(999, "AAA", 999, 999)],
            outcomes: [...outcomes, outcome(999, "AAA", 99, 1000)],
        });
        assert.deepEqual(mutated.slice(0, expected.length), expected);
        assert.deepEqual(expected, buildCandidateFeatures({ snapshots, outcomes }));
    });

    it("uses the frozen tie-break digest when identifying incumbent outcomes", () => {
        const snapshots: PoolSnapshotRecord[] = [];
        const outcomes: CandidateOutcomeRecord[] = [];
        const selectedAssets: string[] = [];
        for (let time = 1; time <= 5; time += 1) {
            for (const asset of ASSETS) snapshots.push(snapshot(time, asset, 5));
            const selected = [...ASSETS].sort((left, right) => tieBreakDigest(time, left).localeCompare(tieBreakDigest(time, right)) || left.localeCompare(right))[0]!;
            selectedAssets.push(selected);
            outcomes.push(outcome(time, selected, time / 100, time));
        }
        const rows = buildCandidateFeatures({ snapshots, outcomes });
        const last = rows.find((row) => row.eventId === "4h:5" && row.asset === ASSETS[0])!;
        const selectedReturns = selectedAssets.slice(0, -1).flatMap((asset, index) => asset === "AAA" ? [(index + 1) / 100] : []);
        const expected = selectedReturns.length < 3 ? null : selectedReturns.slice(-3).reduce((sum, value) => sum + value, 0) / 3;
        assert.equal(last.priorTopMeanReturnMean3, expected);
    });
});
