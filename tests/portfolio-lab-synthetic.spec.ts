import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    buildSyntheticPairConnection,
    parsePortfolioSyntheticPairSymbol,
} from "../lib/portfolioLab/portfolio-lab-synthetic";
import type { OHLCVData } from "../lib/types/strategies";

function bar(time: number, close: number): OHLCVData {
    return {
        time: time as OHLCVData["time"],
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
    };
}

describe("Portfolio Lab synthetic pair helpers", () => {
    it("preserves plus-pair intent while resolving Binance leg symbols", () => {
        const parsed = parsePortfolioSyntheticPairSymbol("near+apt");

        assert.deepEqual(parsed, {
            baseAsset: "NEAR",
            quoteAsset: "APT",
            baseSymbol: "NEARUSDT",
            quoteSymbol: "APTUSDT",
            syntheticSymbol: "NEARAPT",
        });
    });

    it("describes base versus quote leadership from the ratio move", () => {
        const parsed = parsePortfolioSyntheticPairSymbol("FET+APT");
        assert.ok(parsed);

        const connection = buildSyntheticPairConnection({
            parsed,
            ratioData: [bar(1, 2), bar(2, 3)],
            baseData: [bar(1, 10), bar(2, 15)],
            quoteData: [bar(1, 5), bar(2, 5)],
            alignedBars: 2,
            droppedBars: 0,
        });

        assert.equal(connection.baseAsset, "FET");
        assert.equal(connection.quoteAsset, "APT");
        assert.equal(connection.baseMovePercent, 50);
        assert.equal(connection.quoteMovePercent, 0);
        assert.equal(connection.ratioMovePercent, 50);
    });
});
