import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    fetchPolymarketData,
    parsePolymarketEventInput,
} from "../lib/dataProviders/polymarket";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

describe("Polymarket data provider", () => {
    it("parses custom urls and explicit no-side selection", () => {
        const parsed = parsePolymarketEventInput("https://polymarket.com/event/btc-future-123?outcome=no");
        expect(parsed?.slug).to.equal("btc-future-123");
        expect(parsed?.direction).to.equal("down");
        expect(parsed?.canonicalSymbol).to.equal("PM:btc-future-123:DOWN");
    });

    it("buckets raw history into 1-minute candles", async () => {
        const slug = "btc-1m-test-123";
        const eventPayload = {
            title: "BTC 1m Test",
            markets: [{
                slug,
                question: "Will BTC move?",
                outcomes: ["Yes", "No"],
                clobTokenIds: ["yes-token", "no-token"],
                startDate: "2024-01-01T00:00:00Z",
                endDate: "2024-01-01T00:10:00Z",
            }],
        };
        const historyPayload = {
            history: [
                { t: 1_000, p: 0.10 },
                { t: 1_010, p: 0.20 },
                { t: 1_020, p: 0.30 },
                { t: 1_070, p: 0.40 },
            ],
        };

        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/polymarket-event" || url.pathname.startsWith("/events/slug/")) {
                return new Response(JSON.stringify(eventPayload), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/polymarket-history" || url.pathname === "/prices-history") {
                return new Response(JSON.stringify(historyPayload), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected fetch URL: ${url.pathname}`);
        }) as typeof fetch;

        const candles = await fetchPolymarketData(`https://polymarket.com/event/${slug}?outcome=yes`, "1m");

        expect(candles.map((candle) => candle.time)).to.deep.equal([960, 1020]);
        expect(candles[0]?.open).to.equal(0.10);
        expect(candles[0]?.close).to.equal(0.20);
        expect(candles[1]?.open).to.equal(0.30);
        expect(candles[1]?.close).to.equal(0.40);
    });
});
