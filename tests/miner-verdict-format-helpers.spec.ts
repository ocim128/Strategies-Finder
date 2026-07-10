import { expect } from "chai";
import { describe, it } from "node:test";
import {
    computeMinerAgeTag,
    computeMinerTargetPrice,
    computeStabilityAction,
    computeStabilityAgeTag,
    computeStabilityGate,
    formatTargetPrice,
    STABILITY_DATA_STALE_THRESHOLD_BARS,
    summarizeStabilityDataFreshness,
} from "../lib/batch-backtest/miner-verdict-format-helpers";
import type { BatchStabilityRow } from "../lib/batch-backtest/batch-stability-mine";
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

function makeStabilityRow(fields: Partial<BatchStabilityRow> = {}): BatchStabilityRow {
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
        medianBarsHeld: 2,
        agreementTransition: 1,
        freshHits: 10,
        dominantPair: "BTC+ETH",
        dominantPairShare: 0.5,
        ...fields,
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

    it("does not call an unknown carry-in age Fresh", () => {
        expect(computeMinerAgeTag(makeVerdict({ agreementTransition: 1, medianBarsHeld: null }))).to.equal("Aging");
    });
});

describe("Stability copy diagnostics", () => {
    it("labels current-state age without claiming it is the cross-run first-seen time", () => {
        expect(computeStabilityAgeTag(makeStabilityRow())).to.equal("Fresh");
        expect(computeStabilityAgeTag(makeStabilityRow({ medianBarsHeld: 12 }))).to.equal("Aging");
        expect(computeStabilityAgeTag(makeStabilityRow({ medianBarsHeld: 50 }))).to.equal("Stale");
        expect(computeStabilityAgeTag(makeStabilityRow({ medianBarsHeld: null, agreementTransition: null }))).to.equal("--");
        expect(computeStabilityAgeTag(makeStabilityRow({ medianBarsHeld: null, agreementTransition: 1 }))).to.equal("Aging");
    });

    it("explains zero scores caused by repeated evidence or excessive pair warnings", () => {
        expect(computeStabilityGate(makeStabilityRow({ timingEdgeScore: 0, medianDiversity: 0 }))).to.equal("REPEAT");
        expect(computeStabilityGate(makeStabilityRow({ timingEdgeScore: 0, pairWarnings: 20 }))).to.equal("PAIR_WARN");
    });

    it("keeps a positive score visibly tradeable", () => {
        expect(computeStabilityGate(makeStabilityRow({ timingEdgeScore: 42 }))).to.equal("PASS");
    });

    it("separates evidence quality from an actionable fresh entry", () => {
        const nowMs = 1_700_003_600_000;
        const decision = computeStabilityAction(makeStabilityRow({
            asOfTimeKey: "1700000000",
            hits: 10,
            freshHits: 8,
        }), 50, "1h", nowMs);
        expect(decision.action).to.equal("ENTER");
        expect(decision.reason).to.equal("FRESH_STABLE");
    });

    it("invalidates stale data even when the historical evidence score passes", () => {
        const decision = computeStabilityAction(makeStabilityRow({
            asOfTimeKey: "1700000000",
        }), 50, "1h", 1_700_036_000_000);
        expect(decision.action).to.equal("INVALID");
        expect(decision.reason).to.equal("DATA_STALE");
        expect(decision.dataLagBars).to.equal(10);
    });

    it("watches sparse recurrence and waits on an old state", () => {
        const nowMs = 1_700_003_600_000;
        const sparse = computeStabilityAction(makeStabilityRow({
            asOfTimeKey: "1700000000",
            hits: 4,
            freshHits: 4,
        }), 50, "1h", nowMs);
        expect(sparse.action).to.equal("WATCH");
        expect(sparse.reason).to.equal("LOW_RECURRENCE");

        const old = computeStabilityAction(makeStabilityRow({
            asOfTimeKey: "1700000000",
            medianBarsHeld: 80,
            freshHits: 0,
        }), 50, "1h", nowMs);
        expect(old.action).to.equal("WAIT");
        expect(old.reason).to.equal("OLD_STATE");
    });

    it("rejects failed evidence before considering timing", () => {
        const decision = computeStabilityAction(makeStabilityRow({
            timingEdgeScore: 0,
            medianDiversity: 0,
            asOfTimeKey: "1700000000",
        }), 50, "1h", 1_700_003_600_000);
        expect(decision.action).to.equal("REJECT");
        expect(decision.reason).to.equal("REPEAT");
    });
});

