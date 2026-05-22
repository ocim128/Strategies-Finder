import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    loadPolymarketOutcomes,
    loadPolymarketPricePoints,
    resetLocalSqlitePolymarketApiAvailabilityForTests,
} from "../lib/local-sqlite-polymarket-api";
import {
    getEffectivePolymarketSeriesId,
    getPolymarketSeriesIdForSymbol,
    loadPolymarket5mOutcomesForTimeRange,
    loadPolymarketOutcomesForTimeRange,
} from "../lib/polymarket-btc5m";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

function makeOutcome(eventStartTs: number, eventSlug: string): PolymarketOutcomeRow {
    return {
        series_id: "10684",
        event_slug: eventSlug,
        market_slug: eventSlug,
        interval: "5m",
        event_start_ts: eventStartTs,
        event_end_ts: eventStartTs + 300,
        yes_token_id: `yes-${eventSlug}`,
        no_token_id: `no-${eventSlug}`,
        yes_open_price: 0.5,
        yes_entry_minute_1_price: 0.5,
        yes_entry_minute_2_price: 0.5,
        yes_entry_minute_3_price: 0.5,
        yes_entry_minute_4_price: 0.5,
        resolved_outcome_up: 1,
        resolution_source: "test",
        updated_at: 1,
    };
}

describe("Polymarket outcome loading", () => {
    it("resolves native 15m and 1h series ids for supported symbols", () => {
        expect(getPolymarketSeriesIdForSymbol("BTCUSDT", "15m")).to.equal("10192");
        expect(getPolymarketSeriesIdForSymbol("SOLUSDT", "1h")).to.equal("10122");
        expect(getEffectivePolymarketSeriesId("NEARUSDT", "15m", "ETHUSDT")).to.equal("10191");
    });

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

    it("loads native 15m outcomes from the session-specific series id", async () => {
        const requestedSeriesIds: string[] = [];
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

            requestedSeriesIds.push(url.searchParams.get("seriesId") ?? "");
            return new Response(JSON.stringify({
                ok: true,
                rows: [{
                    series_id: "10192",
                    event_slug: "btc-15m-1",
                    market_slug: "btc-15m-1",
                    interval: "15m",
                    event_start_ts: 1_700_000_000,
                    event_end_ts: 1_700_000_900,
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    yes_open_price: 0.5,
                    yes_entry_minute_1_price: 0.51,
                    yes_entry_minute_2_price: 0.52,
                    yes_entry_minute_3_price: 0.53,
                    yes_entry_minute_4_price: 0.54,
                    resolved_outcome_up: 1,
                    resolution_source: "test",
                    updated_at: 1,
                }],
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        const outcomes = await loadPolymarketOutcomesForTimeRange("BTCUSDT", 1_700_000_300, 1_700_000_600, undefined, "15m");

        expect(requestedSeriesIds).to.deep.equal(["10192"]);
        expect(outcomes[0]?.interval).to.equal("15m");
    });

    it("continues paginated outcome loads with a stable tie-safe cursor", async () => {
        const outcomeCalls: URL[] = [];
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

            outcomeCalls.push(url);
            const afterStartTs = url.searchParams.get("afterStartTs");
            const rows = afterStartTs === null
                ? [
                    makeOutcome(1_700_000_000, "event-a"),
                    makeOutcome(1_700_000_000, "event-b"),
                ]
                : [makeOutcome(1_700_000_300, "event-c")];

            return new Response(JSON.stringify({
                ok: true,
                rows,
                count: rows.length,
                limit: 100000,
                truncated: afterStartTs === null,
                nextAfterStartTs: afterStartTs === null ? 1_700_000_000 : undefined,
                nextAfterEventSlug: afterStartTs === null ? "event-b" : undefined,
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        const outcomes = await loadPolymarketOutcomesForTimeRange("BTCUSDT", 1_700_000_000, 1_700_000_300);

        expect(outcomes.map((row) => row.event_slug)).to.deep.equal(["event-a", "event-b", "event-c"]);
        expect(outcomeCalls).to.have.length(2);
        expect(outcomeCalls[1].searchParams.get("afterStartTs")).to.equal("1700000000");
        expect(outcomeCalls[1].searchParams.get("afterEventSlug")).to.equal("event-b");
    });

    it("fails loud when outcome pagination returns a non-advancing cursor", async () => {
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
            return new Response(JSON.stringify({
                ok: true,
                rows: [makeOutcome(1_700_000_000, `event-${loadCalls}`)],
                count: 1,
                limit: 100000,
                truncated: true,
                nextAfterStartTs: 1_700_000_000,
                nextAfterEventSlug: "event-a",
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        let thrown: Error | null = null;
        try {
            await loadPolymarketOutcomesForTimeRange("BTCUSDT", 1_700_000_000, 1_700_000_300);
        } catch (error) {
            thrown = error instanceof Error ? error : new Error(String(error));
        }

        expect(thrown).to.be.instanceOf(Error);
        expect(thrown?.message).to.contain("pagination cursor did not advance");
        expect(loadCalls).to.equal(2);
    });
});
