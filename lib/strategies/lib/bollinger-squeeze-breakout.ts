import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateBollingerBands } from "../indicators";

export const bollinger_squeeze_breakout: Strategy = {
    name: "Bollinger Squeeze Breakout",
    description: "Arms on minimum Bollinger width compression, then enters on the first close outside the band.",
    defaultParams: {
        bbPeriod: 20,
        bbStdDev: 2,
        squeezeLookback: 50,
    },
    paramLabels: {
        bbPeriod: "BB Period",
        bbStdDev: "BB Std Deviation",
        squeezeLookback: "Squeeze Lookback Bars",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 5) return [];

        const bbPeriod = Math.max(5, Math.round(params.bbPeriod ?? 20));
        const bbStdDev = Math.max(0.1, params.bbStdDev ?? 2);
        const squeezeLookback = Math.max(10, Math.round(params.squeezeLookback ?? 50));

        const closes = getCloses(cleanData);
        const { upper, middle, lower } = calculateBollingerBands(closes, bbPeriod, bbStdDev);

        const bbw: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = 0; i < cleanData.length; i++) {
            const u = upper[i];
            const m = middle[i];
            const l = lower[i];
            if (u === null || m === null || l === null || m === 0) continue;
            bbw[i] = (u - l) / Math.abs(m);
        }

        const signals: Signal[] = [];
        let squeezeArmed = false;

        for (let i = 1; i < cleanData.length; i++) {
            const bbwNow = bbw[i];
            const upperNow = upper[i];
            const lowerNow = lower[i];
            if (bbwNow === null || upperNow === null || lowerNow === null) continue;

            const start = Math.max(0, i - squeezeLookback + 1);
            let minBbw = Number.POSITIVE_INFINITY;
            for (let j = start; j <= i; j++) {
                const v = bbw[j];
                if (v !== null && v < minBbw) minBbw = v;
            }

            if (Number.isFinite(minBbw) && bbwNow <= minBbw) {
                squeezeArmed = true;
                continue;
            }

            if (!squeezeArmed) continue;

            const close = closes[i];
            if (close > upperNow) {
                signals.push(createBuySignal(cleanData, i, "BB squeeze breakout up"));
                squeezeArmed = false;
                continue;
            }

            if (close < lowerNow) {
                signals.push(createSellSignal(cleanData, i, "BB squeeze breakout down"));
                squeezeArmed = false;
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["bbPeriod", "bbStdDev", "squeezeLookback"],
    },
};

