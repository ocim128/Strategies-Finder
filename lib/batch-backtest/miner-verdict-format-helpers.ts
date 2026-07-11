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
import type { BatchStabilityRow } from "./batch-stability-mine";
import { parseIntervalSeconds } from "../interval-utils";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { IBKR_SYMBOL_SUFFIX } from "../local-daily-datasets";

export type StabilityAction = "ENTER" | "WATCH" | "WAIT" | "REJECT" | "INVALID";

export interface StabilityActionDecision {
    action: StabilityAction;
    reason: string;
    dataLagBars: number | null;
    recurrenceRate: number;
    freshHitRate: number;
}

const CONTINUATION_MIN_LIFT_PCT = 5;
const CONTINUATION_MIN_RR = 2;
const CONTINUATION_MAX_DISTANCE = 1.5;
const CONTINUATION_MIN_HIGH_CONFIDENCE_SHARE = 0.5;

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
    if (transition > 0 && barsHeld !== null && Number.isFinite(barsHeld) && barsHeld <= 3) {
        return "Fresh";
    }
    return "Aging";
}

export function computeStabilityAgeTag(row: BatchStabilityRow): string {
    const barsHeld = row.medianBarsHeld;
    if (barsHeld === null && row.agreementTransition === null) return "--";
    if (barsHeld !== null && Number.isFinite(barsHeld) && barsHeld >= 50) {
        return "Stale";
    }
    if (row.agreementTransition !== null && row.agreementTransition > 0
        && barsHeld !== null && Number.isFinite(barsHeld) && barsHeld <= 3) {
        return "Fresh";
    }
    return "Aging";
}

/** Explain the first multiplicative factor that prevents a Stability row from scoring. */
export function computeStabilityGate(row: BatchStabilityRow): string {
    if (row.timingEdgeScore > 0) return "PASS";
    if (row.hits <= 0) return "NO_HITS";
    if (row.medianLiftPct === null || row.medianRr === null || row.medianHmaxLiftPct === null) return "THIN";
    if (row.medianLiftPct <= 0) return "NO_LIFT";
    if (row.medianRr <= 1) return "LOW_RR";
    if (row.medianHmaxLiftPct <= 0) return "HORIZON";
    if (row.medianDiversity <= 0) return "REPEAT";
    if (row.pairWarnings / row.hits >= 2) return "PAIR_WARN";
    return "ROUNDING";
}

/**
 * Trade-decision layer kept separate from the research score. The score says
 * whether conditional analog evidence is good; this classifier says whether
 * that evidence is current, recurrent, and fresh enough to act on.
 */
export function computeStabilityAction(
    row: BatchStabilityRow,
    reruns: number,
    interval: string,
    nowMs = Date.now(),
): StabilityActionDecision {
    const recurrenceRate = row.hits / Math.max(1, reruns);
    const freshHitRate = Math.max(0, Number(row.freshHits) || 0) / Math.max(1, row.hits);
    const dataLagBars = computeStabilityDataLagBars(
        row.asOfTimeKey,
        interval,
        nowMs,
        isIbkrStabilityRow(row) ? "us_equities" : "continuous",
    );
    const gate = computeStabilityGate(row);

    if (dataLagBars === null) {
        return { action: "INVALID", reason: "DATA_TIME_UNKNOWN", dataLagBars, recurrenceRate, freshHitRate };
    }
    if (dataLagBars > 2) {
        return { action: "INVALID", reason: "DATA_STALE", dataLagBars, recurrenceRate, freshHitRate };
    }
    if (gate !== "PASS") {
        return { action: "REJECT", reason: gate, dataLagBars, recurrenceRate, freshHitRate };
    }
    if (row.hits < 5 || recurrenceRate < 0.1) {
        return { action: "WATCH", reason: "LOW_RECURRENCE", dataLagBars, recurrenceRate, freshHitRate };
    }
    const ageTag = computeStabilityAgeTag(row);
    if (ageTag === "Fresh" && freshHitRate >= 0.5) {
        return { action: "ENTER", reason: "FRESH_STABLE", dataLagBars, recurrenceRate, freshHitRate };
    }
    const continuationQualityPasses = row.high / Math.max(1, row.hits) >= CONTINUATION_MIN_HIGH_CONFIDENCE_SHARE
        && row.medianLiftPct !== null && row.medianLiftPct >= CONTINUATION_MIN_LIFT_PCT
        && row.medianRr !== null && row.medianRr >= CONTINUATION_MIN_RR
        && row.medianDist !== null && row.medianDist <= CONTINUATION_MAX_DISTANCE;
    if (continuationQualityPasses) {
        // Analog selection already matches the current snapshot on age and
        // move-since-entry before estimating forward return. A second absolute
        // extension veto duplicates that conditioning and can contradict the
        // remaining-edge evidence this action is meant to summarize.
        return { action: "ENTER", reason: "CONTINUATION_EDGE", dataLagBars, recurrenceRate, freshHitRate };
    }
    if (ageTag === "Stale") {
        return { action: "WAIT", reason: "OLD_STATE", dataLagBars, recurrenceRate, freshHitRate };
    }
    return { action: "WATCH", reason: "AGING_STATE", dataLagBars, recurrenceRate, freshHitRate };
}

