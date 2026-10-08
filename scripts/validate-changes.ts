/**
 * validate:changes CLI — maps current Git changes to a validation plan and,
 * with `--run`, executes the selected checks sequentially.
 *
 * Preview is read-only. Execution writes only `artifacts/validation-logs/`
 * and the existing test/build outputs that the selected checks already write.
 * Selection is advisory assistance for the caller inspection required by
 * AGENTS.md; it cannot prove semantic impact. See README.md
 * "Validating changes" for scope, fallback behavior, and limits.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
    buildValidationPlan,
    describeCheckCommand,
    getValidationCheck,
    normalizeChangedPaths,
    ValidationMapError,
    VALIDATION_PLAN_FORMAT_VERSION,
    type ValidationCheckId,
    type ValidationPlan,
} from "./validation-map";
import { discoverTestFiles, sanitizeLogName } from "./run-tests";

const currentFilePath = fileURLToPath(import.meta.url);
export const APP_ROOT = path.resolve(path.dirname(currentFilePath), "..");

/** Resolved from this module's location; fixture app roots have no node_modules. */
const defaultEsnoCliPath = createRequire(import.meta.url).resolve("esno/esno.js");

const VALIDATION_LOGS_DIR_PARTS = ["artifacts", "validation-logs", "latest"];
const MAX_STDOUT_CAPTURE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_LINE_COUNT = 12;
const JSON_SCAN_CANDIDATE_CAP = 200;

const USAGE = [
    "Usage:",
    "  npm run validate:changes",
    "  npm run validate:changes -- --base <ref>",
    "  npm run validate:changes -- --run",
    "  npm run validate:changes -- --run --json",
    "",
    "Behavior:",
    "  - Preview prints a validation plan for the current Git changes and writes no files.",
    "  - Default scope: staged, unstaged, and untracked non-ignored files.",
    "  - --base <ref> adds committed changes from the merge base of <ref> and HEAD.",
    "    The ref is resolved locally; nothing is fetched.",
    "  - --run executes the planned checks sequentially from the app root and",
    "    stops at the first failing check. Child output is preserved under",
    "    artifacts/validation-logs/latest/.",
    "  - --json prints exactly one JSON object on stdout (diagnostics go to stderr).",
    "  - Flags that npm consumes instead of forwarding (notably under PowerShell's",
    "    npm.ps1) are honored from npm_config_run, npm_config_json, and",
    "    npm_config_base; explicit flags always win.",
    "",
    "Exit codes:",
    "  0   plan printed, or all executed checks passed",
    "  1   usage, Git, or map error; or an executed check did not pass",
    "  130 interrupted",
].join("\n");

export class CliUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CliUsageError";
    }
}

export class GitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GitError";
    }
}

export type CliOptions = {
    base: string | null;
    run: boolean;
    json: boolean;
    help: boolean;
};

export function parseCliArgs(argv: readonly string[]): CliOptions {
    const options: CliOptions = { base: null, run: false, json: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--base") {
            const value = argv[index + 1];
            if (!value) throw new CliUsageError("--base requires a Git reference argument.");
            options.base = value;
            index += 1;
            continue;
        }
        if (arg.startsWith("--base=")) {
            const value = arg.slice("--base=".length);
            if (!value) throw new CliUsageError("--base requires a non-empty Git reference.");
            options.base = value;
            continue;
        }
        if (arg === "--run") {
            options.run = true;
            continue;
        }
        if (arg === "--json") {
            options.json = true;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            options.help = true;
            continue;
        }
        throw new CliUsageError(`Unknown argument "${arg}".`);
    }
    return options;
}

function isEnabledEnvValue(value: string | undefined): boolean {
    return value === "true" || value === "1";
}

function envConfigValue(value: string | undefined): string | undefined {
    if (!value || isEnabledEnvValue(value)) return undefined;
    return value;
}

/**
 * npm — notably npm.ps1 on Windows — can consume script flags like `--run`,
 * `--json`, and `--base <ref>` as its own options and forward them through
 * npm_config_* environment variables instead of argv. The existing test
 * runner reads forwarded config the same way; explicit argv flags always win.
 */
export function applyNpmForwardedConfig(
    options: CliOptions,
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
): CliOptions {
    const merged = { ...options };
    const hasFlag = (name: string) => argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (!hasFlag("run") && isEnabledEnvValue(env.npm_config_run)) merged.run = true;
    if (!hasFlag("json") && isEnabledEnvValue(env.npm_config_json)) merged.json = true;
    if (!hasFlag("base")) {
        const forwardedBase = envConfigValue(env.npm_config_base);
        if (forwardedBase) merged.base = forwardedBase;
    }
    return merged;
}

type GitProcessResult = {
    code: number;
    stdout: string;
    stderr: string;
};

