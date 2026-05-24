import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildPolymarket1sPressureGap,
    buildPolymarket1sReactionGap,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEventOpenVolatilityArbitrageReactionGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 50, 5),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
        minLag: normalizeNumberParam(params.minLag, 0.02, 0),
    };
}

export const event_open_volatility_arbitrage_reaction_gap: Strategy = {
    name: "Event Open Volatility Arbitrage with Reaction Gap",
    description: "Buys probability dislocations near the event-open equilibrium when Binance-implied fair value is close to 0.5 and Polymarket reaction lag is favorable.",
    defaultParams: {
        volLookback: 50,
        lagSec: 5,
        minLag: 0.02,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        lagSec: "Reaction Lag Seconds",
        minLag: "Minimum Lag Edge",
    },
    normalizeParams: normalizeEventOpenVolatilityArbitrageReactionGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenVolatilityArbitrageReactionGapParams(params);
        const volLookback = p.volLookback;
        if (cleanData.length < volLookback + p.lagSec + 1) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback });
        const reaction = buildPolymarket1sReactionGap(cleanData, context, {
            volLookback,
            lagSec: p.lagSec,
        });
        if (!pressure.available || !reaction.available) return [];

        return createSignalLoop(cleanData, [pressure.distanceZ, pressure.marketYesProbability, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            const distanceZ = pressure.distanceZ[i];
            const marketYes = pressure.marketYesProbability[i];
            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];
            if (distanceZ === null || marketYes === null || longLagEdge === null || shortLagEdge === null) return null;
            if (Math.abs(distanceZ) > 0.25) return null;

            if (marketYes < 0.42 && longLagEdge >= p.minLag) {
                return createBuySignal(cleanData, i, "Near-open fair value with underpriced YES reaction lag");
            }
            if (marketYes > 0.58 && shortLagEdge >= p.minLag) {
                return createSellSignal(cleanData, i, "Near-open fair value with underpriced NO reaction lag");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "lagSec", "minLag"],
    },
};
