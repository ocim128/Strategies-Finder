import { expect } from "chai";
import { describe, it } from "node:test";
import {
    compareStabilitySnapshots,
    formatStartDateLabel,
    type StabilityWindowResult,
} from "../lib/batch-backtest/sp500-top-mean-stability-compare";
import type { CurrentTopMeanSnapshot, CurrentTopMeanStats } from "../lib/batch-backtest/sp500-top-mean-current-snapshot";

/**
 * Pure unit tests for the stability comparison. Builds synthetic snapshots
 * directly — no coordinator, no artifacts, no data loading — so the
 * intersection/drift/verdict math is locked independently of the run path.
 */

const STATS: CurrentTopMeanStats = {
    artifactsProcessed: 3,
    openPositions: 3,
    positiveCandidates: 1,
    staleEndpoints: 0,
    missingEndpoints: 0,
    malformedArtifacts: 0,
    tieCount: 0,
    durationMs: 1,
};

function snap(
    winners: Array<{ asset: string; mean?: number }>,
    candidates?: Array<{ asset: string; mean: number; score: number; activePairs: number }>,
    reason: CurrentTopMeanSnapshot["reason"] = "ok",
): CurrentTopMeanSnapshot {
    const cand = candidates ?? winners.map((w) => ({
        asset: w.asset,
        mean: w.mean ?? 1,
        score: 1,
        activePairs: 1,
    }));
    return {
        asOf: 1_700_000_000,
        artifacts: 3,
        openPositions: 3,
        candidates: cand,
        winners: winners.map((w) => ({
            asset: w.asset,
            mean: w.mean ?? 1,
            score: 1,
            activePairs: 1,
        })),
        reason,
    };
}

function win(startDateSec: number | null, winners: Array<{ asset: string; mean?: number }>, opts: {
    candidates?: Array<{ asset: string; mean: number; score: number; activePairs: number }>;
    reason?: CurrentTopMeanSnapshot["reason"];
} = {}): StabilityWindowResult {
    return {
        startDateSec,
        label: formatStartDateLabel(startDateSec),
        snapshot: snap(winners, opts.candidates, opts.reason),
        stats: STATS,
    };
}

describe("formatStartDateLabel", () => {
    it("null -> Full", () => {
        expect(formatStartDateLabel(null)).to.equal("Full");
    });
    it("unix seconds -> YYYY-MM-DD (UTC)", () => {
        // 2023-01-01 00:00:00 UTC = 1672531200
        expect(formatStartDateLabel(1672531200)).to.equal("2023-01-01");
    });
});

