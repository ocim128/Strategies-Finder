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
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming typical price is near/touches or breaches the trailing rolling low/high boundaries
// #SUGGEST_VERIFY: Verify that the ATR threshold successfully filters out low-volatility ranging regimes
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 45))),
        atrMin: Math.max(0.01, Number(params.atrMin ?? 1.2)),
        minEdge: Math.max(0.0, Number(params.minEdge ?? 0.03)),
    };
}

export const boundary_proximity_volatility_arbitrage: Strategy = {
    name: "Boundary Proximity Volatility Arbitrage",
    description: "Fades extreme typical price deviations at range boundaries during high-volatility regimes on Binance, executing only when the Polymarket pressure gap confirms a massive mathematical underpricing.",
    defaultParams: {
        lookback: 45,
        atrMin: 1.2,
        minEdge: 0.03,
    },
    paramLabels: {
        lookback: "Lookback Window",
        atrMin: "Minimum ATR Value",
        minEdge: "Minimum Edge Magnitude",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const atrMin = p.atrMin as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback * 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);
        const typicalMinMax = buildRollingMinMax(typical, lookback, false);

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        return createSignalLoop(
            cleanData,
            [typicalMinMax.min, typicalMinMax.max, atr, pressure.longEdge, pressure.shortEdge],
            (i) => {
                if (i < lookback * 2) return null;

                const currentTypical = typical[i];
                const tMin = typicalMinMax.min[i];
                const tMax = typicalMinMax.max[i];
                const currentAtr = atr[i];
                const longEdge = pressure.longEdge[i];
                const shortEdge = pressure.shortEdge[i];

                if (tMin === null || tMax === null || currentAtr === null || longEdge === null || shortEdge === null) return null;

                // High volatility filter
                if (currentAtr < atrMin) return null;

                // Buy YES: typical price is <= trailing low and longEdge >= minEdge
                if (currentTypical <= tMin && longEdge >= minEdge) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Boundary fade YES: typical ${currentTypical.toFixed(2)} <= trailing low ${tMin.toFixed(2)}, ATR ${currentAtr.toFixed(3)}, edge ${longEdge.toFixed(3)}`
                    );
                }

                // Buy NO (expressed as Sell signal): typical price is >= trailing high and shortEdge >= minEdge
                if (currentTypical >= tMax && shortEdge >= minEdge) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Boundary fade NO: typical ${currentTypical.toFixed(2)} >= trailing high ${tMax.toFixed(2)}, ATR ${currentAtr.toFixed(3)}, edge ${shortEdge.toFixed(3)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrMin", "minEdge"],
    },
};
