import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { resetLocalSqlitePolymarketApiAvailabilityForTests } from "../lib/local-sqlite-polymarket-api";
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
});
