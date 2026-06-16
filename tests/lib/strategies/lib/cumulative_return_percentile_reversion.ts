import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        pctlExtreme: Math.max(0.5, Math.min(0.999, Number(params.pctlExtreme ?? 0.9))),
    };
}

export const cumulative_return_percentile_reversion: Strategy = {
    name: "Cumulative Return Percentile Reversion",
    description: "Fades cumulative return over lookback when it sits at a percentile extreme of its own history.",
    defaultParams: {
        lookback: 30,
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

        const rollingSum = new Array<number>(cleanData.length).fill(0);
        let currentSum = 0;
        for (let i = 0; i < cleanData.length; i++) {
            currentSum += returns[i];
            if (i >= lookback) {
                currentSum -= returns[i - lookback];
            }
            rollingSum[i] = currentSum;
        }

        const pctRank = buildPercentileRank(rollingSum, lookback);

        return createSignalLoop(cleanData, [pctRank], (i) => {
            const pr = pctRank[i];
            if (pr === null) return null;

            // Buy: Cumulative return is at low percentile extreme
            if (pr < 1 - p.pctlExtreme) {
                return createBuySignal(cleanData, i, `Cumulative return percentile buy: pct ${pr.toFixed(2)}`);
            }
            // Sell: Cumulative return is at high percentile extreme
            if (pr > p.pctlExtreme) {
                return createSellSignal(cleanData, i, `Cumulative return percentile sell: pct ${pr.toFixed(2)}`);
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
