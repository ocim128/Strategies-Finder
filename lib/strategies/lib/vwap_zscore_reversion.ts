import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateSessionVWAP } from "../indicators";
import { buildRollingZScore } from "./price-action-statistics-core";

type VwapZscoreReversionPrepared = {
    cleanData: OHLCVData[];
    sessionVwap: (number | null)[];
    barsInSession: number[];
    distanceByLookback: Map<number, number[]>;
    zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeVwapZscoreReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        zscoreLookback: Math.max(2, Math.round(params.zscoreLookback ?? 50)),
        zscoreThreshold: Math.max(0, Math.abs(Number(params.zscoreThreshold ?? 2.5))) };
}

function resolveSessionDay(time: OHLCVData["time"]): number {
    if (typeof time === "number") {
        return new Date(time > 1e12 ? time : time * 1000).getUTCDate();
    }
    if (typeof time === "string") {
        return new Date(time).getUTCDate();
    }
    return time.day;
}

function prepareVwapZscoreReversionData(data: OHLCVData[]): VwapZscoreReversionPrepared {
    const cleanData = ensureCleanData(data);
    const sessionVwap = calculateSessionVWAP(cleanData);
    const barsInSession = new Array(cleanData.length).fill(0);
    let validBarsInSession = 0;
    let lastDay = -1;

    for (let i = 0; i < cleanData.length; i++) {
        const currentDay = resolveSessionDay(cleanData[i].time);
        if (currentDay !== lastDay) {
            lastDay = currentDay;
            validBarsInSession = 1;
        } else {
            validBarsInSession++;
        }
        barsInSession[i] = validBarsInSession;
    }

    return {
        cleanData,
        sessionVwap,
        barsInSession,
        distanceByLookback: new Map<number, number[]>(),
        zscoreByLookback: new Map<number, (number | null)[]>() };
}

function getPreparedVwapZscoreReversionData(
    preparedData: unknown,
    data: OHLCVData[]
): VwapZscoreReversionPrepared {
    if (preparedData && typeof preparedData === "object" && "sessionVwap" in preparedData) {
        return preparedData as VwapZscoreReversionPrepared;
    }
    return prepareVwapZscoreReversionData(data);
}

export const vwap_zscore_reversion: Strategy = {
    name: "VWAP Z-Score Reversion",
    description: "Computes the rolling z-score of the distance between price and the Session VWAP. Trades extreme statistical deviations from the volume-weighted mean, banking on intra-session mean reversion.",
    defaultParams: {
        zscoreLookback: 50,
        zscoreThreshold: 2.5 },
    paramLabels: {
        zscoreLookback: "Z-Score Lookback",
        zscoreThreshold: "Z-Score Threshold" },
    normalizeParams: normalizeVwapZscoreReversionParams,
    prepareFinderData: (data) => prepareVwapZscoreReversionData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedVwapZscoreReversionData(preparedData, data);
        const normalizedParams = normalizeVwapZscoreReversionParams(params);
        const { cleanData, sessionVwap, barsInSession, distanceByLookback, zscoreByLookback } = prepared;
        const lookback = normalizedParams.zscoreLookback as number;
        const threshold = normalizedParams.zscoreThreshold as number;

        if (cleanData.length < lookback) return [];

        let distanceSeries = distanceByLookback.get(lookback);
        if (!distanceSeries) {
            distanceSeries = new Array(cleanData.length).fill(0);
            const minWarmupBars = Math.min(10, lookback / 2);

            for (let i = 0; i < cleanData.length; i++) {
                const vwap = sessionVwap[i];
                if (vwap !== null && barsInSession[i] > minWarmupBars) {
                    distanceSeries[i] = cleanData[i].close - vwap;
                }
            }
            distanceByLookback.set(lookback, distanceSeries);
        }

        let zscore = zscoreByLookback.get(lookback);
        if (!zscore) {
            zscore = buildRollingZScore(distanceSeries, lookback);
            zscoreByLookback.set(lookback, zscore);
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            const z = zscore[i];
            if (z === null) return null;

            if (z < -threshold) {
                return createBuySignal(cleanData, i, "Z-Score drops below negative threshold");
            }
            if (z > threshold) {
                return createSellSignal(cleanData, i, "Z-Score exceeds positive threshold");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        vwap_zscore_reversion.executePrepared?.(prepareVwapZscoreReversionData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["zscoreLookback", "zscoreThreshold"] } };
