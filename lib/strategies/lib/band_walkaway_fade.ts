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
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

const BAND_WINDOW = 20;
const WALKAWAY_STREAK_FLOOR = 4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        bandWidth: Math.min(4, Math.max(0.5, Number(params.bandWidth ?? 2))),
    };
}

export const band_walkaway_fade: Strategy = {
    name: "Band Walkaway Fade",
    description: "Fades when the close has spent consecutive bars outside the median +/- ATR band.",
    defaultParams: {
        bandWidth: 2,
    },
    paramLabels: {
        bandWidth: "Band Width (ATR)",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const bandWidth = normalizeParams(params).bandWidth as number;
        if (cleanData.length < BAND_WINDOW + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, BAND_WINDOW);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, BAND_WINDOW);

        // Signed distance beyond the band: positive above the upper band, negative
        // below the lower band, zero for inside-band bars (which reset the streak).
        const excess = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            const a = atr[i];
            if (m === null || a === null) {
                excess[i] = 0;
                continue;
            }
            if (closes[i] > m + bandWidth * a) {
                excess[i] = closes[i] - (m + bandWidth * a);
            } else if (closes[i] < m - bandWidth * a) {
                excess[i] = closes[i] - (m - bandWidth * a);
            } else {
                excess[i] = 0;
            }
        }
        const streak = buildStreakCount(excess);

        return createSignalLoop(cleanData, [median, atr], (i) => {
            const s = streak[i];
            if (s >= WALKAWAY_STREAK_FLOOR) {
                return createSellSignal(cleanData, i, `Walkaway above band: streak ${s}`);
            }
            if (s <= -WALKAWAY_STREAK_FLOOR) {
                return createBuySignal(cleanData, i, `Walkaway below band: streak ${s}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["bandWidth"],
    },
};
