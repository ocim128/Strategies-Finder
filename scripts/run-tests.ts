import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type TestRunStatus = "PASS" | "FAIL";

type TestRunResult = {
    file: string;
    status: TestRunStatus;
    durationMs: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
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
    verbose: boolean;
    filters: string[];
    logsDir: string;
    results: Array<{
        file: string;
        status: TestRunStatus;
        durationMs: number;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        logFile: string;
    }>;
};

const TEST_FILES = [
    "tests/app-bootstrap.spec.ts",
    "tests/app-timing.spec.ts",
    "tests/lazy-feature-init.spec.ts",
    "tests/advanced-sizing.spec.ts",
    "tests/backtest-capital-settings.spec.ts",
    "tests/backtest-edge-analysis.spec.ts",
    "tests/strategy-calculations.spec.ts",
    "tests/data-interval-utils.spec.ts",
    "tests/data-fetcher.spec.ts",
    "tests/signal-stability.spec.ts",
    "tests/walk-forward-engine.spec.ts",
    "tests/strategies-lib/prepared-execution-parity.spec.ts",
    "tests/strategies-lib/retained-strategy-registration.spec.ts",
    "tests/strategies-lib/strategy-normalization-parity.spec.ts",
    "tests/strategy-manifest-sync.spec.ts",
    "tests/strategy-registry-loading.spec.ts",
    "tests/strategy-library-admin-plugin.spec.ts",
    "tests/strategy-library-admin-service.spec.ts",
    "tests/pivot-detection.spec.ts",
    "tests/backtesting-engine.spec.ts",
    "tests/alert-entry-evaluator.spec.ts",
    "tests/alert-evaluation-window.spec.ts",
    "tests/latest-entry-export-window.spec.ts",
    "tests/candle-cache.spec.ts",
    "tests/worker-strategy-support.spec.ts",
    "tests/alert-signal-utils.spec.ts",
    "tests/entry-signal-worker.spec.ts",
    "tests/settings-compat.spec.ts",
    "tests/strategy-panel-settings-registry.spec.ts",
    "tests/finder-cache-decision.spec.ts",
    "tests/finder-engine.spec.ts",
    "tests/finder-manager-logic.spec.ts",
    "tests/hunt-model.spec.ts",
    "tests/hunt-results.spec.ts",
    "tests/backtest-result-analysis.spec.ts",
    "tests/polymarket-diagnostics-utils.spec.ts",
    "tests/state-domains.spec.ts",
    "tests/edge-statistics.spec.ts",
    "tests/statistics-utils.spec.ts",
    "tests/walk-forward-thresholds.spec.ts",
    "tests/feature-dom-contracts.spec.ts",
    "tests/portfolio-lab.spec.ts",
    "tests/strategy-ensemble.spec.ts",
    "tests/quick-view-polymarket.spec.ts",
    "tests/polymarket-sync-outcomes-cli.spec.ts",
    "tests/polymarket-sync-utils.spec.ts",
    "tests/polymarket-outcome-evaluator.spec.ts",
    "tests/polymarket-fill-analysis.spec.ts",
    "tests/finder-polymarket.spec.ts",
    "tests/polymarket-trade-annotations.spec.ts",
    "tests/polymarket-deployability-analysis.spec.ts",
    "tests/backtest-endpoint-parity.spec.ts",
    "tests/backtest-endpoint-batch.spec.ts",
    "tests/backtest-endpoint-plugin.spec.ts",
    "tests/cross-symbol-helpers.spec.ts",
    "tests/cross-symbol-runtime.spec.ts",
    "tests/strategy-registry-cross-symbol.spec.ts",
] as const;

const MAX_CAPTURE_BUFFER_BYTES = 64 * 1024 * 1024;
const FAILURE_TAIL_LINE_COUNT = 8;
const FAILURE_LINE_WIDTH = 180;

const currentFilePath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(currentFilePath);
const repoRoot = path.resolve(scriptDir, "..");
const esnoCliPath = path.resolve(repoRoot, "..", "..", "..", "node_modules", "esno", "esno.js");
const logsBaseDir = path.join(repoRoot, "artifacts", "test-logs");
const latestLogsDir = path.join(logsBaseDir, "latest");

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run test",
        "  npm run test -- <filter>",
        "  npm run test:verbose",
        "  npm run test:json",
        "",
        "Behavior:",
        "  - `npm run test` prints one compact status line per spec and a short summary.",
        "  - Full per-spec logs are written to `artifacts/test-logs/latest`.",
        "  - Pass one or more filters to run a subset by path fragment or filename.",
        "",
        "Examples:",
        "  npm run test -- backtesting-engine",
        "  npm run test -- tests/feature-dom-contracts.spec.ts",
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

