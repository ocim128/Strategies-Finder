import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRateOfChange, buildRollingStdDev } from "./price-action-statistics-core";

const VOL_STD_WINDOW = 20;
const VOL_PCT_WINDOW = 100;

function normalizeCalmRegimePersistenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        calmPercentile: Math.max(0.05, Math.min(0.5, Number(params.calmPercentile ?? 0.2))),
    };
}

export const calm_regime_persistence: Strategy = {
    name: "Calm Regime Persistence",
    description: "Trades the mild drift of close placement while return volatility sits at a low percentile.",
    defaultParams: {
        calmPercentile: 0.2,
    },
    paramLabels: {
        calmPercentile: "Calm Vol Percentile",
    },
    normalizeParams: normalizeCalmRegimePersistenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCalmRegimePersistenceParams(params);
        const calmPercentile = p.calmPercentile as number;
        if (cleanData.length < VOL_PCT_WINDOW + 1) return [];

        const closes = getCloses(cleanData);
        const roc1 = buildRateOfChange(closes, 1);
        const returnsClean = roc1.map((v) => v ?? 0);
        const volatility = buildRollingStdDev(returnsClean, VOL_STD_WINDOW);
        const volClean = volatility.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, VOL_PCT_WINDOW);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [volPct], (i) => {
            if (i < VOL_PCT_WINDOW) return null;
            const vp = volPct[i];
            if (vp === null) return null;

            if (vp < calmPercentile && closeLocation[i] > 0.55) {
                return createBuySignal(cleanData, i, `Calm regime: vol percentile ${vp.toFixed(2)} with upper close ${closeLocation[i].toFixed(2)}`);
            }
            if (vp < calmPercentile && closeLocation[i] < 0.45) {
                return createSellSignal(cleanData, i, `Calm regime: vol percentile ${vp.toFixed(2)} with lower close ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["calmPercentile"],
    },
};
