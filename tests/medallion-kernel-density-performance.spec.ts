import { expect } from "chai";
import { describe, it } from "node:test";
import { buildRollingMedian } from "../lib/strategies/lib/price-action-statistics-core";
import { medallion_mean_reverting_kernel_density } from "../lib/strategies/lib/medallion_mean_reverting_kernel_density";
import type { OHLCVData, Time } from "../lib/types/strategies";

function buildData(length: number): OHLCVData[] {
    let close = 100;
    return Array.from({ length }, (_value, index) => {
        close += Math.sin(index * 0.31) * 0.8 + (((index * 7919) % 101) - 50) * 0.015;
        return {
            time: (1_700_000_000 + index * 300) as Time,
            open: close - 0.2,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000 + ((index * 3571) % 700),
        };
    });
}

function legacyDensityRanks(closes: number[], lookback: number): (number | null)[] {
    const result: (number | null)[] = new Array(closes.length).fill(null);
    for (let i = lookback - 1; i < closes.length; i += 1) {
        const window = closes.slice(i - lookback + 1, i + 1);
        const mean = window.reduce((sum, value) => sum + value, 0) / lookback;
        const variance = window.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / lookback;
        if (variance <= 0) {
            result[i] = 1;
            continue;
        }
        const bandwidth = 1.06 * Math.sqrt(variance) * Math.pow(lookback, -0.2);
        const scores = window.map((value) => window.reduce((density, other) => {
            const u = (value - other) / bandwidth;
            return density + Math.exp(-0.5 * u * u);
        }, 0));
        const currentScore = scores[lookback - 1]!;
        result[i] = scores.slice(0, -1).filter((score) => score < currentScore).length / (lookback - 1);
    }
    return result;
}

describe("Medallion kernel-density Finder hot path", () => {
    it("preserves legacy signal decisions while avoiding unnecessary density tails", () => {
        const data = buildData(320);
        const closes = data.map((bar) => bar.close);

        for (const [lookback, densityPercentile] of [[12, 0.1], [27, 0.2], [45, 0.35]] as const) {
            const median = buildRollingMedian(closes, lookback);
            const ranks = legacyDensityRanks(closes, lookback);
            const expected = data.flatMap((_bar, index) => {
                if (index < lookback || median[index] === null || ranks[index] === null || ranks[index]! >= densityPercentile) return [];
                return [{ barIndex: index, type: closes[index]! < median[index]! ? "buy" : "sell" }];
            });
            const actual = medallion_mean_reverting_kernel_density.execute(data, { lookback, densityPercentile })
                .map((signal) => ({ barIndex: signal.barIndex, type: signal.type }));

            expect(actual, `lookback=${lookback}`).to.deep.equal(expected);
        }
    });
});
