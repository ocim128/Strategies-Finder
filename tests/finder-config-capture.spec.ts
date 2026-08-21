import { expect } from "chai";
import { describe, it } from "node:test";
import { captureTradeFilter, formatCapturedConfiguration } from "../lib/finder/finder-config-capture";

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

describe("finder config capture formatting", () => {
    it("inlines arrays of primitives on one line so symbol universes stay compact", () => {
        const text = formatCapturedConfiguration({
            finder: { symbols: ["AAPL•+SPY•", "ABBV•+SPY•"], oosHorizons: [12, 18, 24] },
        });
        expect(text).to.contain('"symbols": ["AAPL•+SPY•","ABBV•+SPY•"]');
        expect(text).to.contain('"oosHorizons": [12,18,24]');
        // A 500-symbol universe costs one line for the array, not 500.
        const lines = formatCapturedConfiguration({
            finder: { symbols: Array.from({ length: 500 }, (_, i) => `SYM${i}•+SPY•`) },
        }).split("\n");
        expect(lines).to.have.length(5);
    });

    it("still pretty-prints objects and mixed arrays, and round-trips as JSON", () => {
        const value = {
            batch: { startHoldoutBars: 12, endHoldoutBars: 160 },
            nested: [{ rank: 1, tags: ["a", "b"] }],
            empty: { list: [], map: {} },
            flag: null,
        };
        const text = formatCapturedConfiguration(value);
        expect(JSON.parse(text)).to.deep.equal(value);
        expect(text).to.contain('"batch": {\n\t\t"startHoldoutBars": 12');
        expect(text).to.contain('"list": []');
        expect(text).to.contain('"map": {}');
    });
});
