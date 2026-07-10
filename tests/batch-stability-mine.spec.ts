import { expect } from "chai";
import { describe, it } from "node:test";
import {
    addStabilityVerdicts,
    computeDominantPair,
    computeJaccardDiversity,
    computeTimingEdgeScore,
    createStabilityAggregate,
    finalizeStabilityAggregate,
} from "../lib/batch-backtest/batch-stability-mine";
import type { BatchSyntheticAssetVerdict } from "../lib/batch-backtest/batch-synthetic-state-miner";

/**
 * Stability Mine scoring tests.
 *
 * Intent being locked (per AGENTS.md rule 8 — tests must encode WHY):
 * With 400 pair list / 200-per-rerun × N reruns, the raw `hits` count cannot
 * tell whether the asset's signal genuinely recurred across independent
 * agreeing-pair sets or whether one dominant pair got resampled every rerun
 * and dragged the asset over the line. The TimingEdgeScore + Jaccard
 * diversity term exists to make that distinction. These tests fail if the
 * scoring ever stops punishing repetition or stops rewarding diverse
 * confirmation.
 */

function verdict(args: {
    asset: string;
    verdict: "LONG" | "SHORT";
    confidence?: "high" | "medium" | "low" | "none";
    liftPct?: number;
    mfePct?: number;
    maePct?: number;
    hmaxLiftPct?: number;
    agreeingSymbols?: string[];
    pairWarnings?: number;
    medianBarsHeld?: number | null;
    agreementTransition?: number;
}): BatchSyntheticAssetVerdict {
    const confidence = args.confidence ?? "medium";
    const lift = args.liftPct ?? 1.5;
    const mfe = args.mfePct ?? 2;
    const mae = args.maePct ?? -1;
    const hmax = args.hmaxLiftPct ?? 1;
    return {
        asset: args.asset,
        verdict: args.verdict,
        direction: args.verdict === "LONG" ? "long" : "short",
        confidence,
        currentSnapshot: {
            asset: args.asset,
            direction: args.verdict === "LONG" ? "long" : "short",
            timeKey: "t",
            barIndex: 100,
            close: 100,
            activePeerCount: args.agreeingSymbols?.length ?? 1,
            agreementCount: args.agreeingSymbols?.length ?? 1,
            oppositionCount: 0,
            agreementRatio: 1,
            oppositionRatio: 0,
            netAgreement: args.agreeingSymbols?.length ?? 1,
            agreementTransition: args.agreementTransition ?? 1,
            medianBarsHeld: args.medianBarsHeld === undefined ? 5 : args.medianBarsHeld,
            medianMoveSinceEntryPct: 1,
            medianMoveSinceEntryAtr: 1,
            medianAdverseExcursionAtr: -0.5,
            breadthPersistence: 3,
            agreeingSymbols: args.agreeingSymbols ?? ["BTC+ETH"],
            opposingSymbols: [],
        },
        evidence: {
            horizonBars: 6,
            horizonBarsAll: [6, 12, 24],
            candidateCount: 100,
            analogCount: 12,
            selectionCount: 8,
            oosCount: 6,
            avgDistance: 1.2,
            selectionForwardReturnPct: lift,
            selectionMfePct: mfe,
            selectionMaePct: mae,
            expectedForwardReturnPct: lift,
            expectedMfePct: mfe,
            expectedMaePct: mae,
            baselineOosReturnPct: 0,
            oosLiftPct: lift,
            longestHorizonBars: 24,
            longestOosForwardReturnPct: lift,
            longestOosLiftPct: hmax,
        },
        pairContributions: Array.from({ length: args.pairWarnings ?? 0 }, (_, i) => ({
            symbol: `WARN${i}`,
            side: "agreeing" as const,
            label: "dominating" as const,
            oosCountWithout: 4,
            oosReturnWithoutPct: 0,
            returnDeltaPct: 0,
        })),
        reasons: [],
        diagnostics: [],
    };
}

