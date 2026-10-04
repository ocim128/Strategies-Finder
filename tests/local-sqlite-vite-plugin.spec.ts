import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { isTrustedLocalRequest, localSqlitePlugin, __testInternals } from "../lib/local-sqlite-vite-plugin";
import { encodeBinaryOhlcvRows } from "../lib/ohlcv-binary";

const originalToken = process.env.LOCAL_PROXY_TOKEN;
afterEach(() => {
    if (originalToken === undefined) delete process.env.LOCAL_PROXY_TOKEN;
    else process.env.LOCAL_PROXY_TOKEN = originalToken;
});

describe("SQLite metadata invalidation", () => {
    let db: DatabaseSync;
    let handler: (req: unknown, res: unknown) => Promise<void>;
    const candle = (time: number, close = 1) => ({ time, open: 1, high: 2, low: 0.5, close, volume: 1 });

    beforeEach(() => {
        db = new DatabaseSync(":memory:");
        db.exec(`
            CREATE TABLE candles (
                symbol TEXT, interval TEXT, time INTEGER, open REAL, high REAL,
                low REAL, close REAL, volume REAL, provider TEXT, source TEXT,
                updated_at INTEGER, PRIMARY KEY(symbol, interval, time)
            );
            CREATE TABLE series_meta (
                symbol TEXT, interval TEXT, provider TEXT, bars_count INTEGER,
                first_time INTEGER, last_time INTEGER, updated_at INTEGER,
                PRIMARY KEY(symbol, interval)
            );
        `);
        __testInternals.setSqliteDbForTests(db);
        const configure = localSqlitePlugin().configureServer as (server: unknown) => void;
        configure({ middlewares: { use: (_path: string, registered: typeof handler) => { handler = registered; } } });
    });

    afterEach(() => {
        __testInternals.resetSqliteDbForTests();
        db.close();
    });

    async function request(method: string, url: string, body?: Record<string, unknown> | Buffer) {
        const req = Readable.from(body ? [Buffer.isBuffer(body) ? body : JSON.stringify(body)] : []);
        Object.assign(req, {
            method, url, socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "localhost:5173", "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" },
        });
        let text = "";
        const res = { statusCode: 0, setHeader: () => {}, end: (value: string) => { text = value; } };
        await handler(req, res);
        return { status: res.statusCode, body: JSON.parse(text) as Record<string, unknown> };
    }

    for (const format of ["json", "binary"] as const) {
        it(`rebuilds metadata after a default ${format} append and preserves other series`, async () => {
            for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
                assert.equal((await request("POST", "/store-ohlcv", { symbol, interval: "1h", summary: true, candles: [candle(1700000000)] })).status, 200);
            }
            const before = await request("GET", "/series-meta?symbol=BTCUSDT&interval=1h");
            const append = [candle(1700003600)];
            const written = format === "json"
                ? await request("POST", "/store-ohlcv", { symbol: "BTCUSDT", interval: "1h", candles: append })
                : await request("POST", "/store-ohlcv?symbol=BTCUSDT&interval=1h", Buffer.from(encodeBinaryOhlcvRows(append)));
            assert.equal(written.status, 200);
            assert.equal(written.body.totalBars, undefined);
            assert.equal(db.prepare("SELECT * FROM series_meta WHERE symbol = 'BTCUSDT'").get(), undefined);
            assert.ok(db.prepare("SELECT * FROM series_meta WHERE symbol = 'ETHUSDT'").get());
            const after = await request("GET", "/series-meta?symbol=BTCUSDT&interval=1h");
            assert.equal(before.body.barsCount, 1);
            assert.equal(after.body.barsCount, 2);
            assert.equal(after.body.firstTime, 1700000000);
            assert.equal(after.body.lastTime, 1700003600);
        });
    }

    it("refreshes metadata after historical overwrites without changing count or endpoint", async t => {
        t.mock.timers.enable({ apis: ["Date"], now: 1701000000000 });
        await request("POST", "/store-ohlcv", { symbol: "BTCUSDT", interval: "1h", summary: true, candles: [candle(1700000000)] });
        const before = await request("GET", "/series-meta?symbol=BTCUSDT&interval=1h");
        t.mock.timers.tick(1000);
        await request("POST", "/store-ohlcv", { symbol: "BTCUSDT", interval: "1h", candles: [candle(1700000000, 1.5)] });
        const after = await request("GET", "/series-meta?symbol=BTCUSDT&interval=1h");
        assert.equal(after.body.barsCount, before.body.barsCount);
        assert.equal(after.body.lastTime, before.body.lastTime);
        assert.ok(Number(after.body.updatedAt) > Number(before.body.updatedAt));
        assert.equal(db.prepare("SELECT close FROM candles").get()?.close, 1.5);
    });

    it("rolls back candle writes when metadata invalidation fails", async () => {
        await request("POST", "/store-ohlcv", { symbol: "BTCUSDT", interval: "1h", summary: true, candles: [candle(1700000000)] });
        db.exec("CREATE TRIGGER reject_invalidation AFTER DELETE ON series_meta BEGIN SELECT RAISE(ABORT, 'forced metadata failure'); END;");
        const result = await request("POST", "/store-ohlcv", { symbol: "BTCUSDT", interval: "1h", candles: [candle(1700003600)] });
        assert.equal(result.status, 500);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candles").get()?.count, 1);
        assert.equal(db.prepare("SELECT bars_count FROM series_meta").get()?.bars_count, 1);
    });
});

