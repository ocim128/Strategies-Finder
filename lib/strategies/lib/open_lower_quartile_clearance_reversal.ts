import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
    getOpens,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildRangeSeries,
} from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const QUARTILE_Z = 2.2;
const CL_BUY = 0.65;
const CL_SELL = 0.35;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 22))),
    };
}

export const open_lower_quartile_clearance_reversal: Strategy = {
    name: "Open Lower Quartile Clearance Reversal",
    description: "Opening auction clearance below the prior bar lower quartile boundary",
    defaultParams: {
        lookback: 22,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const opens = getOpens(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const ranges = buildRangeSeries(cleanData);

        const openQuartile = new Array<number>(cleanData.length).fill(0);
        const openUpperQuartile = new Array<number>(cleanData.length).fill(0);

        for (let i = 1; i < cleanData.length; i++) {
            const pr = ranges[i - 1];
            if (pr > 0) {
                const lowerQ = lows[i - 1] + 0.25 * pr;
                const upperQ = highs[i - 1] - 0.25 * pr;
                openQuartile[i] = (opens[i] - lowerQ) / pr;
                openUpperQuartile[i] = (opens[i] - upperQ) / pr;
            }
        }

        const openQuartileZ = buildRollingZScore(openQuartile, lookback);
        const openUpperQuartileZ = buildRollingZScore(openUpperQuartile, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [openQuartileZ, openUpperQuartileZ], (i) => {
            if (i < 1) return null;

            const qz = openQuartileZ[i];
            const uqz = openUpperQuartileZ[i];
            const cl = closeLocation[i];

            if (qz !== null && qz < -QUARTILE_Z && cl > CL_BUY) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Open lower quartile depression z ${qz.toFixed(2)} reclaimed (CL ${cl.toFixed(2)})`
                );
            }
            if (uqz !== null && uqz > QUARTILE_Z && cl < CL_SELL) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Open upper quartile elevation z ${uqz.toFixed(2)} rejected (CL ${cl.toFixed(2)})`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
