import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { resolveAssetOpportunityArchiveDir } from "../finder/server/finder-asset-opportunity-archive";
import {
    ARCHIVE_FILE_PATTERN,
    parseAssetOpportunityArchiveText,
    type AssetOpportunityArchiveRecord,
} from "./archive-parser";
import {
    ExplorerAnalysisError,
    buildViewFromCompactBlocks,
    compactRunRecord,
    keepLatestCompactBlock,
    summarizeRunCatalog,
    type ExplorerView,
    type ExplorerViewBlock,
} from "./analysis";
import type { AssetOpportunityExplorerCatalogRun } from "./types";

/** Minimal fs surface for per-file reads; injectable so tests can simulate appends. */
export interface ArchiveFileIo {
    stat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
    readFile(filePath: string): Promise<string>;
}

export interface ArchiveScanIo extends ArchiveFileIo {
    /** Directory listing; defaults to a real readdir with file types. */
    listDir?(dir: string): Promise<Dirent[]>;
}

const defaultFileIo: ArchiveFileIo = {
    stat: async (filePath) => {
        const info = await stat(filePath);
        return { size: info.size, mtimeMs: info.mtimeMs };
    },
    readFile: (filePath) => readFile(filePath, "utf8"),
};

function listDefaultDir(dir: string): Promise<Dirent[]> {
    return readdir(dir, { withFileTypes: true });
}

/**
 * Bounded async archive scan for the Opportunity Explorer.
 *
 * Reads matching archive files ONE at a time (stat → read → stat), parses,
 * compacts to catalog metadata plus at most one run's compact view, and
 * releases the raw records before opening the next file. Never retains all
 * runs' records or builds the CLI report object. The CLI's synchronous
 * whole-directory reader stays in `scripts/analyze-asset-opportunity-holdouts.ts`.
 */

export interface AssetOpportunityArchiveScanOutcome {
    archiveRootRelative: string;
    scannedAt: string;
    fileCount: number;
    /** Per-run catalog metadata for every batch run seen. */
    runs: AssetOpportunityExplorerCatalogRun[];
    /** Compact view for `retainRunId` when requested; null otherwise. */
    view: ExplorerView | null;
}

function mergeRunSummaries(
    merged: Map<string, AssetOpportunityExplorerCatalogRun>,
    runs: readonly AssetOpportunityExplorerCatalogRun[],
): void {
    for (const run of runs) {
        const existing = merged.get(run.batchRunId);
        if (!existing) {
            merged.set(run.batchRunId, {
                ...run,
                holdoutBars: [...run.holdoutBars],
                sortMetrics: [...run.sortMetrics],
                horizons: [...run.horizons],
            });
            continue;
        }
        existing.latestTimestamp = existing.latestTimestamp.localeCompare(run.latestTimestamp) >= 0
            ? existing.latestTimestamp
            : run.latestTimestamp;
        existing.holdoutBars = [...new Set([...existing.holdoutBars, ...run.holdoutBars])].sort((left, right) => left - right);
        existing.sortMetrics = [...new Set([...existing.sortMetrics, ...run.sortMetrics])].sort((left, right) => left.localeCompare(right));
        existing.horizons = [...new Set([...existing.horizons, ...run.horizons])].sort((left, right) => left - right);
        existing.archiveMaximumRank = Math.max(existing.archiveMaximumRank, run.archiveMaximumRank);
        existing.sourceBlockCount += run.sourceBlockCount;
        existing.hasBaselines = existing.hasBaselines || run.hasBaselines;
        existing.support = existing.support === run.support ? existing.support : "mixed_modes";
    }
}

function catalogForScan(runsById: Map<string, AssetOpportunityExplorerCatalogRun>): AssetOpportunityExplorerCatalogRun[] {
    return [...runsById.values()].sort((left, right) => right.latestTimestamp.localeCompare(left.latestTimestamp)
        || left.batchRunId.localeCompare(right.batchRunId));
}

function accumulateViewRecord(
    viewBlocks: Map<string, ExplorerViewBlock> | null,
    retainRunId: string | null,
    record: AssetOpportunityArchiveRecord,
): void {
    if (!viewBlocks || record.batchRunId !== retainRunId) return;
    keepLatestCompactBlock(viewBlocks, compactRunRecord(record));
}

/**
 * Stat → read → stat one archive file and parse its blocks. An append or
 * rewrite mid-read must surface as a retryable archive-changed error, never as
 * an apparently complete mixed snapshot.
 */
export async function readArchiveFileWithChangeDetection(args: {
    filePath: string;
    filename: string;
    io?: ArchiveFileIo;
}): Promise<AssetOpportunityArchiveRecord[]> {
    const io = args.io ?? defaultFileIo;
    const before = await io.stat(args.filePath);
    const text = await io.readFile(args.filePath);
    const after = await io.stat(args.filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new ExplorerAnalysisError(409, `Archive file "${args.filename}" changed while scanning; retry the request.`);
    }
    try {
        return parseAssetOpportunityArchiveText(text, args.filename);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // A corrupt file fails the whole scan: serving a partial heatmap would
        // present an incomplete sample as successfully loaded.
        throw new ExplorerAnalysisError(422, `Archive file "${args.filename}" could not be parsed and was not skipped: ${detail}`);
    }
}

/**
 * Scan the archive once. `retainRunId` compacts that run's deduplicated blocks
 * into the returned view; pass null for a metadata-only catalog scan.
 */
export async function scanAssetOpportunityArchive(args: {
    root: string;
    retainRunId: string | null;
    /** Injected filesystem layer (test seam); production reads the real filesystem. */
    io?: ArchiveScanIo;
}): Promise<AssetOpportunityArchiveScanOutcome> {
    const archiveDir = resolveAssetOpportunityArchiveDir(args.root);
    const archiveRootRelative = path.relative(args.root, archiveDir).replace(/\\/g, "/");
    const scannedAt = new Date().toISOString();
    let entries: Dirent[];
    try {
        entries = await (args.io?.listDir ?? listDefaultDir)(archiveDir);
    } catch (error) {
        // A missing archive folder is an explicit empty state; any other read
        // failure (permissions, I/O) is an actionable error, never "empty".
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return { archiveRootRelative, scannedAt, fileCount: 0, runs: [], view: null };
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new ExplorerAnalysisError(500, `Cannot read the archive directory "${archiveRootRelative}": ${detail}`);
    }
    const filenames = entries
        .filter((entry) => entry.isFile() && ARCHIVE_FILE_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const runsById = new Map<string, AssetOpportunityExplorerCatalogRun>();
    const viewBlocks = args.retainRunId ? new Map<string, ExplorerViewBlock>() : null;
    for (const filename of filenames) {
        const records = await readArchiveFileWithChangeDetection({
            filePath: path.join(archiveDir, filename),
            filename,
            ...(args.io ? { io: args.io } : {}),
        });
        mergeRunSummaries(runsById, summarizeRunCatalog(records));
        for (const record of records) accumulateViewRecord(viewBlocks, args.retainRunId, record);
        // Yield between files so a large scan cannot block the dev server loop.
        await new Promise((resolve) => setImmediate(resolve));
    }
    return {
        archiveRootRelative,
        scannedAt,
        fileCount: filenames.length,
        runs: catalogForScan(runsById),
        view: args.retainRunId ? buildViewFromCompactBlocks(args.retainRunId, [...viewBlocks!.values()]) : null,
    };
}
