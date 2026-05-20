import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./polymarket-1s-strategy-utils";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        fastWindow: Math.max(2, Math.round(Number(params.fastWindow ?? 10))),
        slowWindow: Math.max(5, Math.round(Number(params.slowWindow ?? 40))),
        contractionThreshold: Math.max(0.01, Math.min(0.99, Number(params.contractionThreshold ?? 0.30))),
    };
}

export const range_contraction_breakout_edge_persistence: Strategy = {
    name: "Range Contraction Breakout Edge Persistence",
    description: "Identifies extreme price contractions (coiling) on Binance and enters on decisive range breakouts, utilizing a persistent executable edge on Polymarket to secure a favorable probability rate.",
    defaultParams: {
        fastWindow: 10,
        slowWindow: 40,
        contractionThreshold: 0.30,
    },
    paramLabels: {
        fastWindow: "Fast Range Window",
        slowWindow: "Slow Baseline Window",
        contractionThreshold: "Contraction Threshold",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const fastWindow = p.fastWindow as number;
        const slowWindow = p.slowWindow as number;
        const contractionThreshold = p.contractionThreshold as number;

        if (cleanData.length < slowWindow + 1) return [];

        const closes = getCloses(cleanData);

        const fastBounds = buildRollingMinMax(closes, fastWindow, true); // fast includes current bar
        const slowBounds = buildRollingMinMax(closes, slowWindow, true); // slow includes current bar
        const trailingSlowBounds = buildRollingMinMax(closes, slowWindow, false); // trailing baseline excludes current bar

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: slowWindow });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: slowWindow,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        const persistence = buildPolymarket1sEdgePersistence(edge, {
            minEdge: 0.01,
            ewmaLookback: 3, //EWMA lookback mapped to persistenceSec=3
        });

        return createSignalLoop(cleanData, [fastBounds.min, fastBounds.max, slowBounds.min, slowBounds.max], (i) => {
            if (i < 1) return null;

            // Squeeze check at prior bar i-1 to identify setup coiling
            const fastRangePrev = (fastBounds.max[i - 1] ?? 0) - (fastBounds.min[i - 1] ?? 0);
            const slowRangePrev = (slowBounds.max[i - 1] ?? 0) - (slowBounds.min[i - 1] ?? 0);
            const ratioPrev = slowRangePrev > 0 ? fastRangePrev / slowRangePrev : 1.0;

            const currentClose = closes[i];
            const trailingMax = trailingSlowBounds.max[i];
            const trailingMin = trailingSlowBounds.min[i];

            const yesEdgeSec = persistence.yesEdgeSeconds[i];
            const noEdgeSec = persistence.noEdgeSeconds[i];

            if (trailingMax === null || trailingMin === null) return null;

            // Buy: setup coils, close breaks above trailingMax, persistent YES edge
            if (ratioPrev < contractionThreshold && currentClose > trailingMax && yesEdgeSec >= 3 && actionability.yesActionable[i]) {
                return createBuySignal(cleanData, i, `Coil ratio ${ratioPrev.toFixed(2)} breakout above ${trailingMax.toFixed(2)} with persistent YES edge`);
            }

            // Sell: setup coils, close breaks below trailingMin, persistent NO edge
            if (ratioPrev < contractionThreshold && currentClose < trailingMin && noEdgeSec >= 3 && actionability.noActionable[i]) {
                return createSellSignal(cleanData, i, `Coil ratio ${ratioPrev.toFixed(2)} breakout below ${trailingMin.toFixed(2)} with persistent NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastWindow", "slowWindow", "contractionThreshold"],
    },
};
