import { describe, it } from "node:test";
import { expect } from "chai";
import { normalizeRtdsReferenceMessage } from "../lib/second-market/polymarket-reference-sync";

describe("second market Polymarket reference prices", () => {
    it("normalizes RTDS crypto price updates for BTC and XRP", () => {
        const rows = normalizeRtdsReferenceMessage({
            topic: "crypto_prices",
            type: "update",
            timestamp: 1_753_314_084_421,
            payload: {
                symbol: "btcusdt",
                timestamp: 1_753_314_084_395,
                value: 67234.5,
            },
        }, 1_753_314_084_500);

        expect(rows).to.have.length(1);
        expect(rows[0].symbol).to.equal("BTCUSDT");
        expect(rows[0].reference_source).to.equal("crypto_prices");
        expect(rows[0].source_symbol).to.equal("btcusdt");
        expect(rows[0].source_ts_ms).to.equal(1_753_314_084_395);
        expect(rows[0].reference_price).to.equal(67234.5);
    });

    it("normalizes Chainlink slash symbols and carried-forward flags", () => {
        const rows = normalizeRtdsReferenceMessage({
            topic: "crypto_prices_chainlink",
            type: "update",
            timestamp: 1_753_314_084_421,
            payload: {
                symbol: "xrp/usd",
                timestamp: 1_753_314_084_395,
                value: 0.62,
                is_carried_forward: true,
            },
        }, 1_753_314_084_500);

        expect(rows).to.have.length(1);
        expect(rows[0].symbol).to.equal("XRPUSDT");
        expect(rows[0].reference_source).to.equal("crypto_prices_chainlink");
        expect(rows[0].is_carried_forward).to.equal(1);
        expect(rows[0].quality_flags).to.equal("carried_forward");
    });

    it("ignores unsupported RTDS symbols", () => {
        const rows = normalizeRtdsReferenceMessage({
            topic: "crypto_prices",
            type: "update",
            payload: {
                symbol: "ethusdt",
                timestamp: 1_753_314_084_395,
                value: 3456.78,
            },
        });

        expect(rows).to.deep.equal([]);
    });
});

