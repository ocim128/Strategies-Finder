import { expect } from "chai";
import { describe, it } from "node:test";
import {
    classifyConviction,
    isStabilityTargetSuppressed,
    pickStabilityTopTrade,
    projectStabilityTarget,
    stabilityHorizonBars,
} from "../lib/batch-backtest/stability-top-pick";
import type { BatchStabilityRow } from "../lib/batch-backtest/batch-stability-mine";
import type { StabilityActionDecision } from "../lib/batch-backtest/miner-verdict-format-helpers";

/**
 * Top Pick selector tests.
 *
 * Intent being locked (AGENTS.md rule 8 — tests must encode WHY):
 * The user's question is "what is the best trade decision now?", not "which
 * row has the highest research score?". Stability Mine sorts rows by
 * `timingEdgeScore`, which is an edge-quality rank and is blind to (a) whether
 * `computeStabilityAction` actually marks the row as actionable and (b) data
 * freshness. These tests fail if the selector ever stops putting an
 * actionable ENTER above a higher-score non-actionable row, stops breaking
 * score ties in favor of fresher data, or stops downgrading a stale / low-
 * score ENTER to WEAK conviction.
 */

function makeRow(fields: Partial<BatchStabilityRow> = {}): BatchStabilityRow {
    return {
        asset: "TEST",
        direction: "LONG",
        hits: 10,
        high: 10,
        medium: 0,
        low: 0,
        medianRetPct: 5,
        medianLiftPct: 5,
        medianRr: 3,
        medianDist: 1,
        medianHmaxLiftPct: 5,
        pairWarnings: 0,
        timingEdgeScore: 100,
        medianDiversity: 1,
        asOfTimeKey: "t",
        close: 100,
        medianBarsHeld: 6,
        agreementTransition: 1,
        freshHits: 10,
        dominantPair: "BTC+ETH",
        dominantPairShare: 0.5,
        ...fields,
    };
}

function decision(action: StabilityActionDecision["action"], extra: Partial<StabilityActionDecision> = {}): StabilityActionDecision {
    return {
        action,
        reason: "R",
        dataLagBars: 0,
        recurrenceRate: 1,
        freshHitRate: 1,
        ...extra,
    };
}

