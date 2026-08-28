import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { formatCapturedConfiguration } from "../finder-config-capture";
import type { FinderAssetOpportunityResortMetric } from "../finder-asset-opportunity-metrics";
import type {
    AssetOpportunityForwardOosBaseline,
    AssetOpportunityNextExitOosBaseline,
} from "../finder-asset-opportunity-metadata";
import { buildAssetOpportunityCandidateFingerprint } from "../finder-asset-opportunity-metadata";
import type { FinderAssetOpportunityResult } from "../../types/finder";

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
    /** All-result baseline captured before the top-N slice, when available. */
    baseline?: AssetOpportunityForwardOosBaseline | null;
    measurementMode?: "fixed_horizon" | "next_exit";
    nextExitBaseline?: AssetOpportunityNextExitOosBaseline | null;
}

export interface AssetOpportunityArchiveTupleSnapshot {
    timestamp: string;
    batchRunId: string;
    holdoutBars: number;
    tupleKeys: Set<string>;
}

function assetOpportunityTupleKey(args: {
    symbol: string;
    strategyId: string;
    candidateFingerprint: string;
}): string {
    return `${args.symbol.trim().toUpperCase()}|${args.strategyId.trim()}|${args.candidateFingerprint.trim()}`;
}

export function buildAssetOpportunityTupleKey(result: FinderAssetOpportunityResult): string {
    return assetOpportunityTupleKey({
        symbol: result.symbol,
        strategyId: result.strategyKey,
        candidateFingerprint: buildAssetOpportunityCandidateFingerprint(result),
    });
}

/**
 * Read the tuple identities from existing holdout blocks. A sort writes one
 * block per metric, so blocks sharing timestamp/run/holdout are collapsed into
 * one snapshot and a tuple is counted at most once per archived fold.
 */
export async function readAssetOpportunityArchiveTupleSnapshots(
    root: string,
): Promise<AssetOpportunityArchiveTupleSnapshot[]> {
    const dir = resolveAssetOpportunityArchiveDir(root);
    let filenames: string[];
    try {
        filenames = (await readdir(dir)).filter((filename) => /^oos-holdout-\d+-bars\.txt$/.test(filename));
    } catch {
        return [];
    }
    const snapshots = new Map<string, AssetOpportunityArchiveTupleSnapshot>();
    for (const filename of filenames) {
        const holdoutBars = Number(filename.match(/^(?:oos-holdout-)(\d+)-bars\.txt$/)?.[1]);
        if (!Number.isInteger(holdoutBars) || holdoutBars <= 0) continue;
        let text: string;
        try {
            text = await readFile(path.join(dir, filename), "utf8");
        } catch {
            continue;
        }
        const separator = "=".repeat(80);
        const segments = text.split(separator);
        for (let index = 1; index + 1 < segments.length; index += 2) {
            const header = segments[index]!.trim();
            if (!header.includes("Archive sort:")) continue;
            const timestamp = header.match(/^Timestamp: ([^\n]+)$/m)?.[1];
            const batchRunId = header.match(/^Batch run id: ([^\n]+)$/m)?.[1];
            if (!timestamp || !batchRunId) continue;
            let rows: unknown;
            try {
                rows = JSON.parse(segments[index + 1]!.trim());
            } catch {
                continue;
            }
            if (!Array.isArray(rows)) continue;
            // Each sort append receives its own wall-clock timestamp, so the
            // fold identity is the run/holdout pair rather than the timestamp.
            const snapshotKey = `${batchRunId}|${holdoutBars}`;
            const snapshot = snapshots.get(snapshotKey) ?? {
                timestamp,
                batchRunId,
                holdoutBars,
                tupleKeys: new Set<string>(),
            };
            for (const row of rows) {
                if (!row || typeof row !== "object") continue;
                const value = row as Record<string, unknown>;
                if (typeof value.symbol !== "string"
                    || typeof value.strategyId !== "string"
                    || typeof value.candidateFingerprint !== "string") continue;
                snapshot.tupleKeys.add(assetOpportunityTupleKey({
                    symbol: value.symbol,
                    strategyId: value.strategyId,
                    candidateFingerprint: value.candidateFingerprint,
                }));
            }
            snapshots.set(snapshotKey, snapshot);
        }
    }
    return [...snapshots.values()].sort((left, right) =>
        left.holdoutBars - right.holdoutBars
        || left.timestamp.localeCompare(right.timestamp)
        || left.batchRunId.localeCompare(right.batchRunId));
}

