import { parsePortfolioSyntheticPairSymbol } from "../synthetic-pair-parser";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { CompactPairArtifact } from "./compact-pair-artifact";

/**
 * Phase-1 current-snapshot reducer: compute TOP_MEAN from positions open at
 * the latest common closed candle, directly from completed compact artifacts.
 *
 * This mirrors the Batch `TOP_MEAN NOW` semantics already implemented in
 * `batch-backtest-summary.ts` / `batch-row-scalars.ts`:
 *
 * - open long pair: base `+1`, quote `-1`;
 * - open short pair: base `-1`, quote `+1`;
 * - `activePairs[asset]`: number of open pair legs containing the asset;
 * - candidate: `rawScore > 0` AND `activePairs > 0`;
 * - selection key: `rawScore / activePairs`.
 *
 * Differences vs the historical OPEN_SCORE replay (which builds a per-event
 * leaderboard from `topAssets[0]`): this is a single cross-sectional snapshot
 * as-of the latest common closed candle represented by the artifacts. It is
 * NOT an intrabar signal.
 *
 * The reducer is pure and server-safe: it retains only maps/counters and never
 * loads pair candles or signals. It is fed by `iterateRunCompactArtifacts(...)`
 * (raw `CompactPairArtifact`, before the batch adapter) so it can read the
 * optional `dataEndTime` field directly.
 */

export interface CurrentTopMeanCandidate {
    asset: string;
    /** Net signed vote across all currently-open pair legs. */
    score: number;
    /** Number of currently-open pair legs that contain this asset. */
    activePairs: number;
    /** score / activePairs (the TOP_MEAN arm's selection key). */
    mean: number;
}

export type CurrentTopMeanReason =
    | "ok"
    | "empty"
    | "no_open_positions"
    | "no_positive_candidates"
    | "no_common_endpoint"
    | "tied";

export interface CurrentTopMeanSnapshot {
    /** Unix seconds, or null when no usable common endpoint exists. */
    asOf: number | null;
    /**
     * Artifacts that passed the endpoint filter and were therefore ELIGIBLE to
     * contribute to the vote (the meaningful denominator for `openPositions`).
     * Stale-endpoint, missing-endpoint, and malformed artifacts are counted in
     * `stats` instead, NOT here. Distinct from `stats.artifactsProcessed`
     * (which counts every artifact seen).
     */
    artifacts: number;
    /** Number of artifacts with an open position at the common endpoint. */
    openPositions: number;
    /** Positive candidates (rawScore > 0 and activePairs > 0), sorted by mean. */
    candidates: CurrentTopMeanCandidate[];
    /** Every candidate tied at the max mean (no arbitrary tie-break). */
    winners: CurrentTopMeanCandidate[];
    reason: CurrentTopMeanReason;
}

export interface CurrentTopMeanStats {
    /** Every artifact the reducer observed, before any filtering. */
    artifactsProcessed: number;
    openPositions: number;
    positiveCandidates: number;
    staleEndpoints: number;
    missingEndpoints: number;
    malformedArtifacts: number;
    /** Number of assets tied at the top mean. 0 for a unique winner, N>=2 for a tie. */
    tieCount: number;
    durationMs: number;
}

export type CurrentTopMeanActionCode =
    | "ENTER_NEXT_OPEN"
    | "WAIT_FOR_FRESH_DECISION"
    | "NO_TRADE";

export type CurrentTopMeanActionReason =
    | CurrentTopMeanReason
    | "fresh_unique_winner"
    | "no_fresh_pair_entry";

export interface CurrentTopMeanAction {
    action: CurrentTopMeanActionCode;
    reason: CurrentTopMeanActionReason;
    /** Unique current winner when one exists; null for ties/empty snapshots. */
    asset: string | null;
    /** Latest common closed candle used for the decision. */
    signalAsOf: number | null;
    /** True only when at least one pair trade entered exactly at `signalAsOf`. */
    freshDecision: boolean;
    /** Number of endpoint-aligned pair artifacts containing a fresh entry. */
    freshEntryPairs: number;
    notionalUsd: 1000;
    holdBars: 24;
    entryRule: "next_bar_open";
    exitRule: "24th_bar_close";
    requiresNoActiveAssetPosition: true;
}