describe("summarizeStabilityDataFreshness", () => {
    // Intent (AGENTS.md rule 8): a stale OHLCV feed vetoes every per-row Action
    // (`computeStabilityAction` returns INVALID | DATA_STALE), which on a stale
    // feed makes the whole run look like an algorithm failure. This summary
    // surfaces the data-feed cause once at the run level. The run is STALE when
    // ANY row exceeds the per-row veto threshold — one stale asset means the
    // feed stopped, so the run-level verdict must be pessimistic.

    it("flags STALE when any row's lag exceeds the threshold (1h interval)", () => {
        // nowMs = 1_700_036_000_000 ms = 1_700_036_000 s; asOf 1_700_000_000 s
        // → delta 36_000 s = 10h = 10 bars on 1h (> threshold of 2 → STALE)
        const summary = summarizeStabilityDataFreshness(
            [{ asOfTimeKey: "1700000000" }, { asOfTimeKey: "1700000000" }],
            "1h",
            1_700_036_000_000,
        );
        expect(summary.status).to.equal("STALE");
        expect(summary.maxLagBars).to.equal(10);
        expect(summary.staleCount).to.equal(2);
        expect(summary.freshCount).to.equal(0);
        expect(summary.text).to.contain("STALE");
        expect(summary.text).to.contain("2/2");
    });

    it("flags FRESH when every row's lag is within the threshold", () => {
        // nowMs = 1_700_003_600_000 ; asOf 1_700_000_000 is 1h = 1 bar on 1h
        const summary = summarizeStabilityDataFreshness(
            [{ asOfTimeKey: "1700000000" }, { asOfTimeKey: "1700000000" }],
            "1h",
            1_700_003_600_000,
        );
        expect(summary.status).to.equal("FRESH");
        expect(summary.maxLagBars).to.equal(1);
        expect(summary.staleCount).to.equal(0);
        expect(summary.freshCount).to.equal(2);
        expect(summary.text).to.contain("fresh");
    });

    it("treats a row exactly at the threshold as FRESH (veto is strictly greater-than)", () => {
        // `computeStabilityAction` vetoes when lag > 2, so lag == 2 must be FRESH
        // here too — otherwise the run banner would contradict the per-row action.
        // nowMs chosen so asOf 1_700_000_000 is exactly 2 bars on 1h.
        const summary = summarizeStabilityDataFreshness(
            [{ asOfTimeKey: "1700000000" }],
            "1h",
            1_700_007_200_000,
        );
        expect(summary.maxLagBars).to.equal(2);
        expect(summary.status).to.equal("FRESH");
    });

    it("returns UNKNOWN when every row's AsOf is null or unparseable", () => {
        const summary = summarizeStabilityDataFreshness(
            [{ asOfTimeKey: null }, { asOfTimeKey: "not-a-time" }],
            "1h",
            1_700_003_600_000,
        );
        expect(summary.status).to.equal("UNKNOWN");
        expect(summary.maxLagBars).to.equal(null);
        expect(summary.unknownCount).to.equal(2);
        expect(summary.text).to.contain("UNKNOWN");
    });

    it("flags STALE on a mixed set (one stale + one fresh)", () => {
        const staleAsOf = "1700000000"; // 100h old
        const freshAsOf = String(1_700_035_900_000 / 1000); // <1 bar old
        const summary = summarizeStabilityDataFreshness(
            [{ asOfTimeKey: staleAsOf }, { asOfTimeKey: freshAsOf }],
            "1h",
            1_700_036_000_000,
        );
        expect(summary.status).to.equal("STALE");
        expect(summary.staleCount).to.equal(1);
        expect(summary.freshCount).to.equal(1);
    });

    it("does not label a partially unparseable run FRESH", () => {
        const summary = summarizeStabilityDataFreshness(
            [{ asOfTimeKey: "1700000000" }, { asOfTimeKey: null }],
            "1h",
            1_700_003_600_000,
        );
        expect(summary.status).to.equal("UNKNOWN");
        expect(summary.freshCount).to.equal(1);
        expect(summary.unknownCount).to.equal(1);
    });

    it("exposes the threshold the run-level verdict shares with the per-row veto", () => {
        // Lock the contract: run-level STALE and per-row INVALID | DATA_STALE
        // must use the same threshold, otherwise the banner and the row Actions
        // would disagree on the boundary.
        expect(STABILITY_DATA_STALE_THRESHOLD_BARS).to.equal(2);
    });

    it("handles an empty row set as FRESH (nothing to be stale, no spurious warning)", () => {
        const summary = summarizeStabilityDataFreshness([], "1h", 1_700_003_600_000);
        expect(summary.total).to.equal(0);
        expect(summary.status).to.equal("FRESH");
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
