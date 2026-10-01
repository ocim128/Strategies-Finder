import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { CompactPairArtifact, TopMeanRunManifest, BatchSyntheticPairArtifactAdapter } from "./compact-pair-artifact";
import { toBatchSyntheticPairAdapter } from "./compact-pair-artifact";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const PARSED_SHARD_CACHE_MAX_ENTRIES = 32;
// A shard can contain tens of MB of trade JSON, so entry count alone does
// not bound this process-wide cache. Parsed object overhead is additional.
export const TOP_MEAN_PARSED_SHARD_CACHE_MAX_JSON_BYTES = 32 * 1024 * 1024;

interface ParsedShardCacheEntry {
    mtimeMs: number;
    artifacts: CompactPairArtifact[];
    jsonBytes: number;
}

// Annual TOP_MEAN replay passes revisit the same completed shards. Keep the
// parsed working set bounded while using the file mtime to self-invalidate
// after a resumed run replaces a shard.
const parsedShardCache = new Map<string, ParsedShardCacheEntry>();
let parsedShardCacheJsonBytes = 0;

function deleteParsedShardCacheEntry(path: string): void {
    const entry = parsedShardCache.get(path);
    if (entry) parsedShardCacheJsonBytes -= entry.jsonBytes;
    parsedShardCache.delete(path);
}

/** Release parsed artifacts after their owning run has been removed. */
export function evictRunParsedShardCache(runId: string, baseDir?: string): number {
    const prefix = getRunDir(runId, baseDir) + sep;
    let removed = 0;
    for (const path of parsedShardCache.keys()) {
        if (!path.startsWith(prefix)) continue;
        deleteParsedShardCacheEntry(path);
        removed += 1;
    }
    return removed;
}

/**
 * Allow-list for run ids. Browser-generated ids are `batch-<ts36>-<rand>` and
 * `sp500_top_mean_<ts>_<rand>` — both pure `[A-Za-z0-9_-]`. The regex rejects
 * path separators, `..`, and any other character that could escape the
 * artifacts root once `runId` is joined into a filesystem path. Shared with
 * `batch-backtest-vite-plugin.ts` so the HTTP boundary and the structural
 * `getRunDir` guard stay in lockstep.
 */
const SAFE_RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Fast-fail validator for run ids that reach the filesystem. Throws a generic
 * Error (not an HTTP error) so it stays usable from non-HTTP callers such as
 * the coordinator engine. HTTP handlers wrap this in a 400 at the boundary.
 */
export function isValidRunId(runId: string): boolean {
    return SAFE_RUN_ID_RE.test(runId);
}

export function getArtifactsRootDir(baseDir?: string): string {
    const root = baseDir || process.cwd();
    return resolve(root, "artifacts", "sp500-top-mean");
}

export function getRunDir(runId: string, baseDir?: string): string {
    const root = getArtifactsRootDir(baseDir);
    // Audit (POST run-id finding): the containment check below only rejects
    // paths that ESCAPE the root — an id like `foo/../existing` resolves
    // INSIDE the root and would alias another run's directory. The allow-list
    // is therefore the primary structural guard; the containment check stays
    // as defense-in-depth beneath it.
    if (!isValidRunId(runId)) {
        throw new Error("Invalid runId");
    }
    const resolved = resolve(root, runId);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw new Error("runId escapes artifacts root");
    }
    return join(root, runId);
}

export function getManifestPath(runId: string, baseDir?: string): string {
    return join(getRunDir(runId, baseDir), "manifest.json");
}

export function getShardsDir(runId: string, baseDir?: string): string {
    return join(getRunDir(runId, baseDir), "shards");
}

export function getShardPath(runId: string, shardIndex: number, baseDir?: string): string {
    const shardFileName = `${String(shardIndex).padStart(6, "0")}.json`;
    return join(getShardsDir(runId, baseDir), shardFileName);
}

