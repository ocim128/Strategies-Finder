import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
    TopMeanCoordinatorRunRequest,
    TopMeanResultSummary,
} from "./sp500-top-mean-coordinator-engine";
import { getRunDir, isValidRunId } from "./sp500-top-mean-artifact-store";
import { canonicalizeLegIdentity } from "../synthetic-leg-identity";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "./batch-open-score-usd-replay-engine";

/**
 * Archive writer notes for Phase 0b:
 * - events-full.jsonl and annual event rows retain `controlReturn` as the
 *   leave-one-out mean of the other eligible assets, never a random draw.
 * - Candidate outcome status is `ok`, `missing_target`, `missing_entry`,
 *   `right_censored`, or `invalid_price`; null returns are never zero-filled.
 * - Offline matched comparisons must apply the same event filter to both the
 *   proposed-pool and full-catalog controls; the files preserve the rows needed
 *   to enforce that rule at analysis time.
 */

export const TOP_MEAN_ARCHIVE_LOG_DIR_NAME = "batch-open-score";

export interface TopMeanArchiveManifest {
    strategy: {
        key: string;
        params: unknown;
        normalizeApplied: boolean;
    };
    settings: {
        backtest: unknown;
        capital: unknown;
    };
    pairs: {
        pairs: readonly string[];
        executionOrderSha256: string;
        sortedSetSha256: string;
        source: {
            kind: "custom_pair_list" | "sp500_default";
            pairListTextSha256?: string;
            poolVersion?: string | null;
        };
        construction: {
            algorithm: string | null;
            seed: number | null;
        };
    };
    catalog: {
        assets: readonly string[];
        sha256: string;
        warmup: number | null;
        dataCutoff: string | null;
    };
    costs: {
        slippageRate: number;
        commissionRate: number;
        slippageBps: number;
        commissionPercent: number;
    };
    windowDesignation: "discovery" | "validation" | "full_history" | "other";
    researchContract: {
        tieVersion: string;
        blockCount: number;
        bootstrapSamples: number;
        bootstrapSeed: number;
    };
}

export interface TopMeanArchiveLogOptions {
    /** Project root; defaults to the current working directory. */
    root?: string;
    /** Environment used to resolve TOP_MEAN_ARCHIVE_LOG_DIR. */
    env?: NodeJS.ProcessEnv;
    /** Canonical assets captured during server-side preflight. */
    canonicalAssets?: readonly string[];
    /** Existing coordinator fingerprint captured during server-side preflight. */
    fingerprint?: string;
    /** Normalized execution provenance captured by the coordinator. */
    manifest: TopMeanArchiveManifest;
    /** Injectable warning sink; production passes debugLogger.warn. */
    warn?: (event: string, data: Record<string, unknown>) => void;
    /** Optional deterministic completion timestamp for tests. */
    completedAt?: string;
    /** Coordinator-owned staged Phase 0b files, already closed before archive. */
    phase0bFiles?: TopMeanPhase0bArchiveFiles;
}

export interface TopMeanPhase0bArchiveFiles {
    poolSnapshotsPath?: string;
    candidateOutcomesPath?: string;
}

export interface TopMeanPhase0bArchiveWriter {
    readonly files: TopMeanPhase0bArchiveFiles;
    onPoolSnapshot(row: PoolSnapshotRecord): Promise<void>;
    onCandidateOutcome(row: CandidateOutcomeRecord): Promise<void>;
    close(): Promise<void>;
    dispose(): Promise<void>;
}

async function writeStreamLine(stream: WriteStream, row: unknown): Promise<void> {
    const line = `${JSON.stringify(row)}\n`;
    if (stream.write(line)) return;
    await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => {
            cleanup();
            resolve();
        };
        const onError = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const cleanup = (): void => {
            stream.off("drain", onDrain);
            stream.off("error", onError);
        };
        stream.once("drain", onDrain);
        stream.once("error", onError);
    });
}

function closeWriteStream(stream: WriteStream): Promise<void> {
    return new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(() => resolve());
    });
}

