import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeCloseAcceptanceCompressionNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        devThreshold: normalizeNumberParam(params.devThreshold, 1.2, 0),
    };
}

export const close_acceptance_compression_no_adverse: Strategy = {
    name: "Close Acceptance Compression with No Adverse Mask",
    description: "Fades typical-price deviations from a compressed close-location balance zone when the Polymarket side is actionable and non-adverse.",
    defaultParams: {
        lookback: 25,
        devThreshold: 1.2,
    },
    paramLabels: {
        lookback: "Lookback",
        devThreshold: "Deviation Threshold",
    },
    normalizeParams: normalizeCloseAcceptanceCompressionNoAdverseParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseAcceptanceCompressionNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const balanceCenter = buildRollingAverage(typicals, lookback);
        const closeLocationStdDev = buildRollingStdDev(buildCloseLocationSeries(cleanData), lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [balanceCenter, closeLocationStdDev], (i) => {
            const center = balanceCenter[i];
            const compression = closeLocationStdDev[i];
            if (center === null || compression === null || compression >= 0.15) return null;

            if (typicals[i] <= center - p.devThreshold && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Compressed close-location downside deviation with no adverse YES mask");
            }
            if (typicals[i] >= center + p.devThreshold && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Compressed close-location upside deviation with no adverse NO mask");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "devThreshold"],
    },
};
