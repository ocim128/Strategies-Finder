import { expect } from "chai";
import { describe, it } from "node:test";
import { mean, median, medianOrNull, percentile, percentileSorted, prepareSortedStats, sampleStdDev } from "./lib/statistics-utils";

describe("statistics utils", () => {
    it("computes central tendency for empty and populated samples", () => {
        expect(mean([])).to.equal(0);
        expect(median([])).to.equal(0);
        expect(mean([2, 4, 6, 8])).to.equal(5);
        expect(median([8, 2, 6, 4])).to.equal(5);
        expect(median([9, 1, 5])).to.equal(5);
    });

    it("computes sample standard deviation with Bessel correction", () => {
        expect(sampleStdDev([])).to.equal(0);
        expect(sampleStdDev([5])).to.equal(0);
        expect(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).to.be.closeTo(2.13809, 1e-5);
    });

    it("computes interpolated percentiles on unsorted inputs", () => {
        const values = [40, 10, 20, 30];

        expect(percentile([], 95)).to.equal(0);
        expect(percentile(values, 0)).to.equal(10);
        expect(percentile(values, 50)).to.equal(25);
        expect(percentile(values, 75)).to.equal(32.5);
        expect(percentile(values, 100)).to.equal(40);
    });

    it("medianOrNull distinguishes empty samples from zero", () => {
        expect(medianOrNull([])).to.equal(null);
        expect(medianOrNull([0, 0, 0])).to.equal(0);
        expect(medianOrNull([7, 3, 5, 9])).to.equal(6);
    });

    it("prepareSortedStats reuses one sort across mean, median, std dev, and percentiles", () => {
        const values = [40, 10, 30, 20];

        // Sanity: results must match the standalone helpers on identical input.
        const stats = prepareSortedStats(values);
        expect(stats.mean).to.equal(mean(values));
        expect(stats.median).to.equal(median(values));
        expect(stats.stdDev).to.be.closeTo(sampleStdDev(values), 1e-12);
        expect(stats.min).to.equal(10);
        expect(stats.max).to.equal(40);
        expect(stats.percentile(50)).to.equal(percentile(values, 50));
        expect(stats.percentile(95)).to.equal(percentile(values, 95));
        // Sorted copy must be ascending and independent of the caller's array.
        expect(stats.sorted).to.deep.equal([10, 20, 30, 40]);
        expect(values).to.deep.equal([40, 10, 30, 20]);
    });

    it("prepareSortedStats and percentileSorted handle empty input without throwing", () => {
        const stats = prepareSortedStats([]);
        expect(stats.mean).to.equal(0);
        expect(stats.percentile(95)).to.equal(0);
        expect(percentileSorted([], 50)).to.equal(0);
    });
});

