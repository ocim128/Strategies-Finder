/**
 * Replay stage 2 — time-bucketed merge of per-pair delta streams into
 * decision events. Buckets deltas by decision time (three O(deltas) sequential
 * passes) and walks buckets in ascending time order, maintaining the ordinary,
 * profit-gated, causal PROFIT_NOW, and confidence-weighted accumulators and
 * snapshotting them on entry events. Consumes the scan's per-pair streams and
 * clears them (the flat bucketed arrays become the only delta indexing).
 */
import type { DecisionEvent, ReplayPhaseCallback, StageOutcome } from "./internal-types";
import { ScoreDeltaBuffer } from "./score-delta-buffer";
import { yieldLoop } from "./runtime";

import { parseIntervalSeconds } from "../../interval-utils";
import { TemporalSupport } from "./temporal-support";
import { buildNameRanks, scoreGraphStrength } from "./graph-strength";
import { CAUSAL_ARM_FIELDS } from "./arm-contract";
import { FINDER_CAUSAL_ARMS_V1 } from "./causal-arm-constants";
import { insertRankingPick, RANKING_ARM_SPECS } from "./candidate-selection";
import type { CausalScoreKeys, CausalCompactArms } from "./internal-types";
import type { CausalArmDiagnostics } from "./types";

const SWEEP_CHUNK_SIZE = 2_000;

export interface EventSweepResult {
    /** Decision events in ascending timeSec order (entry buckets only). */
    events: DecisionEvent[];
    causalArmDiagnostics?: CausalArmDiagnostics;
}

