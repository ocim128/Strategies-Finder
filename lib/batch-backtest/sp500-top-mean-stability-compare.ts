import type { CurrentTopMeanSnapshot, CurrentTopMeanStats } from "./sp500-top-mean-current-snapshot";

/**
 * Phase-2 gate comparison: does `TOP_MEAN NOW` pick the same winner(s) across
 * different simulation start dates?
 *
 * This is the gate for continuation parity (Phase 2 incremental checkpoints).
 * If the open position at the latest candle is invariant to simulation origin,
 * then serializing strategy state at T-1 + feeding candle T will reproduce the
 * full-history snapshot — which is exactly what Phase 2 assumes. If the
 * winners diverge across windows, the strategy is path-dependent for this
 * config and Phase 2 is blocked until the path-dependence is fixed.
 *
 * Pure, server-safe leaf (no `lightweight-charts`). Operives entirely on the
 * snapshot structures produced by `computeCurrentTopMeanSnapshot`.
 */

export interface StabilityWindowResult {
    /** Unix seconds of the window's start date, or null for "full history". */
    startDateSec: number | null;
    /** Human label, e.g. "Full" or "2023-01-01". */
    label: string;
    snapshot: CurrentTopMeanSnapshot;
    stats: CurrentTopMeanStats;
}

export interface StabilityComparison {
    windows: StabilityWindowResult[];
    /** Winner asset sets per window, parallel to `windows`. */
    winnerAssetsByWindow: string[][];
    /**
     * Assets that are winners in EVERY window. Empty if any window had no
     * winners or if the winner sets disagree.
     */
    commonWinners: string[];
    /** Assets that are a winner in at least one window. */
    unionWinners: string[];
    /**
     * |commonWinners| / |unionWinners| as a percentage (0-100). 100 means
     * every window picked exactly the same set. 0 when the union is empty.
     */
    agreementPct: number;
    /** True if any window's winner set differs from window[0]'s. */
    divergentWindows: boolean;
    /**
     * Max |mean(asset, windowA) - mean(asset, windowB)| across windows for
     * assets present as candidates in all windows. 0 when there is exact
     * agreement or fewer than 2 windows. Detects "same winner but drifting
     * score" cases that a pure set comparison misses.
     */
    maxMeanDrift: number;
    /**
     * Phase-2 gate verdict. True only when >=2 windows ALL agree on the winner
     * set (agreementPct === 100, no divergence). False otherwise, including
     * the single-window case (cannot assess stability from one data point).
     */
    parityAssumptionHolds: boolean;
    reportLines: string[];
}

/** Human label for a window's start date: "Full" for null, else YYYY-MM-DD. */
export function formatStartDateLabel(startDateSec: number | null): string {
    if (startDateSec === null) return "Full";
    return new Date(startDateSec * 1000).toISOString().slice(0, 10);
}