export function computeStabilityDataLagBars(
    asOfTimeKey: string | null,
    interval: string,
    nowMs = Date.now(),
    market: "continuous" | "us_equities" = "continuous",
): number | null {
    const asOfSeconds = parseTimeToUnixSeconds(asOfTimeKey);
    const intervalSeconds = parseIntervalSeconds(interval);
    if (asOfSeconds === null || intervalSeconds === null) return null;
    if (market === "us_equities") {
        return countUsEquityAggregateBucketsAfter(asOfSeconds, intervalSeconds, nowMs);
    }
    return Math.max(0, ((nowMs / 1000) - asOfSeconds) / intervalSeconds);
}

function isIbkrStabilityRow(row: Pick<BatchStabilityRow, "dominantPair">): boolean {
    return row.dominantPair?.includes(IBKR_SYMBOL_SUFFIX) ?? false;
}

/**
 * Count completed US regular-session aggregate buckets after the stored bar.
 * IBKR 4H CSVs store the bucket start (for example 16:00 UTC) even though that
 * bucket contains 30m candles through the 20:00 UTC close. Counting distinct
 * completed RTH buckets avoids treating that coverage, overnight, and weekends
 * as missing market bars. The standard post-2007 US DST rule is sufficient for
 * the exchange session; a single weekday holiday contributes at most two 4H
 * buckets, which remains inside the existing two-bar freshness allowance.
 */
function countUsEquityAggregateBucketsAfter(
    asOfSeconds: number,
    intervalSeconds: number,
    nowMs: number,
): number {
    if (nowMs / 1000 <= asOfSeconds) return 0;
    const completedBuckets = new Set<number>();
    const start = new Date(asOfSeconds * 1000);
    const end = new Date(nowMs);
    const startDate = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    const endDate = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

    for (let dateMs = startDate; dateMs <= endDate; dateMs += 86_400_000) {
        const date = new Date(dateMs);
        const weekday = date.getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth();
        const day = date.getUTCDate();
        const easternOffsetHours = isUsEasternDstDate(year, month, day) ? -4 : -5;
        const sessionOpenSeconds = Date.UTC(year, month, day, 9 - easternOffsetHours, 30) / 1000;
        for (let slot = 0; slot < 13; slot += 1) {
            const barOpenSeconds = sessionOpenSeconds + slot * 30 * 60;
            const barCloseMs = (barOpenSeconds + 30 * 60) * 1000;
            if (barCloseMs > nowMs) break;
            const bucketStart = Math.floor(barOpenSeconds / intervalSeconds) * intervalSeconds;
            if (bucketStart > asOfSeconds) completedBuckets.add(bucketStart);
        }
    }
    return completedBuckets.size;
}

function isUsEasternDstDate(year: number, month: number, day: number): boolean {
    if (month < 2 || month > 10) return false;
    if (month > 2 && month < 10) return true;
    if (month === 2) return day >= nthSundayOfMonth(year, month, 2);
    return day < nthSundayOfMonth(year, month, 1);
}

