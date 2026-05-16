import type {
    Strategy,
    OHLCVData,
    StrategyParams,
    StrategyExecutionContext,
} from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";
import { buildRollingAverage, buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRelativeStrength } from "./cross-symbol-helpers";

function normalizeDominanceHandoffExhaustionParams(params: StrategyParams): StrategyParams {
    const dominanceLookback = Math.max(5, Math.round(params.dominanceLookback ?? 20));
    const rocLookback = Math.max(5, Math.round(params.rocLookback ?? 10));
    const acceptanceBuyThreshold = Math.max(0, Math.min(1, Number(params.acceptanceBuyThreshold ?? 0.6)));
    const acceptanceSellThreshold = Math.max(0, Math.min(1, Number(params.acceptanceSellThreshold ?? 0.4)));
    return {
        ...params,
        dominanceLookback,
        rocLookback,
        acceptanceBuyThreshold,
        acceptanceSellThreshold,
    };
}

export const dominance_handoff_exhaustion: Strategy = {
    name: "Dominance Handoff Exhaustion",
    description: "Signals when the rate of change of inverse RS (secondary/primary) crosses zero after a sustained dominance run, confirmed by primary close acceptance. Captures BTC-to-alt dominance rotation.",
    defaultParams: {
        dominanceLookback: 20,
        rocLookback: 10,
        acceptanceBuyThreshold: 0.6,
        acceptanceSellThreshold: 0.4,
    },
    paramLabels: {
        dominanceLookback: "Dominance Lookback",
        rocLookback: "ROC Lookback",
        acceptanceBuyThreshold: "Acceptance Buy Threshold",
        acceptanceSellThreshold: "Acceptance Sell Threshold",
    },
    normalizeParams: normalizeDominanceHandoffExhaustionParams,
    crossSymbolConfig: {
        defaultSymbol: "BTCUSDT",
        userSelectable: true,
        minBars: 50,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeDominanceHandoffExhaustionParams(params);
        const minWarmup = p.dominanceLookback + p.rocLookback;
        if (cleanData.length < minWarmup) return [];

        const secondaryData = context.crossSymbol.secondaryData;
        const primaryCloses = getCloses(cleanData);
        const secondaryCloses = getCloses(secondaryData);

        const inverseRS = buildRelativeStrength(secondaryCloses, primaryCloses);
        const rocInverseRS = buildRateOfChange(inverseRS, p.rocLookback as number);
        const rocNumbers: number[] = rocInverseRS.map(v => v ?? 0);
        const avgROC = buildRollingAverage(rocNumbers, p.dominanceLookback as number);

        const primaryAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [rocInverseRS, avgROC], (i) => {
            if (i < minWarmup) return null;
            const roc = rocInverseRS[i];
            const avg = avgROC[i];
            if (roc === null || avg === null) return null;

            if (roc < 0 && avg > 0 && primaryAcceptance[i] > p.acceptanceBuyThreshold) {
                return createBuySignal(cleanData, i, `Dominance exhausting, primary auction constructive (ROC=${roc.toFixed(3)})`);
            }
            if (roc > 0 && avg < 0 && primaryAcceptance[i] < p.acceptanceSellThreshold) {
                return createSellSignal(cleanData, i, `Dominance returning, primary auction destructive (ROC=${roc.toFixed(3)})`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["dominanceLookback", "rocLookback", "acceptanceBuyThreshold", "acceptanceSellThreshold"],
    },
};