describe("pickStabilityTopTrade", () => {
    it("returns null on empty input", () => {
        expect(pickStabilityTopTrade([], [])).to.equal(null);
    });

    it("returns null when only REJECT/WAIT/INVALID rows exist", () => {
        const rows = [makeRow({ asset: "A" }), makeRow({ asset: "B" })];
        const decisions = [decision("REJECT"), decision("INVALID")];
        expect(pickStabilityTopTrade(rows, decisions)).to.equal(null);
    });

    it("picks an ENTER over a higher-score WATCH — decision outranks score", () => {
        // The whole point of the selector: a WATCH with a glowing score must
        // not be the "best trade decision" when an ENTER exists. If this test
        // fails the selector has regressed to sorting by score alone.
        const rows = [
            makeRow({ asset: "WATCH-HIGH", timingEdgeScore: 999 }),
            makeRow({ asset: "ENTER-LOW", timingEdgeScore: 10 }),
        ];
        const decisions = [decision("WATCH"), decision("ENTER")];
        const pick = pickStabilityTopTrade(rows, decisions);
        expect(pick).to.not.equal(null);
        expect(pick!.row.asset).to.equal("ENTER-LOW");
        expect(pick!.tier).to.equal("ENTER");
    });

    it("among ENTER rows, picks the highest timingEdgeScore", () => {
        const rows = [
            makeRow({ asset: "LOW", timingEdgeScore: 40 }),
            makeRow({ asset: "HIGH", timingEdgeScore: 90 }),
            makeRow({ asset: "MID", timingEdgeScore: 60 }),
        ];
        const decisions = [decision("ENTER"), decision("ENTER"), decision("ENTER")];
        const pick = pickStabilityTopTrade(rows, decisions);
        expect(pick!.row.asset).to.equal("HIGH");
        expect(pick!.tier).to.equal("ENTER");
    });

    it("breaks score ties in favor of fresher data (lower dataLagBars)", () => {
        // Two ENTERs with identical scores: the fresher one wins. This is the
        // axis timingEdgeScore ignores. If the selector stops considering lag,
        // a stale-data ENTER could be the recommended trade.
        const rows = [
            makeRow({ asset: "STALE", timingEdgeScore: 80 }),
            makeRow({ asset: "FRESH", timingEdgeScore: 80 }),
        ];
        const decisions = [
            decision("ENTER", { dataLagBars: 5 }),
            decision("ENTER", { dataLagBars: 0 }),
        ];
        const pick = pickStabilityTopTrade(rows, decisions);
        expect(pick!.row.asset).to.equal("FRESH");
    });

    it("treats unknown dataLagBars (null) as worst-case when tie-breaking", () => {
        const rows = [
            makeRow({ asset: "UNKNOWN-LAG", timingEdgeScore: 80 }),
            makeRow({ asset: "KNOWN-LAG", timingEdgeScore: 80 }),
        ];
        const decisions = [
            decision("ENTER", { dataLagBars: null }),
            decision("ENTER", { dataLagBars: 100 }),
        ];
        // Even a large-but-known lag beats unknown lag, mirroring the action
        // layer's stance that unknown freshness is not trustworthy.
        const pick = pickStabilityTopTrade(rows, decisions);
        expect(pick!.row.asset).to.equal("KNOWN-LAG");
    });

    it("after score and lag, breaks ties by freshHitRate desc", () => {
        const rows = [
            makeRow({ asset: "LOW-FRESH", timingEdgeScore: 80 }),
            makeRow({ asset: "HIGH-FRESH", timingEdgeScore: 80 }),
        ];
        const decisions = [
            decision("ENTER", { dataLagBars: 1, freshHitRate: 0.2 }),
            decision("ENTER", { dataLagBars: 1, freshHitRate: 0.9 }),
        ];
        expect(pickStabilityTopTrade(rows, decisions)!.row.asset).to.equal("HIGH-FRESH");
    });

    it("after score/lag/freshness, breaks ties by hits desc", () => {
        const rows = [
            makeRow({ asset: "FEW-HITS", timingEdgeScore: 80, hits: 3 }),
            makeRow({ asset: "MANY-HITS", timingEdgeScore: 80, hits: 12 }),
        ];
        const decisions = [
            decision("ENTER", { dataLagBars: 1, freshHitRate: 0.5 }),
            decision("ENTER", { dataLagBars: 1, freshHitRate: 0.5 }),
        ];
        expect(pickStabilityTopTrade(rows, decisions)!.row.asset).to.equal("MANY-HITS");
    });

    it("promotes the best WATCH (tier=WATCH) when no ENTER exists", () => {
        const rows = [
            makeRow({ asset: "WATCH-LOW", timingEdgeScore: 30 }),
            makeRow({ asset: "WATCH-HIGH", timingEdgeScore: 70 }),
            makeRow({ asset: "REJECT-HIGHER", timingEdgeScore: 999 }),
        ];
        const decisions = [decision("WATCH"), decision("WATCH"), decision("REJECT")];
        const pick = pickStabilityTopTrade(rows, decisions);
        expect(pick!.row.asset).to.equal("WATCH-HIGH");
        expect(pick!.tier).to.equal("WATCH");
    });

    it("is deterministic under equal-everything ties (stable asset|direction order)", () => {
        const rows = [
            makeRow({ asset: "ZETA", timingEdgeScore: 80, direction: "LONG" }),
            makeRow({ asset: "ALPHA", timingEdgeScore: 80, direction: "LONG" }),
        ];
        const decisions = [decision("ENTER"), decision("ENTER")];
        // Same score, same lag, same freshness, same hits — fall back to the
        // asset|direction key so the pick is stable across runs, not whichever
        // happened to come first in the array.
        expect(pickStabilityTopTrade(rows, decisions)!.row.asset).to.equal("ALPHA");
    });

    it("truncates to the shorter of rows/decisions without throwing", () => {
        // Defensive: renderer parallel arrays should always match length, but
        // a mismatched pair must not crash the render path.
        const rows = [makeRow({ asset: "A" }), makeRow({ asset: "B" })];
        const decisions = [decision("ENTER")];
        const pick = pickStabilityTopTrade(rows, decisions);
        expect(pick!.row.asset).to.equal("A");
    });
});

