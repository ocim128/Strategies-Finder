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
    buildCloseAcceptanceSeries,
    buildRangeSeries,
} from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const CLEARANCE_Z = 2.2;
const ACCEPT = 0.35;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 22))),
    };
}

export const open_clearance_collapse_reversal: Strategy = {
    name: "Open Clearance Collapse Reversal",
    description: "Opening clearance below prior low relative to preceding open clearance",
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

        const openClearanceLower = new Array<number>(cleanData.length).fill(0);
        const openClearanceUpper = new Array<number>(cleanData.length).fill(0);

        for (let i = 1; i < cleanData.length; i++) {
            const pr = ranges[i - 1];
            if (pr > 0) {
                openClearanceLower[i] = (opens[i] - lows[i - 1]) / pr;
                openClearanceUpper[i] = (opens[i] - highs[i - 1]) / pr;
            }
        }

        const openClearanceLowerZ = buildRollingZScore(openClearanceLower, lookback);
        const openClearanceUpperZ = buildRollingZScore(openClearanceUpper, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [openClearanceLowerZ, openClearanceUpperZ], (i) => {
            if (i < 1) return null;

            const lz = openClearanceLowerZ[i];
            const uz = openClearanceUpperZ[i];
            const acc = closeAcceptance[i];

            if (lz !== null && lz < -CLEARANCE_Z && acc > ACCEPT) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Open clearance below prior low z ${lz.toFixed(2)} with positive acceptance ${acc.toFixed(2)}`
                );
            }
            if (uz !== null && uz > CLEARANCE_Z && acc < -ACCEPT) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Open clearance above prior high z ${uz.toFixed(2)} with negative acceptance ${acc.toFixed(2)}`
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
