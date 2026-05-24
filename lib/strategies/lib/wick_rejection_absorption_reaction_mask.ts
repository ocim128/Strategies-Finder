import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { computePriceActionBarMetrics } from "./price-action-frequency-core";
import { buildRollingMinMax } from "./polymarket-1s-strategy-utils";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming high-volume wick rejection maps passive taker absorption limits
// #SUGGEST_VERIFY: Verify wickRatio calculation (lowerWick / range for bottom, upperWick / range for top) matches standard bar metrics
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
        wickRatio: Math.max(0.01, Math.min(0.99, Number(params.wickRatio ?? 0.60))),
        lagSec: Math.max(1, Math.round(Number(params.lagSec ?? 4))),
    };
}

export const wick_rejection_absorption_reaction_mask: Strategy = {
    name: "Wick Rejection Absorption with Reaction Agreement Mask",
    description: "Detects high-volume passive absorption signature via extreme wick rejections on Binance, executing only when verified by Polymarket's reaction agreement mask.",
    defaultParams: {
        lookback: 20,
        wickRatio: 0.60,
        lagSec: 4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        wickRatio: "Wick Ratio Threshold",
        lagSec: "Lag Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const wickRatio = p.wickRatio as number;
        const lagSec = p.lagSec as number;

        if (cleanData.length < lookback * 2) return [];

        const typical = getTypicalPrices(cleanData);
        const volumes = getVolumes(cleanData);

        const typicalMinMax = buildRollingMinMax(typical, lookback, false);
        const volZ = buildRollingZScore(volumes, lookback);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, { volLookback: lookback, lagSec });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [typicalMinMax.min, typicalMinMax.max, volZ],
            (i) => {
                if (i < lookback * 2) return null;

                const currentTypical = typical[i];
                const tMin = typicalMinMax.min[i];
                const tMax = typicalMinMax.max[i];
                const vz = volZ[i];
                const longAllowed = mask.longAllowed[i];
                const shortAllowed = mask.shortAllowed[i];

                if (tMin === null || tMax === null || vz === null) return null;

                // High volume condition (absorption check)
                if (vz <= 1.2) return null;

                const bar = cleanData[i];
                const metrics = computePriceActionBarMetrics(bar);
                if (metrics.range <= 0) return null;

                // Lower wick ratio = lowerWick / range
                const lowerWickRatio = metrics.lowerWick / metrics.range;
                // Upper wick ratio = upperWick / range
                const upperWickRatio = metrics.upperWick / metrics.range;

                // Buy YES: typical price is at trailing low, lower wick ratio >= wickRatio, volume z-score > 1.2, and longAllowed is true
                if (currentTypical <= tMin && lowerWickRatio >= wickRatio && longAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Wick rejection floor buy YES: lowerWickRatio ${lowerWickRatio.toFixed(3)} >= ${wickRatio}, volZ ${vz.toFixed(2)}, YES allowed`
                    );
                }

                // Buy NO (expressed as Sell signal): typical price is at trailing high, upper wick ratio >= wickRatio, volume z-score > 1.2, and shortAllowed is true
                if (currentTypical >= tMax && upperWickRatio >= wickRatio && shortAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Wick rejection ceiling buy NO: upperWickRatio ${upperWickRatio.toFixed(3)} >= ${wickRatio}, volZ ${vz.toFixed(2)}, NO allowed`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "wickRatio", "lagSec"],
    },
};