/** Stage large Phase 0b JSONL outputs without retaining millions of rows. */
export async function createTopMeanPhase0bArchiveWriter(
    root: string | undefined,
    runId: string,
): Promise<TopMeanPhase0bArchiveWriter> {
    const stagingDir = path.join(getRunDir(runId, root), "phase0b");
    await mkdir(stagingDir, { recursive: true });
    const poolSnapshotsPath = path.join(stagingDir, "pool-snapshots.jsonl");
    const candidateOutcomesPath = path.join(stagingDir, "candidate-outcomes.jsonl");
    const poolStream = createWriteStream(poolSnapshotsPath, { encoding: "utf8" });
    const candidateStream = createWriteStream(candidateOutcomesPath, { encoding: "utf8" });
    let closePromise: Promise<void> | null = null;
    const closeStreams = (): Promise<void> => {
        closePromise ??= Promise.all([
            closeWriteStream(poolStream),
            closeWriteStream(candidateStream),
        ]).then(() => undefined);
        return closePromise;
    };
    return {
        files: { poolSnapshotsPath, candidateOutcomesPath },
        onPoolSnapshot: (row) => writeStreamLine(poolStream, row),
        onCandidateOutcome: (row) => writeStreamLine(candidateStream, row),
        close: async () => {
            await closeStreams();
        },
        dispose: async () => {
            try {
                await closeStreams();
            } catch {
                // Best effort cleanup only.
            }
            await rm(stagingDir, { recursive: true, force: true });
        },
    };
}

export function resolveTopMeanArchiveLogDir(
    root: string,
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const override = env.TOP_MEAN_ARCHIVE_LOG_DIR;
    if (override !== undefined && override.trim() === "") {
        return null;
    }
    if (override !== undefined) {
        return path.resolve(override);
    }
    return path.join(root, "archive", TOP_MEAN_ARCHIVE_LOG_DIR_NAME);
}

function computeArchiveFingerprint(
    request: TopMeanCoordinatorRunRequest,
    canonicalAssets: readonly string[],
): string {
    return createHash("sha256").update(JSON.stringify({
        strategyKey: request.strategyKey,
        strategyParams: request.strategyParams,
        backtestSettings: request.backtestSettings,
        capitalSettings: request.capitalSettings,
        interval: request.interval,
        useRustEnginePreference: request.useRustEnginePreference,
        canonicalAssets,
    })).digest("hex");
}

