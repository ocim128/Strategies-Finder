import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import { buildLogReturnSeries } from "./polymarket-1s-strategy-utils";
import { buildPolymarket1sActionabilityMask, buildPolymarket1sExecutableEdge } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming log close return skewness extremes map return asymmetry exhaustion
// #SUGGEST_VERIFY: Verify return skewness and executable edge alignment avoids buying negative edge outcomes
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
        skewThreshold: Math.max(0.1, Number(params.skewThreshold ?? 1.4)),
        minEdge: Math.max(0.0, Number(params.minEdge ?? 0.02)),
    };
}

export const skewness_asymmetry_executable_reversal: Strategy = {
    name: "Skewness Asymmetry Reversal with Executable Edge",
    description: "Trades return skewness exhaustion extremes on Binance, entering the contrarian reversion leg only when Polymarket presents an underpriced executable ask quote.",
    defaultParams: {
        lookback: 40,
        skewThreshold: 1.4,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Skewness Lookback",
        skewThreshold: "Skewness Threshold",
        minEdge: "Minimum Edge Magnitude",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const skewThreshold = p.skewThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback + 2) return [];

        const returns = buildLogReturnSeries(cleanData);
        const skewness = buildRollingSkewness(returns, lookback);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, { volLookback: lookback });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(
            cleanData,
            [skewness, edge.buyYesEdge, edge.buyNoEdge],
            (i) => {
                if (i < lookback + 1) return null;

                const skew = skewness[i];
                const buyYesEdge = edge.buyYesEdge[i];
                const buyNoEdge = edge.buyNoEdge[i];
                const yesActionable = actionability.yesActionable[i];
                const noActionable = actionability.noActionable[i];

                if (skew === null || buyYesEdge === null || buyNoEdge === null) return null;

                // Buy YES: rolling return skewness <= -skewThreshold, YES actionable, buyYesEdge >= minEdge
                if (skew <= -skewThreshold && yesActionable && buyYesEdge >= minEdge) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Skewness oversold buy YES: skew ${skew.toFixed(2)} <= -${skewThreshold}, edge ${buyYesEdge.toFixed(3)}`
                    );
                }

                // Buy NO (expressed as Sell signal): rolling return skewness >= skewThreshold, NO actionable, buyNoEdge >= minEdge
                if (skew >= skewThreshold && noActionable && buyNoEdge >= minEdge) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Skewness overbought buy NO: skew ${skew.toFixed(2)} >= ${skewThreshold}, edge ${buyNoEdge.toFixed(3)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold", "minEdge"],
    },
};