describe("computeJaccardDiversity", () => {
    it("returns 0 when fewer than 2 sets — diversity is undefined, not maximal", () => {
        expect(computeJaccardDiversity([])).to.equal(0);
        expect(computeJaccardDiversity([["BTC+ETH"]])).to.equal(0);
    });

    it("returns 0 when every hit recorded the identical pair set (pure repetition)", () => {
        const sets = Array.from({ length: 20 }, () => ["BTC+ETH"]);
        expect(computeJaccardDiversity(sets)).to.equal(0);
    });

    it("returns 1 when no two hits share any pair (fully diverse confirmation)", () => {
        const sets = [
            ["BTC+ETH"],
            ["SOL+AVAX"],
            ["MATIC+DOT"],
            ["LINK+UNI"],
        ];
        // 6 pairs, all disjoint → avg distance 1
        expect(computeJaccardDiversity(sets)).to.be.closeTo(1, 1e-9);
    });

    it("returns 2/3 for three identical-pair-rotating sets (the 'two pairs rotating' case dominant-share is blind to)", () => {
        // Two pairs rotating across hits: A,B / A,C / B,C — each pair of sets
        // shares exactly 1 of 3 elements → Jaccard similarity 1/3 → distance 2/3.
        // A dominant-pair-share metric would see each pair appear twice out of
        // 3 hits (share 0.67) and call this near-repetition; Jaccard correctly
        // shows moderate diversity.
        const sets = [
            ["BTC+ETH", "BTC+SOL"],
            ["BTC+ETH", "BTC+AVAX"],
            ["BTC+SOL", "BTC+AVAX"],
        ];
        // Sanity: each pair-of-sets shares one symbol of three total → distance 2/3
        expect(computeJaccardDiversity(sets)).to.be.closeTo(2 / 3, 1e-9);
    });

    it("treats empty sets as not diverse — they don't inflate the score", () => {
        // All empty: similarity(∅,∅) = 1 → distance 0
        expect(computeJaccardDiversity([[], [], []])).to.equal(0);
    });
});

describe("computeDominantPair", () => {
    it("returns null pair and 0 share when there are no hits", () => {
        expect(computeDominantPair([])).to.deep.equal({ pair: null, share: 0 });
    });

    it("returns null pair when hits have no agreeing symbols", () => {
        expect(computeDominantPair([[], []])).to.deep.equal({ pair: null, share: 0 });
    });

    it("computes appearances / totalHits (not appearances / non-empty hits)", () => {
        // 4 hits total; BTC+ETH appears in 3 of them; one hit had no agreeing list.
        const dominant = computeDominantPair([["BTC+ETH"], ["BTC+ETH"], ["BTC+ETH"], []]);
        expect(dominant.pair).to.equal("BTC+ETH");
        // 3/4, NOT 3/3 — empty hits must dilute the share, not be hidden.
        expect(dominant.share).to.equal(0.75);
    });
});

