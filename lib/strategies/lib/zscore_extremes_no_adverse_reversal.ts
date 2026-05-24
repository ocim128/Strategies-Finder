import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming typical price rolling z-score identifies mathematical depletion zones
// #SUGGEST_VERIFY: Verify that buildPolymarket1sNoAdverseActionableMask correctly maps available asks on both YES/NO outcomes
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 25))),
        zThreshold: Math.max(0.1, Number(params.zThreshold ?? 2.2)),
    };
}

export const zscore_extremes_no_adverse_reversal: Strategy = {
    name: "Z-Score Extremes Reversal with No Adverse Mask",
    description: "Fades deep statistical typical price z-score deviations on Binance, entering contrarian positions only when verified by Polymarket's no-adverse actionability mask.",
    defaultParams: {
        lookback: 25,
        zThreshold: 2.2,
    },
    paramLabels: {
        lookback: "Z-Score Lookback",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const zThreshold = p.zThreshold as number;

        if (cleanData.length < lookback) return [];

        const typical = getTypicalPrices(cleanData);
        const zscore = buildRollingZScore(typical, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [zscore],
            (i) => {
                if (i < lookback) return null;

                const z = zscore[i];
                const yesAllowed = mask.yesAllowed[i];
                const noAllowed = mask.noAllowed[i];

                if (z === null) return null;

                // Buy YES: typical zscore <= -zThreshold and yesAllowed is true (no adverse pressure for YES ask)
                if (z <= -zThreshold && yesAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Z-Score oversold buy YES: zscore ${z.toFixed(2)} <= -${zThreshold}, YES allowed`
                    );
                }

                // Buy NO (expressed as Sell signal): typical zscore >= zThreshold and noAllowed is true
                if (z >= zThreshold && noAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Z-Score overbought buy NO: zscore ${z.toFixed(2)} >= ${zThreshold}, NO allowed`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
