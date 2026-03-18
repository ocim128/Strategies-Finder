import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildRollingMinMax, buildRateOfChange } from "./price-action-statistics-core";

export const supertrend_friction_pinch: Strategy = {
    name: "Supertrend Friction Pinch",
    description: "Quantifies localized stall-points precisely at major trend structure lines. Computes the absolute distance between Close and Supertrend, seeking instances where this distance collapses to a rolling minimum deadzone prior to breaking away.",
    defaultParams: {
        stPeriod: 10,
        pinchLookback: 20,
        rocTarget: 1.5,
    },
    paramLabels: {
        stPeriod: "Supertrend Sensitity Layer",
        pinchLookback: "Friction Floor Matrix",
        rocTarget: "Minimum Breakaway Threshold",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const sPeriod = params.stPeriod as number;
        const pLookback = params.pinchLookback as number;

        if (cleanData.length < sPeriod + pLookback + 5) return [];

        const st = calculateSupertrend(
            cleanData.map(d => d.high),
            cleanData.map(d => d.low),
            cleanData.map(d => d.close),
            sPeriod,
            3 // Default factor 3 for core structure
        );

        const distances = cleanData.map((d, i) => {
            if (st.supertrend[i] === null) return 0;
            return Math.abs(d.close - st.supertrend[i]!);
        });

        const safeDistances = distances.map((v, i) => i === 0 ? 0.000001 : v);
        // Track the minimum distance floor natively
        const distanceLimits = buildRollingMinMax(safeDistances, pLookback);

        const rocSeries = buildRateOfChange(cleanData.map(d => d.close), 1);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < Math.max(sPeriod, pLookback) || distanceLimits.min[i - 1] === null || rocSeries[i] === null || st.direction[i - 1] === null) return null;

            // Did the prior bar represent the friction compression event?
            const priorDistance = safeDistances[i - 1];
            const priorMin = distanceLimits.min[i - 1]!;
            // Add tiny epsilon to handle floating point comparisons identically
            const isPinched = priorDistance <= priorMin + 0.0001; 

            const priorDirection = st.direction[i - 1];
            const currentRoc = rocSeries[i]! * 100;
            const rocTrigger = params.rocTarget as number;

            // Buy: Pinched near bullish Supertrend, snapped up
            if (isPinched && priorDirection === 1 && currentRoc > rocTrigger) {
                return createBuySignal(cleanData, i, "Physical trajectory bounce perfectly off the macroscopic algorithmic friction line");
            }

            // Sell: Pinched near bearish Supertrend, snapped down 
            if (isPinched && priorDirection === -1 && currentRoc < -rocTrigger) {
                return createSellSignal(cleanData, i, "Physical trajectory rejection perfectly off the macroscopic algorithmic friction line");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["stPeriod", "pinchLookback", "rocTarget"],
    },
};
