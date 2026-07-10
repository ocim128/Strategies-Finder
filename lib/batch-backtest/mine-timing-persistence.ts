/**
 * Persistence shape for Mine Timing verdicts.
 *
 * The Assets tab (Asset Leadership) consumes these to rank assets by timing
 * edge instead of by Finder Universe breadth. This module is a leaf — it has
 * no runtime dependencies on the heavy service module — so it can be imported
 * from both the browser-side service AND the server-side Vite plugin without
 * tripping the ESM-only `lightweight-charts` bundle trap (see AGENTS.md
 * "Server-side import hygiene").
 *
 * Contract rule (AGENTS.md "Server-Side Batch Backtest"): the on-the-wire
 * shape must be SCALAR-ONLY. No arrays except the top-level `verdicts`. No
 * nested objects beyond what's explicitly typed below. The plugin mirrors
 * each field into its own column.
 */

import type { BatchSyntheticAssetVerdict } from "./batch-synthetic-state-miner";
import type { BatchStabilityRow } from "./batch-stability-mine";

export type MineTimingSource = "mine" | "stability";

export interface TimingEdgeVerdictSnapshot {
    asset: string;
    verdict: string;
    direction: string | null;
    confidence: string;
    close: number | null;
    medianBarsHeld: number | null;
    agreementTransition: number | null;
    asOfTimeKey: string | null;
    horizonBars: number | null;
    longestHorizonBars: number | null;
    expectedForwardReturnPct: number | null;
    oosLiftPct: number | null;
    longestOosForwardReturnPct: number | null;
    expectedMfePct: number | null;
    expectedMaePct: number | null;
    analogCount: number | null;
    candidateCount: number | null;
    pairWarnings: number;
    // Stability-only fields (0 / null for one-shot Mine runs)
    timingEdgeScore: number;
    medianDiversity: number;
    dominantPair: string | null;
    dominantPairShare: number;
    hits: number;
    high: number;
    medium: number;
    low: number;
    medianLiftPct: number | null;
    medianRr: number | null;
    medianHmaxLiftPct: number | null;
    medianDist: number | null;
}

export interface TimingEdgePersistedRun {
    runId: string;
    createdAt: number;
    interval: string;
    strategyKey: string;
    source: MineTimingSource;
    pairCount: number;
    /** Stability-only. 0 for one-shot Mine. */
    reruns: number;
    /** Stability-only. 0 for one-shot Mine. */
    subsetSize: number;
    /** Stability-only. 0 for one-shot Mine. */
    seed: number;
    verdicts: TimingEdgeVerdictSnapshot[];
}

/**
 * Project a one-shot Mine Timing result into the persisted verdict shape.
 * Stability-only fields default to 0/null because a single Mine run has no
 * rerun aggregation, no diversity computation, and no "hits" — it produces one
 * verdict per asset.
 */
export function projectMineVerdictToSnapshot(
    verdict: BatchSyntheticAssetVerdict,
): TimingEdgeVerdictSnapshot {
    const evidence = verdict.evidence;
    const snapshot = verdict.currentSnapshot;
    return {
        asset: verdict.asset,
        verdict: verdict.verdict,
        direction: verdict.direction,
        confidence: verdict.confidence,
        close: snapshot?.close ?? null,
        medianBarsHeld: snapshot?.medianBarsHeld ?? null,
        agreementTransition: snapshot?.agreementTransition ?? null,
        asOfTimeKey: snapshot?.timeKey ?? null,
        horizonBars: evidence.horizonBars,
        longestHorizonBars: evidence.longestHorizonBars,
        expectedForwardReturnPct: evidence.expectedForwardReturnPct,
        oosLiftPct: evidence.oosLiftPct,
        longestOosForwardReturnPct: evidence.longestOosForwardReturnPct,
        expectedMfePct: evidence.expectedMfePct,
        expectedMaePct: evidence.expectedMaePct,
        analogCount: evidence.analogCount,
        candidateCount: evidence.candidateCount,
        pairWarnings: verdict.pairContributions
            .filter((entry) => entry.label === "dominating" || entry.label === "harmful" || entry.label === "opposing")
            .length,
        timingEdgeScore: 0,
        medianDiversity: 0,
        dominantPair: null,
        dominantPairShare: 0,
        hits: verdict.verdict === "LONG" || verdict.verdict === "SHORT" ? 1 : 0,
        high: verdict.confidence === "high" && (verdict.verdict === "LONG" || verdict.verdict === "SHORT") ? 1 : 0,
        medium: verdict.confidence === "medium" && (verdict.verdict === "LONG" || verdict.verdict === "SHORT") ? 1 : 0,
        low: verdict.confidence === "low" && (verdict.verdict === "LONG" || verdict.verdict === "SHORT") ? 1 : 0,
        medianLiftPct: evidence.oosLiftPct,
        medianRr: null,
        medianHmaxLiftPct: evidence.longestOosLiftPct,
        medianDist: evidence.avgDistance,
    };
}

/**
 * Project a Stability Mine row into the same persisted verdict shape. The
 * Stability aggregator already computed every cross-rerun field, so this is
 * mostly a 1:1 copy. Used so both sources share one schema and one Assets-tab
 * rendering path.
 */
export function projectStabilityRowToSnapshot(row: BatchStabilityRow): TimingEdgeVerdictSnapshot {
    return {
        asset: row.asset,
        verdict: row.direction,
        direction: row.direction.toLowerCase(),
        confidence: row.high > 0 ? "high" : row.medium > 0 ? "medium" : "low",
        close: row.close,
        medianBarsHeld: row.medianBarsHeld,
        agreementTransition: row.agreementTransition,
        asOfTimeKey: row.asOfTimeKey,
        horizonBars: null,
        longestHorizonBars: null,
        expectedForwardReturnPct: row.medianRetPct,
        oosLiftPct: row.medianLiftPct,
        longestOosForwardReturnPct: null,
        expectedMfePct: null,
        expectedMaePct: null,
        analogCount: null,
        candidateCount: null,
        pairWarnings: row.pairWarnings,
        timingEdgeScore: row.timingEdgeScore,
        medianDiversity: row.medianDiversity,
        dominantPair: row.dominantPair,
        dominantPairShare: row.dominantPairShare,
        hits: row.hits,
        high: row.high,
        medium: row.medium,
        low: row.low,
        medianLiftPct: row.medianLiftPct,
        medianRr: row.medianRr,
        medianHmaxLiftPct: row.medianHmaxLiftPct,
        medianDist: row.medianDist,
    };
}
