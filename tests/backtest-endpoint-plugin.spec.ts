import assert from "node:assert";
import { describe, it } from "node:test";
import { Readable } from "node:stream";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { backtestEndpointPlugin } from "../lib/backtest-endpoint-plugin";
import { strategyManifest } from "../lib/strategies/manifest";

const defaultStrategyEntry = strategyManifest.find((entry) => !entry.strategy.crossSymbolConfig);
assert.ok(defaultStrategyEntry, "Expected at least one non-cross-symbol strategy in manifest");
const defaultStrategyKey = defaultStrategyEntry!.key;
const defaultStrategyParams = { ...defaultStrategyEntry!.strategy.defaultParams };

type MockHandler = (req: NodeJS.ReadableStream & { method?: string; url?: string }, res: {
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

function makeRequest(path: string, method: string, body?: unknown) {
    const payload = body === undefined ? [] : [JSON.stringify(body)];
    const request = Readable.from(payload) as NodeJS.ReadableStream & { method?: string; url?: string };
    request.method = method;
    request.url = path;
    return request;
}

async function invoke(handler: MockHandler, path: string, method: string, body?: unknown): Promise<{
    statusCode: number;
    json: any;
}> {
    return await new Promise((resolve, reject) => {
        const headers = new Map<string, string>();
        const response = {
            statusCode: 200,
            setHeader(name: string, value: string) {
                headers.set(name, value);
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

        Promise.resolve(handler(makeRequest(path, method, body), response)).catch(reject);
    });
}

function buildCandles(): OHLCVData[] {
    return Array.from({ length: 240 }, (_, index) => ({
        time: (1700000000 + index * 300) as Time,
        open: 100 + Math.sin(index * 0.1) * 2,
        high: 101 + Math.sin(index * 0.1) * 2,
        low: 99 + Math.sin(index * 0.1) * 2,
        close: 100 + Math.sin(index * 0.1) * 2 + (index % 5) * 0.05,
        volume: 1000 + index,
    }));
}

function buildSinglePayload(dataset: { candles: OHLCVData[] } | { ref: string }) {
    const candles = "candles" in dataset ? dataset.candles : buildCandles();
    const lastTime = Number(candles[candles.length - 1]?.time ?? 0);

    return {
        symbol: "BTCUSDT",
        interval: "5m",
        dataset,
        strategyParams: defaultStrategyParams,
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
});