describe("computeTimingEdgeScore", () => {
    it("returns 0 when hits is 0 (no edge to score)", () => {
        expect(computeTimingEdgeScore({
            hits: 0, high: 0, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 0, medianDiversity: 1,
        })).to.equal(0);
    });

    it("returns 0 when lift / hmax / rr is null (insufficient analog evidence)", () => {
        const base = {
            hits: 10, high: 10, medium: 0, low: 0,
            pairWarnings: 0, medianDiversity: 1, medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
        };
        expect(computeTimingEdgeScore({ ...base, medianLiftPct: null })).to.equal(0);
        expect(computeTimingEdgeScore({ ...base, medianHmaxLiftPct: null })).to.equal(0);
        expect(computeTimingEdgeScore({ ...base, medianRr: null })).to.equal(0);
    });

    it("zeroes the score when longest-horizon OOS lift is non-positive (short-horizon drift, not transferable edge)", () => {
        // Strong lift, strong rr, full diversity — but longest horizon fails.
        expect(computeTimingEdgeScore({
            hits: 10, high: 10, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: -0.1,
            pairWarnings: 0, medianDiversity: 1,
        })).to.equal(0);
    });

    it("crushes the score when diversity is 0 (the 'repeating the same thing' failure mode)", () => {
        // Excellent edge metrics but every hit came from the identical pair set.
        // Score must be 0 — this is THE failure the score exists to catch.
        expect(computeTimingEdgeScore({
            hits: 20, high: 20, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 0, medianDiversity: 0,
        })).to.equal(0);
    });

    it("rewards diversity — same edge metrics, but diverse confirmation scores higher than repetition", () => {
        const repeat = computeTimingEdgeScore({
            hits: 20, high: 20, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 0, medianDiversity: 0,
        });
        const diverse = computeTimingEdgeScore({
            hits: 20, high: 20, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 0, medianDiversity: 1,
        });
        expect(repeat).to.equal(0);
        expect(diverse).to.be.greaterThan(0);
        expect(diverse).to.be.greaterThan(repeat);
    });

    it("treats infinite rr (MAE ≈ 0) as the max rr factor of 1, not Infinity", () => {
        // The accumulator's rr can be +Inf when adverse excursion is ~0.
        // That should map to the max factor, not blow up the score.
        const score = computeTimingEdgeScore({
            hits: 10, high: 10, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: Number.POSITIVE_INFINITY, medianHmaxLiftPct: 5,
            pairWarnings: 0, medianDiversity: 1,
        });
        expect(Number.isFinite(score)).to.equal(true);
        expect(score).to.be.greaterThan(0);
    });

    it("pair warnings cut the score softly — 50% at ratio 1.0, zero at ratio ≥ 2 (not strict 1 − w/h)", () => {
        // Softened formula: penalty = 1 − clamp01(0.5 · w/h).
        // The strict `1 − w/h` would zero any row where warnings ≥ hits,
        // however diverse the agreeing pairs. The Jaccard independence factor
        // already guards "same pair repeating"; PairWarn is secondary.
        const noWarnings = computeTimingEdgeScore({
            hits: 10, high: 10, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 0, medianDiversity: 1,
        });
        // ratio 0.5 (5 warnings / 10 hits) → penalty 0.75 → 75% of score kept
        const halfRatio = computeTimingEdgeScore({
            hits: 10, high: 10, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 5, medianDiversity: 1,
        });
        // ratio 1.0 (warnings === hits) → penalty 0.5 → still surfaces at 50%
        const equalRatio = computeTimingEdgeScore({
            hits: 10, high: 10, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 10, medianDiversity: 1,
        });
        // ratio 2.0 (warnings === 2× hits) → 0.5·2 = 1.0 → penalty 0 → zeroed
        const doubleRatio = computeTimingEdgeScore({
            hits: 10, high: 10, medium: 0, low: 0,
            medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 20, medianDiversity: 1,
        });
        expect(halfRatio).to.be.closeTo(noWarnings * 0.75, 1);
        expect(equalRatio).to.be.closeTo(noWarnings * 0.5, 1);
        expect(doubleRatio).to.equal(0);
    });

    it("confidence floor weights high > medium > low", () => {
        const base = {
            hits: 10, medianLiftPct: 5, medianRr: 3, medianHmaxLiftPct: 5,
            pairWarnings: 0, medianDiversity: 1,
        };
        const allHigh = computeTimingEdgeScore({ ...base, high: 10, medium: 0, low: 0 });
        const allMedium = computeTimingEdgeScore({ ...base, high: 0, medium: 10, low: 0 });
        const allLow = computeTimingEdgeScore({ ...base, high: 0, medium: 0, low: 10 });
        expect(allHigh).to.be.greaterThan(allMedium);
        expect(allMedium).to.be.greaterThan(allLow);
    });
});

