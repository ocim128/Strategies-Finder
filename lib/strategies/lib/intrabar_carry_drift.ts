import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getOpens,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";

const CARRY_BAND = 0.0005;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const intrabar_carry_drift: Strategy = {
    name: "Intrabar Carry Drift",
    description: "Rides persistent open-to-close flow, entering when the rolling mean of intrabar returns crosses a small fixed band.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const opens = getOpens(cleanData);
        const closes = getCloses(cleanData);
        // Scale-free per-bar intrabar return: close / open - 1.
        const intrabar = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            intrabar[i] = opens[i] > 0 ? closes[i] / opens[i] - 1 : 0;
        }
        const carryMean = buildRollingAverage(intrabar, lookback);

        return createSignalLoop(cleanData, [carryMean], (i) => {
            const prev = carryMean[i - 1];
            const curr = carryMean[i];
            if (prev === null || curr === null) return null;

            // Positive carry flow band-entry edge.
            if (prev <= CARRY_BAND && curr > CARRY_BAND) {
                return createBuySignal(cleanData, i, `Carry drift buy: intrabar mean ${curr.toFixed(5)} crossed above band`);
            }
            // Negative carry flow band-entry edge.
            if (prev >= -CARRY_BAND && curr < -CARRY_BAND) {
                return createSellSignal(cleanData, i, `Carry drift sell: intrabar mean ${curr.toFixed(5)} crossed below band`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
