/**
 * Baseline benchmark for the two TypeScript fallback simulations in
 * lib/strategies/backtest/backtest-engine.ts (runBacktest / runBacktestCompact
 * with the single-position Finder fast path blocked).
 *
 * Purpose: record repeatable wall-clock + heap baselines BEFORE the fallback
 * loops are consolidated into one shared simulation, so the replacement can be
 * evaluated against a measured acceptance threshold instead of a guess.
 *
 * Method: fixed deterministic dataset and signals (seeded PRNG), identical
 * settings/runtime per entrypoint, warmup runs discarded, then N measured
 * runs; report median/min/max wall time and the heapUsed delta around each
 * measured run. Timing diagnostics inside results are NOT used as fixtures.
 *
 * Run: npm run bench:backtest-fallback  (or esno scripts/bench-backtest-fallback.ts)
 * Optional: --bars N --runs N --max-open N
 */
import { performance } from "node:perf_hooks";
import { MAX_OPEN_TRADES_UNLIMITED, runBacktest, runBacktestCompact } from "../lib/strategies/index";
import type { OHLCVData, Signal, Time } from "../lib/types/strategies";

function parsePositiveInt(name: string, fallback: number): number {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const BAR_COUNT = parsePositiveInt("bars", 20_000);
const MEASURED_RUNS = parsePositiveInt("runs", 7);
const MAX_OPEN_TRADES = parsePositiveInt("max-open", 2);

/** Deterministic mulberry32 PRNG so every invocation benches the same data. */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildData(count: number): OHLCVData[] {
    const random = mulberry32(0xC0FFEE);
    const data: OHLCVData[] = [];
    let price = 100;
    for (let i = 0; i < count; i += 1) {
        // Regime-switching random walk: trends then reverses, so long and
        // short trades and every exit rule get realistic activity.
        const drift = Math.sin(i / 500) * 0.4;
        const open = price;
        const close = Math.max(1, open * (1 + drift / 100 + (random() - 0.5) * 0.02));
        const high = Math.max(open, close) * (1 + random() * 0.008);
        const low = Math.min(open, close) * (1 - random() * 0.008);
        data.push({
            time: (1_700_000_000 + i * 3_600) as Time,
            open,
            high,
            low,
            close,
            volume: 1000,
        });
        price = close;
    }
    return data;
}

function buildSignals(data: OHLCVData[], everyN: number): Signal[] {
    const random = mulberry32(0xBEEF);
    const signals: Signal[] = [];
    for (let i = 10; i < data.length - 2; i += everyN) {
        const type = random() < 0.5 ? "buy" : "sell";
        signals.push({ time: data[i]!.time, type, price: data[i]!.close });
    }
    return signals;
}

interface Measurement {
    label: string;
    medianMs: number;
    minMs: number;
    maxMs: number;
    heapDeltaMb: number;
    totalTrades: number;
}

function measure(label: string, run: () => unknown): Measurement {
    // Warmup (discarded): JIT + engine-internal caches reach steady state.
    for (let i = 0; i < 2; i += 1) run();
    if (globalThis.gc) globalThis.gc();

    const durations: number[] = [];
    let heapDelta = 0;
    let totalTrades = 0;
    for (let i = 0; i < MEASURED_RUNS; i += 1) {
        if (globalThis.gc) globalThis.gc();
        const heapBefore = process.memoryUsage().heapUsed;
        const startedAt = performance.now();
        const result = run() as { totalTrades?: number };
        durations.push(performance.now() - startedAt);
        heapDelta = Math.max(heapDelta, process.memoryUsage().heapUsed - heapBefore);
        totalTrades = result?.totalTrades ?? 0;
    }
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)]!;
    return {
        label,
        medianMs: Math.round(median * 100) / 100,
        minMs: Math.round(durations[0]! * 100) / 100,
        maxMs: Math.round(durations[durations.length - 1]! * 100) / 100,
        heapDeltaMb: Math.round((heapDelta / (1024 * 1024)) * 100) / 100,
        totalTrades,
    };
}

