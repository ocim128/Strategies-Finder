import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingEntropy } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        entropyThreshold: Math.max(0, Math.min(1, Number(params.entropyThreshold ?? 0.25))),
    };
}

export const entropy_compression_breakout: Strategy = {
    name: "Entropy Compression Breakout",
    description: "Follows close location breakouts emerging from entropy compression phases.",
    defaultParams: {
        lookback: 30,
        entropyThreshold: 0.25,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyThreshold: "Entropy Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const entropy = buildRollingEntropy(closes, lookback, 5);
        const entropyNumbers = entropy.map((v) => (v !== null ? v : 0));
        const entropyPctl = buildPercentileRank(entropyNumbers, lookback);

        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [entropyPctl], (i) => {
            const ep = entropyPctl[i];
            if (ep === null) return null;

            // Check if entropy rank was below threshold in the previous 4 bars (excluding current bar)
            let hasCompression = false;
            for (let k = 1; k <= 4; k++) {
                const prevIdx = i - k;
                if (prevIdx >= 0) {
                    const prevEp = entropyPctl[prevIdx];
                    if (prevEp !== null && prevEp < p.entropyThreshold) {
                        hasCompression = true;
                        break;
                    }
                }
            }

            if (!hasCompression) return null;

            const cl = closeLocation[i];

            if (cl > 0.75) {
                return createBuySignal(cleanData, i, `Entropy compression breakout buy: CL ${cl.toFixed(2)}`);
            }
            if (cl < 0.25) {
                return createSellSignal(cleanData, i, `Entropy compression breakout sell: CL ${cl.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold"],
    },
};
