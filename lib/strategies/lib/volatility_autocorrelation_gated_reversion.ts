import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingStdDev,
    buildRollingAutoCorrelation,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        acThreshold: Number(params.acThreshold ?? 0.20),
        zThreshold: Math.max(0.01, Number(params.zThreshold ?? 1.9)),
    };
}

export const volatility_autocorrelation_gated_reversion: Strategy = {
    name: "Volatility Autocorrelation Gated Reversion",
    description: "Fades ratio price z-score extremes when rolling autocorrelation of return volatility is high, indicating stable volatility boundaries.",
    defaultParams: {
        lookback: 35,
        acThreshold: 0.20,
        zThreshold: 1.9,
    },
    paramLabels: {
        lookback: "Lookback Window",
        acThreshold: "Autocorrelation Threshold",
        zThreshold: "Price Z-Score Threshold",
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

        const volAC = buildRollingAutoCorrelation(volClean, lookback, 1);
        const closeZ = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [volAC, closeZ], (i) => {
            const vac = volAC[i];
            const cz = closeZ[i];
            if (vac === null || cz === null) return null;

            // Buy: price z-score is extremely negative and volatility autocorrelation is positive/high
            if (cz < -p.zThreshold && vac > p.acThreshold) {
                return createBuySignal(cleanData, i, `Volatility AC gated buy: Close Z ${cz.toFixed(2)}, Vol AC ${vac.toFixed(2)}`);
            }
            // Sell: price z-score is extremely positive and volatility autocorrelation is positive/high
            if (cz > p.zThreshold && vac > p.acThreshold) {
                return createSellSignal(cleanData, i, `Volatility AC gated sell: Close Z ${cz.toFixed(2)}, Vol AC ${vac.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acThreshold", "zThreshold"],
    },
};
