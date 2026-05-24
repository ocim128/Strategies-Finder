import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingEntropy, buildRollingMinMax } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const ENTROPY_BINS = 5;
const MAX_ENTROPY = Math.log2(ENTROPY_BINS);

function normalizeVolumeEntropyContractionPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        entropyThreshold: normalizeNumberParam(params.entropyThreshold, 0.44, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

export const volume_entropy_contraction_pressure_gap: Strategy = {
    name: "Volume Entropy Contraction with Pressure Gap",
    description: "Fades trailing price boundaries when volume-return entropy contracts and Polymarket pressure edge supports the side.",
    defaultParams: {
        lookback: 30,
        entropyThreshold: 0.44,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyThreshold: "Maximum Normalized Entropy",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeVolumeEntropyContractionPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeEntropyContractionPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const volumes = getVolumes(cleanData);
        const volumeReturns = volumes.map((volume, i) => i === 0 || volumes[i - 1] <= 0 ? 0 : Math.log(Math.max(volume, 1e-12) / volumes[i - 1]));
        const entropy = buildRollingEntropy(volumeReturns, lookback, ENTROPY_BINS);
        const boundary = buildRollingMinMax(typicals, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [entropy, boundary.min, boundary.max, pressure.longEdge, pressure.shortEdge], (i) => {
            const entropyValue = entropy[i];
            const low = boundary.min[i];
            const high = boundary.max[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (entropyValue === null || low === null || high === null || longEdge === null || shortEdge === null) return null;
            if (entropyValue / MAX_ENTROPY > p.entropyThreshold) return null;

            if (typicals[i] <= low && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Low volume entropy at trailing low with YES pressure edge");
            }
            if (typicals[i] >= high && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Low volume entropy at trailing high with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold", "minEdge"],
    },
};
