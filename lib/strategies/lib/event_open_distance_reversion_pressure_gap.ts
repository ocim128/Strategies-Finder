import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: Math.max(5, Math.round(Number(params.volLookback ?? 25))),
        zThreshold: Math.max(0.1, Number(params.zThreshold ?? 2.2)),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const event_open_distance_reversion_pressure_gap: Strategy = {
    name: "Event Open Distance Reversion Pressure Gap",
    description: "Exploits overextended shifts in the Binance-implied event-open boundary distance, entering counter-trend reversions only when a favorable Polymarket pressure gap confirms the contract is mispriced.",
    defaultParams: {
        volLookback: 25,
        zThreshold: 2.2,
        minEdge: 0.015,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        zThreshold: "Z-Score Threshold",
        minEdge: "Minimum Same-Side Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const volLookback = p.volLookback as number;
        const zThreshold = p.zThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < volLookback) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [pressure.distanceZ, pressure.longEdge, pressure.shortEdge], (i) => {
            if (i < 1) return null;

            const prevDistanceZ = pressure.distanceZ[i - 1];
            const currentDistanceZ = pressure.distanceZ[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];

            if (prevDistanceZ === null || currentDistanceZ === null || longEdge === null || shortEdge === null) return null;

            // Buy: distanceZ crosses back above negative zThreshold (mean-reverting from deep oversold)
            if (prevDistanceZ < -zThreshold && currentDistanceZ >= -zThreshold && longEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Z-distance reverted from deep oversold with YES edge ${longEdge.toFixed(3)}`);
            }

            // Sell: distanceZ crosses back below positive zThreshold (mean-reverting from deep overbought)
            if (prevDistanceZ > zThreshold && currentDistanceZ <= zThreshold && shortEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Z-distance reverted from deep overbought with NO edge ${shortEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "zThreshold", "minEdge"],
    },
};
