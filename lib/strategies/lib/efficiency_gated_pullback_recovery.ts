import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

const EFFICIENCY_GATE = 0.5;
const PULLBACK_LOW_BAND = 0.4;
const PULLBACK_HIGH_BAND = 0.6;

function normalizeEfficiencyGatedPullbackRecoveryParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const efficiency_gated_pullback_recovery: Strategy = {
    name: "Efficiency Gated Pullback Recovery",
    description: "Buys recoveries back above the rolling median after a low-placed pullback bar, gated to efficient trends.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeEfficiencyGatedPullbackRecoveryParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeEfficiencyGatedPullbackRecoveryParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const medians = buildRollingMedian(closes, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [efficiency], (i) => {
            if (i < lookback) return null;
            const eff = efficiency[i];
            const medianNow = medians[i];
            const medianPrev = medians[i - 1];
            if (eff === null || medianNow === null || medianPrev === null) return null;

            if (eff >= EFFICIENCY_GATE && closeLocation[i - 1] < PULLBACK_LOW_BAND && closes[i - 1] <= medianPrev && closes[i] > medianNow) {
                return createBuySignal(cleanData, i, `Efficiency pullback buy: eff ${eff.toFixed(2)}, pullback bar recovered above median`);
            }
            if (eff >= EFFICIENCY_GATE && closeLocation[i - 1] > PULLBACK_HIGH_BAND && closes[i - 1] >= medianPrev && closes[i] < medianNow) {
                return createSellSignal(cleanData, i, `Efficiency pullback sell: eff ${eff.toFixed(2)}, overextension bar fell below median`);
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
