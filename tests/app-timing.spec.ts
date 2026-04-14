import { expect } from "chai";
import { describe, it } from "node:test";
import { getAppTimingSnapshot, markAppTiming, resetAppTiming } from "../lib/app-timing";

describe("App timing", () => {
    it("returns null when bootstrap has not completed", () => {
        resetAppTiming();
        expect(getAppTimingSnapshot()).to.equal(null);
    });

    it("computes durations from marks", () => {
        resetAppTiming();
        markAppTiming("bootstrapStart");
        markAppTiming("manifestLoadStart");
        markAppTiming("manifestLoadEnd");
        markAppTiming("bootstrapReady");

        const snapshot = getAppTimingSnapshot();
        expect(snapshot).to.not.equal(null);
        expect(snapshot!.bootstrapTotalMs).to.be.greaterThan(0);
        expect(snapshot!.manifestLoadMs).to.be.greaterThan(0);
    });

    it("computes zero for unset optional marks", () => {
        resetAppTiming();
        markAppTiming("bootstrapStart");
        markAppTiming("bootstrapReady");

        const snapshot = getAppTimingSnapshot();
        expect(snapshot!.manifestLoadMs).to.equal(0);
        expect(snapshot!.dataLoadMs).to.equal(0);
        expect(snapshot!.firstBacktestMs).to.equal(0);
    });
});