export interface CurrentTopMeanResult {
    snapshot: CurrentTopMeanSnapshot;
    stats: CurrentTopMeanStats;
    /** Optional only for backward compatibility with persisted pre-action runs. */
    action?: CurrentTopMeanAction;
}

export function buildCurrentTopMeanAction(
    snapshot: CurrentTopMeanSnapshot,
    freshEntryPairs: number,
): CurrentTopMeanAction {
    const uniqueWinner = snapshot.reason === "ok" && snapshot.winners.length === 1
        ? snapshot.winners[0]!
        : null;
    const freshDecision = freshEntryPairs > 0 && snapshot.asOf !== null;

    if (!uniqueWinner) {
        return {
            action: "NO_TRADE",
            reason: snapshot.reason,
            asset: null,
            signalAsOf: snapshot.asOf,
            freshDecision,
            freshEntryPairs,
            notionalUsd: 1000,
            holdBars: 24,
            entryRule: "next_bar_open",
            exitRule: "24th_bar_close",
            requiresNoActiveAssetPosition: true,
        };
    }

    return {
        action: freshDecision ? "ENTER_NEXT_OPEN" : "WAIT_FOR_FRESH_DECISION",
        reason: freshDecision ? "fresh_unique_winner" : "no_fresh_pair_entry",
        asset: uniqueWinner.asset,
        signalAsOf: snapshot.asOf,
        freshDecision,
        freshEntryPairs,
        notionalUsd: 1000,
        holdBars: 24,
        entryRule: "next_bar_open",
        exitRule: "24th_bar_close",
        requiresNoActiveAssetPosition: true,
    };
}

/**
 * Construct the empty/no-selection snapshot result shared by early returns.
 * `snapshotArtifacts` is the count of artifacts that passed the endpoint
 * filter (the meaningful denominator); it is distinct from
 * `stats.artifactsProcessed` (every artifact seen).
 */
function emptyResult(
    reason: CurrentTopMeanReason,
    stats: Partial<CurrentTopMeanStats> = {},
    asOf: number | null = null,
    snapshotArtifacts: number = 0,
    freshEntryPairs: number = 0,
): CurrentTopMeanResult {
    const snapshot: CurrentTopMeanSnapshot = {
        asOf,
        artifacts: snapshotArtifacts,
        openPositions: stats.openPositions ?? 0,
        candidates: [],
        winners: [],
        reason,
    };
    return {
        snapshot,
        stats: {
            artifactsProcessed: stats.artifactsProcessed ?? 0,
            openPositions: stats.openPositions ?? 0,
            positiveCandidates: stats.positiveCandidates ?? 0,
            staleEndpoints: stats.staleEndpoints ?? 0,
            missingEndpoints: stats.missingEndpoints ?? 0,
            malformedArtifacts: stats.malformedArtifacts ?? 0,
            tieCount: stats.tieCount ?? 0,
            durationMs: stats.durationMs ?? 0,
        },
        action: buildCurrentTopMeanAction(snapshot, freshEntryPairs),
    };
}

/**
 * Inspect a single artifact's last trade and decide its direction contribution.
 * Returns null when the artifact has no currently-open position. Mirrors
 * `computeOpenTradeAssetScores` exactly: only the LAST trade matters, and only
 * when its exitReason is `end_of_data`.
 *
 * Exposed for unit tests so the sign/active-pair conventions can be locked.
 */
