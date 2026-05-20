import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import {
    buildPolymarket1sGammaAgreement,
    buildPolymarket1sPressureGap,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { buildLogReturnSeries } from "./polymarket-1s-strategy-utils";

function normalizeEventOpenDistanceVolatilitySkewConsensusGammaParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 25, 3),
        skewThreshold: normalizeNumberParam(params.skewThreshold, 1.6, 0),
        minEdge: normalizeNumberParam(params.minEdge, 0.015, 0),
    };
}

export const event_open_distance_volatility_skew_consensus_gamma: Strategy = {
    name: "Event Open Distance Volatility Skew Consensus Gamma",
    description: "Pairs rapid event-open distance shifts with asymmetric Binance return skew and Gamma consensus confirmation.",
    defaultParams: {
        volLookback: 25,
        skewThreshold: 1.6,
        minEdge: 0.015,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        skewThreshold: "Skew Threshold",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams: normalizeEventOpenDistanceVolatilitySkewConsensusGammaParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenDistanceVolatilitySkewConsensusGammaParams(params);
        const volLookback = p.volLookback;
        if (cleanData.length < volLookback + 2) return [];

        const returns = buildLogReturnSeries(cleanData);
        const skewness = buildRollingSkewness(returns, volLookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback });
        if (!pressure.available) return [];
        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback });
        if (!gamma.available) return [];

        return createSignalLoop(cleanData, [
            skewness,
            pressure.distanceZ,
            gamma.consensusLongEdge,
            gamma.consensusShortEdge,
        ], (i) => {
            if (i < volLookback + 1) return null;
            const distance = pressure.distanceZ[i];
            const previousDistance = pressure.distanceZ[i - 1];
            const skew = skewness[i];
            if (distance === null || previousDistance === null || skew === null) return null;

            const distanceShift = distance - previousDistance;
            if (distanceShift > 0 && skew > p.skewThreshold && (gamma.consensusLongEdge[i] ?? -Infinity) >= p.minEdge) {
                return createBuySignal(cleanData, i, "Event-open distance shift with long Gamma consensus");
            }
            if (distanceShift < 0 && skew < -p.skewThreshold && (gamma.consensusShortEdge[i] ?? -Infinity) >= p.minEdge) {
                return createSellSignal(cleanData, i, "Event-open distance shift with short Gamma consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "skewThreshold", "minEdge"],
    },
};
