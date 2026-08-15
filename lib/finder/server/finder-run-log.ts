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

function serializeFinderRunLogLine(args: {
    runId: string;
    event: string;
    data?: Record<string, unknown>;
    ts?: number;
}): string {
    return JSON.stringify({
        ts: args.ts ?? Date.now(),
        runId: args.runId,
        event: args.event,
        ...(args.data ?? {}),
    });
}

export async function appendFinderRunLogEvent(
    args: AppendFinderRunLogEventArgs,
): Promise<void> {
    const dir = resolveFinderRunLogDir(args.root);
    const filename = buildFinderRunLogFilename(args.runId);
    const line = serializeFinderRunLogLine(args);
    const append = args.append ?? (async (dirPath, fileName, content) => {
        await mkdir(dirPath, { recursive: true });
        await appendFile(path.join(dirPath, fileName), `${content}\n`, "utf8");
    });
    await append(dir, filename, line);
}

export interface CreateBufferedFinderRunLogSinkOptions {
    /** Flush once this many lines are buffered. Default 256. */
    maxLines?: number;
    /** Flush this many ms after the first buffered line. Default 250. */
    flushAfterMs?: number;
    /**
     * Events flushed IMMEDIATELY (durability points). Defaults to the
     * iteration boundaries: every completed iteration is fully on disk before
     * the next archive append runs.
     */
    boundaryEvents?: ReadonlySet<string>;
    /** Injectable append leaf (tests); default appends the joined chunk. */
    append?: FinderRunLogAppend;
    /** Called once per FAILED flush; the buffer is cleared, never retried. */
    onWriteError?: (error: unknown) => void;
}

/**
 * Buffered {@link FinderRunLogSink} for high-frequency events. A large Asset
 * Opportunity batch emits ~100k `asset_complete` lines; appending each with
 * its own mkdir+appendFile costs ~200k syscalls. Lines accumulate and flush
 * as ONE appendFile when the buffer fills, when `flushAfterMs` has elapsed
 * since the first buffered line, or immediately for boundary events. The
 * line schema is identical to {@link appendFinderRunLogEvent}; only the write
 * granularity changes. Flushes are serialized through a promise chain so
 * chunks never interleave; a failed flush reports via `onWriteError` and
 * clears the buffer (fire-and-forget semantics — it can never fail a run).
 */
export function createBufferedFinderRunLogSink(
    root: string,
    runId: string,
    options: CreateBufferedFinderRunLogSinkOptions = {},
): FinderRunLogSink {
    const maxLines = Math.max(1, Math.floor(options.maxLines ?? 256));
    const flushAfterMs = Math.max(0, options.flushAfterMs ?? 250);
    const boundaryEvents = options.boundaryEvents
        ?? new Set(["iteration_start", "iteration_complete"]);
    const dir = resolveFinderRunLogDir(root);
    const filename = buildFinderRunLogFilename(runId);
    // An injected append owns ALL filesystem effects (same seam contract as
    // appendFinderRunLogEvent's injectable default = mkdir + appendFile);
    // the production default mkdirs lazily on the first flush.
    const append = options.append ?? ((dirPath, fileName, content) =>
        appendFile(path.join(dirPath, fileName), content, "utf8"));
    const ensureDir: () => Promise<void> = options.append
        ? async () => undefined
        : () => mkdir(dir, { recursive: true }).then(() => undefined);

    let buffer: string[] = [];
    let timer: NodeJS.Timeout | null = null;
    let dirReady: Promise<void> | null = null;
    // Serializes flushes: each append awaits the previous one so chunks stay
    // ordered and never interleave mid-line.
    let flushChain: Promise<void> = Promise.resolve();

    const flushNow = (): void => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (buffer.length === 0) return;
        const lines = buffer;
        buffer = [];
        const chunk = `${lines.join("\n")}\n`;
        dirReady ??= ensureDir();
        flushChain = flushChain
            .then(() => dirReady)
            .then(() => append(dir, filename, chunk))
            .catch((error: unknown) => {
                options.onWriteError?.(error);
            });
    };

    return (event, data) => {
        buffer.push(serializeFinderRunLogLine({ runId, event, data }));
        if (boundaryEvents.has(event) || buffer.length >= maxLines) {
            flushNow();
            return;
        }
        if (timer === null && Number.isFinite(flushAfterMs)) {
            timer = setTimeout(flushNow, flushAfterMs);
        }
    };
}
