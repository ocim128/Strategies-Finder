import { expect } from "chai";
import { describe, it } from "node:test";
import { calculateVolumeWeightedMedian } from "../../lib/strategies/trend-confirmation-indicators";

function referenceWeightedMedian(values: number[], volumes: number[], period: number): Array<number | null> {
    const result: Array<number | null> = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i += 1) {
        const window = values.slice(i - period + 1, i + 1)
            .map((value, offset) => ({
                value,
                index: i - period + 1 + offset,
                weight: Math.max(0, volumes[i - period + 1 + offset]!),
            }))
            .sort((left, right) => left.value - right.value || left.index - right.index);
        const totalWeight = window.reduce((sum, entry) => sum + entry.weight, 0);
        if (totalWeight <= 0) {
            const middle = period >> 1;
            result[i] = (period & 1)
                ? window[middle]!.value
                : (window[middle - 1]!.value + window[middle]!.value) / 2;
            continue;
        }

        const targetWeight = totalWeight / 2;
        let cumulativeWeight = 0;
        for (const entry of window) {
            cumulativeWeight += entry.weight;
            if (cumulativeWeight >= targetWeight) {
                result[i] = entry.value;
                break;
            }
        }
    }
    return result;
}

describe("trend confirmation indicators", () => {
    it("matches the weighted-median reference for positive volumes", () => {
        const values = [4, 2, 8, 2, 6, 3, 9, 1, 7, 5, 5, 10, 0, 4];
        const volumes = [3.5, 1.25, 8.75, 2.5, 5.5, 7.25, 4.5, 6.75, 2.25, 9.5, 1.5, 5.25, 4.75, 3.25];

        for (const period of [1, 2, 3, 5, 9]) {
            expect(calculateVolumeWeightedMedian(values, volumes, period))
                .to.deep.equal(referenceWeightedMedian(values, volumes, period));
        }
    });

    it("preserves the unweighted median fallback when the window has no volume", () => {
        expect(calculateVolumeWeightedMedian(
            [1, 10, 2, 9, 3, 8],
            [0, 0, 0, 0, 0, 0],
            3,
        )).to.deep.equal([null, null, 2, 9, 3, 8]);
    });
});
