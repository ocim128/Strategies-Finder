import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming Value Area reentry is a highly reliable magnetic force and boundary crossovers are handled causally.
// #SUGGEST_VERIFY: Verify streak tracking outside Value Area doesn't overflow or produce off-by-one errors.
function normalizeVolumeProfileValueAreaReentryParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
        minBarsOutside: Math.max(1, Math.round(Number(params.minBarsOutside ?? 5))),
    };
}

export const volume_profile_value_area_reentry: Strategy = {
    name: "Volume Profile Value Area Reentry",
    description: "Signals when close price crosses back inside Value Area High (VAH) or Value Area Low (VAL) after spent outside streak conditions are met.",
    defaultParams: {
        lookback: 60,
        minBarsOutside: 5,
    },
    paramLabels: {
        lookback: "Profile Lookback",
        minBarsOutside: "Min Bars Outside",
    },
    normalizeParams: normalizeVolumeProfileValueAreaReentryParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeProfileValueAreaReentryParams(params);
        const lookback = p.lookback as number;
        const minBarsOutside = p.minBarsOutside as number;
        if (cleanData.length < lookback + minBarsOutside + 5) return [];

        const closes = getCloses(cleanData);
        const { vah, val } = buildRollingValueArea(cleanData, lookback);

        // Pre-build streaks spent consecutively below VAL and above VAH
        const consecutiveBelowVal: number[] = new Array(cleanData.length).fill(0);
        const consecutiveAboveVah: number[] = new Array(cleanData.length).fill(0);

        for (let i = 1; i < cleanData.length; i++) {
            const v = val[i - 1];
            const h = vah[i - 1];
            if (v === null || h === null) continue;
            consecutiveBelowVal[i] = closes[i - 1] < v ? consecutiveBelowVal[i - 1] + 1 : 0;
            consecutiveAboveVah[i] = closes[i - 1] > h ? consecutiveAboveVah[i - 1] + 1 : 0;
        }

        return createSignalLoop(cleanData, [val, vah], (i) => {
            if (i < lookback + minBarsOutside) return null;
            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentVal = val[i];
            const prevVal = val[i - 1];
            const currentVah = vah[i];
            const prevVah = vah[i - 1];

            if (currentVal === null || prevVal === null || currentVah === null || prevVah === null) return null;

            // Buy: Close crosses above VAL (re-entering from below), after spending minBarsOutside consecutively below VAL
            const wasBelow = consecutiveBelowVal[i] >= minBarsOutside;
            const crossedAboveVal = prevClose <= prevVal && currentClose > currentVal;
            if (wasBelow && crossedAboveVal) {
                return createBuySignal(cleanData, i, `Value Area Reentry Bullish (VAL=${currentVal.toFixed(2)}, barsOutside=${consecutiveBelowVal[i]})`);
            }

            // Sell: Close crosses below VAH (re-entering from above), after spending minBarsOutside consecutively above VAH
            const wasAbove = consecutiveAboveVah[i] >= minBarsOutside;
            const crossedBelowVah = prevClose >= prevVah && currentClose < currentVah;
            if (wasAbove && crossedBelowVah) {
                return createSellSignal(cleanData, i, `Value Area Reentry Bearish (VAH=${currentVah.toFixed(2)}, barsOutside=${consecutiveAboveVah[i]})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minBarsOutside"],
    },
};
