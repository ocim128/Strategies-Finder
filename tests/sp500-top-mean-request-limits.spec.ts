import { expect } from "chai";
import { describe, it } from "node:test";
import {
    TOP_MEAN_HORIZONS_MAX_LENGTH,
    TOP_MEAN_HORIZONS_MAX_VALUE,
    TOP_MEAN_MAX_PAIRS_MAX,
    TOP_MEAN_STABILITY_DATES_MAX,
    TOP_MEAN_WORKER_COUNT_MAX,
    validateTopMeanRequestLimits,
} from "../lib/batch-backtest/sp500-top-mean-request-limits";

describe("validateTopMeanRequestLimits", () => {
    it("accepts legitimate UI-shaped values", () => {
        const result = validateTopMeanRequestLimits({
            horizons: [12, 24, 48],
            workerCount: 4,
            maxPairs: 2000,
            stabilityStartDates: [1_700_000_000],
        });
        expect(result.ok).to.equal(true);
        if (result.ok) {
            expect(result.value.horizons).to.deep.equal([12, 24, 48]);
            expect(result.value.workerCount).to.equal(4);
            expect(result.value.maxPairs).to.equal(2000);
            expect(result.value.stabilityStartDates).to.deep.equal([1_700_000_000]);
        }
    });

    it("rejects empty, non-integer, zero, duplicate, oversized, and too-many horizons", () => {
        expect(validateTopMeanRequestLimits({ horizons: [] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [1.5] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [0] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [-3] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12, 12] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [TOP_MEAN_HORIZONS_MAX_VALUE + 1] }).ok).to.equal(false);
        const tooMany = Array.from({ length: TOP_MEAN_HORIZONS_MAX_LENGTH + 1 }, (_, i) => i + 1);
        expect(validateTopMeanRequestLimits({ horizons: tooMany }).ok).to.equal(false);
    });

    it("rejects workerCount / maxPairs / stabilityStartDates outside the documented bounds", () => {
        expect(validateTopMeanRequestLimits({ horizons: [12], workerCount: 0 }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12], workerCount: TOP_MEAN_WORKER_COUNT_MAX + 1 }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12], maxPairs: 0 }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12], maxPairs: TOP_MEAN_MAX_PAIRS_MAX + 1 }).ok).to.equal(false);
        const tooManyDates = Array.from({ length: TOP_MEAN_STABILITY_DATES_MAX + 1 }, () => 1_700_000_000);
        expect(validateTopMeanRequestLimits({ horizons: [12], stabilityStartDates: tooManyDates }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12], stabilityStartDates: [Number.NaN] }).ok).to.equal(false);
    });
});
