import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRollingMedian,
    buildRollingStdDev,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.8)),
        minVolPercentile: Math.max(0, Math.min(1, Number(params.minVolPercentile ?? 0.60))),
    };
}

export const median_reversion_volatility_squeeze: Strategy = {
    name: "Median Reversion Volatility Squeeze",
    description: "Fades deviations from the rolling median when rolling standard deviation is high.",
    defaultParams: {
        lookback: 30,
        zThreshold: 1.8,
        minVolPercentile: 0.60,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
        minVolPercentile: "Min Volatility Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        const devs = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            devs[i] = m !== null ? closes[i] - m : 0;
        }

        const devZ = buildRollingZScore(devs, lookback);
        const stdDev = buildRollingStdDev(closes, lookback);
        const stdDevNumbers = stdDev.map((v) => (v !== null ? v : 0));
        const volPctl = buildPercentileRank(stdDevNumbers, lookback);

        return createSignalLoop(cleanData, [median, devZ, volPctl], (i) => {
            const m = median[i];
            const z = devZ[i];
            const vp = volPctl[i];
            if (m === null || z === null || vp === null) return null;

            const close = closes[i];

            if (vp > p.minVolPercentile) {
                if (close < m && z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Median squeeze buy: Z ${z.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
                if (close > m && z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Median squeeze sell: Z ${z.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold", "minVolPercentile"],
    },
};
