import { expect } from "chai";
import { describe, it } from "node:test";
import {
    computeMinerAgeTag,
    computeMinerTargetPrice,
    formatTargetPrice,
} from "../lib/batch-backtest/miner-verdict-format-helpers";
import type { BatchSyntheticAssetVerdict } from "../lib/batch-backtest/batch-synthetic-state-miner";

/**
 * Mine Timing row enrichment helpers.
 *
 * Intent being locked (AGENTS.md rule 8): the Mine Timing row must surface
 * "when the signal showed", "entry", and "exit recommendation" as one-glance
 * tags instead of forcing the user to read 6 numeric columns and do the
 * arithmetic in their head. These helpers exist for presentation, not for
 * decision logic — the verdict engine itself is unchanged. Tests fail if the
 * tags stop mapping to the underlying snapshot/evidence in the obvious way.
 */

function makeVerdict(args: {
    direction?: "long" | "short" | null;
    close?: number | null;
    medianBarsHeld?: number | null;
    agreementTransition?: number;
    longestOosForwardReturnPct?: number | null;
    longestHorizonBars?: number | null;
}): BatchSyntheticAssetVerdict {
    return {
        asset: "TEST",
        verdict: args.direction === "short" ? "SHORT" : "LONG",
        direction: args.direction === null ? null : (args.direction ?? "long"),
        confidence: "medium",
        currentSnapshot: {
            asset: "TEST",
            direction: args.direction === "short" ? "short" : (args.direction ?? "long"),
            timeKey: "t",
            barIndex: 100,
            close: args.close === undefined ? 100 : args.close,
            activePeerCount: 4,
            agreementCount: 4,
            oppositionCount: 0,
            agreementRatio: 1,
            oppositionRatio: 0,
            netAgreement: 4,
            agreementTransition: args.agreementTransition ?? 1,
            medianBarsHeld: args.medianBarsHeld === undefined ? 5 : args.medianBarsHeld,
            medianMoveSinceEntryPct: 1,
            medianMoveSinceEntryAtr: 1,
            medianAdverseExcursionAtr: -0.5,
            breadthPersistence: 3,
            agreeingSymbols: ["BTC+ETH"],
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
            selectionForwardReturnPct: 2,
            selectionMfePct: 3,
            selectionMaePct: -1,
            expectedForwardReturnPct: 2,
            expectedMfePct: 3,
            expectedMaePct: -1,
            baselineOosReturnPct: 0,
            oosLiftPct: 2,
            longestHorizonBars: args.longestHorizonBars === undefined ? 24 : args.longestHorizonBars,
            longestOosForwardReturnPct: args.longestOosForwardReturnPct === undefined ? 5 : args.longestOosForwardReturnPct,
            longestOosLiftPct: 4,
        },
        pairContributions: [],
        reasons: [],
        diagnostics: [],
    };
}

describe("computeMinerAgeTag", () => {
    it("returns '--' when there is no current snapshot", () => {
        const verdict = makeVerdict({});
        verdict.currentSnapshot = null;
        expect(computeMinerAgeTag(verdict)).to.equal("--");
    });

    it("returns 'Fresh' for a newly-emerged trigger (positive transition, ≤ 3 bars held)", () => {
        expect(computeMinerAgeTag(makeVerdict({ agreementTransition: 2, medianBarsHeld: 0 }))).to.equal("Fresh");
        expect(computeMinerAgeTag(makeVerdict({ agreementTransition: 1, medianBarsHeld: 3 }))).to.equal("Fresh");
    });

    it("returns 'Stale' for long carry-in (≥ 50 bars held) — the survivor-bias case flagged in AGENTS.md", () => {
        expect(computeMinerAgeTag(makeVerdict({ medianBarsHeld: 50 }))).to.equal("Stale");
        expect(computeMinerAgeTag(makeVerdict({ medianBarsHeld: 200, agreementTransition: 5 }))).to.equal("Stale");
    });

    it("returns 'Aging' for the typical mid-life state (positive transition but barsHeld in the strategy-hold band)", () => {
        // 4H median hold is ~5-20 bars. A fresh-enough trigger at 10 bars held is mid-life, not Fresh and not Stale.
        expect(computeMinerAgeTag(makeVerdict({ agreementTransition: 1, medianBarsHeld: 10 }))).to.equal("Aging");
        expect(computeMinerAgeTag(makeVerdict({ agreementTransition: 0, medianBarsHeld: 20 }))).to.equal("Aging");
    });

    it("returns 'Aging' (not 'Fresh') when transition is 0 even with low carry-in", () => {
        // A carry-in with no recent state change isn't a fresh trigger.
        expect(computeMinerAgeTag(makeVerdict({ agreementTransition: 0, medianBarsHeld: 2 }))).to.equal("Aging");
    });
});

describe("computeMinerTargetPrice", () => {
    it("returns null when direction is null", () => {
        expect(computeMinerTargetPrice(makeVerdict({ direction: null, close: 100, longestOosForwardReturnPct: 5 }))).to.equal(null);
    });

    it("returns null when close is missing or non-positive", () => {
        expect(computeMinerTargetPrice(makeVerdict({ close: null, longestOosForwardReturnPct: 5 }))).to.equal(null);
        expect(computeMinerTargetPrice(makeVerdict({ close: 0, longestOosForwardReturnPct: 5 }))).to.equal(null);
    });

    it("returns null when longest-horizon return is null", () => {
        expect(computeMinerTargetPrice(makeVerdict({ close: 100, longestOosForwardReturnPct: null }))).to.equal(null);
    });

    it("scales the close up by the longest-horizon OOS return for a long verdict", () => {
        // Symmetric to invalidation price (which uses MAE). A 5% longest-horizon
        // forward return on a $100 close projects a $105 target.
        expect(computeMinerTargetPrice(makeVerdict({ direction: "long", close: 100, longestOosForwardReturnPct: 5 }))).to.be.closeTo(105, 1e-9);
    });

    it("scales the close DOWN by the longest-horizon OOS return for a short verdict", () => {
        // For shorts the favorable direction is down, so a +5% forward-return
        // (already direction-adjusted by the miner) projects a $95 target.
        expect(computeMinerTargetPrice(makeVerdict({ direction: "short", close: 100, longestOosForwardReturnPct: 5 }))).to.be.closeTo(95, 1e-9);
    });
});

describe("formatTargetPrice", () => {
    const fmt = (v: number | null | undefined): string => v?.toFixed(2) ?? "--";

    it("returns '--' when any required input is missing", () => {
        expect(formatTargetPrice(null, 100, 24, fmt)).to.equal("--");
        expect(formatTargetPrice("long", null, 24, fmt)).to.equal("--");
        expect(formatTargetPrice("long", 100, null, fmt)).to.equal("--");
        expect(formatTargetPrice("long", Number.NaN, 24, fmt)).to.equal("--");
    });

    it("uses '>' comparator for longs and includes the horizon window", () => {
        // The horizon is part of the recommendation — "target X @ 48b" tells
        // the user both the level AND the time window.
        expect(formatTargetPrice("long", 105, 48, fmt)).to.equal(">105.00@48b");
    });

    it("uses '<' comparator for shorts", () => {
        expect(formatTargetPrice("short", 95, 24, fmt)).to.equal("<95.00@24b");
    });
});
