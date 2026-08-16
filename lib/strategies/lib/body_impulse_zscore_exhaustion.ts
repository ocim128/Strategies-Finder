import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    ensureCleanData,
    createSignalLoop,
    createBuySignal,
    createSellSignal
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const body_impulse_zscore_exhaustion: Strategy = {
    name: "Body Impulse Z-Score Exhaustion",
    description: "Rolling z-score of candle body impulse exhausting into reversal.",
    defaultParams: {
        "lookback": 20
    },
    paramLabels: {
        "lookback": "Lookback Period"
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const bodyImpulses = cleanData.map(d => d.close - d.open);
        const zScores = buildRollingZScore(bodyImpulses, lookback);

        return createSignalLoop(cleanData, [zScores], (i) => {
            const z = zScores[i];
            if (z === null) return null;

            if (z < -1.35) {
                return createBuySignal(cleanData, i, `Body impulse downward exhaustion (${z.toFixed(2)}) buy`);
            }
            if (z > 1.35) {
                return createSellSignal(cleanData, i, `Body impulse upward exhaustion (${z.toFixed(2)}) sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"]
    }
};
