import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingMedian, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeDisplacementVelocityQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        velocity_lookback: Math.max(1, Math.round(Number(params.velocity_lookback ?? 10))),
        quorum_threshold: Math.max(1, Math.min(2, Math.round(Number(params.quorum_threshold ?? 2)))),
    };
}

export const displacement_velocity_quorum: Strategy = {
    name: "Displacement Velocity Quorum",
    description:
        "Requires quorum between gap displacement, close velocity, and median acceptance for multi-day settlement entries.",
    defaultParams: {
        velocity_lookback: 10,
        quorum_threshold: 2,
    },
    paramLabels: {
        velocity_lookback: "Velocity Lookback",
        quorum_threshold: "Quorum Threshold",
    },
    normalizeParams: normalizeDisplacementVelocityQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDisplacementVelocityQuorumParams(params);
        const lookback = p.velocity_lookback as number;
        const quorum = p.quorum_threshold as number;
        const magnitudeLookback = Math.max(lookback * 3, 20);
        if (cleanData.length < magnitudeLookback + lookback + 1) return [];

        const closes = getCloses(cleanData);
        const gaps = extractBarMetricSeries(cleanData, "gapPct");
        const velocity = buildRateOfChange(closes, lookback);
        const velocityMagnitude = buildRollingMedian(velocity.map((value) => Math.abs(value ?? 0)), magnitudeLookback);
        const median = buildRollingMedian(closes, magnitudeLookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [velocity, velocityMagnitude, median], (i) => {
            if (i < magnitudeLookback + lookback) return null;

            const currentVelocity = velocity[i];
            const minVelocity = velocityMagnitude[i];
            const med = median[i];
            if (currentVelocity === null || minVelocity === null || med === null || minVelocity <= 0) return null;

            let longVotes = 0;
            let shortVotes = 0;

            if (gaps[i] > 0 && closes[i] > med && closeAcceptance[i] > 0) longVotes++;
            if (gaps[i] < 0 && closes[i] < med && closeAcceptance[i] < 0) shortVotes++;

            if (currentVelocity > minVelocity && closes[i] > med) longVotes++;
            if (currentVelocity < -minVelocity && closes[i] < med) shortVotes++;

            const longSignal = longVotes >= quorum;
            const shortSignal = shortVotes >= quorum;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Displacement velocity quorum long ${longVotes}/2`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Displacement velocity quorum short ${shortVotes}/2`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["velocity_lookback", "quorum_threshold"],
    },
};
