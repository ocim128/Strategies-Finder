import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { loadSqliteCandles, resetLocalSqliteApiAvailabilityForTests, storeSqliteCandles } from "../lib/local-sqlite-api";
import type { OHLCVData } from "../lib/types";

const originalFetch = globalThis.fetch;

type FetchCall = {
    url: string;
    init?: RequestInit;
};

function makeBinaryCandles(rows: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>): ArrayBuffer {
    const headerBytes = 16;
    const fieldCount = 6;
    const rowCount = rows.length;
    const buffer = new ArrayBuffer(headerBytes + fieldCount * rowCount * Float64Array.BYTES_PER_ELEMENT);
    const view = new DataView(buffer);
    const columnBytes = rowCount * Float64Array.BYTES_PER_ELEMENT;

    view.setUint32(0, 0x4F484C56, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, rowCount, true);
    view.setUint32(12, fieldCount, true);

    rows.forEach((row, index) => {
        const offset = headerBytes + index * Float64Array.BYTES_PER_ELEMENT;
        view.setFloat64(offset, row.time, true);
        view.setFloat64(offset + columnBytes, row.open, true);
        view.setFloat64(offset + 2 * columnBytes, row.high, true);
        view.setFloat64(offset + 3 * columnBytes, row.low, true);
        view.setFloat64(offset + 4 * columnBytes, row.close, true);
        view.setFloat64(offset + 5 * columnBytes, row.volume, true);
    });

    return buffer;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, calls: FetchCall[]): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init });
        if (url.includes("/api/sqlite/status")) {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        return handler(url, init);
    }) as typeof fetch;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetLocalSqliteApiAvailabilityForTests();
});