export function sha256LineList(lines: readonly string[]): string {
    return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

function hashText(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

const DISCOVERY_FROM_SEC = Math.floor(Date.parse("2025-01-10T00:00:00.000Z") / 1000);
const DISCOVERY_TO_SEC = Math.floor(Date.parse("2025-12-31T23:59:59.000Z") / 1000);
const VALIDATION_FROM_SEC = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
const VALIDATION_TO_SEC = Math.floor(Date.parse("2026-08-24T23:59:59.000Z") / 1000);

export function resolveTopMeanWindowDesignation(
    request: TopMeanCoordinatorRunRequest,
): TopMeanArchiveManifest["windowDesignation"] {
    const from = request.sampleFromSec;
    const to = request.sampleToSec;
    if (from === undefined && to === undefined) return "full_history";
    if (from === DISCOVERY_FROM_SEC && to === DISCOVERY_TO_SEC) return "discovery";
    if (from === VALIDATION_FROM_SEC && to === VALIDATION_TO_SEC) return "validation";
    return "other";
}

export interface RegistryPoolMatch {
    poolVersion: string;
    algorithm: string | null;
    seed: number | null;
}

export function normalizeAssetPairSet(pairs: readonly string[]): Set<string> | null {
    const normalized = new Set<string>();
    for (const pair of pairs) {
        const [baseToken, quoteToken, ...extra] = pair.split("+");
        if (!baseToken || !quoteToken || extra.length > 0) return null;
        const base = canonicalizeLegIdentity(baseToken);
        const quote = canonicalizeLegIdentity(quoteToken);
        if (!base || !quote || base.scoringAsset === quote.scoringAsset) return null;
        const [first, second] = [base.scoringAsset, quote.scoringAsset].sort((a, b) => a.localeCompare(b));
        normalized.add(`${first}+${second}`);
    }
    return normalized;
}

function hasSameAssetPairSet(left: Set<string>, right: Set<string>): boolean {
    if (left.size !== right.size) return false;
    for (const pair of left) {
        if (!right.has(pair)) return false;
    }
    return true;
}

export async function findRegistryPoolMatch(
    root: string,
    pairs: readonly string[],
): Promise<RegistryPoolMatch | null> {
    try {
        const registryDir = path.join(root, "docs", "pairlist-pools");
        const expectedPairs = normalizeAssetPairSet(pairs);
        if (!expectedPairs) return null;
        const entries = await readdir(registryDir, { withFileTypes: true });
        const matches: RegistryPoolMatch[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            try {
                const registry = JSON.parse(await readFile(path.join(registryDir, entry.name), "utf8")) as {
                    schema?: unknown;
                    poolVersion?: unknown;
                    pairs?: unknown;
                    pairListSha256?: unknown;
                    provenance?: { algorithm?: unknown; effectiveSeed?: unknown };
                };
                if (
                    registry.schema !== "pool-registry.v1"
                    || typeof registry.poolVersion !== "string"
                    || !Array.isArray(registry.pairs)
                    || registry.pairs.length !== pairs.length
                    || registry.pairs.some((pair) => typeof pair !== "string")
                ) {
                    continue;
                }
                const registryPairs = registry.pairs as string[];
                const registryPairHash = sha256LineList(registryPairs);
                const registrySet = normalizeAssetPairSet(registryPairs);
                if (
                    registry.pairListSha256 !== registryPairHash
                    || !registrySet
                    || !hasSameAssetPairSet(expectedPairs, registrySet)
                ) {
                    continue;
                }
                matches.push({
                    poolVersion: registry.poolVersion,
                    algorithm: typeof registry.provenance?.algorithm === "string"
                        ? registry.provenance.algorithm
                        : null,
                    seed: typeof registry.provenance?.effectiveSeed === "number"
                        ? registry.provenance.effectiveSeed
                        : null,
                });
            } catch {
                // Ignore malformed or partially-written registry entries.
            }
        }
        return matches.length === 1 ? matches[0]! : null;
    } catch {
        return null;
    }
}

async function writeJsonlFile<T>(filename: string, rows: readonly T[]): Promise<void> {
    const stream = createWriteStream(filename, { encoding: "utf8" });
    try {
        for (const row of rows) await writeStreamLine(stream, row);
    } finally {
        await closeWriteStream(stream);
    }
}

function defaultWarning(event: string, data: Record<string, unknown>): void {
    console.warn(`[debug] ${event}`, data);
}

/**
 * Persist the permanent TOP_MEAN research archive. This is deliberately a
 * Node-only leaf and has no retention or cleanup behavior.
 *
 * The function is best-effort: it returns false and emits one warning on any
 * failure so archive I/O can never fail the coordinator run.
 */
export async function archiveCompletedTopMeanRun(
    result: TopMeanResultSummary,
    request: TopMeanCoordinatorRunRequest,
    options: TopMeanArchiveLogOptions,
): Promise<boolean> {
    const warn = options.warn ?? defaultWarning;

    if (!result.completed) return false;
    if (!isValidRunId(request.runId)) {
        try {
            warn("sp500_top_mean.archive_log_failed", {
                runId: request.runId,
                error: "Invalid runId",
            });
        } catch {
            // Warning telemetry must never change coordinator control flow.
        }
        return false;
    }

    try {
        const root = options.root ?? process.cwd();
        const archiveRoot = resolveTopMeanArchiveLogDir(root, options.env);
        if (!archiveRoot) return false;

        const canonicalAssets = [...(options.canonicalAssets ?? [])];
        const fingerprint = options.fingerprint
            ?? computeArchiveFingerprint(request, canonicalAssets);
        const runDir = path.join(archiveRoot, request.runId);
        const completedAt = options.completedAt
            ?? result.performance?.completedAt
            ?? new Date().toISOString();
        const performanceEngine = result.performance?.engine ?? {
            requested: request.useRustEnginePreference === true ? "rust" : "typescript",
            actual: request.useRustEnginePreference === true ? "rust" : "typescript",
            typescriptRequirementReasons: [],
        };
        const registryMatch = options.manifest.pairs.source.poolVersion === undefined
            && options.manifest.pairs.source.kind === "custom_pair_list"
            ? await findRegistryPoolMatch(root, options.manifest.pairs.pairs)
            : null;
        const source = {
            ...options.manifest.pairs.source,
            ...(options.manifest.pairs.source.kind === "custom_pair_list" && request.pairListText !== undefined
                ? { pairListTextSha256: hashText(request.pairListText) }
                : {}),
            poolVersion: options.manifest.pairs.source.poolVersion
                ?? registryMatch?.poolVersion
                ?? null,
        };
        const construction = {
            algorithm: options.manifest.pairs.construction.algorithm
                ?? registryMatch?.algorithm
                ?? null,
            seed: options.manifest.pairs.construction.seed
                ?? registryMatch?.seed
                ?? null,
        };
        const manifest = {
            ...options.manifest,
            pairs: {
                ...options.manifest.pairs,
                pairs: [...options.manifest.pairs.pairs],
                source,
                construction,
            },
            catalog: {
                ...options.manifest.catalog,
                assets: [...options.manifest.catalog.assets],
            },
            windowDesignation: resolveTopMeanWindowDesignation(request),
        };
        const meta = {
            schema: "top_mean_archive.v2",
            runId: request.runId,
            completedAt,
            interval: request.interval,
            horizons: request.horizons,
            sampleFromSec: request.sampleFromSec ?? null,
            sampleToSec: request.sampleToSec ?? null,
            workerCount: request.workerCount ?? null,
            maxPairs: request.maxPairs ?? null,
            fingerprint,
            canonicalAssets,
            counts: {
                pairs: result.counts.pairCount,
                assets: canonicalAssets.length,
            },
            engine: performanceEngine,
            useRustEnginePreference: request.useRustEnginePreference === true,
            latestSelections: result.latestSelections ?? null,
            ...(result.currentSnapshot !== undefined
                ? { currentSnapshot: result.currentSnapshot }
                : {}),
            manifest,
        };
        const annualEventFiles = (result.annualReports ?? [])
            .filter((annual) => (annual.eventDetails?.length ?? 0) > 0)
            .map((annual) => ({
                filename: `events-annual-${annual.year}.jsonl`,
                rows: (annual.eventDetails ?? []).map((row) => ({
                    ...row,
                    eventId: `${request.interval}:${row.decisionTime}`,
                    poolVersion: source.poolVersion,
                })),
            }));
        const fullEventRows = (result.openScoreEventDetails ?? []).map((row) => ({
            ...row,
            eventId: `${request.interval}:${row.decisionTime}`,
            poolVersion: source.poolVersion,
        }));

        await mkdir(runDir, { recursive: true });
        await Promise.all([
            writeFile(path.join(runDir, "report.txt"), result.reportLines.join("\n"), "utf8"),
            writeFile(path.join(runDir, "meta.json"), JSON.stringify(meta), "utf8"),
        ]);
        await writeJsonlFile(path.join(runDir, "events-full.jsonl"), fullEventRows);
        for (const file of annualEventFiles) {
            await writeJsonlFile(path.join(runDir, file.filename), file.rows);
        }
        if (options.phase0bFiles?.poolSnapshotsPath) {
            await copyFile(options.phase0bFiles.poolSnapshotsPath, path.join(runDir, "pool-snapshots.jsonl"));
        } else if (result.poolSnapshots !== undefined) {
            await writeJsonlFile(path.join(runDir, "pool-snapshots.jsonl"), result.poolSnapshots);
        }
        if (options.phase0bFiles?.candidateOutcomesPath) {
            await copyFile(options.phase0bFiles.candidateOutcomesPath, path.join(runDir, "candidate-outcomes.jsonl"));
        } else if (result.candidateOutcomes !== undefined) {
            await writeJsonlFile(path.join(runDir, "candidate-outcomes.jsonl"), result.candidateOutcomes);
        }
        return true;
    } catch (error) {
        try {
            warn("sp500_top_mean.archive_log_failed", {
                runId: request.runId,
                error: error instanceof Error ? error.message : String(error),
            });
        } catch {
            // Warning telemetry must never change coordinator control flow.
        }
        return false;
    }
}
