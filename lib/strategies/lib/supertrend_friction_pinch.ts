import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildRollingMinMax, buildRateOfChange } from "./price-action-statistics-core";

type SupertrendFrictionPinchPrepared = {
    cleanData: OHLCVData[];
    highs: number[];
    lows: number[];
    closes: number[];
    supertrendByPeriod: Map<number, ReturnType<typeof calculateSupertrend>>;
    safeDistancesByPeriod: Map<number, number[]>;
    distanceLimitsByKey: Map<string, ReturnType<typeof buildRollingMinMax>>;
    rocSeries: (number | null)[];
};

function prepareSupertrendFrictionPinchData(data: OHLCVData[]): SupertrendFrictionPinchPrepared {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    return {
        cleanData,
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        closes,
        supertrendByPeriod: new Map<number, ReturnType<typeof calculateSupertrend>>(),
        safeDistancesByPeriod: new Map<number, number[]>(),
        distanceLimitsByKey: new Map<string, ReturnType<typeof buildRollingMinMax>>(),
        rocSeries: buildRateOfChange(closes, 1),
    };
}

function getPreparedSupertrendFrictionPinchData(
    preparedData: unknown,
    data: OHLCVData[]
): SupertrendFrictionPinchPrepared {
    if (preparedData && typeof preparedData === "object" && "supertrendByPeriod" in preparedData) {
        return preparedData as SupertrendFrictionPinchPrepared;
    }
    return prepareSupertrendFrictionPinchData(data);
}

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
    prepareFinderData: (data) => prepareSupertrendFrictionPinchData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedSupertrendFrictionPinchData(preparedData, data);
        const { cleanData, highs, lows, closes, supertrendByPeriod, safeDistancesByPeriod, distanceLimitsByKey, rocSeries } = prepared;
        const sPeriod = Number(params.stPeriod ?? 10);
        const pLookback = Number(params.pinchLookback ?? 20);
        const rocTrigger = Number(params.rocTarget ?? 1.5);

        if (cleanData.length < sPeriod + pLookback + 5) return [];

        let st = supertrendByPeriod.get(sPeriod);
        if (!st) {
            st = calculateSupertrend(highs, lows, closes, sPeriod, 3);
            supertrendByPeriod.set(sPeriod, st);
        }

        let safeDistances = safeDistancesByPeriod.get(sPeriod);
        if (!safeDistances) {
            safeDistances = closes.map((close, i) => {
                if (st.supertrend[i] === null) return i === 0 ? 0.000001 : 0;
                const distance = Math.abs(close - st.supertrend[i]!);
                return i === 0 ? 0.000001 : distance;
            });
            safeDistancesByPeriod.set(sPeriod, safeDistances);
        }

        const distanceLimitsKey = `${sPeriod}:${pLookback}`;
        let distanceLimits = distanceLimitsByKey.get(distanceLimitsKey);
        if (!distanceLimits) {
            distanceLimits = buildRollingMinMax(safeDistances, pLookback);
            distanceLimitsByKey.set(distanceLimitsKey, distanceLimits);
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < Math.max(sPeriod, pLookback) || distanceLimits.min[i - 1] === null || rocSeries[i] === null || st.direction[i - 1] === null) return null;

            // Did the prior bar represent the friction compression event?
            const priorDistance = safeDistances[i - 1];
            const priorMin = distanceLimits.min[i - 1]!;
            // Add tiny epsilon to handle floating point comparisons identically
            const isPinched = priorDistance <= priorMin + 0.0001; 

            const priorDirection = st.direction[i - 1];
            const currentRoc = rocSeries[i]! * 100;

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
    execute: (data: OHLCVData[], params: StrategyParams) =>
        supertrend_friction_pinch.executePrepared?.(prepareSupertrendFrictionPinchData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["stPeriod", "pinchLookback", "rocTarget"],
    },
};
