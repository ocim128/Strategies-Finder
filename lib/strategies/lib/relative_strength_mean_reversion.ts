import type {
    Strategy,
    OHLCVData,
    StrategyParams,
    StrategyExecutionContext,
} from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildRelativeStrength } from "./cross-symbol-helpers";

type RelativeStrengthMeanReversionPrepared = {
    cleanData: OHLCVData[];
    secondarySymbol: string | null;
    ratio: number[] | null;
    zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeRelativeStrengthMeanReversionParams(params: StrategyParams): StrategyParams {
    const lookback = Math.max(10, Math.round(params.lookback ?? 30));
    const zThreshold = Math.max(0.5, Number(params.zThreshold ?? 2.0));
    return {
        ...params,
        lookback,
        zThreshold,
    };
}

function prepareRelativeStrengthMeanReversionData(
    data: OHLCVData[],
    context?: StrategyExecutionContext
): RelativeStrengthMeanReversionPrepared {
    const cleanData = ensureCleanData(data);
    if (!context?.crossSymbol) {
        return {
            cleanData,
            secondarySymbol: null,
            ratio: null,
            zScoreByLookback: new Map<number, (number | null)[]>(),
        };
    }

    const primaryCloses = getCloses(cleanData);
    const secondaryCloses = getCloses(context.crossSymbol.secondaryData);
    return {
        cleanData,
        secondarySymbol: context.crossSymbol.secondarySymbol,
        ratio: buildRelativeStrength(primaryCloses, secondaryCloses),
        zScoreByLookback: new Map<number, (number | null)[]>(),
    };
}

function getPreparedRelativeStrengthMeanReversionData(
    preparedData: unknown,
    data: OHLCVData[],
    context?: StrategyExecutionContext
): RelativeStrengthMeanReversionPrepared {
    if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
        const prepared = preparedData as RelativeStrengthMeanReversionPrepared;
        const currentSymbol = context?.crossSymbol?.secondarySymbol ?? null;
        if (prepared.secondarySymbol === currentSymbol) {
            return prepared;
        }
    }

    return prepareRelativeStrengthMeanReversionData(data, context);
}

function getRelativeStrengthZScore(
    prepared: RelativeStrengthMeanReversionPrepared,
    lookback: number
): (number | null)[] | null {
    if (!prepared.ratio) {
        return null;
    }

    let zscore = prepared.zScoreByLookback.get(lookback);
    if (!zscore) {
        zscore = buildRollingZScore(prepared.ratio, lookback);
        prepared.zScoreByLookback.set(lookback, zscore);
    }
    return zscore;
}

export const relative_strength_mean_reversion: Strategy = {
    name: "Relative Strength Mean Reversion",
    description: "Mean-reversion on the z-score of the relative strength ratio (primary / secondary). When the ratio deviates significantly from its rolling mean, a reversal is expected.",
    defaultParams: {
        lookback: 30,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeRelativeStrengthMeanReversionParams,
    crossSymbolConfig: {
        defaultSymbol: "ETHUSDT",
        userSelectable: true,
        minBars: 50,
    },
    prepareFinderData: (data, _settings, context) => prepareRelativeStrengthMeanReversionData(data, context),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const prepared = getPreparedRelativeStrengthMeanReversionData(preparedData, data, context);
        const p = normalizeRelativeStrengthMeanReversionParams(params);
        if (prepared.cleanData.length < p.lookback) return [];

        const zscore = getRelativeStrengthZScore(prepared, p.lookback);
        if (!zscore) return [];

        return createSignalLoop(prepared.cleanData, [zscore], (i) => {
            if (i < p.lookback) return null;
            const z = zscore[i];
            if (z === null) return null;

            if (z > p.zThreshold) {
                return createSellSignal(prepared.cleanData, i, `RS z-score ${z.toFixed(2)} > ${p.zThreshold}`);
            }
            if (z < -p.zThreshold) {
                return createBuySignal(prepared.cleanData, i, `RS z-score ${z.toFixed(2)} < -${p.zThreshold}`);
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        relative_strength_mean_reversion.executePrepared?.(
            prepareRelativeStrengthMeanReversionData(data, context),
            params,
            data,
            context
        ) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
