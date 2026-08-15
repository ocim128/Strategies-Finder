import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingEntropy } from "./price-action-statistics-core";

const ENTROPY_CEILING = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const entropy_gated_breakout: Strategy = {
    name: "Entropy Gated Breakout",
    description: "Continues boundary breaks only out of directionally concentrated, low sign-entropy states.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const signs = returns.map((value) => (value === null ? 0 : Math.sign(value)));
        const entropy = buildRollingEntropy(signs, lookback, 2);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        return createSignalLoop(cleanData, [entropy, highest, lowest], (i) => {
            const level = entropy[i];
            const boundaryHigh = highest[i];
            const boundaryLow = lowest[i];
            if (level === null || boundaryHigh === null || boundaryLow === null) return null;
            if (level > ENTROPY_CEILING) return null;

            const bar = cleanData[i];
            if (bar.close > boundaryHigh) {
                return createBuySignal(cleanData, i, `Concentrated break above: entropy ${level.toFixed(2)}`);
            }
            if (bar.close < boundaryLow) {
                return createSellSignal(cleanData, i, `Concentrated break below: entropy ${level.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