export function computeRunFingerprint(payload: {
    strategyKey: string;
    strategyParams: unknown;
    backtestSettings: unknown;
    capitalSettings: unknown;
    interval: string;
    useRustEnginePreference?: boolean;
    canonicalAssets: string[];
    /**
     * Ordered canonical pair sequence. Load-bearing for resume safety (audit
     * resume-fingerprint finding): assets alone cannot distinguish two runs
     * with a different pair composition, and a fingerprint mismatch is the
     * only thing that stops a resumed run from reusing shards computed for
     * pairs that were never requested.
     */
    canonicalPairs: string[];
}): string {
    const jsonStr = JSON.stringify(payload);
    return createHash("sha256").update(jsonStr).digest("hex");
}

export function atomicWriteJsonSync(targetPath: string, data: unknown): void {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
    writeFileSync(tempPath, JSON.stringify(data), "utf8");

    // Windows can briefly deny replacing an existing file while an antivirus
    // scanner or the Vite watcher still has the destination open. The write
    // is already staged in the same directory, so a short bounded retry keeps
    // the operation atomic without falling back to delete-then-rename.
    const attempts = process.platform === "win32" ? 10 : 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            renameSync(tempPath, targetPath);
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException).code;
            const retryable = process.platform === "win32"
                && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
            if (!retryable || attempt === attempts - 1) break;

            // This is a synchronous API, so use a small bounded wait between
            // attempts rather than allowing overlapping manifest writes.
            const delayMs = Math.min(25 * (attempt + 1), 100);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        }
    }

    try {
        rmSync(tempPath, { force: true });
    } catch {
        // Preserve the original rename failure; cleanup is best effort.
    }
    throw lastError;
}

/**
 * Async twin of `atomicWriteJsonSync`. Same atomic-write semantics (temp file
 * in the same dir, then rename) and the same Windows retry policy, but uses
 * `fs/promises` so callers on the main thread of a hot server path do not
 * block the event loop on multi-hundred-KB shard artifacts. The retry wait
 * uses real `setTimeout` (no `Atomics.wait`) so other microtasks can run.
 */
/**
 * Shared async atomic write/rename core (shard byte-transfer phase): same
 * temp-file placement, Windows retry policy, cleanup, and error propagation
 * as {@link atomicWriteJsonSync}, but writes raw bytes — the worker already
 * serialized the payload, so the coordinator never re-stringifies it.
 */
export async function atomicWriteBytes(targetPath: string, bytes: Uint8Array): Promise<void> {
    const dir = dirname(targetPath);
    // Avoid an `existsSync` syscall roundtrip — `mkdir({ recursive: true })`
    // is a no-op when the dir already exists and is cheaper than a separate
    // existence check + mkdir in the common case.
    await mkdir(dir, { recursive: true });
    const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
    await writeFile(tempPath, bytes);

    const attempts = process.platform === "win32" ? 10 : 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            await rename(tempPath, targetPath);
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException).code;
            const retryable = process.platform === "win32"
                && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
            if (!retryable || attempt === attempts - 1) break;
            const delayMs = Math.min(25 * (attempt + 1), 100);
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
    }

    try {
        await rm(tempPath, { force: true });
    } catch {
        // Preserve the original rename failure; cleanup is best effort.
    }
    throw lastError;
}

export async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
    await atomicWriteBytes(targetPath, new TextEncoder().encode(JSON.stringify(data)));
}

export function saveManifest(manifest: TopMeanRunManifest, baseDir?: string): void {
    manifest.updatedAt = Date.now();
    const manifestPath = getManifestPath(manifest.runId, baseDir);
    atomicWriteJsonSync(manifestPath, manifest);
}

/**
 * Async twin of `saveManifest` for hot paths. Stamps `updatedAt` and uses
 * `atomicWriteJson` so a per-shard-complete flush on the dev server main
 * thread does not block the event loop on the multi-KB write + rename.
 */
export async function saveManifestAsync(
    manifest: TopMeanRunManifest,
    baseDir?: string,
): Promise<void> {
    manifest.updatedAt = Date.now();
    const manifestPath = getManifestPath(manifest.runId, baseDir);
    await atomicWriteJson(manifestPath, manifest);
}

