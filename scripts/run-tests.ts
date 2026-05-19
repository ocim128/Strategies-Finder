import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type TestRunStatus = "PASS" | "FAIL";

type TestRunResult = {
    file: string;
    status: TestRunStatus;
    durationMs: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    logFile: string;
    stdout: string;
    stderr: string;
};

type OutputMode = "compact" | "verbose" | "silent";

type TestRunSummary = {
    generatedAt: string;
    selectedCount: number;
    totalCount: number;
    passedCount: number;
    failedCount: number;
    durationMs: number;
    timeoutMs: number;
    verbose: boolean;
    filters: string[];
    logsDir: string;
    results: Array<{
        file: string;
        status: TestRunStatus;
        durationMs: number;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        timedOut: boolean;
        logFile: string;
    }>;
};

const MAX_CAPTURE_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_TEST_TIMEOUT_MS = 120000;
const FAILURE_TAIL_LINE_COUNT = 8;
const FAILURE_LINE_WIDTH = 180;
const TESTS_DIR_NAME = "tests";
const EXCLUDED_TEST_FILES = new Set([
    "tests/e2e.spec.ts",
]);
const DEFAULT_MAX_JOBS = 6;

const currentFilePath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(currentFilePath);
const repoRoot = path.resolve(scriptDir, "..");
const requireFromHere = createRequire(import.meta.url);
const esnoCliPath = requireFromHere.resolve("esno/esno.js");
const logsBaseDir = path.join(repoRoot, "artifacts", "test-logs");
const latestLogsDir = path.join(logsBaseDir, "latest");

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run test",
        "  npm run test -- <filter>",
        "  npm run test -- --jobs=4",
        "  npm run test -- --timeoutMs=120000",
        "  npm run test -- --runInBand",
        "  npm run test:verbose",
        "  npm run test:json",
        "",
        "Behavior:",
        "  - `npm run test` discovers tests/**/*.spec.ts, excluding tests/e2e.spec.ts.",
        "  - It prints one compact status line per spec and a short summary.",
        "  - Full per-spec logs are written to `artifacts/test-logs/latest`.",
        "  - Pass one or more filters to run a subset by path fragment or filename.",
        "  - Use --runInBand for serial execution or --jobs=<n> for bounded parallelism.",
        "  - Use --timeoutMs=<n> to terminate a hung spec after a bounded time.",
        "",
        "Examples:",
        "  npm run test -- backtesting-engine",
        "  npm run test -- tests/feature-dom-contracts.spec.ts",
        "  npm run test -- persisted-json",
        "  npm run test:verbose -- strategy-ensemble",
    ].join("\n"));
}