export function countPriorAssetOpportunityTupleRecurrence(args: {
    result: FinderAssetOpportunityResult;
    currentHoldoutBars: number;
    snapshots: readonly AssetOpportunityArchiveTupleSnapshot[];
}): number {
    const tuple = assetOpportunityTupleKey({
        symbol: args.result.symbol,
        strategyId: args.result.strategyKey,
        candidateFingerprint: buildAssetOpportunityCandidateFingerprint(args.result),
    });
    return args.snapshots.filter((snapshot) =>
        snapshot.holdoutBars > args.currentHoldoutBars
        && snapshot.tupleKeys.has(tuple)).length;
}

export function buildAssetOpportunityArchiveBlockText(block: AssetOpportunityArchiveBlock): string {
    const separator = "=".repeat(80);
    return [
        separator,
        `Timestamp: ${block.timestamp}`,
        `Batch run id: ${block.batchRunId}`,
        `OOS holdout: ${block.holdoutBars} bars`,
        `Archive sort: ${block.sortMetric ?? "run_default"}`,
        ...(block.measurementMode ? [`Forward measurement: ${block.measurementMode}`] : []),
        ...(block.baseline ? [`Archive baseline: ${JSON.stringify(block.baseline)}`] : []),
        ...(block.nextExitBaseline ? [`Next-exit archive baseline: ${JSON.stringify(block.nextExitBaseline)}`] : []),
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

const defaultAppend: AssetOpportunityArchiveAppend = async (dir, filename, content) => {
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, filename), content, "utf8");
};

export interface AppendAssetOpportunityArchiveBlockArgs {
    /** Vite-configured project root; archive dir is always `<root>/archive/asset opportunity`. */
    root: string;
    batchRunId: string;
    holdoutBars: number;
    /** Re-sort metric used for this payload; null means the run default. */
    sortMetric?: FinderAssetOpportunityResortMetric | null;
    topResults: unknown;
    baseline?: AssetOpportunityForwardOosBaseline | null;
    measurementMode?: "fixed_horizon" | "next_exit";
    nextExitBaseline?: AssetOpportunityNextExitOosBaseline | null;
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
        baseline: args.baseline,
        measurementMode: args.measurementMode,
        nextExitBaseline: args.nextExitBaseline,
    });
    const append = args.append ?? defaultAppend;
    await append(dir, filename, content);
    return {
        path: path.join(dir, filename),
        bytes: Buffer.byteLength(content, "utf8"),
    };
}

export const ASSET_OPPORTUNITY_ARCHIVE_CONFIG_FILENAME = "config.txt";

export interface AppendAssetOpportunityArchiveRunConfigArgs {
    /** Vite-configured project root; archive dir is always `<root>/archive/asset opportunity`. */
    root: string;
    batchRunId: string;
    /** Serializable run configuration (finder options + backtest + capital settings). */
    config: unknown;
    /** Optional deterministic timestamp for tests. */
    timestamp?: string;
    /** Optional injected append leaf for tests. */
    append?: AssetOpportunityArchiveAppend;
}

/**
 * Append one batch run's full configuration to
 * `<root>/archive/asset opportunity/config.txt` — one delimited block per run
 * (same Timestamp / Batch-run-id header shape as the holdout blocks) so every
 * archived holdout sweep carries a matching, timestamped config record without
 * relying on the operator remembering Copy Configuration.
 */
export async function appendAssetOpportunityArchiveRunConfig(
    args: AppendAssetOpportunityArchiveRunConfigArgs,
): Promise<AssetOpportunityArchiveAppendResult> {
    const dir = resolveAssetOpportunityArchiveDir(args.root);
    const content = [
        "=".repeat(80),
        `Timestamp: ${args.timestamp ?? new Date().toISOString()}`,
        `Batch run id: ${args.batchRunId}`,
        `Run configuration: JSON`,
        "=".repeat(80),
        // Primitive arrays (symbols, strategy keys, horizons) inline on one
        // line — a 500-symbol universe otherwise costs ~1,000 lines per block.
        formatCapturedConfiguration(args.config),
        "",
    ].join("\n");
    const append = args.append ?? defaultAppend;
    await append(dir, ASSET_OPPORTUNITY_ARCHIVE_CONFIG_FILENAME, content);
    return {
        path: path.join(dir, ASSET_OPPORTUNITY_ARCHIVE_CONFIG_FILENAME),
        bytes: Buffer.byteLength(content, "utf8"),
    };
}