describe("classifyConviction", () => {
    // The real run that motivated this: a 6.0-score, 271-bar-stale, 0-fresh
    // ENTER badged green as TOP PICK. STRONG must require score, freshness,
    // AND non-stale age — anything less is WEAK (a stand-aside candidate).

    it("STRONG: high-score, fresh-hit, non-stale ENTER", () => {
        const row = makeRow({ timingEdgeScore: 80, freshHits: 5, medianBarsHeld: 6 });
        expect(classifyConviction(row, "ENTER")).to.equal("STRONG");
    });

    it("WEAK: ENTER below the score floor (< 20)", () => {
        const row = makeRow({ timingEdgeScore: 6, freshHits: 5, medianBarsHeld: 6 });
        expect(classifyConviction(row, "ENTER")).to.equal("WEAK");
    });

    it("WEAK: ENTER with zero fresh hits (pure historical continuation)", () => {
        const row = makeRow({ timingEdgeScore: 80, freshHits: 0, medianBarsHeld: 6 });
        expect(classifyConviction(row, "ENTER")).to.equal("WEAK");
    });

    it("WEAK: ENTER whose analog state is stale (medianBarsHeld >= 50)", () => {
        // The exact ZEC case from the real run: 271-bar-stale continuation.
        const row = makeRow({ timingEdgeScore: 80, freshHits: 5, medianBarsHeld: 271 });
        expect(classifyConviction(row, "ENTER")).to.equal("WEAK");
    });

    it("WEAK: WATCH is never STRONG, regardless of score / freshness", () => {
        // A promoted WATCH is by definition "not yet actionable" — it cannot
        // badge green even if its research score is glowing.
        const row = makeRow({ timingEdgeScore: 90, freshHits: 10, medianBarsHeld: 2 });
        expect(classifyConviction(row, "WATCH")).to.equal("WEAK");
    });

    it("conviction is attached to the pick, derived from the chosen row", () => {
        // End-to-end: the picker must populate `conviction`, not just tier.
        const rows = [makeRow({ timingEdgeScore: 6, freshHits: 0, medianBarsHeld: 271 })];
        const decisions = [decision("ENTER")];
        const pick = pickStabilityTopTrade(rows, decisions);
        expect(pick!.conviction).to.equal("WEAK");
    });

    it("WATCH and WEAK-ENTER are distinguishable combinations (renderer contract)", () => {
        // The renderer treats WATCH and WEAK as mutually exclusive classes
        // (a WATCH pick is always WEAK conviction, but the WATCH label must
        // win so the user sees "not yet actionable", not "stand-aside
        // candidate"). This test pins the two distinct (tier, conviction)
        // combinations the renderer branches on — if they collapse, the
        // renderer's else-if becomes dead.
        const watchPick = pickStabilityTopTrade(
            [makeRow({ asset: "W", timingEdgeScore: 50 })],
            [decision("WATCH")],
        );
        const weakEnterPick = pickStabilityTopTrade(
            [makeRow({ asset: "E", timingEdgeScore: 6, medianBarsHeld: 271, freshHits: 0 })],
            [decision("ENTER")],
        );
        expect(watchPick!.tier).to.equal("WATCH");
        expect(watchPick!.conviction).to.equal("WEAK");
        expect(weakEnterPick!.tier).to.equal("ENTER");
        expect(weakEnterPick!.conviction).to.equal("WEAK");
    });
});

