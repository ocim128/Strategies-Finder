import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeMajorityOccupationMomentumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 60))),
    };
}

export const majority_occupation_momentum: Strategy = {
    name: "Majority Occupation Momentum",
    description: "Follows the side on which most recent bars closed relative to the rolling median.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeMajorityOccupationMomentumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMajorityOccupationMomentumParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const flags: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            flags[i] = m === null ? 0 : (closes[i] > m ? 1 : -1);
        }
        const occupation = buildRollingAverage(flags, lookback);

        return createSignalLoop(cleanData, [occupation], (i) => {
            if (i < lookback) return null;
            const occ = occupation[i];
            const m = median[i];
            if (occ === null || m === null) return null;

            if (occ > 0.4 && closes[i] > m) {
                return createBuySignal(cleanData, i, `Majority occupation ${occ.toFixed(2)} with close above median`);
            }
            if (occ < -0.4 && closes[i] < m) {
                return createSellSignal(cleanData, i, `Majority occupation ${occ.toFixed(2)} with close below median`);
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
