import { describe, it } from "node:test";
import { expect } from "chai";
import { decodeBinaryOhlcvRows, encodeBinaryOhlcvRows } from "../lib/ohlcv-binary";

describe("OHLCV binary codec", () => {
    it("round-trips columnar OHLCV rows", () => {
        const rows = [
            { time: 1_700_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 12 },
            { time: 1_700_000_001, open: 100.5, high: 102, low: 100, close: 101.5, volume: 0 },
        ];

        const decoded = decodeBinaryOhlcvRows(encodeBinaryOhlcvRows(rows));

        expect(decoded).to.deep.equal(rows);
    });

    it("decodes from typed-array views without requiring a copied ArrayBuffer", () => {
        const rows = [
            { time: 1_700_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 12 },
        ];
        const encoded = new Uint8Array(encodeBinaryOhlcvRows(rows));
        const wrapped = new Uint8Array(encoded.byteLength + 1);
        wrapped.set(encoded, 1);

        const decoded = decodeBinaryOhlcvRows(wrapped.subarray(1));

        expect(decoded).to.deep.equal(rows);
    });

    it("rejects malformed binary payloads", () => {
        expect(decodeBinaryOhlcvRows(new ArrayBuffer(4))).to.equal(null);
    });
});
