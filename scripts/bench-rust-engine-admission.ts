/**
 * Raw-transport admission benchmark for the Rust engine
 * (RUST_ENGINE_MAX_IN_FLIGHT).
 *
 * This is the RAW TRANSPORT half of the admission measurement story. It drives
 * the production RustEngineClient with a concurrent batch workload and then
 * COMPLETES every candidate through the production TypeScript fallback engine
 * (lib/strategies runBacktestCompact — the same boundary the product falls
 * back to), so wall time includes finishing failed candidates instead of
 * dropping them. For the END-TO-END half (the real Finder Universe runner
 * with its own fallback boundaries and diagnostics), see
 * scripts/validate-finder-admission.ts. Neither run chooses the shipped
 * admission default by itself.
 *
 * Per limit this records, kept in separate sections:
 * - transport (raw): outcomes by failure reason, attempted vs successful
 *   cache uploads, per-request latency;
 * - end-to-end: candidates attempted, TypeScript fallback executions,
 *   candidates completed with a valid result, and total wall time until
 *   every candidate completed;
 * - memory: `sampledMaxRssBytes` — the maximum of RSS samples taken every
 *   250 ms from the server process via an async (non-blocking) sampler.
 *   Sampling misses transient peaks between samples, so this is a sampled
 *   maximum, NOT true peak RSS.
 *
 * Samplers and servers are cleaned up on success, failure, and Ctrl+C.
 *
 * Run: esno scripts/bench-rust-engine-admission.ts [--limits 2,4,64]
 *           [--workers 4] [--rounds 8] [--bars 100000] [--items 16]
 *           [--signals 1500] [--port 3039]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { RustEngineClient } from "../lib/rust-engine-client";
import {
    MAX_OPEN_TRADES_UNLIMITED,
    runBacktestCompact,
} from "../lib/strategies";
import type { BacktestSettings, OHLCVData, Signal } from "../lib/types/strategies";

function parseString(name: string, fallback: string): string {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}
function parseIntOption(name: string, fallback: number): number {
    const index = process.argv.indexOf(`--${name}`);
    const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const LIMITS = parseString("limits", "2,4,64")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
const WORKERS = parseIntOption("workers", 4);
const ROUNDS = parseIntOption("rounds", 8);
const BAR_COUNT = parseIntOption("bars", 100_000);
const ITEMS_PER_BATCH = parseIntOption("items", 16);
const SIGNALS_PER_ITEM = parseIntOption("signals", 1500);
const PORT = parseIntOption("port", 3039);

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const SERVER_BINARY = path.join(
    ROOT,
    "rust-engine",
    "target",
    "release",
    "trading-engine-server.exe",
);

/** Deterministic mulberry32 PRNG so every invocation drives the same data. */
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

function buildData(count: number): OHLCVData[] {
    const random = mulberry32(0xc0ffee);
    const data: OHLCVData[] = [];
    let price = 100;
    for (let i = 0; i < count; i += 1) {
        const drift = Math.sin(i / 500) * 0.4;
        const open = price;
        const close = Math.max(1, open * (1 + drift / 100 + (random() - 0.5) * 0.02));
        const high = Math.max(open, close) * (1 + random() * 0.008);
        const low = Math.min(open, close) * (1 - random() * 0.008);
        data.push({
            time: 1_700_000_000 + i * 3_600,
            open,
            high,
            low,
            close,
            volume: 1000,
        } as OHLCVData);
        price = close;
    }
    return data;
}

function buildSignals(startBar: number, count: number): Signal[] {
    const random = mulberry32(0xbeef + startBar);
    const signals: Signal[] = [];
    for (let i = 0; i < count; i += 1) {
        const bar = startBar + i * 2;
        signals.push({
            time: 1_700_000_000 + bar * 3_600,
            type: i % 2 === 0 ? "buy" : "sell",
            price: 100 + random() * 2,
        } as Signal);
    }
    return signals;
}

type FetchCounts = {
    uploadAttempts: number;
    uploadsOk: number;
    statusByKey: Map<string, number>;
};

function makeCountingFetch(counts: FetchCounts): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        try {
            const response = await fetch(input, init);
            const pathname = new URL(response.url).pathname;
            if (pathname === "/api/data/cache" && init?.method === "POST") {
                counts.uploadAttempts += 1;
                if (response.ok) counts.uploadsOk += 1;
            }
            const key = `${pathname} ${response.status}`;
            counts.statusByKey.set(key, (counts.statusByKey.get(key) ?? 0) + 1);
            return response;
        } catch (error) {
            const pathname =
                typeof input === "string" ? new URL(input).pathname : "unknown";
            const key = `${pathname} transport-error`;
            counts.statusByKey.set(key, (counts.statusByKey.get(key) ?? 0) + 1);
            throw error;
        }
    }) as typeof fetch;
}

