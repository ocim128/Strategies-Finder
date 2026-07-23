/**
 * OPEN_SCORE USD Replay — event-level selector study.
 *
 * Research question (v1, event-level only): at historical synthetic-pair
 * decision events, did selecting the asset with the highest positive
 * OPEN_SCORE and trading that asset vs USD beat selecting another
 * positive-score asset at random (same decision event)?
 *
 * Scope boundary: this is an equal-notional, fixed-horizon USD trade study.
 * It answers whether the top-score choice has better conditional forward
 * return than another positive candidate at the same event. It does NOT
 * reproduce a live portfolio's overlapping positions, adaptive exits, or
 * capital compounding; those need the separate gated stateful phase and must
 * not be inferred from this report.
 *
 * Score semantics (must match computeOpenTradeAssetScores in batch-row-scalars):
 *   long pair  -> base +1, quote -1 at entry; inverse deltas at exit
 *   short pair -> base -1, quote +1 at entry; inverse deltas at exit
 * rawScore[a]        = signed active-pair vote total
 * activePairCount[a] = active positive + active negative votes
 * adjustedScore[a]   = rawScore / sqrt(activePairCount)  (coverage-adjusted,
 *                      NOT a statistically calibrated z-score)
 *
 * Timing (conservative causal rule): the score is updated with ALL entries and
 * exits at a timestamp before candidates are formed (a fixture proves a
 * same-timestamp exit/entry cannot leak a later target bar's price). The USD
 * entry is the first target-asset bar strictly AFTER the decision timestamp,
 * filled at that bar's open. Exit-only score changes do NOT create an event.
 *
 * Eligibility: an event is eligible only when it has >= 2 positive candidates
 * and every candidate has valid target data for the horizon. If a winner has
 * missing data, the event is omitted from BOTH arms — never substitute a
 * different winner after seeing data availability. Right-censored events near
 * the target end are excluded; a missing target is counted, never zero-filled.
 *
 * Pure leaf: imports ../types/strategies (type-only Time is erased),
 * ../strategies/backtest/backtest-utils (timeKey/timeToNumber/applySlippage),
 * and ./batch-synthetic-state-miner (artifact types) only. No DOM, no runtime
 * lightweight-charts — safe for the vite cjs config bundle.
 */
import type { OHLCVData } from "../types/strategies";
import { applySlippage, timeToNumber } from "../strategies/backtest/backtest-utils";
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-artifact";
import {
    tieBreakDigest,
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
} from "./max-active-research-contract";

// ============================================================================
// Public types
// ============================================================================

export interface ReplayComparison {
    /** Eligible events that entered both arms. */
    events: number;
    /** Mean net USD return of the selected (top) asset. */
    topMean: number | null;
    /** Mean net USD return of the uniform random control (other positives). */
    randomMean: number | null;
    /** topMean - randomMean. */
    delta: number | null;
    /** Median net USD return of the selected asset. */
    topMedian: number | null;
    /** Chronological block means of the per-event delta. */
    blockMeans: number[];
    /** Deterministic block-bootstrap 95% CI for the delta. */
    ciLower: number | null;
    ciUpper: number | null;
    /** Count of blocks whose mean delta is positive. */
    positiveBlocks: number;
    totalBlocks: number;
}

export interface DegreeSummary {
    min: number;
    median: number;
    max: number;
    /** Share of selected events attributable to the single most-covered asset. */
    topAssetShare: number | null;
}

export interface SelectorAgreement {
    events: number;
    sameSelection: number;
    rate: number | null;
}

export interface AssetSelectionSummary {
    asset: string;
    events: number;
    share: number;
    topMean: number | null;
    randomMean: number | null;
    delta: number | null;
}

export interface OpenScoreUsdReplayResult {
    pairs: number;
    assets: number;
    complete: boolean;
    omittedPairs: number;
    omittedAssets: number;
    totalEvents: number;
    /** Decision events with at least two positive candidates before outcome availability. */
    candidateEvents: number;
    eligibleEvents: number;
    horizons: Array<{
        bars: number;
        topRaw: ReplayComparison;
        topAdjusted: ReplayComparison;
        /** Highest rawScore / activePairCount (mean signed vote). */
        topMean: ReplayComparison;
        /** Reversion selector: most-open negative-score asset, shorted vs USD. */
        maxActiveReversion: ReplayComparison;
        /** Per-asset breakdown for the reversion selector. */
        maxActiveReversionByAsset: AssetSelectionSummary[];
        /**
         * Reversion selector after events selecting its most-frequent asset
         * are removed. Mirrors {@link maxActiveExDominant} for the short side:
         * drops events where MAX_ACTIVE_REVERSION picked its most-frequent
         * asset; the remaining events form the comparison.
         */
        maxActiveReversionExDominant: ReplayComparison;
        /**
         * Most-frequently-selected MAX_ACTIVE_REVERSION asset (ties by FNV-1a
         * digest). The asset excluded from {@link maxActiveReversionExDominant}.
         */
        maxActiveReversionDominantAsset: string | null;
        /** Control: positive candidate covered by the most currently-open pairs. */
        maxActive: ReplayComparison;
        /** Control: positive candidate with the highest submitted pair-list degree. */
        maxStatic: ReplayComparison;
        /**
         * Phase 3 MAX_ACTIVE: positive candidate with the highest SUBMITTED
         * pair-list degree (the canonical Batch request). Same selector as
         * {@link maxStatic} (renamed per the plan); kept alongside for
         * backward compat with existing tests.
         */
        maxSubmitted: ReplayComparison;
        /**
         * Phase 3 MAX_ACTIVE: positive candidate with the highest RETAINED
         * artifact degree (computed from successfully loaded artifacts,
         * counting both legs of every canonical artifact regardless of trades).
         */
        maxRetained: ReplayComparison;
        /** TOP_RAW after events selecting its most-frequent asset are removed. */
        topRawExDominant: ReplayComparison;
        /**
         * Phase 3 MAX_ACTIVE: dominant-asset exclusion for MAX_ACTIVE (the
         * research hypothesis). Drops events where MAX_ACTIVE picked its
         * most-frequent asset; the remaining events form the comparison.
         */
        maxActiveExDominant: ReplayComparison;
        /**
         * Phase 3 MAX_ACTIVE: most-frequently-selected MAX_ACTIVE asset
         * (ties by FNV-1a digest). The asset excluded from `maxActiveExDominant`.
         */
        maxActiveDominantAsset: string | null;
        /** Phase 3 MAX_ACTIVE: per-asset MAX_ACTIVE selection breakdown. */
        maxActiveByAsset: AssetSelectionSummary[];
        dominantAsset: string | null;
        rawAdjustedAgreement: SelectorAgreement;
        /**
         * Phase 3 MAX_ACTIVE: same-event return difference between MAX_ACTIVE
         * and MAX_SUBMITTED, only on events where the two selectors pick
         * different assets. `events === 0` means the selectors never disagreed
         * on this horizon.
         */
        activeVsSubmitted: ReplayComparison;
        /** Same-event return difference: MAX_ACTIVE vs MAX_RETAINED. */
        activeVsRetained: ReplayComparison;
        /** Same-event return difference: MAX_ACTIVE vs TOP_RAW. */
        activeVsRaw: ReplayComparison;
        /** Same-event return difference: MAX_ACTIVE vs TOP_MEAN. */
        activeVsMean: ReplayComparison;
        topRawByAsset: AssetSelectionSummary[];
        /**
         * TOP_MEAN after events selecting its most-frequent asset are removed.
         * Mirrors {@link topRawExDominant} for the coverage-adjusted arm: drops
         * events where TOP_MEAN picked its most-frequent asset; the remaining
         * events form the comparison.
         */
        topMeanExDominant: ReplayComparison;
        /**
         * Most-frequently-selected TOP_MEAN asset (ties by FNV-1a digest). The
         * asset excluded from {@link topMeanExDominant}.
         */
        topMeanDominantAsset: string | null;
        /** Per-asset breakdown for the TOP_MEAN selector. */
        topMeanByAsset: AssetSelectionSummary[];
        /** Active pair count at decision events (coverage at the event). */
        candidateDegree: DegreeSummary;
        /** Static pair degree of the selected TOP_RAW asset across events. */
        selectedDegree: DegreeSummary;
        /**
         * Phase 3 MAX_ACTIVE: tie count + rate for each selector (ties broken
         * by the shared FNV-1a 64 rule). Surfaces how often the deterministic
         * tie-break decided the selection — material for research transparency.
         */
        tieRates: Record<SelectorName, SelectorAgreement>;
    }>;
    degree: DegreeSummary;
    warnings: string[];
    reportLines: string[];
}

/** Phase 3 MAX_ACTIVE selector labels for tie/agreement diagnostics. */
export type SelectorName = "RAW" | "ADJUSTED" | "MEAN" | "ACTIVE" | "SUBMITTED" | "RETAINED" | "REVERSION";

export interface OpenScoreUsdTarget {
    asset: string;
    symbol: string;
    data: OHLCVData[];
}

