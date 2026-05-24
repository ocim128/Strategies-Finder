import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";
import { buildRollingMinMax } from "./price-action-statistics-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeBidAskAbsorptionNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        absorptionThreshold: normalizeNumberParam(params.absorptionThreshold, 0.7, 0.5, 1),
    };
}

export const bid_ask_absorption_no_adverse: Strategy = {
    name: "Microstructural Bid-Ask Absorption with No Adverse Mask",
    description: "Fades trailing extremes with opposite close-location absorption only when Polymarket no-adverse actionability allows the side.",
    defaultParams: {
        lookback: 20,
        absorptionThreshold: 0.7,
    },
    paramLabels: {
        lookback: "Lookback",
        absorptionThreshold: "Absorption Threshold",
    },
    normalizeParams: normalizeBidAskAbsorptionNoAdverseParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeBidAskAbsorptionNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const smoothedClv = buildRollingAverage(buildCloseLocationSeries(cleanData), lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, smoothedClv], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const clv = smoothedClv[i];
            if (low === null || high === null || clv === null) return null;

            if (typicals[i] <= low && clv >= p.absorptionThreshold && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Trailing low with bullish close-location absorption and no adverse YES mask");
            }
            if (typicals[i] >= high && clv <= 1 - p.absorptionThreshold && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Trailing high with bearish close-location absorption and no adverse NO mask");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "absorptionThreshold"],
    },
};
