import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

const SLOW_MULTIPLE = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const multi_horizon_momentum_agreement: Strategy = {
    name: "Multi-Horizon Momentum Agreement",
    description: "Buys fast-horizon momentum turns only while the fixed slow horizon already agrees with the direction.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Fast Horizon",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const slow = SLOW_MULTIPLE * lookback;
        if (cleanData.length < slow) return [];

        const closes = getCloses(cleanData);
        const fast = buildRateOfChange(closes, lookback).map((v) => (v === null ? 0 : v));
        const slowMomentum = buildRateOfChange(closes, slow).map((v) => (v === null ? 0 : v));

        return createSignalLoop(cleanData, [fast], (i) => {
            const prevFast = fast[i - 1];
            const currFast = fast[i];
            if (prevFast === null || currFast === null || i < slow) return null;

            // Fast horizon turns positive while the slow horizon is already up.
            if (prevFast <= 0 && currFast > 0 && slowMomentum[i] > 0) {
                return createBuySignal(cleanData, i, `Multi-horizon buy: fast ${currFast.toFixed(4)} crossed up with slow ${slowMomentum[i].toFixed(4)} agreeing`);
            }
            if (prevFast >= 0 && currFast < 0 && slowMomentum[i] < 0) {
                return createSellSignal(cleanData, i, `Multi-horizon sell: fast ${currFast.toFixed(4)} crossed down with slow ${slowMomentum[i].toFixed(4)} agreeing`);
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
