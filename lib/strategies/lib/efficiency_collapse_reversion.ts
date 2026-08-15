import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

const COLLAPSE_DELTA_BAND = 0.15;
const STRETCH_Z_BAND = 1.5;

function normalizeEfficiencyCollapseReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const efficiency_collapse_reversion: Strategy = {
    name: "Efficiency Collapse Reversion",
    description: "Fades closes still stretched from center when the efficiency ratio collapses in a single bar, the trend support dying underneath them.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeEfficiencyCollapseReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeEfficiencyCollapseReversionParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const z = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [efficiency], (i) => {
            if (i < lookback + 1) return null;
            const effNow = efficiency[i];
            const effPrev = efficiency[i - 1];
            const zScore = z[i];
            if (effNow === null || effPrev === null || zScore === null) return null;
            const collapse = effPrev - effNow;

            if (collapse > COLLAPSE_DELTA_BAND && zScore < -STRETCH_Z_BAND) {
                return createBuySignal(cleanData, i, `Efficiency collapse buy: eff dropped ${collapse.toFixed(2)}, close z ${zScore.toFixed(2)}`);
            }
            if (collapse > COLLAPSE_DELTA_BAND && zScore > STRETCH_Z_BAND) {
                return createSellSignal(cleanData, i, `Efficiency collapse sell: eff dropped ${collapse.toFixed(2)}, close z ${zScore.toFixed(2)}`);
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