describe("projectStabilityTarget", () => {
    it("projects a LONG target above the close using medianRetPct", () => {
        expect(projectStabilityTarget(makeRow({ direction: "LONG", close: 100, medianRetPct: 5 })))
            .to.equal(105);
    });

    it("projects a SHORT target below the close using medianRetPct", () => {
        expect(projectStabilityTarget(makeRow({ direction: "SHORT", close: 200, medianRetPct: 4 })))
            .to.equal(192);
    });

    it("is symmetric — LONG +ret and SHORT +ret move the price in opposite directions", () => {
        const longT = projectStabilityTarget(makeRow({ direction: "LONG", close: 100, medianRetPct: 5 }));
        const shortT = projectStabilityTarget(makeRow({ direction: "SHORT", close: 100, medianRetPct: 5 }));
        // LONG: 105, SHORT: 95 — symmetric around the close. Encoding this so a
        // sign-flip regression in either branch is caught.
        expect(longT + shortT).to.equal(200);
    });

    it("returns null when close is null", () => {
        expect(projectStabilityTarget(makeRow({ close: null, medianRetPct: 5 }))).to.equal(null);
    });

    it("returns null when medianRetPct is null", () => {
        expect(projectStabilityTarget(makeRow({ close: 100, medianRetPct: null }))).to.equal(null);
    });

    it("returns null when close is non-positive", () => {
        expect(projectStabilityTarget(makeRow({ close: 0, medianRetPct: 5 }))).to.equal(null);
    });

    it("returns null when medianRetPct is non-finite", () => {
        expect(projectStabilityTarget(makeRow({ close: 100, medianRetPct: Number.NaN }))).to.equal(null);
    });

    it("supports negative medianRetPct (target below close for LONG)", () => {
        // A bearish analog edge projects a downward LONG target — the math is
        // pure, the action layer decides whether such a row is ENTER at all.
        expect(projectStabilityTarget(makeRow({ direction: "LONG", close: 100, medianRetPct: -3 })))
            .to.equal(97);
    });
});

describe("isStabilityTargetSuppressed", () => {
    // The real-run gap: projecting >881.87@271b from a 271-bar-stale state
    // overstates conviction. The renderer uses this to show "-- (stale analog)"
    // instead of a misleading price level.

    it("returns false for a fresh analog (medianBarsHeld < 50)", () => {
        expect(isStabilityTargetSuppressed(makeRow({ medianBarsHeld: 6 }))).to.equal(false);
    });

    it("returns true at the stale threshold (medianBarsHeld >= 50)", () => {
        expect(isStabilityTargetSuppressed(makeRow({ medianBarsHeld: 50 }))).to.equal(true);
        expect(isStabilityTargetSuppressed(makeRow({ medianBarsHeld: 271 }))).to.equal(true);
    });

    it("returns false when age cannot be computed (not stale by default)", () => {
        expect(isStabilityTargetSuppressed(makeRow({ medianBarsHeld: null, agreementTransition: null })))
            .to.equal(false);
    });
});

describe("stabilityHorizonBars", () => {
    it("rounds the median hold horizon to whole bars", () => {
        expect(stabilityHorizonBars(makeRow({ medianBarsHeld: 6.4 }))).to.equal(6);
        expect(stabilityHorizonBars(makeRow({ medianBarsHeld: 6.6 }))).to.equal(7);
    });

    it("returns null when medianBarsHeld is missing or non-finite", () => {
        expect(stabilityHorizonBars(makeRow({ medianBarsHeld: null }))).to.equal(null);
        expect(stabilityHorizonBars(makeRow({ medianBarsHeld: Number.NaN }))).to.equal(null);
    });

    it("clamps negative horizons to zero", () => {
        expect(stabilityHorizonBars(makeRow({ medianBarsHeld: -2 }))).to.equal(0);
    });
});