export function loadManifest(runId: string, baseDir?: string): TopMeanRunManifest | null {
    const manifestPath = getManifestPath(runId, baseDir);
    if (!existsSync(manifestPath)) return null;
    try {
        const content = readFileSync(manifestPath, "utf8");
        return JSON.parse(content) as TopMeanRunManifest;
    } catch {
        return null;
    }
}

export function writeShardArtifacts(
    runId: string,
    shardIndex: number,
    artifacts: CompactPairArtifact[],
    baseDir?: string,
): void {
    const shardPath = getShardPath(runId, shardIndex, baseDir);
    atomicWriteJsonSync(shardPath, artifacts);
}

/**
 * Async twin of `writeShardArtifacts` for the worker-pool per-shard path.
 * Multi-hundred-KB artifact writes happening on every `shard_complete` were
 * the dominant main-thread blocker during 400-shard TOP_MEAN runs; this
 * version lets the message handler return immediately while the write lands.
 * The caller is responsible for awaiting in-flight writes before forcing a
 * terminal manifest flush (or before resolving the run) to preserve
 * resume-from-disk safety.
 */
export async function writeShardArtifactsAsync(
    runId: string,
    shardIndex: number,
    artifacts: CompactPairArtifact[],
    baseDir?: string,
): Promise<void> {
    const shardPath = getShardPath(runId, shardIndex, baseDir);
    await atomicWriteJson(shardPath, artifacts);
}

/**
 * Byte-writing shard entry point (shard byte-transfer phase): the worker
 * serializes its artifact array once and transfers the UTF-8 bytes; this
 * persists them without decoding or re-stringifying. Same path construction
 * and atomic-write semantics as {@link writeShardArtifactsAsync} — the
 * parsed output is byte-identical JSON.
 */
export async function writeShardArtifactsBytesAsync(
    runId: string,
    shardIndex: number,
    bytes: Uint8Array,
    baseDir?: string,
): Promise<void> {
    const shardPath = getShardPath(runId, shardIndex, baseDir);
    await atomicWriteBytes(shardPath, bytes);
}

export function readShardArtifacts(
    runId: string,
    shardIndex: number,
    baseDir?: string,
): CompactPairArtifact[] | null {
    const shardPath = getShardPath(runId, shardIndex, baseDir);
    if (!existsSync(shardPath)) return null;
    try {
        const content = readFileSync(shardPath, "utf8");
        return JSON.parse(content) as CompactPairArtifact[];
    } catch {
        return null;
    }
}

export async function readShardArtifactsAsync(
    runId: string,
    shardIndex: number,
    baseDir?: string,
): Promise<CompactPairArtifact[] | null> {
    // Path validation remains an error even for best-effort readers.
    getShardPath(runId, shardIndex, baseDir);
    try {
        return await readRequiredShardArtifactsAsync(runId, shardIndex, baseDir);
    } catch {
        return null;
    }
}

export class TopMeanShardReadError extends Error {
    constructor(
        readonly runId: string,
        readonly shardIndex: number,
        readonly failureKind: "missing" | "invalid_json" | "invalid_shape" | "io_error",
        readonly cause?: unknown,
    ) {
        super(`TOP_MEAN run ${runId}: completed shard ${shardIndex} is unreadable (${failureKind}).`);
        this.name = "TopMeanShardReadError";
    }
}

