import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawDecayRate = Number(params.decayRate ?? 0.8);
    const rawZscoreExtreme = Number(params.zscoreExtreme ?? 2.5);

    return {
        ...params,
        decayRate: Math.max(0, Math.min(1, Number.isFinite(rawDecayRate) ? rawDecayRate : 0.8)),
        zscoreExtreme: Number.isFinite(rawZscoreExtreme) ? rawZscoreExtreme : 2.5 };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    closes: number[];
    roc: number[];
    decayedRoc: number[];
    decayedRocZscore: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    return {
        cleanData,
        closes,
        roc: [],
        decayedRoc: [],
        decayedRocZscore: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const decayed_velocity_equilibrium: Strategy = {
    name: "Decayed Velocity Equilibrium",
    description: "Tracks the decayed sum of velocity to find kinetic overextension, executing exactly when the instantaneous rate of change snaps back to absolute zero equilibrium.",
    defaultParams: {
        decayRate: 0.8,
        zscoreExtreme: 2.5 },
    paramLabels: {
        decayRate: "Decay Rate",
        zscoreExtreme: "Z-Score Extreme" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData, closes } = prepared;

        const decayRate = Number(params.decayRate ?? 0.8);
        const zscoreExtreme = Number(params.zscoreExtreme ?? 2.5);

        if (cleanData.length < 20) return [];

        // Calculate rate of change (ROC)
        let roc = prepared.roc;
        if (roc.length === 0) {
            roc = normalizeSeries(buildRateOfChange(closes, 1));
            prepared.roc = roc;
        }

        // Calculate decayed sum of ROC
        let decayedRoc = prepared.decayedRoc;
        if (decayedRoc.length === 0) {
            decayedRoc = new Array(cleanData.length).fill(0);
            for (let i = 1; i < cleanData.length; i++) {
                const rocVal = roc[i] ?? 0;
                decayedRoc[i] = decayRate * (decayedRoc[i - 1] ?? 0) + rocVal;
            }
            prepared.decayedRoc = decayedRoc;
        }

        // Calculate Z-Score of decayed ROC
        let decayedRocZscore = prepared.decayedRocZscore;
        if (decayedRocZscore.length === 0) {
            decayedRocZscore = normalizeSeries(buildRollingZScore(decayedRoc, 20));
            prepared.decayedRocZscore = decayedRocZscore;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 21) return null;

            const zscore = decayedRocZscore[i];
            const currentRoc = roc[i];
            const prevRoc = roc[i - 1];

            if (zscore === null || currentRoc === null || prevRoc === null) return null;

            // Buy: Z-Score is extremely negative AND ROC crosses above 0 (from negative to positive)
            if (zscore < -zscoreExtreme && prevRoc < 0 && currentRoc >= 0) {
                return createBuySignal(cleanData, i, "Decayed Velocity Equilibrium Long");
            }

            // Sell: Z-Score is extremely positive AND ROC crosses below 0 (from positive to negative)
            if (zscore > zscoreExtreme && prevRoc > 0 && currentRoc <= 0) {
                return createSellSignal(cleanData, i, "Decayed Velocity Equilibrium Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        decayed_velocity_equilibrium.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["decayRate", "zscoreExtreme"] } };
