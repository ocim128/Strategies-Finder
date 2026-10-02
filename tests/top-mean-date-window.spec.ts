import { expect } from "chai";
import { describe, it } from "node:test";
import { parseTopMeanDateWindow, parseOptionalReplayDateWindow } from "../lib/batch-backtest/top-mean-date-window";

describe("TOP_MEAN date windows", () => {
    it("supports optional Batch sides with strict UTC dates and inclusive To", () => {
        expect(parseOptionalReplayDateWindow({ sampleFrom: " ", sampleTo: null }))
            .to.deep.equal({ sampleFromSec: undefined, sampleToSec: undefined });
        expect(parseOptionalReplayDateWindow({ sampleTo: "2024-02-29" }))
            .to.deep.equal({ sampleFromSec: undefined, sampleToSec: Date.UTC(2024, 2, 1) / 1000 - 1 });
        expect(parseOptionalReplayDateWindow({ sampleFrom: "2024-02-29" }).sampleFromSec)
            .to.equal(Date.UTC(2024, 1, 29) / 1000);
        for (const value of ["2024-02-30", "2024-2-01", "2024-01-01T12:00:00Z", 123, {}, []]) {
            expect(() => parseOptionalReplayDateWindow({ sampleFrom: value })).to.throw("Invalid sampleFrom date");
            expect(() => parseOptionalReplayDateWindow({ sampleTo: value })).to.throw("Invalid sampleTo date");
        }
        expect(() => parseOptionalReplayDateWindow({ sampleFrom: "2024-03-01", sampleTo: "2024-02-29" }))
            .to.throw("reversed");
    });
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
