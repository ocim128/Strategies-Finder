import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateADX, calculateParabolicSAR } from "../indicators";

export const parabolic_sar_flip_adx_gate: Strategy = {
    name: "Parabolic SAR Flip + ADX Gate",
    description: "Triggers on Parabolic SAR trend flips only when ADX confirms sufficient trend strength.",
    defaultParams: {
        sarAcceleration: 0.02,
        sarMax: 0.2,
        adxThreshold: 20,
    },
    paramLabels: {
        sarAcceleration: "SAR Acceleration Factor",
        sarMax: "SAR Max Acceleration",
        adxThreshold: "ADX Min Threshold",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 5) return [];

        const sarAcceleration = Math.max(0.001, params.sarAcceleration ?? 0.02);
        const sarMax = Math.max(sarAcceleration, params.sarMax ?? 0.2);
        const adxThreshold = Math.max(1, Math.min(100, params.adxThreshold ?? 20));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const sar = calculateParabolicSAR(highs, lows, sarAcceleration, sarAcceleration, sarMax);
        const adx = calculateADX(highs, lows, closes, 14);

        return createSignalLoop(cleanData, [sar, adx], (i) => {
            const adxNow = adx[i] as number;
            if (adxNow < adxThreshold) return null;

            const prevSar = sar[i - 1] as number;
            const currSar = sar[i] as number;
            const prevClose = closes[i - 1];
            const currClose = closes[i];

            const bullishFlip = prevSar >= prevClose && currSar < currClose;
            if (bullishFlip) {
                return createBuySignal(cleanData, i, "SAR bullish flip + ADX");
            }

            const bearishFlip = prevSar <= prevClose && currSar > currClose;
            if (bearishFlip) {
                return createSellSignal(cleanData, i, "SAR bearish flip + ADX");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["sarAcceleration", "sarMax", "adxThreshold"],
    },
};

