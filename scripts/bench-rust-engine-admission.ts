/**
 * Admission-limit tuning benchmark for the Rust engine
 * (RUST_ENGINE_MAX_IN_FLIGHT, default 2).
 *
 * Purpose: the admission default is an evaluation starting point, not a
 * validated product setting. This harness drives the PRODUCTION
 * RustEngineClient transport (real fallback semantics: an in-flight 503
 * surfaces as `http_error`, which is what triggers TypeScript fallback and
 * cache-ID forgetting) with a concurrent Finder-like batch workload, and
 * compares candidate limits against a high-limit control.
 *
 * Per limit it records:
 * - total wall time for the fixed workload,
 * - transport outcomes by failure reason (http_error == fallback trigger),
 * - actual cache-upload POSTs (re-upload churn after failures),
 * - request latency p50/p95,
 * - peak RSS of the server process (Windows: sampled via PowerShell; other
 *   platforms report null).
 *
 * This is a synthetic concurrent workload, not the Finder product loop.
 * Before rollout, run the same comparison against real Finder workloads
 * (Universe execution can use four Rust-preferred workers) and choose the
 * shipped default from those results.
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
const SERVER_BINARY = path.join(ROOT, "rust-engine", "target", "release", "trading-engine-server.exe");

/** Deterministic mulberry32 PRNG so every invocation drives the same data. */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 1);
        t ^= t + (t << 13);
        return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
    };
}

function buildData(count: number): OHLCVData[] {
    const random = mulberry32(0xC0FFEE);
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
    const random = mulberry32(0xBEEF + startBar);
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

type FetchCounts = { uploads: number; byStatus: Map<string, number> };

function makeCountingFetch(counts: FetchCounts): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await fetch(input, init);
        const pathname = new URL(response.url).pathname;
        if (pathname === "/api/data/cache" && init?.method === "POST") {
            counts.uploads += 1;
        }
        const key = `${pathname} ${response.status}`;
        counts.byStatus.set(key, (counts.byStatus.get(key) ?? 0) + 1);
        return response;
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
    const child = spawn(SERVER_BINARY, [], {
        env: {
            ...process.env,
            RUST_ENGINE_PORT: String(PORT),
            RUST_ENGINE_MAX_IN_FLIGHT: String(limit),
            RUST_LOG: "trading_engine=warn",
        },
        stdio: "ignore",
    });
    return child;
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
        spawnSync("taskkill", ["/PID", String(child.pid), "/F", "/T"], { stdio: "ignore" });
    } else {
        child.kill("SIGKILL");
    }
}

type RssSampler = { stop: () => void; peakRssBytes: () => number | null };