describe("local sqlite api binary transport", () => {
    it("loads valid binary OHLCV payloads", async () => {
        const calls: FetchCall[] = [];
        installFetch(() => new Response(makeBinaryCandles([
            { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
            { time: 200, open: 2, high: 3, low: 1.5, close: 2.5, volume: 20 },
        ]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
        }), calls);

        const result = await loadSqliteCandles("ethusdt", "1m", 50);

        assert.equal(result?.trusted, true);
        assert.deepEqual(result?.candles.map((candle) => candle.time), [100, 200]);
        assert.equal(result?.candles[1].close, 2.5);
        assert.ok(calls.some((call) => call.url.includes("/api/sqlite/load-ohlcv") && String((call.init?.headers as Record<string, string>)?.Accept).includes("application/octet-stream")));
    });

    it("falls back to JSON when a binary payload fails validation", async () => {
        const calls: FetchCall[] = [];
        installFetch((url, init) => {
            const accept = String((init?.headers as Record<string, string>)?.Accept ?? "");
            if (url.includes("/api/sqlite/load-ohlcv") && accept.includes("application/octet-stream")) {
                return new Response(new ArrayBuffer(4), {
                    status: 200,
                    headers: { "content-type": "application/octet-stream" },
                });
            }
            return new Response(JSON.stringify({
                ok: true,
                candles: [
                    { time: 300, open: 3, high: 4, low: 2, close: 3.5, volume: 30 },
                ],
            }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }, calls);

        const result = await loadSqliteCandles("ethusdt", "1m", 50);

        assert.deepEqual(result?.candles.map((candle) => candle.time), [300]);
        assert.equal(calls.filter((call) => call.url.includes("/api/sqlite/load-ohlcv")).length, 2);
    });

    it("uses binary uploads for large candle stores", async () => {
        const calls: FetchCall[] = [];
        installFetch(() => new Response(JSON.stringify({ ok: true, upserted: 1024 }), {
            status: 200,
            headers: { "content-type": "application/json" },
        }), calls);
        const candles: OHLCVData[] = Array.from({ length: 1024 }, (_, index) => ({
            time: (1_700_000_000 + index) as OHLCVData["time"],
            open: index,
            high: index + 1,
            low: index - 1,
            close: index + 0.5,
            volume: index * 10,
        }));

        const result = await storeSqliteCandles("ethusdt", "1m", candles, "Binance", "test");
        const storeCall = calls.find((call) => call.url.includes("/api/sqlite/store-ohlcv"));

        assert.equal(result?.ok, true);
        assert.ok(storeCall?.url.includes("symbol=ETHUSDT"));
        assert.equal(new URL(storeCall!.url, "http://localhost").searchParams.get("summary"), null);
        assert.equal((storeCall?.init?.headers as Record<string, string>)?.["Content-Type"], "application/octet-stream");
        assert.ok(storeCall?.init?.body instanceof ArrayBuffer);
    });

    it("requests store summaries only when explicitly requested", async () => {
        const calls: FetchCall[] = [];
        installFetch(() => new Response(JSON.stringify({ ok: true, upserted: 2, totalBars: 10 }), {
            status: 200,
            headers: { "content-type": "application/json" },
        }), calls);
        const candles: OHLCVData[] = [
            { time: 1_700_000_000 as OHLCVData["time"], open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
            { time: 1_700_000_060 as OHLCVData["time"], open: 2, high: 3, low: 1.5, close: 2.5, volume: 20 },
        ];

        await storeSqliteCandles("ethusdt", "1m", candles, "Binance", "test", { summary: true });
        const storeCall = calls.find((call) => call.url.includes("/api/sqlite/store-ohlcv"));
        const body = JSON.parse(String(storeCall?.init?.body ?? "{}")) as { summary?: boolean };

        assert.equal(body.summary, true);
    });

    it("falls back to JSON uploads when binary store response is not JSON", async () => {
        const calls: FetchCall[] = [];
        installFetch((_url, init) => {
            const contentType = String((init?.headers as Record<string, string>)?.["Content-Type"] ?? "");
            if (contentType.includes("application/octet-stream")) {
                return new Response("unsupported", { status: 415 });
            }
            return new Response(JSON.stringify({ ok: true, upserted: 1024 }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }, calls);
        const candles: OHLCVData[] = Array.from({ length: 1024 }, (_, index) => ({
            time: (1_700_000_000 + index) as OHLCVData["time"],
            open: index,
            high: index + 1,
            low: index - 1,
            close: index + 0.5,
            volume: index * 10,
        }));

        const result = await storeSqliteCandles("ethusdt", "1m", candles, "Binance", "test");
        const storeCalls = calls.filter((call) => call.url.includes("/api/sqlite/store-ohlcv"));

        assert.equal(result?.ok, true);
        assert.equal(storeCalls.length, 2);
        assert.equal((storeCalls[0].init?.headers as Record<string, string>)?.["Content-Type"], "application/octet-stream");
        assert.equal((storeCalls[1].init?.headers as Record<string, string>)?.["Content-Type"], "application/json");
    });

    it("coalesces concurrent status probes before loading candles", async () => {
        const calls: FetchCall[] = [];
        let resolveStatus!: (response: Response) => void;
        const statusResponse = new Promise<Response>((resolve) => {
            resolveStatus = resolve;
        });

        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            calls.push({ url, init });
            if (url.includes("/api/sqlite/status")) {
                return await statusResponse;
            }
            return new Response(JSON.stringify({
                ok: true,
                candles: [
                    { time: 300, open: 3, high: 4, low: 2, close: 3.5, volume: 30 },
                ],
            }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        const first = loadSqliteCandles("ethusdt", "1m", 50);
        const second = loadSqliteCandles("btcusdt", "1m", 50);
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(calls.filter((call) => call.url.includes("/api/sqlite/status")).length, 1);

        resolveStatus(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
        }));

        const [firstResult, secondResult] = await Promise.all([first, second]);

        assert.equal(firstResult?.trusted, true);
        assert.equal(secondResult?.trusted, true);
        assert.equal(calls.filter((call) => call.url.includes("/api/sqlite/status")).length, 1);
        assert.equal(calls.filter((call) => call.url.includes("/api/sqlite/load-ohlcv")).length, 2);
    });
});