function stripAnsi(text: string): string {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function normalizeForMatch(value: string): string {
    return value.replace(/\\/g, "/").toLowerCase();
}

function sanitizeLogName(file: string): string {
    return file.replace(/[\\/]/g, "__").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${durationMs}ms`;
    return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatOutputForLog(stdout: string, stderr: string): string {
    const lines = [
        stdout ? "[stdout]" : "",
        stdout,
        stderr ? "[stderr]" : "",
        stderr,
    ].filter((part) => part !== "");
    return `${lines.join("\n")}\n`;
}

function getFailureTail(stdout: string, stderr: string): string[] {
    const cleanOutput = stripAnsi([stdout, stderr].filter(Boolean).join("\n"))
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

    return cleanOutput
        .slice(-FAILURE_TAIL_LINE_COUNT)
        .map((line) => (line.length > FAILURE_LINE_WIDTH ? `${line.slice(0, FAILURE_LINE_WIDTH - 3)}...` : line));
}

function ensureLatestLogsDir(): void {
    fs.mkdirSync(logsBaseDir, { recursive: true });
    fs.rmSync(latestLogsDir, { recursive: true, force: true });
    fs.mkdirSync(latestLogsDir, { recursive: true });
}

function toPosixPath(value: string): string {
    return value.replace(/\\/g, "/");
}

function discoverTestFiles(): string[] {
    const testsRoot = path.join(repoRoot, TESTS_DIR_NAME);
    const files: string[] = [];

    function walk(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith(".spec.ts")) {
                continue;
            }

            const relativePath = toPosixPath(path.relative(repoRoot, fullPath));
            if (!EXCLUDED_TEST_FILES.has(relativePath)) {
                files.push(relativePath);
            }
        }
    }

    walk(testsRoot);
    return files;
}

function resolveDefaultJobCount(): number {
    const available = typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length;
    return Math.max(1, Math.min(DEFAULT_MAX_JOBS, Math.max(1, available - 1)));
}

function parseExplicitJobCount(raw: string | undefined): number {
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--jobs requires a positive numeric value.");
    }
    return Math.floor(parsed);
}

function parseTimeoutMs(raw: string | undefined): number {
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed) || parsed < 1000) {
        throw new Error("--timeoutMs requires a numeric value of at least 1000.");
    }
    return Math.floor(parsed);
}

function isEnabledEnvFlag(value: string | undefined): boolean {
    if (value === undefined) return false;
    return value === "true" || value === "1";
}

function selectTests(testFiles: readonly string[], filters: string[]): string[] {
    if (filters.length === 0) return [...testFiles];

    const normalizedFilters = filters.map(normalizeForMatch);
    const selected = testFiles.filter((file) => {
        const normalizedFile = normalizeForMatch(file);
        const baseName = path.basename(normalizedFile);
        return normalizedFilters.some((filter) => normalizedFile.includes(filter) || baseName.includes(filter));
    });

    return [...selected];
}

function writeTestLog(file: string, stdout: string, stderr: string): string {
    const logFile = path.join(latestLogsDir, `${sanitizeLogName(file)}.log`);
    fs.writeFileSync(logFile, formatOutputForLog(stdout, stderr), "utf8");
    return logFile;
}

function printTestResult(result: TestRunResult, outputMode: OutputMode): void {
    if (outputMode === "verbose") {
        console.log(`\n[${result.status}] ${result.file} (${formatDuration(result.durationMs)})`);
        if (result.stdout.trim().length > 0) {
            process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
        }
        if (result.stderr.trim().length > 0) {
            process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
        }
        return;
    }

    if (outputMode !== "compact") return;

    console.log(`${result.status} ${result.file} (${formatDuration(result.durationMs)})`);
    if (result.status === "FAIL") {
        const tail = getFailureTail(result.stdout, result.stderr);
        if (tail.length > 0) {
            for (const line of tail) {
                console.log(`  ${line}`);
            }
        } else {
            console.log("  No captured output. Check the log file.");
        }
    }
}

async function runSingleTest(file: string, timeoutMs: number): Promise<TestRunResult> {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let spawnError: unknown = null;

    const child = spawn(process.execPath, [esnoCliPath, file], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = (chunk: Buffer, streamName: "stdout" | "stderr"): void => {
        capturedBytes += chunk.byteLength;
        if (capturedBytes > MAX_CAPTURE_BUFFER_BYTES) {
            if (!outputTruncated) {
                const message = `\n[runner-error]\nCaptured output exceeded ${MAX_CAPTURE_BUFFER_BYTES} bytes. Test process was terminated.\n`;
                stderr += message;
                outputTruncated = true;
                child.kill();
            }
            return;
        }

        if (streamName === "stdout") {
            stdout += chunk.toString("utf8");
        } else {
            stderr += chunk.toString("utf8");
        }
    };

    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.on("error", (error) => {
        spawnError = error;
    });

    const timeoutId = setTimeout(() => {
        timedOut = true;
        stderr += `\n[runner-error]\nTest exceeded ${timeoutMs}ms and was terminated.\n`;
        child.kill();
    }, timeoutMs);

    const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("close", (code, closeSignal) => {
            clearTimeout(timeoutId);
            resolve({ exitCode: code, signal: closeSignal });
        });
    });

    const durationMs = Date.now() - startedAt;
    const runErrorText = spawnError
        ? `\n[runner-error]\n${spawnError instanceof Error ? String(spawnError.stack || spawnError.message) : String(spawnError)}\n`
        : "";
    stderr = `${stderr}${runErrorText}`;
    const status: TestRunStatus = exitCode === 0 && !spawnError && !outputTruncated && !timedOut ? "PASS" : "FAIL";
    const logFile = writeTestLog(file, stdout, stderr);

    return { file, status, durationMs, exitCode, signal, timedOut, logFile, stdout, stderr };
}

async function runTestsInPool(
    selectedTests: readonly string[],
    jobs: number,
    timeoutMs: number,
    onResult?: (result: TestRunResult) => void
): Promise<TestRunResult[]> {
    const results: TestRunResult[] = new Array(selectedTests.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(jobs, selectedTests.length));

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < selectedTests.length) {
            const index = nextIndex;
            nextIndex += 1;
            const result = await runSingleTest(selectedTests[index], timeoutMs);
            results[index] = result;
            onResult?.(result);
        }
    }));

    return results;
}

function writeSummary(summary: TestRunSummary): string {
    const summaryPath = path.join(latestLogsDir, "summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    return summaryPath;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let verbose = false;
    let json = false;
    let runInBand = isEnabledEnvFlag(process.env.npm_config_runinband)
        || isEnabledEnvFlag(process.env.npm_config_run_in_band);
    let requestedJobs: number | null = null;
    let timeoutMs = DEFAULT_TEST_TIMEOUT_MS;
    let expectNpmJobsValue = false;
    let expectNpmTimeoutValue = false;
    if (process.env.npm_config_jobs) {
        if (process.env.npm_config_jobs === "true") {
            expectNpmJobsValue = true;
        } else {
            requestedJobs = parseExplicitJobCount(process.env.npm_config_jobs);
        }
    }
    const npmTimeout = process.env.npm_config_timeoutms ?? process.env.npm_config_timeout_ms;
    if (npmTimeout) {
        if (npmTimeout === "true") {
            expectNpmTimeoutValue = true;
        } else {
            timeoutMs = parseTimeoutMs(npmTimeout);
        }
    }
    if (process.env.TEST_TIMEOUT_MS) {
        timeoutMs = parseTimeoutMs(process.env.TEST_TIMEOUT_MS);
    }
    const filters: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (expectNpmJobsValue) {
            requestedJobs = parseExplicitJobCount(arg);
            expectNpmJobsValue = false;
            continue;
        }
        if (expectNpmTimeoutValue) {
            timeoutMs = parseTimeoutMs(arg);
            expectNpmTimeoutValue = false;
            continue;
        }
        if (arg === "--verbose") {
            verbose = true;
            continue;
        }
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg === "--runInBand") {
            runInBand = true;
            continue;
        }
        if (arg === "--jobs") {
            requestedJobs = parseExplicitJobCount(args[index + 1]);
            index += 1;
            continue;
        }
        if (arg.startsWith("--jobs=")) {
            requestedJobs = parseExplicitJobCount(arg.slice("--jobs=".length));
            continue;
        }
        if (arg === "--timeoutMs" || arg === "--timeout") {
            timeoutMs = parseTimeoutMs(args[index + 1]);
            index += 1;
            continue;
        }
        if (arg.startsWith("--timeoutMs=")) {
            timeoutMs = parseTimeoutMs(arg.slice("--timeoutMs=".length));
            continue;
        }
        if (arg.startsWith("--timeout=")) {
            timeoutMs = parseTimeoutMs(arg.slice("--timeout=".length));
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        }
        filters.push(arg);
    }
    if (expectNpmJobsValue) {
        throw new Error("--jobs requires a positive numeric value.");
    }
    if (expectNpmTimeoutValue) {
        throw new Error("--timeoutMs requires a numeric value of at least 1000.");
    }

    const testFiles = discoverTestFiles();
    const selectedTests = selectTests(testFiles, filters);
    if (selectedTests.length === 0) {
        console.error("No test files matched the provided filters.");
        console.error(`Available tests: ${testFiles.join(", ")}`);
        process.exit(1);
    }

    ensureLatestLogsDir();

    const startedAt = Date.now();
    const outputMode: OutputMode = json ? "silent" : verbose ? "verbose" : "compact";
    const jobs = runInBand ? 1 : requestedJobs ?? resolveDefaultJobCount();
    const results = await runTestsInPool(selectedTests, jobs, timeoutMs, (result) => {
        printTestResult(result, outputMode);
    });
    const durationMs = Date.now() - startedAt;

    const passedCount = results.filter((result) => result.status === "PASS").length;
    const failedCount = results.length - passedCount;
    const summary: TestRunSummary = {
        generatedAt: new Date().toISOString(),
        selectedCount: results.length,
        totalCount: testFiles.length,
        passedCount,
        failedCount,
        durationMs,
        timeoutMs,
        verbose,
        filters,
        logsDir: latestLogsDir,
        results: results.map((result) => ({
            file: result.file,
            status: result.status,
            durationMs: result.durationMs,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            logFile: result.logFile,
        })),
    };

    const summaryPath = writeSummary(summary);

    if (json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        console.log(
            `Summary: ${passedCount} passed, ${failedCount} failed, ${results.length} total (${formatDuration(durationMs)})`
        );
        console.log(`Logs: ${latestLogsDir}`);
        console.log(`Summary JSON: ${summaryPath}`);
        console.log(`Jobs: ${jobs}`);
        console.log(`Timeout: ${timeoutMs}ms`);
        if (filters.length > 0) {
            console.log(`Filters: ${filters.join(", ")}`);
        }
    }

    process.exit(failedCount === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
    if (error instanceof Error && (error.message.startsWith("--jobs") || error.message.startsWith("--timeout"))) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
