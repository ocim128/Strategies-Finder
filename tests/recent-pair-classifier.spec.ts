import { expect } from "chai";
import { describe, it } from "node:test";
import {
    classifyRecentPair,
    compareRecentPairResults,
    RECENT_PAIR_WINDOW_BARS,
    type RecentPairResult,
} from "../lib/rank-pairs/recent-pair-classifier";
import type { OHLCVData, Time } from "../lib/types/strategies";

const END = Date.UTC(2025, 0, 1) / 1000;
const SPACING = 3600;

function candle(index: number, close: number): OHLCVData {
    return {
        time: (END - (RECENT_PAIR_WINDOW_BARS - 1 - index) * SPACING) as Time,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
    };
}

function series(logCloseAt: (index: number) => number, count = RECENT_PAIR_WINDOW_BARS): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => candle(index, Math.exp(logCloseAt(index))));
}

function sine(index: number, amplitude: number, offset = 0): number {
    return offset + amplitude * Math.sin((index * Math.PI) / 10);
}

describe("recent-pair-classifier", () => {
    it("uses only the latest 200 bars", () => {
        const bars = series((index) => index < 50 ? 2 : sine(index - 50, 0.05), 250);
        const result = classifyRecentPair(bars);
        expect(result.reason).to.equal("OK");
        expect(result.metrics.barCount).to.equal(RECENT_PAIR_WINDOW_BARS);
        expect(result.metrics.asOf).to.equal(END + 50 * SPACING);
    });

    it("classifies stable, expanding, and compressing ranges as A, B, and C", () => {
        const stable = classifyRecentPair(series((index) => sine(index, 0.05)));
        const expanding = classifyRecentPair(series((index) => {
            const amplitude = index < 100 ? 0.02 + index * 0.0001 : 0.06 + (index - 100) * 0.0004;
            return amplitude * Math.sin((index * Math.PI) / 10);
        }));
        const compressing = classifyRecentPair(series((index) => {
            const amplitude = index < 100 ? 0.10 - index * 0.0004 : 0.06 - (index - 100) * 0.0004;
            return amplitude * Math.sin((index * Math.PI) / 10);
        }));
        expect(stable.type).to.equal("A");
        expect(expanding.type).to.equal("B");
        expect(compressing.type).to.equal("C");
    });

    it("classifies directional trends as D and E", () => {
        const base = classifyRecentPair(series((index) => index * 0.004));
        const quote = classifyRecentPair(series((index) => -index * 0.004));
        expect(base.type).to.equal("D");
        expect(base.direction).to.equal("BASE");
        expect(quote.type).to.equal("E");
        expect(quote.direction).to.equal("QUOTE");
    });

    it("classifies a recent move out of a range as F", () => {
        const result = classifyRecentPair(series((index) => {
            if (index < 150) return sine(index, 0.05);
            return sine(149, 0.05) + (index - 149) * 0.01;
        }));
        expect(result.type).to.equal("F");
        expect(result.direction).to.equal("BASE");
    });

    it("classifies an established trend that changes direction as G", () => {
        const result = classifyRecentPair(series((index) => {
            if (index < 150) return index * 0.003;
            return 0.45 - (index - 149) * 0.008;
        }));
        expect(result.type).to.equal("G");
        expect(result.direction).to.equal("QUOTE");
    });

    it("classifies a stable step to a new level as H", () => {
        const result = classifyRecentPair(series((index) =>
            sine(index % 100, 0.03, index < 100 ? 0 : 0.60),
        ));
        expect(result.type).to.equal("H");
        expect(result.direction).to.equal("BASE");
    });

    it("classifies irregular movement as I and insufficient data as J", () => {
        const mixed = classifyRecentPair(series((index) => {
            const fraction = index / (RECENT_PAIR_WINDOW_BARS - 1);
            return 0.80 * (1 - Math.cos(fraction * Math.PI * 2)) / 2;
        }));
        const thin = classifyRecentPair(series((index) => index * 0.01, 199));
        expect(mixed.type).to.equal("I");
        expect(thin.type).to.equal("J");
        expect(thin.reason).to.equal("INSUFFICIENT_BARS");
    });

    it("preserves type ordering and symbol tie-breaking", () => {
        const make = (symbol: string, type: RecentPairResult["type"]): RecentPairResult => ({
            symbol,
            type,
            direction: "NEUTRAL",
            label: `TYPE ${type}`,
            reason: "OK",
            metrics: {
                barCount: 200,
                asOf: END,
                ratioReturn: 0,
                logReturn: 0,
                pathEfficiency: 0,
                reversalRate: 0,
                volatilityRatio: 1,
                baselineTrendStrength: 0,
                recentTrendStrength: 0,
                levelShiftSigma: 0,
            },
        });
        const sorted = [
            make("C", "I"),
            make("B", "A"),
            make("A", "A"),
        ].sort(compareRecentPairResults);
        expect(sorted.map((result) => result.symbol)).to.deep.equal(["A", "B", "C"]);
    });
});
