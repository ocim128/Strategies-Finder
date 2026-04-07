import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateDonchianChannels } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawCloseLocSafeZone = Number(params.closeLocSafeZone ?? 0.8);

    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 20)),
        closeLocSafeZone: Math.max(0, Math.min(1, Number.isFinite(rawCloseLocSafeZone) ? rawCloseLocSafeZone : 0.8)) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    donchianUpper: (number | null)[];
    donchianLower: (number | null)[];
    closeLocation: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        donchianUpper: [],
        donchianLower: [],
        closeLocation: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const donchian_rejection_fade: Strategy = {
    name: "Donchian Rejection Fade",
    description: "A high-precision execution mechanic that fades Donchian channel structural limits strictly when price pierces the absolute mathematical boundary but the closing tick snaps aggressively to the safe-zone.",
    defaultParams: {
        lookback: 20,
        closeLocSafeZone: 0.8 },
    paramLabels: {
        lookback: "Lookback",
        closeLocSafeZone: "Close Location Safe Zone" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const lookback = Math.max(2, Math.round(params.lookback ?? 20));
        const closeLocSafeZone = Number(params.closeLocSafeZone ?? 0.8);

        if (cleanData.length < lookback + 2) return [];

        // Calculate Donchian channels
        let donchianUpper = prepared.donchianUpper;
        let donchianLower = prepared.donchianLower;
        if (donchianUpper.length === 0 || donchianLower.length === 0) {
            const highs = cleanData.map(d => d.high);
            const lows = cleanData.map(d => d.low);
            const channels = calculateDonchianChannels(highs, lows, lookback);
            donchianUpper = channels.upper;
            donchianLower = channels.lower;
            prepared.donchianUpper = donchianUpper;
            prepared.donchianLower = donchianLower;
        }

        // Calculate close location
        let closeLocation = prepared.closeLocation;
        if (closeLocation.length === 0) {
            closeLocation = cleanData.map(bar => {
                const range = bar.high - bar.low;
                if (range <= 0) return 0.5;
                return (bar.close - bar.low) / range;
            });
            prepared.closeLocation = closeLocation;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;

            const upper = donchianUpper[i];
            const lower = donchianLower[i];
            const cLoc = closeLocation[i];
            const low = cleanData[i].low;
            const high = cleanData[i].high;
            const close = cleanData[i].close;

            if (upper === null || lower === null || cLoc === null) return null;

            // Buy: Low below lower band (breach) AND Close above lower band (rejection) AND close location is high (retreat)
            if (low < lower && close > lower && cLoc > closeLocSafeZone) {
                return createBuySignal(cleanData, i, "Donchian Rejection Fade Long");
            }

            // Sell: High above upper band (breach) AND Close below upper band (rejection) AND close location is low (retreat)
            if (high > upper && close < upper && cLoc < (1.0 - closeLocSafeZone)) {
                return createSellSignal(cleanData, i, "Donchian Rejection Fade Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        donchian_rejection_fade.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "closeLocSafeZone"] } };
