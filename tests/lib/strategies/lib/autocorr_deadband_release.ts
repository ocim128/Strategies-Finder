import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeAutocorrDeadbandReleaseParams(params: StrategyParams): StrategyParams {
    const rawDeadbandWidth = Number(params.deadbandWidth ?? 0.18);
    const rawRocTrigger = Number(params.rocTrigger ?? 0.012);

    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 18)),
        deadbandWidth: Math.max(0, Number.isFinite(rawDeadbandWidth) ? rawDeadbandWidth : 0.18),
        rocTrigger: Math.max(0, Math.abs(Number.isFinite(rawRocTrigger) ? rawRocTrigger : 0.012)),
    };
}

function buildReturns(series: number[]): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = 1; i < series.length; i++) {
        const prior = series[i - 1];
        res[i] = prior !== 0 ? (series[i] - prior) / prior : 0;
    }
    return res;
}

function buildRollingMinMaxSpan(series: number[], window: number): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = window - 1; i < series.length; i++) {
        let max = -Infinity;
        let min = Infinity;
        for (let j = 0; j < window; j++) {
            if (series[i - j] > max) max = series[i - j];
            if (series[i - j] < min) min = series[i - j];
        }
        res[i] = max - min;
    }
    return res;
}

type AutocorrDeadbandPrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    returns: number[];
    roc1: number[];
    autoCorrByLookback: Map<number, number[]>;
    bandWidthByLookback: Map<number, number[]>;
};

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

function prepareAutocorrDeadbandData(data: OHLCVData[]): AutocorrDeadbandPrepared {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    return {
        cleanData,
        closes,
        returns: buildReturns(closes),
        roc1: normalizeSeries(buildRateOfChange(closes, 1)),
        autoCorrByLookback: new Map<number, number[]>(),
        bandWidthByLookback: new Map<number, number[]>(),
    };
}

function getPreparedAutocorrDeadbandData(preparedData: unknown, data: OHLCVData[]): AutocorrDeadbandPrepared {
    if (preparedData && typeof preparedData === "object" && "autoCorrByLookback" in preparedData) {
        return preparedData as AutocorrDeadbandPrepared;
    }
    return prepareAutocorrDeadbandData(data);
}

export const autocorr_deadband_release: Strategy = {
    name: "Autocorrelation Deadband Release",
    description: "Waits for serial dependence to collapse into a tight near-zero deadband, then trades only when rate-of-change breaks out decisively.",
    defaultParams: {
        lookback: 18,
        deadbandWidth: 0.18,
        rocTrigger: 0.012,
    },
    paramLabels: {
        lookback: "Deadband Window",
        deadbandWidth: "Max Band Width",
        rocTrigger: "ROC Trigger (abs)",
    },
    normalizeParams: normalizeAutocorrDeadbandReleaseParams,
    prepareFinderData: (data) => prepareAutocorrDeadbandData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedAutocorrDeadbandData(preparedData, data);
        const { cleanData, returns, roc1, autoCorrByLookback, bandWidthByLookback } = prepared;
        const normalizedParams = normalizeAutocorrDeadbandReleaseParams(params);
        const lookback = normalizedParams.lookback;
        const deadbandWidth = normalizedParams.deadbandWidth;
        const rocTrigger = normalizedParams.rocTrigger;

        if (cleanData.length < lookback + lookback + 1) return [];

        let autoCorr = autoCorrByLookback.get(lookback);
        if (!autoCorr) {
            autoCorr = normalizeSeries(buildRollingAutoCorrelation(returns, lookback, 1));
            autoCorrByLookback.set(lookback, autoCorr);
        }
        let acBandWidth = bandWidthByLookback.get(lookback);
        if (!acBandWidth) {
            acBandWidth = buildRollingMinMaxSpan(autoCorr, lookback);
            bandWidthByLookback.set(lookback, acBandWidth);
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + lookback) return null;
            
            if (acBandWidth[i - 1] <= deadbandWidth) {
                if (roc1[i] > rocTrigger) {
                    return createBuySignal(cleanData, i, "Deadband Release Long");
                }
                if (roc1[i] < -rocTrigger) {
                    return createSellSignal(cleanData, i, "Deadband Release Short");
                }
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        autocorr_deadband_release.executePrepared?.(prepareAutocorrDeadbandData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "deadbandWidth", "rocTrigger"],
    },
};
