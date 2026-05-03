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
import { calculateDonchianChannels, calculateKeltnerChannels } from "../indicators";

const DONCHIAN_KELTNER_MULTIPLIER = 2;

function normalizeDonchianKeltnerSqueezeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        donchian_period: Math.max(2, Math.round(Number(params.donchian_period ?? 20))),
        keltner_period: Math.max(2, Math.round(Number(params.keltner_period ?? 20))),
    };
}

export const donchian_keltner_squeeze: Strategy = {
    name: "Donchian Keltner Squeeze",
    description:
        "Signals Donchian boundary breaks that remain contained inside Keltner extremes for cleaner expansion entries.",
    defaultParams: {
        donchian_period: 20,
        keltner_period: 20,
    },
    paramLabels: {
        donchian_period: "Donchian Period",
        keltner_period: "Keltner Period",
    },
    normalizeParams: normalizeDonchianKeltnerSqueezeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDonchianKeltnerSqueezeParams(params);
        const donchianPeriod = p.donchian_period as number;
        const keltnerPeriod = p.keltner_period as number;
        const minLookback = Math.max(donchianPeriod, keltnerPeriod);
        if (cleanData.length < minLookback + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const donchian = calculateDonchianChannels(highs, lows, donchianPeriod);
        const keltner = calculateKeltnerChannels(highs, lows, closes, keltnerPeriod, keltnerPeriod, DONCHIAN_KELTNER_MULTIPLIER);

        return createSignalLoop(cleanData, [donchian.upper, donchian.lower, keltner.upper, keltner.lower], (i) => {
            const priorUpper = donchian.upper[i - 1];
            const priorLower = donchian.lower[i - 1];
            const keltnerUpper = keltner.upper[i];
            const keltnerLower = keltner.lower[i];
            if (priorUpper === null || priorLower === null || keltnerUpper === null || keltnerLower === null) return null;

            if (closes[i] > priorUpper && closes[i] < keltnerUpper) {
                return createBuySignal(cleanData, i, "Donchian breakout contained inside Keltner upper");
            }
            if (closes[i] < priorLower && closes[i] > keltnerLower) {
                return createSellSignal(cleanData, i, "Donchian breakdown contained inside Keltner lower");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["donchian_period", "keltner_period"],
    },
};