function selectTests(filters: string[]): string[] {
    if (filters.length === 0) return [...TEST_FILES];

    const normalizedFilters = filters.map(normalizeForMatch);
    const selected = TEST_FILES.filter((file) => {
        const normalizedFile = normalizeForMatch(file);
        const baseName = path.basename(normalizedFile);
        return normalizedFilters.some((filter) => normalizedFile.includes(filter) || baseName.includes(filter));
    });

    return [...selected];
}

function runSingleTest(file: string, outputMode: OutputMode): TestRunResult {
    const startedAt = Date.now();
    const run = spawnSync(process.execPath, [esnoCliPath, file], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_CAPTURE_BUFFER_BYTES,
    });
    const durationMs = Date.now() - startedAt;

    const stdout = run.stdout ?? "";
    const stderr = run.stderr ?? "";
    const status: TestRunStatus = run.status === 0 && !run.error ? "PASS" : "FAIL";
    const logFile = path.join(latestLogsDir, `${sanitizeLogName(file)}.log`);
    const runErrorText = run.error ? `\n[runner-error]\n${String(run.error.stack || run.error.message || run.error)}\n` : "";

    fs.writeFileSync(logFile, `${formatOutputForLog(stdout, stderr)}${runErrorText}`, "utf8");

    if (outputMode === "verbose") {
        console.log(`\n[${status}] ${file} (${formatDuration(durationMs)})`);
        if (stdout.trim().length > 0) process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
        if (stderr.trim().length > 0) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
        if (runErrorText) process.stderr.write(runErrorText);
    } else if (outputMode === "compact") {
        console.log(`${status} ${file} (${formatDuration(durationMs)})`);
        if (status === "FAIL") {
            const tail = getFailureTail(stdout, `${stderr}${runErrorText}`);
            if (tail.length > 0) {
                for (const line of tail) {
                    console.log(`  ${line}`);
                }
            } else {
                console.log("  No captured output. Check the log file.");
            }
        }
    }

    return {
        file,
        status,
        durationMs,
        exitCode: run.status,
        signal: run.signal,
        logFile,
        stdout,
        stderr: `${stderr}${runErrorText}`,
    };
}

function writeSummary(summary: TestRunSummary): string {
    const summaryPath = path.join(latestLogsDir, "summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    return summaryPath;
}

function main(): void {
    const args = process.argv.slice(2);
    let verbose = false;
    let json = false;
    const filters: string[] = [];

    for (const arg of args) {
        if (arg === "--verbose") {
            verbose = true;
            continue;
        }
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        }
        filters.push(arg);
    }

    const selectedTests = selectTests(filters);
    if (selectedTests.length === 0) {
        console.error("No test files matched the provided filters.");
        console.error(`Available tests: ${TEST_FILES.join(", ")}`);
        process.exit(1);
    }

    ensureLatestLogsDir();

    const startedAt = Date.now();
    const results: TestRunResult[] = [];
    for (const file of selectedTests) {
        const outputMode: OutputMode = json ? "silent" : verbose ? "verbose" : "compact";
        results.push(runSingleTest(file, outputMode));
    }
    const durationMs = Date.now() - startedAt;

    const passedCount = results.filter((result) => result.status === "PASS").length;
    const failedCount = results.length - passedCount;
    const summary: TestRunSummary = {
        generatedAt: new Date().toISOString(),
        selectedCount: results.length,
        totalCount: TEST_FILES.length,
        passedCount,
        failedCount,
        durationMs,
        verbose,
        filters,
        logsDir: latestLogsDir,
        results: results.map((result) => ({
            file: result.file,
            status: result.status,
            durationMs: result.durationMs,
            exitCode: result.exitCode,
            signal: result.signal,
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
        if (filters.length > 0) {
            console.log(`Filters: ${filters.join(", ")}`);
        }
    }

    process.exit(failedCount === 0 ? 0 : 1);
}

main();
