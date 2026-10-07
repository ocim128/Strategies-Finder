/**
 * END-TO-END admission validation for the Rust engine using the REAL Finder
 * Symbol Universe execution core.
 *
 * This is the end-to-end half of the admission measurement story. It drives
 * `runFinderUniverseStrategyWorkerTask` — the unchanged production runner the
 * server-side Universe pool executes in its worker threads — with the real
 * strategy registry, the real settings resolver, the real RustEngineClient
 * transport, and the production TypeScript fallback boundaries inside
 * backtest-executor. Only the datasets are synthetic (deterministic, held
 * constant across every configuration and repeat); no historical market data
 * is required, which is also the main limitation of the resulting evidence.
 *
 * The server-side Universe pool runs one strategy per worker with
 * FINDER_UNIVERSE pool workers (commonly four). This script mirrors that by
 * executing four concurrent worker tasks over four distinct built-in
 * strategies per repeat, against three server configurations:
 * - unbounded: RUST_ENGINE_MAX_IN_FLIGHT absent (pre-admission behavior);
 * - limit 2 / limit 4: configured admission.
 *
 * MEASURED FINDING (2026-10-07, this repository): the attempt below could not
 * produce real Rust transport traffic from the production catalog. All 41
 * built-in strategies are Rust-INELIGIBLE through the production gates —
 * 32 emit signal fields the wire gate rejects (diagnostic `reason` strings;
 * `hasUnsupportedRustSignalShape` rejects any `reason`), the rest emit no
 * signals on the probe datasets, and the Universe Rust batch path is
 * additionally gated off because every built-in carries
 * `metadata.role = "entry"`. The per-run `engineUsage` diagnostics in the
 * output prove this directly (`rustAttemptedRuns: 0`). Real Finder
 * validation of admission therefore remains OPEN until a Rust-eligible
 * production workload exists; admission stays opt-in and no default is
 * shipped. Do not treat this script's TypeScript-bound runs as admission
 * evidence.
 *
 * Per configuration it repeats the workload and reports medians and ranges
 * for total wall time until all strategies complete, production engine-usage
 * counters (rustAttemptedRuns, rustCompletedRuns, rustFallbackRuns,
 * typescriptCompletedRuns with reasons), candidate counts, upload attempts vs
 * successes (churn), and candidate-result parity against the unbounded
 * baseline. Server memory is reported as `sampledMaxRssBytes` — the max of
 * 250 ms async samples, NOT true peak RSS.
 *
 * Note on failure semantics: the cached client forgets its cache ID only on
 * `http_error`. Connection-level resets surface as `network_error` and keep
 * the ID, so upload churn requires readable rejections, not resets.
 *
 * Run: esno scripts/validate-finder-admission.ts
 *           [--configs unbounded,2,4] [--repeats 5] [--workers 4]
 *           [--strategies 4] [--symbols 2] [--bars 20000] [--max-runs 48]
 *           [--port 3039]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import type { CapitalSettings } from "../lib/types/backtest";
import type {
    FinderOptions,
    FinderUniverseCandidate,
} from "../lib/types/finder";
import type { BacktestSettings, OHLCVData } from "../lib/types/strategies";

function parseString(name: string, fallback: string): string {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}
function parseIntOption(name: string, fallback: number): number {
    const index = process.argv.indexOf(`--${name}`);
    const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CONFIGS = parseString("configs", "unbounded,2,4")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
const REPEATS = parseIntOption("repeats", 5);
const WORKERS = parseIntOption("workers", 4);
const STRATEGY_COUNT = parseIntOption("strategies", 4);
const SYMBOLS = parseIntOption("symbols", 2);
const BAR_COUNT = parseIntOption("bars", 20_000);
const MAX_RUNS = parseIntOption("max-runs", 48);
const PORT = parseIntOption("port", 3039);

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const SERVER_BINARY = path.join(
    ROOT,
    "rust-engine",
    "target",
    "release",
    "trading-engine-server.exe",
);

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 1);
        t ^= t + (t << 13);
        return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
    };
}

/** One deterministic dataset per symbol, shared by every run. */
function buildDataset(symbolIndex: number, count: number): OHLCVData[] {
    const random = mulberry32(0x5eed + symbolIndex * 7919);
    const data: OHLCVData[] = [];
    let price = 100 + symbolIndex * 17;
    for (let i = 0; i < count; i += 1) {
        const drift = Math.sin(i / 300 + symbolIndex) * 0.5;
        const open = price;
        const close = Math.max(1, open * (1 + drift / 100 + (random() - 0.5) * 0.02));
        const high = Math.max(open, close) * (1 + random() * 0.01);
        const low = Math.min(open, close) * (1 - random() * 0.01);
        data.push({
            time: 1_700_000_000 + i * 3_600,
            open,
            high,
            low,
            close,
            volume: 1000 + Math.floor(random() * 500),
        } as OHLCVData);
        price = close;
    }
    return data;
}