function samplePeakRss(pid: number | undefined): RssSampler {
    if (process.platform !== "win32" || pid === undefined) {
        return { stop: () => {}, peakRssBytes: () => null };
    }
    let peak: number | null = null;
    const timer = setInterval(() => {
        const result = spawnSync(
            "powershell",
            ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`],
            { encoding: "utf8" },
        );
        const value = Number.parseInt((result.stdout ?? "").trim(), 10);
        if (Number.isFinite(value) && (peak === null || value > peak)) peak = value;
    }, 250);
    return {
        stop: () => clearInterval(timer),
        peakRssBytes: () => peak,
    };
}

function percentile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) return Number.NaN;
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
    return sorted[index];
}

type LimitResult = {
    limit: number;
    wallMs: number;
    requests: number;
    ok: number;
    fallbacksByReason: Record<string, number>;
    uploads: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    peakRssBytes: number | null;
};

async function runWorkload(limit: number): Promise<LimitResult> {
    const baseUrl = `http://127.0.0.1:${PORT}`;
    const counts: FetchCounts = { uploads: 0, byStatus: new Map() };
    const client = new RustEngineClient(baseUrl, makeCountingFetch(counts));
    const baseSettings = {} as BacktestSettings;

    const child = startServer(limit);
    const rss = samplePeakRss(child.pid);
    const fallbacksByReason: Record<string, number> = {};
    const latencies: number[] = [];
    let requests = 0;
    let ok = 0;
    try {
        await waitHealthy(baseUrl);
        const healthy = await client.checkHealth();
        if (!healthy) throw new Error("client health check failed against a healthy server");

        const data = buildData(BAR_COUNT);
        const cacheId = await client.cacheData(data);

        const started = performance.now();
        for (let round = 0; round < ROUNDS; round += 1) {
            const workers = Array.from({ length: WORKERS }, async (_, worker) => {
                const items = Array.from({ length: ITEMS_PER_BATCH }, (_, item) => ({
                    id: `candidate-${round}-${worker}-${item}`,
                    signals: buildSignals(round * 997 + item * 31, SIGNALS_PER_ITEM),
                }));
                requests += 1;
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
                if (result.ok) {
                    ok += 1;
                } else {
                    fallbacksByReason[result.reason] = (fallbacksByReason[result.reason] ?? 0) + 1;
                }
                // Every other round, one worker re-attempts an upload so churn
                // after cache-ID forgetting is visible in the counts.
                if (worker === 0 && round % 2 === 1) {
                    requests += 1;
                    const uploadStarted = performance.now();
                    const upload = await client.cacheData(data);
                    latencies.push(performance.now() - uploadStarted);
                    if (upload !== null) ok += 1;
                    else fallbacksByReason.upload_failed = (fallbacksByReason.upload_failed ?? 0) + 1;
                }
            });
            await Promise.all(workers);
        }
        const wallMs = performance.now() - started;
        rss.stop();
        const sorted = [...latencies].sort((a, b) => a - b);
        return {
            limit,
            wallMs: Math.round(wallMs),
            requests,
            ok,
            fallbacksByReason,
            uploads: counts.uploads,
            latencyP50Ms: Math.round(percentile(sorted, 0.5)),
            latencyP95Ms: Math.round(percentile(sorted, 0.95)),
            peakRssBytes: rss.peakRssBytes(),
        };
    } finally {
        rss.stop();
        stopServer(child);
    }
}

async function main(): Promise<void> {
    ensureReleaseBinary();
    const results: LimitResult[] = [];
    for (const limit of LIMITS) {
        process.stdout.write(`running workload at RUST_ENGINE_MAX_IN_FLIGHT=${limit}...\n`);
        results.push(await runWorkload(limit));
        // Give the OS a moment to release the port between server runs.
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const control = results.reduce((best, current) =>
        current.limit > best.limit ? current : best,
    );
    process.stdout.write("\n| limit | wall ms | requests | ok | fallbacks | uploads | p50 ms | p95 ms | peak RSS MiB |\n");
    process.stdout.write("| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    for (const result of results) {
        const fallbacks = Object.entries(result.fallbacksByReason)
            .map(([reason, count]) => `${reason}:${count}`)
            .join(" ") || "0";
        const peak = result.peakRssBytes === null ? "n/a" : Math.round(result.peakRssBytes / (1024 * 1024));
        const delta = ((result.wallMs / control.wallMs - 1) * 100).toFixed(0);
        process.stdout.write(
            `| ${result.limit} | ${result.wallMs} (${delta}% vs control) | ${result.requests} | ${result.ok} | ${fallbacks} | ${result.uploads} | ${result.latencyP50Ms} | ${result.latencyP95Ms} | ${peak} |\n`,
        );
    }

    const outDir = path.join(ROOT, "artifacts");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
        path.join(outDir, "rust-admission-tuning.json"),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), options: { LIMITS, WORKERS, ROUNDS, BAR_COUNT, ITEMS_PER_BATCH, SIGNALS_PER_ITEM, PORT }, results }, null, 2)}\n`,
    );
    process.stdout.write("\nJSON results: artifacts/rust-admission-tuning.json\n");
    process.stdout.write(
        "Reminder: this is a synthetic concurrent workload through the production client. Choose the shipped default from real Finder runs before rollout.\n",
    );
}

main().catch((error) => {
    console.error("benchmark failed", error);
    process.exitCode = 1;
});
