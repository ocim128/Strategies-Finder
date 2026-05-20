import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        skewThreshold: Math.max(0.1, Number(params.skewThreshold ?? 1.8)),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.02)),
    };
}

export const rolling_skewness_reversion_pressure_gap: Strategy = {
    name: "Rolling Skewness Reversion Pressure Gap",
    description: "Fades extreme fat-tailed directional expansions on Binance (high rolling skewness) on a confirmed spot return to the mean, entering only when a favorable Polymarket pressure gap mismatch confirms the counter-trend option is underpriced.",
    defaultParams: {
        lookback: 35,
        skewThreshold: 1.8,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Skew Lookback",
        skewThreshold: "Skew Threshold",
        minEdge: "Minimum Same-Side Edge",
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

        if (cleanData.length < lookback + 1) return [];

        // Build close returns
        const returns = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const prev = cleanData[i - 1].close;
            returns[i] = prev > 0 ? (cleanData[i].close - prev) / prev : 0;
        }

        const skewness = buildRollingSkewness(returns, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [skewness, pressure.longEdge, pressure.shortEdge], (i) => {
            if (i < 1) return null;

            const prevSkew = skewness[i - 1];
            const currentSkew = skewness[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];

            if (prevSkew === null || currentSkew === null || longEdge === null || shortEdge === null) return null;

            // Buy: positive skewness reaches a positive extreme and crosses back below it (fading bullish expansion)
            if (prevSkew > skewThreshold && currentSkew <= skewThreshold && longEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Fading bullish skewness reversion ${currentSkew.toFixed(2)} with long edge ${longEdge.toFixed(3)}`);
            }

            // Sell: negative skewness reaches a negative extreme and crosses back above it (fading bearish expansion)
            if (prevSkew < -skewThreshold && currentSkew >= -skewThreshold && shortEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Fading bearish skewness reversion ${currentSkew.toFixed(2)} with short edge ${shortEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold", "minEdge"],
    },
};
