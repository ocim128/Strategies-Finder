/** Rendering checks for the heatmap colour mapping: intensity must grow with
 * magnitude, zero reads neutral, and missing cells stay visually distinct. */
import { expect } from "chai";
import { describe, it } from "node:test";
import { cellFillColor, type CellFillTokens } from "../lib/asset-opportunity-explorer/renderer";

const tokens: CellFillTokens = {
    positive: "hsl(145 72% 42%)",
    negative: "hsl(2 82% 58%)",
    neutral: "hsl(220 12% 50%)",
    missing: "hsl(225 22% 16%)",
};

function alphaOf(fill: string): number | null {
    const match = /\/ ([0-9.]+)\)$/.exec(fill);
    return match ? Number(match[1]) : null;
}

describe("Asset Opportunity Explorer heatmap colours", () => {
    it("raises intensity with magnitude for positive extremes", () => {
        const atMax = cellFillColor(10, 10, tokens);
        const atHalf = cellFillColor(5, 10, tokens);
        const nearZero = cellFillColor(0.5, 10, tokens);

        expect(atMax).to.contain(tokens.positive.slice(0, tokens.positive.indexOf(")")));
        expect(alphaOf(atMax)).to.equal(1);
        expect(alphaOf(atHalf)!).to.be.greaterThan(alphaOf(nearZero)!);
        expect(alphaOf(nearZero)!).to.be.greaterThan(0);
    });

    it("raises intensity with magnitude for negative extremes", () => {
        const atMin = cellFillColor(-10, 10, tokens);
        const atHalf = cellFillColor(-5, 10, tokens);

        expect(atMin).to.contain(tokens.negative.slice(0, tokens.negative.indexOf(")")));
        expect(alphaOf(atMin)).to.equal(1);
        expect(alphaOf(atHalf)!).to.be.greaterThan(0);
        expect(alphaOf(atMin)!).to.be.greaterThan(alphaOf(atHalf)!);
    });

    it("gives exact zero a neutral fill that is neither hue nor missing", () => {
        const zero = cellFillColor(0, 10, tokens);
        expect(zero.startsWith(tokens.neutral.slice(0, tokens.neutral.indexOf(")")))).to.equal(true);
        expect(alphaOf(zero)).to.be.greaterThan(0);
        expect(zero).to.not.contain(tokens.positive.slice(0, tokens.positive.indexOf(")")));
        expect(zero).to.not.contain(tokens.negative.slice(0, tokens.negative.indexOf(")")));
        expect(zero).to.not.equal(tokens.missing);
    });

    it("renders missing and unobservable cells with the dedicated missing colour", () => {
        expect(cellFillColor(null, 10, tokens)).to.equal(tokens.missing);
        expect(cellFillColor(Number.NaN, 10, tokens)).to.equal(tokens.missing);
    });
});
