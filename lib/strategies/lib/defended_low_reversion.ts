import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMinMax } from "./price-action-statistics-core";

const EDGE_POSITION = 0.1;
const ACCEPTANCE_THRESHOLD = 0.1;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 50))),
    };
}

export const defended_low_reversion: Strategy = {
    name: "Defended Low Reversion",
    description: "Fades channel-edge prints where the opposing side won the close, showing the edge was defended.",
    defaultParams: {
        lookback: 50,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const { min, max } = buildRollingMinMax(closes, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [min, max], (i) => {
            const minNow = min[i];
            const maxNow = max[i];
            if (minNow === null || maxNow === null) return null;

            const width = maxNow - minNow;
            if (width <= 0) return null;

            const position = (closes[i] - minNow) / width;
            const acceptanceNow = acceptance[i];

            // Low edge printed but buyers won the close: the low is defended.
            if (position <= EDGE_POSITION && acceptanceNow >= ACCEPTANCE_THRESHOLD) {
                return createBuySignal(cleanData, i, `Defended low buy: position ${position.toFixed(2)}, acceptance ${acceptanceNow.toFixed(2)}`);
            }
            // High edge printed but sellers won the close: the high is defended.
            if (position >= 1 - EDGE_POSITION && acceptanceNow <= -ACCEPTANCE_THRESHOLD) {
                return createSellSignal(cleanData, i, `Defended high sell: position ${position.toFixed(2)}, acceptance ${acceptanceNow.toFixed(2)}`);
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
