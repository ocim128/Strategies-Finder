import { expect } from "chai";
import { describe, it } from "node:test";
import { captureTradeFilter } from "../lib/finder/finder-config-capture";

describe("finder config capture trade-filter normalization", () => {
    it("nulls the bounds when the toggle is off so a captured config cannot read as an enforced filter", () => {
        // The exact archive misread this guards against: minTrades 50 captured
        // verbatim next to tradeFilterEnabled: false was read as "strictly
        // enforced" — while the runners skipped filtering entirely.
        expect(captureTradeFilter({ tradeFilterEnabled: false, minTrades: 50, maxTrades: 60 })).to.deep.equal({
            tradeFilterEnabled: false,
            minTrades: null,
            maxTrades: null,
        });
    });

    it("keeps the bounds when the toggle is on", () => {
        expect(captureTradeFilter({ tradeFilterEnabled: true, minTrades: 10, maxTrades: 60 })).to.deep.equal({
            tradeFilterEnabled: true,
            minTrades: 10,
            maxTrades: 60,
        });
    });

    it("treats missing, non-numeric, or non-finite bounds as null even when enabled", () => {
        expect(captureTradeFilter({ tradeFilterEnabled: true })).to.deep.equal({
            tradeFilterEnabled: true,
            minTrades: null,
            maxTrades: null,
        });
        expect(captureTradeFilter({ tradeFilterEnabled: true, minTrades: Number.NaN, maxTrades: Number.POSITIVE_INFINITY })).to.deep.equal({
            tradeFilterEnabled: true,
            minTrades: null,
            maxTrades: null,
        });
    });

    it("treats a missing toggle as disabled", () => {
        expect(captureTradeFilter({ minTrades: 25 })).to.deep.equal({
            tradeFilterEnabled: false,
            minTrades: null,
            maxTrades: null,
        });
    });
});