export function resolveOpenPairContribution(artifact: CompactPairArtifact): {
    sign: 1 | -1;
    baseAsset: string;
    quoteAsset: string;
} | null {
    const trades = artifact.trades;
    if (!Array.isArray(trades) || trades.length === 0) return null;
    const last = trades[trades.length - 1]!;
    if (last.exitReason !== "end_of_data") return null;
    if (last.type !== "long" && last.type !== "short") return null;
    const sign: 1 | -1 = last.type === "long" ? 1 : -1;
    // Prefer the structural pair identity recorded on the artifact; fall back
    // to parsing the symbol so fixture parity with the Batch path holds for
    // both synthetic pairs and plain single-asset rows.
    const parsed = parsePortfolioSyntheticPairSymbol(artifact.symbol);
    if (parsed) {
        return { sign, baseAsset: parsed.baseAsset, quoteAsset: parsed.quoteAsset };
    }
    return {
        sign,
        baseAsset: artifact.baseAsset,
        quoteAsset: artifact.quoteAsset,
    };
}

/**
 * First pass: find the most common `dataEndTime` across all artifacts. Only
 * artifacts with a finite numeric `dataEndTime` contribute to the mode.
 *
 * Consensus policy: by default the mode must be held by STRICTLY MORE THAN
 * HALF of the artifacts that carry any usable endpoint. A 50/50 (or worse)
 * split means no endpoint is the consensus — voting on a partial universe
 * would produce a misleading cross-sectional ranking, so we return endpoint
 * null and the caller surfaces a `no_common_endpoint` reason. Set
 * `requireStrictMajority: false` to accept any plurality (older endpoint wins
 * on ties); used only by tests that intentionally exercise the partial case.
 *
 * Exposed (and async) so the coordinator can report progress between the two
 * passes on very large runs without holding all artifacts in memory.
 */
export async function resolveCommonEndpoint(
    artifacts: AsyncIterable<CompactPairArtifact>,
    shouldStop?: () => boolean,
    options: { requireStrictMajority?: boolean } = {},
): Promise<{
    endpoint: number | null;
    processed: number;
    missing: number;
    malformed: number;
    endpointTotal: number;
    endpointCount: number;
    noConsensus: boolean;
}> {
    const requireStrictMajority = options.requireStrictMajority ?? true;
    const counts = new Map<number, number>();
    let processed = 0;
    let missing = 0;
    let malformed = 0;
    let endpointTotal = 0;

    for await (const artifact of artifacts) {
        if (shouldStop?.()) {
            // Stopped mid-pass: no conclusion reached. Return noConsensus=false
            // so the caller treats this as "empty/unknown" rather than a
            // definitive "endpoints were split" verdict.
            return { endpoint: null, processed, missing, malformed, endpointTotal, endpointCount: 0, noConsensus: false };
        }
        processed += 1;
        const endpoint = artifact?.dataEndTime;
        if (endpoint === undefined || endpoint === null) {
            missing += 1;
            continue;
        }
        // Reject non-finite / non-integer endpoints defensively; never throw.
        if (typeof endpoint !== "number" || !Number.isFinite(endpoint)) {
            malformed += 1;
            continue;
        }
        counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
        endpointTotal += 1;
    }

    let bestEndpoint: number | null = null;
    let bestCount = 0;
    // Deterministic tie-break: highest count wins; on equal counts the SMALLER
    // endpoint (older) wins so a partial write of newer bars cannot steal the
    // snapshot.
    for (const [endpoint, count] of counts) {
        if (count > bestCount || (count === bestCount && (bestEndpoint === null || endpoint < bestEndpoint))) {
            bestEndpoint = endpoint;
            bestCount = count;
        }
    }

    // Strict-majority consensus check. With bestCount === endpointTotal there
    // is only one distinct endpoint (trivially a consensus). Otherwise the mode
    // must exceed half of all endpoint-bearing artifacts.
    const noConsensus = requireStrictMajority
        && bestEndpoint !== null
        && endpointTotal > 0
        && bestCount * 2 <= endpointTotal;

    return {
        endpoint: noConsensus ? null : bestEndpoint,
        processed,
        missing,
        malformed,
        endpointTotal,
        endpointCount: bestCount,
        noConsensus,
    };
}

