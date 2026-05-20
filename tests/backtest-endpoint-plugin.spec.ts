import assert from "node:assert";
import { describe, it } from "node:test";
import { Readable } from "node:stream";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { backtestEndpointPlugin } from "../lib/backtest-endpoint-plugin";
import { strategyManifest } from "../lib/strategies/manifest-eager";

const defaultStrategyEntry = strategyManifest.find((entry) => !entry.strategy.crossSymbolConfig);
assert.ok(defaultStrategyEntry, "Expected at least one non-cross-symbol strategy in manifest");
const defaultStrategyKey = defaultStrategyEntry!.key;
const defaultStrategyParams = { ...defaultStrategyEntry!.strategy.defaultParams };
const randomizableStrategyEntry = strategyManifest.find((entry) =>
    !entry.strategy.crossSymbolConfig
    && Object.values(entry.strategy.defaultParams ?? {}).some((value) => typeof value === "number" && value !== 0)
);
assert.ok(randomizableStrategyEntry, "Expected at least one non-cross-symbol strategy with numeric defaults");
const randomizableStrategyKey = randomizableStrategyEntry!.key;
const randomizableStrategyParams = { ...randomizableStrategyEntry!.strategy.defaultParams };

type MockRequest = NodeJS.ReadableStream & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
};

type MockHandler = (req: MockRequest, res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
}) => void | Promise<void>;

function createHandler(): MockHandler {
    let handler: MockHandler | null = null;
    const plugin = backtestEndpointPlugin();
    plugin.configurePreviewServer?.({
        middlewares: {
            use(prefix: string, registered: MockHandler) {
                if (prefix === "/api/backtest") {
                    handler = registered;
                }
            },
        },
    } as never);

    assert.ok(handler, "Expected backtest endpoint middleware to register");
    return handler;
}

function makeRequest(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
    const payload = body === undefined ? [] : [JSON.stringify(body)];
    const request = Readable.from(payload) as MockRequest;
    request.method = method;
    request.url = path;
    request.headers = headers;
    return request;
}

async function invoke(
    handler: MockHandler,
    path: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>
): Promise<{
    statusCode: number;
    json: any;
}> {
    return await new Promise((resolve, reject) => {
        const responseHeaders = new Map<string, string>();
        const response = {
            statusCode: 200,
            setHeader(name: string, value: string) {
                responseHeaders.set(name, value);
            },
            end(rawBody?: string) {
                try {
                    resolve({
                        statusCode: response.statusCode,
                        json: rawBody ? JSON.parse(rawBody) : null,
                    });
                } catch (error) {
                    reject(error);
                }
            },
        };

        Promise.resolve(handler(makeRequest(path, method, body, headers), response)).catch(reject);
    });
}

function buildCandles(count = 240): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: (1700000000 + index * 300) as Time,
        open: 100 + Math.sin(index * 0.1) * 2,
        high: 101 + Math.sin(index * 0.1) * 2,
        low: 99 + Math.sin(index * 0.1) * 2,
        close: 100 + Math.sin(index * 0.1) * 2 + (index % 5) * 0.05,
        volume: 1000 + index,
    }));
}

function buildSinglePayload(
    dataset: { candles: OHLCVData[] } | { ref: string },
    strategyParams = defaultStrategyParams
) {
    const candles = "candles" in dataset ? dataset.candles : buildCandles();
    const lastTime = Number(candles[candles.length - 1]?.time ?? 0);

    return {
        symbol: "BTCUSDT",
        interval: "5m",
        dataset,
        strategyParams,
        backtestSettings: {
            executionModel: "next_open",
            tradeDirection: "short",
            allowSameBarExit: true,
            slippageBps: 0,
            marketMode: "all",
        },
        context: {
            nowSec: lastTime + 600,
            blockRange: null,
            annotatePolymarket: false,
            engineMode: "typescript",
        },
    };
}

