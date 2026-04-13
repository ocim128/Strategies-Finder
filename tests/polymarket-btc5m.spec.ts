import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    loadPolymarketOutcomes,
    loadPolymarketPricePoints,
    resetLocalSqlitePolymarketApiAvailabilityForTests,
} from "../lib/local-sqlite-polymarket-api";
import { loadPolymarket5mOutcomesForTimeRange } from "../lib/polymarket-btc5m";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

describe("Polymarket 5m outcome loading", () => {
    it("does not reuse stale sequential rows from an in-memory TTL cache", async () => {
        let loadCalls = 0;
        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname !== "/api/sqlite/load-polymarket-outcomes") {
                throw new Error(`Unexpected URL ${url.pathname}`);
            }

            loadCalls++;
            const rows = loadCalls === 1
                ? [{
                    series_id: "10684",
                    event_slug: "btc-1",
                    market_slug: "btc-1",
                    interval: "5m",
                    event_start_ts: 1_700_000_300,
                    event_end_ts: 1_700_000_600,
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    yes_open_price: 0.5,
                    yes_entry_minute_1_price: 0.5,
                    yes_entry_minute_2_price: 0.5,
                    yes_entry_minute_3_price: 0.5,
                    yes_entry_minute_4_price: 0.5,
                    resolved_outcome_up: 1 as const,
                    resolution_source: "test",
                    updated_at: 1,
                }]
                : [{
                    series_id: "10684",
                    event_slug: "btc-1",
                    market_slug: "btc-1",
                    interval: "5m",
                    event_start_ts: 1_700_000_300,
                    event_end_ts: 1_700_000_600,
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    yes_open_price: 0.5,
                    yes_entry_minute_1_price: 0.52,
                    yes_entry_minute_2_price: 0.54,
                    yes_entry_minute_3_price: 0.56,
                    yes_entry_minute_4_price: 0.58,
                    resolved_outcome_up: 1 as const,
                    resolution_source: "test",
                    updated_at: 2,
                }];

            return new Response(JSON.stringify({ ok: true, rows }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        const first = await loadPolymarket5mOutcomesForTimeRange("BTCUSDT", 1_700_000_360, 1_700_000_360);
        const second = await loadPolymarket5mOutcomesForTimeRange("BTCUSDT", 1_700_000_360, 1_700_000_360);

        expect(loadCalls).to.equal(2);
        expect(first[0]?.yes_entry_minute_1_price).to.equal(0.5);
        expect(second[0]?.yes_entry_minute_1_price).to.equal(0.52);
    });

    it("reuses a recent successful SQLite availability check for price-point loads", async () => {
        let statusCalls = 0;
        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                statusCalls++;
                if (statusCalls === 1) {
                    return new Response(JSON.stringify({ ok: true }), {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                throw new Error("transient status probe failure");
            }

            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10684",
                        event_slug: "btc-1",
                        market_slug: "btc-1",
                        interval: "5m",
                        event_start_ts: 1_700_000_300,
                        event_end_ts: 1_700_000_600,
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: 0.5,
                        yes_entry_minute_2_price: 0.5,
                        yes_entry_minute_3_price: 0.5,
                        yes_entry_minute_4_price: 0.5,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10684",
                        event_start_ts: 1_700_000_300,
                        event_end_ts: 1_700_000_600,
                        market_slug: "btc-1",
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        ts: 1_700_000_360,
                        yes_price: 0.55,
                        no_price: 0.45,
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const outcomes = await loadPolymarketOutcomes({
            seriesId: "10684",
            startTs: 1_700_000_300,
            endTs: 1_700_000_600,
            limit: 100,
        });
        const pricePoints = await loadPolymarketPricePoints({
            seriesId: "10684",
            eventStartTs: [1_700_000_300],
        });

        expect(outcomes).to.have.length(1);
        expect(pricePoints).to.have.length(1);
        expect(statusCalls).to.equal(1);
    });
});
