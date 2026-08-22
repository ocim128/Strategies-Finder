import { expect } from "chai";
import { describe, it } from "node:test";
import { FinderParamSpace } from "../lib/finder/finder-param-space";
import type { FinderOptions } from "../lib/types/finder";

function makeOptions(mode: FinderOptions["mode"], maxRuns: number): FinderOptions {
    return {
        mode,
        maxRuns,
        rangePercent: 50,
        steps: 3,
        randomSeed: 1234,
    } as unknown as FinderOptions;
}

describe("Finder parameter space", () => {
    it("returns only the normalized default for a random single-run search", () => {
        const defaultParams = { period: 20, threshold: 0.25 };

        expect(new FinderParamSpace().generateParamSets(
            defaultParams,
            makeOptions("random", 1),
        )).to.deep.equal([defaultParams]);
    });

    it("keeps grid single-run searches on their existing default-first behavior", () => {
        expect(new FinderParamSpace().generateParamSets(
            { period: 20 },
            makeOptions("grid", 1),
        )).to.deep.equal([{ period: 20 }]);
    });
});
