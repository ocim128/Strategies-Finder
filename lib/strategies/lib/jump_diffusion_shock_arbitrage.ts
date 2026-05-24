import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildLogReturnSeries } from "./polymarket-1s-strategy-utils";
import { buildPolymarket1sActionabilityMask, buildPolymarket1sExecutableEdge } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming jumpThreshold defines extreme shock price jump as 3.0 standard deviations
// #SUGGEST_VERIFY: Verify return and volume z-score calculations behave correctly with low volatility/volume bars
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 25))),
        jumpThreshold: Math.max(0.1, Number(params.jumpThreshold ?? 3.0)),
        minEdge: Math.max(0.0, Number(params.minEdge ?? 0.02)),
    };
}

export const jump_diffusion_shock_arbitrage: Strategy = {
    name: "Jump Diffusion Shock Arbitrage",
    description: "Exploits the latency of Polymarket liquidity providers to adjust ask quotes immediately following an extreme, high-volume price jump (jump-diffusion shock) on Binance.",
    defaultParams: {
        lookback: 25,
        jumpThreshold: 3.0,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Z-Score Lookback",
        jumpThreshold: "Jump Z-Score Threshold",
        minEdge: "Minimum Edge Magnitude",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const jumpThreshold = p.jumpThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback) return [];

        const returns = buildLogReturnSeries(cleanData);
        const volumes = getVolumes(cleanData);

        const returnZ = buildRollingZScore(returns, lookback);
        const volumeZ = buildRollingZScore(volumes, lookback);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, { volLookback: lookback });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(
            cleanData,
            [returnZ, volumeZ, edge.buyYesEdge, edge.buyNoEdge],
            (i) => {
                if (i < lookback) return null;

                const rZ = returnZ[i];
                const vZ = volumeZ[i];
                const buyYesEdge = edge.buyYesEdge[i];
                const buyNoEdge = edge.buyNoEdge[i];
                const yesActionable = actionability.yesActionable[i];
                const noActionable = actionability.noActionable[i];

                if (rZ === null || vZ === null || buyYesEdge === null || buyNoEdge === null) return null;

                // Volume shock condition: volume z-score >= 2.0
                if (vZ < 2.0) return null;

                // YES shock buy: positive price return z-score >= jumpThreshold
                if (rZ >= jumpThreshold && yesActionable && buyYesEdge >= minEdge) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Jump shock buy YES: returnZ ${rZ.toFixed(2)}, volZ ${vZ.toFixed(2)}, edge ${buyYesEdge.toFixed(3)}`
                    );
                }

                // NO shock buy: negative return z-score <= -jumpThreshold
                if (rZ <= -jumpThreshold && noActionable && buyNoEdge >= minEdge) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Jump shock buy NO: returnZ ${rZ.toFixed(2)}, volZ ${vZ.toFixed(2)}, edge ${buyNoEdge.toFixed(3)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "jumpThreshold", "minEdge"],
    },
};
