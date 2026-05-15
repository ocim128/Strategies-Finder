import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildThresholdCrossingCount } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeMicroLevelPingAdverseVetoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        pingLookback: Math.max(2, Math.round(params.pingLookback ?? 10)),
        minPings: Math.max(1, Math.round(params.minPings ?? 4)),
        maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.03)),
    };
}

export const micro_level_ping_adverse_veto: Strategy = {
    name: "Micro Level Ping Adverse Veto",
    description: "Detects repeated median pinging and trades the clean breakout unless Polymarket adverse pressure vetoes it.",
    defaultParams: {
        pingLookback: 10,
        minPings: 4,
        maxAdverse: 0.03,
    },
    paramLabels: {
        pingLookback: "Ping Lookback",
        minPings: "Minimum Pings",
        maxAdverse: "Max Adverse Pressure",
    },
    normalizeParams: normalizeMicroLevelPingAdverseVetoParams,
    polymarket1sConfig: {
        required: true,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeMicroLevelPingAdverseVetoParams(params);
        const lookback = p.pingLookback as number;
        if (cleanData.length < lookback * 2) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const medianDistance = closes.map((close, i) => {
            const med = median[i];
            return med === null ? 0 : close - med;
        });
        const pingCount = buildThresholdCrossingCount(medianDistance, lookback, 0);
        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const pressure = buildPolymarket1sPressureGap(cleanData, context.polymarket1s);

        return createSignalLoop(cleanData, [median, pingCount], (i) => {
            if (i < lookback * 2 - 1) return null;
            const med = median[i];
            const pings = pingCount[i];
            const longAdverse = pressure.longAdverse[i];
            const shortAdverse = pressure.shortAdverse[i];
            if (med === null || pings === null || longAdverse === null || shortAdverse === null) return null;
            if (pings < (p.minPings as number)) return null;

            if (closes[i] > med + trueRange[i] * 0.5 && longAdverse <= (p.maxAdverse as number)) {
                return createBuySignal(cleanData, i, `Median ping breakout long count ${pings}`);
            }
            if (closes[i] < med - trueRange[i] * 0.5 && shortAdverse <= (p.maxAdverse as number)) {
                return createSellSignal(cleanData, i, `Median ping breakout short count ${pings}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["pingLookback", "minPings", "maxAdverse"],
    },
};