export interface RunOpenScoreUsdReplayOptions {
    /** Required in v1: positive bar horizons. Must be non-empty. */
    horizons: number[];
    /** Bar interval the artifacts were produced on (echoed in the report). */
    interval?: string;
    /** Optional decision-timestamp window (unix seconds, inclusive). */
    sampleFromSec?: number;
    sampleToSec?: number;
    /** Batch slippage/commission conventions applied to both arms identically. */
    slippageRate?: number;
    commissionRate?: number;
    /** Chronological blocks for block means / bootstrap. Default 10. */
    blockCount?: number;
    /** Deterministic bootstrap resamples. Default 2000. */
    bootstrapSamples?: number;
    /**
     * Phase 3 MAX_ACTIVE: submitted scoring-asset degree map from the
     * canonical Batch request. Drives the MAX_SUBMITTED selector. When
     * absent, MAX_SUBMITTED mirrors MAX_STATIC (which counts every leg of
     * every artifact as submitted) so old callers keep working.
     */
    submittedDegreeByAsset?: Record<string, number>;
    /** Phase transition + bounded-chunk progress. */
    onPhase?: (phase: "scan" | "events" | "targets" | "outcomes" | "aggregate", detail: string, completed: number, total: number) => void;
    /** Polled between bounded chunks; return true to stop early (cancellation). */
    shouldStop?: () => boolean;
}

// ============================================================================
// Small stat helpers (NaN/Infinity never cross the wire — they serialize to
// null, so every public metric is number | null and finite-guarded).
// ============================================================================

