import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        reclaimThreshold: Math.max(0.01, Math.min(1.0, Number(params.reclaimThreshold ?? 0.75))),
        maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.03)),
    };
}

export const sweep_reclaim_reversion_adverse_veto: Strategy = {
    name: "Sweep Reclaim Reversion Adverse Veto",
    description: "Fades aggressive liquidity sweeps and reclaims on Binance, vetoing entries if the Polymarket pressure gap shows the event contract has already over-adjusted to the reversion.",
    defaultParams: {
        lookback: 20,
        reclaimThreshold: 0.75,
        maxAdverse: 0.03,
    },
    paramLabels: {
        lookback: "Sweep Lookback",
        reclaimThreshold: "Reclaim Conviction",
        maxAdverse: "Maximum Adverse Gap",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const reclaimThreshold = p.reclaimThreshold as number;
        const maxAdverse = p.maxAdverse as number;

        if (cleanData.length < lookback + 1) return [];

        const reclaim = buildSweepReclaimSeries(cleanData, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [reclaim.bullish, reclaim.bearish, pressure.longAdverse, pressure.shortAdverse], (i) => {
            const bullishReclaim = reclaim.bullish[i];
            const bearishReclaim = reclaim.bearish[i];
            const longAdverse = pressure.longAdverse[i];
            const shortAdverse = pressure.shortAdverse[i];

            // Buy: bullish reclaim conviction is high and long adverse pressure gap is low
            if (bullishReclaim !== null && bullishReclaim >= reclaimThreshold && longAdverse !== null && longAdverse <= maxAdverse) {
                return createBuySignal(cleanData, i, `Bullish sweep reclaim ${bullishReclaim.toFixed(2)} with low adverse gap ${longAdverse.toFixed(3)}`);
            }

            // Sell: bearish reclaim conviction is high and short adverse pressure gap is low
            if (bearishReclaim !== null && bearishReclaim >= reclaimThreshold && shortAdverse !== null && shortAdverse <= maxAdverse) {
                return createSellSignal(cleanData, i, `Bearish sweep reclaim ${bearishReclaim.toFixed(2)} with low adverse gap ${shortAdverse.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "reclaimThreshold", "maxAdverse"],
    },
};
