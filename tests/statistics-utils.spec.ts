import { expect } from "chai";
import { describe, it } from "node:test";
import { mean, median, percentile, sampleStdDev } from "./lib/statistics-utils";

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
});
