/**
 * Phase 4 — credential isolation / no-leak regression tests.
 *
 * Locks the security contract from the plan:
 *  - Credentials are read ONLY from env, never from request body.
 *  - The auth header is constructed server-side and discarded with the
 *    response — never returned from any public function.
 *  - No public function returns apiKey/apiSecret in its result.
 *  - Catalog JSON, CSV, NDJSON events, and debug logs carry no credentials.
 *
 * These tests exist because credential leakage is a regression that is
 * invisible to the rest of the suite: a future edit that "conveniently"
 * threads the config into the result object would silently leak keys to the
 * browser via the NDJSON stream.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ALPACA_DATA_HOST,
    ALPACA_DEFAULT_ADJUSTMENT,
    ALPACA_DEFAULT_FEED,
    buildAlpacaBarsUrl,
    fetchAlpacaBars,
    resolveAlpacaConfig,
} from "../lib/ibkr-data/alpaca-fetcher";
import { syncOneAlpacaSymbol } from "../lib/ibkr-data/ibkr-data-vite-plugin";

const CREDS_PATTERN = /PKZ|APCA-API-SECRET-KEY|APCA-API-KEY-ID|testsecret|supersecret/i;

const originalFetch = globalThis.fetch;

/**
 * Stubs `globalThis.fetch` with a spy that records the outbound headers and
 * returns a one-bar Alpaca response. The spy lets each test assert exactly
 * which headers left the process and that no public return value echoes them.
 */
function spyFetch(): { headersSeen: Record<string, string>[]; restore: () => void } {
    const headersSeen: Record<string, string>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        // Capture the headers that left the process.
        headersSeen.push((init?.headers as Record<string, string>) ?? {});
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }),
            text: async () => "",
        } as unknown as Response;
    }) as typeof fetch;
    return {
        headersSeen,
        restore: () => { globalThis.fetch = originalFetch; },
    };
}

describe("alpaca credential isolation", () => {
    it("resolveAlpacaConfig reads creds ONLY from env, never from a request body", () => {
        const savedKey = process.env.ALPACA_API_KEY;
        const savedSecret = process.env.ALPACA_API_SECRET;
        try {
            process.env.ALPACA_API_KEY = "PKENVKEY";
            process.env.ALPACA_API_SECRET = "envsecret";
            const config = resolveAlpacaConfig();
            assert.equal(config.apiKey, "PKENVKEY");
            assert.equal(config.apiSecret, "envsecret");
            // resolveAlpacaConfig takes no args — there is no API surface to
            // pass creds via request body. This is the contract: env-only.
            assert.equal(resolveAlpacaConfig.length, 0);
        } finally {
            if (savedKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = savedKey;
            if (savedSecret === undefined) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = savedSecret;
        }
    });

    it("buildAlpacaBarsUrl never embeds credentials in the URL", () => {
        const url = buildAlpacaBarsUrl(
            { host: ALPACA_DATA_HOST, feed: ALPACA_DEFAULT_FEED, adjustment: ALPACA_DEFAULT_ADJUSTMENT },
            { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
        );
        assert.doesNotMatch(url, CREDS_PATTERN, `URL must not embed credentials: ${url}`);
    });

    it("fetchAlpacaBars sends the auth header on the wire but never returns it", async () => {
        const spy = spyFetch();
        try {
            const result = await fetchAlpacaBars(
                { apiKey: "PKLEAK", apiSecret: "supersecret", host: ALPACA_DATA_HOST, feed: ALPACA_DEFAULT_FEED, adjustment: ALPACA_DEFAULT_ADJUSTMENT },
                { symbol: "AAPL", timeframe: "30Min", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
            );
            // The header DID leave the process on the outbound request.
            assert.equal(spy.headersSeen.length, 1);
            assert.equal(spy.headersSeen[0]!["APCA-API-KEY-ID"], "PKLEAK");
            assert.equal(spy.headersSeen[0]!["APCA-API-SECRET-KEY"], "supersecret");
            // The return value carries NO credential echoes.
            const serialized = JSON.stringify(result);
            assert.doesNotMatch(serialized, CREDS_PATTERN, `result must not echo credentials: ${serialized}`);
        } finally {
            spy.restore();
        }
    });

    it("syncOneAlpacaSymbol returns no credentials in any field (catalog/CSV/stream-safe)", async () => {
        // Use a pre-aborted signal so the worker takes the cancellation path,
        // which returns the same per-symbol result shape WITHOUT touching disk
        // (no readCsvCandles / writeCsv / upsertCatalogEntry calls). The point
        // of this test is the result-shape contract, not disk isolation — and
        // the cancelled result is the same `Record<string, unknown>` that
        // flows into the NDJSON `done` event.
        const spy = spyFetch();
        try {
            const catalog = {
                entries: [{
                    symbol: "AAPL",
                    intervals: {
                        "30m": { source: "alpaca", lastTime: "2026-01-01T00:00:00Z", firstTime: "2026-01-01T00:00:00Z", bars: 1, lastSyncAt: "2026-01-01T00:00:00Z" },
                    },
                }],
            };
            const controller = new AbortController();
            controller.abort();
            const result = await syncOneAlpacaSymbol(
                catalog as never,
                "AAPL",
                "30m",
                "1m",
                true,
                controller.signal,
                { apiKey: "PKLEAK", apiSecret: "supersecret", host: ALPACA_DATA_HOST, feed: ALPACA_DEFAULT_FEED, adjustment: ALPACA_DEFAULT_ADJUSTMENT },
            );
            // The per-symbol result is what flows into the NDJSON `done` event
            // and is the most likely accidental leak surface. Assert no field
            // carries credentials.
            const serialized = JSON.stringify(result);
            assert.doesNotMatch(serialized, CREDS_PATTERN, `per-symbol result leaked credentials: ${serialized}`);
            // Source label is still present on the cancelled result so the UI
            // can render it — but it must be the literal "alpaca", never a
            // credential.
            assert.equal(result.source, "alpaca");
            // The catalog we passed in must not have been mutated to carry
            // credentials either.
            const catalogSerialized = JSON.stringify(catalog);
            assert.doesNotMatch(catalogSerialized, CREDS_PATTERN, `catalog leaked credentials: ${catalogSerialized}`);
        } finally {
            spy.restore();
        }
    });
});