function median(sorted: readonly number[]): number {
    const n = sorted.length;
    if (n === 0) return Number.NaN;
    const mid = n >> 1;
    return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function finiteOrNull(x: number): number | null {
    return Number.isFinite(x) ? x : null;
}

function meanOrNull(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    let s = 0;
    for (const v of values) s += v;
    return finiteOrNull(s / values.length);
}

/**
 * Deterministic block bootstrap over chronological block means. Resamples
 * blocks with replacement using a fixed-seed LCG (init from the versioned
 * `MAX_ACTIVE_BOOTSTRAP_SEED`) so the CI is reproducible run-to-run.
 *
 * Phase 0 freeze: a formal CI requires EXACTLY {@link MAX_ACTIVE_BLOCK_COUNT}
 * nonempty chronological blocks. Fewer blocks (incl. one) return null CI —
 * `INSUFFICIENT_DATA`, never a misleading point CI from a single block.
 */
function blockBootstrapCi(blockMeans: readonly number[], resamples: number): { lower: number | null; upper: number | null } {
    const b = blockMeans.length;
    if (b < MAX_ACTIVE_BLOCK_COUNT) return { lower: null, upper: null };
    let seed = (Math.floor(MAX_ACTIVE_BOOTSTRAP_SEED) >>> 0) || 0x9e3779b9;
    const next = (): number => {
        // LCG (Numerical Recipes constants), returns [0,1).
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    const means: number[] = [];
    for (let r = 0; r < resamples; r += 1) {
        let s = 0;
        for (let k = 0; k < b; k += 1) s += blockMeans[Math.floor(next() * b)]!;
        means.push(s / b);
    }
    means.sort((x, y) => x - y);
    const lo = means[Math.max(0, Math.floor(0.025 * resamples))]!;
    const hi = means[Math.min(resamples - 1, Math.floor(0.975 * resamples))]!;
    return { lower: finiteOrNull(lo), upper: finiteOrNull(hi) };
}

function degreeSummary(degrees: readonly number[], topAssetShare: number | null): DegreeSummary {
    if (degrees.length === 0) return { min: 0, median: 0, max: 0, topAssetShare: null };
    const sorted = [...degrees].sort((a, b) => a - b);
    return {
        min: sorted[0]!,
        median: median(sorted),
        max: sorted[sorted.length - 1]!,
        topAssetShare,
    };
}

// ============================================================================
// Internal flat records (scalar, bounded by trades/events — no per-trade object
// retention beyond the compact delta stream).
// ============================================================================

interface ScoreDelta {
    timeSec: number;
    assetIndex: number;
    delta: number;
    /** 1 when this delta comes from a pair entry, 0 for an exit. */
    isEntry: number;
}

interface DecisionEvent {
    timeSec: number;
    /** Per-asset rawScore snapshot after applying all deltas at this time. */
    rawScore: number[];
    activePairCount: number[];
}

// ============================================================================
// Main engine
// ============================================================================

/**
 * @param artifactLoader Async iterator yielding one artifact at a time. The
 *   engine extracts compact score deltas and releases the reference before the
 *   next load — never holds the full pair universe in memory.
 * @param targetLoader Async iterator yielding one target dataset at a time.
 *   Consumed after events are formed; each dataset is released once all event
 *   requests for that asset are consumed.
 */
export async function runOpenScoreUsdReplay(
    artifactLoader: () => AsyncIterable<BatchSyntheticPairArtifact>,
    targetLoader: () => AsyncIterable<OpenScoreUsdTarget>,
    options: RunOpenScoreUsdReplayOptions,
): Promise<OpenScoreUsdReplayResult> {
    const startedAt = Date.now();
    const shouldStop = options.shouldStop ?? (() => false);
    const onPhase = options.onPhase ?? (() => undefined);
    const slippageRate = options.slippageRate ?? 0;
    const commissionRate = options.commissionRate ?? 0;
    // Phase 0 freeze: block count and bootstrap samples default to the frozen
    // research constants. Callers may override blockCount for diagnostics, but
    // a formal CI still requires EXACTLY MAX_ACTIVE_BLOCK_COUNT nonempty blocks.
    const blockCount = Math.max(1, Math.floor(options.blockCount ?? MAX_ACTIVE_BLOCK_COUNT));
    const bootstrapSamples = Math.max(200, Math.floor(options.bootstrapSamples ?? MAX_ACTIVE_BOOTSTRAP_SAMPLES));
    const warnings: string[] = [];

    const horizons = [...new Set(options.horizons.filter((h) => Number.isFinite(h) && h >= 1).map((h) => Math.floor(h)))].sort((a, b) => a - b);
    const emptyResult = (partial: Partial<OpenScoreUsdReplayResult>): OpenScoreUsdReplayResult => ({
        pairs: 0, assets: 0, complete: false, omittedPairs: 0, omittedAssets: 0,
        totalEvents: 0, candidateEvents: 0, eligibleEvents: 0, horizons: [], degree: degreeSummary([], null),
        warnings, reportLines: [], ...partial,
    });
    if (horizons.length === 0) {
        return emptyResult({ reportLines: ["OPEN_SCORE USD | no valid horizons supplied (required in v1)."] });
    }

    // --- Phase 1: scan artifacts -> compact per-pair delta streams ----------
    // Per-pair streams (not one global object array) so the Phase 2 merge can
    // interleave yields + progress and Stop stays responsive on huge pair
    // lists. Each pair's deltas are sorted in-place (small, fast) right after
    // the pair is loaded — never one global Array.sort blocking the loop.
    onPhase("scan", "scanning pair artifacts", 0, 0);
    const assetIndexByName = new Map<string, number>();
    const assetNames: string[] = [];
    // `retainedDegree` counts BOTH legs of every successfully loaded artifact
    // (the engine reads them from disk; this is what the plan calls RETAINED
    // degree, NOT submitted). The old name `staticDegree` is kept as an alias
    // so existing tests compile; the report labels this selector MAX_RETAINED.
    const retainedDegree = new Map<string, number>();
    /** @deprecated alias for {@link retainedDegree}; use that name in new code. */
    const staticDegree = retainedDegree;
    // Phase 3 MAX_ACTIVE: SUBMITTED degree comes from the canonical Batch
    // request (the user's textarea). When absent, fall back to the retained
    // degree map so MAX_SUBMITTED mirrors MAX_RETAINED for old callers.
    const submittedDegreeInput = options.submittedDegreeByAsset ?? null;
    const submittedDegree = new Map<string, number>();
    if (submittedDegreeInput) {
        for (const [k, v] of Object.entries(submittedDegreeInput)) {
            if (Number.isFinite(v) && v >= 0) submittedDegree.set(k, v);
        }
    }
    const streams: ScoreDelta[][] = [];
    let pairCount = 0;
    let omittedPairs = 0;

    const assetIndex = (name: string): number => {
        let idx = assetIndexByName.get(name);
        if (idx === undefined) {
            idx = assetNames.length;
            assetIndexByName.set(name, idx);
            assetNames.push(name);
        }
        return idx;
    };

    for await (const artifact of artifactLoader()) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, reportLines: ["OPEN_SCORE USD | cancelled during artifact scan."] });
        pairCount += 1;
        const base = artifact.baseAsset?.trim().toUpperCase();
        const quote = artifact.quoteAsset?.trim().toUpperCase();
        // Static pair degree describes the SUBMITTED pair list (the actual
        // workflow's coverage bias), so it must count every leg of every pair
        // regardless of whether the pair produced trades. Counting only pairs
        // that traded understated coverage and hid the pair-balance answer.
        if (base) staticDegree.set(base, (staticDegree.get(base) ?? 0) + 1);
        if (quote && quote !== base) staticDegree.set(quote, (staticDegree.get(quote) ?? 0) + 1);
        if (!base || !quote || base === quote) {
            omittedPairs += 1;
            continue;
        }
        const bi = assetIndex(base);
        const qi = assetIndex(quote);
        const trades = artifact.result?.trades ?? [];
        if (trades.length === 0) {
            omittedPairs += 1;
            continue;
        }
        const stream: ScoreDelta[] = [];
        for (const trade of trades) {
            const entrySec = timeToNumber(trade.entryTime);
            const exitSec = timeToNumber(trade.exitTime);
            if (entrySec === null) continue;
            const sign = trade.type === "long" ? 1 : trade.type === "short" ? -1 : 0;
            if (sign === 0) continue;
            // Entry deltas (long: base+1/quote-1; short: base-1/quote+1).
            stream.push({ timeSec: entrySec, assetIndex: bi, delta: sign, isEntry: 1 });
            stream.push({ timeSec: entrySec, assetIndex: qi, delta: -sign, isEntry: 1 });
            // Exit deltas are the exact inverse. end_of_data / missing exit time
            // means the position is still open at the artifact end -> no exit delta.
            if (exitSec !== null && trade.exitReason !== "end_of_data") {
                stream.push({ timeSec: exitSec, assetIndex: bi, delta: -sign, isEntry: 0 });
                stream.push({ timeSec: exitSec, assetIndex: qi, delta: sign, isEntry: 0 });
            }
        }
        // Sort this pair's deltas in-place (small N). One global Array.sort on
        // 1000+ pairs' worth of deltas would block the event loop and keep
        // Stop / progress from firing during the long sort.
        stream.sort(compareDeltas);
        streams.push(stream);
        if (pairCount % 25 === 0) {
            onPhase("scan", `scanned ${pairCount} pairs`, pairCount, 0);
            await yieldLoop();
        }
    }

    const assetCount = assetNames.length;
    const totalDeltas = streams.reduce((s, st) => s + st.length, 0);
    if (pairCount === 0 || totalDeltas === 0) {
        return emptyResult({ pairs: pairCount, reportLines: ["OPEN_SCORE USD | no trade deltas reconstructed from artifacts."] });
    }

    // --- Phase 2: k-way merge -> decision events + candidates ---------------
    // Binary min-heap over (timeSec, assetIndex, isEntry, streamIdx, offset)
    // pops deltas in global timestamp order. The heap is bounded by #streams,
    // not #deltas; yields fire after bounded pops so progress and Stop reach
    // the server mid-merge on a huge pair list.
    onPhase("events", "merging score deltas", 0, totalDeltas);
    const rawScore = new Array<number>(assetCount).fill(0);
    const activePairCount = new Array<number>(assetCount).fill(0);
    const events: DecisionEvent[] = [];
    const sampleFrom = options.sampleFromSec;
    const sampleTo = options.sampleToSec;

    const heap = new KWayMergeHeap(streams);
    let popped = 0;
    while (!heap.empty) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | cancelled during event sweep."] });
        const t = heap.peekTime();
        let hasEntry = false;
        // Apply ALL deltas at this timestamp before forming candidates.
        while (!heap.empty && heap.peekTime() === t) {
            if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | cancelled during event sweep."] });
            const d = heap.pop()!;
            rawScore[d.assetIndex]! += d.delta;
            // activePairCount tracks currently-open pairs on this asset: an
            // entry adds a vote, an exit removes it (clamped at 0). Using
            // abs(delta) here was wrong because it incremented on BOTH entry
            // and exit, inflating the adjusted-score denominator after every
            // round-trip and corrupting TOP_ADJUSTED selection.
            const countDelta = d.isEntry === 1 ? 1 : -1;
            const next = activePairCount[d.assetIndex]! + countDelta;
            activePairCount[d.assetIndex] = next > 0 ? next : 0;
            if (d.isEntry === 1) hasEntry = true;
            popped += 1;
            // A single timestamp can contain many pair deltas. Check and yield
            // inside the timestamp group so Stop remains observable even before
            // all same-time deltas have been applied. Candidate formation still
            // waits until the group is complete below.
            if (popped % 2000 === 0) {
                onPhase("events", `merged ${popped}/${totalDeltas} deltas`, popped, totalDeltas);
                await yieldLoop();
            }
        }
        // Exit-only score changes do not create a decision event.
        if (hasEntry) {
            if ((sampleFrom === undefined || t >= sampleFrom) && (sampleTo === undefined || t <= sampleTo)) {
                events.push({ timeSec: t, rawScore: [...rawScore], activePairCount: [...activePairCount] });
            }
        }
    }

    const totalEvents = events.length;
    if (totalEvents === 0) {
        return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | no decision events (no pair entries in window)."] });
    }

    // --- Phase 3: build candidate sets; collect per-asset event requests ---
    onPhase("targets", "forming candidates", 0, totalEvents);
    interface Candidate {
        assetIndex: number;
        raw: number;
        adjusted: number;
        mean: number;
        activePairs: number;
        staticPairs: number;     // RETAINED artifact degree (legacy name; counts every loaded artifact leg).
        submittedPairs: number;  // SUBMITTED degree from the canonical Batch request.
    }
    interface EventView {
        timeSec: number;
        positives: Candidate[];
        negatives: Candidate[];
        topRaw: number;      // assetIndex
        topAdjusted: number; // assetIndex
        topMean: number;     // assetIndex
        maxActive: number;   // assetIndex
        maxStatic: number;   // assetIndex (alias for maxRetained — legacy)
        maxSubmitted: number; // assetIndex (Phase 3: from server's submittedDegreeByAsset)
        /** Max active-pair count across positive candidates at this event. */
        maxActivePairs: number;
        /** Most-open negative-score candidate, or -1 when unavailable. */
        maxActiveReversion: number;
        /** Per-selector tie counts at this event (Phase 3 MAX_ACTIVE). */
        ties: Record<SelectorName, number>;
    }
    const views: EventView[] = [];
    for (let e = 0; e < events.length; e += 1) {
        const ev = events[e]!;
        const positives: Candidate[] = [];
        const negatives: Candidate[] = [];
        let maxActivePairs = 0;
        for (let a = 0; a < assetCount; a += 1) {
            const raw = ev.rawScore[a]!;
            const cnt = ev.activePairCount[a]!;
            if (raw > 0) {
                if (cnt > maxActivePairs) maxActivePairs = cnt;
                const adjusted = cnt > 0 ? raw / Math.sqrt(cnt) : raw;
                positives.push({
                    assetIndex: a,
                    raw,
                    adjusted,
                    mean: cnt > 0 ? raw / cnt : raw,
                    activePairs: cnt,
                    staticPairs: retainedDegree.get(assetNames[a]!) ?? 0,
                    submittedPairs: submittedDegree.size > 0
                        ? (submittedDegree.get(assetNames[a]!) ?? 0)
                        : (retainedDegree.get(assetNames[a]!) ?? 0),
                });
            } else if (raw < 0) {
                const adjusted = cnt > 0 ? raw / Math.sqrt(cnt) : raw;
                negatives.push({
                    assetIndex: a,
                    raw,
                    adjusted,
                    mean: cnt > 0 ? raw / cnt : raw,
                    activePairs: cnt,
                    staticPairs: retainedDegree.get(assetNames[a]!) ?? 0,
                    submittedPairs: submittedDegree.size > 0
                        ? (submittedDegree.get(assetNames[a]!) ?? 0)
                        : (retainedDegree.get(assetNames[a]!) ?? 0),
                });
            }
        }
        // Need >= 2 positive candidates for a top-vs-random comparison.
        if (positives.length >= 2) {
            // Phase 0 freeze: tie-break by the versioned FNV-1a 64 digest of
            // `MAX_ACTIVE_TIE_VERSION|tieSeed|truncatedEventTimeSec|scoringAsset`.
            // Smallest digest wins. Asset name and input order are NEVER
            // tie-breaks. On a digest collision (astronomically unlikely),
            // asset-name order keeps execution deterministic.
            const eventTimeSec = ev.timeSec;
            const digestFor = (c: Candidate): string => tieBreakDigest(eventTimeSec, assetNames[c.assetIndex]!);
            const pickMax = (candidates: readonly Candidate[], key: "raw" | "adjusted" | "mean" | "activePairs" | "staticPairs" | "submittedPairs"): { winner: Candidate; tiedCount: number } => {
                // First pass: find the max value.
                let maxValue = candidates[0]![key]!;
                for (let i = 1; i < candidates.length; i += 1) {
                    const v = candidates[i]![key]!;
                    if (v > maxValue) maxValue = v;
                }
                // Second pass: collect every candidate at the max, then pick by
                // tie-break digest. Counting at the end gives the correct tied
                // total regardless of input order.
                const tiedAtTop: Candidate[] = [];
                for (const c of candidates) {
                    if (c[key] === maxValue) tiedAtTop.push(c);
                }
                let winner = tiedAtTop[0]!;
                if (tiedAtTop.length > 1) {
                    // Precompute every tied candidate's digest ONCE and track the
                    // current winner's digest alongside the winner itself. The
                    // prior loop recomputed `digestFor(winner)` on every
                    // iteration — O(k) TextEncoder.encode + FNV hashes per tie
                    // event instead of O(1) lookup, and pickMax runs 6–7× per
                    // event across every event (Phase 3 hot path).
                    const digests = tiedAtTop.map(digestFor);
                    let dW = digests[0]!;
                    for (let i = 1; i < tiedAtTop.length; i += 1) {
                        const c = tiedAtTop[i]!;
                        const dC = digests[i]!;
                        if (dC < dW) { winner = c; dW = dC; }
                        else if (dC === dW) {
                            // Tie-digest collision. Asset name is the final
                            // deterministic fallback (collision is astronomically
                            // unlikely; no longer surfaced as a verdict flag —
                            // no consumer ever read it).
                            if (assetNames[c.assetIndex]! < assetNames[winner.assetIndex]!) { winner = c; dW = dC; }
                        }
                    }
                }
                return { winner, tiedCount: tiedAtTop.length };
            };
            const topRaw = pickMax(positives, "raw");
            const topAdjusted = pickMax(positives, "adjusted");
            const topMean = pickMax(positives, "mean");
            const maxActive = pickMax(positives, "activePairs");
            const maxStatic = pickMax(positives, "staticPairs");
            const maxSubmitted = pickMax(positives, "submittedPairs");
            const maxActiveReversion = negatives.length >= 2 ? pickMax(negatives, "activePairs") : null;
            views.push({
                timeSec: ev.timeSec, positives, negatives,
                topRaw: topRaw.winner.assetIndex,
                topAdjusted: topAdjusted.winner.assetIndex,
                topMean: topMean.winner.assetIndex,
                maxActive: maxActive.winner.assetIndex,
                maxStatic: maxStatic.winner.assetIndex,
                maxSubmitted: maxSubmitted.winner.assetIndex,
                maxActivePairs,
                maxActiveReversion: maxActiveReversion?.winner.assetIndex ?? -1,
                ties: {
                    RAW: topRaw.tiedCount >= 2 ? 1 : 0,
                    ADJUSTED: topAdjusted.tiedCount >= 2 ? 1 : 0,
                    MEAN: topMean.tiedCount >= 2 ? 1 : 0,
                    ACTIVE: maxActive.tiedCount >= 2 ? 1 : 0,
                    SUBMITTED: maxSubmitted.tiedCount >= 2 ? 1 : 0,
                    RETAINED: maxStatic.tiedCount >= 2 ? 1 : 0,
                    REVERSION: maxActiveReversion && maxActiveReversion.tiedCount >= 2 ? 1 : 0,
                },
            });
        }
        if (e % 1000 === 0) {
            onPhase("targets", `formed candidates for ${e}/${totalEvents} events`, e, totalEvents);
            await yieldLoop();
        }
    }

    // Group requested event indexes by asset so each target dataset is loaded
    // once, consumed, and released.
    const requestsByAsset = new Map<number, number[]>();
    const positiveRequestedAssets = new Set<number>();
    for (let v = 0; v < views.length; v += 1) {
        for (const c of views[v]!.positives) {
            positiveRequestedAssets.add(c.assetIndex);
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            list.push(v);
        }
        for (const c of views[v]!.negatives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            if (!list.includes(v)) list.push(v);
        }
    }

    // --- Phase 4: evaluate USD outcomes per target (load -> consume -> free) -
    // Per event-view, per horizon: net return for each candidate assetIndex.
    // Stored sparsely: only eligible-candidate assets are queried.
    const returnsByView: Array<Map<number, { long: number[]; short: number[] }> | null> = new Array(views.length).fill(null);
    const missingAssets = new Set<number>();
    const censoredEvents = new Set<number>();
    const noDataEvents = new Set<number>();

    let targetsSeen = 0;
    const totalTargets = requestsByAsset.size;
    onPhase("outcomes", "evaluating USD outcomes", 0, totalTargets);
    for await (const target of targetLoader()) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, totalEvents, reportLines: ["OPEN_SCORE USD | cancelled during outcome evaluation."] });
        const aIdx = assetIndexByName.get(target.asset.trim().toUpperCase());
        const requests = aIdx === undefined ? undefined : requestsByAsset.get(aIdx);
        if (aIdx === undefined || !requests || requests.length === 0) continue;
        targetsSeen += 1;
        const times = target.data.map((b) => timeToNumber(b.time));
        for (const viewIdx of requests) {
            const view = views[viewIdx]!;
            // First target bar strictly after the decision timestamp.
            const entryBar = firstBarAfter(times, view.timeSec);
            if (entryBar < 0) {
                if (positiveRequestedAssets.has(aIdx)) noDataEvents.add(viewIdx);
                continue;
            }
            let perAsset = returnsByView[viewIdx];
            if (!perAsset) { perAsset = new Map(); returnsByView[viewIdx] = perAsset; }
            const longReturns: number[] = [];
            const shortReturns: number[] = [];
            for (const h of horizons) {
                const exitBar = entryBar + h - 1; // h bars forward, close of that bar
                if (exitBar >= target.data.length) { longReturns.push(Number.NaN); shortReturns.push(Number.NaN); continue; }
                const rawOpen = target.data[entryBar]!.open;
                const exitClose = target.data[exitBar]!.close;
                if (!Number.isFinite(rawOpen) || rawOpen <= 0 || !Number.isFinite(exitClose) || exitClose <= 0) {
                    longReturns.push(Number.NaN);
                    shortReturns.push(Number.NaN);
                    continue;
                }
            // Long USD trade: buy at next bar open (slippage up), sell at
            // horizon close (slippage down), round-trip commission. Commission
            // is applied canonically (matches position-stats.ts): entryValue*rate
            // + exitValue*rate for a 1-unit notional. This is NOT a flat drag
            // off gross return — it varies with price level.
            const entryPrice = applySlippage(rawOpen, "buy", slippageRate);
            const exitPrice = applySlippage(exitClose, "sell", slippageRate);
            // size = 1 unit of the asset; entryValue=entryPrice, exitValue=exitPrice.
                const fees = (entryPrice + exitPrice) * commissionRate;
                const netReturn = (exitPrice - entryPrice - fees) / entryPrice;
                longReturns.push(Number.isFinite(netReturn) ? netReturn : Number.NaN);
                const shortEntryPrice = applySlippage(rawOpen, "sell", slippageRate);
                const shortExitPrice = applySlippage(exitClose, "buy", slippageRate);
                const shortFees = (shortEntryPrice + shortExitPrice) * commissionRate;
                const shortReturn = (shortEntryPrice - shortExitPrice - shortFees) / shortEntryPrice;
                shortReturns.push(Number.isFinite(shortReturn) ? shortReturn : Number.NaN);
            }
            perAsset.set(aIdx, { long: longReturns, short: shortReturns });
            if (longReturns.some((r) => !Number.isFinite(r))) censoredEvents.add(viewIdx);
        }
        onPhase("outcomes", `evaluated ${target.asset} (${targetsSeen}/${totalTargets})`, targetsSeen, totalTargets);
        await yieldLoop();
        // target OHLCV reference released here (goes out of scope next iteration).
    }

    // --- Phase 5: aggregate ------------------------------------------------
    onPhase("aggregate", "aggregating statistics", 0, horizons.length);

    // Determine, per horizon, which views are eligible: every candidate has a
    // finite return for that horizon, for both the treatment winner and all
    // other positives (the control). If the winner has missing data, omit the
    // event from BOTH arms — never substitute a different winner.
    const horizonResults: OpenScoreUsdReplayResult["horizons"] = [];
    let eligibleEventsMax = 0;
    for (let hIdx = 0; hIdx < horizons.length; hIdx += 1) {
        interface SelectorSeries {
            deltas: number[];
            returns: number[];
            times: number[];
            assets: string[];
        }
        const createSeries = (): SelectorSeries => ({ deltas: [], returns: [], times: [], assets: [] });
        const topRaw = createSeries();
        const topAdjusted = createSeries();
        const topMean = createSeries();
        const maxActiveReversion = createSeries();
        const maxActive = createSeries();
        const maxStatic = createSeries();
        const maxSubmitted = createSeries();
        // Phase 3 MAX_ACTIVE pairwise deltas: same-event return differences
        // between MAX_ACTIVE and the other selector, ONLY on events where
        // they pick different assets. Build them as parallel arrays so the
        // buildComparison() helper can derive block means and a CI.
        const activeVsSubmitted = createSeries();
        const activeVsRetained = createSeries();
        const activeVsRaw = createSeries();
        const activeVsMean = createSeries();
        // Phase 3 MAX_ACTIVE tie counters per selector.
        const tieCounts: Record<SelectorName, number> = { RAW: 0, ADJUSTED: 0, MEAN: 0, ACTIVE: 0, SUBMITTED: 0, RETAINED: 0, REVERSION: 0 };
        const selectedDegree: number[] = [];
        const activeCountsAtEvents: number[] = [];
        const selectedByAsset = new Map<string, number>();
        const topRawSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        // Per-asset selection map for TOP_MEAN (coverage-adjusted arm). Mirrors
        // topRawSamplesByAsset so the TOP_MEAN breakdown + EX_DOM lines can be
        // computed the same way as TOP_RAW's.
        const topMeanSelectedByAsset = new Map<string, number>();
        const topMeanSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        // Phase 3 MAX_ACTIVE: parallel per-asset selection map for MAX_ACTIVE.
        const activeSelectedByAsset = new Map<string, number>();
        const maxActiveSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const reversionSelectedByAsset = new Map<string, number>();
        const maxActiveReversionSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        let rawAdjustedSame = 0;

        for (let v = 0; v < views.length; v += 1) {
            const view = views[v]!;
            const perAsset = returnsByView[v];
            if (!perAsset) { noDataEvents.add(v); continue; }
            // Collect returns for all positives this horizon.
            const retByAsset = new Map<number, number>();
            let allValid = true;
            for (const c of view.positives) {
                const arr = perAsset.get(c.assetIndex);
                const r = arr ? arr.long[hIdx] : undefined;
                if (r === undefined || !Number.isFinite(r)) { allValid = false; break; }
                retByAsset.set(c.assetIndex, r);
            }
            if (!allValid) continue; // censored or missing -> omit from both arms

            let totalReturn = 0;
            for (const r of retByAsset.values()) totalReturn += r;
            const randomMeanOf = (selectedIdx: number): number => {
                const selectedReturn = retByAsset.get(selectedIdx);
                return selectedReturn === undefined || retByAsset.size < 2
                    ? Number.NaN
                    : (totalReturn - selectedReturn) / (retByAsset.size - 1);
            };
            const appendSelection = (series: SelectorSeries, selectedIdx: number): void => {
                const selectedReturn = retByAsset.get(selectedIdx)!;
                const randomMean = randomMeanOf(selectedIdx);
                series.returns.push(selectedReturn);
                series.deltas.push(selectedReturn - randomMean);
                series.times.push(view.timeSec);
                series.assets.push(assetNames[selectedIdx]!);
            };
            const appendPairwise = (series: SelectorSeries, aIdx: number, bIdx: number): void => {
                // Only on events where the two selectors pick DIFFERENT assets.
                if (aIdx === bIdx) return;
                const aReturn = retByAsset.get(aIdx);
                const bReturn = retByAsset.get(bIdx);
                if (aReturn === undefined || bReturn === undefined) return;
                // The "delta" is the difference in selected-asset return. The
                // "return" stored is MAX_ACTIVE's return so topMean = active's
                // mean in the comparison report.
                series.returns.push(aReturn);
                series.deltas.push(aReturn - bReturn);
                series.times.push(view.timeSec);
                series.assets.push(assetNames[aIdx]!);
            };

            appendSelection(topRaw, view.topRaw);
            appendSelection(topAdjusted, view.topAdjusted);
            appendSelection(topMean, view.topMean);
            appendSelection(maxActive, view.maxActive);
            appendSelection(maxStatic, view.maxStatic);
            appendSelection(maxSubmitted, view.maxSubmitted);
            // Pairwise: MAX_ACTIVE vs each control, only on differing-selection events.
            appendPairwise(activeVsSubmitted, view.maxActive, view.maxSubmitted);
            appendPairwise(activeVsRetained, view.maxActive, view.maxStatic);
            appendPairwise(activeVsRaw, view.maxActive, view.topRaw);
            appendPairwise(activeVsMean, view.maxActive, view.topMean);
            // Accumulate tie counts.
            (Object.keys(view.ties) as Array<SelectorName>).forEach((k) => {
                tieCounts[k] += view.ties[k];
            });
            if (view.topRaw === view.topAdjusted) rawAdjustedSame += 1;
            // candidateDegree reports ACTIVE PAIR COUNT at decision events
            // (per the plan), NOT the count of positive candidates. The
            // previous `view.positives.length` understated coverage and hid
            // the pair-balance question.
            activeCountsAtEvents.push(view.maxActivePairs);
            const selName = assetNames[view.topRaw]!;
            selectedByAsset.set(selName, (selectedByAsset.get(selName) ?? 0) + 1);
            let assetSamples = topRawSamplesByAsset.get(selName);
            if (!assetSamples) {
                assetSamples = { returns: [], deltas: [] };
                topRawSamplesByAsset.set(selName, assetSamples);
            }
            assetSamples.returns.push(topRaw.returns[topRaw.returns.length - 1]!);
            assetSamples.deltas.push(topRaw.deltas[topRaw.deltas.length - 1]!);
            // Phase 3 MAX_ACTIVE: separately track the MAX_ACTIVE winner's per-
            // asset selection counts so the dominant-asset exclusion measures
            // MAX_ACTIVE (the research hypothesis), NOT TOP_RAW.
            const activeSelName = assetNames[view.maxActive]!;
            activeSelectedByAsset.set(activeSelName, (activeSelectedByAsset.get(activeSelName) ?? 0) + 1);
            let activeSamples = maxActiveSamplesByAsset.get(activeSelName);
            if (!activeSamples) {
                activeSamples = { returns: [], deltas: [] };
                maxActiveSamplesByAsset.set(activeSelName, activeSamples);
            }
            activeSamples.returns.push(maxActive.returns[maxActive.returns.length - 1]!);
            activeSamples.deltas.push(maxActive.deltas[maxActive.deltas.length - 1]!);
            // TOP_MEAN per-asset samples (mirrors TOP_RAW and MAX_ACTIVE
            // accumulation). Lets the report surface which assets TOP_MEAN
            // actually picks and whether its edge survives dropping the
            // dominant one.
            const meanSelName = assetNames[view.topMean]!;
            topMeanSelectedByAsset.set(meanSelName, (topMeanSelectedByAsset.get(meanSelName) ?? 0) + 1);
            let meanSamples = topMeanSamplesByAsset.get(meanSelName);
            if (!meanSamples) {
                meanSamples = { returns: [], deltas: [] };
                topMeanSamplesByAsset.set(meanSelName, meanSamples);
            }
            meanSamples.returns.push(topMean.returns[topMean.returns.length - 1]!);
            meanSamples.deltas.push(topMean.deltas[topMean.deltas.length - 1]!);
            // selectedDegree = static pair degree of the TOP_RAW winner. This
            // was collected but never surfaced; the report now exposes it so
            // coverage bias on the actually-selected asset is visible.
            selectedDegree.push(staticDegree.get(selName) ?? 0);

            // Reversion selector: use the same event and candidate universe,
            // but select the most-open NEGATIVE-score asset and evaluate a
            // short asset/USD trade. Its random baseline is another negative
            // candidate from that event.
            if (view.negatives.length >= 2 && view.maxActiveReversion >= 0) {
                const shortByAsset = new Map<number, number>();
                let shortValid = true;
                for (const c of view.negatives) {
                    const arr = perAsset.get(c.assetIndex);
                    const r = arr ? arr.short[hIdx] : undefined;
                    if (r === undefined || !Number.isFinite(r)) { shortValid = false; break; }
                    shortByAsset.set(c.assetIndex, r);
                }
                if (shortValid) {
                    let shortTotal = 0;
                    for (const r of shortByAsset.values()) shortTotal += r;
                    const selectedReturn = shortByAsset.get(view.maxActiveReversion)!;
                    const randomReturn = (shortTotal - selectedReturn) / (shortByAsset.size - 1);
                    const delta = selectedReturn - randomReturn;
                    maxActiveReversion.returns.push(selectedReturn);
                    maxActiveReversion.deltas.push(delta);
                    maxActiveReversion.times.push(view.timeSec);
                    maxActiveReversion.assets.push(assetNames[view.maxActiveReversion]!);
                    const asset = assetNames[view.maxActiveReversion]!;
                    reversionSelectedByAsset.set(asset, (reversionSelectedByAsset.get(asset) ?? 0) + 1);
                    let samples = maxActiveReversionSamplesByAsset.get(asset);
                    if (!samples) {
                        samples = { returns: [], deltas: [] };
                        maxActiveReversionSamplesByAsset.set(asset, samples);
                    }
                    samples.returns.push(selectedReturn);
                    samples.deltas.push(delta);
                }
            }
        }

        const n = topRaw.deltas.length;
        eligibleEventsMax = Math.max(eligibleEventsMax, n);
        const buildComparison = (deltasArr: number[], topReturns: number[], times: number[]): ReplayComparison => {
            const sampleCount = deltasArr.length;
            if (sampleCount === 0) {
                return {
                    events: 0, topMean: null, randomMean: null, delta: null, topMedian: null,
                    blockMeans: [], ciLower: null, ciUpper: null, positiveBlocks: 0, totalBlocks: 0,
                };
            }
            const topMean = meanOrNull(topReturns);
            const deltaMean = meanOrNull(deltasArr);
            const randomMean = topMean !== null && deltaMean !== null ? finiteOrNull(topMean - deltaMean) : null;
            const sortedTop = [...topReturns].sort((a, b) => a - b);
            // Chronological blocks by event time.
            const blocks = splitIntoBlocks(deltasArr, times, blockCount);
            const blockMeans = blocks.map((blk) => blk.reduce((s, x) => s + x, 0) / blk.length);
            const { lower, upper } = blockBootstrapCi(blockMeans, bootstrapSamples);
            return {
                events: sampleCount,
                topMean,
                randomMean,
                delta: deltaMean,
                topMedian: finiteOrNull(median(sortedTop)),
                blockMeans,
                ciLower: lower,
                ciUpper: upper,
                positiveBlocks: blockMeans.filter((m) => m > 0).length,
                totalBlocks: blockMeans.length,
            };
        };

        const totalSelected = [...selectedByAsset.values()].reduce((s, x) => s + x, 0);
        const maxSelected = Math.max(0, ...selectedByAsset.values());
        const topRawByAsset: AssetSelectionSummary[] = [...selectedByAsset.entries()]
            .map(([asset, events]) => {
                const samples = topRawSamplesByAsset.get(asset)!;
                const selectedMean = meanOrNull(samples.returns);
                const delta = meanOrNull(samples.deltas);
                return {
                    asset,
                    events,
                    share: totalSelected > 0 ? events / totalSelected : 0,
                    topMean: selectedMean,
                    randomMean: selectedMean !== null && delta !== null ? finiteOrNull(selectedMean - delta) : null,
                    delta,
                };
            })
            .sort((a, b) => b.events - a.events || a.asset.localeCompare(b.asset));
        const dominantAsset = topRawByAsset[0]?.asset ?? null;
        const nonDominantIndexes: number[] = [];
        for (let i = 0; i < topRaw.assets.length; i += 1) {
            if (topRaw.assets[i] !== dominantAsset) nonDominantIndexes.push(i);
        }
        const topRawExDominant = buildComparison(
            nonDominantIndexes.map((i) => topRaw.deltas[i]!),
            nonDominantIndexes.map((i) => topRaw.returns[i]!),
            nonDominantIndexes.map((i) => topRaw.times[i]!),
        );
        // Phase 3 MAX_ACTIVE: dominant-asset exclusion measures MAX_ACTIVE
        // (the research hypothesis), NOT TOP_RAW. The most-frequently-selected
        // MAX_ACTIVE asset (ties by FNV-1a digest) is dropped; the remaining
        // events form the `maxActiveExDominant` comparison.
        const totalActiveSelected = [...activeSelectedByAsset.values()].reduce((s, x) => s + x, 0);
        const maxActiveByAsset: AssetSelectionSummary[] = [...activeSelectedByAsset.entries()]
            .map(([asset, events]) => {
                const samples = maxActiveSamplesByAsset.get(asset)!;
                const selectedMean = meanOrNull(samples.returns);
                const delta = meanOrNull(samples.deltas);
                return {
                    asset,
                    events,
                    share: totalActiveSelected > 0 ? events / totalActiveSelected : 0,
                    topMean: selectedMean,
                    randomMean: selectedMean !== null && delta !== null ? finiteOrNull(selectedMean - delta) : null,
                    delta,
                };
            })
            .sort((a, b) => b.events - a.events || a.asset.localeCompare(b.asset));
        const totalReversionSelected = [...reversionSelectedByAsset.values()].reduce((s, x) => s + x, 0);
        const maxActiveReversionByAsset: AssetSelectionSummary[] = [...reversionSelectedByAsset.entries()]
            .map(([asset, events]) => {
                const samples = maxActiveReversionSamplesByAsset.get(asset)!;
                const selectedMean = meanOrNull(samples.returns);
                const delta = meanOrNull(samples.deltas);
                return {
                    asset,
                    events,
                    share: totalReversionSelected > 0 ? events / totalReversionSelected : 0,
                    topMean: selectedMean,
                    randomMean: selectedMean !== null && delta !== null ? finiteOrNull(selectedMean - delta) : null,
                    delta,
                };
            })
            .sort((a, b) => b.events - a.events || a.asset.localeCompare(b.asset));
        const maxActiveDominantAsset = maxActiveByAsset[0]?.asset ?? null;
        const nonActiveDominantIndexes: number[] = [];
        for (let i = 0; i < maxActive.assets.length; i += 1) {
            if (maxActive.assets[i] !== maxActiveDominantAsset) nonActiveDominantIndexes.push(i);
        }
        const maxActiveExDominant = buildComparison(
            nonActiveDominantIndexes.map((i) => maxActive.deltas[i]!),
            nonActiveDominantIndexes.map((i) => maxActive.returns[i]!),
            nonActiveDominantIndexes.map((i) => maxActive.times[i]!),
        );
        // TOP_MEAN dominant-asset exclusion: mirrors maxActiveExDominant for
        // the coverage-adjusted arm. The most-frequently-selected TOP_MEAN
        // asset is dropped; the remaining events form the comparison.
        const totalMeanSelected = [...topMeanSelectedByAsset.values()].reduce((s, x) => s + x, 0);
        const topMeanByAsset: AssetSelectionSummary[] = [...topMeanSelectedByAsset.entries()]
            .map(([asset, events]) => {
                const samples = topMeanSamplesByAsset.get(asset)!;
                const selectedMean = meanOrNull(samples.returns);
                const delta = meanOrNull(samples.deltas);
                return {
                    asset,
                    events,
                    share: totalMeanSelected > 0 ? events / totalMeanSelected : 0,
                    topMean: selectedMean,
                    randomMean: selectedMean !== null && delta !== null ? finiteOrNull(selectedMean - delta) : null,
                    delta,
                };
            })
            .sort((a, b) => b.events - a.events || a.asset.localeCompare(b.asset));
        const topMeanDominantAsset = topMeanByAsset[0]?.asset ?? null;
        const nonMeanDominantIndexes: number[] = [];
        for (let i = 0; i < topMean.assets.length; i += 1) {
            if (topMean.assets[i] !== topMeanDominantAsset) nonMeanDominantIndexes.push(i);
        }
        const topMeanExDominant = buildComparison(
            nonMeanDominantIndexes.map((i) => topMean.deltas[i]!),
            nonMeanDominantIndexes.map((i) => topMean.returns[i]!),
            nonMeanDominantIndexes.map((i) => topMean.times[i]!),
        );
        // Reversion dominant-asset exclusion: mirrors maxActiveExDominant for
        // the short side. The most-frequently-selected MAX_ACTIVE_REVERSION
        // asset (ties already resolved by FNV-1a digest in pickMax) is dropped;
        // the remaining events form the comparison. Reads the same
        // maxActiveReversion series the long side reads for maxActive.
        const maxActiveReversionDominantAsset = maxActiveReversionByAsset[0]?.asset ?? null;
        const nonReversionDominantIndexes: number[] = [];
        for (let i = 0; i < maxActiveReversion.assets.length; i += 1) {
            if (maxActiveReversion.assets[i] !== maxActiveReversionDominantAsset) nonReversionDominantIndexes.push(i);
        }
        const maxActiveReversionExDominant = buildComparison(
            nonReversionDominantIndexes.map((i) => maxActiveReversion.deltas[i]!),
            nonReversionDominantIndexes.map((i) => maxActiveReversion.returns[i]!),
            nonReversionDominantIndexes.map((i) => maxActiveReversion.times[i]!),
        );
        // `maxRetained` is a documented backwards-compat alias for `maxStatic`
        // (identical selector on identical arrays). Compute the 10k-sample block
        // bootstrap ONCE and reuse the result for both fields — the prior
        // duplicate `buildComparison(maxStatic.deltas, ...)` burned 10k LCG
        // iterations + one sort + one 10k-element allocation per horizon.
        const maxStaticComparison = buildComparison(maxStatic.deltas, maxStatic.returns, maxStatic.times);
        horizonResults.push({
            bars: horizons[hIdx]!,
            topRaw: buildComparison(topRaw.deltas, topRaw.returns, topRaw.times),
            topAdjusted: buildComparison(topAdjusted.deltas, topAdjusted.returns, topAdjusted.times),
            topMean: buildComparison(topMean.deltas, topMean.returns, topMean.times),
            maxActiveReversion: buildComparison(maxActiveReversion.deltas, maxActiveReversion.returns, maxActiveReversion.times),
            maxActiveReversionByAsset,
            maxActiveReversionExDominant,
            maxActiveReversionDominantAsset,
            maxActive: buildComparison(maxActive.deltas, maxActive.returns, maxActive.times),
            maxStatic: maxStaticComparison,
            maxSubmitted: buildComparison(maxSubmitted.deltas, maxSubmitted.returns, maxSubmitted.times),
            maxRetained: maxStaticComparison,
            topRawExDominant,
            topMeanExDominant,
            topMeanDominantAsset,
            maxActiveExDominant,
            maxActiveDominantAsset,
            maxActiveByAsset,
            dominantAsset,
            rawAdjustedAgreement: {
                events: n,
                sameSelection: rawAdjustedSame,
                rate: n > 0 ? rawAdjustedSame / n : null,
            },
            activeVsSubmitted: buildComparison(activeVsSubmitted.deltas, activeVsSubmitted.returns, activeVsSubmitted.times),
            activeVsRetained: buildComparison(activeVsRetained.deltas, activeVsRetained.returns, activeVsRetained.times),
            activeVsRaw: buildComparison(activeVsRaw.deltas, activeVsRaw.returns, activeVsRaw.times),
            activeVsMean: buildComparison(activeVsMean.deltas, activeVsMean.returns, activeVsMean.times),
            topRawByAsset,
            topMeanByAsset,
            candidateDegree: degreeSummary(activeCountsAtEvents, totalSelected > 0 ? maxSelected / totalSelected : null),
            selectedDegree: degreeSummary(selectedDegree, totalSelected > 0 ? maxSelected / totalSelected : null),
            tieRates: {
                RAW: { events: n, sameSelection: tieCounts.RAW, rate: n > 0 ? tieCounts.RAW / n : null },
                ADJUSTED: { events: n, sameSelection: tieCounts.ADJUSTED, rate: n > 0 ? tieCounts.ADJUSTED / n : null },
                MEAN: { events: n, sameSelection: tieCounts.MEAN, rate: n > 0 ? tieCounts.MEAN / n : null },
                ACTIVE: { events: n, sameSelection: tieCounts.ACTIVE, rate: n > 0 ? tieCounts.ACTIVE / n : null },
                SUBMITTED: { events: n, sameSelection: tieCounts.SUBMITTED, rate: n > 0 ? tieCounts.SUBMITTED / n : null },
                RETAINED: { events: n, sameSelection: tieCounts.RETAINED, rate: n > 0 ? tieCounts.RETAINED / n : null },
                // Reversion's denominator is the reversion-eligible event count
                // (events with >= 2 negative candidates), NOT the positive-side n.
                REVERSION: {
                    events: maxActiveReversion.deltas.length,
                    sameSelection: tieCounts.REVERSION,
                    rate: maxActiveReversion.deltas.length > 0 ? tieCounts.REVERSION / maxActiveReversion.deltas.length : null,
                },
            },
        });
        onPhase("aggregate", `aggregated horizon ${horizons[hIdx]}`, hIdx + 1, horizons.length);
        await yieldLoop();
    }

    // Count omitted assets (requested but with no usable dataset at all).
    const assetsWithData = new Set<number>();
    for (const m of returnsByView.values()) {
        if (m) for (const k of m.keys()) {
            if (positiveRequestedAssets.has(k)) assetsWithData.add(k);
        }
    }
    for (const aIdx of positiveRequestedAssets) {
        if (!assetsWithData.has(aIdx)) missingAssets.add(aIdx);
    }
    const omittedAssets = missingAssets.size;
    if (omittedAssets > 0) {
        warnings.push(`${omittedAssets} candidate asset(s) had no usable target dataset; their events were omitted, not zero-filled: ${[...missingAssets].map((i) => assetNames[i]).join(", ")}.`);
    }
    if (noDataEvents.size > 0) {
        // noDataEvents were tracked but never surfaced — add the warning so a
        // missing target on one asset is visible as an omitted event count
        // rather than silently disappearing from the eligible total.
        warnings.push(`${noDataEvents.size} event(s) had no target bar strictly after the decision timestamp for at least one candidate; those events were omitted, not zero-filled.`);
    }
    if (censoredEvents.size > 0) {
        warnings.push(`${censoredEvents.size} event(s) were right-censored near a target dataset end for at least one horizon and excluded from that horizon.`);
    }
    // Reversion selector structural-empty check: if the negative pool never
    // produced >= 2 candidates at any event (e.g., a long-only pair universe),
    // every horizon's MAX_ACTIVE_REVERSION line shows events=0 with no
    // explanation. Surface a single warning so the empty reversion line is
    // interpretable instead of looking like a bug.
    if (totalEvents > 0 && horizonResults.length > 0) {
        const anyReversionEvents = horizonResults.some((h) => h.maxActiveReversion.events > 0);
        if (!anyReversionEvents) {
            warnings.push("Reversion selector contributed 0 events across all horizons; the pair universe did not produce enough negative-score assets at any decision event.");
        }
    }
    warnings.push("Stock/marked-leg datasets may carry split/corporate-action discontinuities; verify adjustment before treating this as a tradeable verdict.");
    warnings.push("Event-level selector study: does not model overlapping positions, adaptive exits, or capital compounding.");

    const complete = omittedPairs === 0 && omittedAssets === 0;
    const staticDegrees = assetNames.map((n) => staticDegree.get(n) ?? 0);
    const degree = degreeSummary(staticDegrees, null);

    const reportLines = buildReportLines({
        pairs: pairCount, assets: assetCount, complete, omittedPairs, omittedAssets,
        totalEvents, candidateEvents: views.length, eligibleEvents: eligibleEventsMax, horizons: horizonResults,
        degree, warnings, startedAt, horizonsList: horizons,
        interval: options.interval ?? null,
        sampleFromSec: options.sampleFromSec ?? null,
        sampleToSec: options.sampleToSec ?? null,
        slippageRate, commissionRate,
    });

    return {
        pairs: pairCount,
        assets: assetCount,
        complete,
        omittedPairs,
        omittedAssets,
        totalEvents,
        candidateEvents: views.length,
        eligibleEvents: eligibleEventsMax,
        horizons: horizonResults,
        degree,
        warnings,
        reportLines,
    };
}

