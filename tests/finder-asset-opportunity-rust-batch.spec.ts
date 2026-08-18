import { expect } from "chai";
import { describe, it } from "node:test";
import {
    DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
    DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES,
    dispatchAssetOpportunityRustBatch,
    estimateAssetOpportunityRustBatchRequestBytes,
    partitionAssetOpportunityRustBatchItems,
    resolveAssetOpportunityRustBatchEligibility,
    resolveAssetOpportunityRustBatchFeatureConfig,
    shouldUseRustAssetOpportunityBatch,
    validateAssetOpportunityRustBatchResponse,
    validateAssetOpportunityRustSummaryBatchResponse,
    type AssetOpportunityRustBatchClient,
    type AssetOpportunityRustFreshBatchClient,
} from "../lib/finder/server/finder-asset-opportunity-rust-batch";
import { runServerAssetOpportunityFreshRustBatch } from "../lib/finder/server/finder-asset-opportunity-fresh-rust-batch";
import { runServerAssetIsSearch } from "../lib/finder/server/server-asset-is-search";
import { RustEngineClient } from "../lib/rust-engine-client";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions, FinderResult } from "../lib/types/finder";
import type { BacktestResult, BacktestSettings, OHLCVData, Signal, Strategy, Time } from "../lib/types/strategies";

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0.1,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
};

const eligibleSettings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
    maxOpenTrades: 1,
};

function makeCandles(length: number): OHLCVData[] {
    return Array.from({ length }, (_, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1_000,
    }));
}

function makeOptions(): FinderOptions {
    return {
        mode: "random",
        randomSeed: 1234,
        scope: "asset_opportunity",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        symbols: ["RUST"],
        topN: 2,
        steps: 3,
        rangePercent: 35,
        maxRuns: 2,
        dataSlice: "all",
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        assetOpportunity: {
            symbols: ["RUST"],
            candidatePoolSize: 2,
            minFreshSupport: 1,
            evalLastBars: 0,
        },
    } as unknown as FinderOptions;
}

function makeResult(netProfit: number): BacktestResult {
    return {
        trades: [],
        equityCurve: [],
        netProfit,
        netProfitPercent: netProfit / 100,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
    };
}

function makeRustResponse(ids: readonly string[], netProfit = 0): unknown {
    return {
        processingTimeMs: 2,
        results: ids.map((id, index) => ({ id, result: makeResult(netProfit + index) })),
    };
}

function makeFreshRustResponse(ids: readonly string[]): unknown {
    return {
        processingTimeMs: 1,
        results: ids.map((id) => ({
            id,
            result: {
                totalTrades: 1,
                latestTrade: {
                    type: "long",
                    entryTime: 1_700_000_000,
                    entryPrice: 100,
                    exitReason: "signal",
                },
                isOpen: false,
            },
        })),
    };
}

function makeMetricSummary(netProfit = 0): Record<string, unknown> {
    return {
        netProfit,
        netProfitPercent: netProfit / 100,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
    };
}

function makeAssetOpportunitySummaryResponse(ids: readonly string[]): unknown {
    return {
        processingTimeMs: 1,
        results: ids.map((id, index) => ({
            id,
            result: makeMetricSummary(index),
            selectionResult: makeMetricSummary(index),
            endpointAdjusted: false,
            endpointRemovedTrades: 0,
        })),
    };
}

function makeSignals(): Signal[] {
    return [
        { time: 1_700_000_000 as Time, type: "buy", price: 100, barIndex: 0 },
        { time: 1_700_000_300 as Time, type: "sell", price: 101, barIndex: 1 },
    ];
}

function makeClient(response: unknown): AssetOpportunityRustBatchClient & { calls: number } {
    return {
        calls: 0,
        async runBatchBacktestWithStatus(..._args) {
            this.calls += 1;
            return { ok: true, response, requestBytes: 100, elapsedMs: 2 };
        },
    };
}

function makeFreshClient(response: unknown): AssetOpportunityRustFreshBatchClient & { calls: number } {
    return {
        calls: 0,
        async runFreshEntryBatchBacktestWithStatus(..._args) {
            this.calls += 1;
            return { ok: true, response, requestBytes: 100, elapsedMs: 2 };
        },
    };
}

