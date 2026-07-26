/**
 * Focused unit tests for the Alpaca fetcher leaf module.
 *
 * Locks the Phase 1 contract: URL construction (no secrets), response parsing,
 * bar normalization (dedup timestamps, missing volume, invalid OHLC), retry
 * policy (429 retried, 401/403/422 NOT retried), abort handling, and the
 * config resolver's missing-credential guard. No real network — `fetch` is
 * stubbed per-test.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ALPACA_DEFAULT_ADJUSTMENT,
    ALPACA_DEFAULT_FEED,
    ALPACA_DATA_HOST,
    ALPACA_SUPPORTED_INTERVAL,
    ALPACA_TIMEFRAME_BY_INTERVAL,
    buildAlpacaBarsUrl,
    fetchAlpacaBars,
    isRetryableAlpacaStatus,
    normalizeAlpacaBars,
    parseAlpacaBarsResponse,
    resolveAlpacaConfig,
} from "../lib/ibkr-data/alpaca-fetcher";
import { HttpStatusError } from "../lib/vite-http-utils";

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchResponses: Response[] = [];

function pushResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): void {
    const status = init.status ?? 200;
    const headers = new Map(Object.entries(init.headers ?? {}));
    const text = typeof body === "string" ? body : JSON.stringify(body);
    fetchResponses.push({
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (name: string) => headers.get(name.toLowerCase()) ?? null,
        },
        json: async () => (typeof body === "string" ? JSON.parse(body) : body),
        text: async () => text,
    } as unknown as Response);
}

const originalFetch = globalThis.fetch;

describe("alpaca buildAlpacaBarsUrl", () => {
    const config = { host: ALPACA_DATA_HOST, feed: ALPACA_DEFAULT_FEED, adjustment: ALPACA_DEFAULT_ADJUSTMENT };

    it("builds a URL with the symbol, timeframe, sort=asc, feed, adjustment, and limit", () => {
        const url = buildAlpacaBarsUrl(config, {
            symbol: "aapl",
            timeframe: "30Min",
            start: "2026-01-01T00:00:00Z",
            end: "2026-02-01T00:00:00Z",
        });
        // Symbol is upper-cased and URL-encoded into the path.
        assert.ok(url.startsWith(`${ALPACA_DATA_HOST}/v2/stocks/AAPL/bars?`), url);
        const params = new URL(url).searchParams;
        assert.equal(params.get("timeframe"), "30Min");
        assert.equal(params.get("sort"), "asc");
        assert.equal(params.get("feed"), ALPACA_DEFAULT_FEED);
        assert.equal(params.get("adjustment"), ALPACA_DEFAULT_ADJUSTMENT);
        assert.equal(params.get("limit"), "10000");
        assert.equal(params.get("start"), "2026-01-01T00:00:00Z");
        assert.equal(params.get("end"), "2026-02-01T00:00:00Z");
    });

    it("omits start/end when not provided and includes page_token when provided", () => {
        const url = buildAlpacaBarsUrl(config, {
            symbol: "MSFT",
            timeframe: "30Min",
            pageToken: "abc==",
        });
        const params = new URL(url).searchParams;
        assert.equal(params.get("start"), null);
        assert.equal(params.get("end"), null);
        assert.equal(params.get("page_token"), "abc==");
    });

    it("clamps limit to the documented Alpaca max (10,000)", () => {
        const url = buildAlpacaBarsUrl(config, {
            symbol: "NVDA",
            timeframe: "30Min",
            limit: 99_999,
        });
        const params = new URL(url).searchParams;
        assert.equal(params.get("limit"), "10000");
    });

    it("does not embed credentials in the URL (auth is header-based)", () => {
        const url = buildAlpacaBarsUrl(config, {
            symbol: "AAPL",
            timeframe: "30Min",
        });
        // No key/secret anywhere in the URL string.
        assert.doesNotMatch(url, /APCA-API-KEY-ID|APCA-API-SECRET-KEY|PKZ|secret/i);
    });
});

describe("alpaca parseAlpacaBarsResponse", () => {
    it("returns bars and a trimmed next_page_token", () => {
        const { bars, nextPageToken } = parseAlpacaBarsResponse({
            bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }],
            next_page_token: "  next==  ",
        });
        assert.equal(bars.length, 1);
        assert.equal(nextPageToken, "next==");
    });

    it("treats an absent or blank next_page_token as null", () => {
        assert.equal(parseAlpacaBarsResponse({ bars: [] }).nextPageToken, null);
        assert.equal(parseAlpacaBarsResponse({ bars: [], next_page_token: "   " }).nextPageToken, null);
        assert.equal(parseAlpacaBarsResponse({ bars: [], next_page_token: null }).nextPageToken, null);
    });

    it("tolerates a non-object payload (returns empty bars, null token)", () => {
        const { bars, nextPageToken } = parseAlpacaBarsResponse("garbage");
        assert.deepEqual(bars, []);
        assert.equal(nextPageToken, null);
    });
});

describe("alpaca normalizeAlpacaBars", () => {
    it("converts ISO timestamps to Unix seconds and reads OHLCV", () => {
        const rows = [{
            t: "2026-01-01T00:00:00Z",
            o: "100.5", h: "101", l: "100", c: "100.75", v: "1234",
        }];
        const candles = normalizeAlpacaBars(rows);
        assert.equal(candles.length, 1);
        assert.equal(candles[0]!.time, 1767225600);
        assert.equal(candles[0]!.open, 100.5);
        assert.equal(candles[0]!.high, 101);
        assert.equal(candles[0]!.low, 100);
        assert.equal(candles[0]!.close, 100.75);
        assert.equal(candles[0]!.volume, 1234);
    });

    it("accepts unix-epoch `t` (number) and converts ms -> seconds when needed", () => {
        const candles = normalizeAlpacaBars([
            { t: 1767225600, o: 1, h: 2, l: 0.5, c: 1.5, v: 0 },
            { t: 1767225600000, o: 1, h: 2, l: 0.5, c: 1.5, v: 0 },
        ]);
        assert.equal(candles.length, 2);
        assert.equal(candles[0]!.time, 1767225600);
        // ms timestamp is divided by 1000.
        assert.equal(candles[1]!.time, 1767225600);
    });

    it("drops rows with invalid OHLC and treats missing/null volume as 0", () => {
        const candles = normalizeAlpacaBars([
            { t: "2026-01-01T00:00:00Z", o: NaN, h: 2, l: 1, c: 1.5, v: 100 }, // invalid open -> dropped
            { t: "2026-01-01T00:30:00Z", o: 1, h: 2, l: 1, c: 1.5, v: null },    // null volume -> 0
            { t: "2026-01-01T01:00:00Z", o: 1, h: 2, l: 1, c: 1.5 },             // missing volume -> 0
            { t: "not-a-date", o: 1, h: 2, l: 1, c: 1.5, v: 100 },               // invalid time -> dropped
        ]);
        // 4 rows in, 2 dropped (NaN open + bad time), 2 valid.
        assert.equal(candles.length, 2);
        // Both surviving rows had missing/null volume and defaulted to 0.
        assert.deepEqual(candles.map((c) => c.volume), [0, 0]);
    });
});

describe("alpaca isRetryableAlpacaStatus", () => {
    it("retries 429 and 5xx", () => {
        assert.equal(isRetryableAlpacaStatus(429), true);
        assert.equal(isRetryableAlpacaStatus(500), true);
        assert.equal(isRetryableAlpacaStatus(502), true);
        assert.equal(isRetryableAlpacaStatus(503), true);
        assert.equal(isRetryableAlpacaStatus(504), true);
    });

    it("does NOT retry auth/config/empty-symbol errors", () => {
        assert.equal(isRetryableAlpacaStatus(401), false);
        assert.equal(isRetryableAlpacaStatus(403), false);
        assert.equal(isRetryableAlpacaStatus(422), false);
        assert.equal(isRetryableAlpacaStatus(400), false);
        assert.equal(isRetryableAlpacaStatus(404), false);
    });
});

describe("alpaca resolveAlpacaConfig", () => {
    const savedKey = process.env.ALPACA_API_KEY;
    const savedSecret = process.env.ALPACA_API_SECRET;
    const savedHost = process.env.ALPACA_DATA_HOST;
    const savedFeed = process.env.ALPACA_FEED;
    const savedAdjustment = process.env.ALPACA_ADJUSTMENT;

    afterEach(() => {
        if (savedKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = savedKey;
        if (savedSecret === undefined) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = savedSecret;
        if (savedHost === undefined) delete process.env.ALPACA_DATA_HOST; else process.env.ALPACA_DATA_HOST = savedHost;
        if (savedFeed === undefined) delete process.env.ALPACA_FEED; else process.env.ALPACA_FEED = savedFeed;
        if (savedAdjustment === undefined) delete process.env.ALPACA_ADJUSTMENT; else process.env.ALPACA_ADJUSTMENT = savedAdjustment;
    });

    it("throws an actionable 500 when credentials are missing", () => {
        delete process.env.ALPACA_API_KEY;
        delete process.env.ALPACA_API_SECRET;
        assert.throws(
            () => resolveAlpacaConfig(),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 500
                && /ALPACA_API_KEY.*ALPACA_API_SECRET/.test(error.message),
        );
    });

    it("reads credentials, host, feed, and adjustment from env", () => {
        process.env.ALPACA_API_KEY = "PKTESTKEY";
        process.env.ALPACA_API_SECRET = "testsecret";
        process.env.ALPACA_DATA_HOST = "https://example.test/";
        process.env.ALPACA_FEED = "sip";
        process.env.ALPACA_ADJUSTMENT = "raw";
        const config = resolveAlpacaConfig();
        assert.equal(config.apiKey, "PKTESTKEY");
        assert.equal(config.apiSecret, "testsecret");
        // Trailing slash stripped from host.
        assert.equal(config.host, "https://example.test");
        assert.equal(config.feed, "sip");
        assert.equal(config.adjustment, "raw");
    });

    it("falls back to default feed/adjustment when env is blank", () => {
        process.env.ALPACA_API_KEY = "PKTESTKEY";
        process.env.ALPACA_API_SECRET = "testsecret";
        delete process.env.ALPACA_DATA_HOST;
        process.env.ALPACA_FEED = "   ";
        process.env.ALPACA_ADJUSTMENT = "";
        const config = resolveAlpacaConfig();
        assert.equal(config.host, ALPACA_DATA_HOST);
        assert.equal(config.feed, ALPACA_DEFAULT_FEED);
        assert.equal(config.adjustment, ALPACA_DEFAULT_ADJUSTMENT);
    });
});

describe("alpaca fetchAlpacaBars (stubbed fetch)", () => {
    beforeEach(() => {
        fetchCalls = [];
        fetchResponses = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ url: input.toString(), init });
            const response = fetchResponses.shift();
            if (!response) throw new Error("test forgot to push a response");
            return response;
        }) as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    const config = {
        apiKey: "PKTESTKEY",
        apiSecret: "testsecret",
        host: ALPACA_DATA_HOST,
        feed: ALPACA_DEFAULT_FEED,
        adjustment: ALPACA_DEFAULT_ADJUSTMENT,
    };

    it("passes the auth header on the outbound request and nowhere else", async () => {
        pushResponse({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] });
        await fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" });
        assert.equal(fetchCalls.length, 1);
        const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
        assert.equal(headers["APCA-API-KEY-ID"], "PKTESTKEY");
        assert.equal(headers["APCA-API-SECRET-KEY"], "testsecret");
    });

    it("uses an IPv4-only dispatcher for the public Alpaca host", async () => {
        // Some ISP DNS resolvers return an unreachable NAT64/block-page AAAA
        // record for data.alpaca.markets alongside its working A record. Keep
        // this request host-scoped so one bad IPv6 route cannot make downloads
        // intermittently fail while unrelated server fetches stay untouched.
        pushResponse({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] });
        await fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" });
        const init = fetchCalls[0]!.init as RequestInit & { dispatcher?: unknown };
        assert.ok(init.dispatcher, "public Alpaca requests should carry the IPv4-only dispatcher");
    });

    it("follows next_page_token until exhausted and dedups overlapping timestamps", async () => {
        const t0 = 1767225600;
        pushResponse({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }], next_page_token: "page2" });
        // Page 2 repeats the same timestamp (overlap) + adds a new one.
        pushResponse({
            bars: [
                { t: "2026-01-01T00:00:00Z", o: 1.1, h: 2, l: 0.5, c: 1.6, v: 11 },
                { t: "2026-01-01T00:30:00Z", o: 2, h: 3, l: 1.5, c: 2.5, v: 20 },
            ],
            next_page_token: null,
        });
        const result = await fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" });
        assert.equal(fetchCalls.length, 2);
        // Page 2 carried the page_token from page 1.
        assert.ok(fetchCalls[1]!.url.includes("page_token=page2"), fetchCalls[1]!.url);
        assert.equal(result.candles.length, 2); // dedup collapsed the overlap
        assert.equal(result.complete, true);
        assert.equal(result.stopReason, "covered");
        assert.equal(result.pages, 2);
        // Last-write-wins: the overlapping timestamp took page 2's close.
        assert.equal(result.candles[0]!.close, 1.6);
        // Verify the time math: t0 is the unix-second epoch of page 1's first bar.
        assert.equal(result.candles[0]!.time, t0);
    });

    it("returns cancelled with whatever bars landed when the signal aborts", async () => {
        const controller = new AbortController();
        // First page returns one bar + a next page token; abort before page 2.
        pushResponse({
            bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }],
            next_page_token: "page2",
        });
        const resultPromise = fetchAlpacaBars(
            config,
            { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
            controller.signal,
        );
        controller.abort();
        const result = await resultPromise;
        assert.equal(result.stopReason, "cancelled");
        assert.equal(result.complete, false);
        // The first-page bar landed before the abort.
        assert.equal(result.candles.length, 1);
    });

    it("retries 429 (with Retry-After) then succeeds", async () => {
        pushResponse("rate limited", { status: 429, headers: { "retry-after": "0" } });
        pushResponse({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] });
        const result = await fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" });
        assert.equal(fetchCalls.length, 2);
        assert.equal(result.candles.length, 1);
        assert.equal(result.stopReason, "covered");
    });

    it("does NOT retry 401 (auth) — surfaces immediately", async () => {
        pushResponse("unauthorized", { status: 401 });
        await assert.rejects(
            fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" }),
            (error: unknown) => error instanceof HttpStatusError && error.status === 401,
        );
        // Exactly one fetch — no retries.
        assert.equal(fetchCalls.length, 1);
    });

    it("does NOT retry 422 (invalid config / empty symbol) — surfaces immediately", async () => {
        pushResponse("bad symbol", { status: 422 });
        await assert.rejects(
            fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" }),
            (error: unknown) => error instanceof HttpStatusError && error.status === 400,
        );
        assert.equal(fetchCalls.length, 1);
    });

    it("page ceiling returns page_limit + complete:false (truncated, NOT silently complete)", async () => {
        // Audit Finding 1: hitting ALPACA_MAX_PAGES_PER_SYMBOL with
        // `next_page_token` still present means the dataset is TRUNCATED.
        // The result must NOT be marked complete — otherwise truncated
        // history is written as a full interval and downstream code trusts
        // partial data. Push enough pages to hit the 200-page ceiling.
        for (let i = 0; i < 201; i += 1) {
            pushResponse({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }], next_page_token: "more" });
        }
        const result = await fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" });
        assert.equal(result.stopReason, "page_limit");
        assert.equal(result.complete, false);
        // The page ceiling is a soft truncation — whatever bars landed are
        // still returned (the caller's existing incomplete-result path
        // surfaces a `symbol_warning` and lands them).
        assert.equal(result.candles.length, 1);
        assert.equal(result.pages, 200);
    });

    it("sums retry attempts across pages (audit Finding 4 telemetry)", async () => {
        // Page 1: 429 once then success (1 retry). Page 2: clean success (0).
        pushResponse("rate limited", { status: 429, headers: { "retry-after": "0" } });
        pushResponse({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }], next_page_token: "p2" });
        pushResponse({ bars: [{ t: "2026-01-01T00:30:00Z", o: 2, h: 3, l: 1.5, c: 2.5, v: 20 }] });
        const result = await fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" });
        assert.equal(result.retries, 1);
        assert.equal(result.candles.length, 2);
    });

    it("retries a transient timeout during the initial fetch (audit Finding 3)", async () => {
        // First attempt throws a TimeoutError-shaped error (mirrors what
        // `createFetchTimeoutSignal` produces on per-request timeout). The
        // fetcher must retry it as a transient condition, not propagate it.
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            if (calls === 1) {
                const err = new Error("fetch timeout");
                err.name = "TimeoutError";
                throw err;
            }
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }),
                text: async () => "",
            } as unknown as Response;
        }) as typeof fetch;
        const result = await fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" });
        assert.equal(calls, 2); // first timed out, second succeeded
        assert.equal(result.stopReason, "covered");
        assert.equal(result.retries, 1);
    });

    it("propagates a user abort immediately without retry (audit Finding 3)", async () => {
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            // First call: simulate a TimeoutError-shaped throw BUT with the
            // user signal already aborted — the fetcher must treat this as a
            // user abort (propagate, no retry), not a transient timeout.
            controller.abort();
            const err = new Error("aborted");
            err.name = "TimeoutError";
            throw err;
        }) as typeof fetch;
        const result = await fetchAlpacaBars(
            config,
            { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
            controller.signal,
        );
        // Exactly one fetch call — no retry on user abort.
        assert.equal(calls, 1);
        assert.equal(result.stopReason, "cancelled");
        assert.equal(result.complete, false);
    });

    it("retries a transient timeout during response body parsing (audit Finding 3)", async () => {
        // The timeout must stay active through response.json(). Simulate a
        // first response whose body parsing throws a TimeoutError-shaped
        // error, then a clean second response. The fetcher should retry.
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    json: async () => {
                        const err = new Error("body read timeout");
                        err.name = "TimeoutError";
                        throw err;
                    },
                    text: async () => "",
                } as unknown as Response;
            }
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }),
                text: async () => "",
            } as unknown as Response;
        }) as typeof fetch;
        const result = await fetchAlpacaBars(config, { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" });
        assert.equal(calls, 2);
        assert.equal(result.stopReason, "covered");
        assert.equal(result.retries, 1);
    });
});

describe("alpaca constants and interval mapping", () => {
    it("the only supported Alpaca interval in this release is 30m", () => {
        assert.equal(ALPACA_SUPPORTED_INTERVAL, "30m");
    });

    it("maps 30m to Alpaca's 30Min timeframe token", () => {
        assert.equal(ALPACA_TIMEFRAME_BY_INTERVAL["30m"], "30Min");
    });
});
