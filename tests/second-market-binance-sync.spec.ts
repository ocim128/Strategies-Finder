import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import {
    loadSecondDataSyncState,
    openSecondMarketDb,
    upsertBinance1sCandles,
    writeSecondDataSyncState,
} from "../lib/second-market/db";
import { loadBinance1sCandles } from "../lib/second-market/loaders";
import { fetchBinance1sCandles, syncBinance1sRange } from "../lib/second-market/binance-1s-sync";
import { getBinanceLiveWebSocketStreamName, runLiveBinanceWebSocket } from "../scripts/second-market-miner";

const ORIGINAL_FETCH = globalThis.fetch;
let tempDirs: string[] = [];

function makeDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "second-market-binance-sync-"));
    tempDirs.push(dir);
    return join(dir, "second-market-data.sqlite");
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
});

describe("second market Binance 1s sync", () => {
    it("uses the trade websocket stream for futures live mining", () => {
        expect(getBinanceLiveWebSocketStreamName("BTCUSDT", "futures")).to.equal("btcusdt@trade");
        expect(getBinanceLiveWebSocketStreamName("BTCUSDT", "spot")).to.equal("btcusdt@aggTrade");
    });

    it("flushes websocket-built candles as soon as a next-second trade arrives", async () => {
        const originalWebSocket = globalThis.WebSocket;
        const db = openSecondMarketDb(makeDbPath());
        const controller = new AbortController();
        let runPromise: Promise<void> | null = null;

        class FakeBinanceWebSocket {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSED = 3;

            readyState = FakeBinanceWebSocket.CONNECTING;
            onopen: ((event: Event) => void) | null = null;
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: Event) => void) | null = null;
            onclose: ((event: CloseEvent) => void) | null = null;

            constructor(_url: string) {
                queueMicrotask(() => {
                    this.readyState = FakeBinanceWebSocket.OPEN;
                    this.onopen?.({} as Event);
                });
                sockets.push(this);
            }

            close(): void {
                this.readyState = FakeBinanceWebSocket.CLOSED;
            }

            emitTrade(trade: Record<string, unknown>): void {
                this.onmessage?.({ data: JSON.stringify({ data: trade }) } as MessageEvent);
            }
        }

        const sockets: FakeBinanceWebSocket[] = [];
        (globalThis as { WebSocket: unknown }).WebSocket = FakeBinanceWebSocket;

        try {
            runPromise = runLiveBinanceWebSocket({
                mode: "live",
                symbols: ["BTCUSDT"],
                marketType: "futures",
                outcomeInterval: "5m",
                startTs: 0,
                endTs: 0,
                durationSec: null,
                includeBinance: true,
                includeClob: false,
                includeReference: false,
                includeGamma: false,
                referenceSources: ["crypto_prices"],
                requestDelayMs: 0,
            }, db, controller.signal, undefined);

            await new Promise((resolve) => setTimeout(resolve, 0));
            const socket = sockets[0];
            expect(socket).to.not.equal(undefined);

            socket.emitTrade({ s: "BTCUSDT", T: 1_700_000_000_100, p: "100", q: "1", f: 100, l: 100 });
            expect(loadBinance1sCandles(db, {
                symbol: "BTCUSDT",
                marketType: "futures",
                startTs: 1_700_000_000,
                endTs: 1_700_000_000,
            })).to.have.length(0);

            socket.emitTrade({ s: "BTCUSDT", T: 1_700_000_001_050, p: "101", q: "2", f: 101, l: 102 });
            const rows = loadBinance1sCandles(db, {
                symbol: "BTCUSDT",
                marketType: "futures",
                startTs: 1_700_000_000,
                endTs: 1_700_000_000,
            });

            expect(rows).to.have.length(1);
            expect(rows[0]).to.include({
                ts: 1_700_000_000,
                close: 100,
                source: "binance_1s_ws",
            });
        } finally {
            controller.abort();
            await runPromise?.catch(() => undefined);
            db.close();
            globalThis.WebSocket = originalWebSocket;
        }
    });

    it("builds futures 1s candles from aggregate trades", async () => {
        const requestedUrls: string[] = [];
        const progressEvents: Array<{ fetched: number; cursorTs: number; requestCount: number }> = [];
        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url
            );
            requestedUrls.push(url.toString());
            expect(url.pathname).to.equal("/fapi/v1/aggTrades");
            expect(url.searchParams.get("symbol")).to.equal("BTCUSDT");
            return new Response(JSON.stringify([
                { a: 10, p: "100", q: "1.5", f: 100, l: 101, T: 1_700_000_000_100 },
                { a: 11, p: "102", q: "2", f: 102, l: 102, T: 1_700_000_002_250 },
                { a: 12, p: "101", q: "0.5", f: 103, l: 103, T: 1_700_000_002_500 },
                { a: 13, p: "103", q: "0.25", f: 104, l: 104, T: 1_700_000_002_750 },
            ]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        const rows = await fetchBinance1sCandles({
            symbol: "BTCUSDT",
            marketType: "futures",
            startTs: 1_700_000_000,
            endTs: 1_700_000_002,
            onProgress: (progress) => progressEvents.push(progress),
        });

        expect(requestedUrls).to.have.length(1);
        expect(progressEvents.map((progress) => progress.fetched)).to.deep.equal([3]);
        expect(rows).to.have.length(3);
        expect(rows.map((row) => row.ts)).to.deep.equal([1_700_000_000, 1_700_000_001, 1_700_000_002]);
        expect(rows[0]).to.include({
            market_type: "futures",
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            volume: 1.5,
            trade_count: 2,
        });
        expect(rows[1]).to.include({
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            volume: 0,
            trade_count: 0,
            source: "binance_1s_fill",
        });
        expect(rows[2]).to.include({
            open: 102,
            high: 103,
            low: 101,
            close: 103,
            volume: 2.75,
            trade_count: 3,
        });
    });

    it("keeps the conservative two-second REST cap unless live callers opt in", async () => {
        const originalNow = Date.now;
        const nowSec = 2_100_000_000;
        let fetchCount = 0;
        Date.now = () => nowSec * 1000;
        globalThis.fetch = (async () => {
            fetchCount += 1;
            return new Response(JSON.stringify([
                { a: 10, p: "100", q: "1", f: 100, l: 100, T: (nowSec - 1) * 1000 + 100 },
            ]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const defaultRows = await fetchBinance1sCandles({
                symbol: "BTCUSDT",
                marketType: "futures",
                startTs: nowSec - 1,
                endTs: nowSec - 1,
            });
            const liveRows = await fetchBinance1sCandles({
                symbol: "BTCUSDT",
                marketType: "futures",
                startTs: nowSec - 1,
                endTs: nowSec - 1,
                closedLagSec: 1,
            });

            expect(defaultRows).to.deep.equal([]);
            expect(liveRows.map((row) => row.ts)).to.deep.equal([nowSec - 1]);
            expect(fetchCount).to.equal(1);
        } finally {
            Date.now = originalNow;
        }
    });

    it("does not fill futures candles past the latest aggregate trade", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify([
            { a: 10, p: "100", q: "1", f: 100, l: 100, T: 1_700_000_000_100 },
            { a: 11, p: "102", q: "2", f: 101, l: 101, T: 1_700_000_002_250 },
        ]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

        const rows = await fetchBinance1sCandles({
            symbol: "BTCUSDT",
            marketType: "futures",
            startTs: 1_700_000_000,
            endTs: 1_700_000_005,
        });

        expect(rows.map((row) => row.ts)).to.deep.equal([
            1_700_000_000,
            1_700_000_001,
            1_700_000_002,
        ]);
        expect(rows.map((row) => row.source)).to.deep.equal([
            "binance_1s",
            "binance_1s_fill",
            "binance_1s",
        ]);
    });

    it("preserves the cursor when a too-recent futures fetch returns no rows", async () => {
        const db = openSecondMarketDb(makeDbPath());
        const cursorTs = Math.floor(Date.now() / 1000) - 30;
        try {
            writeSecondDataSyncState(db, {
                source: "binance_1s",
                symbol: "BTCUSDT",
                series_id: "futures",
                cursor_ts: cursorTs,
                cursor_id: "",
                status: "ok",
                updated_at: cursorTs,
            });
            globalThis.fetch = (async () => new Response("[]", {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })) as typeof fetch;

            const endTs = Math.floor(Date.now() / 1000) - 2;
            const summary = await syncBinance1sRange(db, {
                symbol: "BTCUSDT",
                marketType: "futures",
                startTs: endTs - 2,
                endTs,
            });

            const state = loadSecondDataSyncState(db, "binance_1s", "BTCUSDT", "futures");
            expect(summary.fetched).to.equal(0);
            expect(summary.lastTs).to.equal(null);
            expect(state?.cursor_ts).to.equal(cursorTs);
        } finally {
            db.close();
        }
    });

    it("skips Binance REST when the requested 1s range is already covered locally", async () => {
        const db = openSecondMarketDb(makeDbPath());
        try {
            upsertBinance1sCandles(db, [1_700_000_000, 1_700_000_001, 1_700_000_002].map((ts, index) => ({
                symbol: "BTCUSDT",
                market_type: "spot",
                ts,
                open: 100 + index,
                high: 101 + index,
                low: 99 + index,
                close: 100.5 + index,
                volume: 10,
                trade_count: 1,
                source: "binance_1s",
                updated_at: 1_700_000_010,
            })));
            globalThis.fetch = (async () => {
                throw new Error("Binance should not be fetched for a fully covered range");
            }) as typeof fetch;

            const summary = await syncBinance1sRange(db, {
                symbol: "BTCUSDT",
                marketType: "spot",
                startTs: 1_700_000_000,
                endTs: 1_700_000_002,
            });
            const state = loadSecondDataSyncState(db, "binance_1s", "BTCUSDT", "spot");

            expect(summary).to.include({
                fetched: 0,
                upserted: 0,
                firstTs: 1_700_000_000,
                lastTs: 1_700_000_002,
            });
            expect(state?.cursor_ts).to.equal(1_700_000_002);
        } finally {
            db.close();
        }
    });
});