// ============================================================================
// Internals
// ============================================================================

function yieldLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Comparator for ScoreDelta: (time, assetIndex, isEntry DESC). Entries before
 * exits at the same (time, asset) so the post-execution score reflects the new
 * position before any same-timestamp exit netting.
 */
function compareDeltas(a: ScoreDelta, b: ScoreDelta): number {
    return a.timeSec - b.timeSec
        || a.assetIndex - b.assetIndex
        || b.isEntry - a.isEntry;
}

/**
 * Binary min-heap k-way merge over per-pair delta streams. Bounded by
 * #streams (one heap slot per stream head), not #deltas — so a 1000+ pair run
 * with hundreds of thousands of deltas still has a small working set.
 *
 * Ties at the head of multiple streams are broken by stream index so the merge
 * order is deterministic run-to-run regardless of artifact arrival order.
 */
class KWayMergeHeap {
    private readonly streams: readonly ScoreDelta[][];
    /** Heap of stream indexes, keyed by the head delta's compareDeltas rank. */
    private readonly heap: number[] = [];
    /** Current read offset in each stream. */
    private readonly offsets: Int32Array;
    constructor(streams: readonly ScoreDelta[][]) {
        this.streams = streams;
        this.offsets = new Int32Array(streams.length);
        for (let s = 0; s < streams.length; s += 1) {
            if (streams[s]!.length > 0) this.heap.push(s);
        }
        // Heapify bottom-up.
        for (let i = (this.heap.length >> 1) - 1; i >= 0; i -= 1) this.siftDown(i);
    }
    get empty(): boolean { return this.heap.length === 0; }
    peekTime(): number {
        const s = this.heap[0]!;
        return this.streams[s]![this.offsets[s]!]!.timeSec;
    }
    pop(): ScoreDelta | undefined {
        if (this.heap.length === 0) return undefined;
        const s = this.heap[0]!;
        const off = this.offsets[s]!;
        const d = this.streams[s]![off]!;
        const next = off + 1;
        this.offsets[s] = next;
        if (next >= this.streams[s]!.length) {
            // Stream exhausted: swap head with tail and shrink.
            const last = this.heap.length - 1;
            this.heap[0] = this.heap[last]!;
            this.heap.pop();
            if (this.heap.length > 0) this.siftDown(0);
        } else {
            this.siftDown(0);
        }
        return d;
    }
    private less(a: number, b: number): boolean {
        const sa = this.streams[a]![this.offsets[a]!]!;
        const sb = this.streams[b]![this.offsets[b]!]!;
        const cmp = compareDeltas(sa, sb);
        // Stable tie-break on stream index -> deterministic regardless of
        // artifact arrival order.
        return cmp < 0 || (cmp === 0 && a < b);
    }
    private siftDown(root: number): void {
        const n = this.heap.length;
        while (true) {
            let smallest = root;
            const l = (root << 1) + 1;
            const r = (root << 1) + 2;
            if (l < n && this.less(this.heap[l]!, this.heap[smallest]!)) smallest = l;
            if (r < n && this.less(this.heap[r]!, this.heap[smallest]!)) smallest = r;
            if (smallest === root) return;
            const tmp = this.heap[root]!;
            this.heap[root] = this.heap[smallest]!;
            this.heap[smallest] = tmp;
            root = smallest;
        }
    }
}

