import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";
import { buildLogReturnSeries, buildRollingMinMax } from "./polymarket-1s-strategy-utils";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming rolling negative returns autocorrelation signifies high-frequency mean reversion regimes
// #SUGGEST_VERIFY: Verify under test that returns autocorrelation tracks closes correctly and respects autoCorrThreshold bounds
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 25))),
        autoCorrThreshold: Number(params.autoCorrThreshold ?? -0.22),
    };
}

export const negative_autocorrelation_fade_gamma_consensus: Strategy = {
    name: "Negative Autocorrelation Fade with Gamma Consensus",
    description: "Capitalizes on rapid high-frequency mean reversion on Binance indicated by highly negative returns autocorrelation at range boundaries, verified by Gamma consensus.",
    defaultParams: {
        lookback: 25,
        autoCorrThreshold: -0.22,
    },
    paramLabels: {
        lookback: "Autocorrelation Lookback",
        autoCorrThreshold: "Autocorrelation Threshold",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const autoCorrThreshold = p.autoCorrThreshold as number;

        if (cleanData.length < lookback * 2) return [];

        const typical = getTypicalPrices(cleanData);
        const returns = buildLogReturnSeries(cleanData);

        const autocorr = buildRollingAutoCorrelation(returns, lookback);
        const typicalMinMax = buildRollingMinMax(typical, lookback, false);

        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: lookback });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [autocorr, typicalMinMax.min, typicalMinMax.max],
            (i) => {
                if (i < lookback * 2) return null;

                const currentTypical = typical[i];
                const currentAutocorr = autocorr[i];
                const tMin = typicalMinMax.min[i];
                const tMax = typicalMinMax.max[i];
                const longAllowed = mask.longAllowed[i];
                const shortAllowed = mask.shortAllowed[i];

                if (currentAutocorr === null || tMin === null || tMax === null) return null;

                // High-frequency mean reversion regime condition
                if (currentAutocorr > autoCorrThreshold) return null;

                // Buy YES: rolling returns autocorrelation <= autoCorrThreshold, typical price touches trailing low, and longAllowed is true
                if (currentTypical <= tMin && longAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Autocorr mean reversion buy YES: autocorr ${currentAutocorr.toFixed(3)} <= ${autoCorrThreshold}, typical touched floor ${tMin.toFixed(2)}, Gamma consensus long allowed`
                    );
                }

                // Buy NO (expressed as Sell signal): rolling returns autocorrelation <= autoCorrThreshold, typical price touches trailing high, and shortAllowed is true
                if (currentTypical >= tMax && shortAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Autocorr mean reversion buy NO: autocorr ${currentAutocorr.toFixed(3)} <= ${autoCorrThreshold}, typical touched ceiling ${tMax.toFixed(2)}, Gamma consensus short allowed`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autoCorrThreshold"],
    },
};
