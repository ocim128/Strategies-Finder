import assert from "node:assert";
import { describe, it } from "node:test";
import {
    BACKTEST_ENDPOINT_DATASET_REF_PLACEHOLDER,
    buildBacktestEndpointCopyBundleFromSnapshot,
    buildBacktestEndpointRequestFromSnapshot,
    clearCurrentUiBacktestEndpointSnapshot,
    computeBacktestEndpointDatasetFingerprint,
    getCurrentUiBacktestEndpointCandles,
    matchesEndpointCapitalProfile,
    prepareBacktestEndpointCopyBundleFromSnapshot,
    resolveEndpointCopyEngineMode,
    resolveEndpointPolymarketAnnotation,
    setCurrentUiBacktestEndpointCandles,
    uploadBacktestEndpointDataset,
    type UiBacktestEndpointSnapshot,
} from "../lib/backtest-endpoint-copy";
import { BACKTEST_ENDPOINT_CAPITAL_SETTINGS } from "../lib/backtest-endpoint-contract";
import type { OHLCVData, Time } from "../lib/types/strategies";

function buildSnapshot(engineUsed: "rust" | "typescript"): UiBacktestEndpointSnapshot {
    return {
        symbol: "BTCUSDT",
        interval: "5m",
        strategyKey: "median_deviation_streak",
        strategyParams: {
            lookback: 20,
            threshold: 1.5,
        },
        backtestSettings: {
            executionModel: "next_open",
            tradeDirection: "short",
            allowSameBarExit: true,
            slippageBps: 0,
            marketMode: "all",
        },
        capitalSettings: {
            ...BACKTEST_ENDPOINT_CAPITAL_SETTINGS,
        },
        nowSec: 1775400000,
        blockRange: { from: 1775390000, to: 1775400000 },
        annotatePolymarket: false,
        engineUsed,
        datasetFingerprint: computeBacktestEndpointDatasetFingerprint(buildCandles()),
    };
}

