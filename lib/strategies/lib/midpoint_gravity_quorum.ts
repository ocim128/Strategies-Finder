import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getMidpoints,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

function normalizeMidpointGravityQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        quorum_threshold: Math.max(1, Math.min(2, Math.round(Number(params.quorum_threshold ?? 2)))),
    };
}

export const midpoint_gravity_quorum: Strategy = {
    name: "Midpoint Gravity Quorum",
    description:
        "Requires agreement between midpoint-distance reversion and close velocity before trading back toward the rolling midpoint.",
    defaultParams: {
        lookback: 63,
        quorum_threshold: 2,
    },
    paramLabels: {
        lookback: "Lookback",
        quorum_threshold: "Quorum Threshold",
    },
    normalizeParams: normalizeMidpointGravityQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMidpointGravityQuorumParams(params);
        const lookback = p.lookback as number;
        const quorum = p.quorum_threshold as number;
        if (cleanData.length < lookback * 2 + 1) return [];

        const closes = getCloses(cleanData);
        const rollingMidpoint = buildRollingMedian(getMidpoints(cleanData), lookback);
        const distanceFromMidpoint = closes.map((close, i) => {
            const midpoint = rollingMidpoint[i];
            return midpoint === null ? 0 : close - midpoint;
        });
        const distanceMagnitude = buildRollingMedian(distanceFromMidpoint.map((value) => Math.abs(value)), lookback);
        const closeVelocity = buildRateOfChange(closes, 1);

        return createSignalLoop(cleanData, [rollingMidpoint, distanceMagnitude, closeVelocity], (i) => {
            if (i < lookback * 2) return null;

            const midpoint = rollingMidpoint[i];
            const priorMidpoint = rollingMidpoint[i - 1];
            const minDistance = distanceMagnitude[i];
            const velocity = closeVelocity[i];
            if (midpoint === null || priorMidpoint === null || minDistance === null || minDistance <= 0 || velocity === null) return null;

            const distance = closes[i] - midpoint;
            const previousDistance = closes[i - 1] - priorMidpoint;
            let longVotes = 0;
            let shortVotes = 0;

            if (distance <= -minDistance && distance > previousDistance) longVotes++;
            if (distance >= minDistance && distance < previousDistance) shortVotes++;

            if (distance < 0 && velocity > 0) longVotes++;
            if (distance > 0 && velocity < 0) shortVotes++;

            const longSignal = longVotes >= quorum;
            const shortSignal = shortVotes >= quorum;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Midpoint gravity quorum long ${longVotes}/2`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Midpoint gravity quorum short ${shortVotes}/2`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "quorum_threshold"],
    },
};