describe("compareStabilitySnapshots", () => {
    it("0 windows -> empty comparison, gate false", () => {
        const c = compareStabilitySnapshots([]);
        expect(c.windows).to.deep.equal([]);
        expect(c.commonWinners).to.deep.equal([]);
        expect(c.unionWinners).to.deep.equal([]);
        expect(c.agreementPct).to.equal(0);
        expect(c.divergentWindows).to.equal(false);
        expect(c.parityAssumptionHolds).to.equal(false);
    });

    it("1 window -> gate false (cannot assess stability from one data point)", () => {
        const c = compareStabilitySnapshots([win(null, [{ asset: "AAA" }])]);
        expect(c.unionWinners).to.deep.equal(["AAA"]);
        expect(c.commonWinners).to.deep.equal(["AAA"]);
        expect(c.agreementPct).to.equal(100);
        expect(c.divergentWindows).to.equal(false);
        // Single window still does not pass the gate.
        expect(c.parityAssumptionHolds).to.equal(false);
    });

    it("FULL AGREEMENT: 3 windows all pick AAA -> gate PASS", () => {
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA" }]),
            win(1672531200, [{ asset: "AAA" }]),
            win(1704067200, [{ asset: "AAA" }]),
        ]);
        expect(c.commonWinners).to.deep.equal(["AAA"]);
        expect(c.unionWinners).to.deep.equal(["AAA"]);
        expect(c.agreementPct).to.equal(100);
        expect(c.divergentWindows).to.equal(false);
        expect(c.parityAssumptionHolds).to.equal(true);
    });

    it("FULL DIVERGENCE: each window picks a different asset -> gate BLOCKED", () => {
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA" }]),
            win(1672531200, [{ asset: "BBB" }]),
        ]);
        expect(c.commonWinners).to.deep.equal([]);
        expect(c.unionWinners).to.deep.equal(["AAA", "BBB"]);
        expect(c.agreementPct).to.equal(0);
        expect(c.divergentWindows).to.equal(true);
        expect(c.parityAssumptionHolds).to.equal(false);
    });

    it("PARTIAL OVERLAP: AAA in all, BBB in one only -> gate BLOCKED", () => {
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA" }, { asset: "BBB" }]),
            win(1672531200, [{ asset: "AAA" }]),
        ]);
        // AAA is common; BBB appears only in window 0.
        expect(c.commonWinners).to.deep.equal(["AAA"]);
        expect(c.unionWinners).to.deep.equal(["AAA", "BBB"]);
        expect(c.agreementPct).to.equal(50);
        expect(c.divergentWindows).to.equal(true);
        expect(c.parityAssumptionHolds).to.equal(false);
    });

    it("TIE stability: 3-way tie AAA/BBB/CCC preserved across windows -> PASS", () => {
        // The reducer surfaces ALL tied winners; if the same tie survives every
        // window, that IS stable (the tie is not a divergence, it's the answer).
        const tied = [{ asset: "AAA" }, { asset: "BBB" }, { asset: "CCC" }];
        const c = compareStabilitySnapshots([
            win(null, tied),
            win(1672531200, tied),
            win(1704067200, tied),
        ]);
        expect(c.commonWinners.sort()).to.deep.equal(["AAA", "BBB", "CCC"]);
        expect(c.agreementPct).to.equal(100);
        expect(c.divergentWindows).to.equal(false);
        expect(c.parityAssumptionHolds).to.equal(true);
    });

    it("any window with NO winners -> commonWinners empty, gate false", () => {
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA" }]),
            win(1672531200, [], { reason: "no_positive_candidates" }),
        ]);
        expect(c.commonWinners).to.deep.equal([]);
        expect(c.unionWinners).to.deep.equal(["AAA"]);
        expect(c.agreementPct).to.equal(0);
        expect(c.parityAssumptionHolds).to.equal(false);
    });

    it("maxMeanDrift: same winner set but drifting mean across windows -> gate still PASS, drift > 0", () => {
        // Same winner asset AAA in both windows, but mean drifts 1.0 -> 1.5.
        // Set comparison agrees (AAA in both), so gate PASSES. The drift is
        // surfaced as a diagnostic so the user can see "same pick, weaker/stronger
        // conviction" — which does NOT by itself block continuation parity.
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA", mean: 1.0 }], {
                candidates: [{ asset: "AAA", mean: 1.0, score: 1, activePairs: 1 }],
            }),
            win(1672531200, [{ asset: "AAA", mean: 1.5 }], {
                candidates: [{ asset: "AAA", mean: 1.5, score: 3, activePairs: 2 }],
            }),
        ]);
        expect(c.commonWinners).to.deep.equal(["AAA"]);
        expect(c.parityAssumptionHolds).to.equal(true);
        expect(c.maxMeanDrift).to.be.closeTo(0.5, 1e-9);
    });

    it("maxMeanDrift: only counts assets present as candidates in ALL windows", () => {
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA", mean: 1.0 }], {
                candidates: [
                    { asset: "AAA", mean: 1.0, score: 1, activePairs: 1 },
                    { asset: "ZZZ", mean: 5.0, score: 5, activePairs: 1 },
                ],
            }),
            win(1672531200, [{ asset: "AAA", mean: 1.2 }], {
                candidates: [{ asset: "AAA", mean: 1.2, score: 2, activePairs: 2 }],
            }),
        ]);
        // ZZZ is a candidate only in window 0, so it is excluded from drift.
        // AAA drift: |1.2 - 1.0| = 0.2.
        expect(c.maxMeanDrift).to.be.closeTo(0.2, 1e-9);
    });

    it("maxMeanDrift: includes common candidates that are not winners in every window", () => {
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA" }], {
                candidates: [
                    { asset: "AAA", mean: 2.0, score: 2, activePairs: 1 },
                    { asset: "BBB", mean: 1.0, score: 1, activePairs: 1 },
                ],
            }),
            win(1672531200, [{ asset: "AAA" }], {
                candidates: [
                    { asset: "AAA", mean: 2.1, score: 2.1, activePairs: 1 },
                    { asset: "BBB", mean: 4.0, score: 4, activePairs: 1 },
                ],
            }),
        ]);
        // BBB is a candidate in both windows but is not a winner in either;
        // its 3.0 drift must still be visible in the diagnostic.
        expect(c.maxMeanDrift).to.be.closeTo(3.0, 1e-9);
    });

    it("reportLines include the GATE verdict line and per-window breakdown", () => {
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA" }]),
            win(1672531200, [{ asset: "AAA" }]),
        ]);
        const joined = c.reportLines.join("\n");
        expect(joined).to.contain("GATE=PASS");
        expect(joined).to.contain("Full");
        expect(joined).to.contain("2023-01-01");
        expect(joined).to.contain("winners=AAA");
    });

    it("winner order within a window does not affect divergence detection", () => {
        // Winners are a SET; [{AAA,BBB}] vs [{BBB,AAA}] is NOT divergence.
        const c = compareStabilitySnapshots([
            win(null, [{ asset: "AAA" }, { asset: "BBB" }]),
            win(1672531200, [{ asset: "BBB" }, { asset: "AAA" }]),
        ]);
        expect(c.divergentWindows).to.equal(false);
        expect(c.parityAssumptionHolds).to.equal(true);
    });
});
