import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeGapFillVolumeConfirmedParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        gapPercentileMin: Math.max(0, Math.min(1, Number(params.gapPercentileMin ?? 0.55))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.45))),
    };
}

export const gap_fill_volume_confirmed: Strategy = {
    name: "Gap Fill Volume Confirmed",
    description: "Gap fill with proxy volume confirmation.",
    defaultParams: {
        lookback: 25,
        gapPercentileMin: 0.55,
        volumePercentileMin: 0.45,
    },
    paramLabels: {
        lookback: "Lookback",
        gapPercentileMin: "Gap Percentile Min",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeGapFillVolumeConfirmedParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeGapFillVolumeConfirmedParams(params);
        const lookback = p.lookback as number;
        const gapPercentileMin = p.gapPercentileMin as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 2) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const absGapPct = gapPct.map(v => Math.abs(v));
        const gapPercentile = buildPercentileRank(absGapPct, lookback);

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [gapPercentile, volumePercentile, gapPct, closeReturn], (i) => {
            const gapPctRank = gapPercentile[i];
            const volPct = volumePercentile[i];
            const gap = gapPct[i];
            const ret = closeReturn[i];

            if (gapPctRank === null || volPct === null || gap === null || ret === null) return null;

            if (gapPctRank > gapPercentileMin && volPct > volumePercentileMin) {
                // gap < 0 (down), return > 0 (filling up)
                if (gap < 0 && ret > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Gap fill buy: gap down ${gap.toFixed(4)}, close return ${ret.toFixed(4)}, vol pct ${volPct.toFixed(2)}`
                    );
                }
                // gap > 0 (up), return < 0 (filling down)
                if (gap > 0 && ret < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Gap fill sell: gap up ${gap.toFixed(4)}, close return ${ret.toFixed(4)}, vol pct ${volPct.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "gapPercentileMin", "volumePercentileMin"],
    },
};