function ensureReleaseBinary(): void {
    const { status } = spawnSync("cargo", ["build", "--release", "--locked"], {
        cwd: path.join(ROOT, "rust-engine"),
        stdio: "inherit",
    });
    if (status !== 0) throw new Error("cargo build --release failed");
}

function startServer(limit: number): ChildProcess {
    return spawn(SERVER_BINARY, [], {
        env: {
            ...process.env,
            RUST_ENGINE_PORT: String(PORT),
            RUST_ENGINE_MAX_IN_FLIGHT: String(limit),
            RUST_LOG: "trading_engine=warn",
        },
        stdio: "ignore",
    });
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
 * Genuinely asynchronous RSS sampler: each poll spawns PowerShell without
 * blocking the benchmark's event loop (spawnSync here would stall every
 * in-flight request for the duration of a PowerShell cold start). Samples
 * every `intervalMs`; the reported maximum is a SAMPLED maximum and misses
 * transient peaks between samples — it is not true peak RSS.
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

function percentile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) return Number.NaN;
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
    return sorted[index];
}

type LimitResult = {
    limit: number;
    // Raw transport section.
    transport: {
        requests: number;
        ok: number;
        fallbacksByReason: Record<string, number>;
        uploadAttempts: number;
        uploadsOk: number;
        latencyP50Ms: number;
        latencyP95Ms: number;
    };
    // End-to-end section: every candidate finishes with a valid result.
    endToEnd: {
        candidates: number;
        completedCandidates: number;
        typescriptFallbackExecutions: number;
        wallMsUntilAllCompleted: number;
    };
    memory: {
        sampledMaxRssBytes: number | null;
        note: string;
    };
};

/** Registered by each workload so interruption can clean everything up. */
const activeCleanups: Array<() => void> = [];

async function runWorkload(limit: number): Promise<LimitResult> {
    const baseUrl = `http://127.0.0.1:${PORT}`;
    const counts: FetchCounts = {
        uploadAttempts: 0,
        uploadsOk: 0,
        statusByKey: new Map(),
    };
    const client = new RustEngineClient(baseUrl, makeCountingFetch(counts));
    const baseSettings = {} as BacktestSettings;

    const child = startServer(limit);
    const rss = sampleRss(child.pid);
    const cleanup = () => {
        rss.stop();
        stopServer(child);
    };
    activeCleanups.push(cleanup);
    const fallbacksByReason: Record<string, number> = {};
    const latencies: number[] = [];
    let transportRequests = 0;
    let transportOk = 0;
    let candidates = 0;
    let completedCandidates = 0;
    let fallbackExecutions = 0;
    try {
        await waitHealthy(baseUrl);
        if (!(await client.checkHealth())) {
            throw new Error("client health check failed against a healthy server");
        }

        const data = buildData(BAR_COUNT);
        const cacheId = await client.cacheData(data);

        const workloadStarted = performance.now();
        for (let round = 0; round < ROUNDS; round += 1) {
            const workers = Array.from({ length: WORKERS }, async (_, worker) => {
                const items = Array.from({ length: ITEMS_PER_BATCH }, (_, item) => ({
                    id: `candidate-${round}-${worker}-${item}`,
                    signals: buildSignals(round * 997 + item * 31, SIGNALS_PER_ITEM),
                }));
                candidates += 1;
                const startedAt = performance.now();
                const result =
                    cacheId !== null
                        ? await client.runCachedBatchBacktestWithStatus(
                              cacheId,
                              items,
                              10_000,
                              100,
                              0.1,
                              baseSettings,
                              undefined,
                              true,
                          )
                        : await client.runBatchBacktestWithStatus(
                              data,
                              items,
                              10_000,
                              100,
                              0.1,
                              baseSettings,
                              undefined,
                              true,
                          );
                latencies.push(performance.now() - startedAt);
                transportRequests += 1;
                if (result.ok) {
                    transportOk += 1;
                    completedCandidates += 1;
                } else {
                    fallbacksByReason[result.reason] =
                        (fallbacksByReason[result.reason] ?? 0) + 1;
                    // Complete the candidate through the production fallback
                    // engine so wall time includes finishing failed work.
                    fallbackExecutions += 1;
                    for (const item of items) {
                        runBacktestCompact(
                            data,
                            item.signals,
                            10_000,
                            100,
                            0.1,
                            { ...baseSettings, maxOpenTrades: MAX_OPEN_TRADES_UNLIMITED },
                            { mode: "percent" },
                        );
                    }
                    completedCandidates += 1;
                }
                // Every other round one worker re-attempts an upload so
                // churn (attempted vs successful uploads) is visible.
                if (worker === 0 && round % 2 === 1) {
                    transportRequests += 1;
                    const uploadStarted = performance.now();
                    const upload = await client.cacheData(data);
                    latencies.push(performance.now() - uploadStarted);
                    if (upload !== null) {
                        transportOk += 1;
                    } else {
                        fallbacksByReason.upload_failed =
                            (fallbacksByReason.upload_failed ?? 0) + 1;
                    }
                }
            });
            await Promise.all(workers);
        }
        const wallMsUntilAllCompleted = performance.now() - workloadStarted;
        const sorted = [...latencies].sort((a, b) => a - b);
        return {
            limit,
            transport: {
                requests: transportRequests,
                ok: transportOk,
                fallbacksByReason,
                uploadAttempts: counts.uploadAttempts,
                uploadsOk: counts.uploadsOk,
                latencyP50Ms: Math.round(percentile(sorted, 0.5)),
                latencyP95Ms: Math.round(percentile(sorted, 0.95)),
            },
            endToEnd: {
                candidates,
                completedCandidates,
                typescriptFallbackExecutions: fallbackExecutions,
                wallMsUntilAllCompleted: Math.round(wallMsUntilAllCompleted),
            },
            memory: {
                sampledMaxRssBytes: rss.sampledMaxRssBytes(),
                note: "max of 250 ms RSS samples; transient peaks between samples are missed; not true peak RSS",
            },
        };
    } finally {
        cleanup();
        const index = activeCleanups.indexOf(cleanup);
        if (index !== -1) activeCleanups.splice(index, 1);
    }
}

