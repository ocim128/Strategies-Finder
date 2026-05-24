import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingMinMax } from "./polymarket-1s-strategy-utils";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming realized volatility compression (atrZscore <= atrZMax) locks in stable boundaries
// #SUGGEST_VERIFY: Verify boundary calculations and ATR z-scores behave correctly in highly compressed trading ranges
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 35))),
        atrZMax: Number(params.atrZMax ?? -1.2),
        minEdge: Math.max(0.0, Number(params.minEdge ?? 0.025)),
    };
}

export const volatility_distribution_width_arbitrage: Strategy = {
    name: "Volatility Distribution Width Arbitrage",
    description: "Exploits Polymarket's delay in adjusting mid-probabilities to a dramatic narrowing of the Binance price distribution width caused by a collapse in realized volatility.",
    defaultParams: {
        lookback: 35,
        atrZMax: -1.2,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Lookback Window",
        atrZMax: "Maximum ATR Z-Score",
        minEdge: "Minimum Edge Magnitude",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const atrZMax = p.atrZMax as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback * 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);
        const atrZ = buildRollingZScore(atr.map((v) => v ?? 0), lookback);
        const typicalMinMax = buildRollingMinMax(typical, lookback, false);

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        return createSignalLoop(
            cleanData,
            [typicalMinMax.min, typicalMinMax.max, atrZ, pressure.longEdge, pressure.shortEdge],
            (i) => {
                if (i < lookback * 2) return null;

                const currentTypical = typical[i];
                const tMin = typicalMinMax.min[i];
                const tMax = typicalMinMax.max[i];
                const z = atrZ[i];
                const longEdge = pressure.longEdge[i];
                const shortEdge = pressure.shortEdge[i];

                if (tMin === null || tMax === null || z === null || longEdge === null || shortEdge === null) return null;

                // Realized volatility collapse condition
                if (z > atrZMax) return null;

                const range = tMax - tMin;
                if (range <= 0) return null;

                const nearFloor = currentTypical <= tMin + 0.15 * range;
                const nearCeiling = currentTypical >= tMax - 0.15 * range;

                // Buy YES: typical price is near trailing low, ATR z-score <= atrZMax, and longEdge >= minEdge
                if (nearFloor && longEdge >= minEdge) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Vol width buy YES: atrZ ${z.toFixed(2)} <= ${atrZMax}, typical near floor, YES edge ${longEdge.toFixed(3)}`
                    );
                }

                // Buy NO (expressed as Sell signal): typical price is near trailing high, ATR z-score <= atrZMax, and shortEdge >= minEdge
                if (nearCeiling && shortEdge >= minEdge) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Vol width buy NO: atrZ ${z.toFixed(2)} <= ${atrZMax}, typical near ceiling, NO edge ${shortEdge.toFixed(3)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrZMax", "minEdge"],
    },
};
