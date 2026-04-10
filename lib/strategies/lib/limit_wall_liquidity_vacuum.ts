import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingZScore } from "./price-action-statistics-core";

function normalizeLimitWallLiquidityVacuumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        z_lookback: Math.max(3, Math.round(params.z_lookback ?? 30)),
        vol_z_min: Math.max(0, Number(params.vol_z_min ?? 2.0)),
        tr_z_max: Number(params.tr_z_max ?? -1.0)
    };
}

export const limit_wall_liquidity_vacuum: Strategy = {
    name: "Limit Wall Liquidity Vacuum",
    description: "An abnormally high volume bar with a historically tight true range means a massive limit wall absorbed everything. The resultant liquidity vacuum causes an immediate snapback.",
    defaultParams: {
        z_lookback: 30,
        vol_z_min: 2.0,
        tr_z_max: -1.0
    },
    paramLabels: {
        z_lookback: "Z-Score Lookback",
        vol_z_min: "Minimum Volume Z-Score",
        tr_z_max: "Maximum TR Z-Score (Compression)"
    },
    normalizeParams: normalizeLimitWallLiquidityVacuumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLimitWallLiquidityVacuumParams(params);
        const lookback = p.z_lookback as number;
        if (cleanData.length < lookback * 2) return [];

        const volumes = getVolumes(cleanData);
        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const volZ = buildRollingZScore(volumes, lookback);
        const trZ = buildRollingZScore(trueRange, lookback);

        return createSignalLoop(cleanData, [volZ, trZ], (i) => {
            if (i < lookback + 1) return null;
            const vz = volZ[i];
            const tz = trZ[i];
            if (vz === null || tz === null) return null;

            const volMin = p.vol_z_min as number;
            const trMax = p.tr_z_max as number;
            const bar = cleanData[i];
            const prevBar = cleanData[i - 1];

            if (vz > volMin && tz < trMax && bar.close > bar.open && prevBar.close < prevBar.open) {
                return createBuySignal(cleanData, i, `Vol Z > ${volMin}, TR Z < ${trMax}, bullish reversal`);
            }
            if (vz > volMin && tz < trMax && bar.close < bar.open && prevBar.close > prevBar.open) {
                return createSellSignal(cleanData, i, `Vol Z > ${volMin}, TR Z < ${trMax}, bearish reversal`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["z_lookback", "vol_z_min", "tr_z_max"]
    }
};
