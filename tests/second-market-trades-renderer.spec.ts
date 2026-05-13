import { describe, it } from "node:test";
import { expect } from "chai";
import { TradesRenderer } from "../lib/renderers/tradesRenderer";
import type { Trade } from "../lib/types/strategies";

describe("second market trades renderer", () => {
    it("renders legacy resolve-hold annotations as final-outcome settlements instead of signal exits", () => {
        const trade: Trade = {
            id: 1,
            type: "long",
            entryTime: 1_700_000_010 as Trade["entryTime"],
            entryPrice: 100,
            exitTime: 1_700_000_020 as Trade["exitTime"],
            exitPrice: 101,
            pnl: 1,
            pnlPercent: 1,
            size: 1,
            exitReason: "take_profit",
            polymarketOutcome: {
                eventStartTs: 1_700_000_000,
                eventEndTs: 1_700_000_300,
                eventSlug: "btc-event",
                marketSlug: "btc-event",
                prediction: "yes",
                actualOutcomeUp: 1,
                isWin: true,
                evaluationMode: "resolve_hold",
                isProfitable: true,
                marketEntrySource: "quote",
                marketEntryStatus: "filled",
                marketEntryFillTs: 1_700_000_010,
                marketEntryPrice: 0.43,
                marketExitPrice: 1,
                marketExitTs: 1_700_000_300,
                marketExitSource: "resolution",
                marketPnl: 0.57,
            },
        };

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (
                value: Trade,
                formatPrice: (price: number) => string,
                formatDate: (time: Trade["entryTime"]) => string
            ) => string;
        };
        const html = renderer.renderTradeItem(
            trade,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly Win");
        expect(html).to.not.include("Poly Signal");
        expect(html).to.not.include("Signal-exit mode.");
    });
});