/** Coordinators must never silently omit a shard already counted as completed. */
export async function readRequiredShardArtifactsAsync(
    runId: string,
    shardIndex: number,
    baseDir?: string,
): Promise<CompactPairArtifact[]> {
    const shardPath = getShardPath(runId, shardIndex, baseDir);
    try {
        const mtimeMs = (await stat(shardPath)).mtimeMs;
        const cached = parsedShardCache.get(shardPath);
        if (cached && cached.mtimeMs === mtimeMs) {
            parsedShardCache.delete(shardPath);
            parsedShardCache.set(shardPath, cached);
            return cached.artifacts;
        }
        const content = await readFile(shardPath, "utf8");
        const parsed: unknown = JSON.parse(content);
        if (!Array.isArray(parsed) || !parsed.every((artifact: unknown) => {
            if (!artifact || typeof artifact !== "object") return false;
            const row = artifact as Partial<CompactPairArtifact>;
            return row.schema === "compact_pair_artifact.v1"
                && Number.isInteger(row.pairIndex) && row.pairIndex! >= 0
                && ["symbol", "baseAsset", "quoteAsset", "baseSymbol", "quoteSymbol"]
                    .every((key) => typeof (row as Record<string, unknown>)[key] === "string")
                && Array.isArray(row.trades);
        })) {
            throw new TopMeanShardReadError(runId, shardIndex, "invalid_shape");
        }
        const artifacts = parsed as CompactPairArtifact[];
        const jsonBytes = Buffer.byteLength(content, "utf8");
        deleteParsedShardCacheEntry(shardPath);
        // Oversized shards still stream to their consumer, but are never
        // retained in the process-wide parsed cache.
        if (jsonBytes <= TOP_MEAN_PARSED_SHARD_CACHE_MAX_JSON_BYTES) {
            parsedShardCache.set(shardPath, { mtimeMs, artifacts, jsonBytes });
            parsedShardCacheJsonBytes += jsonBytes;
        }
        while (parsedShardCache.size > PARSED_SHARD_CACHE_MAX_ENTRIES
            || parsedShardCacheJsonBytes > TOP_MEAN_PARSED_SHARD_CACHE_MAX_JSON_BYTES) {
            const oldestKey = parsedShardCache.keys().next().value;
            if (oldestKey === undefined) break;
            deleteParsedShardCacheEntry(oldestKey);
        }
        return artifacts;
    } catch (error) {
        deleteParsedShardCacheEntry(shardPath);
        if (error instanceof TopMeanShardReadError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        throw new TopMeanShardReadError(runId, shardIndex,
            code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid_json" : "io_error",
            error);
    }
}

/**
 * Ordered read-ahead window over a run's completed shards (shard-overhead
 * plan phase 3): at most {@link TOP_MEAN_SHARD_READ_AHEAD} shard reads are in
 * flight while results are consumed strictly in the manifest's existing
 * completedShards order — the window overlaps filesystem latency without
 * loading the whole shard set concurrently or changing artifact order.
 * Default readers skip unreadable shards as before; coordinators select a
 * strict reader and fail instead. Both reuse mtime validation and the parsed
 * cache budget. Exported only as a narrow seam for
 * the read-ahead spec; production callers use the public iterators below.
 */
export const TOP_MEAN_SHARD_READ_AHEAD = 4;

export interface TopMeanArtifactReadOptions {
    /** Fail on missing manifests or unreadable completed shards; default keeps legacy best-effort reads. */
    strict?: boolean;
}

export async function* iterateRunShardsWithReadAhead<T>(
    runId: string,
    baseDir: string | undefined,
    adapt: (artifact: CompactPairArtifact) => T,
    readShard: (runId: string, shardIndex: number, baseDir?: string) => Promise<CompactPairArtifact[] | null> = readShardArtifactsAsync,
    options: TopMeanArtifactReadOptions = {},
): AsyncGenerator<T> {
    const manifest = loadManifest(runId, baseDir);
    if (!manifest) {
        if (options.strict) throw new Error(`TOP_MEAN run ${runId}: manifest is missing or unreadable.`);
        return;
    }
    const completedShards = manifest.completedShards;
    const shardReader = options.strict && readShard === readShardArtifactsAsync
        ? readRequiredShardArtifactsAsync : readShard;
    let nextToStart = 0;
    const inFlight = new Map<number, Promise<CompactPairArtifact[] | null>>();
    const fillWindow = (): void => {
        while (nextToStart < completedShards.length && inFlight.size < TOP_MEAN_SHARD_READ_AHEAD) {
            const shardIndex = completedShards[nextToStart]!;
            const pending = shardReader(runId, shardIndex, baseDir);
            // A later prefetched read can fail while an earlier shard is still
            // being consumed. Observe it immediately; the ordered await below
            // still throws, and finally drains every outstanding read.
            void pending.catch(() => undefined);
            inFlight.set(nextToStart, pending);
            nextToStart += 1;
        }
    };
    try {
        fillWindow();
        for (let i = 0; i < completedShards.length; i += 1) {
            const pending = inFlight.get(i);
            if (!pending) {
                throw new Error(`Shard read ${i} was not prefetched`);
            }
            const shardArtifacts = await pending;
            inFlight.delete(i);
            fillWindow();
            if (!shardArtifacts) {
                if (options.strict) throw new TopMeanShardReadError(runId, completedShards[i]!, "io_error");
                continue;
            }
            for (const artifact of shardArtifacts) {
                yield adapt(artifact);
            }
        }
    } finally {
        // Early consumer exit (break/throw/return): stop scheduling and
        // settle every outstanding read so no rejection is orphaned and no
        // work detaches into the background. readShardArtifactsAsync resolves
        // null on failure, but settle defensively regardless of the reader.
        await Promise.allSettled([...inFlight.values()]);
        inFlight.clear();
    }
}

export async function* iterateRunCompactArtifacts(
    runId: string,
    baseDir?: string,
    options: TopMeanArtifactReadOptions = {},
): AsyncGenerator<BatchSyntheticPairArtifactAdapter> {
    yield* iterateRunShardsWithReadAhead(runId, baseDir, toBatchSyntheticPairAdapter,
        options.strict ? readRequiredShardArtifactsAsync : readShardArtifactsAsync, options);
}

/**
 * Raw compact-artifact iterator (no adapter). Used by the Phase-1 current
 * snapshot reducer, which needs the optional `dataEndTime` field directly off
 * the stored artifact. Reads the same completed shards as
 * {@link iterateRunCompactArtifacts}; the only difference is the yield shape.
 */
export async function* iterateRunRawCompactArtifacts(
    runId: string,
    baseDir?: string,
    options: TopMeanArtifactReadOptions = {},
): AsyncGenerator<CompactPairArtifact> {
    yield* iterateRunShardsWithReadAhead(runId, baseDir, (artifact) => artifact,
        options.strict ? readRequiredShardArtifactsAsync : readShardArtifactsAsync, options);
}

export function cleanOldArtifacts(baseDir?: string, maxAgeMs = DEFAULT_RETENTION_MS): void {
    const rootDir = getArtifactsRootDir(baseDir);
    if (!existsSync(rootDir)) return;

    try {
        const entries = readdirSync(rootDir);
        const now = Date.now();

        for (const entry of entries) {
            const entryPath = join(rootDir, entry);
            try {
                const stat = statSync(entryPath);
                if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
                    rmSync(entryPath, { recursive: true, force: true });
                    if (isValidRunId(entry)) evictRunParsedShardCache(entry, baseDir);
                }
            } catch {
                // Ignore per-entry cleanup errors
            }
        }
    } catch {
        // Ignore root scan cleanup errors
    }
}

export function reconcileInterruptedManifestsOnStartup(baseDir?: string): void {
    const rootDir = getArtifactsRootDir(baseDir);
    if (!existsSync(rootDir)) return;

    try {
        const entries = readdirSync(rootDir);
        for (const runId of entries) {
            try {
                const manifest = loadManifest(runId, baseDir);
                if (manifest && manifest.status === "running") {
                    manifest.status = "interrupted";
                    saveManifest(manifest, baseDir);
                }
            } catch {
                // Skip entries whose names fail the run-id allow-list
                // (getRunDir throws on them) or that cannot be read; they
                // must not abort reconciliation of the remaining runs.
            }
        }
    } catch {
        // Ignore startup reconciliation errors
    }
}
