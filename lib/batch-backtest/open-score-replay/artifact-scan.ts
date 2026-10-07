/**
 * Replay stage 1 — artifact scan. Streams each synthetic-pair artifact once,
 * reconstructs its compact per-pair ScoreDelta stream (entry/exit deltas with
 * causal PROFIT_NOW vote flags), counts retained degrees and cap-tilt
 * coverage, and releases the artifact before the next load.
 */
import type { BatchSyntheticPairArtifact } from "../batch-synthetic-artifact";
import { timeToNumber } from "../../strategies/backtest/backtest-utils";
import type { ActiveCapTiltWeight } from "../cap-tilt-contract";
import { computeProfitNowConfidenceWeight } from "./statistics";
import type {
    CapTiltCoverageCounters,
    ReplayPhaseCallback,
    ScoreDelta,
    StageOutcome,
} from "./internal-types";
import { yieldLoop } from "./runtime";
import { ScoreDeltaBuffer } from "./score-delta-buffer";

/** Comparator for ScoreDelta: (time, assetIndex, isEntry DESC). Entries before
 * exits at the same (time, asset) so the post-execution score reflects the new
 * position before any same-timestamp exit netting. Exported so the parallel
 * scan workers sort with the identical comparator. */
export function compareDeltas(a: ScoreDelta, b: ScoreDelta): number {
    return a.timeSec - b.timeSec
        || a.assetIndex - b.assetIndex
        || b.isEntry - a.isEntry;
}

export interface ArtifactScanResult {
    validDegree?: Map<string, number>;
    assetIndexByName: Map<string, number>;
    assetNames: string[];
    /**
     * Counts BOTH legs of every successfully loaded artifact (the engine reads
     * them from disk; this is what the plan calls RETAINED degree, NOT
     * submitted). The old name `staticDegree` is kept as an alias so existing
     * tests compile; the report labels this selector MAX_RETAINED.
     */
    retainedDegree: Map<string, number>;
    /** Per-pair compact delta streams, sorted per pair. */
    streams: ScoreDeltaBuffer[];
    /** Index i describes streams[i]: pair's full backtest netProfit > 0. */
    profitableStreams: boolean[];
    /** Index i describes streams[i]: false when ANY trade lacks finite pnl. */
    pnlKnownStreams: boolean[];
    pairCount: number;
    omittedPairs: number;
    capTiltCoverage: CapTiltCoverageCounters | null;
    capTiltWindowCoverage: CapTiltCoverageCounters;
    capTiltCarryInCoverage: CapTiltCoverageCounters;
    capTiltUnknownAssets: Map<string, number>;
}

/**
 * Per-artifact scan context. `assetIndex` is the scan-wide first-encounter
 * index assigner; the cap-tilt fields ride together (all set when the tilt is
 * active, coverage objects included) exactly as {@link scanArtifacts} wires
 * them. The parallel scan worker supplies the same shape with a shard-local
 * `assetIndex` and an inactive tilt.
 */
export interface PairArtifactScanContext {
    enableCausalArms?: boolean;
    assetIndex(name: string): number;
    capTiltWeight: ActiveCapTiltWeight | null;
    lookupMarketCap: ((symbol: string, timeSec: number) => number | null) | null;
    capTiltCoverage: CapTiltCoverageCounters | null;
    capTiltWindowCoverage: CapTiltCoverageCounters;
    capTiltCarryInCoverage: CapTiltCoverageCounters;
    capTiltUnknownAssets: Map<string, number>;
    sampleFromSec: number | undefined;
    sampleToSec: number | undefined;
}

export interface PairArtifactScanOutcome {
    /** Normalized (trimmed, uppercased) base leg; empty when the artifact lacks one. */
    baseName: string;
    /** Normalized quote leg, or null when the artifact has no quote asset. */
    quoteName: string | null;
    /** True when the pair contributes no stream (structural omit or tradeless). */
    omitted: boolean;
    /** Unsorted delta rows; empty when omitted. */
    deltas: ScoreDelta[];
    /** Full-backtest netProfit > 0 (drives the Profit-gated arms). */
    profitable: boolean;
    /** False when ANY trade lacks a finite pnl. */
    pnlKnown: boolean;
}

/**
 * Reconstruct one artifact's compact ScoreDelta stream. Pure per artifact —
 * all cross-pair state (asset indexes, coverage counters) rides in via
 * {@link PairArtifactScanContext}, so the sequential scan and the parallel
 * scan workers execute IDENTICAL row logic.
 */
