import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildVarianceRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        max_vr: Math.max(0.1, Math.min(1.0, Number(params.max_vr ?? 0.70))),
    };
}

export const variance_ratio_subdiffusive_exhaustion_wick: Strategy = {
    name: "Variance Ratio Subdiffusive Exhaustion Wick",
    description: "Fades exhausted directional pushes with rejection wicks inside a confirmed subdiffusive regime.",
    defaultParams: {
        max_vr: 0.70,
    },
    paramLabels: {
        max_vr: "Maximum Variance Ratio",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const maxVr = Number(params.max_vr);
        const closes = getCloses(cleanData);

        const vr = buildVarianceRatio(closes, 30, 4);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vr, clsLoc], (i) => {
            if (i < 4) return null;
            const v = vr[i];
            const loc = clsLoc[i];
            if (v === null || loc === null) return null;

            if (v <= maxVr) {
                if (closes[i] < closes[i - 4] && loc >= 0.75) {
                    return createBuySignal(cleanData, i, `Bullish subdiffusive exhaustion fade: VR=${v.toFixed(2)}<=${maxVr}, closeLoc=${loc.toFixed(2)}>=0.75 on down-trend`);
                }
                if (closes[i] > closes[i - 4] && loc <= 0.25) {
                    return createSellSignal(cleanData, i, `Bearish subdiffusive exhaustion fade: VR=${v.toFixed(2)}<=${maxVr}, closeLoc=${loc.toFixed(2)}<=0.25 on up-trend`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_vr"],
    },
};
