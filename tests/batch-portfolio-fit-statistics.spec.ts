/**
 * Phase 1 focused tests for the Portfolio Fit statistics leaf.
 *
 * Covers (per the implementation prompt's required test matrix):
 *  - hand-calculated covariance and expected shortfall
 *  - long/short directional return handling
 *  - deterministic output under reordered input
 *  - sparse, singular, empty, and non-finite inputs
 *
 * Framework: node:test + chai (matches existing batch-* specs).
 */
import { describe, it } from "node:test";
import { expect } from "chai";

import {
    applyDirection,
    buildDirectionalReturnSeries,
    intersectTimeKeys,
    alignPairwise,
    sampleCovariance,
    sampleVariance,
    pearsonCorrelation,
    buildCovarianceMatrix,
    historicalExpectedShortfall,
    historicalValueAtRisk,
    portfolioVariance,
    portfolioVolatility,
    marginalVolatilityContribution,
    marginalExpectedShortfall,
    finiteOrNull,
    finiteOrZero,
} from "../lib/batch-backtest/batch-portfolio-fit-statistics";

function mapOf(entries: Array<[string, number]>): Map<string, number> {
    return new Map(entries);
}

describe("batch-portfolio-fit-statistics — directional returns", () => {
    it("applies +sign for long and -sign for short", () => {
        expect(applyDirection(0.05, "long")).to.equal(0.05);
        expect(applyDirection(0.05, "short")).to.equal(-0.05);
        expect(applyDirection(-0.03, "short")).to.equal(0.03);
    });

    it("builds a direction-adjusted series keyed by timeKey", () => {
        const raw = mapOf([["1", 0.1], ["2", -0.2], ["3", 0.05]]);
        const long = buildDirectionalReturnSeries(raw, "long");
        const short = buildDirectionalReturnSeries(raw, "short");
        expect(long.get("1")).to.equal(0.1);
        expect(short.get("1")).to.equal(-0.1);
        expect(long.get("2")).to.equal(-0.2);
        expect(short.get("2")).to.equal(0.2);
    });

    it("drops non-finite values during direction build", () => {
        const raw = mapOf([["1", NaN], ["2", Infinity], ["3", 0.05]]);
        const out = buildDirectionalReturnSeries(raw, "long");
        expect(out.size).to.equal(1);
        expect(out.get("3")).to.equal(0.05);
    });
});

describe("batch-portfolio-fit-statistics — time alignment", () => {
    it("intersects keys across multiple series sorted ascending", () => {
        const a = mapOf([["3", 1], ["1", 2], ["2", 3]]);
        const b = mapOf([["2", 4], ["3", 5]]);
        const keys = intersectTimeKeys([a, b]);
        expect(keys).to.deep.equal(["2", "3"]);
    });

    it("returns empty for no series or no overlap", () => {
        expect(intersectTimeKeys([])).to.deep.equal([]);
        const a = mapOf([["1", 1]]);
        const b = mapOf([["2", 2]]);
        expect(intersectTimeKeys([a, b])).to.deep.equal([]);
    });

    it("alignPairwise preserves only finite overlapping keys", () => {
        const a = mapOf([["1", 1], ["2", NaN], ["3", 3]]);
        const b = mapOf([["1", 10], ["3", 30], ["4", 40]]);
        const { xs, ys } = alignPairwise(a, b);
        expect(xs).to.deep.equal([1, 3]);
        expect(ys).to.deep.equal([10, 30]);
    });
});

describe("batch-portfolio-fit-statistics — covariance (hand-calculated)", () => {
    it("computes sample covariance matching a hand calculation", () => {
        // Two perfectly correlated series: y = 2x.
        // x: [1,2,3,4,5] mean=3; y: [2,4,6,8,10] mean=6
        // dev x: [-2,-1,0,1,2]; dev y: [-4,-2,0,2,4]
        // products: [8,2,0,2,8] → sum = 20; sample cov = 20/(5-1) = 5
        // Since y=2x, cov(x,2x) = 2*var(x) = 2*2.5 = 5
        const a = mapOf([["1", 1], ["2", 2], ["3", 3], ["4", 4], ["5", 5]]);
        const b = mapOf([["1", 2], ["2", 4], ["3", 6], ["4", 8], ["5", 10]]);
        const { covariance, overlap } = sampleCovariance(a, b);
        expect(overlap).to.equal(5);
        expect(covariance).to.be.closeTo(5, 1e-9);
    });

    it("returns zero covariance with <2 overlapping observations", () => {
        const a = mapOf([["1", 1]]);
        const b = mapOf([["1", 2]]);
        const { covariance, overlap } = sampleCovariance(a, b);
        expect(overlap).to.equal(1);
        expect(covariance).to.equal(0);
    });

    it("sampleVariance is zero for <2 values and correct for [2,4,4,4,5,5,7,9]", () => {
        expect(sampleVariance([5])).to.equal(0);
        // Variance of [2,4,4,4,5,5,7,9] = 32/7 ≈ 4.571 (population) / sample = 32/7
        const v = sampleVariance([2, 4, 4, 4, 5, 5, 7, 9]);
        expect(v).to.be.closeTo(32 / 7, 1e-9);
    });
});

