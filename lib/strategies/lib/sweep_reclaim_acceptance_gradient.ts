import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseAcceptanceSeries,
    buildSweepReclaimScoreSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        acceptance_threshold: Math.max(0.01, Math.min(1, Number(params.acceptance_threshold ?? 0.65))),
    };
}

export const sweep_reclaim_acceptance_gradient: Strategy = {
    name: "Sweep Reclaim Acceptance Gradient",
    description: "Requires close acceptance gradient confirmation following a sweep-reclaim bar to enter structural absorption reversals.",
    defaultParams: {
        acceptance_threshold: 0.65,
    },
    paramLabels: {
        acceptance_threshold: "Acceptance Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const acceptance_threshold = p.acceptance_threshold as number;
        if (cleanData.length < 2) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);
        const closeAccept = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [sweep, closeAccept], (i) => {
            if (i < 1) return null;
            const prevSweep = sweep[i - 1];
            const currAccept = closeAccept[i];
            if (prevSweep === null || currAccept === null) return null;

            if (prevSweep >= 0.25 && currAccept >= acceptance_threshold) {
                return createBuySignal(cleanData, i, `Bullish sweep acceptance: prior sweep ${prevSweep.toFixed(3)} >= 0.25, close acceptance ${currAccept.toFixed(3)} >= ${acceptance_threshold}`);
            }
            if (prevSweep <= -0.25 && currAccept <= (1 - acceptance_threshold)) {
                return createSellSignal(cleanData, i, `Bearish sweep acceptance: prior sweep ${prevSweep.toFixed(3)} <= -0.25, close acceptance ${currAccept.toFixed(3)} <= ${(1 - acceptance_threshold).toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["acceptance_threshold"],
    },
};
