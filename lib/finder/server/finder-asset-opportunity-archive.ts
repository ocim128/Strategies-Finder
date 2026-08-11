import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FinderAssetOpportunityResortMetric } from "../finder-asset-opportunity-metrics";

/**
 * Server-side archive leaf for Asset Opportunity batch iterations.
 *
 * The archive directory is always `<configured root>/archive/asset opportunity`
 * and the filename is derived ONLY from the validated integer holdout N
 * (`oos-holdout-<N>-bars.txt`), so a request can never influence the
 * filesystem path. One or more blocks are appended per iteration; re-running
 * the same N appends new delimited blocks and never overwrites or deduplicates
 * prior research.
 *
 * Node-only (imports `node:fs/promises` + `node:path`): must never be
 * imported from browser-bound modules. The append leaf is injectable so tests
 * can verify filenames/delimiters without touching the real archive.
 */

export const ASSET_OPPORTUNITY_ARCHIVE_DIR_NAME = "asset opportunity";

/** Resolve the archive directory from a Vite-configured project root. */
export function resolveAssetOpportunityArchiveDir(root: string): string {
    return path.join(root, "archive", ASSET_OPPORTUNITY_ARCHIVE_DIR_NAME);
}

/**
 * Filename for one holdout value. Accepts only a validated positive integer
 * so a caller cannot smuggle a path separator or arbitrary text into the
 * filesystem layer.
 */
export function buildAssetOpportunityArchiveFilename(holdoutBars: number): string {
    if (!Number.isInteger(holdoutBars) || holdoutBars <= 0) {
        throw new Error(`Invalid holdout bars for archive filename: ${String(holdoutBars)}.`);
    }
    return `oos-holdout-${holdoutBars}-bars.txt`;
}

export interface AssetOpportunityArchiveBlock {
    /** ISO timestamp of the iteration completion. */
    timestamp: string;
    /** The batch run id that produced this block. */
    batchRunId: string;
    holdoutBars: number;
    /** Re-sort metric used for this payload; null means the run default. */
    sortMetric?: FinderAssetOpportunityResortMetric | null;
    /** Compact performance-only rows (array of per-row objects). */
    topResults: unknown;
}

export function buildAssetOpportunityArchiveBlockText(block: AssetOpportunityArchiveBlock): string {
    const separator = "=".repeat(80);
    return [
        separator,
        `Timestamp: ${block.timestamp}`,
        `Batch run id: ${block.batchRunId}`,
        `OOS holdout: ${block.holdoutBars} bars`,
        `Archive sort: ${block.sortMetric ?? "run_default"}`,
        separator,
        JSON.stringify(block.topResults),
        "",
    ].join("\n");
}

/** Injectable filesystem append; production default mkdirs + appends UTF-8. */
export type AssetOpportunityArchiveAppend = (
    dir: string,
    filename: string,
    content: string,
) => Promise<void>;

export interface AppendAssetOpportunityArchiveBlockArgs {
    /** Vite-configured project root; archive dir is always `<root>/archive/asset opportunity`. */
    root: string;
    batchRunId: string;
    holdoutBars: number;
    /** Re-sort metric used for this payload; null means the run default. */
    sortMetric?: FinderAssetOpportunityResortMetric | null;
    topResults: unknown;
    /** Optional deterministic timestamp for tests. */
    timestamp?: string;
    /** Optional injected append leaf for tests. */
    append?: AssetOpportunityArchiveAppend;
}

export interface AssetOpportunityArchiveAppendResult {
    /** Absolute path of the appended file. */
    path: string;
    /** UTF-8 byte count of the appended block. */
    bytes: number;
}

export async function appendAssetOpportunityArchiveBlock(
    args: AppendAssetOpportunityArchiveBlockArgs,
): Promise<AssetOpportunityArchiveAppendResult> {
    const filename = buildAssetOpportunityArchiveFilename(args.holdoutBars);
    const dir = resolveAssetOpportunityArchiveDir(args.root);
    const content = buildAssetOpportunityArchiveBlockText({
        timestamp: args.timestamp ?? new Date().toISOString(),
        batchRunId: args.batchRunId,
        holdoutBars: args.holdoutBars,
        sortMetric: args.sortMetric ?? null,
        topResults: args.topResults,
    });
    const append = args.append ?? (async (dirPath, fileName, fileContent) => {
        await mkdir(dirPath, { recursive: true });
        await appendFile(path.join(dirPath, fileName), fileContent, "utf8");
    });
    await append(dir, filename, content);
    return {
        path: path.join(dir, filename),
        bytes: Buffer.byteLength(content, "utf8"),
    };
}
