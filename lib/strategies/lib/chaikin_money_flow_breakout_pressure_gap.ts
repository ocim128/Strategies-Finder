import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        cmfLookback: Math.max(2, Math.round(Number(params.cmfLookback ?? 20))),
        cmfThreshold: Math.max(0.01, Math.min(0.99, Number(params.cmfThreshold ?? 0.25))),
        maxAdverse: Math.max(0.001, Number(params.maxAdverse ?? 0.04)),
    };
}

export const chaikin_money_flow_breakout_pressure_gap: Strategy = {
    name: "Chaikin Money Flow Breakout Pressure Gap",
    description: "Trades high-conviction volume-weighted breakouts on Binance, using the Polymarket pressure gap to veto trades when the move has already been over-priced by the event contract.",
    defaultParams: {
        cmfLookback: 20,
        cmfThreshold: 0.25,
        maxAdverse: 0.04,
    },
    paramLabels: {
        cmfLookback: "CMF Lookback",
        cmfThreshold: "CMF Threshold",
        maxAdverse: "Maximum Adverse Gap",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const cmfLookback = p.cmfLookback as number;
        const cmfThreshold = p.cmfThreshold as number;
        const maxAdverse = p.maxAdverse as number;

        if (cleanData.length < cmfLookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const cmf = calculateCMF(highs, lows, closes, volumes, cmfLookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: cmfLookback });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [cmf, pressure.longAdverse, pressure.shortAdverse], (i) => {
            const currentCmf = cmf[i];
            const longAdverse = pressure.longAdverse[i];
            const shortAdverse = pressure.shortAdverse[i];

            if (currentCmf === null || longAdverse === null || shortAdverse === null) return null;

            // Buy: CMF crosses above high threshold, adverse pressure gap is low
            if (currentCmf > cmfThreshold && longAdverse <= maxAdverse) {
                return createBuySignal(cleanData, i, `CMF breakout ${currentCmf.toFixed(2)} with low long adverse gap ${longAdverse.toFixed(3)}`);
            }

            // Sell: CMF crosses below high negative threshold, adverse pressure gap is low
            if (currentCmf < -cmfThreshold && shortAdverse <= maxAdverse) {
                return createSellSignal(cleanData, i, `CMF breakout ${currentCmf.toFixed(2)} with low short adverse gap ${shortAdverse.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["cmfLookback", "cmfThreshold", "maxAdverse"],
    },
};
