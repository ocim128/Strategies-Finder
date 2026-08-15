import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingEntropy } from "./price-action-statistics-core";

const ENTROPY_CEILING = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const return_sign_entropy_concentration: Strategy = {
    name: "Return Sign Entropy Concentration",
    description: "Continues the dominant direction when one-bar return signs are concentrated (low two-bin entropy).",
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

        const signSum = new Array<number>(cleanData.length).fill(0);
        let running = 0;
        for (let i = 0; i < signs.length; i++) {
            running += signs[i];
            if (i >= lookback) running -= signs[i - lookback];
            signSum[i] = running;
        }

        return createSignalLoop(cleanData, [entropy], (i) => {
            if (i < lookback) return null;
            const level = entropy[i];
            if (level === null || level > ENTROPY_CEILING) return null;

            if (signSum[i] > 0) {
                return createBuySignal(cleanData, i, `Concentrated bullish signs: entropy ${level.toFixed(2)}`);
            }
            if (signSum[i] < 0) {
                return createSellSignal(cleanData, i, `Concentrated bearish signs: entropy ${level.toFixed(2)}`);
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
