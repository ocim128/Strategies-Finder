import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateMomentum } from "../indicators";

export const inside_bar_momentum_burst: Strategy = {
    name: "Inside Bar Momentum Burst",
    description: "Tracks inside-bar compression and enters when price bursts beyond the mother bar with momentum confirmation.",
    defaultParams: {
        minInsideBars: 1,
        breakoutBufferPct: 0.001,
        momentumLookback: 10,
    },
    paramLabels: {
        minInsideBars: "Min Consecutive Inside Bars",
        breakoutBufferPct: "Breakout Buffer (%)",
        momentumLookback: "Momentum Lookback",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const minInsideBars = Math.max(1, Math.round(params.minInsideBars ?? 1));
        const breakoutBufferPct = Math.max(0, params.breakoutBufferPct ?? 0.001);
        const momentumLookback = Math.max(2, Math.round(params.momentumLookback ?? 10));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const momentum = calculateMomentum(closes, momentumLookback);

        const signals: Signal[] = [];
        let insideCount = 0;
        let motherHigh = 0;
        let motherLow = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const isInside = highs[i] <= highs[i - 1] && lows[i] >= lows[i - 1];

            if (isInside) {
                if (insideCount === 0) {
                    motherHigh = highs[i - 1];
                    motherLow = lows[i - 1];
                }
                insideCount++;
                continue;
            }

            const mom = momentum[i];
            if (insideCount >= minInsideBars && mom !== null) {
                const upperBreak = motherHigh * (1 + breakoutBufferPct);
                const lowerBreak = motherLow * (1 - breakoutBufferPct);
                if (closes[i] > upperBreak && mom > 0) {
                    signals.push(createBuySignal(cleanData, i, "Inside bar momentum long break"));
                } else if (closes[i] < lowerBreak && mom < 0) {
                    signals.push(createSellSignal(cleanData, i, "Inside bar momentum short break"));
                }
            }

            insideCount = 0;
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["minInsideBars", "breakoutBufferPct", "momentumLookback"],
    },
};

