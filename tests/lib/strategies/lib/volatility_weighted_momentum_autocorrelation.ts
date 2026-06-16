import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingStdDev, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        acThreshold: Number(params.acThreshold ?? 0.22),
    };
}

export const volatility_weighted_momentum_autocorrelation: Strategy = {
    name: "Volatility-Weighted Momentum Autocorrelation",
    description: "Follows volatility-weighted return momentum when autocorrelation confirms trend persistence.",
    defaultParams: {
        lookback: 30,
        acThreshold: 0.22,
    },
    paramLabels: {
        lookback: "Lookback Window",
        acThreshold: "Autocorrelation Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const roc1 = buildRateOfChange(closes, 1);
        const returns = roc1.map((v) => v ?? 0);

        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);

        const volWeightedRet = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const v = volClean[i];
            volWeightedRet[i] = v > 0 ? returns[i] / v : 0;
        }

        const ac = buildRollingAutoCorrelation(returns, lookback, 1);

        return createSignalLoop(cleanData, [ac], (i) => {
            const currentAc = ac[i];
            if (currentAc === null || i < 1) return null;

            const curVWR = volWeightedRet[i];
            const prevVWR = volWeightedRet[i - 1];

            // Buy: autocorrelation positive and volatility-weighted return is positive and rising
            if (currentAc > p.acThreshold && curVWR > 0 && curVWR > prevVWR) {
                return createBuySignal(cleanData, i, `Vol-weighted AC buy: AC ${currentAc.toFixed(2)}, VWR ${curVWR.toFixed(2)}`);
            }
            // Sell: autocorrelation positive and volatility-weighted return is negative and falling
            if (currentAc > p.acThreshold && curVWR < 0 && curVWR < prevVWR) {
                return createSellSignal(cleanData, i, `Vol-weighted AC sell: AC ${currentAc.toFixed(2)}, VWR ${curVWR.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acThreshold"],
    },
};