type FetchCounts = {
    uploadAttempts: number;
    uploadsOk: number;
    statusByKey: Map<string, number>;
    // Batch-path engine accounting: candidates whose results come back from
    // Rust vs candidates the runner must replay through the production
    // TypeScript executor (the authoritative fallback for missing items).
    batchItemsSent: number;
    batchItemsFromRust: number;
    batchTransportFailures: number;
};

const originalFetch = globalThis.fetch;
/** Swapped per repeat; the wrapper installed before the client import reads
 * this, because RustEngineClient binds global fetch at construction. */
let currentCounts: FetchCounts = {
    uploadAttempts: 0,
    uploadsOk: 0,
    statusByKey: new Map(),
    batchItemsSent: 0,
    batchItemsFromRust: 0,
    batchTransportFailures: 0,
};

function installCountingFetchOnce(): void {
    globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ) => {
        const counts = currentCounts;
        let batchItems = 0;
        let isBatchPost = false;
        try {
            const pathname =
                typeof input === "string" ? new URL(input).pathname : undefined;
            isBatchPost =
                init?.method === "POST"
                && (pathname === "/api/backtest/batch"
                    || pathname === "/api/backtest/batch/cached");
            if (isBatchPost && typeof init?.body === "string") {
                try {
                    const parsed = JSON.parse(init.body) as { items?: unknown[] };
                    batchItems = Array.isArray(parsed.items) ? parsed.items.length : 0;
                } catch {
                    batchItems = 0;
                }
            }
            const response = await originalFetch(input, init);
            if (pathname === "/api/data/cache" && init?.method === "POST") {
                counts.uploadAttempts += 1;
                if (response.ok) counts.uploadsOk += 1;
            }
            if (isBatchPost) {
                if (response.ok) {
                    counts.batchItemsSent += batchItems;
                    try {
                        const parsed = (await response.clone().json()) as {
                            results?: unknown[];
                        };
                        const returned = Array.isArray(parsed.results)
                            ? parsed.results.length
                            : 0;
                        counts.batchItemsFromRust += returned;
                    } catch {
                        // unreadable body counts as replayed by TypeScript
                    }
                } else {
                    counts.batchTransportFailures += 1;
                    counts.batchItemsSent += batchItems;
                }
            }
            const key = `${pathname ?? "unknown"} ${response.status}`;
            counts.statusByKey.set(key, (counts.statusByKey.get(key) ?? 0) + 1);
            return response;
        } catch (error) {
            const pathname =
                typeof input === "string" ? new URL(input).pathname : "unknown";
            if (isBatchPost) {
                counts.batchTransportFailures += 1;
                counts.batchItemsSent += batchItems;
            }
            const key = `${pathname} transport-error`;
            counts.statusByKey.set(key, (counts.statusByKey.get(key) ?? 0) + 1);
            throw error;
        }
    }) as typeof fetch;
}

