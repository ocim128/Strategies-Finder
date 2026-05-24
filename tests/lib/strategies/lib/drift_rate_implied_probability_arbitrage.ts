import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming Chaikin Money Flow serves as a reliable proxy for directional volume-weighted price drift
// #SUGGEST_VERIFY: Verify lagSec parameter matches reaction gap eval window in Polymarket pricing
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 25))),
        driftThreshold: Math.max(0.01, Math.min(0.99, Number(params.driftThreshold ?? 0.22))),
        lagSec: Math.max(1, Math.round(Number(params.lagSec ?? 5))),
        minLag: Math.max(0.0, Number(params.minLag ?? 0.02)),
    };
}

export const drift_rate_implied_probability_arbitrage: Strategy = {
    name: "Drift-Rate Implied Probability Arbitrage",
    description: "Calculates a volume-weighted price drift rate on Binance to project a more accurate directional settlement probability, exploiting the underreaction gap when Polymarket lags this drift adjustment.",
    defaultParams: {
        lookback: 25,
        driftThreshold: 0.22,
        lagSec: 5,
        minLag: 0.02,
    },
    paramLabels: {
        lookback: "CMF Lookback",
        driftThreshold: "Drift CMF Threshold",
        lagSec: "Lag Seconds",
        minLag: "Minimum Lag Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const driftThreshold = p.driftThreshold as number;
        const lagSec = p.lagSec as number;
        const minLag = p.minLag as number;

        if (cleanData.length < lookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback, lagSec });

        if (!reaction.available) return [];

        return createSignalLoop(
            cleanData,
            [cmf, reaction.longLagEdge, reaction.shortLagEdge],
            (i) => {
                if (i < lookback) return null;

                const currentCmf = cmf[i];
                const longLagEdge = reaction.longLagEdge[i];
                const shortLagEdge = reaction.shortLagEdge[i];

                if (currentCmf === null || longLagEdge === null || shortLagEdge === null) return null;

                // Buy YES: Chaikin Money Flow (CMF) >= driftThreshold and longLagEdge >= minLag
                if (currentCmf >= driftThreshold && longLagEdge >= minLag) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Drift buy YES: CMF ${currentCmf.toFixed(2)} >= ${driftThreshold}, lagEdge ${longLagEdge.toFixed(3)} >= ${minLag}`
                    );
                }

                // Buy NO (expressed as Sell signal): Chaikin Money Flow (CMF) <= -driftThreshold and shortLagEdge >= minLag
                if (currentCmf <= -driftThreshold && shortLagEdge >= minLag) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Drift buy NO: CMF ${currentCmf.toFixed(2)} <= -${driftThreshold}, lagEdge ${shortLagEdge.toFixed(3)} >= ${minLag}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "driftThreshold", "lagSec", "minLag"],
    },
};