/**
 * Reduce a stream of compact artifacts into the current TOP_MEAN snapshot.
 *
 * The caller streams the SAME artifacts twice (or restarts the async iterable):
 * once via `resolveCommonEndpoint` to pick the common endpoint, then again
 * here for the vote. This keeps peak memory bounded to maps/counters — the
 * 124,000-pair universe never needs to be held in memory.
 */
export async function reduceCurrentTopMeanSnapshot(
    artifacts: AsyncIterable<CompactPairArtifact>,
    options: {
        /**
         * If supplied, only artifacts whose `dataEndTime` equals this value
         * contribute to the vote. If omitted, ALL artifacts vote regardless of
         * endpoint (used when callers want a single-endpoint stream).
         */
        commonEndpoint?: number | null;
        shouldStop?: () => boolean;
    } = {},
): Promise<CurrentTopMeanResult> {
    const startedAt = Date.now();
    const endpoint = options.commonEndpoint ?? null;
    const filterByEndpoint = options.commonEndpoint !== undefined;

    const scoreByAsset = new Map<string, number>();
    const activePairsByAsset = new Map<string, number>();
    let artifactsProcessed = 0;
    let contributingArtifacts = 0;
    let openPositions = 0;
    let staleEndpoints = 0;
    let missingEndpoints = 0;
    let malformedArtifacts = 0;
    let freshEntryPairs = 0;

    for await (const artifact of artifacts) {
        if (options.shouldStop?.()) {
            return emptyResult("empty", {
                artifactsProcessed,
                openPositions,
                staleEndpoints,
                missingEndpoints,
                malformedArtifacts,
                durationMs: Date.now() - startedAt,
            });
        }
        artifactsProcessed += 1;

        if (filterByEndpoint) {
            const ep = artifact?.dataEndTime;
            if (ep === undefined || ep === null || typeof ep !== "number" || !Number.isFinite(ep)) {
                missingEndpoints += 1;
                continue;
            }
            if (ep !== endpoint) {
                staleEndpoints += 1;
                continue;
            }
        }
        // Passed the endpoint filter → eligible to contribute to the vote.
        contributingArtifacts += 1;
        if (
            endpoint !== null
            && Array.isArray(artifact.trades)
            && artifact.trades.some((trade) => parseTimeToUnixSeconds(trade.entryTime) === endpoint)
        ) {
            freshEntryPairs += 1;
        }

        const contribution = resolveOpenPairContribution(artifact);
        if (!contribution) continue;

        openPositions += 1;
        const { sign, baseAsset, quoteAsset } = contribution;
        // Long pair: base +1, quote -1. Short pair: base -1, quote +1.
        // Both legs of an open pair count toward activePairs for each asset.
        for (const asset of [baseAsset, quoteAsset]) {
            if (!asset) {
                malformedArtifacts += 1;
                continue;
            }
            activePairsByAsset.set(asset, (activePairsByAsset.get(asset) ?? 0) + 1);
        }
        scoreByAsset.set(baseAsset, (scoreByAsset.get(baseAsset) ?? 0) + sign);
        scoreByAsset.set(quoteAsset, (scoreByAsset.get(quoteAsset) ?? 0) - sign);
    }

    if (openPositions === 0) {
        // Distinguish "nothing flowed in" from "artifacts seen but none open".
        // The former is a contract violation upstream (asOf stays null — we
        // cannot confirm WHEN nothing was observed); the latter is a real
        // market condition (asOf = the endpoint we filtered to).
        const reason: CurrentTopMeanReason = artifactsProcessed === 0 ? "empty" : "no_open_positions";
        const asOf = artifactsProcessed > 0 && filterByEndpoint ? endpoint : null;
        return emptyResult(
            reason,
            {
                artifactsProcessed,
                openPositions,
                positiveCandidates: 0,
                staleEndpoints,
                missingEndpoints,
                malformedArtifacts,
                durationMs: Date.now() - startedAt,
            },
            asOf,
            contributingArtifacts,
            freshEntryPairs,
        );
    }

    // Candidate = rawScore > 0 AND activePairs > 0. mean = score / activePairs.
    const candidates: CurrentTopMeanCandidate[] = [];
    for (const [asset, score] of scoreByAsset) {
        if (score <= 0) continue;
        const activePairs = activePairsByAsset.get(asset) ?? 0;
        if (activePairs <= 0) continue;
        candidates.push({ asset, score, activePairs, mean: score / activePairs });
    }
    candidates.sort((a, b) => b.mean - a.mean || b.score - a.score || a.asset.localeCompare(b.asset));

    if (candidates.length === 0) {
        return emptyResult(
            "no_positive_candidates",
            {
                artifactsProcessed,
                openPositions,
                positiveCandidates: 0,
                staleEndpoints,
                missingEndpoints,
                malformedArtifacts,
                durationMs: Date.now() - startedAt,
            },
            filterByEndpoint ? endpoint : null,
            contributingArtifacts,
            freshEntryPairs,
        );
    }

    // All exact winners tied at the max mean. NO arbitrary asset-name pick.
    const maxMean = candidates[0]!.mean;
    const winners = candidates.filter((c) => c.mean === maxMean);
    const reason: CurrentTopMeanReason = winners.length > 1 ? "tied" : "ok";
    // tieCount: 0 for a unique winner, N for an N-way tie. Reporting the
    // winner count for a unique pick (1) was misleading — a tie is a tie only
    // when two or more assets share the top mean.
    const tieCount = winners.length > 1 ? winners.length : 0;

    const snapshot: CurrentTopMeanSnapshot = {
        asOf: endpoint,
        artifacts: contributingArtifacts,
        openPositions,
        candidates,
        winners,
        reason,
    };
    return {
        snapshot,
        stats: {
            artifactsProcessed,
            openPositions,
            positiveCandidates: candidates.length,
            staleEndpoints,
            missingEndpoints,
            malformedArtifacts,
            tieCount,
            durationMs: Date.now() - startedAt,
        },
        action: buildCurrentTopMeanAction(snapshot, freshEntryPairs),
    };
}

