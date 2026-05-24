import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeKaufmanEfficiencyVelocityReactionAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 5),
        accelThreshold: normalizeNumberParam(params.accelThreshold, 0.15, 0),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

export const kaufman_efficiency_velocity_reaction_agreement: Strategy = {
    name: "Kaufman Efficiency Velocity with Reaction Agreement",
    description: "Trades rising Kaufman efficiency velocity only when Polymarket reaction agreement permits the side.",
    defaultParams: {
        lookback: 35,
        accelThreshold: 0.15,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Efficiency Lookback",
        accelThreshold: "Efficiency Acceleration Threshold",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeKaufmanEfficiencyVelocityReactionAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeKaufmanEfficiencyVelocityReactionAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 4) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const efficiencyVelocity = buildRateOfChange(efficiency.map((value) => value ?? 0), 3);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [efficiency, efficiencyVelocity], (i) => {
            const velocity = efficiencyVelocity[i];
            if (velocity === null || velocity < p.accelThreshold) return null;

            if (closes[i] > closes[i - 1] && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Kaufman efficiency velocity rose with bullish reaction agreement");
            }
            if (closes[i] < closes[i - 1] && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Kaufman efficiency velocity rose with bearish reaction agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "accelThreshold", "lagSec"],
    },
};
