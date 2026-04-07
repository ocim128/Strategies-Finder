import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";

type SupertrendChurnResiliencePrepared = {
    cleanData: OHLCVData[];
    highs: number[];
    lows: number[];
    closes: number[];
    midpoints: number[];
    supertrendByKey: Map<string, ReturnType<typeof calculateSupertrend>>;
    midpointByKey: Map<string, number[]>;
    crossingsByKey: Map<string, (number | null)[]>;
};

function prepareSupertrendChurnResilienceData(data: OHLCVData[]): SupertrendChurnResiliencePrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        closes: getCloses(cleanData),
        midpoints: cleanData.map((candle) => getPriceActionBarMetrics(candle).midpoint),
        supertrendByKey: new Map<string, ReturnType<typeof calculateSupertrend>>(),
        midpointByKey: new Map<string, number[]>(),
        crossingsByKey: new Map<string, (number | null)[]>() };
}

function getPreparedSupertrendChurnResilienceData(
    preparedData: unknown,
    data: OHLCVData[]
): SupertrendChurnResiliencePrepared {
    if (preparedData && typeof preparedData === "object" && "supertrendByKey" in preparedData) {
        return preparedData as SupertrendChurnResiliencePrepared;
    }
    return prepareSupertrendChurnResilienceData(data);
}

export const supertrend_churn_resilience: Strategy = {
    name: "Supertrend Churn Resilience",
    description: "Validates trend persistence by tracking the crossing frequency of midpoints against the Supertrend line. A low crossing count verifies a highly resilient regime.",
    defaultParams: {
        stPeriod: 10,
        stMultiplier: 3,
        maxCrossings: 1 },
    paramLabels: {
        stPeriod: "Supertrend Period",
        stMultiplier: "Supertrend Multiplier",
        maxCrossings: "Max Allowed Crossings (20b)" },
    prepareFinderData: (data) => prepareSupertrendChurnResilienceData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedSupertrendChurnResilienceData(preparedData, data);
        const { cleanData, highs, lows, closes, midpoints, supertrendByKey, midpointByKey, crossingsByKey } = prepared;
        const stPeriod = Number(params.stPeriod ?? 10);
        const stMultiplier = Number(params.stMultiplier ?? 3);
        const maxCrossings = Number(params.maxCrossings ?? 1);

        if (cleanData.length < stPeriod) return [];

        const key = `${stPeriod}:${stMultiplier}`;
        let st = supertrendByKey.get(key);
        if (!st) {
            st = calculateSupertrend(highs, lows, closes, stPeriod, stMultiplier);
            supertrendByKey.set(key, st);
        }

        let midpointDistance = midpointByKey.get(key);
        if (!midpointDistance) {
            midpointDistance = new Array(cleanData.length).fill(0);
            for (let i = 0; i < cleanData.length; i++) {
                if (st.supertrend[i] === null) continue;
                midpointDistance[i] = midpoints[i] - st.supertrend[i]!;
            }
            midpointByKey.set(key, midpointDistance);
        }

        let crossings = crossingsByKey.get(key);
        if (!crossings) {
            crossings = buildThresholdCrossingCount(midpointDistance, 20, 0);
            crossingsByKey.set(key, crossings);
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 20 || st.direction[i] === null || crossings[i] === null) return null;

            const isBullishSupertrend = st.direction[i] === 1;
            const isBearishSupertrend = st.direction[i] === -1;
            const isLowChurn = crossings[i]! <= maxCrossings;
            
            const isUpCandle = cleanData[i].close > cleanData[i].open;
            const isDownCandle = cleanData[i].close < cleanData[i].open;

            if (isBullishSupertrend && isLowChurn && isUpCandle) {
                return createBuySignal(cleanData, i, "Resilient bullish supertrend low-churn continuation");
            }
            if (isBearishSupertrend && isLowChurn && isDownCandle) {
                return createSellSignal(cleanData, i, "Resilient bearish supertrend low-churn continuation");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        supertrend_churn_resilience.executePrepared?.(prepareSupertrendChurnResilienceData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["stPeriod", "stMultiplier", "maxCrossings"] } };