/** Binary search: index of the first bar with time strictly greater than t, or -1. */
function firstBarAfter(times: readonly (number | null)[], t: number): number {
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = times[mid];
        if (v === null) { lo = mid + 1; continue; }
        if (v > t) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
}

/**
 * Split values into chronological blocks by their event times. Phase 0 freeze:
 * boundaries are `floor(block*n/k)..floor((block+1)*n/k)` for `k=blockCount`
 * (NOT `ceil(n/k)`), so each block is count-balanced and the partition covers
 * every index exactly once. Empty blocks are omitted; if any are omitted, the
 * block-bootstrap CI returns null (formal `INSUFFICIENT_DATA`).
 */
function splitIntoBlocks(values: readonly number[], times: readonly number[], blockCount: number): number[][] {
    const n = values.length;
    if (n === 0) return [];
    const order = times.map((_, i) => i).sort((a, b) => times[a]! - times[b]!);
    const k = Math.max(1, Math.min(blockCount, n));
    const blocks: number[][] = [];
    for (let b = 0; b < k; b += 1) {
        const start = Math.floor((b * n) / k);
        const end = Math.floor(((b + 1) * n) / k);
        if (end <= start) continue;
        const slice: number[] = [];
        for (let i = start; i < end; i += 1) slice.push(values[order[i]!]!);
        if (slice.length > 0) blocks.push(slice);
    }
    return blocks;
}