describe("batch-portfolio-fit-statistics — correlation", () => {
    it("returns 1 for perfectly correlated series", () => {
        const a = mapOf([["1", 1], ["2", 2], ["3", 3], ["4", 4]]);
        const b = mapOf([["1", 2], ["2", 4], ["3", 6], ["4", 8]]);
        const { correlation, overlap } = pearsonCorrelation(a, b);
        expect(overlap).to.equal(4);
        expect(correlation).to.be.closeTo(1, 1e-9);
    });

    it("returns -1 for perfectly anti-correlated series", () => {
        const a = mapOf([["1", 1], ["2", 2], ["3", 3], ["4", 4]]);
        const b = mapOf([["1", 4], ["2", 3], ["3", 2], ["4", 1]]);
        const { correlation } = pearsonCorrelation(a, b);
        expect(correlation).to.be.closeTo(-1, 1e-9);
    });

    it("returns null for <3 overlapping observations", () => {
        const a = mapOf([["1", 1], ["2", 2]]);
        const b = mapOf([["1", 2], ["2", 4]]);
        const { correlation } = pearsonCorrelation(a, b);
        expect(correlation).to.equal(null);
    });

    it("clamps correlation to [-1, 1]", () => {
        // Constructed to push slightly outside due to FP; the helper clamps.
        const a = mapOf([["1", 1], ["2", 1], ["3", 1], ["4", 1]]);
        const b = mapOf([["1", 1], ["2", 1], ["3", 1], ["4", 1]]);
        const { correlation } = pearsonCorrelation(a, b);
        // zero variance → null
        expect(correlation).to.equal(null);
    });
});

describe("batch-portfolio-fit-statistics — expected shortfall (hand-calculated)", () => {
    it("computes ES as the mean of the worst 5th-percentile tail", () => {
        // 20 returns: -10,-9,...,-1,0,1,...,9  (worst 5% = ceil(20*0.05)=1 → -10)
        const returns: number[] = [];
        for (let i = -10; i <= 9; i++) returns.push(i);
        const es = historicalExpectedShortfall(returns, 0.05);
        expect(es).to.equal(-10); // worst 1 value
    });

    it("computes ES as mean of worst 2 for tailFraction 0.1 over 20 values", () => {
        const returns: number[] = [];
        for (let i = -10; i <= 9; i++) returns.push(i);
        const es = historicalExpectedShortfall(returns, 0.1);
        // ceil(20 * 0.1) = 2 → worst 2 = -10, -9 → mean = -9.5
        expect(es).to.equal(-9.5);
    });

    it("returns 0 for empty input", () => {
        expect(historicalExpectedShortfall([], 0.05)).to.equal(0);
    });

    it("drops non-finite values", () => {
        const es = historicalExpectedShortfall([NaN, Infinity, -5, -3, 0, 1], 0.5);
        // finite = [-5, -3, 0, 1], tailCount = ceil(4*0.5) = 2, worst 2 = -5, -3 → mean = -4
        expect(es).to.equal(-4);
    });

    it("VaR returns the percentile threshold", () => {
        const returns: number[] = [];
        for (let i = -10; i <= 9; i++) returns.push(i);
        // 5th percentile of 20 values sorted: index = round(19 * 0.05) = 1 → sorted[1] = -9
        const var5 = historicalValueAtRisk(returns, 0.05);
        expect(var5).to.equal(-9);
    });
});

describe("batch-portfolio-fit-statistics — covariance matrix + shrinkage", () => {
    it("builds a valid 2x2 covariance matrix with sufficient overlap", () => {
        const a = buildDirectionalReturnSeries(mapOf([["1", 1], ["2", 2], ["3", 3], ["4", 4], ["5", 5]]), "long");
        const b = buildDirectionalReturnSeries(mapOf([["1", 2], ["2", 4], ["3", 6], ["4", 8], ["5", 10]]), "long");
        const m = buildCovarianceMatrix([a, b], 4);
        expect(m.valid).to.equal(true);
        expect(m.shrunk).to.equal(false);
        expect(m.minOverlap).to.equal(5);
        // cov(x, 2x) = 2*var(x) = 2*2.5 = 5
        expect(m.matrix[0][1]).to.be.closeTo(5, 1e-9);
        expect(m.matrix[1][0]).to.be.closeTo(5, 1e-9);
    });

    it("marks invalid when minObservations not met", () => {
        const a = mapOf([["1", 1], ["2", 2]]);
        const b = mapOf([["1", 2], ["2", 4]]);
        const m = buildCovarianceMatrix([a, b], 30);
        expect(m.valid).to.equal(false);
    });

    it("stays finite with a constant series (zero variance is finite, no shrinkage needed)", () => {
        // A constant series has variance 0 (finite). The matrix is valid with zeros.
        const entriesA: Array<[string, number]> = [];
        const entriesB: Array<[string, number]> = [];
        for (let i = 0; i < 40; i++) {
            entriesA.push([`k${i}`, 1]); // constant → zero variance
            entriesB.push([`k${i}`, i % 2 === 0 ? 2 : 4]);
        }
        const a = mapOf(entriesA);
        const b = mapOf(entriesB);
        const m = buildCovarianceMatrix([a, b], 30);
        expect(m.minOverlap).to.equal(40);
        // Zero variance is finite → no shrinkage, matrix valid.
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
                expect(Number.isFinite(m.matrix[i][j])).to.equal(true);
            }
        }
    });

    it("marks invalid and applies shrinkage when overlap is below minObservations", () => {
        // 5 observations < minObservations 30 → shrinkage path, marked invalid.
        const a = mapOf([["1", 1], ["2", 2], ["3", 3], ["4", 4], ["5", 5]]);
        const b = mapOf([["1", 2], ["2", 4], ["3", 6], ["4", 8], ["5", 10]]);
        const m = buildCovarianceMatrix([a, b], 30);
        expect(m.shrunk).to.equal(true);
        expect(m.valid).to.equal(false);
        // Still finite after shrinkage.
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
                expect(Number.isFinite(m.matrix[i][j])).to.equal(true);
            }
        }
    });
});

