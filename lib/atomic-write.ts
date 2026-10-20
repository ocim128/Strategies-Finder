/**
 * One atomic-write core for every persistence path in this repo.
 *
 * Before this module there were five near-copies of "write a sibling temp file,
 * then rename it over the target", each with a different (and in one case
 * missing) Windows retry policy, a different temp-name scheme, and different
 * cleanup behavior. The copies drifted: the crypto CSV writer used a FIXED
 * `<file>.tmp` name (two concurrent syncs clobber each other's staged bytes) and
 * did no cleanup on failure, while the IBKR and SP500 writers retried locked
 * renames on Windows.
 *
 * Contract:
 * - The temp file always lives in the destination directory, so `rename` is a
 *   same-filesystem atomic replace: a crash leaves either the old file or the
 *   complete new file, never a truncated hybrid.
 * - The temp name is unique per WRITE (`pid` + clock + random), so concurrent
 *   writers — including worker threads sharing a pid — never share a staged file.
 * - On Windows (and only Windows) a destination held open by an antivirus
 *   scanner / file watcher surfaces `EPERM`/`EACCES`/`EBUSY`; those are retried
 *   with a bounded backoff. Every other error, and every error on other
 *   platforms, surfaces immediately.
 * - A failed write removes its own temp file and rethrows the original error, so
 *   retry callers can distinguish "locked destination" from "disk full".
 *
 * Leaf module: `node:` builtins only, no repo imports. Safe to pull into a Vite
 * config bundle, a Worker, a browser-less script, or a test.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Windows-only rename attempts used by most writers. */
export const ATOMIC_WRITE_ATTEMPTS = 10;
/** Upper bound for one retry pause; keeps a locked file from stalling a run. */
export const ATOMIC_WRITE_MAX_DELAY_MS = 100;

/**
 * Injectable seams. Production calls pass nothing; specs pass a fake platform,
 * a recording `rename`, and a `wait` that records instead of sleeping so a
 * retry policy can be asserted without real time passing.
 */
export interface AtomicWriteDependencies {
    /** Defaults to `process.platform`. Tests force `"win32"` to exercise retries. */
    platform?: NodeJS.Platform | string;
    /** Clock for temp-name uniqueness. Defaults to `Date.now`. */
    now?: () => number;
    /** Random source in `[0, 1)`. Defaults to `Math.random`. */
    random?: () => number;
    /** Sync pause between retries. Defaults to a bounded `Atomics.wait`. */
    wait?: (delayMs: number) => void;
    /** Async pause between retries. Defaults to `setTimeout`. */
    sleep?: (delayMs: number) => Promise<void>;
    /** Async rename override (tests). */
    renameAsync?: (sourcePath: string, targetPath: string) => Promise<void>;
    /** Sync rename override (tests). */
    renameSync?: (sourcePath: string, targetPath: string) => void;
    /**
     * Total rename attempts on Windows for the write helpers. Defaults to
     * {@link ATOMIC_WRITE_ATTEMPTS}.
     */
    attempts?: number;
}

export interface ReplaceFileWithRetryDependencies extends AtomicWriteDependencies {
    /**
     * Last-resort recovery, e.g. restoring from a `.bak` copy. Returns true when
     * the target is now in a usable state, in which case the replace is treated
     * as successful.
     */
    fallback?: (sourcePath: string, targetPath: string, error: unknown) => boolean;
}

/** Total rename attempts for a platform: retries exist only for Windows locks. */
export function resolveReplaceAttempts(
    platform: string,
    attempts: number | undefined,
    fallbackDefault = ATOMIC_WRITE_ATTEMPTS,
): number {
    if (platform !== "win32") return 1;
    const requested = Math.floor(Number(attempts));
    if (!Number.isFinite(requested) || requested < 1) return fallbackDefault;
    return requested;
}

/** True for the transient destination locks Windows file scanners produce. */
export function isRetryableReplaceError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Linear backoff shared by the sync and async retry loops. */
export function replaceRetryDelayMs(attempt: number): number {
    return Math.min(25 * (attempt + 1), ATOMIC_WRITE_MAX_DELAY_MS);
}

/**
 * Unique sibling temp path for one write.
 *
 * The name is unique per write, not per process: worker threads share a pid, so
 * a `<file>.<pid>.tmp` scheme let one writer's rename steal (and later delete) a
 * temp file another writer was still staging.
 */
export function atomicTempPath(targetPath: string, dependencies: AtomicWriteDependencies = {}): string {
    const now = dependencies.now ?? Date.now;
    const random = dependencies.random ?? Math.random;
    const nonce = Math.floor(random() * 0x100000000).toString(36);
    return `${targetPath}.${process.pid}.${now().toString(36)}.${nonce}.tmp`;
}

function waitSyncDefault(delayMs: number): void {
    // Synchronous API: a bounded blocking wait is the only option. Same
    // primitive the IBKR and SP500 writers already used.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function removePathSync(path: string): void {
    try {
        rmSync(path, { force: true });
    } catch {
        // Best effort: the original error is what the caller must see.
    }
}

