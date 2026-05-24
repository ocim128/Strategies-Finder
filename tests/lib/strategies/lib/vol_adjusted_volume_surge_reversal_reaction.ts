import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeVolAdjustedVolumeSurgeReversalReactionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 5),
        atrMultiplier: normalizeNumberParam(params.atrMultiplier, 2.0, 0.1),
        volZThreshold: normalizeNumberParam(params.volZThreshold, 1.6, 0),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

export const vol_adjusted_volume_surge_reversal_reaction: Strategy = {
    name: "Volatility-Adjusted Volume Surge Reversal with Reaction Agreement",
    description: "Fades ATR-adjusted volume-surge overextensions only when Polymarket reaction agreement allows the contrarian side.",
    defaultParams: {
        lookback: 35,
        atrMultiplier: 2.0,
        volZThreshold: 1.6,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        atrMultiplier: "ATR Multiplier",
        volZThreshold: "Volume Z-Score Threshold",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeVolAdjustedVolumeSurgeReversalReactionParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolAdjustedVolumeSurgeReversalReactionParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const typicals = getTypicalPrices(cleanData);
        const average = buildRollingAverage(typicals, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [average, atr, volumeZ], (i) => {
            const center = average[i];
            const range = atr[i];
            const volScore = volumeZ[i];
            if (center === null || range === null || volScore === null || volScore < p.volZThreshold) return null;

            if (typicals[i] < center - p.atrMultiplier * range && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Volume-surge downside overextension with reaction long agreement");
            }
            if (typicals[i] > center + p.atrMultiplier * range && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Volume-surge upside overextension with reaction short agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrMultiplier", "volZThreshold", "lagSec"],
    },
};
