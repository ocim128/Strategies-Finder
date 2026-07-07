/**
 * Pure presentation helpers for the Mine Timing verdict row.
 *
 * Extracted to a leaf module (rather than living inside `batch-backtest-service.ts`)
 * so they can be unit-tested directly. `batch-backtest-service.ts` is a heavy
 * module that exports only its singleton; exporting these from there would
 * widen its public surface for a single test. Keeping them as a leaf also
 * means `tests/` can import them without dragging in DOM/chart-manager
 * transitive deps.
 *
 * Intent these encode (AGENTS.md rule 8):
 * - `Age` answers "when did this fire?" in one readable tag instead of forcing
 *   the user to read `AsOf` + `medianBarsHeld` + `agreementTransition` together.
 * - `Target` answers "exit recommendation": a forward price at the longest
 *   analog horizon (~2× median hold), symmetric to the existing invalidation
 *   (stop) price already shown on the row.
 */

import type { BatchSyntheticAssetVerdict } from "./batch-synthetic-state-miner";

/**
 * Signal-age tag.
 * - `Fresh`: positive agreement transition + low carry-in (≤ 3 bars). The
 *   newly-emerged-trigger window — highest value for a timing-edge finder.
 * - `Stale`: carry-in ≥ 50 bars. The miner allows carry-in historically
 *   (higher-timeframe edges live there) but a stale *current* snapshot means
 *   the evidence is about an old entry, not a fresh one.
 * - `Aging`: everything else.
 */
export function computeMinerAgeTag(verdict: BatchSyntheticAssetVerdict): string {
    const snapshot = verdict.currentSnapshot;
    if (!snapshot) return "--";
    const barsHeld = snapshot.medianBarsHeld;
    const transition = snapshot.agreementTransition;
    if (barsHeld !== null && Number.isFinite(barsHeld) && barsHeld >= 50) {
        return "Stale";
    }
    if (transition > 0 && (barsHeld === null || (Number.isFinite(barsHeld) && barsHeld <= 3))) {
        return "Fresh";
    }
    return "Aging";
}

/**
 * Forward target price derived from the longest-horizon OOS forward return.
 * Symmetric to `computeMinerInvalidationPrice` in the service module — that
 * one uses MAE to derive a stop, this one uses the longest-horizon OOS
 * forward return to derive a target. Returns null when direction, close, or
 * longest-horizon return is unavailable.
 */
export function computeMinerTargetPrice(verdict: BatchSyntheticAssetVerdict): number | null {
    const close = verdict.currentSnapshot?.close;
    const longestRet = verdict.evidence.longestOosForwardReturnPct;
    if (!verdict.direction || close === null || close === undefined || longestRet === null || !Number.isFinite(close) || !Number.isFinite(longestRet) || close <= 0) {
        return null;
    }
    const movePct = longestRet / 100;
    if (verdict.direction === "long") {
        return close * (1 + movePct);
    }
    return close * (1 - movePct);
}

/**
 * Format a target price + horizon window as a compact string. The horizon
 * bar count is part of the recommendation — "target X @ 48b" tells the user
 * both the price level AND the time window the analog edge projects to.
 */
export function formatTargetPrice(
    direction: BatchSyntheticAssetVerdict["direction"],
    value: number | null,
    horizonBars: number | null,
    formatPrice: (value: number | null | undefined) => string
): string {
    if (!direction || value === null || !Number.isFinite(value) || horizonBars === null || !Number.isFinite(horizonBars)) {
        return "--";
    }
    const comparator = direction === "long" ? ">" : "<";
    return `${comparator}${formatPrice(value)}@${horizonBars}b`;
}
