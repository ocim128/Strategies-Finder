import { expect } from "chai";
import { describe, it } from "node:test";
import {
    getProviderScopedSeriesSymbol,
    normalizeUnderlyingPriceFeedSymbolValue,
    normalizePolymarketPriceFeedSymbolValue,
} from "../lib/polymarket-price-feed-utils";

describe("Underlying price feed helpers", () => {
    it("normalizes underlying crypto symbols for chainlink candles", () => {
        expect(normalizePolymarketPriceFeedSymbolValue("BTCUSDT")).to.equal("BTC");
        expect(normalizeUnderlyingPriceFeedSymbolValue("BTCUSDT")).to.equal("BTC");
        expect(normalizePolymarketPriceFeedSymbolValue("eth/usdt")).to.equal("ETH");
        expect(normalizePolymarketPriceFeedSymbolValue("SOL")).to.equal("SOL");
        expect(normalizePolymarketPriceFeedSymbolValue("PM:btc-above-100k-12345678:UP")).to.equal(null);
    });

    it("separates provider storage keys for the same symbol", () => {
        expect(getProviderScopedSeriesSymbol("BTCUSDT", "binance")).to.equal("BTCUSDT");
        expect(getProviderScopedSeriesSymbol("BTCUSDT", "chainlink")).to.equal("CHAINLINK:BTCUSDT");
        expect(getProviderScopedSeriesSymbol("BTCUSDT", "polymarket")).to.equal("POLYMARKET:BTCUSDT");
        expect(getProviderScopedSeriesSymbol("PM:btc-above-100k-12345678:UP", "polymarket", { isPolymarketEventSymbol: true }))
            .to.equal("PM:BTC-ABOVE-100K-12345678:UP");
    });
});
