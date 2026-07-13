import { describe, it } from "node:test";
import { expect } from "chai";

import { generateMockData, isMockSymbol } from "../lib/dataProviders/mock";
import { state } from "../lib/state";

describe("mock data provider", () => {
    it("generates one deterministic, valid OHLCV model", () => {
        const previousBars = state.mockChartBars;
        state.mockChartBars = 120;
        try {
            const first = generateMockData("MOCK_STOCK", "1h");
            const second = generateMockData("MOCK_STOCK", "1h");
            expect(first).to.deep.equal(second);
            expect(first).to.have.length(120);
            for (const candle of first) {
                expect(candle.high).to.be.at.least(Math.max(candle.open, candle.close));
                expect(candle.low).to.be.at.most(Math.min(candle.open, candle.close));
                expect(candle.low).to.be.greaterThan(0);
                expect(candle.volume).to.be.greaterThan(0);
            }
        } finally {
            state.mockChartBars = previousBars;
        }
    });

    it("only routes the three explicit mock symbols", () => {
        expect(isMockSymbol("MOCK_STOCK")).to.equal(true);
        expect(isMockSymbol("BTCUSDT")).to.equal(false);
    });
});