describe("backtest endpoint plugin", () => {
    it("serves health from mounted middleware paths", async () => {
        const handler = createHandler();
        const response = await invoke(handler, "/health", "GET");

        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(response.json.ok, true);
        assert.ok(response.json.manifest.strategyCount > 0);
        assert.ok(typeof response.json.manifest.hash === "string");
        assert.ok(!("strategyKeys" in response.json.manifest));
    });

    it("accepts inline candle datasets for single-run backtests", async () => {
        const handler = createHandler();
        const candles = buildCandles();
        const response = await invoke(
            handler,
            `/${defaultStrategyKey}`,
            "POST",
            buildSinglePayload({ candles })
        );

        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(response.json.ok, true);
        assert.strictEqual(response.json.strategyKey, defaultStrategyKey);
        assert.ok(typeof response.json.requestFingerprint === "string");
        assert.ok(response.json.result.marketContext.candleCount > 0);
        assert.ok(!("trades" in response.json.result));
        assert.ok(!("equityCurve" in response.json.result));
        assert.ok(!("strategyKeys" in response.json.strategyManifestFingerprint));
    });

    it("fingerprints randomized single-run requests by effective strategy params", async () => {
        const handler = createHandler();
        const candles = buildCandles();
        const payload = buildSinglePayload({ candles }, randomizableStrategyParams);

        const first = await invoke(
            handler,
            `/${randomizableStrategyKey}`,
            "POST",
            payload,
            { "random-parameter-range": "25", "random-seed": "10" }
        );
        const second = await invoke(
            handler,
            `/${randomizableStrategyKey}`,
            "POST",
            payload,
            { "random-parameter-range": "25", "random-seed": "11" }
        );

        assert.strictEqual(first.statusCode, 200);
        assert.strictEqual(second.statusCode, 200);
        assert.strictEqual(first.json.randomSeed, 10);
        assert.strictEqual(second.json.randomSeed, 11);
        assert.notDeepStrictEqual(first.json.strategyParams, second.json.strategyParams);
        assert.notStrictEqual(first.json.requestFingerprint, second.json.requestFingerprint);
    });

    it("supports cached dataset refs for single-run backtests", async () => {
        const handler = createHandler();
        const candles = buildCandles();
        const upload = await invoke(handler, "/datasets", "POST", { candles });

        assert.strictEqual(upload.statusCode, 200);
        assert.strictEqual(upload.json.ok, true);
        assert.ok(typeof upload.json.datasetRef === "string");

        const response = await invoke(
            handler,
            `/${defaultStrategyKey}`,
            "POST",
            buildSinglePayload({ ref: upload.json.datasetRef })
        );

        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(response.json.ok, true);
        assert.strictEqual(response.json.strategyKey, defaultStrategyKey);
        assert.ok(response.json.result.totalTrades >= 0);
    });

    it("ignores caller-supplied capital settings and uses the fixed endpoint profile", async () => {
        const handler = createHandler();
        const candles = buildCandles();
        const payload = buildSinglePayload({ candles });

        const baseline = await invoke(
            handler,
            `/${defaultStrategyKey}`,
            "POST",
            payload
        );

        const legacyCapitalPayload = {
            ...payload,
            capitalSettings: {
                initialCapital: 500,
                positionSize: 5,
                commission: 4,
                sizingMode: "percent",
                fixedTradeAmount: 25,
            },
        };

        const withIgnoredCapital = await invoke(
            handler,
            `/${defaultStrategyKey}`,
            "POST",
            legacyCapitalPayload
        );

        assert.strictEqual(baseline.statusCode, 200);
        assert.strictEqual(withIgnoredCapital.statusCode, 200);
        assert.strictEqual(baseline.json.ok, true);
        assert.strictEqual(withIgnoredCapital.json.ok, true);
        assert.strictEqual(withIgnoredCapital.json.requestFingerprint, baseline.json.requestFingerprint);
        assert.strictEqual(withIgnoredCapital.json.result.totalTrades, baseline.json.result.totalTrades);
        assert.strictEqual(withIgnoredCapital.json.result.netProfit, baseline.json.result.netProfit);
    });

    it("runs a cross-symbol endpoint request when the secondary dataset is provided", async () => {
        const handler = createHandler();
        const candles = buildCandles();
        const secondaryCandles: OHLCVData[] = candles.map((candle, index) => ({
            ...candle,
            close: candle.close * (1 + Math.sin(index * 0.18) * 0.08),
            open: candle.open * (1 + Math.sin(index * 0.18) * 0.08),
            high: candle.high * (1 + Math.sin(index * 0.18) * 0.08),
            low: candle.low * (1 + Math.sin(index * 0.18) * 0.08),
        }));

        const response = await invoke(
            handler,
            "/relative_strength_mean_reversion",
            "POST",
            {
                symbol: "XRPUSDT",
                interval: "5m",
                dataset: { candles },
                strategyParams: {
                    lookback: 30,
                    zThreshold: 0.5,
                },
                backtestSettings: {
                    executionModel: "next_open",
                    tradeDirection: "both",
                    marketMode: "all",
                    crossSymbolSecondary: "DOGEUSDT",
                },
                crossSymbol: {
                    secondarySymbol: "DOGEUSDT",
                    dataset: { candles: secondaryCandles },
                },
                context: {
                    nowSec: Number(candles[candles.length - 1]?.time ?? 0) + 600,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "typescript",
                },
            }
        );

        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(response.json.ok, true);
        assert.strictEqual(response.json.strategyKey, "relative_strength_mean_reversion");
        assert.ok(response.json.result.totalTrades >= 0);
    });

    it("hashes full uploaded datasets instead of sampled candles only", async () => {
        const handler = createHandler();
        const candles = buildCandles(2048);
        const changed = candles.map((candle) => ({ ...candle }));
        changed[1] = { ...changed[1], close: changed[1].close + 25 };

        const left = await invoke(handler, "/datasets", "POST", { candles });
        const right = await invoke(handler, "/datasets", "POST", { candles: changed });

        assert.strictEqual(left.statusCode, 200);
        assert.strictEqual(right.statusCode, 200);
        assert.notStrictEqual(left.json.hash, right.json.hash);
        assert.notStrictEqual(left.json.datasetRef, right.json.datasetRef);
    });

    it("rejects reused dataset key hints with different candle content", async () => {
        const handler = createHandler();
        const candles = buildCandles();
        const changed = candles.map((candle) => ({ ...candle }));
        changed[1] = { ...changed[1], close: changed[1].close + 25 };

        const first = await invoke(handler, "/datasets", "POST", { candles, keyHint: "shared_ref" });
        const second = await invoke(handler, "/datasets", "POST", { candles: changed, keyHint: "shared_ref" });

        assert.strictEqual(first.statusCode, 200);
        assert.strictEqual(second.statusCode, 409);
        assert.strictEqual(second.json.ok, false);
        assert.strictEqual(second.json.code, "DATASET_REF_CONFLICT");
    });

    it("rejects cross-symbol endpoint requests that omit the secondary dataset", async () => {
        const handler = createHandler();
        const candles = buildCandles();

        const response = await invoke(
            handler,
            "/relative_strength_mean_reversion",
            "POST",
            {
                symbol: "XRPUSDT",
                interval: "5m",
                dataset: { candles },
                strategyParams: {
                    lookback: 30,
                    zThreshold: 0.5,
                },
                backtestSettings: {
                    executionModel: "next_open",
                    tradeDirection: "both",
                    marketMode: "all",
                    crossSymbolSecondary: "DOGEUSDT",
                },
                context: {
                    nowSec: Number(candles[candles.length - 1]?.time ?? 0) + 600,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "typescript",
                },
            }
        );

        assert.strictEqual(response.statusCode, 400);
        assert.strictEqual(response.json.ok, false);
        assert.match(String(response.json.error ?? ""), /crossSymbol/i);
    });

    it("reports random-search execution failures instead of silently hiding them", async () => {
        const handler = createHandler();
        const candles = buildCandles();

        const response = await invoke(
            handler,
            "/__missing_strategy__/search/random",
            "POST",
            {
                symbol: "BTCUSDT",
                interval: "5m",
                dataset: { candles },
                baseParams: { lookback: 20 },
                randomization: {
                    rangePercent: 10,
                    count: 2,
                    seed: 42,
                },
                backtestSettings: {
                    executionModel: "next_open",
                    tradeDirection: "long",
                },
                context: {
                    nowSec: Number(candles[candles.length - 1]?.time ?? 0) + 600,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "typescript",
                },
                compact: true,
            }
        );

        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(response.json.ok, true);
        assert.strictEqual(response.json.processed, 2);
        assert.strictEqual(response.json.evaluated, 0);
        assert.strictEqual(response.json.failed, 2);
        assert.strictEqual(response.json.seed, 42);
        assert.equal(response.json.failureSamples.length, 2);
        assert.match(String(response.json.failureSamples[0].error), /not found|unknown|missing/i);
    });
});
