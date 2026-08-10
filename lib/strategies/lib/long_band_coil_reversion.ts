import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeLongBandCoilReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        bandLookback: Math.max(30, Math.round(Number(params.bandLookback ?? 120))),
    };
}

export const long_band_coil_reversion: Strategy = {
    name: "Long Band Coil Reversion",
    description: "Fades placement extremes back to center when the prior-only trailing band is coiled at an extreme tightness percentile.",
    defaultParams: {
        bandLookback: 120,
    },
    paramLabels: {
        bandLookback: "Band Lookback",
    },
    normalizeParams: normalizeLongBandCoilReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLongBandCoilReversionParams(params);
        const bandLookback = p.bandLookback as number;
        if (cleanData.length < bandLookback * 2) return [];

        const channel = buildTrailingHighLow(cleanData, bandLookback, false);
        const bandWidth: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = 0; i < cleanData.length; i++) {
            if (channel.highest[i] !== null && channel.lowest[i] !== null) {
                bandWidth[i] = channel.highest[i]! - channel.lowest[i]!;
            }
        }
        const widthClean = bandWidth.map((v) => v ?? 0);
        const widthPct = buildPercentileRank(widthClean, bandLookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [widthPct], (i) => {
            if (i < bandLookback * 2 - 1) return null;
            const wPct = widthPct[i];
            if (wPct === null) return null;

            if (wPct <= 0.2 && closeLocation[i] < 0.3) {
                return createBuySignal(cleanData, i, `Coiled band (width percentile ${wPct.toFixed(2)}) with bottom placement ${closeLocation[i].toFixed(2)}`);
            }
            if (wPct <= 0.2 && closeLocation[i] > 0.7) {
                return createSellSignal(cleanData, i, `Coiled band (width percentile ${wPct.toFixed(2)}) with top placement ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["bandLookback"],
    },
};
