import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import {
    buildPolymarket1sPressureGap,
    buildPolymarket1sReactionAgreementMask,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam } from "./range-conviction-core";

function normalizeVolatilityAdjustedEventOpenReactionAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 45, 5),
        rocLookback: normalizeIntegerParam(params.rocLookback, 10, 1),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

export const volatility_adjusted_event_open_reaction_agreement: Strategy = {
    name: "Volatility-Adjusted Event Open Momentum with Reaction Agreement",
    description: "Trades z-scored momentum in event-open distance only when Polymarket reaction agreement supports the side.",
    defaultParams: {
        volLookback: 45,
        rocLookback: 10,
        lagSec: 5,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        rocLookback: "Momentum Lookback",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeVolatilityAdjustedEventOpenReactionAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityAdjustedEventOpenReactionAgreementParams(params);
        if (cleanData.length < p.volLookback + p.rocLookback + 1) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: p.volLookback });
        if (!pressure.available) return [];
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, {
            volLookback: p.volLookback,
            lagSec: p.lagSec,
        });
        if (!mask.available) return [];

        const distanceMomentum: number[] = new Array(cleanData.length).fill(0);
        for (let i = p.rocLookback; i < cleanData.length; i++) {
            const currentDistance = pressure.distanceZ[i];
            const previousDistance = pressure.distanceZ[i - p.rocLookback];
            if (currentDistance === null || previousDistance === null) continue;
            distanceMomentum[i] = currentDistance - previousDistance;
        }
        const momentumZ = buildRollingZScore(distanceMomentum, p.volLookback);

        return createSignalLoop(cleanData, [momentumZ], (i) => {
            const score = momentumZ[i];
            if (
                score === null
                || pressure.distanceZ[i] === null
                || i < p.rocLookback
                || pressure.distanceZ[i - p.rocLookback] === null
            ) return null;

            if (score >= 1.2 && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Positive event-open distance momentum with reaction agreement");
            }
            if (score <= -1.2 && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Negative event-open distance momentum with reaction agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "rocLookback", "lagSec"],
    },
};
