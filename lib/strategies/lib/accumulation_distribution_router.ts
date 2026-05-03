import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeAccumulationDistributionRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        cmf_lookback: Math.max(2, Math.round(Number(params.cmf_lookback ?? 63))),
        regime_threshold: Math.max(-1, Math.min(1, Number(params.regime_threshold ?? 0.1))),
    };
}

export const accumulation_distribution_router: Strategy = {
    name: "Accumulation Distribution Router",
    description:
        "Routes positive CMF accumulation to median alignment and weaker distribution context to value-boundary reversion.",
    defaultParams: {
        cmf_lookback: 63,
        regime_threshold: 0.1,
    },
    paramLabels: {
        cmf_lookback: "CMF Lookback",
        regime_threshold: "Regime Threshold",
    },
    normalizeParams: normalizeAccumulationDistributionRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAccumulationDistributionRouterParams(params);
        const lookback = p.cmf_lookback as number;
        const threshold = p.regime_threshold as number;
        if (cleanData.length < lookback * 2) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
        const median = buildRollingMedian(closes, lookback);
        const distanceFromMedian = closes.map((close, i) => {
            const med = median[i];
            return med === null ? 0 : Math.abs(close - med);
        });
        const averageDistance = buildRollingAverage(distanceFromMedian, lookback);

        return createSignalLoop(cleanData, [cmf, median, averageDistance], (i) => {
            if (i < lookback * 2 - 2) return null;

            const flow = cmf[i];
            const med = median[i];
            const avgDistance = averageDistance[i];
            if (flow === null || med === null || avgDistance === null || avgDistance <= 0) return null;

            if (flow > threshold) {
                if (closes[i] > med) {
                    return createBuySignal(cleanData, i, `Accumulation regime CMF ${flow.toFixed(3)} above median`);
                }
                if (closes[i] < med) {
                    return createSellSignal(cleanData, i, `Accumulation regime CMF ${flow.toFixed(3)} below median`);
                }
                return null;
            }

            if (closes[i] <= med - avgDistance) {
                return createBuySignal(cleanData, i, `Distribution regime lower value boundary with CMF ${flow.toFixed(3)}`);
            }
            if (closes[i] >= med + avgDistance) {
                return createSellSignal(cleanData, i, `Distribution regime upper value boundary with CMF ${flow.toFixed(3)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["cmf_lookback", "regime_threshold"],
    },
};