async function runGitProcess(args: readonly string[], cwd: string): Promise<GitProcessResult> {
    return await new Promise((resolve, reject) => {
        const child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
            reject(new GitError(error.code === "ENOENT"
                ? "The git executable was not found on PATH."
                : `Failed to run git: ${error.message}`));
        });
        child.on("close", (code) => {
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}

async function runGit(args: readonly string[], cwd: string, failureLabel: string): Promise<string> {
    const result = await runGitProcess(args, cwd);
    if (result.code !== 0) {
        const detail = result.stderr.trim() || `git exited with code ${result.code}`;
        throw new GitError(`${failureLabel}: ${detail}`);
    }
    return result.stdout;
}

type StatusEntry = {
    entryPath: string;
    originPath?: string;
};

function splitNulList(output: string): string[] {
    return output.split("\0").filter(token => token.length > 0);
}

/**
 * Parse `git status --porcelain=v1 -z`. Each entry is `XY PATH`; rename and
 * copy entries are followed by a second NUL-delimited token with the origin
 * path. Both paths are reported so renamed-away files stay routed.
 */
export function parseStatusZ(output: string): StatusEntry[] {
    const tokens = output.split("\0");
    const entries: StatusEntry[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token || token.length < 4 || token[2] !== " ") continue;
        const x = token[0];
        const y = token[1];
        const entryPath = token.slice(3);
        let originPath: string | undefined;
        if (x === "R" || x === "C" || y === "R" || y === "C") {
            const next = tokens[index + 1];
            if (next) {
                originPath = next;
                index += 1;
            }
        }
        entries.push(originPath ? { entryPath, originPath } : { entryPath });
    }
    return entries;
}

/**
 * Split Git paths into app-root-relative in-scope paths and out-of-scope Git
 * paths. Roots are canonicalized but path strings are returned raw; slash
 * conversion and deduplication happen once at the collector result boundary.
 */
function scopePathsToAppRoot(
    gitPaths: readonly string[],
    gitRoot: string,
    appRoot: string,
): { inScope: string[]; outOfScope: string[] } {
    // Git can report the physical repository path while the caller uses a
    // junction or Windows short path. Compare canonical roots so aliases do
    // not incorrectly move genuine changes outside the application scope.
    const scopedGitRoot = fs.realpathSync.native(gitRoot);
    const scopedAppRoot = fs.realpathSync.native(appRoot);
    if (path.relative(scopedAppRoot, scopedGitRoot) === "") {
        return { inScope: [...gitPaths], outOfScope: [] };
    }
    const inScope: string[] = [];
    const outOfScope: string[] = [];
    for (const gitPath of gitPaths) {
        const absolute = path.resolve(scopedGitRoot, gitPath);
        const relative = path.relative(scopedAppRoot, absolute);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
            outOfScope.push(gitPath);
            continue;
        }
        inScope.push(relative);
    }
    return { inScope, outOfScope };
}

export type CollectedChanges = {
    appRoot: string;
    gitRoot: string;
    base: string | null;
    baseCommit: string | null;
    mergeBase: string | null;
    /** App-root-relative, slash-normalized, deduplicated, sorted paths. */
    paths: string[];
    /** Git paths outside the app root; reported, never planned. */
    outOfScopePaths: string[];
};

/**
 * Collect changed paths without consulting only HEAD: staged, unstaged, and
 * untracked files from `git status`, plus — for `--base` — committed changes
 * between the merge base of the ref and HEAD. The ref is resolved locally;
 * nothing is fetched and `origin/main` need not exist.
 */
export async function collectChangedPaths(options: {
    appRoot: string;
    base?: string | null;
}): Promise<CollectedChanges> {
    const appRoot = path.resolve(options.appRoot);
    const gitRoot = (await runGit(["rev-parse", "--show-toplevel"], appRoot, "Not a Git repository")).trim();
    if (!gitRoot) throw new GitError("Not a Git repository: git rev-parse returned no toplevel.");

    const statusOutput = await runGit(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        gitRoot,
        "git status failed",
    );
    const localPaths: string[] = [];
    for (const entry of parseStatusZ(statusOutput)) {
        localPaths.push(entry.entryPath);
        if (entry.originPath) localPaths.push(entry.originPath);
    }

    const base = options.base ?? null;
    let baseCommit: string | null = null;
    let mergeBase: string | null = null;
    const committedPaths: string[] = [];
    if (base) {
        const verify = await runGitProcess(["rev-parse", "--verify", `${base}^{commit}`], gitRoot);
        if (verify.code !== 0) {
            throw new GitError(`Base ref "${base}" did not resolve to a commit in this repository.`);
        }
        baseCommit = verify.stdout.trim();
        const mergeBaseResult = await runGitProcess(["merge-base", "HEAD", baseCommit], gitRoot);
        if (mergeBaseResult.code !== 0) {
            throw new GitError(`Could not compute a merge base between HEAD and "${base}" (is HEAD committed?).`);
        }
        mergeBase = mergeBaseResult.stdout.trim();
        const diffOutput = await runGit(
            ["diff", "--name-only", "-z", "--no-renames", mergeBase, "HEAD"],
            gitRoot,
            `git diff against "${base}" failed`,
        );
        committedPaths.push(...splitNulList(diffOutput));
    }

    const { inScope, outOfScope } = scopePathsToAppRoot([...localPaths, ...committedPaths], gitRoot, appRoot);
    return {
        appRoot,
        gitRoot,
        base,
        baseCommit,
        mergeBase,
        paths: normalizeChangedPaths(inScope),
        outOfScopePaths: normalizeChangedPaths(outOfScope),
    };
}

/** Stop a spawned child and (on Windows) its process tree. Mirrors tests/e2e.spec.ts. */
export function stopProcessTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
        const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            timeout: 5000,
        });
        if (result.error) {
            try {
                child.kill();
            } catch {
                // ignore cleanup errors
            }
        }
        return;
    }
    try {
        child.kill("SIGTERM");
    } catch {
        // ignore cleanup errors
    }
}

export function resolveNpmCliPath(explicit?: string): string {
    if (explicit) return explicit;
    const execPath = process.env.npm_execpath;
    if (execPath && execPath.endsWith(".js") && fs.existsSync(execPath)) return execPath;
    throw new Error(
        "The npm CLI path is unavailable (npm_execpath is not set). Run this command through npm: `npm run validate:changes`.",
    );
}

