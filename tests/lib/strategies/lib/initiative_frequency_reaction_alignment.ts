import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildThresholdCrossingCount } from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam } from "./range-conviction-core";

function normalizeInitiativeFrequencyReactionAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        minCrossings: normalizeIntegerParam(params.minCrossings, 6, 1),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

export const initiative_frequency_reaction_alignment: Strategy = {
    name: "Initiative Frequency with Reaction Alignment",
    description: "Measures how frequently volume-weighted initiative pressure flips sign to capture exhaustion in taker battles, entering only when Polymarket reaction lag confirms the emerging winner.",
    defaultParams: {
        lookback: 20,
        minCrossings: 6,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Crossing Lookback Window",
        minCrossings: "Minimum Crossings Count",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeInitiativeFrequencyReactionAlignmentParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativeFrequencyReactionAlignmentParams(params);
        const lookback = p.lookback;
        const minCrossings = p.minCrossings;
        const lagSec = p.lagSec;

        const warmup = lookback + 3;
        if (cleanData.length < warmup) return [];

        const typical = getTypicalPrices(cleanData);
        const closes = getCloses(cleanData);

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const typicalMedian = buildRollingMedian(typical, lookback);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, { volLookback: lookback, lagSec });

        if (!mask.available) return [];

        const flatPressure = pressure.map((v) => v ?? 0);
        const crossings = buildThresholdCrossingCount(flatPressure, lookback, 0);

        return createSignalLoop(
            cleanData,
            [typicalMedian, crossings],
            (i) => {
                if (i < warmup) return null;

                const currentClose = closes[i];
                const currentMedian = typicalMedian[i];
                const currentCrossings = crossings[i];
                const prevCrossings = crossings[i - 3]; // Check for rapid decay from past 3 bars
                const longAllowed = mask.longAllowed[i];
                const shortAllowed = mask.shortAllowed[i];

                if (
                    currentMedian === null ||
                    currentCrossings === null ||
                    prevCrossings === null
                ) {
                    return null;
                }

                const exhaustedChop = prevCrossings >= minCrossings && currentCrossings < minCrossings;
                if (!exhaustedChop) return null;

                if (currentClose > currentMedian && longAllowed) {
                    return createBuySignal(cleanData, i, "Initiative crossing frequency collapsed above median with reaction agreement");
                }

                if (currentClose < currentMedian && shortAllowed) {
                    return createSellSignal(cleanData, i, "Initiative crossing frequency collapsed below median with reaction agreement");
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minCrossings", "lagSec"],
    },
};
