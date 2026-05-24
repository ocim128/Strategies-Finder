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
import { buildRollingMinMax, buildTrailingWindowSpan } from "./polymarket-1s-strategy-utils";
import { buildPolymarket1sExecutableAgreementMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming typical price range compression can be evaluated by the z-score of the trailing typical price range span
// #SUGGEST_VERIFY: Verify compression and extreme boundaries under high volume z-scores represent valid passive absorption walls
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
        volZMin: Math.max(0.1, Number(params.volZMin ?? 1.6)),
    };
}

export const limit_wall_survival_arbitrage: Strategy = {
    name: "Limit Wall Survival Arbitrage",
    description: "Projects a highly elevated fair probability of event settlement on Binance due to massive passive limit order walls blocking price progress, secured under favorable Polymarket execution terms.",
    defaultParams: {
        lookback: 20,
        volZMin: 1.6,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volZMin: "Minimum Volume Z-Score",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const volZMin = p.volZMin as number;

        if (cleanData.length < lookback * 2) return [];

        const typical = getTypicalPrices(cleanData);
        const volumes = getVolumes(cleanData);

        const typicalMinMax = buildRollingMinMax(typical, lookback, false);
        const typicalRangeSpan = buildTrailingWindowSpan(typical, lookback);
        const typicalRangeZ = buildRollingZScore(typicalRangeSpan.map((v) => v ?? 0), lookback);
        const volZ = buildRollingZScore(volumes, lookback);

        const mask = buildPolymarket1sExecutableAgreementMask(cleanData, context, { volLookback: lookback });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [typicalMinMax.min, typicalMinMax.max, typicalRangeZ, volZ],
            (i) => {
                if (i < lookback * 2) return null;

                const currentTypical = typical[i];
                const tMin = typicalMinMax.min[i];
                const tMax = typicalMinMax.max[i];
                const rZ = typicalRangeZ[i];
                const vZ = volZ[i];
                const yesAllowed = mask.yesAllowed[i];
                const noAllowed = mask.noAllowed[i];

                if (tMin === null || tMax === null || rZ === null || vZ === null) return null;

                // High volume condition (passive absorption check)
                if (vZ < volZMin) return null;

                // Compressed range condition: z-score of trailing typical price range span <= 0.0
                if (rZ > 0.0) return null;

                const range = tMax - tMin;
                if (range <= 0) return null;

                // Typical price near trailing low (limit floor)
                const nearFloor = currentTypical <= tMin + 0.15 * range;
                // Typical price near trailing high (limit ceiling)
                const nearCeiling = currentTypical >= tMax - 0.15 * range;

                // Buy YES: typical price at floor, high volume, range compressed, yesAllowed is true
                if (nearFloor && yesAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Floor limit wall YES: volZ ${vZ.toFixed(2)}, rangeZ ${rZ.toFixed(2)}, typ ${currentTypical.toFixed(2)} close to min ${tMin.toFixed(2)}`
                    );
                }

                // Buy NO (expressed as Sell signal): typical price at ceiling, high volume, range compressed, noAllowed is true
                if (nearCeiling && noAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Ceiling limit wall NO: volZ ${vZ.toFixed(2)}, rangeZ ${rZ.toFixed(2)}, typ ${currentTypical.toFixed(2)} close to max ${tMax.toFixed(2)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volZMin"],
    },
};
