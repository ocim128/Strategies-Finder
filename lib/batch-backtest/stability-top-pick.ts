/**
 * Stability Mine "Top Pick" selector.
 *
 * Why this exists (AGENTS.md rule 8 — encode intent, not behavior):
 * `BatchStabilityRow` is sorted by `timingEdgeScore`, which ranks the quality
 * of the analog-state *research edge*. That is a different question from
 * "what is the best trade decision now?" — the answer to the latter also
 * depends on whether `computeStabilityAction` says the row is actionable
 * (ENTER), and on data freshness / recurrence that the research score does
 * not carry. Without this selector, a high-score row that the action layer
 * has downgraded to REJECT or INVALID sits at the top of the list and the
 * user has to read every badge to find the one trade they should actually
 * take. This module collapses the sorted list into a single, decision-aware
 * pick so the renderer can surface it as a callout.
 *
 * Leaf module (no DOM / chart-manager transitive deps) so it can be unit
 * tested directly — mirrors the `miner-verdict-format-helpers.ts` pattern.
 */

import type { BatchStabilityRow } from "./batch-stability-mine";
import { computeStabilityAgeTag, type StabilityActionDecision } from "./miner-verdict-format-helpers";

export type StabilityTopPickTier = "ENTER" | "WATCH";

/**
 * Conviction classification layered on top of the action tier.
 *
 * `computeStabilityAction` says *whether* a row is actionable (ENTER/WATCH);
 * this says *how strongly* the user should act on it. A row can be ENTER and
 * still be a weak stand-aside candidate — e.g. a low-score, stale, zero-fresh
 * continuation. Surfacing that distinction is the whole point of the callout:
 * a green TOP PICK reasonably implies "yes, trade this," and we must not say
 * that when the evidence is thin.
 *
 * - STRONG: green callout. Actionable AND the evidence backs conviction.
 * - WEAK:   warning callout. ENTER/WATCH exists but fails the strong gate —
 *           best read as "stand-aside candidate," not "enter now."
 * - NONE:   no callout. Only REJECT/WAIT/INVALID in the run.
 */
export type StabilityConviction = "STRONG" | "WEAK" | "NONE";

export interface StabilityTopPick {
    row: BatchStabilityRow;
    decision: StabilityActionDecision;
    /** ENTER when a genuine entry exists; WATCH only as a promoted fallback. */
    tier: StabilityTopPickTier;
    conviction: Exclude<StabilityConviction, "NONE">;
}

/**
 * Strong-conviction thresholds. Tuned against real Stability Mine runs:
 * a score floor of 20 clears the typical noise band (most rows score < 10),
 * `Age !== "Stale"` rejects analog states that fired ≥ 50 bars ago, and
 * `freshHits > 0` requires at least one recent agreement so a pure
 * historical continuation can't badge green.
 */
const STRONG_MIN_SCORE = 20;

function isStaleAnalog(row: BatchStabilityRow): boolean {
    return computeStabilityAgeTag(row) === "Stale";
}

/**
 * Pick the single best trade decision from a Stability Mine run.
 *
 * Selection contract:
 * 1. ENTER rows always beat WATCH rows, regardless of score. The user asked
 *    for a decision, not a score; an actionable ENTER is the answer even when
 *    a non-actionable WATCH has a higher research score.
 * 2. Within a tier, rank by `timingEdgeScore` (edge quality), then break ties
 *    by `dataLagBars` ascending (fresher data wins — the axis the score
 *    ignores), then `freshHitRate` desc, then `hits` desc, then
 *    `asset|direction` for determinism.
 * 3. REJECT / WAIT / INVALID are never picked.
 *
 * Returns `null` when there are zero ENTER and zero WATCH rows (including the
 * empty input case).
 */
export function pickStabilityTopTrade(
    rows: readonly BatchStabilityRow[],
    decisions: readonly StabilityActionDecision[],
): StabilityTopPick | null {
    if (rows.length === 0 || decisions.length === 0) return null;
    const capped = Math.min(rows.length, decisions.length);

    let best: { row: BatchStabilityRow; decision: StabilityActionDecision } | null = null;
    let bestTier: StabilityTopPickTier | null = null;
    for (let i = 0; i < capped; i += 1) {
        const decision = decisions[i]!;
        const tier = tierOf(decision.action);
        if (tier === null) continue;
        const candidate = { row: rows[i]!, decision };
        // First qualifying row initializes; later rows must beat the incumbent.
        // ENTER always supersedes WATCH without further comparison.
        if (bestTier === "ENTER" && tier === "WATCH") continue;
        if (best === null || (bestTier === "WATCH" && tier === "ENTER")) {
            best = candidate;
            bestTier = tier;
            continue;
        }
        if (compareCandidates(candidate, best) < 0) {
            best = candidate;
            bestTier = tier;
        }
    }
    if (best === null || bestTier === null) return null;
    const conviction = classifyConviction(best.row, bestTier);
    return { row: best.row, decision: best.decision, tier: bestTier, conviction };
}

