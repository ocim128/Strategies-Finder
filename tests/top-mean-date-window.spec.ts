import { expect } from "chai";
import { describe, it } from "node:test";
import { parseTopMeanDateWindow } from "../lib/batch-backtest/top-mean-date-window";

describe("TOP_MEAN date windows", () => {
    it("keeps Full unbounded and makes Date range inclusive through UTC end of day", () => {
        expect(parseTopMeanDateWindow({ mode: "full", from: "ignored", to: "ignored" }))
            .to.deep.equal({ mode: "full" });
        expect(parseTopMeanDateWindow({ mode: "date_range", from: "2024-02-29", to: "2024-03-01" }))
            .to.deep.equal({
                mode: "date_range",
                sampleFromSec: Date.UTC(2024, 1, 29) / 1000,
                sampleToSec: Date.UTC(2024, 2, 2) / 1000 - 1,
            });
    });

    it("rejects malformed, impossible, and reversed date ranges", () => {
        expect(() => parseTopMeanDateWindow({ mode: "other" as never })).to.throw("dateMode");
        expect(() => parseTopMeanDateWindow({ mode: "date_range", from: "2024-2-01", to: "2024-03-01" })).to.throw("YYYY-MM-DD");
        expect(() => parseTopMeanDateWindow({ mode: "date_range", from: "2024-02-30", to: "2024-03-01" })).to.throw("not a valid UTC date");
        expect(() => parseTopMeanDateWindow({ mode: "date_range", from: "2024-04-01", to: "2024-03-01" })).to.throw("reversed");
    });
});