function buildCandles(): OHLCVData[] {
    return [
        { time: 1700000000 as Time, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
        { time: 1700000300 as Time, open: 100.5, high: 102, low: 100, close: 101.5, volume: 12 },
    ];
}

describe("backtest endpoint copy helpers", () => {
    it("builds a single-run endpoint request from the latest UI snapshot", () => {
        const candles = buildCandles();
        const snapshot = buildSnapshot("typescript");
        const request = buildBacktestEndpointRequestFromSnapshot(snapshot, candles);

        assert.strictEqual(request.symbol, snapshot.symbol);
        assert.strictEqual(request.interval, snapshot.interval);
        assert.ok(!("strategyKey" in request));
        assert.deepStrictEqual(request.strategyParams, snapshot.strategyParams);
        assert.strictEqual(request.backtestSettings.executionModel, snapshot.backtestSettings.executionModel);
        assert.strictEqual(request.backtestSettings.tradeDirection, snapshot.backtestSettings.tradeDirection);
        assert.strictEqual(request.backtestSettings.allowSameBarExit, snapshot.backtestSettings.allowSameBarExit);
        assert.strictEqual(request.backtestSettings.slippageBps, snapshot.backtestSettings.slippageBps);
        assert.strictEqual(request.backtestSettings.marketMode, snapshot.backtestSettings.marketMode);
        assert.ok(!("polymarketAnnotationEnabled" in request.backtestSettings));
        assert.ok(!("snapshotRsiMin" in request.backtestSettings));
        assert.ok(!("snapshotRsiMax" in request.backtestSettings));
        assert.strictEqual(request.backtestSettings.polymarketAnnotationEnabled, true);
        assert.deepStrictEqual(request.context, {
            nowSec: snapshot.nowSec,
            blockRange: snapshot.blockRange,
            annotatePolymarket: true,
            engineMode: "typescript",
        });
        assert.ok("candles" in request.dataset);
        assert.deepStrictEqual(request.dataset.candles, candles);
        assert.notStrictEqual(request.dataset.candles, candles);
    });

    it("preserves a rust UI run as rust_preferred for endpoint replay", () => {
        const snapshot = buildSnapshot("rust");
        const request = buildBacktestEndpointRequestFromSnapshot(snapshot, buildCandles());

        assert.strictEqual(resolveEndpointCopyEngineMode("rust"), "rust_preferred");
        assert.strictEqual(request.context.engineMode, "rust_preferred");
    });

    it("builds a compact copy bundle with endpoint urls and a dataset ref placeholder", () => {
        const snapshot = buildSnapshot("typescript");
        const bundle = buildBacktestEndpointCopyBundleFromSnapshot(snapshot, "http://localhost:5173/");

        assert.strictEqual(bundle.url, "http://localhost:5173/api/backtest/median_deviation_streak");
        assert.strictEqual(bundle.method, "POST");
        assert.strictEqual(bundle.datasetUploadUrl, "http://localhost:5173/api/backtest/datasets");
        assert.strictEqual(bundle.payload.dataset.ref, BACKTEST_ENDPOINT_DATASET_REF_PLACEHOLDER);
        assert.deepStrictEqual(bundle.payload.strategyParams, snapshot.strategyParams);
        assert.ok(!("snapshotRsiMin" in bundle.payload.backtestSettings));
        assert.ok(!("snapshotRsiMax" in bundle.payload.backtestSettings));
        assert.strictEqual(bundle.payload.backtestSettings.polymarketAnnotationEnabled, true);
        assert.strictEqual(bundle.payload.context.annotatePolymarket, true);
    });

    it("supports building a compact copy bundle with a resolved dataset ref", () => {
        const snapshot = buildSnapshot("typescript");
        const bundle = buildBacktestEndpointCopyBundleFromSnapshot(
            snapshot,
            "http://localhost:5173/",
            "cache_abc123"
        );

        assert.strictEqual(bundle.payload.dataset.ref, "cache_abc123");
    });

    it("uploads candles and returns a reusable dataset ref", async () => {
        const candles = buildCandles();
        const originalFetch = globalThis.fetch;

        try {
            globalThis.fetch = (async (input, init) => {
                assert.strictEqual(input, "http://localhost:5173/api/backtest/datasets");
                assert.strictEqual(init?.method, "POST");
                assert.strictEqual(
                    (init?.headers as Record<string, string>)["Content-Type"],
                    "application/json"
                );
                assert.deepStrictEqual(JSON.parse(String(init?.body)).candles, candles);

                return new Response(JSON.stringify({
                    ok: true,
                    datasetRef: "cache_abc123",
                    hash: "hash_abc123",
                    candleCount: candles.length,
                    firstTime: 1700000000,
                    lastTime: 1700000300,
                }), {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                    },
                });
            }) as typeof fetch;

            const upload = await uploadBacktestEndpointDataset("http://localhost:5173/", candles);
            assert.strictEqual(upload.datasetUploadUrl, "http://localhost:5173/api/backtest/datasets");
            assert.strictEqual(upload.datasetRef, "cache_abc123");
            assert.strictEqual(upload.candleCount, candles.length);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("surfaces a clear endpoint-unavailable error when dataset upload cannot reach the API", async () => {
        const candles = buildCandles();
        const originalFetch = globalThis.fetch;

        try {
            globalThis.fetch = (async () => {
                throw new TypeError("Failed to fetch");
            }) as typeof fetch;

            await assert.rejects(
                () => uploadBacktestEndpointDataset("http://localhost:5173/", candles),
                /Backtest endpoint is unavailable at http:\/\/localhost:5173.*api\/backtest\/health/
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("falls back to a placeholder dataset ref when endpoint upload is unavailable", async () => {
        const candles = buildCandles();
        const snapshot = buildSnapshot("typescript");
        const originalFetch = globalThis.fetch;

        try {
            globalThis.fetch = (async () => {
                throw new TypeError("Failed to fetch");
            }) as typeof fetch;

            const prepared = await prepareBacktestEndpointCopyBundleFromSnapshot(
                snapshot,
                "http://localhost:5173/",
                candles
            );

            assert.strictEqual(prepared.datasetUploaded, false);
            assert.strictEqual(prepared.datasetRef, BACKTEST_ENDPOINT_DATASET_REF_PLACEHOLDER);
            assert.strictEqual(prepared.candleCount, candles.length);
            assert.match(prepared.datasetUploadError ?? "", /Backtest endpoint is unavailable/);
            assert.strictEqual(
                prepared.bundle.payload.dataset.ref,
                BACKTEST_ENDPOINT_DATASET_REF_PLACEHOLDER
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("does not hide dataset upload HTTP errors behind the placeholder fallback", async () => {
        const candles = buildCandles();
        const snapshot = buildSnapshot("typescript");
        const originalFetch = globalThis.fetch;

        try {
            globalThis.fetch = (async () => new Response(JSON.stringify({
                ok: false,
                error: "dataset upload rejected",
            }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                },
            })) as typeof fetch;

            await assert.rejects(
                () => prepareBacktestEndpointCopyBundleFromSnapshot(
                    snapshot,
                    "http://localhost:5173/",
                    candles
                ),
                /dataset upload rejected/
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("stores endpoint copy candles independently from later chart mutations", () => {
        const candles = buildCandles();
        setCurrentUiBacktestEndpointCandles(candles);

        candles[0]!.close = 999;
        const stored = getCurrentUiBacktestEndpointCandles();

        assert.ok(stored);
        assert.strictEqual(stored[0]!.close, 100.5);

        clearCurrentUiBacktestEndpointSnapshot();
        assert.strictEqual(getCurrentUiBacktestEndpointCandles(), null);
    });

    it("detects whether the UI capital settings already match the endpoint profile", () => {
        assert.strictEqual(matchesEndpointCapitalProfile({ ...BACKTEST_ENDPOINT_CAPITAL_SETTINGS }), true);
        assert.strictEqual(matchesEndpointCapitalProfile({
            ...BACKTEST_ENDPOINT_CAPITAL_SETTINGS,
            fixedTradeAmount: 500,
        }), false);
    });

    it("auto-enables polymarket annotation for supported endpoint copy runs", () => {
        const supportedSnapshot = buildSnapshot("typescript");
        const unsupportedSnapshot = {
            ...supportedSnapshot,
            symbol: "ADAUSDT",
        } satisfies UiBacktestEndpointSnapshot;

        assert.strictEqual(resolveEndpointPolymarketAnnotation(supportedSnapshot), true);
        assert.strictEqual(resolveEndpointPolymarketAnnotation(unsupportedSnapshot), false);
    });
});