function tierOf(action: StabilityActionDecision["action"]): StabilityTopPickTier | null {
    if (action === "ENTER") return "ENTER";
    if (action === "WATCH") return "WATCH";
    return null;
}

/**
 * Candidate comparator implementing the documented tie-break order.
 * Returns < 0 when `a` ranks ahead of `b`.
 *
 * `dataLagBars` null (unknown lag) is treated as worst-case (+Infinity). In
 * practice ENTER/WATCH rows always carry a finite lag (an unparseable
 * `asOfTimeKey` forces action INVALID upstream), so this is a defensive
 * guard rather than a reachable branch.
 */
function compareCandidates(
    a: { row: BatchStabilityRow; decision: StabilityActionDecision },
    b: { row: BatchStabilityRow; decision: StabilityActionDecision },
): number {
    if (a.row.timingEdgeScore !== b.row.timingEdgeScore) {
        return b.row.timingEdgeScore - a.row.timingEdgeScore;
    }
    const lagA = a.decision.dataLagBars ?? Number.POSITIVE_INFINITY;
    const lagB = b.decision.dataLagBars ?? Number.POSITIVE_INFINITY;
    if (lagA !== lagB) return lagA - lagB;
    if (a.decision.freshHitRate !== b.decision.freshHitRate) {
        return b.decision.freshHitRate - a.decision.freshHitRate;
    }
    if (a.row.hits !== b.row.hits) return b.row.hits - a.row.hits;
    const keyA = `${a.row.asset}|${a.row.direction}`;
    const keyB = `${b.row.asset}|${b.row.direction}`;
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
}

/**
 * Classify a picked row's conviction. Returns NONE only when no actionable
 * row exists at all; for a non-null `pickStabilityTopTrade` result the
 * conviction is always STRONG or WEAK.
 */
export function classifyConviction(row: BatchStabilityRow, tier: StabilityTopPickTier): Exclude<StabilityConviction, "NONE"> {
    const strong = tier === "ENTER"
        && row.timingEdgeScore >= STRONG_MIN_SCORE
        && !isStaleAnalog(row)
        && row.freshHits > 0;
    return strong ? "STRONG" : "WEAK";
}

/**
 * Forward target price projected from a Stability row's median expected
 * forward return, mirroring `computeMinerTargetPrice`'s math but operating on
 * the aggregated `BatchStabilityRow` (the verdict helper takes a raw
 * `BatchSyntheticAssetVerdict`, which an aggregated row is not).
 *
 * LONG: close × (1 + medianRetPct/100); SHORT: close × (1 - medianRetPct/100).
 * Returns null when direction, close, or medianRetPct is missing or invalid.
 */
export function projectStabilityTarget(row: BatchStabilityRow): number | null {
    const { close, medianRetPct, direction } = row;
    if (close === null || !Number.isFinite(close) || close <= 0) return null;
    if (medianRetPct === null || !Number.isFinite(medianRetPct)) return null;
    const movePct = medianRetPct / 100;
    return direction === "LONG" ? close * (1 + movePct) : close * (1 - movePct);
}

/**
 * Compact hold-horizon label for the target, derived from `medianBarsHeld`
 * (the analog hold scale). Mirrors Mine Timing's `@<n>b` horizon annotation
 * so the target reads as "price level at this bar horizon", not just a number.
 * Returns null when no finite horizon is available.
 */
export function stabilityHorizonBars(row: BatchStabilityRow): number | null {
    const bars = row.medianBarsHeld;
    if (bars === null || !Number.isFinite(bars)) return null;
    return Math.max(0, Math.round(bars));
}

/**
 * Whether the analog state is too stale for a forward target projection to be
 * meaningful. The renderer uses this to suppress the target price on stale
 * picks (showing `-- (stale analog)`) instead of extending a historical
 * median forward from a state that fired ≥ 50 bars ago.
 */
export function isStabilityTargetSuppressed(row: BatchStabilityRow): boolean {
    return isStaleAnalog(row);
}
