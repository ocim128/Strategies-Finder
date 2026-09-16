import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        gap_threshold: Math.max(0, Number(params.gap_threshold ?? 0.05)),
    };
}

export const adjacent_range_gap_open_intrabar_reclaim: Strategy = {
    name: "Adjacent Range Gap Open Intrabar Reclaim",
    description: "Fades opening gap moves that fail to hold and close back inside the prior bar's range within the same bar.",
    defaultParams: {
        gap_threshold: 0.05,
    },
    paramLabels: {
        gap_threshold: "Gap Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const gapThreshold = p.gap_threshold as number;
        if (cleanData.length < 2) return [];

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            const prior = cleanData[i - 1];
            const current = cleanData[i];
            const priorRange = prior.high - prior.low;
            if (priorRange <= 0) return null;

            // Buy: Open gaps below prior low by gap_threshold * range, but close reclaims above prior low
            const buyGapLevel = prior.low - priorRange * gapThreshold;
            if (current.open < buyGapLevel && current.close > prior.low) {
                return createBuySignal(cleanData, i, `Bullish gap-open reclaim: open ${current.open.toFixed(4)} < ${buyGapLevel.toFixed(4)}, close ${current.close.toFixed(4)} > prior low ${prior.low.toFixed(4)}`);
            }

            // Sell: Open gaps above prior high by gap_threshold * range, but close drops back below prior high
            const sellGapLevel = prior.high + priorRange * gapThreshold;
            if (current.open > sellGapLevel && current.close < prior.high) {
                return createSellSignal(cleanData, i, `Bearish gap-open reclaim: open ${current.open.toFixed(4)} > ${sellGapLevel.toFixed(4)}, close ${current.close.toFixed(4)} < prior high ${prior.high.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["gap_threshold"],
    },
};
