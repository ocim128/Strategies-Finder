import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import {
    buildEfficiencyRatio,
    buildRollingMedian,
    buildRollingZScore,
    buildStreakCount,
} from "./price-action-statistics-core";

const INITIATIVE_PRESSURE_STREAK_LOOKBACK = 10;
const QUIET_TREND_ER_LOOKBACK = 20;
const QUIET_TREND_ATR_PERIOD = 20;
const QUIET_TREND_ATR_Z_LOOKBACK = 60;

function normalizeInitiativePressureLowVolatilityExitHybridParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 2))),
        entryMedianLookback: Math.max(2, Math.round(Number(params.entryMedianLookback ?? 2))),
        exitErThreshold: Math.max(0, Math.min(1, Number(params.exitErThreshold ?? 0.2025))),
        exitVolZMax: Number(params.exitVolZMax ?? 1),
    };
}

export const initiative_pressure_low_volatility_exit_hybrid: Strategy = {
    name: "Initiative Pressure Low-Volatility Exit Hybrid",
    description:
        "Uses Initiative Pressure Accumulation Streak for entries and Low-Volatility Efficiency Lead as the exit overlay, with opposite entry signals taking priority over the exit leg.",
    defaultParams: {
        streakThreshold: 2,
        entryMedianLookback: 2,
        exitErThreshold: 0.2025,
        exitVolZMax: 1,
    },
    paramLabels: {
        streakThreshold: "Streak Threshold",
        entryMedianLookback: "Entry Median Lookback",
        exitErThreshold: "Exit ER Threshold",
        exitVolZMax: "Exit ATR Z Max",
    },
    normalizeParams: normalizeInitiativePressureLowVolatilityExitHybridParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureLowVolatilityExitHybridParams(params);
        const minBars = Math.max(
            INITIATIVE_PRESSURE_STREAK_LOOKBACK,
            p.entryMedianLookback as number,
            QUIET_TREND_ATR_Z_LOOKBACK,
            QUIET_TREND_ER_LOOKBACK + 1
        );
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const median = buildRollingMedian(closes, p.entryMedianLookback as number);
        const initiativePressure = buildInitiativePressureSeries(cleanData, INITIATIVE_PRESSURE_STREAK_LOOKBACK);
        const streaks = buildStreakCount(
            initiativePressure.map((value) => value === null ? 0 : value > 0 ? 1 : value < 0 ? -1 : 0)
        );
        const efficiencyRatio = buildEfficiencyRatio(cleanData, QUIET_TREND_ER_LOOKBACK);
        const atr = calculateATR(highs, lows, closes, QUIET_TREND_ATR_PERIOD);
        const atrZScore = buildRollingZScore(atr.map((value) => value ?? 0), QUIET_TREND_ATR_Z_LOOKBACK);

        const signals: Signal[] = [];
        let virtualPosition: "long" | "short" | null = null;

        for (let i = 1; i < cleanData.length; i++) {
            const med = median[i];
            const er = efficiencyRatio[i];
            const atrZ = atrZScore[i];
            if (med === null || er === null || atrZ === null) {
                continue;
            }

            const wantsLongEntry =
                streaks[i] >= (p.streakThreshold as number)
                && closes[i] > med;
            const wantsShortEntry =
                streaks[i] <= -(p.streakThreshold as number)
                && closes[i] < med;

            const exitConditionActive =
                er > (p.exitErThreshold as number)
                && atrZ < (p.exitVolZMax as number);
            const wantsLongExit = exitConditionActive && cleanData[i].close < cleanData[i].open;
            const wantsShortExit = exitConditionActive && cleanData[i].close > cleanData[i].open;

            if (virtualPosition === null) {
                if (wantsLongEntry) {
                    signals.push(
                        createBuySignal(
                            cleanData,
                            i,
                            `Initiative streak ${streaks[i]} with close above hybrid median`
                        )
                    );
                    virtualPosition = "long";
                    continue;
                }
                if (wantsShortEntry) {
                    signals.push(
                        createSellSignal(
                            cleanData,
                            i,
                            `Initiative streak ${Math.abs(streaks[i])} with close below hybrid median`
                        )
                    );
                    virtualPosition = "short";
                }
                continue;
            }

            if (virtualPosition === "long") {
                if (wantsShortEntry) {
                    signals.push(
                        createSellSignal(
                            cleanData,
                            i,
                            `Initiative streak ${Math.abs(streaks[i])} triggered hybrid short reversal`
                        )
                    );
                    virtualPosition = "short";
                    continue;
                }
                if (wantsShortExit) {
                    signals.push(
                        createSellSignal(
                            cleanData,
                            i,
                            `ER ${er.toFixed(2)} with ATR z-score ${atrZ.toFixed(2)} triggered hybrid long exit`
                        )
                    );
                    virtualPosition = null;
                }
                continue;
            }

            if (wantsLongEntry) {
                signals.push(
                    createBuySignal(
                        cleanData,
                        i,
                        `Initiative streak ${streaks[i]} triggered hybrid long reversal`
                    )
                );
                virtualPosition = "long";
                continue;
            }
            if (wantsLongExit) {
                signals.push(
                    createBuySignal(
                        cleanData,
                        i,
                        `ER ${er.toFixed(2)} with ATR z-score ${atrZ.toFixed(2)} triggered hybrid short exit`
                    )
                );
                virtualPosition = null;
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakThreshold", "entryMedianLookback", "exitErThreshold", "exitVolZMax"],
    },
};