async function removePath(path: string): Promise<void> {
    try {
        await rm(path, { force: true });
    } catch {
        // Best effort: the original error is what the caller must see.
    }
}

/**
 * Atomically move `sourcePath` onto `targetPath`, retrying transient Windows
 * destination locks. Sync variant (callers: plugin startup, worker shards).
 */
export function replaceFileWithRetrySync(
    sourcePath: string,
    targetPath: string,
    dependencies: ReplaceFileWithRetryDependencies = {},
): void {
    const platform = dependencies.platform ?? process.platform;
    const rename = dependencies.renameSync ?? renameSync;
    const wait = dependencies.wait ?? waitSyncDefault;
    const attempts = resolveReplaceAttempts(platform, dependencies.attempts);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            rename(sourcePath, targetPath);
            return;
        } catch (error) {
            lastError = error;
            if (platform !== "win32" || attempt === attempts - 1 || !isRetryableReplaceError(error)) break;
            wait(replaceRetryDelayMs(attempt));
        }
    }

    if (dependencies.fallback?.(sourcePath, targetPath, lastError)) return;
    throw lastError;
}

/** Async twin of {@link replaceFileWithRetrySync} (event-loop friendly). */
export async function replaceFileWithRetryAsync(
    sourcePath: string,
    targetPath: string,
    dependencies: ReplaceFileWithRetryDependencies = {},
): Promise<void> {
    const platform = dependencies.platform ?? process.platform;
    const renameAsync = dependencies.renameAsync
        ?? ((source: string, target: string) => rename(source, target));
    const sleep = dependencies.sleep
        ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const attempts = resolveReplaceAttempts(platform, dependencies.attempts);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await renameAsync(sourcePath, targetPath);
            return;
        } catch (error) {
            lastError = error;
            if (platform !== "win32" || attempt === attempts - 1 || !isRetryableReplaceError(error)) break;
            await sleep(replaceRetryDelayMs(attempt));
        }
    }

    if (dependencies.fallback?.(sourcePath, targetPath, lastError)) return;
    throw lastError;
}

function stageSync(targetPath: string, write: (tempPath: string) => void, dependencies: AtomicWriteDependencies): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    const tempPath = atomicTempPath(targetPath, dependencies);
    try {
        write(tempPath);
        replaceFileWithRetrySync(tempPath, targetPath, dependencies);
    } catch (error) {
        // Only clean up a temp file this write created; a failed rename means
        // the target is untouched, so leaving the staged bytes behind would
        // accumulate forever.
        removePathSync(tempPath);
        throw error;
    }
}

async function stage(
    targetPath: string,
    write: (tempPath: string) => Promise<void>,
    dependencies: AtomicWriteDependencies,
): Promise<void> {
    // `mkdir({ recursive: true })` is a no-op when the dir exists and cheaper
    // than a separate existence check.
    await mkdir(dirname(targetPath), { recursive: true });
    const tempPath = atomicTempPath(targetPath, dependencies);
    try {
        await write(tempPath);
        await replaceFileWithRetryAsync(tempPath, targetPath, dependencies);
    } catch (error) {
        await removePath(tempPath);
        throw error;
    }
}

/** Atomic text write (CSV, JSONL, plain text). */
export function atomicWriteTextSync(
    targetPath: string,
    text: string,
    dependencies: AtomicWriteDependencies = {},
): void {
    stageSync(targetPath, (tempPath) => {
        writeFileSync(tempPath, text, "utf8");
    }, dependencies);
}

/** Atomic JSON write, compact serialization (callers that want pretty JSON pass `JSON.stringify(v, null, 2)`). */
export function atomicWriteJsonSync(
    targetPath: string,
    data: unknown,
    dependencies: AtomicWriteDependencies = {},
): void {
    atomicWriteTextSync(targetPath, JSON.stringify(data), dependencies);
}

/** Atomic raw-bytes write. */
export function atomicWriteBytesSync(
    targetPath: string,
    bytes: Uint8Array,
    dependencies: AtomicWriteDependencies = {},
): void {
    stageSync(targetPath, (tempPath) => {
        writeFileSync(tempPath, bytes);
    }, dependencies);
}

/** Async atomic raw-bytes write. */
export async function atomicWriteBytes(
    targetPath: string,
    bytes: Uint8Array,
    dependencies: AtomicWriteDependencies = {},
): Promise<void> {
    await stage(targetPath, (tempPath) => writeFile(tempPath, bytes), dependencies);
}

/** Async atomic JSON write. */
export async function atomicWriteJson(
    targetPath: string,
    data: unknown,
    dependencies: AtomicWriteDependencies = {},
): Promise<void> {
    await atomicWriteBytes(targetPath, new TextEncoder().encode(JSON.stringify(data)), dependencies);
}

/** Async atomic text write. */
export async function atomicWriteText(
    targetPath: string,
    text: string,
    dependencies: AtomicWriteDependencies = {},
): Promise<void> {
    await atomicWriteBytes(targetPath, new TextEncoder().encode(text), dependencies);
}
