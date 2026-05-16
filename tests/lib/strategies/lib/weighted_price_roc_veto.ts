import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getWeightedClosePrices,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeWeightedPriceRocVetoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        rocLookback: Math.max(1, Math.round(params.rocLookback ?? 10)),
        minWapRoc: Math.max(0, Number(params.minWapRoc ?? 0.0015)),
        maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.03)),
    };
}

export const weighted_price_roc_veto: Strategy = {
    name: "Weighted Price ROC Veto",
    description: "Trades volume-weighted close momentum unless Polymarket adverse pressure marks the move as overextended.",
    defaultParams: {
        rocLookback: 10,
        minWapRoc: 0.0015,
        maxAdverse: 0.03,
    },
    paramLabels: {
        rocLookback: "ROC Lookback",
        minWapRoc: "Minimum Weighted Price ROC",
        maxAdverse: "Max Adverse Pressure",
    },
    normalizeParams: normalizeWeightedPriceRocVetoParams,
    polymarket1sConfig: {
        required: true,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeWeightedPriceRocVetoParams(params);
        if (cleanData.length < (p.rocLookback as number) + 1) return [];

        const weightedCloseRoc = buildRateOfChange(getWeightedClosePrices(cleanData), p.rocLookback as number);
        const pressure = buildPolymarket1sPressureGap(cleanData, context.polymarket1s);

        return createSignalLoop(cleanData, [weightedCloseRoc], (i) => {
            const roc = weightedCloseRoc[i];
            const longAdverse = pressure.longAdverse[i];
            const shortAdverse = pressure.shortAdverse[i];
            if (roc === null || longAdverse === null || shortAdverse === null) return null;

            if (roc >= (p.minWapRoc as number) && longAdverse <= (p.maxAdverse as number)) {
                return createBuySignal(cleanData, i, `Weighted price ROC veto long ${roc.toFixed(4)}`);
            }
            if (roc <= -(p.minWapRoc as number) && shortAdverse <= (p.maxAdverse as number)) {
                return createSellSignal(cleanData, i, `Weighted price ROC veto short ${roc.toFixed(4)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rocLookback", "minWapRoc", "maxAdverse"],
    },
};





