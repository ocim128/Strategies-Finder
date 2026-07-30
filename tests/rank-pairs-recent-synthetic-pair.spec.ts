import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData } from "../lib/types/strategies";
import {
    buildRecentSyntheticPairCloseBars,
    normalizeRecentSyntheticLeg,
} from "../lib/rank-pairs/recent-synthetic-pair";
import {
    aggregateSyntheticBars,
    buildSyntheticPairDataset,
} from "../scripts/lib/synthetic-pair";

function bar(time: number, open: number, close: number): OHLCVData {
    return {
        time: time as OHLCVData["time"],
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 1,
    };
}

describe("rank-pairs recent synthetic close builder", () => {
    it("returns the latest aligned closes without materializing older pair bars", () => {
        const base = normalizeRecentSyntheticLeg([
            bar(60, 10, 12),
            bar(120, 12, 14),
            bar(180, 14, 16),
            bar(240, 16, 18),
        ]);
        const quote = normalizeRecentSyntheticLeg([
            bar(60, 2, 2),
            bar(120, 2, 2),
            bar(180, 2, 2),
            bar(240, 2, 2),
        ]);
        const result = buildRecentSyntheticPairCloseBars(base, quote, "1m", "1m", 2);
        expect(result.map((item) => [item.time, item.close])).to.deep.equal([
            [180, 8],
            [240, 9],
        ]);
    });

    it("uses the final source close in each target bucket", () => {
        const base = normalizeRecentSyntheticLeg([
            bar(0, 10, 10),
            bar(60, 12, 12),
            bar(120, 14, 14),
            bar(180, 16, 16),
        ]);
        const quote = normalizeRecentSyntheticLeg([
            bar(0, 2, 2),
            bar(60, 2, 2),
            bar(120, 2, 2),
            bar(180, 2, 2),
        ]);
        const result = buildRecentSyntheticPairCloseBars(base, quote, "1m", "2m", 2);
        expect(result.map((item) => [item.time, item.close])).to.deep.equal([
            [0, 6],
            [120, 8],
        ]);
    });

    it("matches the full synthetic build for the latest aggregated closes", () => {
        const baseBars = Array.from({ length: 500 }, (_, index) =>
            bar(index * 60, 100 + index * 0.2, 100.1 + index * 0.2));
        const quoteBars = Array.from({ length: 500 }, (_, index) =>
            bar(index * 60, 50 + index * 0.05, 50.1 + index * 0.05));
        quoteBars.splice(120, 1);
        quoteBars.splice(300, 1);

        const full = aggregateSyntheticBars(
            buildSyntheticPairDataset({
                base: baseBars,
                quote: quoteBars,
                interval: "1m",
            }).bars,
            "2m",
        ).slice(-200);
        const recent = buildRecentSyntheticPairCloseBars(
            normalizeRecentSyntheticLeg(baseBars),
            normalizeRecentSyntheticLeg(quoteBars),
            "1m",
            "2m",
            200,
        );
        expect(recent.map((item) => [item.time, item.close]))
            .to.deep.equal(full.map((item) => [item.time, item.close]));
    });
});