async function main(): Promise<void> {
    ensureReleaseBinary();
    const results: LimitResult[] = [];
    for (const limit of LIMITS) {
        process.stdout.write(
            `running workload at RUST_ENGINE_MAX_IN_FLIGHT=${limit}...\n`,
        );
        results.push(await runWorkload(limit));
        // Give the OS a moment to release the port between server runs.
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const control = results.reduce((best, current) =>
        current.limit > best.limit ? current : best,
    );
    process.stdout.write(
        "\nRaw transport section (client-visible outcomes only):\n| limit | requests | ok | failures by reason | upload attempts | uploads ok | p50 ms | p95 ms |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n",
    );
    for (const result of results) {
        const failures =
            Object.entries(result.transport.fallbacksByReason)
                .map(([reason, count]) => `${reason}:${count}`)
                .join(" ") || "0";
        process.stdout.write(
            `| ${result.limit} | ${result.transport.requests} | ${result.transport.ok} | ${failures} | ${result.transport.uploadAttempts} | ${result.transport.uploadsOk} | ${result.transport.latencyP50Ms} | ${result.transport.latencyP95Ms} |\n`,
        );
    }
    process.stdout.write(
        "\nEnd-to-end section (every candidate completed through fallback when needed):\n| limit | candidates | completed | TS fallback executions | wall ms until all completed | vs control |\n| --- | --- | --- | --- | --- | --- |\n",
    );
    for (const result of results) {
        const delta = (
            (result.endToEnd.wallMsUntilAllCompleted / control.endToEnd.wallMsUntilAllCompleted - 1) *
            100
        ).toFixed(0);
        process.stdout.write(
            `| ${result.limit} | ${result.endToEnd.candidates} | ${result.endToEnd.completedCandidates} | ${result.endToEnd.typescriptFallbackExecutions} | ${result.endToEnd.wallMsUntilAllCompleted} | ${delta}% |\n`,
        );
    }
    process.stdout.write(
        "\nMemory section (sampled, not true peak):\n| limit | sampled max RSS MiB |\n| --- | --- |\n",
    );
    for (const result of results) {
        const peak =
            result.memory.sampledMaxRssBytes === null
                ? "n/a"
                : Math.round(result.memory.sampledMaxRssBytes / (1024 * 1024));
        process.stdout.write(`| ${result.limit} | ${peak} |\n`);
    }

    const outDir = path.join(ROOT, "artifacts");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
        path.join(outDir, "rust-admission-tuning.json"),
        `${JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                options: { LIMITS, WORKERS, ROUNDS, BAR_COUNT, ITEMS_PER_BATCH, SIGNALS_PER_ITEM, PORT },
                results,
            },
            null,
            2,
        )}\n`,
    );
    process.stdout.write("\nJSON results: artifacts/rust-admission-tuning.json\n");
}

async function mainWithCleanup(): Promise<void> {
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
        await main();
    } finally {
        process.off("SIGINT", onSignal);
        for (const cleanup of activeCleanups.splice(0)) cleanup();
    }
}

mainWithCleanup().catch((error) => {
    console.error("benchmark failed", error);
    process.exitCode = 1;
});
