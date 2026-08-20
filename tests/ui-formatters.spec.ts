import { expect } from "chai";
import { describe, it } from "node:test";
import {
    formatNullableAdaptivePercentPoints,
    formatNullableAdaptiveSignedPercentPoints,
    formatNullableCurrency,
    formatNullableFixed,
    formatNullablePercentPoints,
    formatNullableSignedFixed,
    formatNullableSignedPercentPoints,
    formatScore,
} from "../lib/ui-formatters";

describe("shared UI formatter variants", () => {
    it("preserves nullable fixed and percent display sentinels", () => {
        expect(formatNullableFixed(null, 2)).to.equal("--");
        expect(formatNullableFixed(Infinity, 2, "-", "Inf")).to.equal("Inf");
        expect(formatNullablePercentPoints(12.345, 1)).to.equal("12.3%");
        expect(formatNullablePercentPoints(null, 1, "-")).to.equal("-");
    });

    it("preserves signed and adaptive display conventions", () => {
        expect(formatNullableSignedPercentPoints(0, 2)).to.equal("+0.00%");
        expect(formatNullableSignedPercentPoints(0, 2, "--", false)).to.equal("0.00%");
        expect(formatNullableSignedFixed(1.25, 1)).to.equal("+1.3");
        expect(formatNullableAdaptivePercentPoints(12.4)).to.equal("12%");
        expect(formatNullableAdaptiveSignedPercentPoints(-1.234)).to.equal("-1.23%");
        expect(formatNullableCurrency(-12)).to.equal("$-12.00");
    });

    it("keeps score formatting compact for Finder chips", () => {
        expect(formatScore(60)).to.equal("60");
        expect(formatScore(60.25)).to.equal("60.3");
        expect(formatScore(null)).to.equal("--");
    });
});