type CapturedChildResult = {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    spawnError: string | null;
    spawnErrorCode: string | null;
    stdoutText: string;
    stdoutTruncated: boolean;
    stderrTail: string[];
};

type CapturedChildOptions = {
    file: string;
    args: readonly string[];
    cwd: string;
    logPath: string;
    captureFullStdout: boolean;
    /** Lets the executor stop the active child on interruption. */
    executionContext?: ExecutionContext;
};

/** Tracks the currently running child so an abort can kill its process tree. */
type ExecutionContext = {
    activeChild: ChildProcess | null;
};

/**
 * Spawn a check child with argument arrays (never a shell string), stream its
 * output into `logPath`, and keep only bounded tails (or the full stdout when
 * JSON evidence is parsed from it).
 */
async function runCapturedChild(options: CapturedChildOptions): Promise<CapturedChildResult> {
    fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
    const log = fs.createWriteStream(options.logPath, { encoding: "utf8" });
    const logClosed = new Promise<void>((resolve, reject) => {
        log.on("close", resolve);
        log.on("error", reject);
    });

    return await new Promise<CapturedChildResult>((resolve) => {
        const child = spawn(options.file, [...options.args], {
            cwd: options.cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (options.executionContext) options.executionContext.activeChild = child;
        let stdoutText = "";
        let stdoutBytes = 0;
        let stdoutTruncated = false;
        const stderrTail: string[] = [];
        let pendingStderr = "";

        const pushStderrLines = (chunk: string) => {
            pendingStderr += chunk;
            let newlineIndex = pendingStderr.indexOf("\n");
            while (newlineIndex !== -1) {
                const line = pendingStderr.slice(0, newlineIndex).replace(/\r$/, "").trimEnd();
                pendingStderr = pendingStderr.slice(newlineIndex + 1);
                if (line) {
                    stderrTail.push(line.slice(0, 240));
                    if (stderrTail.length > STDERR_TAIL_LINE_COUNT) stderrTail.shift();
                }
                newlineIndex = pendingStderr.indexOf("\n");
            }
        };

        child.stdout?.on("data", (chunk: Buffer) => {
            log.write(chunk);
            if (options.captureFullStdout) {
                stdoutBytes += chunk.byteLength;
                if (stdoutBytes <= MAX_STDOUT_CAPTURE_BYTES) {
                    stdoutText += chunk.toString("utf8");
                } else {
                    stdoutTruncated = true;
                }
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            log.write(chunk);
            pushStderrLines(chunk.toString("utf8"));
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
            log.write(`\n[validate-changes] spawn error: ${error.message}\n`);
            if (options.executionContext && options.executionContext.activeChild === child) {
                options.executionContext.activeChild = null;
            }
            resolve({
                exitCode: null,
                signal: null,
                spawnError: error.message,
                spawnErrorCode: error.code ?? null,
                stdoutText,
                stdoutTruncated,
                stderrTail,
            });
        });
        child.on("close", (code, closeSignal) => {
            log.end();
            if (options.executionContext && options.executionContext.activeChild === child) {
                options.executionContext.activeChild = null;
            }
            resolve({
                exitCode: code,
                signal: closeSignal,
                spawnError: null,
                spawnErrorCode: null,
                stdoutText,
                stdoutTruncated,
                stderrTail,
            });
        });
    }).finally(async () => {
        await logClosed;
    });
}

export type RunnerSummaryEvidence = {
    generatedAt: string;
    selectedCount: number;
    passedCount: number;
    failedCount: number;
    skippedCount: number;
    durationMs: number;
    timeoutMs: number;
    verbose: boolean;
    filters: string[];
    logsDir: string;
    results: Array<{
        file: string;
        status: string;
        durationMs: number;
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        logFile: string;
        skipReason?: string;
        logError?: string;
    }>;
};

function extractJsonObject(text: string): unknown | undefined {
    try {
        return JSON.parse(text.trim());
    } catch {
        // Fall through to scanning for an embedded object.
    }
    const starts: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "{" && (index === 0 || text[index - 1] === "\n")) {
            starts.push(index);
            if (starts.length >= JSON_SCAN_CANDIDATE_CAP) break;
        }
    }
    for (let cursor = starts.length - 1; cursor >= 0; cursor -= 1) {
        try {
            return JSON.parse(text.slice(starts[cursor]));
        } catch {
            // Try the next candidate.
        }
    }
    return undefined;
}

function isRunnerSummary(value: unknown): value is RunnerSummaryEvidence {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.generatedAt === "string"
        && typeof candidate.selectedCount === "number"
        && typeof candidate.passedCount === "number"
        && typeof candidate.failedCount === "number"
        && typeof candidate.skippedCount === "number"
        && typeof candidate.durationMs === "number"
        && Array.isArray(candidate.filters)
        && candidate.filters.every(filter => typeof filter === "string")
        && Array.isArray(candidate.results)
        && candidate.results.every(item => {
            if (typeof item !== "object" || item === null) return false;
            const result = item as Record<string, unknown>;
            return typeof result.file === "string" && typeof result.status === "string";
        })
    );
}

export type EvidenceParseResult =
    | { ok: true; summary: RunnerSummaryEvidence }
    | { ok: false; reason: string };

