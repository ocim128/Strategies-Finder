import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    ensurePolymarketPricePointsWithMetadata,
    resetLocalSqlitePolymarketApiAvailabilityForTests,
} from "../lib/local-sqlite-polymarket-api";
import { ensurePricePointsForOutcomes } from "../lib/polymarket-price-points-ingest";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";

const ORIGINAL_FETCH = globalThis.fetch;

function makeOutcome(interval: "15m" | "1h", eventStartTs: number, eventEndTs: number): PolymarketOutcomeRow {
    return {
        series_id: interval === "15m" ? "10192" : "10114",
        event_slug: `${interval}-event`,
        market_slug: `${interval}-event`,
        interval,
        event_start_ts: eventStartTs,
        event_end_ts: eventEndTs,
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
    };
}

function makePoint(eventStartTs: number, eventEndTs: number, ts: number) {
    return {
        series_id: "series-test",
        event_start_ts: eventStartTs,
        event_end_ts: eventEndTs,
        market_slug: "test-event",
        yes_token_id: "yes-1",
        no_token_id: "no-1",
        ts,
        yes_price: 0.5,
        no_price: 0.5,
        updated_at: 1,
    };
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

describe("Polymarket price-point ingestion coverage", () => {
    it("re-fetches a native 15m session when SQLite only covers the first 5 minutes", async () => {
        const eventStartTs = 1_700_000_000;
        const eventEndTs = eventStartTs + 900;
        let ensureCalls = 0;

        globalThis.fetch = (async (input, init) => {
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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        makePoint(eventStartTs, eventEndTs, eventStartTs),
                        makePoint(eventStartTs, eventEndTs, eventStartTs + 300),
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                ensureCalls++;
                const body = JSON.parse(String(init?.body ?? "{}")) as { outcomes?: Array<{ event_end_ts?: number }> };
                expect(body.outcomes?.[0]?.event_end_ts).to.equal(eventEndTs);
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        makePoint(eventStartTs, eventEndTs, eventStartTs + 840),
                        makePoint(eventStartTs, eventEndTs, eventEndTs),
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const rows = await ensurePricePointsForOutcomes(
            [makeOutcome("15m", eventStartTs, eventEndTs)],
            "series-test"
        );

        expect(ensureCalls).to.equal(1);
        expect(rows.map((row) => row.ts)).to.include(eventEndTs);
    });

    it("keeps a native 1h session local when SQLite already reaches event_end_ts", async () => {
        const eventStartTs = 1_700_010_000;
        const eventEndTs = eventStartTs + 3600;
        let ensureCalls = 0;

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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        makePoint(eventStartTs, eventEndTs, eventStartTs),
                        makePoint(eventStartTs, eventEndTs, eventEndTs - 30),
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                ensureCalls++;
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const rows = await ensurePricePointsForOutcomes(
            [makeOutcome("1h", eventStartTs, eventEndTs)],
            "series-test"
        );

        expect(ensureCalls).to.equal(0);
        expect(rows).to.have.length(2);
    });

    it("returns server-side ensure diagnostics for ingestion visibility", async () => {
        const eventStartTs = 1_700_020_000;
        const eventEndTs = eventStartTs + 900;

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

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [makePoint(eventStartTs, eventEndTs, eventStartTs + 60)],
                    upserted: 1,
                    fetchedEvents: 2,
                    failedEvents: 1,
                    missingTokenEvents: 1,
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const result = await ensurePolymarketPricePointsWithMetadata({
            seriesId: "series-test",
            outcomes: [makeOutcome("15m", eventStartTs, eventEndTs)],
        });

        expect(result.rows).to.have.length(1);
        expect(result.upserted).to.equal(1);
        expect(result.fetchedEvents).to.equal(2);
        expect(result.failedEvents).to.equal(1);
        expect(result.missingTokenEvents).to.equal(1);
    });

    it("falls back only for events still uncovered after a partial server ensure", async () => {
        const firstStartTs = 1_700_030_000;
        const secondStartTs = firstStartTs + 900;
        const firstEndTs = firstStartTs + 900;
        const secondEndTs = secondStartTs + 900;
        let directHistoryCalls = 0;

        globalThis.fetch = (async (input, init) => {
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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        makePoint(firstStartTs, firstEndTs, firstStartTs),
                        makePoint(firstStartTs, firstEndTs, firstEndTs - 30),
                    ],
                    upserted: 2,
                    fetchedEvents: 2,
                    failedEvents: 1,
                    missingTokenEvents: 0,
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/polymarket-history") {
                directHistoryCalls++;
                expect(Number(url.searchParams.get("startTs"))).to.equal(secondStartTs - 15);
                return new Response(JSON.stringify({
                    history: [
                        { t: secondStartTs, p: 0.48 },
                        { t: secondEndTs - 30, p: 0.52 },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/store-polymarket-price-points") {
                const body = JSON.parse(String(init?.body ?? "{}")) as { rows?: Array<{ event_start_ts?: number }> };
                expect(body.rows?.every((row) => row.event_start_ts === secondStartTs)).to.equal(true);
                return new Response(JSON.stringify({ ok: true, upserted: body.rows?.length ?? 0 }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const rows = await ensurePricePointsForOutcomes([
            makeOutcome("15m", firstStartTs, firstEndTs),
            makeOutcome("15m", secondStartTs, secondEndTs),
        ], "series-test");

        expect(directHistoryCalls).to.equal(1);
        expect(rows.some((row) => row.event_start_ts === firstStartTs)).to.equal(true);
        expect(rows.some((row) => row.event_start_ts === secondStartTs)).to.equal(true);
    });

    it("coalesces concurrent stored loads and server ensures for identical outcome sets", async () => {
        const eventStartTs = 1_700_040_000;
        const eventEndTs = eventStartTs + 900;
        let loadCalls = 0;
        let ensureCalls = 0;

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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                loadCalls++;
                await new Promise((resolve) => setTimeout(resolve, 0));
                return new Response(JSON.stringify({ ok: true, rows: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                ensureCalls++;
                await new Promise((resolve) => setTimeout(resolve, 0));
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        makePoint(eventStartTs, eventEndTs, eventStartTs + 60),
                        makePoint(eventStartTs, eventEndTs, eventEndTs - 30),
                    ],
                    upserted: 2,
                    fetchedEvents: 1,
                    failedEvents: 0,
                    missingTokenEvents: 0,
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const outcome = makeOutcome("15m", eventStartTs, eventEndTs);
        const [first, second] = await Promise.all([
            ensurePricePointsForOutcomes([outcome], "series-test"),
            ensurePricePointsForOutcomes([outcome], "series-test"),
        ]);

        expect(loadCalls).to.equal(1);
        expect(ensureCalls).to.equal(1);
        expect(first.map((row) => row.ts)).to.deep.equal(second.map((row) => row.ts));
        expect(first).to.have.length(2);
    });

    it("chunks large server ensure requests before posting to local SQLite", async () => {
        const baseStartTs = 1_700_050_000;
        const outcomes = Array.from({ length: 205 }, (_, index) => {
            const startTs = baseStartTs + index * 900;
            return makeOutcome("15m", startTs, startTs + 900);
        });
        const ensureChunkSizes: number[] = [];

        globalThis.fetch = (async (input, init) => {
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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                const body = JSON.parse(String(init?.body ?? "{}")) as { outcomes?: PolymarketOutcomeRow[] };
                const chunk = body.outcomes ?? [];
                ensureChunkSizes.push(chunk.length);
                return new Response(JSON.stringify({
                    ok: true,
                    rows: chunk.flatMap((outcome) => [
                        makePoint(outcome.event_start_ts, outcome.event_end_ts, outcome.event_start_ts),
                        makePoint(outcome.event_start_ts, outcome.event_end_ts, outcome.event_end_ts - 30),
                    ]),
                    upserted: chunk.length * 2,
                    fetchedEvents: chunk.length,
                    failedEvents: 0,
                    missingTokenEvents: 0,
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const rows = await ensurePricePointsForOutcomes(outcomes, "series-test");

        expect(ensureChunkSizes).to.deep.equal([100, 100, 5]);
        expect(rows).to.have.length(410);
    });
});
