import { expect } from "chai";
import { describe, it } from "node:test";
import { mapWithConcurrencyLimit } from "../lib/async-pool";

describe("mapWithConcurrencyLimit", () => {
    it("preserves input order while bounding concurrent workers", async () => {
        let active = 0;
        let peak = 0;

        const results = await mapWithConcurrencyLimit([30, 10, 20, 5], 2, async (delay, index) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, delay));
            active -= 1;
            return `${index}:${delay}`;
        });

        expect(results).to.deep.equal(["0:30", "1:10", "2:20", "3:5"]);
        expect(peak).to.equal(2);
    });

    it("falls back to one worker for invalid limits", async () => {
        let active = 0;
        let peak = 0;

        await mapWithConcurrencyLimit([1, 2, 3], Number.NaN, async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active -= 1;
        });

        expect(peak).to.equal(1);
    });
});
