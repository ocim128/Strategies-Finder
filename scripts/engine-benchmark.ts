import { performance } from "node:perf_hooks";
import { rustEngine, type RustFreshEntrySummary } from "../lib/rust-engine-client";
import {
    runBacktest,
    runBacktestCompact,
    type BacktestResult,
    type BacktestSettings,
    type OHLCVData,
    type Signal,
    type Time,
} from "../lib/strategies";
import { buildSelectionResult } from "../lib/finder/endpoint";
import type { RustAssetOpportunityCandidateSummary } from "../lib/rust-engine-client";
import type { TradeSizingConfig } from "../lib/types/backtest";

type BenchmarkItem = {
    id: string;
    signals: Signal[];
};

type BenchmarkSample = {
    wallMs: number;
    serviceMs?: number;
    results: Map<string, BacktestResult>;
};

type FreshBenchmarkSample = {
    wallMs: number;
    serviceMs?: number;
    results: Map<string, RustFreshEntrySummary>;
};

type CandidateSummarySample = {
    wallMs: number;
    serviceMs?: number;
    results: Map<string, RustAssetOpportunityCandidateSummary>;
};

const FOUR_HOURS_SECONDS = 4 * 60 * 60;
const DEFAULT_BARS = 3_589;
const DEFAULT_CANDIDATES = 128;
const DEFAULT_SAMPLES = 5;
const INITIAL_CAPITAL = 10_000;
const POSITION_SIZE_PERCENT = 100;
const COMMISSION_PERCENT = 0;

const settings: BacktestSettings = {
    atrPeriod: 21,
    stopLossPercent: 2,
    takeProfitPercent: 2,
    stopLossEnabled: true,
    takeProfitEnabled: true,
    takeProfitMode: "fixed",
    riskMode: "percentage",
    maxOpenTrades: 1,
    strategyTimeframeMinutes: 120,
    riskMinHoldBars: 1,
    riskMaxHoldBars: 1,
    riskCooldownBars: 2,
    slippageBps: 0,
    tradeDirection: "long",
    executionModel: "signal_close",
    pathExitEnabled: false,
    disableSignalExits: false,
};

const sizing: TradeSizingConfig = {
    mode: "percent",
    fixedTradeAmount: 0,
};

function readPositiveInteger(name: string, fallback: number): number {
    const prefix = `--${name}=`;
    const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
    const parsed = value === undefined ? fallback : Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createBenchmarkData(barCount: number): OHLCVData[] {
    const data: OHLCVData[] = [];
    let previousClose = 100;
    for (let index = 0; index < barCount; index += 1) {
        const trend = index * 0.006;
        const cycle = Math.sin(index / 13) * 2.4 + Math.sin(index / 47) * 1.6;
        const microMove = Math.sin(index * 1.71) * 0.28;
        const open = previousClose;
        const close = Math.max(1, 100 + trend + cycle + microMove);
        const range = 0.65 + Math.abs(Math.sin(index / 9)) * 0.55;
        data.push({
                time: (1_609_459_200 + index * FOUR_HOURS_SECONDS) as Time,
            open,
            high: Math.max(open, close) + range,
            low: Math.max(0.01, Math.min(open, close) - range),
            close,
            volume: 1_000 + (index % 97) * 17,
        });
        previousClose = close;
    }
    return data;
}

function createBenchmarkItems(data: OHLCVData[], candidateCount: number): BenchmarkItem[] {
    const items: BenchmarkItem[] = [];
    const usableBars = Math.max(1, data.length - 80);
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
        const offset = 25 + (candidateIndex * 17) % 55;
        const signals: Signal[] = [];
        for (let barIndex = offset; barIndex < usableBars; barIndex += 47) {
            const candle = data[barIndex]!;
            signals.push({
                time: candle.time,
                type: "buy",
                price: candle.close,
            });
        }
        items.push({ id: `candidate-${candidateIndex}`, signals });
    }
    return items;
}