const fmtPct = (x: number | null): string => (x === null || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const fmtNum = (x: number | null): string => (x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));

function buildReportLines(args: {
    pairs: number; assets: number; complete: boolean; omittedPairs: number; omittedAssets: number;
    totalEvents: number; candidateEvents: number; eligibleEvents: number; horizons: OpenScoreUsdReplayResult["horizons"];
    degree: DegreeSummary; warnings: string[]; startedAt: number; horizonsList: number[];
    interval: string | null; sampleFromSec: number | null; sampleToSec: number | null;
    slippageRate: number; commissionRate: number;
}): string[] {
    const lines: string[] = [];
    const status = args.complete ? "DATA_COMPLETE" : "DATA_INCOMPLETE";
    const comparisonLine = (label: string, comparison: ReplayComparison): string =>
        `${label.padEnd(14)} n=${comparison.events} top=${fmtPct(comparison.topMean)} rand=${fmtPct(comparison.randomMean)} ` +
        `delta=${fmtPct(comparison.delta)} CI95=[${fmtPct(comparison.ciLower)},${fmtPct(comparison.ciUpper)}] ` +
        `+blocks=${comparison.positiveBlocks}/${comparison.totalBlocks}`;
    lines.push(`OPEN_SCORE USD | ${status} | pairs=${args.pairs} assets=${args.assets} events=${args.totalEvents} comparable=${args.candidateEvents} eligible=${args.eligibleEvents}`);
    lines.push(`config | interval=${args.interval ?? "n/a"} window=${args.sampleFromSec === null ? "start" : new Date(args.sampleFromSec * 1000).toISOString().slice(0, 10)}..${args.sampleToSec === null ? "end" : new Date(args.sampleToSec * 1000).toISOString().slice(0, 10)} horizons=[${args.horizonsList.join(",")}] slippageRate=${args.slippageRate} commissionRate=${args.commissionRate}`);
    lines.push(`retained pair degree min/median/max = ${args.degree.min}/${fmtNum(args.degree.median)}/${args.degree.max}`);
    lines.push("controls | TOP_MEAN=raw/activePairs MAX_ACTIVE=most open pairs MAX_ACTIVE_REVERSION=most open pairs among negative-score assets, shorted vs USD MAX_SUBMITTED=most submitted pairs MAX_RETAINED=most loaded artifacts");
    for (const h of args.horizons) {
        const coverageRate = args.candidateEvents > 0 ? h.topRaw.events / args.candidateEvents : 0;
        const coverageStatus = h.topRaw.events === 0
            ? "NO_USABLE_EVENTS"
            : h.topRaw.events < args.candidateEvents
                ? "PARTIAL"
                : "FULL";
        lines.push(`--- horizon ${h.bars} bar(s) | coverage=${h.topRaw.events}/${args.candidateEvents} (${(coverageRate * 100).toFixed(1)}%) ${coverageStatus} ---`);
        lines.push(comparisonLine("TOP_RAW", h.topRaw));
        lines.push(comparisonLine("TOP_ADJUSTED", h.topAdjusted));
        lines.push(comparisonLine("TOP_MEAN", h.topMean));
        lines.push(comparisonLine("MAX_ACTIVE", h.maxActive));
        lines.push(comparisonLine("MAX_ACTIVE_REVERSION", h.maxActiveReversion));
        lines.push(comparisonLine(`REVERSION_EX_${h.maxActiveReversionDominantAsset ?? "NONE"}`, h.maxActiveReversionExDominant));
        lines.push(comparisonLine("MAX_SUBMITTED", h.maxSubmitted));
        if (h.maxRetained.events !== h.maxSubmitted.events || h.maxRetained.delta !== h.maxSubmitted.delta) {
            lines.push(comparisonLine("MAX_RETAINED", h.maxRetained));
        }
        lines.push(comparisonLine(`RAW_EX_${h.dominantAsset ?? "NONE"}`, h.topRawExDominant));
        lines.push(comparisonLine(`MEAN_EX_${h.topMeanDominantAsset ?? "NONE"}`, h.topMeanExDominant));
        lines.push(comparisonLine(`ACTIVE_EX_${h.maxActiveDominantAsset ?? "NONE"}`, h.maxActiveExDominant));
        // Phase 3 MAX_ACTIVE: pairwise same-event deltas (only differing-selection events).
        lines.push(comparisonLine("ACTIVE_VS_SUB", h.activeVsSubmitted));
        if (h.activeVsRetained.events !== h.activeVsSubmitted.events || h.activeVsRetained.delta !== h.activeVsSubmitted.delta) {
            lines.push(comparisonLine("ACTIVE_VS_RET", h.activeVsRetained));
        }
        lines.push(comparisonLine("ACTIVE_VS_RAW", h.activeVsRaw));
        lines.push(comparisonLine("ACTIVE_VS_MEAN", h.activeVsMean));
        lines.push(`RAW/ADJUSTED agreement = ${h.rawAdjustedAgreement.sameSelection}/${h.rawAdjustedAgreement.events} (${h.rawAdjustedAgreement.rate === null ? "n/a" : (h.rawAdjustedAgreement.rate * 100).toFixed(1) + "%"})`);
        // Phase 3 MAX_ACTIVE: per-selector tie rate.
        const tieLine = (name: string, k: keyof typeof h.tieRates): string =>
            `${name}=${h.tieRates[k].sameSelection}/${h.tieRates[k].events} (${h.tieRates[k].rate === null ? "n/a" : (h.tieRates[k].rate! * 100).toFixed(1) + "%"})`;
        const tieTokens = [
            tieLine("RAW", "RAW"),
            tieLine("ADJ", "ADJUSTED"),
            tieLine("MEAN", "MEAN"),
            tieLine("ACTIVE", "ACTIVE"),
            tieLine("SUB", "SUBMITTED"),
        ];
        if (h.tieRates.RETAINED.sameSelection !== h.tieRates.SUBMITTED.sameSelection || h.tieRates.RETAINED.events !== h.tieRates.SUBMITTED.events) {
            tieTokens.push(tieLine("RET", "RETAINED"));
        }
        tieTokens.push(tieLine("REV", "REVERSION"));
        lines.push(`tie rates | ${tieTokens.join(" ")}`);
        const assetBreakdown = h.topRawByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW selected assets = ${assetBreakdown || "n/a"}${h.topRawByAsset.length > 5 ? ` | other=${h.topRawByAsset.length - 5} assets` : ""}`);
        const topMeanBreakdown = h.topMeanByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN selected assets = ${topMeanBreakdown || "n/a"}${h.topMeanByAsset.length > 5 ? ` | other=${h.topMeanByAsset.length - 5} assets` : ""}`);
        const maxActiveBreakdown = h.maxActiveByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`MAX_ACTIVE selected assets = ${maxActiveBreakdown || "n/a"}${h.maxActiveByAsset.length > 5 ? ` | other=${h.maxActiveByAsset.length - 5} assets` : ""}`);
        const maxActiveReversionBreakdown = h.maxActiveReversionByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`MAX_ACTIVE_REVERSION selected assets (short USD) = ${maxActiveReversionBreakdown || "n/a"}${h.maxActiveReversionByAsset.length > 5 ? ` | other=${h.maxActiveReversionByAsset.length - 5} assets` : ""}`);
        lines.push(`active pair count at events min/median/max = ${h.candidateDegree.min}/${fmtNum(h.candidateDegree.median)}/${h.candidateDegree.max} topAssetShare=${h.candidateDegree.topAssetShare === null ? "n/a" : (h.candidateDegree.topAssetShare * 100).toFixed(1) + "%"}`);
        lines.push(`selected TOP_RAW retained degree min/median/max = ${h.selectedDegree.min}/${fmtNum(h.selectedDegree.median)}/${h.selectedDegree.max}`);
    }
    for (const w of args.warnings) lines.push(`WARN: ${w}`);
    lines.push(`elapsed=${((Date.now() - args.startedAt) / 1000).toFixed(1)}s`);
    return lines;
}