function nthSundayOfMonth(year: number, month: number, occurrence: number): number {
    const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const firstSunday = 1 + ((7 - firstWeekday) % 7);
    return firstSunday + (occurrence - 1) * 7;
}

/**
 * Per-run staleness threshold in bars. Mirrors the `dataLagBars > 2` veto in
 * `computeStabilityAction` — kept as a named constant so the run-level summary
 * and the per-row action stay on the same definition of "stale".
 */
export const STABILITY_DATA_STALE_THRESHOLD_BARS = 2;

export type StabilityDataFreshnessStatus = "FRESH" | "STALE" | "UNKNOWN";

export interface StabilityDataFreshnessSummary {
    status: StabilityDataFreshnessStatus;
    maxLagBars: number | null;
    staleCount: number;
    freshCount: number;
    unknownCount: number;
    total: number;
    text: string;
}

/**
 * Aggregate per-row data lag into a single run-level freshness verdict.
 *
 * Why this exists: Stability Mine's per-row `Action` is `INVALID | DATA_STALE`
 * whenever `dataLagBars > 2`, but on stale OHLCV every row hits that veto and
 * the run looks like an algorithm failure rather than a data-feed failure.
 * This summary surfaces "the data is stale" once at the top of the run/Copy so
 * the cause is impossible to miss, while `computeStabilityAction` keeps its
 * hard per-row veto unchanged.
 *
 * Reuses `computeStabilityDataLagBars` (the single source of lag math). A row
 * is STALE when its lag exceeds `STABILITY_DATA_STALE_THRESHOLD_BARS`. The run
 * is STALE if ANY row is stale (one stale asset means the feed stopped), UNKNOWN
 * when any non-empty row has unparseable age, else FRESH.
 *
 * Pure (no DOM, no `Date.now()` when `nowMs` is supplied) so it is directly
 * unit-testable.
 */
export function summarizeStabilityDataFreshness(
    rows: readonly { asOfTimeKey: string | null; dominantPair?: string | null }[],
    interval: string,
    nowMs = Date.now(),
): StabilityDataFreshnessSummary {
    const total = rows.length;
    let maxLagBars: number | null = null;
    let staleCount = 0;
    let freshCount = 0;
    let unknownCount = 0;
    for (const row of rows) {
        const lag = computeStabilityDataLagBars(
            row.asOfTimeKey,
            interval,
            nowMs,
            row.dominantPair?.includes(IBKR_SYMBOL_SUFFIX) ? "us_equities" : "continuous",
        );
        if (lag === null) {
            unknownCount += 1;
            continue;
        }
        if (maxLagBars === null || lag > maxLagBars) maxLagBars = lag;
        if (lag > STABILITY_DATA_STALE_THRESHOLD_BARS) staleCount += 1;
        else freshCount += 1;
    }
    const knownCount = staleCount + freshCount;
    let status: StabilityDataFreshnessStatus;
    if (staleCount > 0) {
        status = "STALE";
    } else if (unknownCount > 0) {
        // Do not claim the whole run is fresh when even one row cannot be
        // checked. An empty row set has unknownCount=0 and remains FRESH.
        status = "UNKNOWN";
    } else {
        status = "FRESH";
    }
    const maxLagText = maxLagBars === null ? "--" : maxLagBars.toFixed(1);
    let text: string;
    if (status === "STALE") {
        text = `Data STALE — max lag ${maxLagText}b across ${staleCount}/${knownCount} assets (threshold ${STABILITY_DATA_STALE_THRESHOLD_BARS}b). Refresh OHLCV before trusting any Action.`;
    } else if (status === "UNKNOWN") {
        text = `Data age UNKNOWN — could not parse AsOf timestamps for ${unknownCount}/${total} assets.`;
    } else {
        text = `Data fresh — max lag ${maxLagText}b across ${knownCount} asset${knownCount === 1 ? "" : "s"}.`;
    }
    return { status, maxLagBars, staleCount, freshCount, unknownCount, total, text };
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
