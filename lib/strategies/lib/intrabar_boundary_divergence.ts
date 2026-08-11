import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getOpens,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const intrabar_boundary_divergence: Strategy = {
    name: "Intrabar Boundary Divergence",
    description: "Sides with the intrabar return component when its rolling sum persistently disagrees in sign with the boundary gap sum.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Divergence Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const opens = getOpens(cleanData);
        const closes = getCloses(cleanData);
        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const intrabar = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            intrabar[i] = opens[i] > 0 ? closes[i] / opens[i] - 1 : 0;
        }

        // Rolling sums: average over the window times its length.
        const gapSum = buildRollingAverage(gapPct, lookback).map((v) => (v === null ? null : v * lookback));
        const intrabarSum = buildRollingAverage(intrabar, lookback).map((v) => (v === null ? null : v * lookback));

        // Joint divergence state; a null (warm-up) reading counts as not active.
        const state = (j: number): { buy: boolean; sell: boolean } => {
            const gap = gapSum[j];
            const intra = intrabarSum[j];
            if (gap === null || intra === null) return { buy: false, sell: false };
            return {
                buy: intra > 0 && gap < 0,
                sell: intra < 0 && gap > 0,
            };
        };

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback - 1) return null;
            const now = state(i);
            const prev = state(i - 1);

            // Intrabar recovery against boundary mark-downs, newly true.
            if (now.buy && !prev.buy) {
                return createBuySignal(cleanData, i, `Intrabar divergence buy: intrabar sum ${intrabarSum[i]!.toFixed(5)}, gap sum ${gapSum[i]!.toFixed(5)}`);
            }
            // Intrabar weakness against boundary mark-ups, newly true.
            if (now.sell && !prev.sell) {
                return createSellSignal(cleanData, i, `Intrabar divergence sell: intrabar sum ${intrabarSum[i]!.toFixed(5)}, gap sum ${gapSum[i]!.toFixed(5)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
