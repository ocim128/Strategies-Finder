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
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-state-miner";

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

export interface OpenScoreUsdReplayResult {
    pairs: number;
    assets: number;
    complete: boolean;
    omittedPairs: number;
    omittedAssets: number;
    totalEvents: number;
    eligibleEvents: number;
    horizons: Array<{
        bars: number;
        topRaw: ReplayComparison;
        topAdjusted: ReplayComparison;
        /** Active pair count at decision events (coverage at the event). */
        candidateDegree: DegreeSummary;
        /** Static pair degree of the selected TOP_RAW asset across events. */
        selectedDegree: DegreeSummary;
    }>;
    degree: DegreeSummary;
    warnings: string[];
    reportLines: string[];
}

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
 * blocks with replacement using a fixed-seed LCG so the CI is reproducible
 * run-to-run (no Math.random — research must be reproducible).
 */
function blockBootstrapCi(blockMeans: readonly number[], resamples: number): { lower: number | null; upper: number | null } {
    const b = blockMeans.length;
    if (b === 0) return { lower: null, upper: null };
    if (b === 1) return { lower: blockMeans[0]!, upper: blockMeans[0]! };
    let seed = 0x9e3779b9;
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
    const blockCount = Math.max(1, Math.floor(options.blockCount ?? 10));
    const bootstrapSamples = Math.max(200, Math.floor(options.bootstrapSamples ?? 2000));
    const warnings: string[] = [];

    const horizons = [...new Set(options.horizons.filter((h) => Number.isFinite(h) && h >= 1).map((h) => Math.floor(h)))].sort((a, b) => a - b);
    const emptyResult = (partial: Partial<OpenScoreUsdReplayResult>): OpenScoreUsdReplayResult => ({
        pairs: 0, assets: 0, complete: false, omittedPairs: 0, omittedAssets: 0,
        totalEvents: 0, eligibleEvents: 0, horizons: [], degree: degreeSummary([], null),
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
    const staticDegree = new Map<string, number>();
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
    interface Candidate { assetIndex: number; raw: number; adjusted: number; activePairs: number }
    interface EventView {
        timeSec: number;
        positives: Candidate[];
        topRaw: number;      // assetIndex
        topAdjusted: number; // assetIndex
        /** Max active-pair count across positive candidates at this event. */
        maxActivePairs: number;
    }
    const views: EventView[] = [];
    for (let e = 0; e < events.length; e += 1) {
        const ev = events[e]!;
        const positives: Candidate[] = [];
        let maxActivePairs = 0;
        for (let a = 0; a < assetCount; a += 1) {
            const raw = ev.rawScore[a]!;
            const cnt = ev.activePairCount[a]!;
            if (raw > 0) {
                if (cnt > maxActivePairs) maxActivePairs = cnt;
                const adjusted = cnt > 0 ? raw / Math.sqrt(cnt) : raw;
                positives.push({ assetIndex: a, raw, adjusted, activePairs: cnt });
            }
        }
        // Need >= 2 positive candidates for a top-vs-random comparison.
        if (positives.length >= 2) {
            // Deterministic tie-break: highest score, then asset name.
            const byName = (x: Candidate, y: Candidate): number => assetNames[x.assetIndex]!.localeCompare(assetNames[y.assetIndex]!);
            let topRaw = positives[0]!;
            let topAdjusted = positives[0]!;
            for (const c of positives) {
                if (c.raw > topRaw.raw || (c.raw === topRaw.raw && byName(c, topRaw) < 0)) topRaw = c;
                if (c.adjusted > topAdjusted.adjusted || (c.adjusted === topAdjusted.adjusted && byName(c, topAdjusted) < 0)) topAdjusted = c;
            }
            views.push({
                timeSec: ev.timeSec, positives,
                topRaw: topRaw.assetIndex, topAdjusted: topAdjusted.assetIndex,
                maxActivePairs,
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
    for (let v = 0; v < views.length; v += 1) {
        for (const c of views[v]!.positives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            list.push(v);
        }
    }

    // --- Phase 4: evaluate USD outcomes per target (load -> consume -> free) -
    // Per event-view, per horizon: net return for each candidate assetIndex.
    // Stored sparsely: only eligible-candidate assets are queried.
    const returnsByView: Array<Map<number, number[]> | null> = new Array(views.length).fill(null);
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
            if (entryBar < 0) { noDataEvents.add(viewIdx); continue; }
            let perAsset = returnsByView[viewIdx];
            if (!perAsset) { perAsset = new Map(); returnsByView[viewIdx] = perAsset; }
            const horizonReturns: number[] = [];
            for (const h of horizons) {
                const exitBar = entryBar + h - 1; // h bars forward, close of that bar
                if (exitBar >= target.data.length) { horizonReturns.push(Number.NaN); continue; }
                const rawOpen = target.data[entryBar]!.open;
                const exitClose = target.data[exitBar]!.close;
                if (!Number.isFinite(rawOpen) || rawOpen <= 0 || !Number.isFinite(exitClose) || exitClose <= 0) {
                    horizonReturns.push(Number.NaN);
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
            horizonReturns.push(Number.isFinite(netReturn) ? netReturn : Number.NaN);
            }
            perAsset.set(aIdx, horizonReturns);
            if (horizonReturns.some((r) => !Number.isFinite(r))) censoredEvents.add(viewIdx);
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
        const topRawDelta: number[] = [];
        const topAdjDelta: number[] = [];
        const topRawReturns: number[] = [];
        const topAdjReturns: number[] = [];
        const eventTimes: number[] = [];
        const selectedDegree: number[] = [];
        const activeCountsAtEvents: number[] = [];
        const selectedByAsset = new Map<string, number>();

        for (let v = 0; v < views.length; v += 1) {
            const view = views[v]!;
            const perAsset = returnsByView[v];
            if (!perAsset) { noDataEvents.add(v); continue; }
            // Collect returns for all positives this horizon.
            const retByAsset = new Map<number, number>();
            let allValid = true;
            for (const c of view.positives) {
                const arr = perAsset.get(c.assetIndex);
                const r = arr ? arr[hIdx] : undefined;
                if (r === undefined || !Number.isFinite(r)) { allValid = false; break; }
                retByAsset.set(c.assetIndex, r);
            }
            if (!allValid) continue; // censored or missing -> omit from both arms

            const randomMeanOf = (excludeIdx: number): number => {
                let s = 0, n = 0;
                for (const [aIdx, r] of retByAsset) {
                    if (aIdx === excludeIdx) continue;
                    s += r; n += 1;
                }
                return n > 0 ? s / n : Number.NaN;
            };

            const topRawRet = retByAsset.get(view.topRaw)!;
            const topAdjRet = retByAsset.get(view.topAdjusted)!;
            const randVsRaw = randomMeanOf(view.topRaw);
            const randVsAdj = randomMeanOf(view.topAdjusted);
            if (!Number.isFinite(randVsRaw) || !Number.isFinite(randVsAdj)) continue;

            topRawReturns.push(topRawRet);
            topAdjReturns.push(topAdjRet);
            topRawDelta.push(topRawRet - randVsRaw);
            topAdjDelta.push(topAdjRet - randVsAdj);
            eventTimes.push(view.timeSec);
            // candidateDegree reports ACTIVE PAIR COUNT at decision events
            // (per the plan), NOT the count of positive candidates. The
            // previous `view.positives.length` understated coverage and hid
            // the pair-balance question.
            activeCountsAtEvents.push(view.maxActivePairs);
            const selName = assetNames[view.topRaw]!;
            selectedByAsset.set(selName, (selectedByAsset.get(selName) ?? 0) + 1);
            // selectedDegree = static pair degree of the TOP_RAW winner. This
            // was collected but never surfaced; the report now exposes it so
            // coverage bias on the actually-selected asset is visible.
            selectedDegree.push(staticDegree.get(selName) ?? 0);
        }

        const n = topRawDelta.length;
        eligibleEventsMax = Math.max(eligibleEventsMax, n);
        const buildComparison = (deltasArr: number[], topReturns: number[]): ReplayComparison => {
            if (n === 0) {
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
            const blocks = splitIntoBlocks(deltasArr, eventTimes, blockCount);
            const blockMeans = blocks.map((blk) => blk.reduce((s, x) => s + x, 0) / blk.length);
            const { lower, upper } = blockBootstrapCi(blockMeans, bootstrapSamples);
            return {
                events: n,
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
        horizonResults.push({
            bars: horizons[hIdx]!,
            topRaw: buildComparison(topRawDelta, topRawReturns),
            topAdjusted: buildComparison(topAdjDelta, topAdjReturns),
            candidateDegree: degreeSummary(activeCountsAtEvents, totalSelected > 0 ? maxSelected / totalSelected : null),
            selectedDegree: degreeSummary(selectedDegree, totalSelected > 0 ? maxSelected / totalSelected : null),
        });
        onPhase("aggregate", `aggregated horizon ${horizons[hIdx]}`, hIdx + 1, horizons.length);
        await yieldLoop();
    }

    // Count omitted assets (requested but with no usable dataset at all).
    const assetsWithData = new Set<number>();
    for (const m of returnsByView.values()) {
        if (m) for (const k of m.keys()) assetsWithData.add(k);
    }
    for (const aIdx of requestsByAsset.keys()) {
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
    warnings.push("Stock/marked-leg datasets may carry split/corporate-action discontinuities; verify adjustment before treating this as a tradeable verdict.");
    warnings.push("Event-level selector study: does not model overlapping positions, adaptive exits, or capital compounding.");

    const complete = omittedPairs === 0 && omittedAssets === 0;
    const staticDegrees = assetNames.map((n) => staticDegree.get(n) ?? 0);
    const degree = degreeSummary(staticDegrees, null);

    const reportLines = buildReportLines({
        pairs: pairCount, assets: assetCount, complete, omittedPairs, omittedAssets,
        totalEvents, eligibleEvents: eligibleEventsMax, horizons: horizonResults,
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

/** Split values into chronological blocks by their event times. */
function splitIntoBlocks(values: readonly number[], times: readonly number[], blockCount: number): number[][] {
    const n = values.length;
    if (n === 0) return [];
    const order = times.map((_, i) => i).sort((a, b) => times[a]! - times[b]!);
    const blocks: number[][] = [];
    const k = Math.min(blockCount, n);
    const per = Math.ceil(n / k);
    for (let b = 0; b < n; b += per) {
        const slice = order.slice(b, b + per).map((i) => values[i]!);
        if (slice.length > 0) blocks.push(slice);
    }
    return blocks;
}

const fmtPct = (x: number | null): string => (x === null || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const fmtNum = (x: number | null): string => (x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));

function buildReportLines(args: {
    pairs: number; assets: number; complete: boolean; omittedPairs: number; omittedAssets: number;
    totalEvents: number; eligibleEvents: number; horizons: OpenScoreUsdReplayResult["horizons"];
    degree: DegreeSummary; warnings: string[]; startedAt: number; horizonsList: number[];
    interval: string | null; sampleFromSec: number | null; sampleToSec: number | null;
    slippageRate: number; commissionRate: number;
}): string[] {
    const lines: string[] = [];
    const status = args.complete ? "COMPLETE" : "INCOMPLETE";
    lines.push(`OPEN_SCORE USD | ${status} | pairs=${args.pairs} assets=${args.assets} events=${args.totalEvents} eligible=${args.eligibleEvents}`);
    lines.push(`config | interval=${args.interval ?? "n/a"} window=${args.sampleFromSec === null ? "start" : new Date(args.sampleFromSec * 1000).toISOString().slice(0, 10)}..${args.sampleToSec === null ? "end" : new Date(args.sampleToSec * 1000).toISOString().slice(0, 10)} horizons=[${args.horizonsList.join(",")}] slippageRate=${args.slippageRate} commissionRate=${args.commissionRate}`);
    lines.push(`static pair degree min/median/max = ${args.degree.min}/${fmtNum(args.degree.median)}/${args.degree.max}`);
    for (const h of args.horizons) {
        lines.push(`--- horizon ${h.bars} bar(s) ---`);
        lines.push(
            `TOP_RAW      n=${h.topRaw.events} top=${fmtPct(h.topRaw.topMean)} rand=${fmtPct(h.topRaw.randomMean)} ` +
            `delta=${fmtPct(h.topRaw.delta)} CI95=[${fmtPct(h.topRaw.ciLower)},${fmtPct(h.topRaw.ciUpper)}] ` +
            `+blocks=${h.topRaw.positiveBlocks}/${h.topRaw.totalBlocks}`,
        );
        lines.push(
            `TOP_ADJUSTED n=${h.topAdjusted.events} top=${fmtPct(h.topAdjusted.topMean)} rand=${fmtPct(h.topAdjusted.randomMean)} ` +
            `delta=${fmtPct(h.topAdjusted.delta)} CI95=[${fmtPct(h.topAdjusted.ciLower)},${fmtPct(h.topAdjusted.ciUpper)}] ` +
            `+blocks=${h.topAdjusted.positiveBlocks}/${h.topAdjusted.totalBlocks}`,
        );
        lines.push(`active pair count at events min/median/max = ${h.candidateDegree.min}/${fmtNum(h.candidateDegree.median)}/${h.candidateDegree.max} topAssetShare=${h.candidateDegree.topAssetShare === null ? "n/a" : (h.candidateDegree.topAssetShare * 100).toFixed(1) + "%"}`);
        lines.push(`selected TOP_RAW static degree min/median/max = ${h.selectedDegree.min}/${fmtNum(h.selectedDegree.median)}/${h.selectedDegree.max}`);
    }
    for (const w of args.warnings) lines.push(`WARN: ${w}`);
    lines.push(`elapsed=${((Date.now() - args.startedAt) / 1000).toFixed(1)}s`);
    return lines;
}