function freshCounts(): FetchCounts {
    currentCounts = {
        uploadAttempts: 0,
        uploadsOk: 0,
        statusByKey: new Map(),
        batchItemsSent: 0,
        batchItemsFromRust: 0,
        batchTransportFailures: 0,
    };
    return currentCounts;
}

function ensureReleaseBinary(): void {
    const { status } = spawnSync("cargo", ["build", "--release", "--locked"], {
        cwd: path.join(ROOT, "rust-engine"),
        stdio: "inherit",
    });
    if (status !== 0) throw new Error("cargo build --release failed");
}

function startServer(limit: string | null): ChildProcess {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        RUST_ENGINE_PORT: String(PORT),
        RUST_LOG: "trading_engine=warn",
    };
    if (limit !== null) env.RUST_ENGINE_MAX_IN_FLIGHT = limit;
    return spawn(SERVER_BINARY, [], { env, stdio: "ignore" });
}

async function waitHealthy(baseUrl: string, timeoutMs = 30_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch {
            // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("server did not become healthy in time");
}

function stopServer(child: ChildProcess | undefined): void {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/F", "/T"], {
            stdio: "ignore",
        });
    } else {
        child.kill("SIGKILL");
    }
}

/**
 * Genuinely asynchronous RSS sampler (spawn, never spawnSync) so the
 * benchmark's event loop — which is also the Finder's event loop — is never
 * blocked by a PowerShell cold start. The reported maximum is a SAMPLED
 * maximum and misses transient peaks between samples; it is not true peak RSS.
 */
type RssSampler = { stop: () => void; sampledMaxRssBytes: () => number | null };

