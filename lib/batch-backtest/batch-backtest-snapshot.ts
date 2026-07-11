import { toScalarRow } from "./batch-backtest-stream-types";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import type { BatchStabilityMineResult } from "./batch-stability-mine";
import type { BatchSyntheticMinerProfile } from "./batch-synthetic-state-miner";

export const BATCH_RESULT_SNAPSHOT_LIMIT = 2_000;

export interface BatchBacktestResultsSnapshot {
    savedAt: number;
    interval: string;
    fingerprint: string | null;
    // The strategy that governed the Run that produced these results. Mine /
    // Stability Mine persist timing-edge verdicts labeled with this key; if it
    // is lost (older snapshots predate the field), Mine persistence is skipped
    // rather than silently attributing verdicts to the currently-selected UI
    // strategy. See `persistMineTimingResult`.
    strategyKey: string | null;
    serverHasArtifacts: boolean;
    results: BatchBacktestSymbolResult[];
    stabilityResult?: BatchStabilityMineResult | null;
}

export function compactBatchBacktestResultsSnapshot(
    snapshot: BatchBacktestResultsSnapshot,
): BatchBacktestResultsSnapshot {
    return {
        savedAt: Number.isFinite(snapshot.savedAt) ? snapshot.savedAt : Date.now(),
        interval: snapshot.interval,
        fingerprint: typeof snapshot.fingerprint === "string" ? snapshot.fingerprint : null,
        strategyKey: typeof snapshot.strategyKey === "string" && snapshot.strategyKey ? snapshot.strategyKey : null,
        serverHasArtifacts: snapshot.serverHasArtifacts === true,
        results: snapshot.results
            .slice(0, BATCH_RESULT_SNAPSHOT_LIMIT)
            .map(toScalarRow),
        ...(snapshot.stabilityResult ? { stabilityResult: compactStabilityResult(snapshot.stabilityResult) } : {}),
    };
}

export function normalizeBatchBacktestResultsSnapshot(value: unknown): BatchBacktestResultsSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Partial<BatchBacktestResultsSnapshot>;
    if (!Array.isArray(candidate.results) || candidate.results.length === 0) {
        return null;
    }
    return compactBatchBacktestResultsSnapshot({
        savedAt: typeof candidate.savedAt === "number" ? candidate.savedAt : 0,
        interval: typeof candidate.interval === "string" ? candidate.interval : "",
        fingerprint: typeof candidate.fingerprint === "string" ? candidate.fingerprint : null,
        strategyKey: typeof candidate.strategyKey === "string" && candidate.strategyKey ? candidate.strategyKey : null,
        serverHasArtifacts: candidate.serverHasArtifacts === true,
        results: candidate.results as BatchBacktestSymbolResult[],
        stabilityResult: normalizeStabilityResult(candidate.stabilityResult),
    });
}

function compactStabilityResult(result: BatchStabilityMineResult): BatchStabilityMineResult {
    return {
        reruns: Math.max(0, Math.floor(Number(result.reruns) || 0)),
        subsetSize: Math.max(0, Math.floor(Number(result.subsetSize) || 0)),
        seed: Math.max(0, Math.floor(Number(result.seed) || 0)),
        totalPairs: Math.max(0, Math.floor(Number(result.totalPairs) || 0)),
        targetAssets: Math.max(0, Math.floor(Number(result.targetAssets) || 0)),
        hitEvents: Math.max(0, Math.floor(Number(result.hitEvents) || 0)),
        minerProfile: compactMinerProfile(result.minerProfile),
        ...(result.engine === "typescript" || result.engine === "typescript_parallel"
            ? { engine: result.engine }
            : {}),
        rows: Array.isArray(result.rows)
            ? result.rows.map((row): BatchStabilityMineResult["rows"][number] => ({
                    asset: String(row.asset ?? "").trim().toUpperCase(),
                    direction: row.direction === "SHORT" ? "SHORT" : "LONG",
                    hits: Math.max(0, Math.floor(Number(row.hits) || 0)),
                    high: Math.max(0, Math.floor(Number(row.high) || 0)),
                    medium: Math.max(0, Math.floor(Number(row.medium) || 0)),
                    low: Math.max(0, Math.floor(Number(row.low) || 0)),
                    medianRetPct: finiteOrNull(row.medianRetPct),
                    medianLiftPct: finiteOrNull(row.medianLiftPct),
                    medianRr: finiteOrNull(row.medianRr),
                    medianDist: finiteOrNull(row.medianDist),
                    medianHmaxLiftPct: finiteOrNull(row.medianHmaxLiftPct),
                    pairWarnings: Math.max(0, Math.floor(Number(row.pairWarnings) || 0)),
                    timingEdgeScore: Math.max(0, Number(row.timingEdgeScore) || 0),
                    medianDiversity: Math.max(0, Math.min(1, Number(row.medianDiversity) || 0)),
                    asOfTimeKey: typeof row.asOfTimeKey === "string" && row.asOfTimeKey.trim() ? row.asOfTimeKey.trim() : null,
                    close: finiteOrNull(row.close),
                    medianBarsHeld: finiteOrNull(row.medianBarsHeld),
                    agreementTransition: finiteOrNull(row.agreementTransition),
                    freshHits: Math.max(0, Math.floor(Number(row.freshHits) || 0)),
                    dominantPair: typeof row.dominantPair === "string" && row.dominantPair.trim() ? row.dominantPair.trim().toUpperCase() : null,
                    dominantPairShare: Math.max(0, Math.min(1, Number(row.dominantPairShare) || 0)),
                }))
                .filter((row) => row.asset)
            : [],
    };
}

