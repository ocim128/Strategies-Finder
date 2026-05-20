import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        extremePercentile: Math.max(0.01, Math.min(0.49, Number(params.extremePercentile ?? 0.15))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const typical_price_percentile_reversion_pressure_gap: Strategy = {
    name: "Typical Price Percentile Reversion Pressure Gap",
    description: "Capitalizes on extreme typical price percentile extensions on Binance that have over-stretched and begun reverting, entering counter-trend positions only when a significant Polymarket pressure gap confirms the contract is underpriced.",
    defaultParams: {
        lookback: 20,
        extremePercentile: 0.15,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Typical Price Lookback",
        extremePercentile: "Extreme Boundary Percentile",
        minEdge: "Minimum Same-Side Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const extremePercentile = p.extremePercentile as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback + 1) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const rank = buildPercentileRank(typicalPrices, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [rank, pressure.longEdge, pressure.shortEdge], (i) => {
            if (i < lookback + 1) return null;

            const currentRank = rank[i];
            const prevRank = rank[i - 1];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];

            if (currentRank === null || prevRank === null || longEdge === null || shortEdge === null) return null;

            // Buy: crosses back above extremePercentile from below
            if (prevRank < extremePercentile && currentRank >= extremePercentile && longEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Typical percentile reverted above ${extremePercentile} with long edge ${longEdge.toFixed(4)}`);
            }

            // Sell: crosses back below (1.0 - extremePercentile) from above
            const upperExtreme = 1.0 - extremePercentile;
            if (prevRank > upperExtreme && currentRank <= upperExtreme && shortEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Typical percentile reverted below ${upperExtreme.toFixed(2)} with short edge ${shortEdge.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "extremePercentile", "minEdge"],
    },
};
