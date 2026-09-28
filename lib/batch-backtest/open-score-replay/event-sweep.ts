/**
 * Replay stage 2 — time-bucketed merge of per-pair delta streams into
 * decision events. Buckets deltas by decision time (three O(deltas) sequential
 * passes) and walks buckets in ascending time order, maintaining the ordinary,
 * profit-gated, causal PROFIT_NOW, and confidence-weighted accumulators and
 * snapshotting them on entry events. Consumes the scan's per-pair streams and
 * clears them (the flat bucketed arrays become the only delta indexing).
 */
import type { DecisionEvent, ReplayPhaseCallback, ScoreDelta, StageOutcome } from "./internal-types";
import { yieldLoop } from "./runtime";

export interface EventSweepResult {
    /** Decision events in ascending timeSec order (entry buckets only). */
    events: DecisionEvent[];
}

export async function sweepScoreEvents(args: {
    streams: ScoreDelta[][];
    profitableStreams: readonly boolean[];
    sampleFromSec: number | undefined;
    sampleToSec: number | undefined;
    shouldStop: () => boolean;
    onPhase: ReplayPhaseCallback;
    /** Report-window pair/asset counts reused by cancellation early exits. */
    pairCount: number;
    assetCount: number;
}): Promise<StageOutcome<EventSweepResult>> {
    const { streams, profitableStreams, sampleFromSec, sampleToSec, shouldStop, onPhase, pairCount, assetCount } = args;
    const totalDeltas = streams.reduce((s, st) => s + st.length, 0);
    // --- Phase 2: time-bucketed merge -> decision events + candidates ------
    // The prior implementation merged streams with a binary k-way heap: that
    // is O(deltas × log2(streams)) with a cache-hostile random access per pop,
    // which dominated replay time on a 100k-pair run (hundreds of seconds).
    // Every accumulator the merge maintains is ADDITIVE within a timestamp
    // group, so delta order INSIDE a group cannot change results. Deltas are
    // therefore bucketed by decision time into one flat array (three O(deltas)
    // sequential passes) and the sweep walks buckets in ascending time order
    // with the exact same per-group semantics as the heap version. Cross-group
    // order is strict by timeSec, as before; within-group order is stream-index
    // order, which is deterministic run-to-run regardless of artifact arrival
    // order. Yields still fire after bounded pops so progress and Stop reach
    // the server mid-merge on a huge pair list.
    onPhase("events", "merging score deltas", 0, totalDeltas);
    // 1. Distinct decision times. Each stream is already sorted by timeSec, so
    // walking its equal-time runs visits each of its distinct times once.
    const timeIndex = new Map<number, number>();
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        for (let i = 0; i < stream.length; i += 1) {
            const t = stream[i]!.timeSec;
            if (i > 0 && stream[i - 1]!.timeSec === t) continue;
            if (!timeIndex.has(t)) timeIndex.set(t, timeIndex.size);
        }
        if (s % 25_000 === 24_999) await yieldLoop();
    }
    const bucketTimes = Float64Array.from([...timeIndex.keys()].sort((a, b) => a - b));
    for (let b = 0; b < bucketTimes.length; b += 1) timeIndex.set(bucketTimes[b]!, b);
    // 2. Count deltas per bucket (run-walking again, one Map lookup per run).
    const runCounts = new Uint32Array(bucketTimes.length);
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        let i = 0;
        while (i < stream.length) {
            const t = stream[i]!.timeSec;
            let j = i + 1;
            while (j < stream.length && stream[j]!.timeSec === t) j += 1;
            runCounts[timeIndex.get(t)!] += j - i;
            i = j;
        }
    }
    const bucketStart = new Uint32Array(bucketTimes.length + 1);
    for (let b = 0; b < bucketTimes.length; b += 1) {
        bucketStart[b + 1] = bucketStart[b]! + runCounts[b]!;
    }
    // 3. Place deltas into the flat, time-ordered array. Iterating streams in
    // stream-index order makes within-bucket order deterministic.
    const flatDeltas = new Array<ScoreDelta>(totalDeltas);
    const flatStreamIdx = new Uint32Array(totalDeltas);
    const placementCursor = bucketStart.slice();
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        for (let i = 0; i < stream.length; i += 1) {
            const d = stream[i]!;
            const bucketIdx = timeIndex.get(d.timeSec)!;
            const slot = placementCursor[bucketIdx]!;
            flatDeltas[slot] = d;
            flatStreamIdx[slot] = s;
            placementCursor[bucketIdx] = slot + 1;
        }
    }
    // The bucketed arrays now own every delta; drop the per-stream arrays so
    // the sweep does not retain a second indexing of the delta set.
    streams.length = 0;
    timeIndex.clear();

    const rawScore = new Array<number>(assetCount).fill(0);
    const activePairCount = new Array<number>(assetCount).fill(0);
    // Profit-gated accumulators: identical bookkeeping, fed only by deltas from
    // profitable pairs. The TOP_RAW_PROFIT / TOP_MEAN_PROFIT arms read
    // these; every other arm is untouched by the filter.
    const profitRawScore = new Array<number>(assetCount).fill(0);
    const profitPairCount = new Array<number>(assetCount).fill(0);
    // Causal PROFIT_NOW accumulators: fed by deltas from pairs whose pnl
    // realized SO FAR is strictly positive, evaluated at each event (see the
    // post-group apply below).
    const profitNowRawScore = new Array<number>(assetCount).fill(0);
    const profitNowPairCount = new Array<number>(assetCount).fill(0);
    const profitNowConfidenceScore = new Array<number>(assetCount).fill(0);
    const profitNowConfidencePairCount = new Array<number>(assetCount).fill(0);
    // Running realized pnl per stream (sum of exit deltas' pnlShare popped so
    // far). Exits at the event timestamp are applied before the post-group
    // mask evaluation, so their pnl is known at that event.
    const realizedPnlByStream = new Float64Array(profitableStreams.length);
    // Causal PROFIT_NOW vote applicability travels ON each delta
    // (ScoreDelta.voteApplied, precomputed per trade at scan time), so the
    // post-group apply below needs no per-stream state; the apply replays the
    // flat bucket range directly (event-sweep plan phase 3).
    let events: DecisionEvent[] = [];
    const sampleFrom = sampleFromSec;
    const sampleTo = sampleToSec;
    // Sweep bound (event-sweep plan phase 2): buckets are ascending, so once
    // a timestamp passes the finite inclusive sampleToSec no further event
    // can be stored — stop before applying that bucket. The pre-window
    // buckets still run to completion (starting at sampleFromSec would lose
    // carried positions and causal state), and the artifact scan, ledger,
    // static degrees, profitability flags, and cap-tilt coverage above
    // intentionally describe the full artifact and stay untouched.
    const sweepDeltaTotal = sampleTo === undefined
        ? totalDeltas
        : (() => {
            let lo = 0;
            let hi = bucketTimes.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if ((bucketTimes[mid] ?? Number.POSITIVE_INFINITY) > sampleTo) hi = mid;
                else lo = mid + 1;
            }
            // Deltas strictly before the first out-of-bounds bucket.
            return lo < bucketStart.length ? (bucketStart[lo] ?? totalDeltas) : totalDeltas;
        })();

    let popped = 0;
    for (let b = 0; b < bucketTimes.length; b += 1) {
        if (shouldStop()) return { ok: false, earlyExit: { reportLine: "OPEN_SCORE USD | cancelled during event sweep.", pairs: pairCount, assets: assetCount } };
        const t = bucketTimes[b]!;
        if (sampleTo !== undefined && t > sampleTo) break;
        let hasEntry = false;
        // Apply ALL deltas at this timestamp before forming candidates.
        const bucketEnd = bucketStart[b + 1]!;
        for (let i = bucketStart[b]!; i < bucketEnd; i += 1) {
            if (shouldStop()) return { ok: false, earlyExit: { reportLine: "OPEN_SCORE USD | cancelled during event sweep.", pairs: pairCount, assets: assetCount } };
            const d = flatDeltas[i]!;
            const streamIdx = flatStreamIdx[i]!;
            rawScore[d.assetIndex]! += d.delta;
            // activePairCount tracks currently-open pairs on this asset: an
            // entry adds a vote, an exit removes it (clamped at 0). Using
            // abs(delta) here was wrong because it incremented on BOTH entry
            // and exit, inflating the adjusted-score denominator after every
            // round-trip and corrupting TOP_ADJUSTED selection.
            const countDelta = d.isEntry === 1 ? 1 : -1;
            const next = activePairCount[d.assetIndex]! + countDelta;
            activePairCount[d.assetIndex] = next > 0 ? next : 0;
            if (d.isEntry === 0) realizedPnlByStream[streamIdx] += d.pnlShare;
            // Profit-gated mirror: only deltas from pairs whose FULL backtest
            // netted positive (static mask).
            if (profitableStreams[streamIdx]!) {
                profitRawScore[d.assetIndex]! += d.delta;
                const nextPnl = profitPairCount[d.assetIndex]! + countDelta;
                profitPairCount[d.assetIndex] = nextPnl > 0 ? nextPnl : 0;
            }
            if (d.isEntry === 1) hasEntry = true;
            popped += 1;
            // A single timestamp can contain many pair deltas. Check and yield
            // inside the timestamp group so Stop remains observable even before
            // all same-time deltas have been applied. Candidate formation still
            // waits until the group is complete below.
            if (popped % 2000 === 0) {
                // The denominator is the bounded sweep total — the same
                // bucket-boundary derivation stops the loop — so progress
                // stays monotonic and reaches 100% without claiming the
                // unvisited post-bound deltas were processed.
                onPhase("events", `merged ${popped}/${sweepDeltaTotal} deltas`, popped, sweepDeltaTotal);
                await yieldLoop();
            }
        }
        // Causal PROFIT_NOW apply. Runs for EVERY timestamp group — including
        // exit-only ones that form no decision event — so the accumulators
        // stay an exact image of "open votes of pairs profitable so far".
        // (Gating this on hasEntry leaked votes: a masked pair exiting on an
        // exit-only timestamp never had its vote subtracted.) The pair's own
        // exit already updated realizedPnlByStream, so masks here are the
        // point-in-time profitability AT this event. Pairs whose realized
        // pnl-so-far is <= 0 (including those with no per-trade pnl) are
        // muted. Exits are applied before entries so a same-timestamp
        // re-entry accounts both legs of the round trip exactly.
        //
        // Event-sweep plan phase 3: replay the SAME bucket range over the
        // original ScoreDelta objects instead of the per-delta copies this
        // loop used to consume — the deltas are not mutated between passes,
        // and the second pass reads only fields the first pass never touches
        // (voteApplied/delta/isEntry/profitNowConfidenceWeight), so operation
        // order and every accumulated value are identical without the
        // per-delta object allocation.
        const bucketStartIndex = bucketStart[b]!;
        for (let i = bucketStartIndex; i < bucketEnd; i += 1) {
            const d = flatDeltas[i]!;
            if (!d.voteApplied) continue;
            profitNowRawScore[d.assetIndex]! += d.delta;
            const countDeltaNow = d.isEntry === 1 ? 1 : -1;
            const nextNow = profitNowPairCount[d.assetIndex]! + countDeltaNow;
            profitNowPairCount[d.assetIndex] = nextNow > 0 ? nextNow : 0;
            if (d.profitNowConfidenceWeight > 0) {
                profitNowConfidenceScore[d.assetIndex]! += d.delta * d.profitNowConfidenceWeight;
                const nextConfidence = profitNowConfidencePairCount[d.assetIndex]! + countDeltaNow;
                profitNowConfidencePairCount[d.assetIndex] = nextConfidence > 0 ? nextConfidence : 0;
            }
        }
        // Exit-only score changes do not create a decision event.
        if (hasEntry) {
            if ((sampleFrom === undefined || t >= sampleFrom) && (sampleTo === undefined || t <= sampleTo)) {
                events.push({
                    timeSec: t,
                    rawScore: Float64Array.from(rawScore),
                    activePairCount: Float64Array.from(activePairCount),
                    rawScoreProfit: Float64Array.from(profitRawScore),
                    activePairCountProfit: Float64Array.from(profitPairCount),
                    rawScoreProfitNow: Float64Array.from(profitNowRawScore),
                    activePairCountProfitNow: Float64Array.from(profitNowPairCount),
                    rawScoreProfitNowConf: Float64Array.from(profitNowConfidenceScore),
                    activePairCountProfitNowConf: Float64Array.from(profitNowConfidencePairCount),
                });
            }
        }
    }
    return { ok: true, result: { events } };
}
