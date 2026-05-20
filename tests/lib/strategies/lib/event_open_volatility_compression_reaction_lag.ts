import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingStdDev } from "./price-action-statistics-core";
import {
    buildPolymarket1sPressureGap,
    buildPolymarket1sReactionGap,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEventOpenVolatilityCompressionReactionLagParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 30, 6),
        compressionThreshold: normalizeNumberParam(params.compressionThreshold, 0.65, 0.01),
        minLag: normalizeNumberParam(params.minLag, 0.01, 0),
    };
}

export const event_open_volatility_compression_reaction_lag: Strategy = {
    name: "Event Open Volatility Compression Reaction Lag",
    description: "Trades event-open distance shifts after Binance volatility compression when Polymarket reaction lag confirms underreaction.",
    defaultParams: {
        volLookback: 30,
        compressionThreshold: 0.65,
        minLag: 0.01,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        compressionThreshold: "Compression Threshold",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams: normalizeEventOpenVolatilityCompressionReactionLagParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenVolatilityCompressionReactionLagParams(params);
        const slowLookback = p.volLookback;
        const fastLookback = Math.max(3, Math.round(slowLookback / 2));
        if (cleanData.length < slowLookback + 2) return [];

        const closes = getCloses(cleanData);
        const fastStdDev = buildRollingStdDev(closes, fastLookback);
        const slowStdDev = buildRollingStdDev(closes, slowLookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: slowLookback });
        if (!pressure.available) return [];
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: slowLookback });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [
            fastStdDev,
            slowStdDev,
            pressure.distanceZ,
            reaction.longLagEdge,
            reaction.shortLagEdge,
        ], (i) => {
            if (i < slowLookback + 1) return null;
            const fast = fastStdDev[i];
            const slow = slowStdDev[i];
            const distance = pressure.distanceZ[i];
            const previousDistance = pressure.distanceZ[i - 1];
            if (fast === null || slow === null || slow <= 0 || distance === null || previousDistance === null) return null;
            if (fast / slow >= p.compressionThreshold) return null;

            const distanceShift = distance - previousDistance;
            if (distanceShift > 0 && (reaction.longLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createBuySignal(cleanData, i, "Event-open compression breakout with long reaction lag");
            }
            if (distanceShift < 0 && (reaction.shortLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createSellSignal(cleanData, i, "Event-open compression breakdown with short reaction lag");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "compressionThreshold", "minLag"],
    },
};
