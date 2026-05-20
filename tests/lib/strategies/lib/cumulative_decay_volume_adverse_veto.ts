import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 15))),
        decayFactor: Math.max(0.01, Math.min(0.99, Number(params.decayFactor ?? 0.88))),
        maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.03)),
    };
}

export const cumulative_decay_volume_adverse_veto: Strategy = {
    name: "Cumulative Decay Volume Adverse Veto",
    description: "Tracks decaying cumulative directional volume impulses on Binance to identify heavy institutional buying or selling flow, using the Polymarket pressure gap to veto entries if the move is already overpriced.",
    defaultParams: {
        lookback: 15,
        decayFactor: 0.88,
        maxAdverse: 0.03,
    },
    paramLabels: {
        lookback: "Volume Lookback",
        decayFactor: "Decay Factor",
        maxAdverse: "Maximum Adverse Gap",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const decayFactor = p.decayFactor as number;
        const maxAdverse = p.maxAdverse as number;

        if (cleanData.length < lookback) return [];

        const len = cleanData.length;
        const volumes = getVolumes(cleanData);

        // Normalized volume by rolling 20-period average to keep the decay sum in a stable range (-5 to +5)
        const avgVolumes = new Array(len).fill(0);
        let sumVol = 0;
        for (let i = 0; i < len; i++) {
            sumVol += volumes[i];
            if (i >= 20) sumVol -= volumes[i - 20];
            avgVolumes[i] = i >= 19 ? sumVol / 20 : volumes[i];
        }

        const normalizedVolImpulses = new Array(len).fill(0);
        for (let i = 1; i < len; i++) {
            const prev = cleanData[i - 1].close;
            const diff = cleanData[i].close - prev;
            const returnSign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
            const normVol = avgVolumes[i] > 0 ? volumes[i] / avgVolumes[i] : 1.0;
            normalizedVolImpulses[i] = normVol * returnSign;
        }

        const cumulativeDecay = buildCumulativeDecaySum(normalizedVolImpulses, decayFactor);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        // Threshold default calibrated to normalized volume units
        const threshold = 1.5;

        return createSignalLoop(cleanData, [cumulativeDecay, pressure.longAdverse, pressure.shortAdverse], (i) => {
            const sum = cumulativeDecay[i];
            const longAdverse = pressure.longAdverse[i];
            const shortAdverse = pressure.shortAdverse[i];

            if (sum === null || longAdverse === null || shortAdverse === null) return null;

            // Buy: cumulative decay sum exceeds threshold, longAdverse is low (no adverse veto)
            if (sum > threshold && longAdverse <= maxAdverse) {
                return createBuySignal(cleanData, i, `Heavy buying volume momentum ${sum.toFixed(2)} with low adverse gap ${longAdverse.toFixed(3)}`);
            }

            // Sell: cumulative decay sum falls below negative threshold, shortAdverse is low
            if (sum < -threshold && shortAdverse <= maxAdverse) {
                return createSellSignal(cleanData, i, `Heavy selling volume momentum ${sum.toFixed(2)} with low adverse gap ${shortAdverse.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decayFactor", "maxAdverse"],
    },
};