describe("local sqlite vite plugin", () => {
    it("rejects requests without local origin or referer headers", () => {
        assert.equal(isTrustedLocalRequest({ headers: {} }), false);
    });

    it("allows localhost origin requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "localhost:5173", origin: "http://localhost:5173" },
        }), true);
    });

    it("allows localhost referer requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173", referer: "http://127.0.0.1:5173/chart" },
        }), true);
    });

    it("rejects forged local headers and deceptive hostnames", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        for (const origin of ["http://localhost:5173", "http://localhost.attacker.invalid:5173"]) {
            assert.equal(isTrustedLocalRequest({
                socket: { remoteAddress: "192.0.2.1" },
                headers: { host: "localhost:5173", origin },
            }), false);
        }
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "localhost:5173", origin: "http://localhost.attacker.invalid:5173" },
        }), false);
    });

    it("allows local internal calls without Origin and authenticated tunnel callers", () => {
        process.env.LOCAL_PROXY_TOKEN = "sqlite-test-token";
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "::1" }, headers: { host: "[::1]:5173" },
        }), true);
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "tunnel.example", authorization: "Bearer sqlite-test-token" },
        }), true);
    });

    it("gates both SQLite reads and writes before accessing the database", async () => {
        let handler: (req: unknown, res: unknown) => Promise<void> = async () => { throw new Error("not registered"); };
        const plugin = localSqlitePlugin();
        const configure = plugin.configureServer as (server: unknown) => void;
        configure({ middlewares: { use: (_path: string, registered: typeof handler) => { handler = registered; } } });
        for (const token of [undefined, "sqlite-test-token"]) {
            if (token === undefined) delete process.env.LOCAL_PROXY_TOKEN;
            else process.env.LOCAL_PROXY_TOKEN = token;
            for (const [method, url] of [["GET", "/load-ohlcv"], ["POST", "/store-ohlcv"]]) {
                let body = "";
                const res = { statusCode: 0, setHeader: () => {}, end: (value: string) => { body = value; } };
                await handler({ method, url, socket: { remoteAddress: "192.0.2.1" }, headers: { host: "localhost:5173", origin: "http://localhost:5173" } }, res);
                assert.equal(res.statusCode, 401);
                assert.equal(JSON.parse(body).error, "Unauthorized");
            }
        }
    });
});
