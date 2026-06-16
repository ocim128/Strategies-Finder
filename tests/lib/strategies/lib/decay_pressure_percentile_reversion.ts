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
    buildCumulativeDecaySum,
    buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
        pctlExtreme: Math.max(0.5, Math.min(0.999, Number(params.pctlExtreme ?? 0.9))),
    };
}

export const decay_pressure_percentile_reversion: Strategy = {
    name: "Decay Pressure Percentile Reversion",
    description: "Fades an exponentially decayed sum of returns at its percentile extremes.",
    defaultParams: {
        lookback: 40,
        pctlExtreme: 0.9,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pctlExtreme: "Percentile Extreme",
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

        const decaySum = buildCumulativeDecaySum(returns, 0.15);
        const pctRank = buildPercentileRank(decaySum, lookback);

        return createSignalLoop(cleanData, [pctRank], (i) => {
            const pr = pctRank[i];
            if (pr === null) return null;

            // Buy: decay sum at low percentile extreme
            if (pr < 1 - p.pctlExtreme) {
                return createBuySignal(cleanData, i, `Decay sum percentile buy: pct ${pr.toFixed(2)}`);
            }
            // Sell: decay sum at high percentile extreme
            if (pr > p.pctlExtreme) {
                return createSellSignal(cleanData, i, `Decay sum percentile sell: pct ${pr.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctlExtreme"],
    },
};
