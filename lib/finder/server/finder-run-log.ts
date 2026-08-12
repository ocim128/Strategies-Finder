/**
 * Server-side per-run diagnostics log for Finder jobs (Asset Opportunity single
 * and batch runs).
 *
 * The in-memory `debugLogger` ring buffer (200 entries) and the dev-server
 * console are the only traces of a server-side Finder run today; when the Vite
 * process dies mid-run (crash, OOM under the documented heap guidance, fatal on
 * a late holdout), the per-asset failure reasons and timings are unrecoverable.
 * This leaf appends one JSON line per event to a per-run `.jsonl` file so a
 * post-mortem can read exactly which assets failed, why, and how long each
 * phase took.
 *
 * Logging is opt-out-by-default: the directory resolves to
 * `<project root>/archive/finder-runs` unless `FINDER_RUN_LOG_DIR` is set
 * (absolute or relative path). `FINDER_RUN_LOG_DIR=""` disables the log.
 *
 * Node-only (imports `node:fs/promises` + `node:path`): must never be imported
 * from browser-bound modules. The append leaf is injectable so tests can
 * capture writes without touching the real archive directory.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const FINDER_RUN_LOG_DIR_NAME = "finder-runs";

/** Resolve the run-log directory from a project root, honoring the env override. */
export function resolveFinderRunLogDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
    const override = env.FINDER_RUN_LOG_DIR;
    if (override !== undefined && override !== null && override.trim() !== "") {
        return path.resolve(override);
    }
    return path.join(root, "archive", FINDER_RUN_LOG_DIR_NAME);
}

/**
 * Filename for one run id. The id is already validated at the HTTP boundary
 * (non-empty, <= 128 chars), but never assume: encode only safe characters so
 * a pathological value cannot smuggle a path separator or drive letter into
 * the filesystem layer.
 */
export function buildFinderRunLogFilename(runId: string): string {
    const sanitized = runId.replace(/[^A-Za-z0-9._-]/gu, "_");
    return `${sanitized || "run"}.jsonl`;
}

/** Injectable filesystem append; production default mkdirs + appends UTF-8. */
export type FinderRunLogAppend = (
    dir: string,
    filename: string,
    content: string,
) => Promise<void>;

/**
 * Fire-and-forget sink used by the server plugin. The plugin catches and logs
 * write failures, so a disk hiccup can never fail a Finder run.
 */
export type FinderRunLogSink = (event: string, data: Record<string, unknown>) => void;

export interface AppendFinderRunLogEventArgs {
    /** Project root; the dir is `<root>/archive/finder-runs` unless the env override points elsewhere. */
    root: string;
    runId: string;
    /** Event name, e.g. `asset_complete` / `asset_failed` / `iteration_complete`. */
    event: string;
    /** Extra structured fields merged into the JSON line. */
    data?: Record<string, unknown>;
    /** Optional deterministic timestamp for tests. */
    ts?: number;
    /** Optional injected append leaf for tests. */
    append?: FinderRunLogAppend;
}

export async function appendFinderRunLogEvent(
    args: AppendFinderRunLogEventArgs,
): Promise<void> {
    const dir = resolveFinderRunLogDir(args.root);
    const filename = buildFinderRunLogFilename(args.runId);
    const line = JSON.stringify({
        ts: args.ts ?? Date.now(),
        runId: args.runId,
        event: args.event,
        ...(args.data ?? {}),
    });
    const append = args.append ?? (async (dirPath, fileName, content) => {
        await mkdir(dirPath, { recursive: true });
        await appendFile(path.join(dirPath, fileName), `${content}\n`, "utf8");
    });
    await append(dir, filename, line);
}