function comparePlain(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/**
 * Parse and attribute the runner's JSON summary. The summary is trusted only
 * when its filters, selected spec count, and per-spec result identities match
 * this invocation, so a stale `latest` artifact or an unexpected selection
 * can never pass as evidence for the current run.
 */
export function parseRunnerSummary(
    text: string,
    expectedFilters: readonly string[],
    expectedSpecs: readonly string[],
): EvidenceParseResult {
    if (text.trim().length === 0) {
        return { ok: false, reason: "The spec runner printed no JSON summary (launch failed or output lost)." };
    }
    const parsed = extractJsonObject(text);
    if (!isRunnerSummary(parsed)) {
        return { ok: false, reason: "Could not parse the spec runner's JSON summary from its stdout." };
    }
    if (JSON.stringify(parsed.filters) !== JSON.stringify([...expectedFilters])) {
        return {
            ok: false,
            reason: `Runner summary filters [${parsed.filters.join(", ")}] do not match this invocation [${expectedFilters.join(", ")}].`,
        };
    }
    if (parsed.selectedCount !== expectedSpecs.length) {
        return {
            ok: false,
            reason: `Runner summary selected ${parsed.selectedCount} spec(s) but the plan resolved ${expectedSpecs.length}.`,
        };
    }
    const resultFiles = parsed.results.map(item => item.file).sort(comparePlain);
    const plannedFiles = [...expectedSpecs].sort(comparePlain);
    if (resultFiles.length !== plannedFiles.length
        || resultFiles.some((file, index) => file !== plannedFiles[index])) {
        return {
            ok: false,
            reason: `Runner summary results [${resultFiles.join(", ")}] do not match the planned specs [${plannedFiles.join(", ")}].`,
        };
    }
    return { ok: true, summary: parsed };
}

export type CheckExecutionStatus = "PASS" | "FAIL" | "UNMET" | "SKIPPED";

export type CheckEvidence = {
    selectedCount: number;
    passedCount: number;
    failedCount: number;
    skippedCount: number;
    logErrors: string[];
    skippedSpecs: string[];
    failedSpecs: string[];
};

export type CheckExecutionResult = {
    checkId: ValidationCheckId;
    status: CheckExecutionStatus;
    durationMs: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    detail?: string;
    logFiles: string[];
    evidence?: CheckEvidence;
    runnerSummary?: RunnerSummaryEvidence;
};

export type ExecutionOutcome = {
    requested: boolean;
    success: boolean;
    interrupted: boolean;
    results: CheckExecutionResult[];
    tools: {
        node: string;
        npmCliPath: string | null;
        npmVersion: string | null;
        cargoVersion: string | null;
    };
};

export type ExecuteOptions = {
    appRoot: string;
    logDir: string;
    npmCliPath?: string;
    cargoPath?: string;
    /**
     * Overrides for the focused-spec child command. Defaults launch the
     * existing runner through node and the resolved esno CLI. Tests inject a
     * small fixture child instead of repeatedly launching the real suite.
     */
    focusedChild?: {
        file?: string;
        leadingArgs?: readonly string[];
    };
    signal?: AbortSignal;
};

type ResolvedToolPaths = {
    npmCliPath: string;
    cargoPath: string;
    focusedChildFile: string;
    focusedChildLeadingArgs: string[];
};

const RUST_CHECK_STEPS: ReadonlyArray<{ label: string; logName: string; args: readonly string[] }> = [
    {
        label: "cargo fmt --check",
        logName: "rust-fmt.log",
        args: ["fmt", "--manifest-path", "rust-engine/Cargo.toml", "--", "--check"],
    },
    {
        label: "cargo test",
        logName: "rust-test.log",
        args: ["test", "--manifest-path", "rust-engine/Cargo.toml"],
    },
    {
        label: "cargo clippy -D warnings",
        logName: "rust-clippy.log",
        args: ["clippy", "--manifest-path", "rust-engine/Cargo.toml", "--all-targets", "--", "-D", "warnings"],
    },
];

/** Best-effort first stdout line from a version probe; null when unavailable. */
function captureToolVersionSync(file: string, args: readonly string[], cwd: string): string | null {
    try {
        const result = spawnSync(file, [...args], { cwd, encoding: "utf8", timeout: 30000 });
        if (result.error || result.status !== 0) return null;
        const firstLine = (result.stdout ?? "").trim().split("\n")[0];
        return firstLine || null;
    } catch {
        return null;
    }
}

type FullSuiteEvidenceCheck =
    | { ok: true; evidence: CheckEvidence }
    | { ok: false; reason: string };

/**
 * `full-js` contains the full spec suite via `npm run ci`, so a passing npm
 * exit code alone is not sufficient evidence: the fresh runner summary must
 * exist, belong to this invocation, and report zero failed, skipped, or
 * log-error specs.
 */
function readFreshFullSuiteEvidence(appRoot: string, startedAt: number): FullSuiteEvidenceCheck {
    const summaryPath = path.join(appRoot, "artifacts", "test-logs", "latest", "summary.json");
    if (!fs.existsSync(summaryPath)) {
        return { ok: false, reason: "no artifacts/test-logs/latest/summary.json was written, so full-suite evidence is missing" };
    }
    let parsedSummary: unknown;
    try {
        parsedSummary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    } catch {
        return { ok: false, reason: "artifacts/test-logs/latest/summary.json is not valid JSON, so full-suite evidence is unusable" };
    }
    if (!isRunnerSummary(parsedSummary)) {
        return { ok: false, reason: "artifacts/test-logs/latest/summary.json does not match the runner's summary shape" };
    }
    const generatedAtMs = Date.parse(parsedSummary.generatedAt);
    if (!Number.isFinite(generatedAtMs) || generatedAtMs < startedAt) {
        return { ok: false, reason: "artifacts/test-logs/latest/summary.json predates this invocation; refusing stale full-suite evidence" };
    }
    if (parsedSummary.filters.length > 0) {
        return {
            ok: false,
            reason: `the full-suite summary ran with filters [${parsedSummary.filters.join(", ")}] instead of the whole suite`,
        };
    }
    if (parsedSummary.results.length !== parsedSummary.selectedCount) {
        return { ok: false, reason: "the full-suite summary's result list is incomplete relative to its selected count" };
    }
    const logErrors = parsedSummary.results.map(item => item.logError).filter((value): value is string => Boolean(value));
    const skippedSpecs = parsedSummary.results.filter(item => item.status === "SKIP").map(item => item.file);
    const failedSpecs = parsedSummary.results.filter(item => item.status === "FAIL").map(item => item.file);
    if (failedSpecs.length > 0 || skippedSpecs.length > 0 || logErrors.length > 0) {
        return {
            ok: false,
            reason: `full-suite evidence is incomplete: ${failedSpecs.length} failed, ${skippedSpecs.length} skipped, ${logErrors.length} log error(s)`,
        };
    }
    return {
        ok: true,
        evidence: {
            selectedCount: parsedSummary.selectedCount,
            passedCount: parsedSummary.passedCount,
            failedCount: parsedSummary.failedCount,
            skippedCount: parsedSummary.skippedCount,
            logErrors,
            skippedSpecs,
            failedSpecs,
        },
    };
}

async function runNpmScriptCheck(
    script: string,
    checkId: ValidationCheckId,
    tools: ResolvedToolPaths,
    options: ExecuteOptions,
    executionContext: ExecutionContext,
): Promise<CheckExecutionResult> {
    const startedAt = Date.now();
    const logPath = path.join(options.logDir, `${sanitizeLogName(checkId)}.log`);
    const result = await runCapturedChild({
        file: process.execPath,
        args: [tools.npmCliPath, "run", script],
        cwd: options.appRoot,
        logPath,
        captureFullStdout: false,
        executionContext,
    });
    const durationMs = Date.now() - startedAt;
    if (result.spawnError) {
        return {
            checkId,
            status: "UNMET",
            durationMs,
            exitCode: null,
            signal: null,
            detail: `Could not launch npm: ${result.spawnError}`,
            logFiles: [logPath],
        };
    }
    const passed = result.exitCode === 0 && result.signal === null;
    if (passed && checkId === "full-js") {
        // The full suite ran inside `npm run ci`; validate its fresh evidence
        // instead of trusting the npm exit code alone.
        const evidenceCheck = readFreshFullSuiteEvidence(options.appRoot, startedAt);
        if (!evidenceCheck.ok) {
            return {
                checkId,
                status: "FAIL",
                durationMs,
                exitCode: result.exitCode,
                signal: null,
                detail: `npm run ${script} exited 0, but ${evidenceCheck.reason}.`,
                logFiles: [logPath],
            };
        }
        return {
            checkId,
            status: "PASS",
            durationMs,
            exitCode: result.exitCode,
            signal: null,
            logFiles: [logPath],
            evidence: evidenceCheck.evidence,
        };
    }
    return {
        checkId,
        status: passed ? "PASS" : "FAIL",
        durationMs,
        exitCode: result.exitCode,
        signal: result.signal,
        ...(passed ? {} : {
            detail: result.stderrTail.length > 0
                ? `npm run ${script} failed. Last stderr: ${result.stderrTail.join(" | ")}`
                : `npm run ${script} failed with exit code ${result.exitCode}.`,
        }),
        logFiles: [logPath],
    };
}

async function runFocusedTestsCheck(
    plan: ValidationPlan,
    tools: ResolvedToolPaths,
    options: ExecuteOptions,
    executionContext: ExecutionContext,
): Promise<CheckExecutionResult> {
    const startedAt = Date.now();
    const checkId: ValidationCheckId = "focused-tests";
    const logPath = path.join(options.logDir, `${sanitizeLogName(checkId)}.log`);
    if (plan.testFilters.length === 0 || plan.selectedSpecs.length === 0) {
        return {
            checkId,
            status: "FAIL",
            durationMs: 0,
            exitCode: null,
            signal: null,
            detail: "No filters resolved for the focused spec run; refusing to run an empty or unbounded selection.",
            logFiles: [],
        };
    }
    const result = await runCapturedChild({
        file: tools.focusedChildFile,
        args: [...tools.focusedChildLeadingArgs, ...plan.testFilters, "--json"],
        cwd: options.appRoot,
        logPath,
        captureFullStdout: true,
        executionContext,
    });
    const durationMs = Date.now() - startedAt;
    if (result.spawnError) {
        return {
            checkId,
            status: "UNMET",
            durationMs,
            exitCode: null,
            signal: null,
            detail: `Could not launch the spec runner: ${result.spawnError}`,
            logFiles: [logPath],
        };
    }
    if (result.stdoutTruncated) {
        return {
            checkId,
            status: "FAIL",
            durationMs,
            exitCode: result.exitCode,
            signal: result.signal,
            detail: "Runner stdout exceeded the capture cap; summary evidence is incomplete.",
            logFiles: [logPath],
        };
    }
    const parsed = parseRunnerSummary(result.stdoutText, plan.testFilters, plan.selectedSpecs);
    if (!parsed.ok) {
        return {
            checkId,
            status: "FAIL",
            durationMs,
            exitCode: result.exitCode,
            signal: result.signal,
            detail: `${parsed.reason} (exit code ${result.exitCode})`,
            logFiles: [logPath],
        };
    }
    const summary = parsed.summary;
    const logErrors = summary.results.map(item => item.logError).filter((value): value is string => Boolean(value));
    const skippedSpecs = summary.results
        .filter(item => item.status === "SKIP")
        .map(item => item.file);
    const failedSpecs = summary.results
        .filter(item => item.status === "FAIL")
        .map(item => item.file);
    const evidence: CheckEvidence = {
        selectedCount: summary.selectedCount,
        passedCount: summary.passedCount,
        failedCount: summary.failedCount,
        skippedCount: summary.skippedCount,
        logErrors,
        skippedSpecs,
        failedSpecs,
    };

    const details: string[] = [];
    if (result.exitCode !== 0 || result.signal !== null) {
        details.push(`Runner exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}.`);
    }
    if (summary.failedCount > 0) {
        details.push(`${summary.failedCount} spec(s) failed: ${failedSpecs.join(", ")}`);
    }
    if (summary.skippedCount > 0) {
        details.push(`${summary.skippedCount} spec(s) skipped, so validation is incomplete: ${skippedSpecs.join(", ")}`);
    }
    if (logErrors.length > 0) {
        details.push(`${logErrors.length} log error(s) make the evidence incomplete: ${logErrors.join(" | ")}`);
    }

    const passed = result.exitCode === 0
        && result.signal === null
        && summary.failedCount === 0
        && summary.skippedCount === 0
        && logErrors.length === 0;
    return {
        checkId,
        status: passed ? "PASS" : "FAIL",
        durationMs,
        exitCode: result.exitCode,
        signal: result.signal,
        ...(details.length > 0 ? { detail: details.join(" ") } : {}),
        logFiles: [logPath],
        evidence,
        runnerSummary: summary,
    };
}

async function runRustCheck(
    tools: ResolvedToolPaths,
    options: ExecuteOptions,
    executionContext: ExecutionContext,
): Promise<{ result: CheckExecutionResult; cargoVersion: string | null }> {
    const startedAt = Date.now();
    const checkId: ValidationCheckId = "rust";
    const versionProbe = captureToolVersionSync(tools.cargoPath, ["--version"], options.appRoot);
    if (versionProbe === null) {
        return {
            result: {
                checkId,
                status: "UNMET",
                durationMs: Date.now() - startedAt,
                exitCode: null,
                signal: null,
                detail: "cargo was not found on PATH; the Rust checks could not run and validation is incomplete.",
                logFiles: [],
            },
            cargoVersion: null,
        };
    }

    const logFiles: string[] = [];
    for (const step of RUST_CHECK_STEPS) {
        const logPath = path.join(options.logDir, step.logName);
        logFiles.push(logPath);
        const result = await runCapturedChild({
            file: tools.cargoPath,
            args: step.args,
            cwd: options.appRoot,
            logPath,
            captureFullStdout: false,
            executionContext,
        });
        if (result.spawnError) {
            return {
                result: {
                    checkId,
                    status: result.spawnErrorCode === "ENOENT" ? "UNMET" : "FAIL",
                    durationMs: Date.now() - startedAt,
                    exitCode: null,
                    signal: null,
                    detail: `Could not launch ${step.label}: ${result.spawnError}`,
                    logFiles,
                },
                cargoVersion: versionProbe,
            };
        }
        if (result.exitCode !== 0 || result.signal !== null) {
            return {
                result: {
                    checkId,
                    status: "FAIL",
                    durationMs: Date.now() - startedAt,
                    exitCode: result.exitCode,
                    signal: result.signal,
                    detail: `${step.label} failed. Last stderr: ${result.stderrTail.join(" | ") || "(none captured)"}`,
                    logFiles,
                },
                cargoVersion: versionProbe,
            };
        }
    }

    return {
        result: {
            checkId,
            status: "PASS",
            durationMs: Date.now() - startedAt,
            exitCode: 0,
            signal: null,
            logFiles,
        },
        cargoVersion: versionProbe,
    };
}

/**
 * Execute the plan's checks sequentially from the app root, stopping at the
 * first non-passing check and marking the remainder as not run. Never
 * regenerates manifests, installs packages, fetches refs, or repairs
 * failures; missing tools surface as UNMET, not as silent skips.
 */
export async function executePlanChecks(plan: ValidationPlan, options: ExecuteOptions): Promise<ExecutionOutcome> {
    const tools: ResolvedToolPaths = {
        npmCliPath: resolveNpmCliPath(options.npmCliPath),
        cargoPath: options.cargoPath ?? "cargo",
        focusedChildFile: options.focusedChild?.file ?? process.execPath,
        focusedChildLeadingArgs: [
            ...(options.focusedChild?.leadingArgs ?? [
                defaultEsnoCliPath,
                path.join(options.appRoot, "scripts", "run-tests.ts"),
            ]),
        ],
    };

    fs.rmSync(options.logDir, { recursive: true, force: true });
    fs.mkdirSync(options.logDir, { recursive: true });

    let cargoVersion: string | null = null;
    const results: CheckExecutionResult[] = [];
    let interrupted = false;
    let stopAfterFailure: string | null = null;
    const executionContext: ExecutionContext = { activeChild: null };

    // Interruption kills the active child's process tree (Windows taskkill
    // tree reference: tests/e2e.spec.ts) and marks the run incomplete.
    const onAbort = () => {
        interrupted = true;
        if (executionContext.activeChild) {
            stopProcessTree(executionContext.activeChild);
        }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
        for (const checkId of plan.checks) {
            if (interrupted) {
                results.push({
                    checkId,
                    status: "SKIPPED",
                    durationMs: 0,
                    exitCode: null,
                    signal: null,
                    detail: "Aborted before execution.",
                    logFiles: [],
                });
                continue;
            }
            if (stopAfterFailure !== null) {
                results.push({
                    checkId,
                    status: "SKIPPED",
                    durationMs: 0,
                    exitCode: null,
                    signal: null,
                    detail: `Not run after "${stopAfterFailure}" failed.`,
                    logFiles: [],
                });
                continue;
            }

            const checkDefinition = getValidationCheck(checkId);
            let result: CheckExecutionResult;
            if (checkId === "focused-tests") {
                result = await runFocusedTestsCheck(plan, tools, options, executionContext);
            } else if (checkId === "rust") {
                const rustOutcome = await runRustCheck(tools, options, executionContext);
                result = rustOutcome.result;
                cargoVersion = rustOutcome.cargoVersion;
            } else if (checkDefinition?.command.kind === "npm-script") {
                result = await runNpmScriptCheck(checkDefinition.command.script, checkId, tools, options, executionContext);
            } else {
                result = {
                    checkId,
                    status: "FAIL",
                    durationMs: 0,
                    exitCode: null,
                    signal: null,
                    detail: `Check "${checkId}" has no dispatch definition.`,
                    logFiles: [],
                };
            }
            results.push(result);
            if (result.status !== "PASS") {
                stopAfterFailure = result.checkId;
            }
        }
    } finally {
        options.signal?.removeEventListener("abort", onAbort);
    }

    const npmVersion = captureToolVersionSync(process.execPath, [tools.npmCliPath, "--version"], options.appRoot);

    return {
        requested: true,
        success: !interrupted && results.every(result => result.status === "PASS"),
        interrupted,
        results,
        tools: {
            node: process.version,
            npmCliPath: tools.npmCliPath,
            npmVersion,
            cargoVersion,
        },
    };
}

export type ReportScope = {
    base: string | null;
    baseCommit: string | null;
    mergeBase: string | null;
    gitRoot: string;
    appRoot: string;
    outOfScopePaths: readonly string[];
};

export type ReportExecution = {
    requested: boolean;
    success: boolean;
    interrupted: boolean;
    results: CheckExecutionResult[];
    tools: ExecutionOutcome["tools"];
};

function formatCheckLines(plan: ValidationPlan): string[] {
    const lines: string[] = [];
    plan.checks.forEach((checkId, index) => {
        lines.push(`  ${index + 1}. ${checkId} — ${describeCheckCommand(checkId, plan.testFilters)}`);
    });
    return lines;
}

export function renderHumanReport(input: {
    plan: ValidationPlan;
    scope: ReportScope;
    execution?: ReportExecution;
    ran: boolean;
    generatedAt: string;
}): string {
    const { plan, scope, execution, ran } = input;
    const lines: string[] = [];

    lines.push(ran ? "Validation plan — executed" : "Validation plan — preview (read-only)");
    const scopeText = scope.base
        ? `working-tree changes plus committed changes from the merge base of "${scope.base}" and HEAD`
        : "staged, unstaged, and untracked files";
    lines.push(`Scope: ${scopeText}`);

    if (plan.changedPaths.length === 0) {
        lines.push("No changed files detected: nothing to validate.");
        if (ran) lines.push("Nothing to execute.");
        lines.push("Outcome: OK");
        return lines.join("\n");
    }

    lines.push(`Changed paths (${plan.changedPaths.length}):`);
    for (const changed of plan.changedPaths) {
        lines.push(`  - ${changed}`);
    }
    if (scope.outOfScopePaths.length > 0) {
        lines.push(`Outside the app root (${scope.outOfScopePaths.length}, not validated here):`);
        for (const outside of scope.outOfScopePaths) {
            lines.push(`  - ${outside}`);
        }
    }

    lines.push(`Selected rules (${plan.matches.length}):`);
    for (const match of plan.matches) {
        lines.push(`  - ${match.ruleId}: ${match.summary}`);
        lines.push(`      paths: ${match.paths.join(", ")}`);
        if (match.guides.length > 0) lines.push(`      guides: ${match.guides.join(", ")}`);
        if (match.testFilters.length > 0) lines.push(`      filters: ${match.testFilters.join(", ")}`);
        lines.push(`      checks: ${match.checks.length > 0 ? match.checks.join(", ") : "(none — documentation only)"}`);
        for (const note of match.notes) {
            lines.push(`      note: ${note}`);
        }
    }

    if (plan.unmatchedPaths.length > 0) {
        lines.push(`Unmatched paths (${plan.unmatchedPaths.length}) — full JS fallback applies:`);
        for (const unmatched of plan.unmatchedPaths) {
            lines.push(`  - ${unmatched}`);
        }
    }

    if (plan.checks.length > 0) {
        lines.push(ran ? "Checks (planned order):" : "Checks (planned; not executed):");
        lines.push(...formatCheckLines(plan));
        if (plan.checks.includes("focused-tests") && plan.testFilters.length > 0) {
            lines.push(`  Focused filters (${plan.testFilters.length}): ${plan.testFilters.join(", ")}`);
            lines.push(`  Resolved specs (${plan.selectedSpecs.length}): ${plan.selectedSpecs.join(", ")}`);
        }
    }

    if (plan.guides.length > 0) {
        lines.push(`Guides (${plan.guides.length}): ${plan.guides.join(", ")}`);
    }

    if (plan.docsOnly) {
        lines.push("Documentation-only change: no code checks were selected, so code was not validated.");
    }

    if (execution) {
        lines.push("Execution:");
        lines.push(`  Tools: node ${execution.tools.node}, npm ${execution.tools.npmVersion ?? "unknown"}, cargo ${execution.tools.cargoVersion ?? "not used"}`);
        for (const result of execution.results) {
            lines.push(`  [${result.status}] ${result.checkId} (${result.durationMs}ms)`);
            if (result.detail) lines.push(`      ${result.detail}`);
            for (const logFile of result.logFiles) {
                lines.push(`      log: ${logFile}`);
            }
        }
        lines.push(execution.success
            ? "Outcome: PASSED — executed checks agree with the plan."
            : execution.interrupted
                ? "Outcome: INTERRUPTED — validation is incomplete."
                : "Outcome: FAILED — see details and preserved logs above.");
    } else if (ran) {
        lines.push("Execution: documentation-only or empty change; no checks to run.");
    } else {
        lines.push("Preview only — re-run with `npm run validate:changes -- --run` to execute the checks.");
    }

    return lines.join("\n");
}

export function buildJsonReport(input: {
    plan: ValidationPlan;
    scope: ReportScope;
    execution?: ReportExecution;
    ran: boolean;
    generatedAt: string;
}): Record<string, unknown> {
    const { plan, scope, execution, ran } = input;
    const report: Record<string, unknown> = {
        formatVersion: VALIDATION_PLAN_FORMAT_VERSION,
        generatedAt: input.generatedAt,
        command: "validate:changes",
        scope: {
            base: scope.base,
            baseCommit: scope.baseCommit,
            mergeBase: scope.mergeBase,
            includesCommittedChanges: scope.base !== null,
            appRoot: scope.appRoot,
            gitRoot: scope.gitRoot,
            outOfScopePaths: [...scope.outOfScopePaths],
        },
        changedPaths: plan.changedPaths,
        matches: plan.matches,
        unmatchedPaths: plan.unmatchedPaths,
        fallbackApplied: plan.fallbackApplied,
        guides: plan.guides,
        testFilters: plan.testFilters,
        selectedSpecs: plan.selectedSpecs,
        checks: plan.checks.map(checkId => ({
            id: checkId,
            title: getValidationCheck(checkId)?.title ?? checkId,
            command: describeCheckCommand(checkId, plan.testFilters),
        })),
        docsOnly: plan.docsOnly,
    };
    if (ran) {
        report.execution = execution ?? {
            requested: true,
            success: true,
            interrupted: false,
            results: [],
            tools: {
                node: process.version,
                npmCliPath: null,
                npmVersion: null,
                cargoVersion: null,
            },
        };
    }
    return report;
}

type MainIo = {
    stdout: { write: (text: string) => void };
    stderr: { write: (text: string) => void };
};

function registerSignalHandlers(): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return {
        signal: controller.signal,
        dispose: () => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
        },
    };
}