function sampleRss(pid: number | undefined, intervalMs = 250): RssSampler {
    if (process.platform !== "win32" || pid === undefined) {
        return { stop: () => {}, sampledMaxRssBytes: () => null };
    }
    let peak: number | null = null;
    let inFlight = false;
    const timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        const child = spawn(
            "powershell",
            [
                "-NoProfile",
                "-Command",
                `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
        );
        child.stdout.on("data", (chunk: Buffer) => {
            const value = Number.parseInt(chunk.toString().trim(), 10);
            if (Number.isFinite(value) && (peak === null || value > peak)) {
                peak = value;
            }
        });
        child.on("close", () => {
            inFlight = false;
        });
        child.on("error", () => {
            inFlight = false;
        });
    }, intervalMs);
    return {
        stop: () => clearInterval(timer),
        sampledMaxRssBytes: () => peak,
    };
}

type EngineUsage = {
    rustRequested: boolean;
    rustAttemptedRuns: number;
    rustCompletedRuns: number;
    rustFallbackRuns: number;
    typescriptCompletedRuns: number;
    typescriptReasons: Record<string, number>;
};

type RepeatOutcome = {
    config: string;
    repeat: number;
    wallMs: number;
    candidateCounts: number[];
    resultSignatures: string[];
    engineUsage: EngineUsage;
    /** Transport-derived engine accounting (the production diagnostics do
     *  not count batch-path runs; the runner replays missing batch items
     *  through its TypeScript executor). */
    batchItemsSent: number;
    batchItemsFromRust: number;
    typescriptReplayedItems: number;
    batchTransportFailures: number;
    transportStatuses: Record<string, number>;
    uploadAttempts: number;
    uploadsOk: number;
    sampledMaxRssBytes: number | null;
    failedSymbols: string[];
    parityMatchesBaseline: boolean | null;
};

function median(values: number[]): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function candidateSignature(candidates: FinderUniverseCandidate[]): string {
    return JSON.stringify(
        candidates.map((candidate) => ({
            key: candidate.strategyKey,
            params: candidate.params,
            trades: candidate.totalTrades,
            winRate: Number(candidate.averageWinRate.toFixed(9)),
            expectancy: Number(candidate.medianExpectancy.toFixed(9)),
        })),
    );
}

async function main(): Promise<void> {
    ensureReleaseBinary();
    const baseUrl = `http://127.0.0.1:${PORT}`;
    // The client resolves its URL and binds global fetch at import time;
    // both must be prepared first.
    process.env.RUST_ENGINE_URL = baseUrl;
    installCountingFetchOnce();

    const { runFinderUniverseStrategyWorkerTask } = await import(
        "../lib/finder/server/finder-universe-strategy-worker"
    );
    const { rustEngine } = await import("../lib/rust-engine-client");
    const { getBuiltInStrategyKeys } = await import("../lib/strategies/built-in-catalog");
    const { resolveBacktestSettingsFromRaw } = await import("../lib/backtest-settings-resolver");
    const { DEFAULT_BACKTEST_SETTINGS } = await import("../lib/settings-model");

    const datasets = Array.from({ length: SYMBOLS }, (_, index) =>
        buildDataset(index, BAR_COUNT),
    );
    const symbolNames = Array.from({ length: SYMBOLS }, (_, index) => `SYNTH-${index}`);
    const strategies = [...getBuiltInStrategyKeys()].sort().slice(0, STRATEGY_COUNT);
    if (strategies.length < STRATEGY_COUNT) {
        throw new Error(`only ${strategies.length} built-in strategies available`);
    }
    const settings: BacktestSettings = resolveBacktestSettingsFromRaw(
        DEFAULT_BACKTEST_SETTINGS as BacktestSettings,
        { coerceWithoutUiToggles: true },
    );
    // The production settings sanitizer routes slippage-enabled
    // configurations to TypeScript, so the default 5 bps would keep every
    // run on the TypeScript engine and the validation would never touch the
    // Rust transport. Zero slippage is a supported product configuration and
    // makes this workload Rust-eligible.
    settings.slippageBps = 0;
    const capitalSettings: CapitalSettings = {
        initialCapital: 10_000,
        positionSize: 100,
        commission: 0.1,
        sizingMode: "percent",
        fixedTradeAmount: 1000,
    };

    const buildTaskOptions = (): FinderOptions => ({
        mode: "random",
        sortPriority: ["compositeEdgeRatio"],
        useAdvancedSort: false,
        randomSeed: 20261007,
        topN: 10,
        steps: 5,
        rangePercent: 20,
        maxRuns: MAX_RUNS,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: 0,
        universe: {
            symbols: symbolNames,
            minActiveSymbols: 1,
            minTotalTrades: 0,
            minProfitableActiveRatio: 0,
            sortPriority: ["averageWinRate"],
        },
    });

    const outcomes: RepeatOutcome[] = [];
    const baselineSignatures: string[][] = [];
    const activeCleanups: Array<() => void> = [];
    let interrupted = false;
    const onSignal = () => {
        if (interrupted) return;
        interrupted = true;
        process.stdout.write("\ninterrupted; cleaning up samplers and servers\n");
        for (const cleanup of activeCleanups.splice(0)) cleanup();
        process.exit(130);
    };
    process.on("SIGINT", onSignal);

    try {
        for (const config of CONFIGS) {
            const limit = config === "unbounded" ? null : config;
            for (let repeat = 0; repeat < REPEATS; repeat += 1) {
                if (interrupted) return;
                process.stdout.write(
                    `running config=${config} repeat=${repeat + 1}/${REPEATS}...\n`,
                );
                const child = startServer(limit);
                const rss = sampleRss(child.pid);
                const counts = freshCounts();
                const cleanup = () => {
                    rss.stop();
                    stopServer(child);
                };
                activeCleanups.push(cleanup);
                try {
                    await waitHealthy(baseUrl);
                    if (!(await rustEngine.checkHealth())) {
                        throw new Error("client health check failed");
                    }
                    const capabilities = rustEngine.capabilities;

                    const tasks = strategies.map((strategyKey, taskIndex) => ({
                        taskIndex,
                        runId: `admission-${config}-${repeat}-${taskIndex}`,
                        interval: "1h",
                        symbols: symbolNames,
                        options: buildTaskOptions(),
                        settings,
                        capitalSettings,
                        strategyKey,
                        exitStrategyKeys: [] as string[],
                        useRustEnginePreference: true,
                        rustCapabilities: capabilities,
                    }));

                    const started = performance.now();
                    const results = await Promise.all(
                        tasks.map((task) =>
                            runFinderUniverseStrategyWorkerTask({
                                task,
                                loadDataset: (symbol) => {
                                    const index = symbolNames.indexOf(symbol);
                                    if (index === -1) {
                                        throw new Error(`unexpected symbol ${symbol}`);
                                    }
                                    return Promise.resolve(datasets[index]);
                                },
                                abortSignal: new AbortController().signal,
                                isCancelled: () => false,
                                onProgress: () => {},
                            }),
                        ),
                    );
                    const wallMs = performance.now() - started;

                    const engineUsage: EngineUsage = {
                        rustRequested: true,
                        rustAttemptedRuns: 0,
                        rustCompletedRuns: 0,
                        rustFallbackRuns: 0,
                        typescriptCompletedRuns: 0,
                        typescriptReasons: {},
                    };
                    const candidateCounts: number[] = [];
                    const resultSignatures: string[] = [];
                    let failedSymbols: string[] = [];
                    for (const result of results) {
                        candidateCounts.push(result.results.length);
                        resultSignatures.push(candidateSignature(result.results));
                        failedSymbols = failedSymbols.concat(result.failedSymbols);
                        // The Universe diagnostics' engineUsage carries the
                        // optional attempted/fallback counters; read defensively.
                        type DiagnosticsEngineUsage = {
                            rustAttemptedRuns?: number;
                            rustCompletedRuns?: number;
                            rustFallbackRuns?: number;
                            typescriptCompletedRuns?: number;
                            typescriptReasons?: Array<{ reason: string; runs: number }>;
                        };
                        const usage: DiagnosticsEngineUsage | undefined =
                            result.diagnostics?.universe?.engineUsage;
                        if (usage) {
                            engineUsage.rustAttemptedRuns += usage.rustAttemptedRuns ?? 0;
                            engineUsage.rustCompletedRuns += usage.rustCompletedRuns ?? 0;
                            engineUsage.rustFallbackRuns += usage.rustFallbackRuns ?? 0;
                            engineUsage.typescriptCompletedRuns +=
                                usage.typescriptCompletedRuns ?? 0;
                            for (const reason of usage.typescriptReasons ?? []) {
                                engineUsage.typescriptReasons[reason.reason] =
                                    (engineUsage.typescriptReasons[reason.reason] ?? 0) +
                                    reason.runs;
                            }
                        }
                    }

                    // Parity: identical candidate results to the baseline
                    // config's repeat with the same index.
                    let parityMatchesBaseline: boolean | null = null;
                    if (config === CONFIGS[0]) {
                        baselineSignatures[repeat] = resultSignatures;
                        parityMatchesBaseline = true;
                    } else {
                        const baseline = baselineSignatures[repeat];
                        parityMatchesBaseline =
                            baseline !== undefined &&
                            JSON.stringify(baseline) === JSON.stringify(resultSignatures);
                    }

                    // Short workloads can finish before the async sampler's
                    // first PowerShell poll resolves; give it a bounded window
                    // so the memory column is populated. Null after the window
                    // means no sample landed.
                    for (let settle = 0; settle < 8 && rss.sampledMaxRssBytes() === null; settle += 1) {
                        await new Promise((resolve) => setTimeout(resolve, 250));
                    }
                    outcomes.push({
                        config,
                        repeat,
                        wallMs: Math.round(wallMs),
                        candidateCounts,
                        resultSignatures,
                        engineUsage,
                        batchItemsSent: counts.batchItemsSent,
                        batchItemsFromRust: counts.batchItemsFromRust,
                        typescriptReplayedItems:
                            counts.batchItemsSent - counts.batchItemsFromRust,
                        batchTransportFailures: counts.batchTransportFailures,
                        transportStatuses: Object.fromEntries(counts.statusByKey),
                        uploadAttempts: counts.uploadAttempts,
                        uploadsOk: counts.uploadsOk,
                        sampledMaxRssBytes: rss.sampledMaxRssBytes(),
                        failedSymbols,
                        parityMatchesBaseline,
                    });
                } finally {
                    cleanup();
                    const index = activeCleanups.indexOf(cleanup);
                    if (index !== -1) activeCleanups.splice(index, 1);
                }
            }
        }
    } finally {
        process.off("SIGINT", onSignal);
        for (const cleanup of activeCleanups.splice(0)) cleanup();
    }

    // Aggregate per configuration.
    process.stdout.write(
        "\n| config | repeats | wall median ms | wall min-max | candidate items | completed by Rust | replayed by TS | batch transport failures | finder candidates | upload attempts/ok | sampled max RSS MiB | parity vs baseline |\n",
    );
    process.stdout.write("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    CONFIGS.map((config) => {
        const runs = outcomes.filter((outcome) => outcome.config === config);
        const walls = runs.map((run) => run.wallMs);
        const items = runs.reduce(
            (total, run) => ({
                sent: total.sent + run.batchItemsSent,
                fromRust: total.fromRust + run.batchItemsFromRust,
                replayed: total.replayed + run.typescriptReplayedItems,
                transportFailures: total.transportFailures + run.batchTransportFailures,
            }),
            { sent: 0, fromRust: 0, replayed: 0, transportFailures: 0 },
        );
        const candidates = runs.reduce(
            (total, run) => total + run.candidateCounts.reduce((a, b) => a + b, 0),
            0,
        );
        const uploads = runs.reduce((total, run) => total + run.uploadAttempts, 0);
        const uploadsOk = runs.reduce((total, run) => total + run.uploadsOk, 0);
        const rssValues = runs
            .map((run) => run.sampledMaxRssBytes)
            .filter((value): value is number => value !== null);
        const sampledRssMiB =
            rssValues.length === 0
                ? "n/a"
                : Math.round(Math.max(...rssValues) / (1024 * 1024));
        const parity = runs.every((run) => run.parityMatchesBaseline === true);
        const reasons: Record<string, number> = {};
        for (const run of runs) {
            for (const [reason, count] of Object.entries(run.engineUsage.typescriptReasons)) {
                reasons[reason] = (reasons[reason] ?? 0) + count;
            }
        }
        process.stdout.write(
            `| ${config} | ${runs.length} | ${Math.round(median(walls))} | ${Math.min(...walls)}-${Math.max(...walls)} | ${items.sent} | ${items.fromRust} | ${items.replayed} | ${items.transportFailures} | ${candidates} | ${uploads}/${uploadsOk} | ${sampledRssMiB} | ${parity ? "match" : "MISMATCH"} |\n`,
        );
        return { config, runs };
    });

    const outDir = path.join(ROOT, "artifacts");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
        path.join(outDir, "rust-admission-finder-validation.json"),
        `${JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                options: {
                    CONFIGS,
                    REPEATS,
                    WORKERS,
                    STRATEGY_COUNT,
                    SYMBOLS,
                    BAR_COUNT,
                    MAX_RUNS,
                    PORT,
                    strategies,
                },
                limitations: [
                    "datasets are deterministic synthetic OHLCV, not historical market data",
                    "server memory is a sampled maximum (250 ms), not true peak RSS",
                    "wall time is the total until every strategy task completes with valid results",
                ],
                outcomes,
            },
            null,
            2,
        )}\n`,
    );
    process.stdout.write(
        "\nJSON results: artifacts/rust-admission-finder-validation.json\n",
    );
    process.stdout.write(
        "Reminder: admission is opt-in. Enable RUST_ENGINE_MAX_IN_FLIGHT only from measurements on the target machine and workload.\n",
    );
}

main().catch((error) => {
    console.error("validation failed", error);
    process.exitCode = 1;
});
