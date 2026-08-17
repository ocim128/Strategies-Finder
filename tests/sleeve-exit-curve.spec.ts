import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    assessExitQuestion,
    buildExitCurveEntries,
    buildRatioFourHourBars,
    computeSleeveExitCurve,
    evaluateForwardEntry,
    type ExitCurveEntry,
} from "../lib/research/sleeve-exit-curve";
import type { OHLCVData } from "../lib/types/strategies";

const T4H = 4 * 60 * 60;

function bar(index: number, open: number, high: number, low: number, close: number): OHLCVData {
    return {
        time: (1_700_000_000 + index * T4H) as OHLCVData["time"],
        open,
        high,
        low,
        close,
        volume: 1_000,
    };
}

describe("sleeve exit curve", () => {
    it("computes next-open entry, cost, MAE, MFE, and exposure arithmetic", () => {
        const bars = [
            bar(0, 99, 100, 98, 99),
            bar(1, 100, 105, 95, 102),
            bar(2, 102, 120, 90, 104),
            bar(3, 104, 115, 100, 110),
        ];
        const entry: ExitCurveEntry = { symbol: "TEST", bars, signalIndex: 0 };
        const observation = evaluateForwardEntry(entry, 3);
        assert.ok(observation);
        assert.equal(observation.entryPrice, 100);
        assert.equal(observation.exitPrice, 110);
        assert.ok(Math.abs(observation.netReturn - 0.097) < 1e-12);
        assert.ok(Math.abs(observation.mae + 0.1) < 1e-12);
        assert.ok(Math.abs(observation.mfe - 0.2) < 1e-12);
        assert.ok(Math.abs(observation.retPerExposureBar - 0.097 / 3) < 1e-12);
    });

    it("builds the ratio at 30m and aggregates the ratio bars into 4H buckets", () => {
        const baseStart = Math.floor(1_700_000_000 / T4H) * T4H;
        const base = Array.from({ length: 8 }, (_, index) => ({
            ...bar(index, 100 + index, 105 + index, 95 + index, 102 + index),
            time: (baseStart + index * 30 * 60) as OHLCVData["time"],
        }));
        const quote = Array.from({ length: 8 }, (_, index) => ({
            ...bar(index, 10, 10, 10, 10),
            time: (baseStart + index * 30 * 60) as OHLCVData["time"],
        }));
        const ratio = buildRatioFourHourBars(base, quote);
        assert.equal(ratio.length, 1);
        assert.equal(ratio[0]?.open, 10);
        assert.equal(ratio[0]?.close, 10.9);
        assert.equal(ratio[0]?.high, 11.2);
        assert.equal(ratio[0]?.low, 9.5);
    });

    it("uses a reproducible seeded random control and counts positive chronological blocks", () => {
        const bars = Array.from({ length: 12 }, (_, index) => {
            const close = index >= 1 && index <= 5 ? 101 : 99;
            return bar(index, 100, 102, 98, close);
        });
        const entries = buildExitCurveEntries("TEST", bars, Array.from({ length: 10 }, (_, index) => index));
        const series = [{ symbol: "TEST", bars }];
        const first = computeSleeveExitCurve("robustz", entries, series, { horizons: [1], randomSeed: 42 });
        const second = computeSleeveExitCurve("robustz", entries, series, { horizons: [1], randomSeed: 42 });
        assert.equal(first.horizons[0]?.positiveBlocks, 5);
        assert.deepEqual(first.controls, second.controls);
        assert.equal(first.controls[0]?.sampleSize, 10);
    });

    it("answers the registered ratio question from the 5/12-bar curves and block comparisons", () => {
        const bars = Array.from({ length: 24 }, (_, index) => bar(index, 100, 110, 100, index === 0 ? 100 : 110));
        const entries = buildExitCurveEntries("X/NVDA", bars, Array.from({ length: 10 }, (_, index) => index));
        const result = computeSleeveExitCurve("clearanceNVDA", entries, [{ symbol: "X/NVDA", bars }], {
            horizons: [5, 12],
            randomSeed: 42,
        });
        const assessment = assessExitQuestion(result);
        assert.equal(assessment.status, "YES");
        assert.equal(assessment.improvedExposureBlocks, 10);
        assert.ok((assessment.retentionRatio ?? 0) >= 0.8);
        assert.ok((assessment.retPerExposureImprovement ?? 0) >= 0.2);
    });
});
