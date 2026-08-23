import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { formatCapturedConfiguration } from "../finder-config-capture";
import type { FinderAssetOpportunityResortMetric } from "../finder-asset-opportunity-metrics";
import type {
    AssetOpportunityForwardOosBaseline,
    AssetOpportunityPairSummaryRow,
} from "../finder-asset-opportunity-metadata";
import type { FinderAssetOpportunityFoldMetadata } from "../finder-asset-opportunity-fold";
import type {
    FinderAssetOpportunityCandidateSummaryRow,
    FinderAssetOpportunityPairContextRow,
    FinderFreshWindowBatchRole,
    FinderFreshWindowJudgmentStatus,
} from "../finder-asset-opportunity-research-types";
import type { FinderAssetOpportunityControlDraw } from "../finder-asset-opportunity-control-trace";

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
export const ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER = "Record complete: true";

export const ASSET_OPPORTUNITY_RESEARCH_PROGRAMS = ["fresh-window"] as const;
export type AssetOpportunityResearchProgram = typeof ASSET_OPPORTUNITY_RESEARCH_PROGRAMS[number];
export type { FinderFreshWindowBatchRole } from "../finder-asset-opportunity-research-types";

export function isAssetOpportunityResearchProgram(value: unknown): value is AssetOpportunityResearchProgram {
    return typeof value === "string"
        && (ASSET_OPPORTUNITY_RESEARCH_PROGRAMS as readonly string[]).includes(value);
}

