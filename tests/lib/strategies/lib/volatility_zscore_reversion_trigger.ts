import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingStdDev, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        volZThreshold: Math.max(0.01, Number(params.volZThreshold ?? 2.0)),
    };
}

export const volatility_zscore_reversion_trigger: Strategy = {
    name: "Volatility Z-Score Reversion Trigger",
    description: "Fades ratio price moves when the rolling volatility of returns reaches an extreme z-score, signaling volatility exhaustion.",
    defaultParams: {
        lookback: 30,
        volZThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volZThreshold: "Vol Z-Score Threshold",
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

        const volZ = buildRollingZScore(volClean, lookback);
        const retZ = buildRollingZScore(returns, lookback);

        return createSignalLoop(cleanData, [volZ, retZ], (i) => {
            const vz = volZ[i];
            const rz = retZ[i];
            if (vz === null || rz === null) return null;

            // Buy: downside return stretch and extreme return volatility
            if (rz < -1.5 && vz > p.volZThreshold) {
                return createBuySignal(cleanData, i, `Volatility Z-Score reversion buy: Vol Z ${vz.toFixed(2)}, Return Z ${rz.toFixed(2)}`);
            }
            // Sell: upside return stretch and extreme return volatility
            if (rz > 1.5 && vz > p.volZThreshold) {
                return createSellSignal(cleanData, i, `Volatility Z-Score reversion sell: Vol Z ${vz.toFixed(2)}, Return Z ${rz.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volZThreshold"],
    },
};
