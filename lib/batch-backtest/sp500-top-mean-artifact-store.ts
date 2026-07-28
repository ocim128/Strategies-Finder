import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { CompactPairArtifact, TopMeanRunManifest, BatchSyntheticPairArtifactAdapter } from "./compact-pair-artifact";
import { toBatchSyntheticPairAdapter } from "./compact-pair-artifact";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    // Defense-in-depth: even if a caller forgets to validate at the HTTP
    // boundary, refuse to build a path that escapes the artifacts root. This
    // is the structural guard that covers EVERY fs consumer of runId,
    // including the coordinator-engine write path.
    const resolved = resolve(root, runId);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw new Error("runId escapes artifacts root");
    }
    return join(root, runId);
}

/**
 * Optional window key for the stability mode's per-start-date artifact
 * partitioning. When set, path helpers resolve to
 * `<runDir>/windows/<windowKey>/...` so each stability window gets its own
 * manifest + shards and does not overwrite siblings. `windowKey` must be a
 * safe path segment (validated identically to runId: `[A-Za-z0-9_-]`).
 */
const SAFE_WINDOW_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidWindowKey(windowKey: string): boolean {
    return SAFE_WINDOW_KEY_RE.test(windowKey);
}

function resolveWindowSubdir(windowKey: string | undefined): string {
    if (windowKey === undefined) return "";
    if (!isValidWindowKey(windowKey)) {
        throw new Error("windowKey must be a safe path segment ([A-Za-z0-9_-]{1,64})");
    }
    return join("windows", windowKey);
}

export function getManifestPath(runId: string, baseDir?: string, windowKey?: string): string {
    const sub = resolveWindowSubdir(windowKey);
    return sub
        ? join(getRunDir(runId, baseDir), sub, "manifest.json")
        : join(getRunDir(runId, baseDir), "manifest.json");
}

export function getShardsDir(runId: string, baseDir?: string, windowKey?: string): string {
    const sub = resolveWindowSubdir(windowKey);
    return sub
        ? join(getRunDir(runId, baseDir), sub, "shards")
        : join(getRunDir(runId, baseDir), "shards");
}

export function getShardPath(runId: string, shardIndex: number, baseDir?: string, windowKey?: string): string {
    const shardFileName = `${String(shardIndex).padStart(6, "0")}.json`;
    return join(getShardsDir(runId, baseDir, windowKey), shardFileName);
}

export function computeRunFingerprint(payload: {
    strategyKey: string;
    strategyParams: unknown;
    backtestSettings: unknown;
    capitalSettings: unknown;
    interval: string;
    useRustEnginePreference?: boolean;
    canonicalAssets: string[];
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
export async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
    const dir = dirname(targetPath);
    // Avoid an `existsSync` syscall roundtrip — `mkdir({ recursive: true })`
    // is a no-op when the dir already exists and is cheaper than a separate
    // existence check + mkdir in the common case.
    await mkdir(dir, { recursive: true });
    const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
    await writeFile(tempPath, JSON.stringify(data), "utf8");

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

export function saveManifest(manifest: TopMeanRunManifest, baseDir?: string, windowKey?: string): void {
    manifest.updatedAt = Date.now();
    const manifestPath = getManifestPath(manifest.runId, baseDir, windowKey);
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
    windowKey?: string,
): Promise<void> {
    manifest.updatedAt = Date.now();
    const manifestPath = getManifestPath(manifest.runId, baseDir, windowKey);
    await atomicWriteJson(manifestPath, manifest);
}

export function loadManifest(runId: string, baseDir?: string, windowKey?: string): TopMeanRunManifest | null {
    const manifestPath = getManifestPath(runId, baseDir, windowKey);
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
    windowKey?: string,
): void {
    const shardPath = getShardPath(runId, shardIndex, baseDir, windowKey);
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
    windowKey?: string,
): Promise<void> {
    const shardPath = getShardPath(runId, shardIndex, baseDir, windowKey);
    await atomicWriteJson(shardPath, artifacts);
}

export function readShardArtifacts(
    runId: string,
    shardIndex: number,
    baseDir?: string,
    windowKey?: string,
): CompactPairArtifact[] | null {
    const shardPath = getShardPath(runId, shardIndex, baseDir, windowKey);
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
    windowKey?: string,
): Promise<CompactPairArtifact[] | null> {
    const shardPath = getShardPath(runId, shardIndex, baseDir, windowKey);
    try {
        const content = await readFile(shardPath, "utf8");
        return JSON.parse(content) as CompactPairArtifact[];
    } catch {
        return null;
    }
}

export async function* iterateRunCompactArtifacts(
    runId: string,
    baseDir?: string,
    windowKey?: string,
): AsyncGenerator<BatchSyntheticPairArtifactAdapter> {
    const manifest = loadManifest(runId, baseDir, windowKey);
    if (!manifest) return;

    for (const shardIndex of manifest.completedShards) {
        const shardArtifacts = await readShardArtifactsAsync(runId, shardIndex, baseDir, windowKey);
        if (!shardArtifacts) continue;
        for (const artifact of shardArtifacts) {
            yield toBatchSyntheticPairAdapter(artifact);
        }
    }
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
    windowKey?: string,
): AsyncGenerator<CompactPairArtifact> {
    const manifest = loadManifest(runId, baseDir, windowKey);
    if (!manifest) return;

    for (const shardIndex of manifest.completedShards) {
        const shardArtifacts = await readShardArtifactsAsync(runId, shardIndex, baseDir, windowKey);
        if (!shardArtifacts) continue;
        for (const artifact of shardArtifacts) {
            yield artifact;
        }
    }
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
            const manifest = loadManifest(runId, baseDir);
            if (manifest && manifest.status === "running") {
                manifest.status = "interrupted";
                saveManifest(manifest, baseDir);
            }
        }
    } catch {
        // Ignore startup reconciliation errors
    }
}
