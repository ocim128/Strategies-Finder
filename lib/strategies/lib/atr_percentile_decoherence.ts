import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateATR } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawAtrPercentile = Number(params.atrPercentile ?? 0.05);
    const rawWickDominance = Number(params.wickDominance ?? 0.75);

    return {
        ...params,
        rankLookback: Math.max(3, Math.round(params.rankLookback ?? 100)),
        atrPercentile: Math.max(0, Math.min(1, Number.isFinite(rawAtrPercentile) ? rawAtrPercentile : 0.05)),
        wickDominance: Math.max(0, Math.min(1, Number.isFinite(rawWickDominance) ? rawWickDominance : 0.75)) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    atr: (number | null)[];
    atrPercentileRank: number[];
    lowerWickRatio: number[];
    upperWickRatio: number[];
    ranges: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        atr: [],
        atrPercentileRank: [],
        lowerWickRatio: [],
        upperWickRatio: [],
        ranges: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const atr_percentile_decoherence: Strategy = {
    name: "ATR Percentile Decoherence",
    description: "Hunts for aggressive, highly directed wick rejections that happen strictly during 1st-percentile volatility regimes, capturing explosive reversions from perfect compressions.",
    defaultParams: {
        rankLookback: 100,
        atrPercentile: 0.05,
        wickDominance: 0.75 },
    paramLabels: {
        rankLookback: "Rank Lookback",
        atrPercentile: "ATR Percentile",
        wickDominance: "Wick Dominance" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const rankLookback = Math.max(3, Math.round(params.rankLookback ?? 100));
        const atrPercentile = Number(params.atrPercentile ?? 0.05);
        const wickDominance = Number(params.wickDominance ?? 0.75);

        if (cleanData.length < rankLookback + 2) return [];

        // Calculate ATR
        let atr = prepared.atr;
        if (atr.length === 0 || (atr[0] === null)) {
            const highs = cleanData.map(d => d.high);
            const lows = cleanData.map(d => d.low);
            const closes = cleanData.map(d => d.close);
            atr = calculateATR(highs, lows, closes, 14);
            prepared.atr = atr;
        }

        // Calculate percentile rank of ATR
        let atrPercentileRank = prepared.atrPercentileRank;
        if (atrPercentileRank.length === 0) {
            const validAtr = atr.map((v, i) => v ?? cleanData[i].close * 0.001);
            atrPercentileRank = validAtr.map((_, i) => {
                if (i < rankLookback - 1) return null;
                let countBelow = 0;
                let validCount = 0;
                for (let j = i - rankLookback + 1; j <= i; j++) {
                    const sample = validAtr[j];
                    if (!Number.isFinite(sample)) continue;
                    validCount++;
                    if (sample < validAtr[i]) countBelow++;
                }
                if (validCount < 2) return 0.5;
                return countBelow / (validCount - 1);
            }).map(v => v ?? 0.5);
            prepared.atrPercentileRank = atrPercentileRank;
        }

        // Calculate wick ratios and ranges
        let lowerWickRatio = prepared.lowerWickRatio;
        let upperWickRatio = prepared.upperWickRatio;
        let ranges = prepared.ranges;
        if (lowerWickRatio.length === 0) {
            lowerWickRatio = new Array(cleanData.length).fill(0);
            upperWickRatio = new Array(cleanData.length).fill(0);
            ranges = new Array(cleanData.length).fill(0);
            for (let i = 0; i < cleanData.length; i++) {
                const bar = cleanData[i];
                const range = bar.high - bar.low;
                ranges[i] = range;
                if (range > 0) {
                    const bodyHigh = Math.max(bar.open, bar.close);
                    const bodyLow = Math.min(bar.open, bar.close);
                    const upperWick = Math.max(0, bar.high - bodyHigh);
                    const lowerWick = Math.max(0, bodyLow - bar.low);
                    lowerWickRatio[i] = lowerWick / range;
                    upperWickRatio[i] = upperWick / range;
                }
            }
            prepared.lowerWickRatio = lowerWickRatio;
            prepared.upperWickRatio = upperWickRatio;
            prepared.ranges = ranges;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < rankLookback + 1) return null;

            const rank = atrPercentileRank[i];
            const lowerWick = lowerWickRatio[i];
            const upperWick = upperWickRatio[i];
            const isBullish = cleanData[i].close > cleanData[i].open;
            const isBearish = cleanData[i].close < cleanData[i].open;

            if (rank === null) return null;

            if (rank < atrPercentile) {
                // Buy: lower wick dominates and bar is bullish
                if (isBullish && lowerWick > wickDominance) {
                    return createBuySignal(cleanData, i, "ATR Percentile Decoherence Long");
                }
                // Sell: upper wick dominates and bar is bearish
                if (isBearish && upperWick > wickDominance) {
                    return createSellSignal(cleanData, i, "ATR Percentile Decoherence Short");
                }
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        atr_percentile_decoherence.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rankLookback", "atrPercentile", "wickDominance"] } };
