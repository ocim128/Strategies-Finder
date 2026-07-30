import type { BatchDatasetCacheStats } from "../batch-backtest/batch-dataset-loader-core";

export interface RankPairsPerformanceTimings {
    parseInput: number;
    prepareRelationships: number;
    load: number;
    classify: number;
    liveRender: number;
    progress: number;
    yield: number;
    sort: number;
    finalRender: number;
}

export interface RankPairsCacheDelta {
    legHits: number;
    legMisses: number;
    pairHits: number;
    pairMisses: number;
    recentLegHits?: number;
    recentLegMisses?: number;
}

export interface RankPairsPerformanceDiagnostics {
    totalPairs: number;
    processedPairs: number;
    renderedPairs: number;
    totalBars: number;
    elapsedMs: number;
    timingsMs: RankPairsPerformanceTimings;
    cacheDelta: RankPairsCacheDelta;
}

export function nowRankPairsMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createRankPairsPerformanceTimings(): RankPairsPerformanceTimings {
    return {
        parseInput: 0,
        prepareRelationships: 0,
        load: 0,
        classify: 0,
        liveRender: 0,
        progress: 0,
        yield: 0,
        sort: 0,
        finalRender: 0,
    };
}

export function buildRankPairsCacheDelta(
    before: BatchDatasetCacheStats,
    after: BatchDatasetCacheStats,
): RankPairsCacheDelta {
    return {
        legHits: after.leg.hits - before.leg.hits,
        legMisses: after.leg.misses - before.leg.misses,
        pairHits: after.pair.hits - before.pair.hits,
        pairMisses: after.pair.misses - before.pair.misses,
    };
}

function formatDuration(ms: number): string {
    if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;
    return `${ms.toFixed(1)}ms`;
}

function formatPhase(label: string, ms: number, elapsedMs: number): string {
    const percent = elapsedMs > 0 ? (ms / elapsedMs) * 100 : 0;
    return `${label} ${formatDuration(ms)} (${percent.toFixed(1)}%)`;
}

export function formatRankPairsPerformanceDiagnostics(
    diagnostics: RankPairsPerformanceDiagnostics,
): string {
    const { elapsedMs, timingsMs, cacheDelta } = diagnostics;
    const measuredMs = Object.values(timingsMs).reduce((sum, ms) => sum + ms, 0);
    const otherMs = Math.max(0, elapsedMs - measuredMs);
    const pairsPerSecond = elapsedMs > 0
        ? diagnostics.processedPairs / (elapsedMs / 1_000)
        : 0;
    return [
        `Perf ${formatDuration(elapsedMs)}`,
        `${pairsPerSecond.toFixed(1)} pairs/s`,
        `shown ${diagnostics.renderedPairs.toLocaleString("en-US")}/${diagnostics.processedPairs.toLocaleString("en-US")}`,
        `${diagnostics.totalBars.toLocaleString("en-US")} bars`,
        formatPhase("parse", timingsMs.parseInput, elapsedMs),
        formatPhase("prepare", timingsMs.prepareRelationships, elapsedMs),
        formatPhase("load", timingsMs.load, elapsedMs),
        formatPhase("classify", timingsMs.classify, elapsedMs),
        formatPhase("live DOM", timingsMs.liveRender, elapsedMs),
        formatPhase("progress", timingsMs.progress, elapsedMs),
        formatPhase("yield", timingsMs.yield, elapsedMs),
        formatPhase("sort", timingsMs.sort, elapsedMs),
        formatPhase("final DOM", timingsMs.finalRender, elapsedMs),
        formatPhase("other", otherMs, elapsedMs),
        `cache leg ${cacheDelta.legHits}H/${cacheDelta.legMisses}M`,
        `pair ${cacheDelta.pairHits}H/${cacheDelta.pairMisses}M`,
        `recent leg ${cacheDelta.recentLegHits ?? 0}H/${cacheDelta.recentLegMisses ?? 0}M`,
    ].join(" | ");
}