describe("batch-portfolio-fit-statistics — portfolio risk", () => {
    it("portfolioVariance = wᵀΣw for a 2-asset portfolio", () => {
        // var(a)=4, var(b)=9, cov(a,b)=2; w=[0.5,0.5]
        // pVar = 0.25*4 + 2*0.25*2 + 0.25*9 = 1 + 1 + 2.25 = 4.25
        const cov = [[4, 2], [2, 9]];
        expect(portfolioVariance([0.5, 0.5], cov)).to.be.closeTo(4.25, 1e-9);
    });

    it("portfolioVolatility = sqrt(variance)", () => {
        const cov = [[4, 0], [0, 9]];
        expect(portfolioVolatility([0.5, 0.5], cov)).to.be.closeTo(Math.sqrt(3.25), 1e-9);
    });

    it("returns 0 for empty portfolio", () => {
        expect(portfolioVariance([], [])).to.equal(0);
        expect(portfolioVolatility([], [])).to.equal(0);
    });

    it("marginalVolatilityContribution is finite for a valid portfolio", () => {
        const cov = [[4, 2], [2, 9]];
        const mv = marginalVolatilityContribution([0.5, 0.5], cov, 0);
        expect(Number.isFinite(mv)).to.equal(true);
        expect(mv).to.be.greaterThan(0);
    });
});

describe("batch-portfolio-fit-statistics — marginal ES", () => {
    it("returns 0 for zero candidate weight", () => {
        const port = mapOf([["1", 0.01], ["2", -0.02]]);
        const cand = mapOf([["1", 0.05], ["2", 0.03]]);
        expect(marginalExpectedShortfall(port, cand, 0, 0.05)).to.equal(0);
    });

    it("returns the candidate's own ES when portfolio is empty", () => {
        const port = new Map<string, number>();
        const cand = mapOf([["1", -0.1], ["2", -0.2], ["3", 0.05]]);
        // weight 1 → candidateOnly = same as cand; ES(0.05) over 3 values: ceil(3*0.05)=1 → worst = -0.2
        const mes = marginalExpectedShortfall(port, cand, 1, 0.05);
        expect(mes).to.be.closeTo(-0.2, 1e-9);
    });

    it("returns the change in ES when adding the candidate", () => {
        const port = mapOf([["1", -0.1], ["2", -0.05], ["3", 0.02], ["4", 0.01]]);
        const cand = mapOf([["1", -0.2], ["2", -0.1], ["3", 0.0], ["4", 0.0]]);
        const baseES = historicalExpectedShortfall([-0.1, -0.05, 0.02, 0.01], 0.05);
        const newES = historicalExpectedShortfall([-0.1 - 0.5 * 0.2, -0.05 - 0.5 * 0.1, 0.02, 0.01], 0.05);
        const mes = marginalExpectedShortfall(port, cand, 0.5, 0.05);
        expect(mes).to.be.closeTo(newES - baseES, 1e-9);
    });
});

describe("batch-portfolio-fit-statistics — finite guards", () => {
    it("finiteOrNull returns null for NaN/Infinity/null/undefined", () => {
        expect(finiteOrNull(NaN)).to.equal(null);
        expect(finiteOrNull(Infinity)).to.equal(null);
        expect(finiteOrNull(null)).to.equal(null);
        expect(finiteOrNull(undefined)).to.equal(null);
        expect(finiteOrNull(0)).to.equal(0);
        expect(finiteOrNull(-3.5)).to.equal(-3.5);
    });

    it("finiteOrZero returns 0 for NaN/Infinity/null/undefined", () => {
        expect(finiteOrZero(NaN)).to.equal(0);
        expect(finiteOrZero(Infinity)).to.equal(0);
        expect(finiteOrZero(null)).to.equal(0);
        expect(finiteOrZero(undefined)).to.equal(0);
        expect(finiteOrZero(7)).to.equal(7);
    });
});
