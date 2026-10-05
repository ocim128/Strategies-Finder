/**
 * Shared worker entry resolution and esbuild bundling for server-side worker
 * pools (Finder batch/universe, TOP_MEAN backtest and replay scan).
 *
 * One source-selection/bundle/publication mechanism: prefer the standalone
 * deployment's sibling `.js`, else the caller's `.ts` source (repository copy
 * first, then the caller's module-relative copy), else esbuild-bundle the
 * `.ts` to a content-addressed file under `os.tmpdir()` published by
 * temporary-file + rename. Pool lifecycles and caching policies stay at the
 * callers: the Finder pools pass a per-process memo record keyed by source
 * mtime + size; TOP_MEAN passes none and pins the resolved entry on its pool.
 *
 * Import hygiene (the documented vite.config bundle trap): this is a Node-only
 * leaf module (node builtins plus a dynamic esbuild import). It must NOT
 * transitively reach `lightweight-charts` or any browser-bound module.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

/** Caller-owned per-process memo for the last resolved worker bundle. */
export interface WorkerBundleMemoRecord {
    sourcePath: string;
    mtimeMs: number;
    size: number;
    outfile: string;
}

/** Minimal structural view of the esbuild build contract used here. */
export type WorkerEntryBuild = (options: {
    entryPoints: string[];
    bundle: true;
    platform: "node";
    format: "cjs";
    target: string;
    outfile: string;
    write: false;
    logLevel: "silent";
}) => Promise<{ outputFiles?: Array<{ contents: Uint8Array }> }>;

export interface ResolveWorkerEntryOptions {
    /** Repository source candidate (relative to the server's cwd). */
    repositorySourcePath: string;
    /** Bundled/deployment fallback next to the caller's compiled module. */
    moduleSourcePath: string;
    /** Content-addressed temporary directory name under `os.tmpdir()`. */
    temporaryNamespace: string;
    /** Output file name inside the content-addressed directory. */
    outputFileName: string;
    /**
     * Optional caller-owned memo record. The Finder pools share one per
     * process so an unchanged source skips the 50-150ms esbuild build; TOP_MEAN
     * omits it and relies on its pool-pinned entry instead.
     */
    memo?: { record: WorkerBundleMemoRecord | null };
    /** Test seam overriding the esbuild invocation. */
    build?: WorkerEntryBuild;
}

/**
 * Resolve one worker entry: prefer the sibling `.js` of the selected source,
 * else bundle the `.ts`, falling back to the raw source when the build fails.
 * Callers keep their own module directory (`import.meta.url` / `__dirname`)
 * and worker file name; this helper never resolves relative to itself.
 */
export async function resolveWorkerEntryPath(options: ResolveWorkerEntryOptions): Promise<string> {
    const fs = await import("node:fs/promises");
    const sourcePath = await fs.access(options.repositorySourcePath)
        .then(() => options.repositorySourcePath)
        .catch(() => options.moduleSourcePath);
    const sibling = sourcePath.replace(/\.ts$/, ".js");
    if (sourcePath.endsWith(".js") || (await fs.access(sibling).then(() => true).catch(() => false))) {
        return sourcePath.endsWith(".js") ? sourcePath : sibling;
    }
    try {
        return await bundleWorkerEntryWithEsbuild(sourcePath, options);
    } catch {
        return sourcePath;
    }
}

/**
 * Bundle the worker source and reuse the content-addressed output file.
 * The Finder memo (when provided) cuts an unchanged source back to one stat;
 * its limitation is unchanged: imported dependency mtimes are not inspected.
 */
async function bundleWorkerEntryWithEsbuild(
    sourcePath: string,
    options: ResolveWorkerEntryOptions,
): Promise<string> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const build = options.build ?? (await defaultEsbuildBuild());
    const root = join(os.tmpdir(), options.temporaryNamespace);
    const memo = options.memo;

    if (memo) {
        try {
            const stat = await fs.stat(sourcePath);
            if (
                memo.record
                && memo.record.sourcePath === sourcePath
                && memo.record.mtimeMs === stat.mtimeMs
                && memo.record.size === stat.size
                && await fs.access(memo.record.outfile).then(() => true).catch(() => false)
            ) {
                return memo.record.outfile;
            }
        } catch {
            // Stat failure: fall through to the full bundle path.
        }
    }

    const result = await build({
        entryPoints: [sourcePath],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node18",
        outfile: options.outputFileName,
        write: false,
        logLevel: "silent",
    });

    const contents = result.outputFiles?.[0]?.contents;
    if (!contents?.byteLength) {
        throw new Error(`esbuild produced an empty worker bundle for ${options.outputFileName}`);
    }
    const bundleHash = createHash("sha256").update(contents).digest("hex").slice(0, 16);
    const dir = join(root, bundleHash);
    const outfile = join(dir, options.outputFileName);
    await fs.mkdir(dir, { recursive: true });
    if (!(await fs.access(outfile).then(() => true).catch(() => false))) {
        // Unique per call so concurrent publications cannot share a temporary
        // file; a loser of the rename race reuses the winner's complete file.
        const temporary = join(
            dir,
            `worker.${process.pid}.${Date.now()}.${++temporaryFileSequence}.tmp`,
        );
        try {
            await fs.writeFile(temporary, contents);
            try {
                await fs.rename(temporary, outfile);
            } catch (error) {
                if (!(await fs.access(outfile).then(() => true).catch(() => false))) {
                    throw error;
                }
            }
        } finally {
            // Best-effort removal of THIS invocation's temporary file: a lost
            // rename race or a failed write must never accumulate bundle
            // copies. A successful rename already consumed the file, and
            // `force` no-ops then; cleanup errors never mask the outcome.
            await fs.rm(temporary, { force: true }).catch(() => undefined);
        }
    }
    if (memo) {
        try {
            const stat = await fs.stat(sourcePath);
            memo.record = { sourcePath, mtimeMs: stat.mtimeMs, size: stat.size, outfile };
        } catch {
            // Best-effort: leave the previous cache entry in place.
        }
    }
    return outfile;
}

let temporaryFileSequence = 0;

async function defaultEsbuildBuild(): Promise<WorkerEntryBuild> {
    const esbuild = (await import("esbuild")) as unknown as {
        build: WorkerEntryBuild;
    };
    return esbuild.build;
}