export async function sweepScoreEvents(args: {
    enableCausalArms?: boolean;
    interval?: string;
    mode?: "horizon" | "asset_switch";
    assetNames?: readonly string[];
    validDegree?: Map<string, number>;
    pairEndpoints?: Array<{ base: number; quote: number } | null>;
    streams: ScoreDeltaBuffer[];
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
    // order. Each linear indexing/counting/placement pass yields at bounded
    // delta intervals so progress and Stop reach the server before the final
    // accumulator sweep on a huge pair list.
    const cancelled = (): StageOutcome<EventSweepResult> => ({
        ok: false,
        earlyExit: { reportLine: "OPEN_SCORE USD | cancelled during event sweep.", pairs: pairCount, assets: assetCount },
    });
    const yieldAtBoundary = async (
        detail: string,
        completed: number,
        total = totalDeltas,
    ): Promise<boolean> => {
        onPhase("events", `${detail} ${completed}/${total}`, completed, total);
        await yieldLoop();
        return shouldStop();
    };
    onPhase("events", "merging score deltas", 0, totalDeltas);
    if (shouldStop()) return cancelled();
    // 1. Distinct decision times. Each stream is already sorted by timeSec, so
    // walking its equal-time runs visits each of its distinct times once.
    const timeIndex = new Map<number, number>();
    let indexedDeltas = 0;
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        for (let i = 0; i < stream.length; i += 1) {
            const t = stream.timeSecs[i]!;
            indexedDeltas += 1;
            if (indexedDeltas % SWEEP_CHUNK_SIZE === 0
                && await yieldAtBoundary("indexed decision times", indexedDeltas)) return cancelled();
            if (i === 0 || stream.timeSecs[i - 1] !== t) {
                if (!timeIndex.has(t)) timeIndex.set(t, timeIndex.size);
            }
        }
    }
    onPhase("events", "sorting decision times", 0, timeIndex.size);
    await yieldLoop();
    if (shouldStop()) return cancelled();
    const sortedTimes = [...timeIndex.keys()].sort((a, b) => a - b);
    // Native sorting is synchronous. Yield on both sides so a Stop received
    // before it is honored immediately and one received during it is handled
    // before any of the following bucket work starts.
    await yieldLoop();
    if (shouldStop()) return cancelled();
    const bucketTimes = new Float64Array(sortedTimes.length);
    for (let b = 0; b < sortedTimes.length; b += 1) {
        const time = sortedTimes[b]!;
        bucketTimes[b] = time;
        timeIndex.set(time, b);
        if ((b + 1) % SWEEP_CHUNK_SIZE === 0
            && await yieldAtBoundary("indexed decision buckets", b + 1, sortedTimes.length)) return cancelled();
    }
    sortedTimes.length = 0;
    // 2. Count deltas per bucket (run-walking again, one Map lookup per run).
    const runCounts = new Uint32Array(bucketTimes.length);
    let countedDeltas = 0;
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        let i = 0;
        while (i < stream.length) {
            const t = stream.timeSecs[i]!;
            let j = i;
            while (j < stream.length && stream.timeSecs[j] === t) {
                j += 1;
                countedDeltas += 1;
                if (countedDeltas % SWEEP_CHUNK_SIZE === 0
                    && await yieldAtBoundary("counted event deltas", countedDeltas)) return cancelled();
            }
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
    const flatDeltas = new ScoreDeltaBuffer(totalDeltas, undefined, args.enableCausalArms);
    const flatStreamIdx = new Uint32Array(totalDeltas);
    const placementCursor = bucketStart.slice();
    let placedDeltas = 0;
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        for (let i = 0; i < stream.length; i += 1) {
            const bucketIdx = timeIndex.get(stream.timeSecs[i]!)!;
            const slot = placementCursor[bucketIdx]!;
            flatDeltas.copyFrom(slot, stream, i);
            flatStreamIdx[slot] = s;
            placementCursor[bucketIdx] = slot + 1;
            placedDeltas += 1;
            if (placedDeltas % SWEEP_CHUNK_SIZE === 0
                && await yieldAtBoundary("placed event deltas", placedDeltas)) return cancelled();
        }
        // Release each source as it is copied, rather than retaining both
        // complete columnar representations until placement finishes.
        streams[s] = null as unknown as ScoreDeltaBuffer;
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

    const interval = parseIntervalSeconds(args.interval ?? "");
    if (args.enableCausalArms && (!interval || !args.validDegree || !args.pairEndpoints || !args.assetNames)) throw new Error("Causal arms require interval and valid scan metadata.");
    const support = args.enableCausalArms ? new TemporalSupport(interval! * FINDER_CAUSAL_ARMS_V1.supportIntervals, bucketTimes[0]!) : null;
    // Integer name ranks replace per-comparison `localeCompare` inside the
    // graph solve; built once, they reproduce the identical ordering.
    const nameRanks = support ? buildNameRanks(args.assetNames!) : null;
    const pairVotes = support ? new Float64Array(profitableStreams.length) : null;
    const pairCounts = support ? new Float64Array(profitableStreams.length) : null;
    // Incremental open-pair list: the graph solve used to flatMap over ALL
    // pair endpoints on every entry bucket (O(pairs) scans + object spreads
    // per bucket). pairCounts only transitions 0 <-> positive on a pair's own
    // base-leg deltas, so maintain the open set as a swap-remove list here and
    // hand the solver exactly the open edges.
    const openPairList: number[] = [];
    const openPairPos = support ? new Int32Array(profitableStreams.length).fill(-1) : null;
    const graphEdgePool: Array<{ base: number; quote: number; vote: number; count: number }> = [];
    const diagnostics: CausalArmDiagnostics | undefined = support ? { eligibleCandidates: {}, unavailableDegree: 0, unavailableSupportHistory: 0, unavailablePriceHistory: 0, graphExcludedCandidates: 0, graphSolverFailures: 0 } : undefined;
    let popped = 0;
    for (let b = 0; b < bucketTimes.length; b += 1) {
        if (shouldStop()) return cancelled();
        const t = bucketTimes[b]!;
        if (sampleTo !== undefined && t > sampleTo) break;
        support?.advance(t);
        let hasEntry = false;
        // Apply ALL deltas at this timestamp before forming candidates.
        const bucketEnd = bucketStart[b + 1]!;
        for (let i = bucketStart[b]!; i < bucketEnd; i += 1) {
            if (shouldStop()) return cancelled();
            const assetIndex = flatDeltas.assetIndices[i]!;
            const delta = flatDeltas.deltas[i]!;
            const isEntry = flatDeltas.flags[i]! & 1;
            const streamIdx = flatStreamIdx[i]!;
            rawScore[assetIndex]! += delta;
            if (support) {
                support.update(assetIndex, t, flatDeltas.entrySecs![i]!, delta, isEntry === 1, rawScore[assetIndex]!);
                const endpoints = args.pairEndpoints![streamIdx];
                if (endpoints && endpoints.base === assetIndex) {
                    pairVotes![streamIdx] += delta;
                    const before = pairCounts![streamIdx]!;
                    const after = before + (isEntry === 1 ? 1 : -1);
                    pairCounts![streamIdx] = after;
                    if (after > 0 && before <= 0) {
                        openPairPos![streamIdx] = openPairList.length;
                        openPairList.push(streamIdx);
                    } else if (after <= 0 && before > 0) {
                        const position = openPairPos![streamIdx]!;
                        const moved = openPairList.pop()!;
                        if (position < openPairList.length) {
                            openPairList[position] = moved;
                            openPairPos![moved] = position;
                        }
                        openPairPos![streamIdx] = -1;
                    }
                }
            }
            // activePairCount tracks currently-open pairs on this asset: an
            // entry adds a vote, an exit removes it (clamped at 0). Using
            // abs(delta) here was wrong because it incremented on BOTH entry
            // and exit, inflating the adjusted-score denominator after every
            // round-trip and corrupting TOP_ADJUSTED selection.
            const countDelta = isEntry === 1 ? 1 : -1;
            const next = activePairCount[assetIndex]! + countDelta;
            activePairCount[assetIndex] = next > 0 ? next : 0;
            if (isEntry === 0) realizedPnlByStream[streamIdx] += flatDeltas.pnlShares[i]!;
            // Profit-gated mirror: only deltas from pairs whose FULL backtest
            // netted positive (static mask).
            if (profitableStreams[streamIdx]!) {
                profitRawScore[assetIndex]! += delta;
                const nextPnl = profitPairCount[assetIndex]! + countDelta;
                profitPairCount[assetIndex] = nextPnl > 0 ? nextPnl : 0;
            }
            if (isEntry === 1) hasEntry = true;
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
        // columnar deltas instead of the per-delta copies this
        // loop used to consume — the deltas are not mutated between passes,
        // and the second pass reads only fields the first pass never touches
        // (voteApplied/delta/isEntry/profitNowConfidenceWeight), so operation
        // order and every accumulated value are identical without the
        // per-delta object allocation.
        const bucketStartIndex = bucketStart[b]!;
        for (let i = bucketStartIndex; i < bucketEnd; i += 1) {
            if (!(flatDeltas.flags[i]! & 2)) continue;
            const assetIndex = flatDeltas.assetIndices[i]!;
            const delta = flatDeltas.deltas[i]!;
            const confidenceWeight = flatDeltas.confidenceWeights[i]!;
            profitNowRawScore[assetIndex]! += delta;
            const countDeltaNow = (flatDeltas.flags[i]! & 1) === 1 ? 1 : -1;
            const nextNow = profitNowPairCount[assetIndex]! + countDeltaNow;
            profitNowPairCount[assetIndex] = nextNow > 0 ? nextNow : 0;
            if (confidenceWeight > 0) {
                profitNowConfidenceScore[assetIndex]! += delta * confidenceWeight;
                const nextConfidence = profitNowConfidencePairCount[assetIndex]! + countDeltaNow;
                profitNowConfidencePairCount[assetIndex] = nextConfidence > 0 ? nextConfidence : 0;
            }
        }
        // Exit-only score changes do not create a decision event.
        if (hasEntry) {
            if ((sampleFrom === undefined || t >= sampleFrom) && (sampleTo === undefined || t <= sampleTo)) {
                let causalScores: Map<number, CausalScoreKeys> | undefined;
                let causalArms: CausalCompactArms | undefined;
                if (support) {
                    // Packed open edges from the incremental list: no per-bucket
                    // scan of every pair endpoint and no per-edge object spread.
                    let edgeCount = 0;
                    for (const streamIdx of openPairList) {
                        const endpoints = args.pairEndpoints![streamIdx];
                        if (!endpoints) continue;
                        let edge = graphEdgePool[edgeCount];
                        if (!edge) edge = graphEdgePool[edgeCount] = { base: 0, quote: 0, vote: 0, count: 0 };
                        edge.base = endpoints.base;
                        edge.quote = endpoints.quote;
                        edge.vote = pairVotes![streamIdx]!;
                        edge.count = pairCounts![streamIdx]!;
                        edgeCount += 1;
                    }
                    const graph = await scoreGraphStrength(
                        args.assetNames!,
                        edgeCount === graphEdgePool.length ? graphEdgePool : graphEdgePool.slice(0, edgeCount),
                        shouldStop,
                        undefined,
                        nameRanks!,
                    );
                    if (graph.failed) diagnostics!.graphSolverFailures++;
                    if (args.mode === "asset_switch") causalArms = Object.fromEntries(CAUSAL_ARM_FIELDS.map((field) => [field, { picks: [], eligibleCount: 0 }]));
                    else causalScores = new Map();
                    for (let a = 0; a < assetCount; a++) {
                        if (a > 0 && a % 2000 === 0) { await yieldLoop(); if (shouldStop()) return cancelled(); }
                        if (rawScore[a]! <= 0) continue;
                        const keys: CausalScoreKeys = {};
                        const degree = args.validDegree!.get(args.assetNames![a]!) ?? 0;
                        if (degree > 0) {
                            keys.topCoverage = rawScore[a]! / degree;
                            const temporal = support.scores(a, t, degree);
                            keys.topFreshSupport = temporal.fresh;
                            if (temporal.stable !== undefined) keys.topStableSupport = temporal.stable;
                            else diagnostics!.unavailableSupportHistory++;
                        } else diagnostics!.unavailableDegree++;
                        if (graph.scores.has(a)) keys.topGraphStrength = graph.scores.get(a)!;
                        else if (!graph.component.has(a)) diagnostics!.graphExcludedCandidates++;
                        for (const field of CAUSAL_ARM_FIELDS) if (keys[field] !== undefined) {
                            diagnostics!.eligibleCandidates[field] = (diagnostics!.eligibleCandidates[field] ?? 0) + 1;
                            if (causalArms) {
                                const row = causalArms[field]!; row.eligibleCount++;
                                insertRankingPick(row.picks, { assetIndex: a, raw: rawScore[a]!, adjusted: 0, mean: 0, activePairs: activePairCount[a]!, ...keys }, RANKING_ARM_SPECS.find((spec) => spec.field === field)!, t, args.assetNames!);
                            }
                        }
                        causalScores?.set(a, keys);
                    }
                }
                events.push({
                    ...(causalScores ? { causalScores } : {}),
                    ...(causalArms ? { causalArms } : {}),
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
    return { ok: true, result: { events, ...(diagnostics ? { causalArmDiagnostics: diagnostics } : {}) } };
}