/** Resolve the archive directory from a Vite-configured project root. */
export function resolveAssetOpportunityArchiveDir(
    root: string,
    program?: AssetOpportunityResearchProgram,
): string {
    return program === undefined
        ? path.join(root, "archive", ASSET_OPPORTUNITY_ARCHIVE_DIR_NAME)
        : path.join(root, "archive", program);
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

export function buildAssetOpportunityPairSummaryFilename(holdoutBars: number): string {
    if (!Number.isInteger(holdoutBars) || holdoutBars <= 0) {
        throw new Error(`Invalid holdout bars for pair summary archive filename: ${String(holdoutBars)}.`);
    }
    return `oos-pair-summary-${holdoutBars}-bars.txt`;
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
    foldMetadata?: FinderAssetOpportunityFoldMetadata;
    dataSyncSnapshot?: string;
    gitCommit?: string;
    judgmentStatus?: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons?: string[];
}

export function buildAssetOpportunityFoldIdentityFilename(holdoutBars: number): string {
    if (!Number.isInteger(holdoutBars) || holdoutBars <= 0) {
        throw new Error(`Invalid holdout bars for archive filename: ${String(holdoutBars)}.`);
    }
    return `oos-fold-identities-${holdoutBars}-bars.txt`;
}

export function buildAssetOpportunityArchiveBlockText(block: AssetOpportunityArchiveBlock): string {
    const separator = "=".repeat(80);
    return [
        separator,
        `Timestamp: ${block.timestamp}`,
        `Batch run id: ${block.batchRunId}`,
        `OOS holdout: ${block.holdoutBars} bars`,
        `Archive sort: ${block.sortMetric ?? "run_default"}`,
        ...(block.foldMetadata ? [
            `Fold end: ${block.foldMetadata.foldEnd}`,
            `Search window end: ${block.foldMetadata.searchWindowEnd ?? "unknown"}`,
            `OOS start: ${block.foldMetadata.oosStart ?? "unknown"}`,
            `OOS end: ${block.foldMetadata.oosEnd ?? "unknown"}`,
        ] : []),
        ...(block.dataSyncSnapshot ? [`Data sync snapshot: ${block.dataSyncSnapshot}`] : []),
        ...(block.gitCommit ? [`Git commit: ${block.gitCommit}`] : []),
        ...(block.judgmentStatus ? [`Judgment: ${block.judgmentStatus}`] : []),
        ...(block.judgmentInvalidReasons && block.judgmentInvalidReasons.length > 0
            ? [`Judgment invalid reasons: ${JSON.stringify(block.judgmentInvalidReasons)}`]
            : []),
        ...(block.baseline ? [`Archive baseline: ${JSON.stringify(block.baseline)}`] : []),
        separator,
        JSON.stringify(block.topResults),
        ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER,
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
    const handle = await open(path.join(dir, filename), "a");
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
    } finally {
        await handle.close();
    }
};

export interface AppendAssetOpportunityArchiveBlockArgs {
    /** Vite-configured project root; archive dir is always `<root>/archive/asset opportunity`. */
    root: string;
    program?: AssetOpportunityResearchProgram;
    batchRunId: string;
    holdoutBars: number;
    /** Re-sort metric used for this payload; null means the run default. */
    sortMetric?: FinderAssetOpportunityResortMetric | null;
    topResults: unknown;
    baseline?: AssetOpportunityForwardOosBaseline | null;
    foldMetadata?: FinderAssetOpportunityFoldMetadata;
    dataSyncSnapshot?: string;
    gitCommit?: string;
    judgmentStatus?: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons?: string[];
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
    const dir = resolveAssetOpportunityArchiveDir(args.root, args.program);
    const content = buildAssetOpportunityArchiveBlockText({
        timestamp: args.timestamp ?? new Date().toISOString(),
        batchRunId: args.batchRunId,
        holdoutBars: args.holdoutBars,
        sortMetric: args.sortMetric ?? null,
        topResults: args.topResults,
        baseline: args.baseline,
        ...(args.foldMetadata ? { foldMetadata: args.foldMetadata } : {}),
        ...(args.dataSyncSnapshot ? { dataSyncSnapshot: args.dataSyncSnapshot } : {}),
        ...(args.gitCommit ? { gitCommit: args.gitCommit } : {}),
        ...(args.judgmentStatus ? { judgmentStatus: args.judgmentStatus } : {}),
        ...(args.judgmentInvalidReasons ? { judgmentInvalidReasons: args.judgmentInvalidReasons } : {}),
    });
    const append = args.append ?? defaultAppend;
    await append(dir, filename, content);
    return {
        path: path.join(dir, filename),
        bytes: Buffer.byteLength(content, "utf8"),
    };
}

export interface AssetOpportunityPairSummaryBlock {
    timestamp: string;
    batchRunId: string;
    holdoutBars: number;
    pairSummaries: AssetOpportunityPairSummaryRow[];
    fullPoolContext?: FinderAssetOpportunityPairContextRow[];
    judgmentStatus?: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons?: string[];
}

export function buildAssetOpportunityPairSummaryBlockText(
    block: AssetOpportunityPairSummaryBlock,
): string {
    const separator = "=".repeat(80);
    return [
        separator,
        `Timestamp: ${block.timestamp}`,
        `Batch run id: ${block.batchRunId}`,
        `OOS holdout: ${block.holdoutBars} bars`,
        "Pair summaries: JSON",
        separator,
        JSON.stringify(block.pairSummaries),
        ...(block.fullPoolContext ? [
            "Full-pool pair context: JSON",
            separator,
            JSON.stringify(block.fullPoolContext),
        ] : []),
        ...(block.judgmentStatus ? [`Judgment: ${block.judgmentStatus}`] : []),
        ...(block.judgmentInvalidReasons && block.judgmentInvalidReasons.length > 0
            ? [`Judgment invalid reasons: ${JSON.stringify(block.judgmentInvalidReasons)}`]
            : []),
        ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER,
        "",
    ].join("\n");
}

export interface AppendAssetOpportunityArchivePairSummaryArgs {
    root: string;
    program?: AssetOpportunityResearchProgram;
    batchRunId: string;
    holdoutBars: number;
    pairSummaries: AssetOpportunityPairSummaryRow[];
    fullPoolContext?: FinderAssetOpportunityPairContextRow[];
    judgmentStatus?: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons?: string[];
    timestamp?: string;
    append?: AssetOpportunityArchiveAppend;
}

export interface AssetOpportunityFoldIdentityBlock {
    timestamp: string;
    batchRunId: string;
    batchRole?: FinderFreshWindowBatchRole;
    holdoutBars: number;
    declaredRowCount: number;
    /** Independent evaluator count; unlike declaredRowCount this is not derived from rows. */
    expectedRowCount?: number;
    /** Number of rows carrying the primary forward outcome. */
    outcomeRowCount?: number;
    controlSeed?: number;
    controlDrawIdentities?: FinderAssetOpportunityControlDraw[];
    controlDrawDigest?: string;
    rows: FinderAssetOpportunityCandidateSummaryRow[];
    foldMetadata?: FinderAssetOpportunityFoldMetadata;
    dataSyncSnapshot?: string;
    gitCommit?: string;
    judgmentStatus?: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons?: string[];
}

export function buildAssetOpportunityFoldIdentityBlockText(
    block: AssetOpportunityFoldIdentityBlock,
): string {
    if (block.declaredRowCount !== block.rows.length) {
        throw new Error(
            `Fold identity row count mismatch: declared ${block.declaredRowCount}, received ${block.rows.length}.`,
        );
    }
    const separator = "=".repeat(80);
    return [
        separator,
        `Timestamp: ${block.timestamp}`,
        `Batch run id: ${block.batchRunId}`,
        ...(block.batchRole ? [`Batch role: ${block.batchRole}`] : []),
        `Fold id: ${block.holdoutBars}`,
        `OOS holdout: ${block.holdoutBars} bars`,
        `Declared row count: ${block.declaredRowCount}`,
        `Expected evaluated row count: ${block.expectedRowCount ?? "unknown"}`,
        `Forward outcome row count: ${block.outcomeRowCount ?? "unknown"}`,
        `Control seed: ${block.controlSeed ?? "unknown"}`,
        `Control draw digest: ${block.controlDrawDigest ?? "unknown"}`,
        `Control draw identities: ${block.controlDrawIdentities ? JSON.stringify(block.controlDrawIdentities) : "unknown"}`,
        ...(block.foldMetadata ? [
            `Fold end: ${block.foldMetadata.foldEnd}`,
            `Search window end: ${block.foldMetadata.searchWindowEnd ?? "unknown"}`,
            `OOS start: ${block.foldMetadata.oosStart ?? "unknown"}`,
            `OOS end: ${block.foldMetadata.oosEnd ?? "unknown"}`,
        ] : []),
        ...(block.dataSyncSnapshot ? [`Data sync snapshot: ${block.dataSyncSnapshot}`] : []),
        ...(block.gitCommit ? [`Git commit: ${block.gitCommit}`] : []),
        ...(block.judgmentStatus ? [`Judgment: ${block.judgmentStatus}`] : []),
        ...(block.judgmentInvalidReasons && block.judgmentInvalidReasons.length > 0
            ? [`Judgment invalid reasons: ${JSON.stringify(block.judgmentInvalidReasons)}`]
            : []),
        separator,
        JSON.stringify(block.rows),
        ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER,
        "",
    ].join("\n");
}

export interface AppendAssetOpportunityArchiveFoldIdentitiesArgs {
    root: string;
    program?: AssetOpportunityResearchProgram;
    batchRunId: string;
    batchRole?: FinderFreshWindowBatchRole;
    holdoutBars: number;
    rows: FinderAssetOpportunityCandidateSummaryRow[];
    expectedRowCount?: number;
    outcomeRowCount?: number;
    controlSeed?: number;
    controlDrawIdentities?: FinderAssetOpportunityControlDraw[];
    controlDrawDigest?: string;
    foldMetadata?: FinderAssetOpportunityFoldMetadata;
    dataSyncSnapshot?: string;
    gitCommit?: string;
    judgmentStatus?: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons?: string[];
    timestamp?: string;
    append?: AssetOpportunityArchiveAppend;
}

export async function appendAssetOpportunityArchiveFoldIdentities(
    args: AppendAssetOpportunityArchiveFoldIdentitiesArgs,
): Promise<AssetOpportunityArchiveAppendResult> {
    const filename = buildAssetOpportunityFoldIdentityFilename(args.holdoutBars);
    const dir = resolveAssetOpportunityArchiveDir(args.root, args.program);
    const content = buildAssetOpportunityFoldIdentityBlockText({
        timestamp: args.timestamp ?? new Date().toISOString(),
        batchRunId: args.batchRunId,
        ...(args.batchRole ? { batchRole: args.batchRole } : {}),
        holdoutBars: args.holdoutBars,
        declaredRowCount: args.rows.length,
        ...(args.expectedRowCount !== undefined ? { expectedRowCount: args.expectedRowCount } : {}),
        ...(args.outcomeRowCount !== undefined ? { outcomeRowCount: args.outcomeRowCount } : {}),
        ...(args.controlSeed !== undefined ? { controlSeed: args.controlSeed } : {}),
        ...(args.controlDrawIdentities ? { controlDrawIdentities: args.controlDrawIdentities } : {}),
        ...(args.controlDrawDigest ? { controlDrawDigest: args.controlDrawDigest } : {}),
        rows: args.rows,
        ...(args.foldMetadata ? { foldMetadata: args.foldMetadata } : {}),
        ...(args.dataSyncSnapshot ? { dataSyncSnapshot: args.dataSyncSnapshot } : {}),
        ...(args.gitCommit ? { gitCommit: args.gitCommit } : {}),
        ...(args.judgmentStatus ? { judgmentStatus: args.judgmentStatus } : {}),
        ...(args.judgmentInvalidReasons ? { judgmentInvalidReasons: args.judgmentInvalidReasons } : {}),
    });
    const append = args.append ?? defaultAppend;
    await append(dir, filename, content);
    return {
        path: path.join(dir, filename),
        bytes: Buffer.byteLength(content, "utf8"),
    };
}

export async function appendAssetOpportunityArchivePairSummary(
    args: AppendAssetOpportunityArchivePairSummaryArgs,
): Promise<AssetOpportunityArchiveAppendResult> {
    const filename = buildAssetOpportunityPairSummaryFilename(args.holdoutBars);
    const dir = resolveAssetOpportunityArchiveDir(args.root, args.program);
    const content = buildAssetOpportunityPairSummaryBlockText({
        timestamp: args.timestamp ?? new Date().toISOString(),
        batchRunId: args.batchRunId,
        holdoutBars: args.holdoutBars,
        pairSummaries: args.pairSummaries,
        ...(args.fullPoolContext ? { fullPoolContext: args.fullPoolContext } : {}),
        ...(args.judgmentStatus ? { judgmentStatus: args.judgmentStatus } : {}),
        ...(args.judgmentInvalidReasons ? { judgmentInvalidReasons: args.judgmentInvalidReasons } : {}),
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
    program?: AssetOpportunityResearchProgram;
    batchRunId: string;
    /** Serializable run configuration (finder options + backtest + capital settings). */
    config: unknown;
    judgmentStatus?: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons?: string[];
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
    const dir = resolveAssetOpportunityArchiveDir(args.root, args.program);
    const content = [
        "=".repeat(80),
        `Timestamp: ${args.timestamp ?? new Date().toISOString()}`,
        `Batch run id: ${args.batchRunId}`,
        `Run configuration: JSON`,
        ...(args.judgmentStatus ? [`Judgment: ${args.judgmentStatus}`] : []),
        ...(args.judgmentInvalidReasons && args.judgmentInvalidReasons.length > 0
            ? [`Judgment invalid reasons: ${JSON.stringify(args.judgmentInvalidReasons)}`]
            : []),
        "=".repeat(80),
        // Primitive arrays (symbols, strategy keys, horizons) inline on one
        // line — a 500-symbol universe otherwise costs ~1,000 lines per block.
        formatCapturedConfiguration(args.config),
        ASSET_OPPORTUNITY_ARCHIVE_RECORD_COMPLETE_MARKER,
        "",
    ].join("\n");
    const append = args.append ?? defaultAppend;
    await append(dir, ASSET_OPPORTUNITY_ARCHIVE_CONFIG_FILENAME, content);
    return {
        path: path.join(dir, ASSET_OPPORTUNITY_ARCHIVE_CONFIG_FILENAME),
        bytes: Buffer.byteLength(content, "utf8"),
    };
}
