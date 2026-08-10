import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParticipationPersistenceFlowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const participation_persistence_flow: Strategy = {
    name: "Participation Persistence Flow",
    description: "Trades close placement direction when a sustained majority of recent bars show above-median proxy volume.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeParticipationPersistenceFlowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParticipationPersistenceFlowParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const volumes = getVolumes(cleanData);
        const volPct = buildPercentileRank(volumes, lookback);
        const flags: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            const vp = volPct[i];
            flags[i] = vp === null ? 0 : (vp > 0.5 ? 1 : 0);
        }
        const participation = buildRollingAverage(flags, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [participation], (i) => {
            if (i < lookback) return null;
            const part = participation[i];
            if (part === null) return null;

            if (part > 0.7 && closeLocation[i] > 0.5) {
                return createBuySignal(cleanData, i, `Sustained participation ${part.toFixed(2)} with upper close ${closeLocation[i].toFixed(2)}`);
            }
            if (part < 0.3 && closeLocation[i] < 0.5) {
                return createSellSignal(cleanData, i, `Thin participation ${part.toFixed(2)} with lower close ${closeLocation[i].toFixed(2)}`);
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
