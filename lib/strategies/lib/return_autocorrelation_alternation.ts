import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    extractBarMetricSeries,
} from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

const AC_THRESHOLD = -0.30;
const CL_TAIL_BUY = 0.30;
const CL_TAIL_SELL = 0.70;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const return_autocorrelation_alternation: Strategy = {
    name: "Return Autocorrelation Alternation",
    description: "One-bar return alternation: fade only when bar-to-bar returns are actively mean-reverting.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const ac = buildRollingAutoCorrelation(returns, lookback, 1);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [ac], (i) => {
            const rAc = ac[i];
            if (rAc === null || rAc >= AC_THRESHOLD) return null;

            const cl = closeLocation[i];
            if (cl < CL_TAIL_BUY) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Return autocorrelation ${rAc.toFixed(2)} alternating with low CL ${cl.toFixed(2)}`
                );
            }
            if (cl > CL_TAIL_SELL) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Return autocorrelation ${rAc.toFixed(2)} alternating with high CL ${cl.toFixed(2)}`
                );
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
