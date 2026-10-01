import type { TopMeanRunManifest } from "./compact-pair-artifact";
import type { OpenScoreUsdReplayResult } from "./open-score-replay/types";
import type { CoverageCounts } from "./sp500-pair-enumerator";
import {
    buildTopMeanHorizonSummaries,
    type TopMeanHorizonSummary,
    type TopMeanResultSummary,
} from "./sp500-top-mean-coordinator-engine";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeHorizons(value: unknown): TopMeanHorizonSummary[] | null {
    if (!Array.isArray(value)) return null;
    const summaries: TopMeanHorizonSummary[] = [];
    for (const row of value) {
        if (!isRecord(row) || !isRecord(row.topMean)) return null;
        if (typeof row.horizon === "number" && Number.isFinite(row.horizon)) {
            summaries.push(row as unknown as TopMeanHorizonSummary);
        } else if (typeof row.bars === "number" && Number.isFinite(row.bars)) {
            // Raw replay horizons are deliberately kept on disk. Copy the
            // asset breakdown because the shared summary builder sorts it.
            const raw = {
                ...row,
                topMeanByAsset: Array.isArray(row.topMeanByAsset) ? [...row.topMeanByAsset] : [],
            } as unknown as OpenScoreUsdReplayResult["horizons"][number];
            summaries.push(...buildTopMeanHorizonSummaries({ horizons: [raw] } as OpenScoreUsdReplayResult));
        } else return null;
    }
    return summaries;
}

function normalizeCounts(value: unknown, manifest: TopMeanRunManifest): CoverageCounts {
    const counts: CoverageCounts = {
        sp500AssetsCount: 0, catalogAssetsCount: 0, usable30mSeedCount: 0,
        usableTargetIntervalCount: 0, pairCount: manifest.pairCount,
        excludedAssetsCount: 0, excludedPairsCount: 0,
    };
    if (isRecord(value)) {
        for (const key of Object.keys(counts) as Array<keyof CoverageCounts>) {
            const count = value[key];
            if (typeof count === "number" && Number.isFinite(count) && count >= 0) counts[key] = count;
        }
    }
    return counts;
}

/**
 * Convert full raw replay files, historical summary files, and pre-replay
 * snapshot checkpoints to the UI contract. Explicit fields prevent uncapped
 * raw aliases (especially eventDetails) from leaking through the wire spread.
 * Legacy files have no full enumeration counts; retain their manifest pair
 * count and leave unavailable coverage counters at zero.
 */
export function normalizePersistedTopMeanResult(
    value: unknown,
    manifest: TopMeanRunManifest,
): TopMeanResultSummary | null {
    if (!isRecord(value)) return null;
    for (const key of ["horizons", "annualReports", "eventDetails", "openScoreEventDetails",
        "ongoingEventDetails", "warnings", "reportLines"]) {
        if (value[key] != null && !Array.isArray(value[key])) return null;
    }
    const horizons = value.horizons === undefined && "currentSnapshot" in value
        ? [] : normalizeHorizons(value.horizons);
    if (!horizons) return null;
    // Assertions are confined to this persisted boundary after checking the
    // discriminating root/horizon shapes. Optional fields keep old v1 files readable.
    const stored = value as Partial<TopMeanResultSummary> & Partial<OpenScoreUsdReplayResult>;
    const annualReports: NonNullable<TopMeanResultSummary["annualReports"]> = [];
    for (const annual of stored.annualReports ?? []) {
        const annualHorizons = normalizeHorizons(annual.horizons);
        if (!annualHorizons) return null;
        annualReports.push({
            year: annual.year,
            sampleFromSec: annual.sampleFromSec,
            sampleToSec: annual.sampleToSec,
            replayMode: annual.replayMode,
            horizons: annualHorizons,
            assetSwitch: annual.assetSwitch,
            eventDetails: annual.eventDetails,
            eventDetailCount: annual.eventDetailCount,
            warnings: annual.warnings ?? [],
            reportLines: annual.reportLines ?? [],
        });
    }
    return {
        runId: manifest.runId,
        replayMode: stored.replayMode ?? stored.mode ?? manifest.replayMode ?? "horizon",
        selectionCooldownBars: stored.selectionCooldownBars ?? manifest.selectionCooldownBars ?? 0,
        completed: manifest.status === "completed",
        archiveComplete: manifest.archiveComplete ?? stored.archiveComplete ?? false,
        archiveRequested: manifest.archiveRequested ?? stored.archiveRequested,
        archiveDir: manifest.archiveDir ?? stored.archiveDir,
        archiveError: manifest.archiveError ?? stored.archiveError,
        counts: normalizeCounts(stored.counts, manifest),
        horizons,
        annualReports,
        assetSwitch: stored.assetSwitch,
        openScoreEventDetails: stored.openScoreEventDetails ?? stored.eventDetails,
        openScoreEventDetailCount: stored.openScoreEventDetailCount,
        ongoingEventDetails: stored.ongoingEventDetails,
        warnings: stored.warnings ?? [],
        reportLines: stored.reportLines ?? [],
        latestSelections: stored.latestSelections,
        performance: stored.performance,
        currentSnapshot: stored.currentSnapshot,
        replayTargetLoadFailureCount: stored.replayTargetLoadFailureCount,
        targetDataBoundary: stored.targetDataBoundary,
        noTradePairs: stored.noTradePairs,
    };
}