function mapResults(items: Array<{ id: string; result: BacktestResult }>): Map<string, BacktestResult> {
    return new Map(items.map((item) => [item.id, item.result]));
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function normalizedProfitFactor(value: number | null): number {
    return value === null ? 0 : value;
}

function assertResultParity(
    expected: Map<string, BacktestResult>,
    actual: Map<string, BacktestResult>,
): void {
    if (expected.size !== actual.size) {
        throw new Error(`Engine result count mismatch: TypeScript=${expected.size}, Rust=${actual.size}`);
    }
    for (const [id, expectedResult] of expected) {
        const actualResult = actual.get(id);
        if (!actualResult) throw new Error(`Rust omitted benchmark result ${id}`);
        const scalarFields: Array<keyof BacktestResult> = [
            "totalTrades",
            "winningTrades",
            "losingTrades",
            "netProfit",
            "profitFactor",
        ];
        for (const field of scalarFields) {
            const expectedValue = field === "profitFactor"
                ? normalizedProfitFactor(expectedResult.profitFactor)
                : expectedResult[field];
            const actualValue = field === "profitFactor"
                ? normalizedProfitFactor(actualResult.profitFactor)
                : actualResult[field];
            if (typeof expectedValue !== "number" || typeof actualValue !== "number") {
                throw new Error(`Non-numeric parity field ${field} for ${id}`);
            }
            const tolerance = field === "totalTrades" || field === "winningTrades" || field === "losingTrades"
                ? 0
                : Math.max(1e-7, Math.abs(expectedValue) * 1e-7);
            if (Math.abs(expectedValue - actualValue) > tolerance) {
                throw new Error(`Parity mismatch ${id}.${field}: TypeScript=${expectedValue}, Rust=${actualValue}`);
            }
        }
    }
}

function runTypeScript(
    data: OHLCVData[],
    items: BenchmarkItem[],
    fullResults: boolean,
): BenchmarkSample {
    const startedAt = performance.now();
    const results = new Map<string, BacktestResult>();
    for (const item of items) {
        const result = fullResults
            ? runBacktest(
                data,
                item.signals,
                INITIAL_CAPITAL,
                POSITION_SIZE_PERCENT,
                COMMISSION_PERCENT,
                settings,
                sizing,
            )
            : runBacktestCompact(
                data,
                item.signals,
                INITIAL_CAPITAL,
                POSITION_SIZE_PERCENT,
                COMMISSION_PERCENT,
                settings,
                sizing,
                undefined,
                {
                    omitEquityCurve: true,
                    includeSharpeRatio: false,
                    skipDrawdown: true,
                    requireTradeHistory: false,
                },
            );
        results.set(item.id, result);
    }
    return { wallMs: performance.now() - startedAt, results };
}

async function runRust(
    cacheId: string,
    items: BenchmarkItem[],
    fullResults: boolean,
): Promise<BenchmarkSample> {
    const startedAt = performance.now();
    const response = await rustEngine.runCachedBatchBacktest(
        cacheId,
        items.map((item) => ({ id: item.id, signals: item.signals })),
        INITIAL_CAPITAL,
        POSITION_SIZE_PERCENT,
        COMMISSION_PERCENT,
        settings,
        sizing,
        !fullResults,
    );
    if (!response) throw new Error("Rust batch benchmark returned no response");
    return {
        wallMs: performance.now() - startedAt,
        serviceMs: response.processingTimeMs,
        results: mapResults(response.results),
    };
}

function toFreshSummary(result: BacktestResult): RustFreshEntrySummary {
    const latestTrade = result.trades[result.trades.length - 1];
    return {
        totalTrades: result.totalTrades,
        isOpen: latestTrade?.exitReason === "end_of_data",
        latestTrade: latestTrade
            ? {
                type: latestTrade.type,
                entryTime: latestTrade.entryTime,
                entryPrice: latestTrade.entryPrice,
                exitReason: latestTrade.exitReason ?? "signal",
            }
            : null,
    };
}

async function runRustFresh(
    cacheId: string,
    items: BenchmarkItem[],
): Promise<FreshBenchmarkSample> {
    const startedAt = performance.now();
    const response = await rustEngine.runCachedFreshEntryBatchBacktest(
        cacheId,
        items.map((item) => ({ id: item.id, signals: item.signals })),
        INITIAL_CAPITAL,
        POSITION_SIZE_PERCENT,
        COMMISSION_PERCENT,
        settings,
        sizing,
    );
    if (!response) throw new Error("Rust fresh-entry summary benchmark returned no response");
    return {
        wallMs: performance.now() - startedAt,
        serviceMs: response.processingTimeMs,
        results: new Map(response.results.map((item) => [item.id, item.result])),
    };
}

function toMetricSummary(result: BacktestResult): RustAssetOpportunityCandidateSummary["result"] {
    return {
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        winRate: result.winRate,
        expectancy: result.expectancy,
        avgTrade: result.avgTrade,
        profitFactor: Number.isFinite(result.profitFactor) ? result.profitFactor : null,
        maxDrawdown: result.maxDrawdown,
        maxDrawdownPercent: result.maxDrawdownPercent,
        totalTrades: result.totalTrades,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
        sharpeRatio: result.sharpeRatio,
    };
}

function runTypeScriptCandidateSummary(
    data: OHLCVData[],
    items: BenchmarkItem[],
): { wallMs: number; results: Map<string, RustAssetOpportunityCandidateSummary> } {
    const startedAt = performance.now();
    const lastDataTime = data[data.length - 1]?.time ?? null;
    const results = new Map<string, RustAssetOpportunityCandidateSummary>();
    for (const item of items) {
        const result = runBacktest(
            data,
            item.signals,
            INITIAL_CAPITAL,
            POSITION_SIZE_PERCENT,
            COMMISSION_PERCENT,
            settings,
            sizing,
        );
        const selection = buildSelectionResult(result, lastDataTime, INITIAL_CAPITAL);
        results.set(item.id, {
            result: toMetricSummary(result),
            selectionResult: toMetricSummary(selection.result),
            endpointAdjusted: selection.adjusted,
            endpointRemovedTrades: selection.removedTrades,
        });
    }
    return { wallMs: performance.now() - startedAt, results };
}

async function runRustCandidateSummary(
    cacheId: string,
    data: OHLCVData[],
    items: BenchmarkItem[],
): Promise<CandidateSummarySample> {
    const startedAt = performance.now();
    const response = await rustEngine.runCachedAssetOpportunityBatchBacktest(
        cacheId,
        items.map((item) => ({ id: item.id, signals: item.signals })),
        INITIAL_CAPITAL,
        POSITION_SIZE_PERCENT,
        COMMISSION_PERCENT,
        settings,
        data[data.length - 1]?.time ?? null,
        sizing,
    );
    if (!response) throw new Error("Rust Asset Opportunity summary benchmark returned no response");
    return {
        wallMs: performance.now() - startedAt,
        serviceMs: response.processingTimeMs,
        results: new Map(response.results.map((item) => [item.id, {
            result: item.result,
            selectionResult: item.selectionResult,
            endpointAdjusted: item.endpointAdjusted,
            endpointRemovedTrades: item.endpointRemovedTrades,
        }])),
    };
}

function assertCandidateSummaryParity(
    expected: Map<string, RustAssetOpportunityCandidateSummary>,
    actual: Map<string, RustAssetOpportunityCandidateSummary>,
): void {
    if (expected.size !== actual.size) throw new Error("Asset Opportunity summary result count mismatch");
    const fields = [
        "netProfit", "netProfitPercent", "winRate", "expectancy", "avgTrade", "profitFactor",
        "maxDrawdown", "maxDrawdownPercent", "totalTrades", "winningTrades", "losingTrades",
        "avgWin", "avgLoss",
    ] as const;
    for (const [id, expectedSummary] of expected) {
        const actualSummary = actual.get(id);
        if (!actualSummary) throw new Error(`Rust omitted Asset Opportunity summary ${id}`);
        if (
            expectedSummary.endpointAdjusted !== actualSummary.endpointAdjusted
            || expectedSummary.endpointRemovedTrades !== actualSummary.endpointRemovedTrades
        ) throw new Error(`Asset Opportunity endpoint parity mismatch ${id}: TypeScript=${JSON.stringify(expectedSummary)}, Rust=${JSON.stringify(actualSummary)}`);
        for (const part of ["result", "selectionResult"] as const) {
            for (const field of fields) {
                const expectedValue = expectedSummary[part][field] ?? 0;
                const actualValue = actualSummary[part][field] ?? 0;
                const tolerance = field === "totalTrades" || field === "winningTrades" || field === "losingTrades"
                    ? 0
                    : Math.max(1e-6, Math.abs(expectedValue) * 1e-5);
                if (Math.abs(expectedValue - actualValue) > tolerance) {
                    throw new Error(`Asset Opportunity parity mismatch ${id}.${part}.${field}: TypeScript=${expectedValue}, Rust=${actualValue}`);
                }
            }
        }
    }
}

function assertFreshParity(
    typescript: Map<string, RustFreshEntrySummary>,
    rust: Map<string, RustFreshEntrySummary>,
): void {
    if (typescript.size !== rust.size) {
        throw new Error(`Fresh result count mismatch: TypeScript=${typescript.size}, Rust=${rust.size}`);
    }
    for (const [id, expected] of typescript) {
        const actual = rust.get(id);
        if (!actual) throw new Error(`Rust omitted fresh benchmark result ${id}`);
        if (expected.totalTrades !== actual.totalTrades || expected.isOpen !== actual.isOpen) {
            throw new Error(`Fresh parity mismatch ${id}: TypeScript=${JSON.stringify(expected)}, Rust=${JSON.stringify(actual)}`);
        }
        if (expected.latestTrade === null || actual.latestTrade === null) {
            if (expected.latestTrade !== actual.latestTrade) {
                throw new Error(`Fresh latest-trade parity mismatch ${id}`);
            }
            continue;
        }
        if (
            expected.latestTrade.type !== actual.latestTrade.type
            || expected.latestTrade.entryTime !== actual.latestTrade.entryTime
            || Math.abs(expected.latestTrade.entryPrice - actual.latestTrade.entryPrice) > 1e-7
        ) {
            throw new Error(`Fresh latest-trade parity mismatch ${id}: TypeScript=${JSON.stringify(expected)}, Rust=${JSON.stringify(actual)}`);
        }
    }
}

function formatMs(value: number): string {
    return `${value.toFixed(2)} ms`;
}

async function main(): Promise<void> {
    const barCount = readPositiveInteger("bars", DEFAULT_BARS);
    const candidateCount = readPositiveInteger("candidates", DEFAULT_CANDIDATES);
    const sampleCount = readPositiveInteger("samples", DEFAULT_SAMPLES);
    const data = createBenchmarkData(barCount);
    const items = createBenchmarkItems(data, candidateCount);

    if (!await rustEngine.checkHealth()) {
        throw new Error("Rust engine is unavailable at http://127.0.0.1:3030");
    }
    // The Rust cache is a bounded LRU-like map. Clear it so an existing full
    // cache cannot evict the dataset this benchmark just uploaded.
    const clearResponse = await fetch("http://127.0.0.1:3030/api/data/clear", { method: "POST" });
    if (!clearResponse.ok) {
        throw new Error(`Rust engine cache clear failed: ${clearResponse.status} ${clearResponse.statusText}`);
    }
    rustEngine.clearLocalCache();
    const cacheId = await rustEngine.cacheData(data);
    if (!cacheId) throw new Error("Rust engine rejected benchmark dataset caching");

    // Warm both implementations and the Rust data cache before collecting samples.
    runTypeScript(data, items, false);
    await runRust(cacheId, items, false);
    runTypeScript(data, items, true);
    await runRust(cacheId, items, true);
    runTypeScriptCandidateSummary(data, items);
    await runRustCandidateSummary(cacheId, data, items);

    const modes = [
        { name: "compact", fullResults: false },
        { name: "full trade history", fullResults: true },
    ];
    const report: Array<{
        mode: string;
        typescript: BenchmarkSample[];
        rust: BenchmarkSample[];
    }> = [];

    for (const mode of modes) {
        const typescript: BenchmarkSample[] = [];
        const rust: BenchmarkSample[] = [];
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
            // Alternate order across samples to reduce one-sided thermal/JIT bias.
            if (sampleIndex % 2 === 0) {
                typescript.push(runTypeScript(data, items, mode.fullResults));
                rust.push(await runRust(cacheId, items, mode.fullResults));
            } else {
                rust.push(await runRust(cacheId, items, mode.fullResults));
                typescript.push(runTypeScript(data, items, mode.fullResults));
            }
        }
        assertResultParity(
            typescript[0]!.results,
            rust[0]!.results,
        );
        report.push({ mode: mode.name, typescript, rust });
    }

    console.log("\nEngine benchmark");
    console.log(`Workload: ${barCount.toLocaleString("en-US")} bars, ${candidateCount} candidates, ${sampleCount} measured samples`);
    console.log("Signals: deterministic pre-generated buy signals; identical input for both engines");
    console.log("Rust transport: one cached batch request per sample; cache upload/clear excluded from timings");
    console.log("Parity: all checked scalar metrics and endpoint flags matched within tolerance\n");
    for (const entry of report) {
        const typescriptMedian = median(entry.typescript.map((sample) => sample.wallMs));
        const rustMedian = median(entry.rust.map((sample) => sample.wallMs));
        const rustServiceMedian = median(entry.rust.map((sample) => sample.serviceMs ?? 0));
        const speedup = rustMedian > 0 ? typescriptMedian / rustMedian : 0;
        console.log(`${entry.mode}:`);
        console.log(`  TypeScript median: ${formatMs(typescriptMedian)}`);
        console.log(`  Rust batch median: ${formatMs(rustMedian)} (Rust service: ${formatMs(rustServiceMedian)})`);
        console.log(`  Rust speedup:      ${speedup.toFixed(2)}x`);
    }

    const candidateTypeScript: Array<{ wallMs: number; results: Map<string, RustAssetOpportunityCandidateSummary> }> = [];
    const candidateRust: CandidateSummarySample[] = [];
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        if (sampleIndex % 2 === 0) {
            candidateTypeScript.push(runTypeScriptCandidateSummary(data, items));
            candidateRust.push(await runRustCandidateSummary(cacheId, data, items));
        } else {
            candidateRust.push(await runRustCandidateSummary(cacheId, data, items));
            candidateTypeScript.push(runTypeScriptCandidateSummary(data, items));
        }
    }
    assertCandidateSummaryParity(candidateTypeScript[0]!.results, candidateRust[0]!.results);
    const candidateTypeScriptMedian = median(candidateTypeScript.map((sample) => sample.wallMs));
    const candidateRustMedian = median(candidateRust.map((sample) => sample.wallMs));
    const candidateRustServiceMedian = median(candidateRust.map((sample) => sample.serviceMs ?? 0));
    console.log("asset-opportunity scalar summary:");
    console.log(`  TypeScript full replay + endpoint selection: ${formatMs(candidateTypeScriptMedian)}`);
    console.log(`  Rust scalar batch:                         ${formatMs(candidateRustMedian)} (Rust service: ${formatMs(candidateRustServiceMedian)})`);
    console.log(`  Rust speedup:                              ${(candidateTypeScriptMedian / candidateRustMedian).toFixed(2)}x`);
    console.log("");

    const freshTypeScript: FreshBenchmarkSample[] = [];
    const freshRust: FreshBenchmarkSample[] = [];
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        if (sampleIndex % 2 === 0) {
            const typescript = runTypeScript(data, items, true);
            freshTypeScript.push({
                wallMs: typescript.wallMs,
                results: new Map([...typescript.results].map(([id, result]) => [id, toFreshSummary(result)])),
            });
            freshRust.push(await runRustFresh(cacheId, items));
        } else {
            freshRust.push(await runRustFresh(cacheId, items));
            const typescript = runTypeScript(data, items, true);
            freshTypeScript.push({
                wallMs: typescript.wallMs,
                results: new Map([...typescript.results].map(([id, result]) => [id, toFreshSummary(result)])),
            });
        }
    }
    assertFreshParity(freshTypeScript[0]!.results, freshRust[0]!.results);
    const freshTypeScriptMedian = median(freshTypeScript.map((sample) => sample.wallMs));
    const freshRustMedian = median(freshRust.map((sample) => sample.wallMs));
    const freshRustServiceMedian = median(freshRust.map((sample) => sample.serviceMs ?? 0));
    console.log("fresh-entry summary:");
    console.log(`  TypeScript full replay: ${formatMs(freshTypeScriptMedian)}`);
    console.log(`  Rust summary batch:     ${formatMs(freshRustMedian)} (Rust service: ${formatMs(freshRustServiceMedian)})`);
    console.log(`  Rust speedup:            ${(freshTypeScriptMedian / freshRustMedian).toFixed(2)}x`);
    console.log("");
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