function formatAsOf(asOf: number | null): string {
    if (asOf === null) return "no common endpoint";
    return new Date(asOf * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function meanForAsset(snapshot: CurrentTopMeanSnapshot, asset: string): number | null {
    for (const c of snapshot.candidates) {
        if (c.asset === asset) return c.mean;
    }
    return null;
}

/**
 * Compute the stability comparison across N window snapshots.
 *
 * Degenerate cases:
 *   - 0 windows: returns an empty comparison, parityAssumptionHolds=false
 *     (cannot assess stability from nothing).
 *   - 1 window: returns that window's data, parityAssumptionHolds=false
 *     (cannot assess stability from a single data point — the user must run
 *     >=2 windows for the gate to be meaningful).
 *   - any window with reason "no_common_endpoint" / "empty" / etc. (no
 *     winners): treated as a divergence (that window contributed nothing).
 */
export function compareStabilitySnapshots(windows: StabilityWindowResult[]): StabilityComparison {
    const winnerAssetsByWindow = windows.map((w) => w.snapshot.winners.map((x) => x.asset));
    const unionWinners = Array.from(new Set(winnerAssetsByWindow.flat())).sort();

    // commonWinners = intersection of every window's winner set.
    let commonWinners: string[];
    if (windows.length === 0 || winnerAssetsByWindow.some((s) => s.length === 0)) {
        // Any window with no winners means the intersection is empty.
        commonWinners = [];
    } else {
        commonWinners = unionWinners.filter((asset) =>
            winnerAssetsByWindow.every((set) => set.includes(asset)),
        );
    }

    const agreementPct = unionWinners.length > 0
        ? (commonWinners.length / unionWinners.length) * 100
        : 0;

    const firstSet = winnerAssetsByWindow[0] ?? [];
    const divergentWindows = windows.length > 1 && winnerAssetsByWindow.some((set) => {
        if (set.length !== firstSet.length) return true;
        const sorted = [...set].sort();
        const sortedFirst = [...firstSet].sort();
        return sorted.some((a, i) => a !== sortedFirst[i]);
    });

    // maxMeanDrift: across assets present as candidates in ALL windows, the
    // largest absolute mean difference between any two windows.
    let maxMeanDrift = 0;
    if (windows.length >= 2) {
        const candidateSets = windows.map((w) => new Set(w.snapshot.candidates.map((c) => c.asset)));
        const candidateUnion = Array.from(new Set(
            windows.flatMap((w) => w.snapshot.candidates.map((c) => c.asset)),
        ));
        const commonCandidates = candidateUnion.filter((asset) =>
            candidateSets.every((set) => set.has(asset)),
        );
        for (const asset of commonCandidates) {
            const means = windows.map((w) => meanForAsset(w.snapshot, asset));
            const finiteMeans = means.filter((m): m is number => m !== null && Number.isFinite(m));
            if (finiteMeans.length < 2) continue;
            const lo = Math.min(...finiteMeans);
            const hi = Math.max(...finiteMeans);
            const drift = hi - lo;
            if (drift > maxMeanDrift) maxMeanDrift = drift;
        }
    }

    // Phase-2 gate: requires >=2 windows AND full agreement.
    const parityAssumptionHolds = windows.length >= 2
        && !divergentWindows
        && agreementPct === 100
        && commonWinners.length > 0;

    return {
        windows,
        winnerAssetsByWindow,
        commonWinners,
        unionWinners,
        agreementPct,
        divergentWindows,
        maxMeanDrift,
        parityAssumptionHolds,
        reportLines: buildStabilityReportLines({
            windows,
            winnerAssetsByWindow,
            commonWinners,
            unionWinners,
            agreementPct,
            divergentWindows,
            maxMeanDrift,
            parityAssumptionHolds,
        }),
    };
}

function buildStabilityReportLines(c: {
    windows: StabilityWindowResult[];
    winnerAssetsByWindow: string[][];
    commonWinners: string[];
    unionWinners: string[];
    agreementPct: number;
    divergentWindows: boolean;
    maxMeanDrift: number;
    parityAssumptionHolds: boolean;
}): string[] {
    const lines: string[] = [];
    lines.push("----------------------------------------------------------------------");
    lines.push("STABILITY | TOP_MEAN NOW across start dates (Phase-2 continuation-parity gate)");
    lines.push("----------------------------------------------------------------------");
    if (c.windows.length === 0) {
        lines.push("STABILITY | NO WINDOWS | cannot assess stability");
        return lines;
    }
    lines.push(`STABILITY | windows=${c.windows.length} | agreementPct=${c.agreementPct.toFixed(1)} | divergent=${c.divergentWindows} | maxMeanDrift=${c.maxMeanDrift.toFixed(4)} | commonWinners=${c.commonWinners.length} | unionWinners=${c.unionWinners.length}`);
    lines.push(`STABILITY | GATE=${c.parityAssumptionHolds ? "PASS — continuation parity assumption holds; Phase 2 viable" : "BLOCKED — winners diverge across start dates; Phase 2 not safe for this config"}`);
    lines.push("");
    lines.push("Per-window snapshots:");
    for (let i = 0; i < c.windows.length; i++) {
        const w = c.windows[i]!;
        const winners = c.winnerAssetsByWindow[i]!;
        const winnersText = winners.length > 0 ? winners.join(",") : "(no pick)";
        lines.push(`  ${w.label.padEnd(12)} | asOf=${formatAsOf(w.snapshot.asOf)} | reason=${w.snapshot.reason} | openPositions=${w.snapshot.openPositions} | winners=${winnersText} | artifacts=${w.snapshot.artifacts}`);
    }
    lines.push("");
    if (c.commonWinners.length > 0) {
        lines.push(`STABILITY | COMMON WINNERS (in every window): ${c.commonWinners.join(", ")}`);
    }
    if (c.unionWinners.length > c.commonWinners.length) {
        const onlySome = c.unionWinners.filter((a) => !c.commonWinners.includes(a));
        lines.push(`STABILITY | DIVERGENT (winner in some windows only): ${onlySome.join(", ")}`);
    }
    return lines;
}
