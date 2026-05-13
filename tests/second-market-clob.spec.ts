import { describe, it } from "node:test";
import { expect } from "chai";
import {
    applyClobWebSocketMessage,
    buildClobQuoteRow,
    createEmptyClobBookState,
    selectClobSubscriptionEvents,
} from "../lib/second-market/polymarket-clob-sync";
import type { SecondMarketPolymarketEvent } from "../lib/second-market/types";

const event: SecondMarketPolymarketEvent = {
    seriesId: "10684",
    symbol: "BTCUSDT",
    outcomeInterval: "5m",
    eventSlug: "btc-updown-5m",
    marketId: "market",
    conditionId: "condition",
    marketSlug: "btc-updown-5m",
    eventStartTs: 1_700_000_000,
    eventEndTs: 1_700_000_300,
    yesTokenId: "yes-token",
    noTokenId: "no-token",
};

describe("second market CLOB websocket parsing", () => {
    it("flattens price_change rows into YES and NO executable quotes", () => {
        const state = createEmptyClobBookState();
        applyClobWebSocketMessage(state, event, {
            event_type: "price_change",
            market: "condition",
            timestamp: "1700000010123",
            price_changes: [
                {
                    asset_id: "yes-token",
                    best_bid: "0.51",
                    best_ask: "0.53",
                },
                {
                    asset_id: "no-token",
                    best_bid: "0.47",
                    best_ask: "0.49",
                },
            ],
        }, 1_700_000_010_200);

        const row = buildClobQuoteRow(event, state, 1_700_000_010, 1_700_000_010_200);
        expect(row.yes_bid).to.equal(0.51);
        expect(row.yes_ask).to.equal(0.53);
        expect(row.no_bid).to.equal(0.47);
        expect(row.no_ask).to.equal(0.49);
        expect(row.source_ts_ms).to.equal(1_700_000_010_123);
        expect(row.quality_flags).to.equal("");
    });

    it("keeps CLOB subscriptions limited to active and near-future events", () => {
        const sampleTs = 1_700_000_100;
        const active = { ...event, eventStartTs: sampleTs - 100, eventEndTs: sampleTs + 200 };
        const next = {
            ...event,
            conditionId: "condition-next",
            yesTokenId: "yes-next",
            noTokenId: "no-next",
            eventStartTs: sampleTs + 200,
            eventEndTs: sampleTs + 500,
        };
        const expired = {
            ...event,
            conditionId: "condition-expired",
            yesTokenId: "yes-expired",
            noTokenId: "no-expired",
            eventStartTs: sampleTs - 500,
            eventEndTs: sampleTs,
        };
        const farFuture = {
            ...event,
            conditionId: "condition-far",
            yesTokenId: "yes-far",
            noTokenId: "no-far",
            eventStartTs: sampleTs + 1_000,
            eventEndTs: sampleTs + 1_300,
        };

        const selected = selectClobSubscriptionEvents([farFuture, expired, next, active], sampleTs, 300);

        expect(selected.map((item) => item.conditionId)).to.deep.equal(["condition", "condition-next"]);
    });
});
