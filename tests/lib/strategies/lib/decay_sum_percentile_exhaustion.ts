import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import {
    buildCumulativeDecaySum,
    buildPercentileRank,
    buildRateOfChange,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        exhaustionPctl: Math.max(0.5, Math.min(1.0, Number(params.exhaustionPctl ?? 0.92))),
    };
}

export const decay_sum_percentile_exhaustion: Strategy = {
    name: "Decay Sum Percentile Exhaustion",
    description: "Fades proxy-volume-weighted return decay sum extremes.",
    defaultParams: {
        lookback: 30,
        exhaustionPctl: 0.92,
    },
    paramLabels: {
        lookback: "Lookback Window",
        exhaustionPctl: "Exhaustion Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const returns = buildRateOfChange(closes, 1);
        const retNumbers = returns.map((v) => (v !== null ? v : 0));

        const volZ = buildRollingZScore(volumes, lookback);

        const weightedReturns = new Array<number>(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            const vz = volZ[i];
            const weight = vz !== null ? Math.max(0, vz) : 0;
            weightedReturns[i] = retNumbers[i] * weight;
        }

        const decaySum = buildCumulativeDecaySum(weightedReturns, 0.15);
        const percentile = buildPercentileRank(decaySum, lookback);

        return createSignalLoop(cleanData, [percentile], (i) => {
            const pRank = percentile[i];
            if (pRank === null) return null;

            // Buy: volume-confirmed pressure has exhausted to the downside
            if (pRank < (1 - p.exhaustionPctl)) {
                return createBuySignal(cleanData, i, `Decay sum exhaustion buy: percentile ${pRank.toFixed(2)}`);
            }
            // Sell: volume-confirmed pressure has exhausted to the upside
            if (pRank > p.exhaustionPctl) {
                return createSellSignal(cleanData, i, `Decay sum exhaustion sell: percentile ${pRank.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "exhaustionPctl"],
    },
};
