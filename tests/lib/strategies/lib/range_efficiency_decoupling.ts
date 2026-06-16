import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        rangePct: Math.max(0, Math.min(1, Number(params.rangePct ?? 0.75))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.50))),
    };
}

export const range_efficiency_decoupling: Strategy = {
    name: "Range Efficiency Decoupling",
    description: "Follows clean, structured trend breakouts characterized by high range percentiles and high efficiency ratios.",
    defaultParams: {
        lookback: 30,
        rangePct: 0.75,
        efficiencyMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback Window",
        rangePct: "Min Range Percentile",
        efficiencyMin: "Min Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangePctl, efficiency], (i) => {
            const rp = rangePctl[i];
            const er = efficiency[i];
            if (rp === null || er === null) return null;

            const cl = closeLocation[i];

            if (rp > p.rangePct && er > p.efficiencyMin) {
                if (cl > 0.7) {
                    return createBuySignal(cleanData, i, `Range efficiency breakout buy: range rank ${rp.toFixed(2)}, ER ${er.toFixed(2)}`);
                }
                if (cl < 0.3) {
                    return createSellSignal(cleanData, i, `Range efficiency breakout sell: range rank ${rp.toFixed(2)}, ER ${er.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePct", "efficiencyMin"],
    },
};