/**
 * Testable CLI entry: returns the process exit code instead of calling
 * process.exit. Importing this module never executes it (guarded below).
 * `overrides.appRoot` lets tests run against disposable repositories.
 */
export async function main(
    argv: readonly string[],
    io: MainIo = process,
    overrides: { appRoot?: string } = {},
): Promise<number> {
    let options: CliOptions;
    try {
        options = applyNpmForwardedConfig(parseCliArgs(argv), argv, process.env);
    } catch (error) {
        if (error instanceof CliUsageError) {
            io.stderr.write(`${error.message}\n\n${USAGE}\n`);
            return 1;
        }
        throw error;
    }
    if (options.help) {
        io.stdout.write(`${USAGE}\n`);
        return 0;
    }

    const appRoot = path.resolve(overrides.appRoot ?? APP_ROOT);
    const generatedAt = new Date().toISOString();
    try {
        const availableSpecs = discoverTestFiles(appRoot);
        const collected = await collectChangedPaths({ appRoot, base: options.base });
        let plan: ValidationPlan;
        try {
            plan = buildValidationPlan({ changedPaths: collected.paths, availableSpecs });
        } catch (error) {
            if (error instanceof ValidationMapError) {
                io.stderr.write(`${error.message}\n`);
                for (const issue of error.issues) io.stderr.write(`  - ${issue}\n`);
                return 1;
            }
            throw error;
        }

        const scope: ReportScope = {
            base: collected.base,
            baseCommit: collected.baseCommit,
            mergeBase: collected.mergeBase,
            gitRoot: collected.gitRoot,
            appRoot: collected.appRoot,
            outOfScopePaths: collected.outOfScopePaths,
        };

        const shouldExecute = options.run && plan.changedPaths.length > 0 && !plan.docsOnly;
        let execution: ExecutionOutcome | undefined;
        const signals = shouldExecute ? registerSignalHandlers() : undefined;
        try {
            if (shouldExecute) {
                execution = await executePlanChecks(plan, {
                    appRoot,
                    logDir: path.join(appRoot, ...VALIDATION_LOGS_DIR_PARTS),
                    signal: signals?.signal,
                });
            }
        } finally {
            signals?.dispose();
        }

        const reportInput = {
            plan,
            scope,
            execution,
            ran: Boolean(options.run),
            generatedAt,
        };
        if (options.json) {
            io.stdout.write(`${JSON.stringify(buildJsonReport(reportInput), null, 2)}\n`);
        } else {
            io.stdout.write(`${renderHumanReport(reportInput)}\n`);
        }

        if (execution?.interrupted) return 130;
        if (execution && !execution.success) return 1;
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr.write(`Error: ${message}\n`);
        return 1;
    }
}

async function runMain(): Promise<void> {
    const exitCode = await main(process.argv.slice(2));
    process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
    runMain().catch((error: unknown) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exit(1);
    });
}