describe("finalizeStabilityAggregate end-to-end sort", () => {
    it("aggregates age and fresh-hit evidence across reruns instead of keeping the last hit", () => {
        const aggregate = createStabilityAggregate(3, 2, 1, 4);
        addStabilityVerdicts(aggregate, [verdict({
            asset: "SOL", verdict: "LONG", medianBarsHeld: 1, agreementTransition: 1,
        })]);
        addStabilityVerdicts(aggregate, [verdict({
            asset: "SOL", verdict: "LONG", medianBarsHeld: 9, agreementTransition: 0,
        })]);
        addStabilityVerdicts(aggregate, [verdict({
            asset: "SOL", verdict: "LONG", medianBarsHeld: 5, agreementTransition: 1,
        })]);
        addStabilityVerdicts(aggregate, [verdict({
            asset: "SOL", verdict: "LONG", medianBarsHeld: null, agreementTransition: 1,
        })]);

        const row = finalizeStabilityAggregate(aggregate).rows[0]!;
        expect(row.medianBarsHeld).to.equal(5);
        expect(row.agreementTransition).to.equal(1);
        // Unknown age must not inflate actionable fresh-hit evidence.
        expect(row.freshHits).to.equal(1);
    });

    it("ranks a diverse strong-edge row above a repetitive strong-edge row even when the repetitive row has more hits", () => {
        // Row A: 6 hits, every hit from the SAME agreeing pair (pure repetition)
        // Row B: 4 hits, every hit from a DIFFERENT agreeing pair (genuine diverse recurrence)
        // Old `hits → high → lift` ranking put A above B (6 > 4). Score must
        // invert that — repetition is not signal.
        const acc = createStabilityAggregate(10, 50, 1, 100);
        for (let i = 0; i < 6; i += 1) {
            addStabilityVerdicts(acc, [verdict({
                asset: "REPETITIVE",
                verdict: "LONG",
                confidence: "high",
                liftPct: 5,
                mfePct: 6,
                maePct: -1,
                hmaxLiftPct: 4,
                agreeingSymbols: ["BTC+ETH"], // identical every time
            })]);
        }
        for (let i = 0; i < 4; i += 1) {
            addStabilityVerdicts(acc, [verdict({
                asset: "DIVERSE",
                verdict: "LONG",
                confidence: "high",
                liftPct: 5,
                mfePct: 6,
                maePct: -1,
                hmaxLiftPct: 4,
                agreeingSymbols: [`PAIR${i}`], // distinct every time
            })]);
        }
        const result = finalizeStabilityAggregate(acc);
        expect(result.rows[0]!.asset).to.equal("DIVERSE");
        expect(result.rows[1]!.asset).to.equal("REPETITIVE");
        expect(result.rows[0]!.timingEdgeScore).to.be.greaterThan(result.rows[1]!.timingEdgeScore);
        // And the new fields are populated
        expect(result.rows[1]!.medianDiversity).to.equal(0);
        expect(result.rows[0]!.medianDiversity).to.be.greaterThan(0);
        expect(result.rows[1]!.dominantPair).to.equal("BTC+ETH");
        expect(result.rows[1]!.dominantPairShare).to.equal(1);
    });

    it("timingEdgeScore flows through snapshot compaction (4 new fields are not silently dropped)", () => {
        // This is the "DOM checked, settings false" failure mode AGENTS.md
        // warns about for this codebase: any persistence layer that
        // reconstructs the row field-by-field must carry the new fields or
        // they vanish across save/load.
        const acc = createStabilityAggregate(5, 50, 1, 100);
        addStabilityVerdicts(acc, [verdict({
            asset: "X", verdict: "LONG", confidence: "high",
            liftPct: 4, mfePct: 5, maePct: -1, hmaxLiftPct: 3,
            agreeingSymbols: ["A+B"],
        })]);
        addStabilityVerdicts(acc, [verdict({
            asset: "X", verdict: "LONG", confidence: "high",
            liftPct: 4, mfePct: 5, maePct: -1, hmaxLiftPct: 3,
            agreeingSymbols: ["C+D"],
        })]);
        const result = finalizeStabilityAggregate(acc);
        const row = result.rows[0]!;
        expect(row).to.have.property("timingEdgeScore");
        expect(row).to.have.property("medianDiversity");
        expect(row).to.have.property("dominantPair");
        expect(row).to.have.property("dominantPairShare");
        expect(row).to.have.property("asOfTimeKey");
        expect(row).to.have.property("close");
        expect(row).to.have.property("medianBarsHeld");
        expect(row).to.have.property("agreementTransition");
        expect(typeof row.timingEdgeScore).to.equal("number");
        expect(typeof row.medianDiversity).to.equal("number");
        expect(row.asOfTimeKey).to.equal("t");
        expect(row.close).to.equal(100);
        expect(row.medianBarsHeld).to.equal(5);
        expect(row.agreementTransition).to.equal(1);
    });
});