function printTable(rows: Measurement[]): void {
    const header = ["entrypoint", "median ms", "min ms", "max ms", "peak heap Δ MB", "trades"];
    const lines = rows.map((row) => [
        row.label,
        row.medianMs.toFixed(2),
        row.minMs.toFixed(2),
        row.maxMs.toFixed(2),
        row.heapDeltaMb.toFixed(2),
        String(row.totalTrades),
    ]);
    const widths = header.map((name, column) => Math.max(name.length, ...lines.map((cells) => cells[column]!.length)));
    const format = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
    console.info(format(header));
    for (const cells of lines) console.info(format(cells));
}

function main(): void {
    console.info(`bars=${BAR_COUNT} signals-every=5 maxOpenTrades=${MAX_OPEN_TRADES} measured-runs=${MEASURED_RUNS}${globalThis.gc ? " gc=exposed" : " gc=not-exposed"}`);
    const data = buildData(BAR_COUNT);
    const signals = buildSignals(data, 5);
    const finderOptions = {
        omitEquityCurve: true,
        includeSharpeRatio: false,
        requireTradeHistory: false,
        collectDiagnostics: false,
    } as const;
    // Overlap (>=2 open books) is one of the canonical fallback blockers for
    // both entrypoints; adaptive take-profit and trailing ATR exercise the
    // same loop with heavier per-bar exit work.
    const fallbackSettings = {
        executionModel: "signal_close",
        maxOpenTrades: MAX_OPEN_TRADES,
        riskMode: "percentage",
        stopLossEnabled: true,
        stopLossPercent: 2,
        takeProfitEnabled: true,
        takeProfitPercent: 4,
        atrPeriod: 14,
        trailingAtr: 3,
    } as const;
    const lastDataTime = data[data.length - 1]!.time;

    const rows = [
        measure("runBacktest (full fallback, default analytics)", () =>
            runBacktest(data, signals, 100_000, 100, 0.1, fallbackSettings)),
        measure("runBacktestCompact (finder fallback)", () =>
            runBacktestCompact(data, signals, 100_000, 100, 0.1, fallbackSettings, undefined, undefined, finderOptions)),
        measure("runBacktestCompact + endpoint exclusion", () =>
            runBacktestCompact(data, signals, 100_000, 100, 0.1, fallbackSettings, undefined, undefined, {
                ...finderOptions,
                endpointSelectionLastDataTime: lastDataTime,
                endpointSelectionInitialCapital: 100_000,
            })),
        measure("runBacktestCompact + equityOut Float64Array", () => {
            const equityOut = new Float64Array(data.length);
            return runBacktestCompact(data, signals, 100_000, 100, 0.1, fallbackSettings, undefined, undefined, equityOut, finderOptions);
        }),
        measure(`runBacktestCompact unlimited overlap (${MAX_OPEN_TRADES_UNLIMITED}+)`, () =>
            runBacktestCompact(data, signals, 100_000, 100, 0.1,
                { ...fallbackSettings, maxOpenTrades: MAX_OPEN_TRADES_UNLIMITED }, undefined, undefined, finderOptions)),
    ];
    printTable(rows);

    const fastest = Math.min(...rows.map((row) => row.medianMs));
    const slowest = Math.max(...rows.map((row) => row.medianMs));
    console.info("\nAcceptance-threshold guidance for the shared-simulation replacement:");
    console.info(`- measured spread this run: fastest ${fastest.toFixed(2)}ms .. slowest ${slowest.toFixed(2)}ms`);
    console.info("- re-run this script several times on an idle machine; the replacement must keep every");
    console.info("  entrypoint's median within ~10% of its pre-change baseline (2x the observed run-to-run");
    console.info("  jitter), with no entrypoint regressing while another improves.");
}

main();