/**
 * One-shot convenience: stream artifacts once for the endpoint, then again
 * for the vote. Suitable for the coordinator path where the async iterable
 * can be re-created cheaply from on-disk shards.
 *
 * If the endpoint pass finds no usable common endpoint, returns a no-selection
 * result (winners empty, asOf null) rather than mixing states from different
 * dates. The endpoint-pass counters are still surfaced in `stats`.
 */
export async function computeCurrentTopMeanSnapshot(
    artifactIterableFactory: () => AsyncIterable<CompactPairArtifact>,
    options: { shouldStop?: () => boolean } = {},
): Promise<CurrentTopMeanResult> {
    const endpointPass = await resolveCommonEndpoint(artifactIterableFactory(), options.shouldStop);
    const endpoint = endpointPass.endpoint;

    if (endpoint === null) {
        // No consensus common endpoint. Distinguish "no endpoint at all"
        // (empty) from "endpoints exist but no strict majority"
        // (no_common_endpoint) — the latter means the universe was split
        // across timestamps and any pick would rank on part of it. Either way
        // do NOT mix states from different dates.
        const reason: CurrentTopMeanReason = endpointPass.noConsensus && endpointPass.endpointTotal > 0
            ? "no_common_endpoint"
            : "empty";
        return emptyResult(reason, {
            artifactsProcessed: endpointPass.processed,
            missingEndpoints: endpointPass.missing,
            malformedArtifacts: endpointPass.malformed,
            durationMs: 0,
        });
    }

    const votePass = await reduceCurrentTopMeanSnapshot(artifactIterableFactory(), {
        commonEndpoint: endpoint,
        shouldStop: options.shouldStop,
    });
    // Merge missing/malformed counters observed during the endpoint pass so
    // callers see totals across both passes, not just the vote pass.
    return {
        snapshot: votePass.snapshot,
        stats: {
            ...votePass.stats,
            missingEndpoints: votePass.stats.missingEndpoints + endpointPass.missing,
            malformedArtifacts: votePass.stats.malformedArtifacts + endpointPass.malformed,
        },
        action: votePass.action,
    };
}
