import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingEntropy, buildRollingZScore } from "./price-action-statistics-core";

const CHOP_ENTROPY_BAND = 0.9;
const STRETCH_Z_BAND = 2.0;

function normalizeEntropyChopGatedReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const entropy_chop_gated_reversion: Strategy = {
    name: "Entropy Chop Gated Reversion",
    description: "Fades stretched closes only while the two-bin sign entropy marks the market as measurably choppy.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeEntropyChopGatedReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeEntropyChopGatedReversionParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const entropy = buildRollingEntropy(returns, lookback, 2);
        const z = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [entropy, z], (i) => {
            if (i < lookback) return null;
            const chop = entropy[i];
            const zScore = z[i];
            if (chop === null || zScore === null) return null;

            if (chop > CHOP_ENTROPY_BAND && zScore < -STRETCH_Z_BAND) {
                return createBuySignal(cleanData, i, `Entropy chop reversion buy: entropy ${chop.toFixed(2)} bits, close z ${zScore.toFixed(2)}`);
            }
            if (chop > CHOP_ENTROPY_BAND && zScore > STRETCH_Z_BAND) {
                return createSellSignal(cleanData, i, `Entropy chop reversion sell: entropy ${chop.toFixed(2)} bits, close z ${zScore.toFixed(2)}`);
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
