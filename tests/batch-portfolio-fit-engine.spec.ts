import { describe, it } from "node:test";
import { expect } from "chai";

import {
    estimateAdjustedEdge,
    evaluateEligibility,
    runPortfolioFit,
} from "../lib/batch-backtest/batch-portfolio-fit-engine";
import { formatPortfolioFitSummary } from "../lib/batch-backtest/batch-portfolio-fit-summary";
import { PORTFOLIO_FIT_DEFAULT_OPTIONS } from "../lib/batch-backtest/batch-portfolio-fit-types";
import type {
    BatchPortfolioFitInput,
    PortfolioFitTargetReturnSeries,
} from "../lib/batch-backtest/batch-portfolio-fit-types";
import type { BatchStabilityRow } from "../lib/batch-backtest/batch-stability-mine";

const NOW_MS = 1_700_000_000_000;

function row(asset: string, overrides: Partial<BatchStabilityRow> = {}): BatchStabilityRow {
    return {
        asset,
        direction: "LONG",
        hits: 30,
        high: 20,
        medium: 8,
        low: 2,
        medianRetPct: 2,
        medianLiftPct: 5,
        medianRr: 3,
        medianDist: 1,
        medianHmaxLiftPct: 2,
        pairWarnings: 0,
        timingEdgeScore: 75,
        medianDiversity: 0.7,
        asOfTimeKey: String(NOW_MS / 1000 - 300),
        close: 100,
        medianBarsHeld: 2,
        agreementTransition: 0.5,
        freshHits: 20,
        dominantPair: null,
        dominantPairShare: 0.3,
        ...overrides,
    };
}

function returns(asset: string, sign = 1, phase = 0): PortfolioFitTargetReturnSeries {
    return {
        asset,
        returns: new Map(Array.from({ length: 60 }, (_, index) => [
            `t${index}`,
            sign * (0.002 + Math.sin(index + phase) * 0.004),
        ])),
    };
}

function input(
    rows: BatchStabilityRow[],
    targetReturns: PortfolioFitTargetReturnSeries[],
    overrides: Partial<BatchPortfolioFitInput> = {},
): BatchPortfolioFitInput {
    return {
        fingerprint: "fp",
        interval: "5m",
        stability: {
            reruns: 50,
            subsetSize: 20,
            seed: 1,
            totalPairs: 20,
            targetAssets: rows.length,
            hitEvents: rows.reduce((sum, item) => sum + item.hits, 0),
            rows,
        },
        capital: {
            initialCapital: 10_000,
            baseAllocation: 1_000,
            kellyFraction: null,
            baseAllocationSource: "percent",
            configuredKellyFraction: null,
        },
        targetReturns,
        nowMs: NOW_MS,
        ...overrides,
    };
}

describe("Portfolio Fit eligibility and edge", () => {
    it("accepts a fresh Stability ENTER row", () => {
        const result = evaluateEligibility(row("AAA"), 50, "5m", NOW_MS);
        expect(result.eligible).to.equal(true);
        expect(result.stabilityAction).to.equal("ENTER");
    });

    it("normalizes Stability percent edge and applies a bounded haircut", () => {
        const result = estimateAdjustedEdge(row("AAA", { hits: 25, medianLiftPct: 2 }), 50, PORTFOLIO_FIT_DEFAULT_OPTIONS);
        expect(result.rawEdgeFraction).to.equal(0.02);
        expect(result.adjustedEdgeFraction!).to.be.within(0, 0.02);
    });
});

describe("Portfolio Fit allocation", () => {
    it("outputs only Stability ENTER candidates", () => {
        const enter = row("AAA");
        const invalid = row("BBB", { asOfTimeKey: null, hits: 0, freshHits: 0 });
        const result = runPortfolioFit(input([enter, invalid], [returns("AAA"), returns("BBB")]));
        expect(result.rows.map((item) => item.asset)).to.deep.equal(["AAA"]);
    });

    it("allocates the full resolved size in one attempt", () => {
        const result = runPortfolioFit(input([row("AAA")], [returns("AAA")]));
        expect(result.rows[0]!.decision).to.equal("ADD");
        expect(result.rows[0]!.allocationFraction).to.equal(0.1);
    });

    it("falls back once to half-size when full-size exceeds the gross cap", () => {
        const rows = [row("AAA", { medianLiftPct: 10 }), row("BBB", { medianLiftPct: 5 })];
        const result = runPortfolioFit(input(rows, [returns("AAA", 1, 0), returns("BBB", 1, 2)], {
            options: { totalGrossCapFraction: 0.15, correlationCap: 1, tailRiskIncreaseThreshold: 1 },
        }));
        const second = result.rows.find((item) => item.asset === "BBB")!;
        expect(second.decision).to.equal("ADD_SMALL");
        expect(second.allocationFraction).to.be.closeTo(0.05, 1e-12);
        expect(second.allocationLimitReasonCodes).to.deep.equal(["PORTFOLIO_CAP_REACHED"]);
    });

    it("rejects a redundant highly correlated candidate", () => {
        const sharedReturns = returns("AAA").returns;
        const result = runPortfolioFit(input(
            [row("AAA", { medianLiftPct: 10 }), row("BBB")],
            [{ asset: "AAA", returns: sharedReturns }, { asset: "BBB", returns: new Map(sharedReturns) }],
            { options: { correlationCap: 0.8, tailRiskIncreaseThreshold: 1 } },
        ));
        const second = result.rows.find((item) => item.asset === "BBB")!;
        expect(second.decision).to.equal("DEFER");
        expect(second.allocationFraction).to.equal(0);
        expect(second.reasonCodes).to.include("HIGH_CORRELATION");
    });

    it("defers a candidate when full and half allocations both increase tail risk", () => {
        const sharedReturns = returns("AAA").returns;
        const result = runPortfolioFit(input(
            [row("AAA", { medianLiftPct: 10 }), row("BBB")],
            [{ asset: "AAA", returns: sharedReturns }, { asset: "BBB", returns: new Map(sharedReturns) }],
            { options: { correlationCap: 1, tailRiskIncreaseThreshold: 0 } },
        ));
        const second = result.rows.find((item) => item.asset === "BBB")!;
        expect(second.decision).to.equal("DEFER");
        expect(second.allocationFraction).to.equal(0);
        expect(second.reasonCodes).to.deep.equal(["TAIL_RISK_INCREASE"]);
        expect(formatPortfolioFitSummary(result)).to.include(
            "PORTFOLIO_FIT | Candidates 2 | Accepted 1 | Deferred 1 | Rejected 0",
        );
    });

    it("uses direction-adjusted returns exactly once for shorts", () => {
        const result = runPortfolioFit(input(
            [row("AAA", { direction: "SHORT" })],
            [returns("AAA", -1)],
        ));
        expect(result.portfolio.expectedReturnPct!).to.be.greaterThan(0);
    });

    it("is deterministic under Stability row reordering", () => {
        const rows = [row("AAA"), row("BBB")];
        const series = [returns("AAA", 1, 0), returns("BBB", 1, 2)];
        const first = runPortfolioFit(input(rows, series, { options: { correlationCap: 1, tailRiskIncreaseThreshold: 1 } }));
        const second = runPortfolioFit(input([...rows].reverse(), [...series].reverse(), { options: { correlationCap: 1, tailRiskIncreaseThreshold: 1 } }));
        const weights = (result: typeof first) => Object.fromEntries(result.rows.map((item) => [item.asset, item.allocationFraction]));
        expect(weights(first)).to.deep.equal(weights(second));
        expect(first.portfolio).to.deep.equal(second.portfolio);
    });
});