export function scanPairArtifact(artifact: BatchSyntheticPairArtifact, ctx: PairArtifactScanContext): PairArtifactScanOutcome {
    const base = artifact.baseAsset?.trim().toUpperCase();
    const quote = artifact.quoteAsset?.trim().toUpperCase();
    const baseName = base ?? "";
    const quoteName = quote ?? null;
    // Structural omit: static degree still counted by the caller, but the pair
    // contributes no asset indexes and no deltas.
    if (!base || (quote && base === quote)) {
        return { baseName, quoteName, omitted: true, deltas: [], profitable: false, pnlKnown: false };
    }
    const bi = ctx.assetIndex(base);
    const qi = quote ? ctx.assetIndex(quote) : null;
    const trades = artifact.result?.trades ?? [];
    if (trades.length === 0) {
        // Asset indexes were still assigned (matches the sequential scan, which
        // indexes structurally valid pairs before the tradeless check).
        return { baseName, quoteName, omitted: true, deltas: [], profitable: false, pnlKnown: false };
    }
    const stream: ScoreDelta[] = [];
    // Causal PROFIT_NOW: decide per trade whether its vote is applied,
    // by simulating the pair's own ledger chronologically (exits at a
    // timestamp count as known before entries at that timestamp, so an
    // entry mask includes same-timestamp exits — consistent with the
    // merge's post-group rule). A trade entered while pnl-known and
    // strictly positive carries its vote until its own exit.
    const tradeVoteApplied: boolean[] = new Array(trades.length).fill(false);
    const tradeProfitNowConfidenceWeight: number[] = new Array(trades.length).fill(0);
    let streamPnlKnown = true;
    {
        const ledger: Array<{ t: number; out: boolean; idx: number }> = [];
        trades.forEach((trade, idx) => {
            const entrySec = timeToNumber(trade.entryTime);
            if (entrySec === null) return;
            ledger.push({ t: entrySec, out: false, idx });
            if (trade.exitReason === "end_of_data") return;
            const exitSec = timeToNumber(trade.exitTime);
            if (exitSec === null) return;
            ledger.push({ t: exitSec, out: true, idx });
        });
        ledger.sort((a, b) => a.t - b.t || (a.out === b.out ? 0 : a.out ? -1 : 1));
        let realized = 0;
        let grossAbsPnl = 0;
        let closedTradeCount = 0;
        for (const step of ledger) {
            const pnl = trades[step.idx]!.pnl;
            if (!Number.isFinite(pnl)) streamPnlKnown = false;
            if (step.out) {
                if (Number.isFinite(pnl)) {
                    realized += pnl!;
                    grossAbsPnl += Math.abs(pnl!);
                    closedTradeCount += 1;
                }
            } else {
                tradeVoteApplied[step.idx] = streamPnlKnown && realized > 0;
                tradeProfitNowConfidenceWeight[step.idx] = streamPnlKnown
                    ? computeProfitNowConfidenceWeight(closedTradeCount, realized, grossAbsPnl)
                    : 0;
            }
        }
    }
    const capTiltActive = ctx.capTiltWeight !== null && ctx.lookupMarketCap !== null && ctx.capTiltCoverage !== null;
    let tradeIdx = -1;
    for (const trade of trades) {
        const entrySec = timeToNumber(trade.entryTime);
        const exitSec = timeToNumber(trade.exitTime);
        if (entrySec === null) continue;
        const sign = trade.type === "long" ? 1 : trade.type === "short" ? -1 : 0;
        if (sign === 0) continue;
        // Cap-tilt weight (docs/open-score-cap-tilt.md): classified ONCE
        // per LONG trade from the entry-time caps and stamped on BOTH the
        // entry and exit base deltas, so rawScore returns exactly to its
        // prior value after every round-trip (re-classifying at exit would
        // drift every accumulator). similarCap2x weights both legs;
        // other modes leave the quote unchanged. Shorts stay ±1.
        let baseWeight = 1;
        let quoteWeight = 1;
        if (sign === 1 && capTiltActive && ctx.capTiltCoverage && ctx.lookupMarketCap !== null) {
            ctx.capTiltCoverage.long += 1;
            const capBase = ctx.lookupMarketCap(artifact.baseSymbol?.trim() || base, entrySec);
            const capQuote = qi !== null
                ? ctx.lookupMarketCap(artifact.quoteSymbol?.trim() || quote!, entrySec)
                : null;
            if (capBase !== null && capQuote !== null) {
                ctx.capTiltCoverage.known += 1;
                if (ctx.capTiltWeight === "smallBase2x" && capBase < capQuote) {
                    baseWeight = 2;
                    ctx.capTiltCoverage.weighted += 1;
                } else if (ctx.capTiltWeight === "largeBase2x" && capBase > capQuote) {
                    baseWeight = 2;
                    ctx.capTiltCoverage.weighted += 1;
                } else if (ctx.capTiltWeight === "similarCap2x"
                    && Number.isFinite(capBase) && capBase > 0
                    && Number.isFinite(capQuote) && capQuote > 0
                    && Math.max(capBase, capQuote) / Math.min(capBase, capQuote) <= 3) {
                    baseWeight = 2;
                    quoteWeight = 2;
                    ctx.capTiltCoverage.weighted += 1;
                }
            } else {
                ctx.capTiltCoverage.unknown += 1;
            }
            // Reconstruction scans the entire ledger, even for a bounded
            // report. Separate new entries from positions carried into
            // the window; both retain their original entry-time weight.
            const from = ctx.sampleFromSec ?? -Infinity;
            const to = ctx.sampleToSec ?? Infinity;
            const coverage = entrySec >= from && entrySec <= to
                ? ctx.capTiltWindowCoverage
                : entrySec < from && entrySec <= to
                    && (trade.exitReason === "end_of_data" || exitSec === null || exitSec >= from)
                    ? ctx.capTiltCarryInCoverage
                    : null;
            if (coverage) {
                coverage.long += 1;
                if (capBase !== null && capQuote !== null) {
                    coverage.known += 1;
                    if (baseWeight === 2) coverage.weighted += 1;
                } else {
                    coverage.unknown += 1;
                    if (capBase === null) ctx.capTiltUnknownAssets.set(base, (ctx.capTiltUnknownAssets.get(base) ?? 0) + 1);
                    if (capQuote === null && quote) ctx.capTiltUnknownAssets.set(quote, (ctx.capTiltUnknownAssets.get(quote) ?? 0) + 1);
                }
            }
        }
        tradeIdx += 1;
        const voteApplied = tradeVoteApplied[tradeIdx]!;
        const profitNowConfidenceWeight = tradeProfitNowConfidenceWeight[tradeIdx]!;
        // Entry deltas (long: base+1/quote-1; short: base-1/quote+1).
        stream.push({
            ...(ctx.enableCausalArms ? { entrySec } : {}),
            timeSec: entrySec,
            assetIndex: bi,
            delta: sign * baseWeight,
            isEntry: 1,
            pnlShare: 0,
            voteApplied,
            profitNowConfidenceWeight,
        });
        if (qi !== null) {
            stream.push({
                ...(ctx.enableCausalArms ? { entrySec } : {}),
                timeSec: entrySec,
                assetIndex: qi,
                delta: -sign * quoteWeight,
                isEntry: 1,
                pnlShare: 0,
                voteApplied,
                profitNowConfidenceWeight,
            });
        }
        // Exit deltas are the exact inverse. end_of_data / missing exit time
        // means the position is still open at the artifact end -> no exit delta.
        if (exitSec !== null && trade.exitReason !== "end_of_data") {
            // Split the trade's realized pnl evenly across its exit legs so
            // summing every leg's share reconstructs the trade pnl exactly.
            const pnl = Number.isFinite(trade.pnl) ? trade.pnl : 0;
            const pnlShare = pnl / (qi !== null ? 2 : 1);
            stream.push({
                ...(ctx.enableCausalArms ? { entrySec } : {}),
                timeSec: exitSec,
                assetIndex: bi,
                delta: -sign * baseWeight,
                isEntry: 0,
                pnlShare,
                voteApplied,
                profitNowConfidenceWeight,
            });
            if (qi !== null) {
                stream.push({
                    ...(ctx.enableCausalArms ? { entrySec } : {}),
                    timeSec: exitSec,
                    assetIndex: qi,
                    delta: sign * quoteWeight,
                    isEntry: 0,
                    pnlShare,
                    voteApplied,
                    profitNowConfidenceWeight,
                });
            }
        }
    }
    const pairNetProfit = artifact.result?.netProfit;
    return {
        baseName,
        quoteName,
        omitted: false,
        deltas: stream,
        profitable: Number.isFinite(pairNetProfit) && pairNetProfit > 0,
        pnlKnown: streamPnlKnown,
    };
}

