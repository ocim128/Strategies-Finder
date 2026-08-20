import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Signal, Time } from "../lib/types/strategies";
import { mapSignalsFromHigherTimeframe } from "../lib/strategy-timeframe";
import {
    executeStrategyAcrossTimeGapSegments,
    type ContiguousTimeSegment,
} from "../lib/strategy-time-gap-isolation";
import { calculateWilliamsR } from "../lib/strategies/indicators";
import {
    buildRollingCorrelation,
    buildRollingMinMax,
} from "../lib/strategies/lib/price-action-statistics-core";

function bar(time: number, close: number): OHLCVData {
    return {
        time: time as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1,
    };
}

function expectedRollingCorrelation(
    series1: number[],
    series2: number[],
    lookback: number
): (number | null)[] {
    const length = Math.min(series1.length, series2.length);
    const result: (number | null)[] = new Array(length).fill(null);
    for (let i = lookback - 1; i < length; i++) {
        const window1 = series1.slice(i - lookback + 1, i + 1);
        const window2 = series2.slice(i - lookback + 1, i + 1);
        if (window1.some((value) => !Number.isFinite(value)) || window2.some((value) => !Number.isFinite(value))) {
            result[i] = Number.NaN;
            continue;
        }

        const mean1 = window1.reduce((sum, value) => sum + value, 0) / lookback;
        const mean2 = window2.reduce((sum, value) => sum + value, 0) / lookback;
        let covariance = 0;
        let variance1 = 0;
        let variance2 = 0;
        for (let j = 0; j < lookback; j++) {
            const delta1 = window1[j] - mean1;
            const delta2 = window2[j] - mean2;
            covariance += delta1 * delta2;
            variance1 += delta1 * delta1;
            variance2 += delta2 * delta2;
        }
        const denominator = Math.sqrt(variance1 * variance2);
        if (denominator > 0) result[i] = covariance / denominator;
    }
    return result;
}

describe("signal generation optimizations", () => {
    it("maps higher-timeframe signals to the last base bar in each bucket", () => {
        const baseData = [bar(0, 10), bar(60, 11), bar(120, 12), bar(180, 13)];
        const higherData = [bar(0, 10), bar(120, 12)];
        const higherSignals: Signal[] = [
            { time: 120 as Time, type: "buy", price: 12, barIndex: 1 },
            { time: 181 as Time, type: "sell", price: 13 },
        ];

        const mapped = mapSignalsFromHigherTimeframe(
            baseData,
            baseData.map((item) => ({ ...item })),
            higherData,
            higherSignals,
            "120s"
        );

        expect(mapped.map((signal) => signal.barIndex)).to.deep.equal([3, 3]);
        expect(mapped.map((signal) => signal.time)).to.deep.equal([180, 180]);
        expect(mapped.map((signal) => signal.price)).to.deep.equal([13, 13]);
    });

    it("resolves time-gap signals by bar index first and timestamps only as fallback", () => {
        const segment: ContiguousTimeSegment = {
            data: [bar(10, 10), bar(11, 11)],
            offset: 4,
        };
        const signals = executeStrategyAcrossTimeGapSegments({
            segments: [segment],
            executeSegment: () => [
                { time: 999 as Time, type: "buy", price: 10, barIndex: 1 },
                { time: 11 as Time, type: "sell", price: 11 },
            ],
        });

        expect(signals.map((signal) => signal.barIndex)).to.deep.equal([5, 5]);
        expect(signals.map((signal) => signal.time)).to.deep.equal([11, 11]);
    });

    it("keeps rolling correlation equivalent to the windowed formula and recovers after non-finite data leaves", () => {
        const series1 = [1e9, 1e9 + 0.25, Number.NaN, 1e9 + 0.75, 1e9 + 1, 1e9 + 1.25];
        const series2 = [2e9, 2e9 + 0.5, Number.NaN, 2e9 + 1.5, 2e9 + 2, 2e9 + 2.5];
        const actual = buildRollingCorrelation(series1, series2, 3);
        const expected = expectedRollingCorrelation(series1, series2, 3);

        expect(actual.length).to.equal(expected.length);
        for (let i = 0; i < expected.length; i++) {
            if (Number.isNaN(expected[i])) {
                expect(actual[i], `index ${i}`).to.be.NaN;
            } else if (expected[i] === null) {
                expect(actual[i], `index ${i}`).to.equal(null);
            } else {
                expect(actual[i], `index ${i}`).to.be.closeTo(expected[i]!, 1e-10);
            }
        }
    });

    it("keeps rolling min/max and Williams %R results unchanged while using deque heads", () => {
        const values = [3, 1, 4, 2, 5];
        expect(buildRollingMinMax(values, 3)).to.deep.equal({
            min: [null, null, 1, 1, 2],
            max: [null, null, 4, 4, 5],
        });
        expect(buildRollingMinMax(values, 3, false)).to.deep.equal({
            min: [null, null, null, 1, 1],
            max: [null, null, null, 4, 4],
        });

        expect(calculateWilliamsR(
            [10, 12, 11, 13],
            [1, 2, 3, 4],
            [5, 10, 8, 12],
            2
        )).to.deep.equal([
            null,
            -100 * (12 - 10) / (12 - 1),
            -100 * (12 - 8) / (12 - 2),
            -100 * (13 - 12) / (13 - 3),
        ]);
    });
});
