import type { PairSelectionDetailRow, PairSelectionDetailStatus } from "../pair-selection/tally";
import { SELECTION_RULES_DETAIL_PAGE_DEFAULT } from "./stream-types";

export { SELECTION_RULES_DETAIL_PAGE_DEFAULT };

/** Formats a unix-seconds signal timestamp as `YYYY-MM-DD HH:MM:SS` (UTC). */
export function formatDetailSignalTime(signalTime: number): string {
    return new Date(signalTime * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/** Direction-adjusted fractional returns render as signed percentages. */
export function formatDetailPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

/** Deltas versus the pool mean render in percentage points, matching the summary table. */
export function formatDetailPp(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}pp`;
}

export function formatDetailScore(value: number): string {
    return Number.isFinite(value) ? value.toFixed(4) : String(value);
}

export const DETAIL_STATUS_LABELS: Record<PairSelectionDetailStatus, string> = {
    COMPLETE: "COMPLETE",
    SELECTED_OUTCOME_KNOWN_POOL_INCOMPLETE: "POOL INCOMPLETE",
    PENDING: "PENDING",
};

export function detailStatusLabel(status: PairSelectionDetailStatus): string {
    return DETAIL_STATUS_LABELS[status];
}

export function detailStatusClass(status: PairSelectionDetailStatus): string {
    return `selection-rules-detail-status-${status.toLowerCase()}`;
}

/**
 * A details response only applies while the run that produced it is still
 * the tab's active run; a newer run (or a cleared tab) must ignore it.
 */
export function isStaleDetailResponse(response: { runId: string }, activeRunId: string | null): boolean {
    return activeRunId === null || response.runId !== activeRunId;
}

export function selectionRulesDetailsUrl(
    runId: string,
    ruleKey: string,
    horizonBars: number,
    offset: number,
    limit: number = SELECTION_RULES_DETAIL_PAGE_DEFAULT,
): string {
    return `/api/selection-rules/details?runId=${encodeURIComponent(runId)}&ruleKey=${encodeURIComponent(ruleKey)}`
        + `&horizonBars=${horizonBars}&offset=${offset}&limit=${limit}`;
}

/** Splits the per-row `data-detail-key` (`ruleKey|horizonBars`) button payload. */
export function parseDetailResultKey(key: string): { ruleKey: string; horizonBars: number } | null {
    const separator = key.lastIndexOf("|");
    if (separator <= 0 || separator === key.length - 1) return null;
    const ruleKey = key.slice(0, separator);
    const horizonBars = Number(key.slice(separator + 1));
    if (!ruleKey || !Number.isInteger(horizonBars) || horizonBars <= 0) return null;
    return { ruleKey, horizonBars };
}

/**
 * Accumulates one fetched page (newest-first) onto the rendered history.
 * Pages append because offset grows with the rendered row count; the server
 * keeps the authoritative newest-first order and page bounds.
 */
export function appendDetailPage(rows: readonly PairSelectionDetailRow[], page: readonly PairSelectionDetailRow[]): PairSelectionDetailRow[] {
    return [...rows, ...page];
}