function compactMinerProfile(profile: BatchSyntheticMinerProfile | null | undefined): BatchSyntheticMinerProfile | null {
    if (!profile || typeof profile !== "object") return null;
    return {
        prepareTargetsMs: finiteOrZero(profile.prepareTargetsMs),
        preparePairsMs: finiteOrZero(profile.preparePairsMs),
        subsetTargetFilterMs: finiteOrZero(profile.subsetTargetFilterMs),
        runPreparedMs: finiteOrZero(profile.runPreparedMs),
        buildVerdictsMs: finiteOrZero(profile.buildVerdictsMs),
        sortVerdictsMs: finiteOrZero(profile.sortVerdictsMs),
        linkedPairFilterMs: finiteOrZero(profile.linkedPairFilterMs),
        horizonMs: finiteOrZero(profile.horizonMs),
        currentSnapshotMs: finiteOrZero(profile.currentSnapshotMs),
        candidateSamplesMs: finiteOrZero(profile.candidateSamplesMs),
        windowingMs: finiteOrZero(profile.windowingMs),
        distanceScaleMs: finiteOrZero(profile.distanceScaleMs),
        analogSelectionMs: finiteOrZero(profile.analogSelectionMs),
        summarizeMs: finiteOrZero(profile.summarizeMs),
        pairContributionsMs: finiteOrZero(profile.pairContributionsMs),
        classifyMs: finiteOrZero(profile.classifyMs),
        targetsEvaluated: intOrZero(profile.targetsEvaluated),
        artifactsEvaluated: intOrZero(profile.artifactsEvaluated),
        linkedPairsEvaluated: intOrZero(profile.linkedPairsEvaluated),
        candidateSamples: intOrZero(profile.candidateSamples),
        preOosSamples: intOrZero(profile.preOosSamples),
        oosSamples: intOrZero(profile.oosSamples),
        earlyNoLinkedPairs: intOrZero(profile.earlyNoLinkedPairs),
        earlyShortTargetHistory: intOrZero(profile.earlyShortTargetHistory),
        earlyNoCurrentState: intOrZero(profile.earlyNoCurrentState),
        earlyNotEnoughCandidates: intOrZero(profile.earlyNotEnoughCandidates),
        analogCandidatesScored: intOrZero(profile.analogCandidatesScored),
        topKSelected: intOrZero(profile.topKSelected),
        assetIndexHits: intOrZero(profile.assetIndexHits),
        assetIndexMisses: intOrZero(profile.assetIndexMisses),
        artifactConversionMs: finiteOrZero(profile.artifactConversionMs),
        parallelWorkerCount: intOrZero(profile.parallelWorkerCount),
    };
}

function normalizeStabilityResult(value: unknown): BatchStabilityMineResult | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const compact = compactStabilityResult(value as BatchStabilityMineResult);
    return compact.rows.length > 0 ? compact : null;
}

function finiteOrNull(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function finiteOrZero(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function intOrZero(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}
