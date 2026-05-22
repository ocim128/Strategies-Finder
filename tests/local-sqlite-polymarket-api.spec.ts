import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
    loadPolymarketOutcomes,
    resetLocalSqlitePolymarketApiAvailabilityForTests,
} from "../lib/local-sqlite-polymarket-api";

const originalFetch = globalThis.fetch;

type FetchCall = {
    url: string;
    init?: RequestInit;
};

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

describe("local sqlite polymarket api availability", () => {
    it("caches negative availability instead of forcing repeated status probes", async () => {
        const calls: FetchCall[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            calls.push({ url, init });
            if (url.includes("/api/sqlite/status")) {
                return new Response(JSON.stringify({ ok: false }), {
                    status: 503,
                    headers: { "content-type": "application/json" },
                });
            }
            return new Response(JSON.stringify({ ok: true, rows: [] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        await assert.rejects(() => loadPolymarketOutcomes(), /Local SQLite API is unavailable/);
        await assert.rejects(() => loadPolymarketOutcomes(), /Local SQLite API is unavailable/);

        assert.equal(calls.filter((call) => call.url.includes("/api/sqlite/status")).length, 1);
        assert.equal(calls.filter((call) => call.url.includes("/api/sqlite/load-polymarket-outcomes")).length, 0);
    });

    it("does not poison availability after a route-level SQLite failure", async () => {
        let statusCalls = 0;
        let loadCalls = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/sqlite/status")) {
                statusCalls++;
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            if (url.includes("/api/sqlite/load-polymarket-outcomes")) {
                loadCalls++;
                if (loadCalls === 1) {
                    return new Response(JSON.stringify({ ok: false, error: "database busy" }), {
                        status: 500,
                        headers: { "content-type": "application/json" },
                    });
                }
                return new Response(JSON.stringify({ ok: true, rows: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            throw new Error(`Unexpected URL ${url}`);
        }) as typeof fetch;

        await assert.rejects(() => loadPolymarketOutcomes(), /database busy/);
        assert.deepEqual(await loadPolymarketOutcomes(), []);

        assert.equal(statusCalls, 1);
        assert.equal(loadCalls, 2);
    });
});
