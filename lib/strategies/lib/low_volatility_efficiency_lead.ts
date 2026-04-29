import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

const QUIET_TREND_ER_LOOKBACK = 20;
const QUIET_TREND_ATR_PERIOD = 20;
const QUIET_TREND_ATR_Z_LOOKBACK = 60;

function normalizeLowVolatilityEfficiencyLeadParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        er_threshold: Math.max(0, Math.min(1, Number(params.er_threshold ?? 0.6))),
        vol_z_max: Number(params.vol_z_max ?? 0),
    };
}

export const low_volatility_efficiency_lead: Strategy = {
    name: "Low-Volatility Efficiency Lead",
    description:
        "Looks for efficient directional migration while ATR remains statistically muted, targeting the quieter part of trend formation instead of late volatility expansion.",
    defaultParams: {
        er_threshold: 0.6,
        vol_z_max: 0,
    },
    paramLabels: {
        er_threshold: "ER Threshold",
        vol_z_max: "ATR Z Max",
    },
    normalizeParams: normalizeLowVolatilityEfficiencyLeadParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLowVolatilityEfficiencyLeadParams(params);
        const minBars = Math.max(QUIET_TREND_ATR_Z_LOOKBACK, QUIET_TREND_ER_LOOKBACK + 1);
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, QUIET_TREND_ER_LOOKBACK);
        const atr = calculateATR(highs, lows, closes, QUIET_TREND_ATR_PERIOD);
        const atrZScore = buildRollingZScore(atr.map((value) => value ?? 0), QUIET_TREND_ATR_Z_LOOKBACK);

        return createSignalLoop(cleanData, [efficiencyRatio, atr, atrZScore], (i) => {
            const er = efficiencyRatio[i];
            const atrZ = atrZScore[i];
            if (er === null || atrZ === null) return null;
            if (er <= (p.er_threshold as number) || atrZ >= (p.vol_z_max as number)) return null;

            if (cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `ER ${er.toFixed(2)} with subdued ATR z-score ${atrZ.toFixed(2)}`);
            }
            if (cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `ER ${er.toFixed(2)} with subdued ATR z-score ${atrZ.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["er_threshold", "vol_z_max"],
    },
};
