import { expect } from "chai";
import { describe, it } from "node:test";
import { computeExecutionLabPerformanceMetrics } from "../lib/execution-lab/execution-lab-metrics";

describe("Execution Lab performance metrics", () => {
    it("computes compact paper-trade metrics", () => {
        const metrics = computeExecutionLabPerformanceMetrics([
            { pnlUsd: 5 },
            { pnlUsd: -2 },
            { pnlUsd: 0 },
            { pnlUsd: 3 },
        ]);

        expect(metrics.trades).to.equal(4);
        expect(metrics.wins).to.equal(2);
        expect(metrics.losses).to.equal(1);
        expect(metrics.breakeven).to.equal(1);
        expect(metrics.winRatePct).to.equal(50);
        expect(metrics.totalPnlUsd).to.equal(6);
        expect(metrics.profitFactor).to.equal(4);
        expect(metrics.expectancyUsd).to.equal(1.5);
        expect(metrics.avgWinUsd).to.equal(4);
        expect(metrics.avgLossUsd).to.equal(-2);
    });

    it("uses infinite profit factor when there are wins and no losses", () => {
        const metrics = computeExecutionLabPerformanceMetrics([{ pnlUsd: 1 }]);

        expect(metrics.profitFactor).to.equal(Number.POSITIVE_INFINITY);
    });
});

