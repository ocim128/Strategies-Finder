import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap, buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming the spread (spotYesProbability - marketYesProbability) is cointegrated
// #SUGGEST_VERIFY: Verify the z-score of the spread identifies extreme divergences with statistical validity
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        spreadZThreshold: Math.max(0.1, Number(params.spreadZThreshold ?? 2.0)),
    };
}

export const cointegrated_spread_deviation_arbitrage: Strategy = {
    name: "Cointegrated Spread Deviation Arbitrage",
    description: "Models the cointegrated relationship between Binance-implied fair probability and Polymarket mid-probability, entering contrarian positions when the spread deviates to statistical extremes.",
    defaultParams: {
        lookback: 30,
        spreadZThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Spread Z-Score Lookback",
        spreadZThreshold: "Spread Z-Score Threshold",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const spreadZThreshold = p.spreadZThreshold as number;

        if (cleanData.length < lookback) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });

        if (!pressure.available || !mask.available) return [];

        // Build spread series = spotYesProbability - marketYesProbability
        const spreadSeries = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const spot = pressure.spotYesProbability[i];
            const market = pressure.marketYesProbability[i];
            spreadSeries[i] = (spot !== null && market !== null) ? (spot - market) : 0;
        }

        const spreadZ = buildRollingZScore(spreadSeries, lookback);

        return createSignalLoop(
            cleanData,
            [spreadZ, pressure.spotYesProbability, pressure.marketYesProbability],
            (i) => {
                if (i < lookback) return null;

                const z = spreadZ[i];
                const longAllowed = mask.longAllowed[i];
                const shortAllowed = mask.shortAllowed[i];
                const spot = pressure.spotYesProbability[i];
                const market = pressure.marketYesProbability[i];

                if (z === null || spot === null || market === null) return null;

                // Buy YES: spreadZ <= -spreadZThreshold and longAllowed is true
                if (z <= -spreadZThreshold && longAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Spread underpriced YES: spreadZ ${z.toFixed(2)}, spotYes ${spot.toFixed(3)}, marketYes ${market.toFixed(3)}`
                    );
                }

                // Buy NO (expressed as Sell signal): spreadZ >= spreadZThreshold and shortAllowed is true
                if (z >= spreadZThreshold && shortAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Spread underpriced NO: spreadZ ${z.toFixed(2)}, spotYes ${spot.toFixed(3)}, marketYes ${market.toFixed(3)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "spreadZThreshold"],
    },
};
