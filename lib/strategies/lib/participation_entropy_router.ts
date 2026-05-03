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
import { buildRateOfChange, buildRollingEntropy, buildRollingMedian } from "./price-action-statistics-core";

const PARTICIPATION_ENTROPY_BINS = 5;
const PARTICIPATION_ENTROPY_MAX = Math.log2(PARTICIPATION_ENTROPY_BINS);

function normalizeParticipationEntropyRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        entropy_lookback: Math.max(3, Math.round(Number(params.entropy_lookback ?? 55))),
        threshold: Math.max(0, Math.min(1, Number(params.threshold ?? 0.5))),
    };
}

export const participation_entropy_router: Strategy = {
    name: "Participation Entropy Router",
    description:
        "Routes low normalized entropy to CMF-confirmed median alignment and high entropy to median reversion from stretched closes.",
    defaultParams: {
        entropy_lookback: 55,
        threshold: 0.5,
    },
    paramLabels: {
        entropy_lookback: "Entropy Lookback",
        threshold: "Threshold",
    },
    normalizeParams: normalizeParticipationEntropyRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParticipationEntropyRouterParams(params);
        const lookback = p.entropy_lookback as number;
        const threshold = p.threshold as number;
        if (cleanData.length < lookback * 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const entropy = buildRollingEntropy(returns, lookback, PARTICIPATION_ENTROPY_BINS)
            .map((value) => value === null ? null : value / PARTICIPATION_ENTROPY_MAX);
        const median = buildRollingMedian(closes, lookback);
        const distanceFromMedian = closes.map((close, i) => {
            const med = median[i];
            return med === null ? 0 : Math.abs(close - med);
        });
        const distanceMedian = buildRollingMedian(distanceFromMedian, lookback);
        const cmf = calculateCMF(getHighs(cleanData), getLows(cleanData), closes, getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [entropy, median, distanceMedian, cmf], (i) => {
            const ent = entropy[i];
            const med = median[i];
            const typicalDistance = distanceMedian[i];
            const flow = cmf[i];
            if (ent === null || med === null || typicalDistance === null || flow === null) return null;

            if (ent < threshold) {
                if (closes[i] > med && flow > 0) {
                    return createBuySignal(cleanData, i, `Low entropy participation long ${ent.toFixed(2)}`);
                }
                if (closes[i] < med && flow < 0) {
                    return createSellSignal(cleanData, i, `Low entropy participation short ${ent.toFixed(2)}`);
                }
                return null;
            }

            if (typicalDistance <= 0) return null;
            if (closes[i] <= med - typicalDistance) {
                return createBuySignal(cleanData, i, `High entropy lower value reversion ${ent.toFixed(2)}`);
            }
            if (closes[i] >= med + typicalDistance) {
                return createSellSignal(cleanData, i, `High entropy upper value reversion ${ent.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["entropy_lookback", "threshold"],
    },
};