export async function scanArtifacts(args: {
    enableCausalArms?: boolean;
    artifactLoader: () => AsyncIterable<BatchSyntheticPairArtifact>;
    shouldStop: () => boolean;
    onPhase: ReplayPhaseCallback;
    /** Pre-resolved cap-tilt inputs (both set, or both null). */
    capTiltWeight: ActiveCapTiltWeight | null;
    lookupMarketCap: ((symbol: string, timeSec: number) => number | null) | null;
    capTiltActive: boolean;
    sampleFromSec: number | undefined;
    sampleToSec: number | undefined;
}): Promise<StageOutcome<ArtifactScanResult>> {
    const { artifactLoader, shouldStop, onPhase, capTiltWeight, lookupMarketCap, capTiltActive, sampleFromSec, sampleToSec } = args;
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
    const streams: ScoreDeltaBuffer[] = [];
    // Index i describes streams[i]: true when that pair's full backtest
    // netProfit was strictly positive (drives the Profit-gated arms only).
    const profitableStreams: boolean[] = [];
    // Causal PROFIT_NOW per-stream pnl-known flags are pushed in lockstep
    // with `streams` (index i describes streams[i]): false when ANY trade of
    // that pair lacks a finite pnl — such pairs are never profitable-now
    // (documented fallback; a pair with mixed known/missing pnl must not
    // ride its known wins).
    const pnlKnownStreams: boolean[] = [];
    let pairCount = 0;
    let omittedPairs = 0;
    // Cap-tilt coverage counters (docs/open-score-cap-tilt.md): LONG trades
    // scanned while the tilt is active, split by whether the entry-time caps
    // were known and whether the tilt actually applied. The report line turns
    // a silently-under-covered tilted run (weights degraded to 1) visible —
    // weighting semantics are unchanged.
    const capTiltCoverage = capTiltActive ? { long: 0, known: 0, weighted: 0, unknown: 0 } : null;
    const capTiltWindowCoverage = { long: 0, known: 0, weighted: 0, unknown: 0 };
    const capTiltCarryInCoverage = { long: 0, known: 0, weighted: 0, unknown: 0 };
    const capTiltUnknownAssets = new Map<string, number>();

    const assetIndex = (name: string): number => {
        let idx = assetIndexByName.get(name);
        if (idx === undefined) {
            idx = assetNames.length;
            assetIndexByName.set(name, idx);
            assetNames.push(name);
        }
        return idx;
    };
    const validDegree = args.enableCausalArms ? new Map<string, number>() : undefined;
    const scanCtx: PairArtifactScanContext = {
        enableCausalArms: args.enableCausalArms,
        assetIndex,
        capTiltWeight,
        lookupMarketCap,
        capTiltCoverage,
        capTiltWindowCoverage,
        capTiltCarryInCoverage,
        capTiltUnknownAssets,
        sampleFromSec,
        sampleToSec,
    };

    for await (const artifact of artifactLoader()) {
        if (shouldStop()) return { ok: false, earlyExit: { reportLine: "OPEN_SCORE USD | cancelled during artifact scan.", pairs: pairCount } };
        pairCount += 1;
        const outcome = scanPairArtifact(artifact, scanCtx);
        // Static pair degree describes the SUBMITTED pair list (the actual
        // workflow's coverage bias), so it must count every leg of every pair
        // regardless of whether the pair produced trades. Counting only pairs
        // that traded understated coverage and hid the pair-balance answer.
        if (outcome.baseName) staticDegree.set(outcome.baseName, (staticDegree.get(outcome.baseName) ?? 0) + 1);
        if (outcome.quoteName && outcome.quoteName !== outcome.baseName) {
            staticDegree.set(outcome.quoteName, (staticDegree.get(outcome.quoteName) ?? 0) + 1);
        }
        const validPair = !!outcome.baseName && !!outcome.quoteName && outcome.baseName !== outcome.quoteName;
        if (validDegree && validPair) for (const name of [outcome.baseName, outcome.quoteName!]) validDegree.set(name, (validDegree.get(name) ?? 0) + 1);
        if (outcome.omitted) {
            omittedPairs += 1;
            continue;
        }
        // Sort this pair's deltas in-place (small N). One global Array.sort on
        // 1000+ pairs' worth of deltas would block the event loop and keep
        // Stop / progress from firing during the long sort.
        outcome.deltas.sort(compareDeltas);
        // Only this pair's temporary rows survive the sort. Retaining objects
        // for four deltas per trade exhausts even a 16 GiB coordinator heap.
        streams.push(ScoreDeltaBuffer.from(outcome.deltas, args.enableCausalArms));
        // Profit-gated arms: a pair feeds the filtered accumulators only when its
        // full backtest netted strictly positive. Kept in lockstep with
        // `streams` (index i describes streams[i]).
        profitableStreams.push(outcome.profitable);
        // Causal PROFIT_NOW arms: per-stream quote asset index (-1 for
        // single-leg direct markets) so the exact open-vote flags below can
        // tell a delta's base leg from its quote leg.
        pnlKnownStreams.push(outcome.pnlKnown);
        if (pairCount % 25 === 0) {
            onPhase("scan", `scanned ${pairCount} pairs`, pairCount, 0);
            await yieldLoop();
        }
    }
    return {
        ok: true,
        result: {
            ...(validDegree ? { validDegree } : {}),
            assetIndexByName,
            assetNames,
            retainedDegree,
            streams,
            profitableStreams,
            pnlKnownStreams,
            pairCount,
            omittedPairs,
            capTiltCoverage,
            capTiltWindowCoverage,
            capTiltCarryInCoverage,
            capTiltUnknownAssets,
        },
    };
}
