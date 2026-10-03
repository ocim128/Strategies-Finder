/**
 * Deterministic causal-arm sweep fixture. Shared by the snapshot generator and
 * the equivalence spec: the fixture streams are generated from a seeded LCG so
 * the sweep's output can be pinned against a reference snapshot captured from
 * the pre-optimization implementation (tests/fixtures/causal-sweep-reference.json).
 */
import { ScoreDeltaBuffer } from "../../lib/batch-backtest/open-score-replay/score-delta-buffer";
import type { ScoreDelta } from "../../lib/batch-backtest/open-score-replay/internal-types";
import type { DecisionEvent } from "../../lib/batch-backtest/open-score-replay/internal-types";
import type { CausalArmDiagnostics } from "../../lib/batch-backtest/open-score-replay/types";

export interface CausalSweepFixture {
    assetNames: string[];
    pairEndpoints: Array<{ base: number; quote: number } | null>;
    validDegree: Map<string, number>;
    streams: ScoreDeltaBuffer[];
    profitableStreams: boolean[];
    interval: string;
}

/** Deterministic 32-bit LCG so every consumer regenerates identical deltas. */
function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

const BUCKET_SECONDS = 14400; // 4h
const BUCKET_COUNT = 900;
const ASSET_COUNT = 24;
const PAIR_COUNT = 120;

export function buildCausalSweepFixture(): CausalSweepFixture {
    const next = lcg(42);
    const int = (max: number): number => Math.floor(next() * max);

    const assetNames = Array.from({ length: ASSET_COUNT }, (_, i) => `S${(i * 37) % 997}_${i}`);
    const pairEndpoints: Array<{ base: number; quote: number } | null> = [];
    for (let p = 0; p < PAIR_COUNT; p += 1) {
        const base = int(ASSET_COUNT);
        let quote = int(ASSET_COUNT);
        while (quote === base) quote = int(ASSET_COUNT);
        pairEndpoints.push({ base, quote });
    }
    // A null endpoint exercises pairs whose legs were never resolvable.
    pairEndpoints[PAIR_COUNT - 1] = null;

    const validDegree = new Map<string, number>();
    for (let a = 0; a < ASSET_COUNT; a += 1) {
        let degree = 0;
        for (const endpoint of pairEndpoints) {
            if (!endpoint) continue;
            if (endpoint.base === a || endpoint.quote === a) degree += 1;
        }
        validDegree.set(assetNames[a]!, degree);
    }
    // A few assets with zero degree exercise the unavailableDegree diagnostic.
    validDegree.set(assetNames[0]!, 0);

    const streams: ScoreDeltaBuffer[] = [];
    const profitableStreams: boolean[] = [];
    const startSec = 1_700_000_000;
    for (let p = 0; p < PAIR_COUNT; p += 1) {
        const rows: ScoreDelta[] = [];
        const tradeCount = 8 + int(24);
        let bucket = int(40);
        for (let t = 0; t < tradeCount && bucket < BUCKET_COUNT - 40; t += 1) {
            const isLong = next() < 0.6;
            const sign = isLong ? 1 : -1;
            const entrySec = startSec + bucket * BUCKET_SECONDS;
            const hold = 4 + int(40);
            const exitBucket = bucket + hold;
            const openEnd = exitBucket >= BUCKET_COUNT || (t === tradeCount - 1 && next() < 0.3);
            const exitSec = openEnd ? null : startSec + exitBucket * BUCKET_SECONDS;
            const pnl = next() < 0.1 ? Number.NaN : (next() - 0.45) * 100;
            const voteApplied = next() < 0.5;
            const confidence = voteApplied && next() < 0.5 ? next() : 0;
            const { base, quote } = pairEndpoints[p]! ?? { base: 0, quote: 1 };
            rows.push({
                entrySec,
                timeSec: entrySec,
                assetIndex: base,
                delta: sign,
                isEntry: 1,
                pnlShare: 0,
                voteApplied,
                profitNowConfidenceWeight: 0,
            });
            rows.push({
                entrySec,
                timeSec: entrySec,
                assetIndex: quote,
                delta: -sign,
                isEntry: 1,
                pnlShare: 0,
                voteApplied,
                profitNowConfidenceWeight: 0,
            });
            if (!openEnd) {
                const pnlShare = Number.isFinite(pnl) ? pnl / 2 : 0;
                rows.push({
                    entrySec,
                    timeSec: exitSec!,
                    assetIndex: base,
                    delta: -sign,
                    isEntry: 0,
                    pnlShare,
                    voteApplied,
                    profitNowConfidenceWeight: confidence,
                });
                rows.push({
                    entrySec,
                    timeSec: exitSec!,
                    assetIndex: quote,
                    delta: sign,
                    isEntry: 0,
                    pnlShare,
                    voteApplied,
                    profitNowConfidenceWeight: confidence,
                });
                bucket = exitBucket + int(6);
            } else {
                bucket = BUCKET_COUNT;
            }
        }
        rows.sort((a, b) => a.timeSec - b.timeSec);
        streams.push(ScoreDeltaBuffer.from(rows, true));
        profitableStreams.push(next() < 0.55);
    }

    return {
        assetNames,
        pairEndpoints,
        validDegree,
        streams,
        profitableStreams,
        interval: "4h",
    };
}

/** Full-fidelity serialization of sweep output for snapshot comparison. */
export function serializeSweepResult(
    events: DecisionEvent[],
    diagnostics: CausalArmDiagnostics | undefined,
): unknown {
    return {
        events: events.map((event) => ({
            timeSec: event.timeSec,
            rawScore: [...event.rawScore],
            activePairCount: [...event.activePairCount],
            rawScoreProfit: [...event.rawScoreProfit],
            activePairCountProfit: [...event.activePairCountProfit],
            rawScoreProfitNow: [...event.rawScoreProfitNow],
            activePairCountProfitNow: [...event.activePairCountProfitNow],
            rawScoreProfitNowConf: [...event.rawScoreProfitNowConf],
            activePairCountProfitNowConf: [...event.activePairCountProfitNowConf],
            causalScores: event.causalScores
                ? [...event.causalScores.entries()].map(([asset, keys]) => [asset, keys])
                : undefined,
        })),
        diagnostics: diagnostics ?? null,
    };
}