describe("Asset Opportunity Rust batch contract", () => {
    it("keeps the feature independently disableable and clamps request-size settings", () => {
        expect(resolveAssetOpportunityRustBatchFeatureConfig({}).enabled).to.equal(true);
        expect(resolveAssetOpportunityRustBatchFeatureConfig({
            FINDER_ASSET_OPPORTUNITY_RUST_BATCH: "0",
            FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES: "999999999",
        }).enabled).to.equal(false);
        expect(resolveAssetOpportunityRustBatchFeatureConfig({}).maxResponseBytes)
            .to.equal(DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES);
        expect(resolveAssetOpportunityRustBatchFeatureConfig({
            FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES: "1",
        }).maxRequestBytes).to.equal(DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES);
    });

    it("admits only the proven signal-close long/short profile", () => {
        const base = {
            featureConfig: {
                enabled: true,
                maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
                maxResponseBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES,
            },
            useRustEnginePreference: true,
            settings: eligibleSettings,
            capitalSettings,
            selectedStrategy: { key: "entry", name: "Entry", strategy: {} as Strategy },
        } as const;
        expect(resolveAssetOpportunityRustBatchEligibility(base).eligible).to.equal(true);
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: { ...eligibleSettings, executionModel: "next_open" },
        }).reason).to.equal("execution_model_unsupported");
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: { ...eligibleSettings, slippageBps: 1 },
        }).reason).to.equal("slippage_unsupported");
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: { ...eligibleSettings, allowSameBarExit: false },
        }).eligible).to.equal(true);
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: { ...eligibleSettings, tradeDirection: "both" },
        }).reason).to.equal("direction_unsupported");
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: { ...eligibleSettings, polymarketExitMode: "resolve_hold" },
        }).eligible).to.equal(true);
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: { ...eligibleSettings, strategyTimeframeEnabled: true },
        }).reason).to.equal("risk_control_unsupported");
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            capitalSettings: { ...capitalSettings, sizingMode: "kelly_criterion" },
        }).eligible).to.equal(true);
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            capitalSettings: { ...capitalSettings, sizingMode: "risk_parity" },
        }).reason).to.equal("smart_sizing_unsupported");
    });

    it("skips external Rust transport for low-density Asset Opportunity searches", () => {
        expect(shouldUseRustAssetOpportunityBatch(2, 500)).to.equal(false);
        expect(shouldUseRustAssetOpportunityBatch(7, 500)).to.equal(false);
        expect(shouldUseRustAssetOpportunityBatch(8, 500)).to.equal(true);
        expect(shouldUseRustAssetOpportunityBatch(2, 0)).to.equal(true);
    });

    it("partitions candidate items before the serialized request exceeds the budget", () => {
        const data = makeCandles(10);
        const items = Array.from({ length: 4 }, (_, index) => ({
            id: String(index),
            signals: Array.from({ length: 50 }, () => ({ ...makeSignals()[0]!, reason: "x".repeat(1_000) })),
            settings: eligibleSettings,
        }));
        const oneItemBytes = estimateAssetOpportunityRustBatchRequestBytes({
            data,
            items: [items[0]!],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            compact: false,
        });
        const partition = partitionAssetOpportunityRustBatchItems({
            data,
            items,
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            maxRequestBytes: oneItemBytes * 2,
        });
        expect(partition.tooLargeItemId).to.equal(undefined);
        expect(partition.chunks.length).to.be.greaterThan(1);
        expect(partition.chunks.flat().map((item) => item.id)).to.deep.equal(["0", "1", "2", "3"]);
    });

    it("rejects missing, duplicate, unknown, and inconsistent result ids", () => {
        const valid = makeRustResponse(["a", "b"]);
        expect(validateAssetOpportunityRustBatchResponse(valid, ["a", "b"]).ok).to.equal(true);
        expect(validateAssetOpportunityRustBatchResponse(makeRustResponse(["a"]), ["a", "b"])).to.include({ reason: "missing_result_id" });
        expect(validateAssetOpportunityRustBatchResponse({ processingTimeMs: 1, results: [
            { id: "a", result: makeResult(0) },
            { id: "a", result: makeResult(0) },
        ] }, ["a"])).to.include({ reason: "duplicate_result_id" });
        expect(validateAssetOpportunityRustBatchResponse(makeRustResponse(["x"]), ["a"])).to.include({ reason: "unknown_result_id" });
        expect(validateAssetOpportunityRustBatchResponse({ processingTimeMs: 1, results: [{ id: "a", result: { ...makeResult(0), totalTrades: 2 } }] }, ["a"]))
            .to.include({ reason: "inconsistent_result" });
        const nullProfitFactor = {
            ...makeResult(10),
            profitFactor: null,
            totalTrades: 1,
            winningTrades: 1,
            avgTrade: 10,
            avgWin: 10,
            expectancy: 10,
            winRate: 100,
        };
        const normalized = validateAssetOpportunityRustBatchResponse({
            processingTimeMs: 1,
            results: [{ id: "a", result: nullProfitFactor }],
        }, ["a"]);
        expect(normalized.ok).to.equal(true);
        if (normalized.ok) expect(normalized.results.get("a")!.result.profitFactor).to.equal(Number.POSITIVE_INFINITY);
        const zeroTradeNullProfitFactor = { ...makeResult(0), profitFactor: null };
        const emptyNormalized = validateAssetOpportunityRustBatchResponse({
            processingTimeMs: 1,
            results: [{ id: "empty", result: zeroTradeNullProfitFactor }],
        }, ["empty"]);
        expect(emptyNormalized.ok).to.equal(true);
        if (emptyNormalized.ok) expect(emptyNormalized.results.get("empty")!.result.profitFactor).to.equal(0);
    });

    it("validates the scalar Asset Opportunity response and avoids full histories", async () => {
        const response = makeAssetOpportunitySummaryResponse(["a"]);
        const validated = validateAssetOpportunityRustSummaryBatchResponse(response, ["a"]);
        expect(validated.ok).to.equal(true);
        const client: AssetOpportunityRustBatchClient = {
            async runBatchBacktestWithStatus() {
                throw new Error("full-history endpoint should not be selected");
            },
            async runAssetOpportunityBatchBacktestWithStatus() {
                return { ok: true, response, requestBytes: 100, elapsedMs: 1 };
            },
        };
        const result = await dispatchAssetOpportunityRustBatch({
            client,
            data: makeCandles(4),
            lastDataTime: makeCandles(4).at(-1)!.time,
            items: [{ id: "a", signals: makeSignals(), settings: eligibleSettings }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
        });
        expect(result.status).to.equal("completed");
        if (result.status === "completed") {
            expect(result.results.get("a")?.result.trades).to.deep.equal([]);
            expect(result.results.get("a")?.selectionResult?.equityCurve).to.deep.equal([]);
        }
    });

    it("sends one bounded full-result batch request and preserves cancellation/timeout reasons", async () => {
        let requestBody: Record<string, unknown> | undefined;
        const fetchImpl: typeof fetch = async (url, init) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({ status: "healthy", engine: "trading-engine-rust", version: "0.1.0" }), { status: 200 });
            }
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            const items = requestBody.items as Array<{ id: string }>;
            return new Response(JSON.stringify(makeRustResponse(items.map((item) => item.id))), { status: 200 });
        };
        const client = new RustEngineClient("http://127.0.0.1:3030", fetchImpl);
        const transport = await client.runBatchBacktestWithStatus(
            makeCandles(4),
            [{ id: "a", signals: makeSignals(), settings: eligibleSettings }],
            10_000,
            100,
            0,
            eligibleSettings,
            undefined,
            false,
            { maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES },
        );
        expect(transport.ok).to.equal(true);
        expect(requestBody?.compact).to.equal(false);
        expect((requestBody?.items as Array<{ id: string }>)[0]?.id).to.equal("a");

        const cancelled = new AbortController();
        cancelled.abort();
        const cancelledClient = new RustEngineClient("http://127.0.0.1:3030", async (url) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({ status: "healthy", engine: "trading-engine-rust" }), { status: 200 });
            }
            throw new DOMException("cancelled", "AbortError");
        });
        const cancelledResult = await cancelledClient.runBatchBacktestWithStatus(
            makeCandles(1), [], 10_000, 100, 0, eligibleSettings, undefined, false, { signal: cancelled.signal },
        );
        expect(cancelledResult).to.include({ ok: false, reason: "cancelled" });

        const timeoutClient = new RustEngineClient("http://127.0.0.1:3030", async (url, init) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({ status: "healthy", engine: "trading-engine-rust" }), { status: 200 });
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (init?.signal?.aborted) throw new DOMException("timeout", "TimeoutError");
            return new Response(JSON.stringify(makeRustResponse([])), { status: 200 });
        });
        const timeoutResult = await timeoutClient.runBatchBacktestWithStatus(
            makeCandles(1), [], 10_000, 100, 0, eligibleSettings, undefined, false, { timeoutMs: 1 },
        );
        expect(timeoutResult).to.include({ ok: false, reason: "timeout" });
    });

    it("uses the cached batch endpoint without resending OHLCV and bounds responses", async () => {
        const calls: string[] = [];
        let cachedBody: Record<string, unknown> | undefined;
        const fetchImpl: typeof fetch = async (url, init) => {
            calls.push(String(url));
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({ status: "healthy", engine: "trading-engine-rust" }), { status: 200 });
            }
            cachedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify(makeRustResponse(["cached"])), { status: 200 });
        };
        const client = new RustEngineClient("http://127.0.0.1:3030", fetchImpl);
        const transport = await client.runCachedBatchBacktestWithStatus(
            "cache-1",
            [{ id: "cached", signals: makeSignals(), settings: eligibleSettings }],
            10_000,
            100,
            0,
            eligibleSettings,
            undefined,
            false,
            { maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES },
        );
        expect(transport.ok).to.equal(true);
        expect(calls.some((url) => url.endsWith("/api/backtest/batch/cached"))).to.equal(true);
        expect(cachedBody?.cacheId).to.equal("cache-1");
        expect(cachedBody?.data).to.equal(undefined);

        const oversizedClient = new RustEngineClient("http://127.0.0.1:3030", async (url) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({ status: "healthy", engine: "trading-engine-rust" }), { status: 200 });
            }
            return new Response(JSON.stringify({ results: [], processingTimeMs: 1, padding: "x".repeat(256) }), { status: 200 });
        });
        const oversized = await oversizedClient.runBatchBacktestWithStatus(
            makeCandles(1), [], 10_000, 100, 0, eligibleSettings, undefined, false,
            { maxResponseBytes: 64 },
        );
        expect(oversized).to.include({ ok: false, reason: "response_too_large" });
    });

    it("retries an evicted cached dataset through the raw Rust batch endpoint", async () => {
        const calls: string[] = [];
        const client: AssetOpportunityRustBatchClient = {
            async runCachedBatchBacktestWithStatus() {
                calls.push("cached");
                return { ok: false, reason: "http_error", requestBytes: 120, message: "404", };
            },
            async runBatchBacktestWithStatus() {
                calls.push("raw");
                return { ok: true, response: makeRustResponse(["cached"]), requestBytes: 240, elapsedMs: 2 };
            },
        };
        const result = await dispatchAssetOpportunityRustBatch({
            client,
            data: makeCandles(4),
            cacheId: "evicted-cache",
            items: [{ id: "cached", signals: makeSignals(), settings: eligibleSettings }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
        });
        expect(result.status).to.equal("completed");
        expect(calls).to.deep.equal(["cached", "raw"]);
    });

    it("falls back the whole batch when validation fails, never returning a partial set", async () => {
        const client = makeClient(makeRustResponse(["a"]));
        const result = await dispatchAssetOpportunityRustBatch({
            client,
            data: makeCandles(4),
            items: [
                { id: "a", signals: makeSignals(), settings: eligibleSettings },
                { id: "b", signals: makeSignals(), settings: eligibleSettings },
            ],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
        });
        expect(result.status).to.equal("fallback");
        if (result.status === "fallback") expect(result.reason).to.equal("missing_result_id");
        expect(client.calls).to.equal(1);
    });

    it("keeps Rust-ranked candidates deterministic and records batch completion", async () => {
        const previous = process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
        process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = "1";
        try {
            const strategy: Strategy = {
                name: "Rust batch fixture",
                description: "deterministic signals",
                defaultParams: { marker: 1 },
                paramLabels: { marker: "Marker" },
                execute: () => makeSignals(),
            };
            const client = makeClient(makeRustResponse(["asset-opportunity:0", "asset-opportunity:1"]));
            const output = await runServerAssetIsSearch({
                ohlcvData: makeCandles(8),
                symbol: "RUST",
                interval: "5m",
                options: makeOptions(),
                settings: eligibleSettings,
                capitalSettings,
                selectedStrategy: { key: "rust_batch_fixture", name: strategy.name, strategy },
                generateParamSets: () => [{ marker: 1 }, { marker: 2 }],
                useRustEnginePreference: true,
                confirmationStrategiesLoaded: true,
                rustBatchClient: client,
                isCancelled: () => false,
                yieldControl: async () => undefined,
            });
            expect(output.results).to.have.length(2);
            expect(output.engineUsage.rustAttemptedRuns).to.equal(2);
            expect(output.engineUsage.rustCompletedRuns).to.equal(2);
            expect(output.engineUsage.typescriptCompletedRuns).to.equal(0);
            expect(output.results.every((result) => result.result.trades.length === 0)).to.equal(true);
        } finally {
            if (previous === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
            else process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = previous;
        }
    });

    it("uploads one dataset and reuses its cache for the Rust candidate batch", async () => {
        const previous = process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
        process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = "1";
        try {
            const strategy: Strategy = {
                name: "Rust cached fixture",
                description: "deterministic signals",
                defaultParams: { marker: 1 },
                paramLabels: { marker: "Marker" },
                execute: () => makeSignals(),
            };
            let cacheCalls = 0;
            let cachedBatchCalls = 0;
            const client: AssetOpportunityRustBatchClient = {
                async cacheData() {
                    cacheCalls += 1;
                    return "cache-1";
                },
                async runCachedBatchBacktestWithStatus() {
                    cachedBatchCalls += 1;
                    return { ok: true, response: makeRustResponse(["asset-opportunity:0", "asset-opportunity:1"]), requestBytes: 100, elapsedMs: 2 };
                },
                async runBatchBacktestWithStatus() {
                    throw new Error("raw endpoint should not be selected when the cache endpoint is available");
                },
            };
            const output = await runServerAssetIsSearch({
                ohlcvData: makeCandles(8),
                symbol: "RUST",
                interval: "5m",
                options: makeOptions(),
                settings: eligibleSettings,
                capitalSettings,
                selectedStrategy: { key: "rust_cached_fixture", name: strategy.name, strategy },
                generateParamSets: () => [{ marker: 1 }, { marker: 2 }],
                useRustEnginePreference: true,
                confirmationStrategiesLoaded: true,
                rustBatchClient: client,
                rustBatchDatasetCache: new Map(),
                isCancelled: () => false,
                yieldControl: async () => undefined,
            });
            expect(output.results).to.have.length(2);
            expect(cacheCalls).to.equal(1);
            expect(cachedBatchCalls).to.equal(1);
        } finally {
            if (previous === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
            else process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = previous;
        }
    });

    it("runs signal_close fresh rechecks through the Rust batch seam", async () => {
        const strategy: Strategy = {
            name: "Fresh Rust fixture",
            description: "fresh batch fixture",
            defaultParams: {},
            paramLabels: {},
            execute: () => makeSignals(),
        };
        const candidate: FinderResult = {
            key: "fresh_rust_fixture",
            name: strategy.name,
            params: {},
            result: makeResult(1),
            selectionResult: makeResult(1),
            endpointAdjusted: false,
            endpointRemovedTrades: 0,
        };
        const result = await runServerAssetOpportunityFreshRustBatch({
            client: makeFreshClient(makeFreshRustResponse(["fresh-0"])),
            input: {
                data: makeCandles(8),
                symbol: "RUST",
                interval: "5m",
                settings: eligibleSettings,
                capitalSettings,
                options: makeOptions(),
                useRustEnginePreference: true,
                selectedStrategy: { key: candidate.key, name: strategy.name, strategy },
                candidates: [{
                    id: "fresh-0",
                    signals: makeSignals(),
                    backtestSettings: eligibleSettings,
                }],
            },
        });
        expect(result?.get("fresh-0")?.engineUsed).to.equal("rust");
        expect(result?.get("fresh-0")?.rustAttempted).to.equal(true);
    });

    it("reruns every candidate through TypeScript after an incomplete Rust batch", async () => {
        const previous = process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
        process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = "1";
        try {
            const strategy: Strategy = {
                name: "Rust fallback fixture",
                description: "deterministic signals",
                defaultParams: { marker: 1 },
                paramLabels: { marker: "Marker" },
                execute: () => makeSignals(),
            };
            const output = await runServerAssetIsSearch({
                ohlcvData: makeCandles(8),
                symbol: "RUST",
                interval: "5m",
                options: makeOptions(),
                settings: eligibleSettings,
                capitalSettings,
                selectedStrategy: { key: "rust_fallback_fixture", name: strategy.name, strategy },
                generateParamSets: () => [{ marker: 1 }, { marker: 2 }],
                useRustEnginePreference: true,
                confirmationStrategiesLoaded: true,
                rustBatchClient: makeClient(makeRustResponse([])),
                isCancelled: () => false,
                yieldControl: async () => undefined,
            });
            expect(output.results).to.have.length(2);
            expect(output.engineUsage.rustAttemptedRuns).to.equal(2);
            expect(output.engineUsage.rustFallbackRuns).to.equal(2);
            expect(output.engineUsage.rustCompletedRuns).to.equal(0);
            expect(output.engineUsage.typescriptCompletedRuns).to.equal(2);
            expect(output.engineUsage.typescriptReasons[0]?.reason).to.include("Rust batch fallback");
        } finally {
            if (previous === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
            else process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = previous;
        }
    });
});
