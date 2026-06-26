import { expect } from "chai";
import { describe, it } from "node:test";
import type { Time } from "../lib/strategies";
import { calculateBacktestStats } from "../lib/strategies";
import { calculateAdvancedPerformanceAnalyticsFromEquityCurve } from "../lib/strategies/performance-metrics";

describe("advanced performance analytics", () => {
    it("computes advanced risk metrics from an equity curve and attaches them to backtest results", () => {
        const equityCurve = [
            { time: "2020-01-01T00:00:00Z" as Time, value: 10000 },
            { time: "2021-01-01T00:00:00Z" as Time, value: 12000 },
            { time: "2022-01-01T00:00:00Z" as Time, value: 9600 },
            { time: "2023-01-01T00:00:00Z" as Time, value: 13800 },
            { time: "2024-01-01T00:00:00Z" as Time, value: 11730 },
        ];

        const analytics = calculateAdvancedPerformanceAnalyticsFromEquityCurve(equityCurve);
        expect(analytics).to.not.equal(undefined);
        expect(analytics?.sampleCount).to.equal(4);
        expect(analytics?.sortinoRatio).to.be.closeTo(0.5751909785584858, 1e-12);
        expect(analytics?.calmarRatio).to.be.closeTo(0.20348313879423485, 1e-12);
        expect(analytics?.sterlingRatio).to.be.closeTo(0.4069662775884697, 1e-12);
        expect(analytics?.tailRatio).to.be.closeTo(2.087662337662337, 1e-12);
        expect(analytics?.skewness).to.be.closeTo(0.18155480760227474, 1e-12);
        expect(analytics?.kurtosis).to.be.closeTo(-2.215639031198124, 1e-12);
        expect(analytics?.valueAtRisk95).to.be.closeTo(19.25, 1e-12);
        expect(analytics?.conditionalValueAtRisk95).to.be.closeTo(20, 1e-12);
        expect(analytics?.ulcerIndex).to.be.closeTo(11.180339887498949, 1e-12);
        expect(analytics?.serenityIndex).to.be.closeTo(0.36400170449514696, 1e-12);
        expect(analytics?.cagr).to.be.closeTo(4.069662775884697, 1e-12);

        const result = calculateBacktestStats([], equityCurve, 10000, 11730, 2400, 20);
        expect(result.performanceAnalytics).to.not.equal(undefined);
        expect(result.performanceAnalytics?.tailRatio).to.be.closeTo(analytics?.tailRatio ?? 0, 1e-12);
        expect(result.performanceAnalytics?.ulcerIndex).to.be.closeTo(analytics?.ulcerIndex ?? 0, 1e-12);
    });

    it("collapses intraday samples before computing advanced metrics", () => {
        const dailyCurve = [
            { time: "2023-01-01T23:55:00Z" as Time, value: 10000 },
            { time: "2023-01-02T23:55:00Z" as Time, value: 10100 },
            { time: "2023-01-03T23:55:00Z" as Time, value: 10050 },
            { time: "2023-01-04T23:55:00Z" as Time, value: 10200 },
            { time: "2023-01-05T23:55:00Z" as Time, value: 10180 },
            { time: "2023-01-06T23:55:00Z" as Time, value: 10320 },
        ];
        const intradayCurve = [
            { time: "2023-01-01T00:05:00Z" as Time, value: 10000 },
            { time: "2023-01-01T23:55:00Z" as Time, value: 10000 },
            { time: "2023-01-02T00:05:00Z" as Time, value: 10000 },
            { time: "2023-01-02T23:55:00Z" as Time, value: 10100 },
            { time: "2023-01-03T00:05:00Z" as Time, value: 10100 },
            { time: "2023-01-03T23:55:00Z" as Time, value: 10050 },
            { time: "2023-01-04T00:05:00Z" as Time, value: 10050 },
            { time: "2023-01-04T23:55:00Z" as Time, value: 10200 },
            { time: "2023-01-05T00:05:00Z" as Time, value: 10200 },
            { time: "2023-01-05T23:55:00Z" as Time, value: 10180 },
            { time: "2023-01-06T00:05:00Z" as Time, value: 10180 },
            { time: "2023-01-06T23:55:00Z" as Time, value: 10320 },
        ];

        const dailyAnalytics = calculateAdvancedPerformanceAnalyticsFromEquityCurve(dailyCurve);
        const intradayAnalytics = calculateAdvancedPerformanceAnalyticsFromEquityCurve(intradayCurve);

        expect(intradayAnalytics?.sortinoRatio).to.be.closeTo(dailyAnalytics?.sortinoRatio ?? 0, 1e-12);
        expect(intradayAnalytics?.tailRatio).to.be.closeTo(dailyAnalytics?.tailRatio ?? 0, 1e-12);
        expect(intradayAnalytics?.ulcerIndex).to.be.closeTo(dailyAnalytics?.ulcerIndex ?? 0, 1e-12);
    });
});
