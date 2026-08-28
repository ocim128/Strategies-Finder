import { expect } from "chai";
import { after, before, describe, it } from "node:test";
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
import { createAssetOpportunityRustMultiBatchCoordinator } from "../lib/finder/server/finder-asset-opportunity-multi-rust-batch";
import { createAssetOpportunitySignalCache } from "../lib/finder/finder-asset-opportunity-search-cache";
import { runServerAssetIsSearch } from "../lib/finder/server/server-asset-is-search";
import { RustEngineClient } from "../lib/rust-engine-client";
import {
    RUST_EXIT_REASON_CAPABILITY,
    RUST_NEXT_OPEN_CAPABILITY,
    RUST_RISK_MAX_HOLD_CAPABILITY,
} from "../lib/rust-settings-sanitizer";
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
    const originalBatchFlag = process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
    before(() => {
        process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = "1";
    });
    after(() => {
        if (originalBatchFlag === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
        else process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = originalBatchFlag;
    });

    it("keeps the feature independently disableable and clamps request-size settings", () => {
        expect(resolveAssetOpportunityRustBatchFeatureConfig({}).enabled).to.equal(false);
        expect(resolveAssetOpportunityRustBatchFeatureConfig({
            FINDER_ASSET_OPPORTUNITY_RUST_BATCH: "1",
        }).enabled).to.equal(true);
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

    it("admits the proven execution-model/slippage profile and keeps unsupported controls on TypeScript", () => {
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
            rustCapabilities: [RUST_NEXT_OPEN_CAPABILITY, RUST_RISK_MAX_HOLD_CAPABILITY, RUST_EXIT_REASON_CAPABILITY],
        } as const;
        expect(resolveAssetOpportunityRustBatchEligibility(base).eligible).to.equal(true);
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: {
                ...eligibleSettings,
                executionModel: "next_open",
                slippageBps: 5,
                riskCooldownEnabled: true,
                riskCooldownBars: 1,
            },
        }).eligible).to.equal(true);
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            rustCapabilities: [],
            settings: { ...eligibleSettings, executionModel: "next_open" },
        }).reason).to.equal("rust_capability_missing");
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            rustCapabilities: [],
            settings: { ...eligibleSettings, riskMaxHoldEnabled: true, riskMaxHoldBars: 2 },
        }).reason).to.equal("rust_capability_missing");
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            selectedStrategy: {
                key: "cross-symbol-entry",
                name: "Cross-symbol entry",
                strategy: { crossSymbolConfig: { defaultSymbol: "SECONDARY", minBars: 1 } } as Strategy,
            },
        }).reason).to.equal("cross_symbol_unsupported");
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: { ...eligibleSettings, executionModel: "next_open", stopLossAtr: 1.5 },
        }).eligible).to.equal(true);
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: {
                ...eligibleSettings,
                executionModel: "next_open",
                stopLossAtr: 1.5,
                riskCooldownEnabled: true,
                riskCooldownBars: 1,
            },
        }).eligible).to.equal(true);
        expect(resolveAssetOpportunityRustBatchEligibility({
            ...base,
            settings: { ...eligibleSettings, riskMinHoldEnabled: true },
        }).reason).to.equal("risk_control_unsupported");
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

    it("keeps Rust enabled for sparse capped searches so low-density runs do not silently become TypeScript", () => {
        expect(shouldUseRustAssetOpportunityBatch(2, 500)).to.equal(true);
        expect(shouldUseRustAssetOpportunityBatch(7, 500)).to.equal(true);
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

    it("falls back the whole batch before transport for behavior-bearing signals", async () => {
        const client = makeClient(makeRustResponse(["a"]));
        const result = await dispatchAssetOpportunityRustBatch({
            client,
            data: makeCandles(4),
            items: [{
                id: "a",
                signals: [{ ...makeSignals()[0]!, triggerPrice: 100 }],
                settings: eligibleSettings,
            }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
        });
        expect(result).to.include({ status: "fallback", reason: "signal_shape_unsupported", requests: 0 });
        expect(client.calls).to.equal(0);
    });

    it("rejects both behavior-bearing Polymarket reasons across direct and multi-asset gates", async () => {
        for (const reason of ["polymarket_take_profit", "polymarket_stop_loss"] as const) {
            const directClient = makeClient(makeRustResponse(["a"]));
            const direct = await dispatchAssetOpportunityRustBatch({
                client: directClient,
                data: makeCandles(4),
                items: [{
                    id: "a",
                    signals: [{ ...makeSignals()[0]!, reason }],
                    settings: eligibleSettings,
                }],
                initialCapital: 10_000,
                positionSizePercent: 100,
                commissionPercent: 0,
                baseSettings: eligibleSettings,
                maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
            });
            expect(direct).to.include({ status: "fallback", reason: "signal_shape_unsupported", requests: 0 });
            expect(directClient.calls).to.equal(0);

            let multiCalls = 0;
            const client = {
                getDataCacheKey: () => "polymarket-reason",
                runMultiAssetAssetOpportunityBatchBacktestWithStatus: async () => {
                    multiCalls += 1;
                    throw new Error("unsupported reason reached multi-asset Rust");
                },
            } as any;
            const coordinator = createAssetOpportunityRustMultiBatchCoordinator(client);
            const grouped = await coordinator.dispatchCandidate({
                client,
                data: makeCandles(4),
                items: [{ id: "a", signals: [{ ...makeSignals()[0]!, reason }], settings: eligibleSettings }],
                initialCapital: 10_000,
                positionSizePercent: 100,
                commissionPercent: 0,
                baseSettings: eligibleSettings,
                maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
            });
            expect(grouped).to.include({ status: "fallback", reason: "signal_shape_unsupported", requests: 0 });
            expect(multiCalls).to.equal(0);
        }
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

    it("carries realistic execution settings into the specialized Rust batch", async () => {
        const strategy: Strategy = {
            name: "Realistic Rust batch fixture",
            description: "deterministic signals",
            defaultParams: { marker: 1 },
            paramLabels: { marker: "Marker" },
            execute: () => makeSignals(),
        };
        let capturedBaseSettings: BacktestSettings | undefined;
        let capturedItemSettings: BacktestSettings[] = [];
        const client: AssetOpportunityRustBatchClient = {
            async runBatchBacktestWithStatus(_data, items, _initialCapital, _positionSize, _commission, baseSettings) {
                capturedBaseSettings = baseSettings;
                capturedItemSettings = items.map((item) => item.settings!);
                return { ok: true, response: makeRustResponse(items.map((item) => item.id)), requestBytes: 100, elapsedMs: 2 };
            },
        };
        const output = await runServerAssetIsSearch({
            ohlcvData: makeCandles(8),
            symbol: "RUST",
            interval: "5m",
            options: makeOptions(),
            settings: {
                ...eligibleSettings,
                executionModel: "next_open",
                slippageBps: 5,
                riskCooldownEnabled: true,
                riskCooldownBars: 1,
                riskMaxHoldEnabled: true,
                riskMaxHoldBars: 2,
            },
            capitalSettings,
            selectedStrategy: { key: "realistic_rust_batch_fixture", name: strategy.name, strategy },
            generateParamSets: () => [{ marker: 1, riskMaxHoldBars: 1 }, { marker: 2, riskMaxHoldBars: 2 }],
            useRustEnginePreference: true,
            rustCapabilities: [RUST_NEXT_OPEN_CAPABILITY, RUST_RISK_MAX_HOLD_CAPABILITY, RUST_EXIT_REASON_CAPABILITY],
            // Asset Opportunity shares one secondary-data helper across the
            // selected strategy set. A plain strategy must remain Rust-eligible
            // when that helper exists for a different selected strategy.
            dataFetcher: {
                getProvider: () => "local",
                fetchDataDetached: async () => makeCandles(8),
            },
            confirmationStrategiesLoaded: true,
            rustBatchClient: client,
            isCancelled: () => false,
            yieldControl: async () => undefined,
        });
        expect(output.engineUsage.rustCompletedRuns).to.equal(2);
        expect(capturedBaseSettings?.executionModel).to.equal("next_open");
        expect(capturedBaseSettings?.slippageBps).to.equal(5);
        expect(capturedBaseSettings?.riskCooldownEnabled).to.equal(true);
        expect(capturedBaseSettings?.riskCooldownBars).to.equal(1);
        expect(capturedItemSettings).to.have.length(2);
        expect(capturedItemSettings.map((settings) => settings.executionModel)).to.deep.equal(["next_open", "next_open"]);
        expect(capturedItemSettings.map((settings) => settings.slippageBps)).to.deep.equal([5, 5]);
        expect(capturedItemSettings.map((settings) => settings.riskCooldownEnabled)).to.deep.equal([true, true]);
        expect(capturedItemSettings.map((settings) => settings.riskCooldownBars)).to.deep.equal([1, 1]);
        expect(capturedItemSettings.map((settings) => settings.riskMaxHoldEnabled)).to.deep.equal([true, true]);
        expect(capturedItemSettings.map((settings) => settings.riskMaxHoldBars)).to.deep.equal([1, 2]);
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

    it("coalesces queued multi-asset cache bootstrap before Rust execution", async () => {
        const cacheGroupSizes: number[] = [];
        const executionGroupSizes: number[] = [];
        const metric = {
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: null,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
        };
        const client = {
            getDataCacheKey: (data: OHLCVData[]) => String(data[0]?.time ?? "empty"),
            cacheMultiAssetDataWithStatus: async (group: Array<{ id: string; data: OHLCVData[] }>) => {
                cacheGroupSizes.push(group.length);
                return {
                    ok: true as const,
                    response: {
                        datasets: group.map((entry) => ({ id: entry.id, cacheId: `cache:${entry.id}` })),
                    },
                    requestBytes: 1,
                    elapsedMs: 1,
                };
            },
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async (workloads: Array<{
                items: Array<{ id: string }>;
            }>) => {
                executionGroupSizes.push(workloads.length);
                return {
                    ok: true as const,
                    response: {
                        processingTimeMs: 1,
                        results: workloads.flatMap((workload) => workload.items.map((item) => ({
                            id: item.id,
                            result: metric,
                            selectionResult: metric,
                            endpointAdjusted: false,
                            endpointRemovedTrades: 0,
                        }))),
                    },
                    requestBytes: 1,
                    elapsedMs: 1,
                };
            },
        } as any;
        const coordinator = createAssetOpportunityRustMultiBatchCoordinator(client);
        const makeInput = (data: OHLCVData[], id: string) => ({
            client,
            data,
            items: [{ id, signals: [] }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            lastDataTime: data[data.length - 1]?.time ?? null,
            maxRequestBytes: 16 * 1024 * 1024,
            maxResponseBytes: 128 * 1024 * 1024,
        });

        const [first, second] = await Promise.all([
            coordinator.dispatchCandidate(makeInput(makeCandles(8), "first")),
            coordinator.dispatchCandidate(makeInput(makeCandles(8).map((candle) => ({ ...candle, time: (Number(candle.time) + 1) as Time })), "second")),
        ]);

        expect(first.status).to.equal("completed");
        expect(second.status).to.equal("completed");
        expect(cacheGroupSizes).to.deep.equal([2]);
        expect(executionGroupSizes).to.deep.equal([2]);
    });

    it("rejects behavior-bearing signals before multi-asset queueing", async () => {
        let executionCalls = 0;
        const client = {
            getDataCacheKey: () => "signals",
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async () => {
                executionCalls += 1;
                throw new Error("multi-asset Rust should not receive this signal");
            },
        } as any;
        const coordinator = createAssetOpportunityRustMultiBatchCoordinator(client);

        const result = await coordinator.dispatchCandidate({
            client,
            data: makeCandles(8),
            items: [{
                id: "behavior-bearing",
                signals: [{ ...makeSignals()[0]!, sizeFraction: 0.5 }],
                settings: eligibleSettings,
            }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            maxRequestBytes: DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
        });

        expect(result).to.include({ status: "fallback", reason: "signal_shape_unsupported", requests: 0 });
        expect(executionCalls).to.equal(0);
    });

    it("does not reuse a grouped cache ID after an in-place dataset mutation", async () => {
        let cacheCalls = 0;
        const metric = makeMetricSummary(0);
        const client = {
            getDataCacheKey: (data: OHLCVData[]) => String(data[1]?.close ?? "empty"),
            cacheData: async () => {
                cacheCalls += 1;
                return `cache:${cacheCalls}`;
            },
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async (workloads: Array<{
                items: Array<{ id: string }>;
            }>) => ({
                ok: true as const,
                response: {
                    processingTimeMs: 1,
                    results: workloads.flatMap((workload) => workload.items.map((item) => ({
                        id: item.id,
                        result: metric,
                        selectionResult: metric,
                        endpointAdjusted: false,
                        endpointRemovedTrades: 0,
                    }))),
                },
                requestBytes: 1,
                elapsedMs: 1,
            }),
        } as any;
        const coordinator = createAssetOpportunityRustMultiBatchCoordinator(client);
        const data = makeCandles(8);
        const input = () => ({
            client,
            data,
            items: [{ id: "mutable", signals: [] }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            lastDataTime: data[data.length - 1]?.time ?? null,
            maxRequestBytes: 16 * 1024 * 1024,
            maxResponseBytes: 128 * 1024 * 1024,
        });

        await coordinator.dispatchCandidate(input());
        data[1]!.close += 1;
        await coordinator.dispatchCandidate(input());

        expect(cacheCalls).to.equal(2);
    });

    it("preserves the cached dataset window start and end in grouped requests", async () => {
        let observedWindow: { start?: number; end?: number } | undefined;
        const metric = {
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: null,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
        };
        const client = {
            getDataCacheKey: () => "windowed-dataset",
            cacheMultiAssetDataWithStatus: async (group: Array<{ id: string }>) => ({
                ok: true as const,
                response: { datasets: group.map((entry) => ({ id: entry.id, cacheId: `cache:${entry.id}` })) },
                requestBytes: 1,
                elapsedMs: 1,
            }),
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async (workloads: Array<{
                dataStartIndex?: number;
                dataEndIndex?: number;
                items: Array<{ id: string }>;
            }>) => {
                observedWindow = {
                    start: workloads[0]?.dataStartIndex,
                    end: workloads[0]?.dataEndIndex,
                };
                return {
                    ok: true as const,
                    response: {
                        processingTimeMs: 1,
                        results: workloads.flatMap((workload) => workload.items.map((item) => ({
                            id: item.id,
                            result: metric,
                            selectionResult: metric,
                            endpointAdjusted: false,
                            endpointRemovedTrades: 0,
                        }))),
                    },
                    requestBytes: 1,
                    elapsedMs: 1,
                };
            },
        } as any;
        const coordinator = createAssetOpportunityRustMultiBatchCoordinator(client);
        const data = makeCandles(8);
        const result = await coordinator.dispatchCandidate({
            client,
            data: data.slice(2, 6),
            cacheData: data,
            datasetStartIndex: 2,
            datasetEndIndex: 6,
            items: [{ id: "windowed", signals: [] }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            maxRequestBytes: 16 * 1024 * 1024,
        });

        expect(result.status).to.equal("completed");
        expect(observedWindow).to.deep.equal({ start: 2, end: 6 });
    });

    it("maps a trailing IS slice onto the cached full dataset", async () => {
        const strategy: Strategy = {
            name: "Windowed Rust fixture",
            description: "deterministic signals",
            defaultParams: { marker: 1 },
            paramLabels: { marker: "Marker" },
            execute: () => makeSignals(),
        };
        const fullData = makeCandles(8);
        const windowData = fullData.slice(2, 6);
        let capturedInput: any;
        const rustMultiAssetBatch = {
            dispatchCandidate: async (input: any) => {
                capturedInput = input;
                const result = makeResult(0);
                const candidate = input.items[0];
                return {
                    status: "completed" as const,
                    results: new Map([[candidate.id, {
                        id: candidate.id,
                        result,
                        selectionResult: result,
                        endpointAdjusted: false,
                        endpointRemovedTrades: 0,
                    }]]),
                    requests: 1,
                    requestBytes: 1,
                    latencyMs: 1,
                };
            },
            dispatchFresh: async () => ({ status: "cancelled" as const, reason: "cancelled" as const, requests: 0, requestBytes: 0, latencyMs: 0 }),
        };
        const output = await runServerAssetIsSearch({
            ohlcvData: windowData,
            fullSignalData: fullData,
            symbol: "RUST",
            interval: "5m",
            options: makeOptions(),
            settings: eligibleSettings,
            capitalSettings,
            selectedStrategy: { key: "windowed_rust_fixture", name: strategy.name, strategy },
            generateParamSets: () => [{ marker: 1 }],
            useRustEnginePreference: true,
            confirmationStrategiesLoaded: true,
            rustBatchClient: {} as AssetOpportunityRustBatchClient,
            rustMultiAssetBatch: rustMultiAssetBatch as any,
            isCancelled: () => false,
            yieldControl: async () => undefined,
        });

        expect(output.results).to.have.length(1);
        expect(capturedInput.data).to.equal(windowData);
        expect(capturedInput.cacheData).to.equal(fullData);
        expect(capturedInput.datasetStartIndex).to.equal(2);
        expect(capturedInput.datasetEndIndex).to.equal(6);
    });

    it("keeps exact-window signals authoritative before warming the full-series signal cache", async () => {
        const dataLengths: number[] = [];
        const strategy: Strategy = {
            name: "Exact-window signal fixture",
            description: "signal price depends on the input window",
            defaultParams: { marker: 1 },
            paramLabels: { marker: "Marker" },
            execute: (data) => {
                dataLengths.push(data.length);
                const candle = data[2];
                return candle
                    ? [{ time: candle.time, type: "buy", price: data.length, barIndex: 2 }]
                    : [];
            },
        };
        const fullData = makeCandles(8);
        const windowData = fullData.slice(2, 6);
        let capturedSignals: Signal[] | undefined;
        const rustMultiAssetBatch = {
            dispatchCandidate: async (input: any) => {
                capturedSignals = input.items[0]?.signals;
                const result = makeResult(0);
                const candidate = input.items[0];
                return {
                    status: "completed" as const,
                    results: new Map([[candidate.id, {
                        id: candidate.id,
                        result,
                        selectionResult: result,
                        endpointAdjusted: false,
                        endpointRemovedTrades: 0,
                    }]]),
                    requests: 1,
                    requestBytes: 1,
                    latencyMs: 1,
                };
            },
            dispatchFresh: async () => ({ status: "cancelled" as const, reason: "cancelled" as const, requests: 0, requestBytes: 0, latencyMs: 0 }),
        };
        await runServerAssetIsSearch({
            ohlcvData: windowData,
            fullSignalData: fullData,
            symbol: "RUST",
            interval: "5m",
            options: makeOptions(),
            settings: eligibleSettings,
            capitalSettings,
            selectedStrategy: { key: "exact_window_fixture", name: strategy.name, strategy },
            generateParamSets: () => [{ marker: 1 }],
            useRustEnginePreference: true,
            confirmationStrategiesLoaded: true,
            rustBatchClient: {} as AssetOpportunityRustBatchClient,
            rustMultiAssetBatch: rustMultiAssetBatch as any,
            signalCache: createAssetOpportunitySignalCache(),
            isCancelled: () => false,
            yieldControl: async () => undefined,
        });

        expect(dataLengths).to.deep.equal([4, 8]);
        expect(capturedSignals).to.deep.equal([{
            time: windowData[2]!.time,
            type: "buy",
            price: 4,
            barIndex: 2,
        }]);
    });

    it("reuses the shared dataset cache across holdout coordinators", async () => {
        const cacheGroupSizes: number[] = [];
        const metric = {
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: null,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
        };
        const client = {
            getDataCacheKey: (data: OHLCVData[]) => String(data[0]?.time ?? "empty"),
            cacheMultiAssetDataWithStatus: async (group: Array<{ id: string; data: OHLCVData[] }>) => {
                cacheGroupSizes.push(group.length);
                return {
                    ok: true as const,
                    response: {
                        datasets: group.map((entry) => ({ id: entry.id, cacheId: `cache:${entry.id}` })),
                    },
                    requestBytes: 1,
                    elapsedMs: 1,
                };
            },
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async (workloads: Array<{
                items: Array<{ id: string }>;
            }>) => {
                return {
                    ok: true as const,
                    response: {
                        processingTimeMs: 1,
                        results: workloads.flatMap((workload) => workload.items.map((item) => ({
                            id: item.id,
                            result: metric,
                            selectionResult: metric,
                            endpointAdjusted: false,
                            endpointRemovedTrades: 0,
                        }))),
                    },
                    requestBytes: 1,
                    elapsedMs: 1,
                };
            },
        } as any;
        const sharedDatasetCache = new Map<string, Promise<string | null>>();
        const data = makeCandles(8);
        const makeInput = (id: string) => ({
            client,
            data,
            items: [{ id, signals: [] }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            lastDataTime: data[data.length - 1]?.time ?? null,
            maxRequestBytes: 16 * 1024 * 1024,
            maxResponseBytes: 128 * 1024 * 1024,
        });

        await createAssetOpportunityRustMultiBatchCoordinator(client, { datasetCache: sharedDatasetCache })
            .dispatchCandidate(makeInput("first"));
        await createAssetOpportunityRustMultiBatchCoordinator(client, { datasetCache: sharedDatasetCache })
            .dispatchCandidate(makeInput("second"));

        expect(cacheGroupSizes).to.deep.equal([1]);
    });

    it("drops a shared cache ID after multi-batch eviction", async () => {
        let cacheCalls = 0;
        let multiCalls = 0;
        const data = makeCandles(8);
        const client = {
            getDataCacheKey: () => "same-dataset",
            cacheMultiAssetDataWithStatus: async (group: Array<{ id: string }>) => {
                cacheCalls += group.length;
                return {
                    ok: true as const,
                    response: { datasets: group.map((entry) => ({ id: entry.id, cacheId: `cache:${entry.id}` })) },
                    requestBytes: 1,
                    elapsedMs: 1,
                };
            },
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async () => {
                multiCalls += 1;
                return { ok: false as const, reason: "http_error" as const, requestBytes: 1 };
            },
        } as any;
        const sharedDatasetCache = new Map<string, Promise<string | null>>();
        const makeInput = (id: string) => ({
            client,
            data,
            items: [{ id, signals: [] }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            lastDataTime: data[data.length - 1]?.time ?? null,
            maxRequestBytes: 16 * 1024 * 1024,
            maxResponseBytes: 128 * 1024 * 1024,
        });

        await createAssetOpportunityRustMultiBatchCoordinator(client, { datasetCache: sharedDatasetCache })
            .dispatchCandidate(makeInput("candidate"));
        await createAssetOpportunityRustMultiBatchCoordinator(client, { datasetCache: sharedDatasetCache })
            .dispatchCandidate(makeInput("candidate"));

        expect(cacheCalls).to.equal(2);
        expect(multiCalls).to.equal(2);
    });

    it("does not fan out direct Rust retries after a grouped timeout", async () => {
        let directCalls = 0;
        const client = {
            getDataCacheKey: (data: OHLCVData[]) => String(data[0]?.time ?? "empty"),
            invalidateCachedDataId: () => undefined,
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async () => ({
                ok: false as const,
                reason: "timeout" as const,
                requestBytes: 1,
            }),
            runBatchBacktestWithStatus: async () => {
                directCalls += 1;
                return { ok: false as const, reason: "timeout" as const };
            },
        } as any;
        const coordinator = createAssetOpportunityRustMultiBatchCoordinator(client);
        const result = await coordinator.dispatchCandidate({
            client,
            data: makeCandles(8),
            items: [{ id: "timed-out", signals: [] }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            lastDataTime: makeCandles(8).at(-1)?.time ?? null,
            maxRequestBytes: 16 * 1024 * 1024,
            maxResponseBytes: 128 * 1024 * 1024,
        });

        expect(result).to.include({ status: "fallback", reason: "timeout" });
        expect(directCalls).to.equal(0);
    });

    it("falls back the whole grouped workload after a malformed response", async () => {
        let directCalls = 0;
        const client = {
            getDataCacheKey: (data: OHLCVData[]) => String(data[0]?.time ?? "empty"),
            invalidateCachedDataId: () => undefined,
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async () => ({
                ok: true as const,
                response: { results: [], processingTimeMs: 1 },
                requestBytes: 1,
                elapsedMs: 1,
            }),
            runBatchBacktestWithStatus: async () => {
                directCalls += 1;
                throw new Error("malformed grouped work must not retry per asset");
            },
        } as any;
        const coordinator = createAssetOpportunityRustMultiBatchCoordinator(client);
        const result = await coordinator.dispatchCandidate({
            client,
            data: makeCandles(8),
            items: [{ id: "malformed", signals: [] }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            lastDataTime: makeCandles(8).at(-1)?.time ?? null,
            maxRequestBytes: 16 * 1024 * 1024,
            maxResponseBytes: 128 * 1024 * 1024,
        });

        expect(result).to.include({ status: "fallback", reason: "missing_result_id" });
        expect(directCalls).to.equal(0);
    });

    it("resolves queued cancelled grouped work without transport or retry", async () => {
        const controller = new AbortController();
        let transportCalls = 0;
        const client = {
            getDataCacheKey: () => "cancelled-dataset",
            runMultiAssetAssetOpportunityBatchBacktestWithStatus: async () => {
                transportCalls += 1;
                throw new Error("cancelled queued work must not reach Rust");
            },
        } as any;
        const coordinator = createAssetOpportunityRustMultiBatchCoordinator(client);
        const data = makeCandles(8);
        const pending = coordinator.dispatchCandidate({
            client,
            data,
            items: [{ id: "queued-cancel", signals: [] }],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0,
            baseSettings: eligibleSettings,
            lastDataTime: data.at(-1)?.time ?? null,
            maxRequestBytes: 16 * 1024 * 1024,
            maxResponseBytes: 128 * 1024 * 1024,
            signal: controller.signal,
        });
        controller.abort();

        const result = await pending;
        expect(result).to.include({ status: "cancelled", reason: "cancelled", requests: 0 });
        expect(transportCalls).to.equal(0);
    });
});
