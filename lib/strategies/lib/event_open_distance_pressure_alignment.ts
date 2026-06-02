import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming event open (data[0].open) serves as a stable directional breakout anchor.
// #SUGGEST_VERIFY: Verify that decay (0.9 to 0.99) doesn't result in cumulative sum overflows.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 100))),
        decay: Math.max(0.1, Math.min(0.999, Number(params.decay ?? 0.95))),
        minPressure: Math.max(0.1, Number(params.minPressure ?? 1.0)),
    };
}

export const event_open_distance_pressure_alignment: Strategy = {
    name: "Event Open Distance Pressure Alignment",
    description: "Aligns event-open distance shifts with cumulative initiative volume pressure to capture breakout waves.",
    defaultParams: {
        lookback: 100,
        decay: 0.95,
        minPressure: 1.0,
    },
    paramLabels: {
        lookback: "Lookback",
        decay: "Decay Factor",
        minPressure: "Min Pressure",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const decay = p.decay as number;
        const minPressure = p.minPressure as number;
        if (cleanData.length < lookback + 1) return [];

        const eventOpen = cleanData[0].open;
        const closes = getCloses(cleanData);
        const pressure = buildInitiativePressureSeries(cleanData, lookback);

        // Initiative pressure has nulls during initial warmup, sanitize to 0
        const sanitizedPressure = pressure.map(v => v ?? 0);
        const decayedPressure = buildCumulativeDecaySum(sanitizedPressure, decay);

        return createSignalLoop(cleanData, [pressure], (i) => {
            const currentClose = closes[i];
            const dp = decayedPressure[i];

            // Buy: Close is above event open, and decayed cumulative pressure is strongly positive
            if (currentClose > eventOpen && dp > minPressure) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish breakout: close above event open (${eventOpen.toFixed(2)}) with strong buy pressure (${dp.toFixed(2)} > ${minPressure})`
                );
            }

            // Sell: Close is below event open, and decayed cumulative pressure is strongly negative
            if (currentClose < eventOpen && dp < -minPressure) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish breakout: close below event open (${eventOpen.toFixed(2)}) with strong sell pressure (${dp.toFixed(2)} < -${minPressure})`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay", "minPressure"],
    },
};
