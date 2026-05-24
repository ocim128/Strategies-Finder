import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingStdDev, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sExecutableAgreementMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming typical price z-score relative to rolling average maps deviation from the compression center
// #SUGGEST_VERIFY: Verify standard deviation of rolling CLV (< 0.12) reliably flags balanced high-frequency ranges
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
        deviationLimit: Math.max(0.1, Number(params.deviationLimit ?? 1.2)),
    };
}

export const close_location_compression_executable_agreement: Strategy = {
    name: "Close Location Compression Reversal with Executable Agreement",
    description: "Fades brief price deviations out of tight high-frequency close-location balance zones, locking in advantageous underpricing terms via the executable agreement mask.",
    defaultParams: {
        lookback: 20,
        deviationLimit: 1.2,
    },
    paramLabels: {
        lookback: "Compression Lookback",
        deviationLimit: "Deviation Limit (Z-Score)",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const deviationLimit = p.deviationLimit as number;

        if (cleanData.length < lookback * 2) return [];

        const typical = getTypicalPrices(cleanData);
        const clv = buildCloseLocationSeries(cleanData);

        // Standard deviation of rolling CLV over lookback bars
        const clvStd = buildRollingStdDev(clv, lookback);
        const typicalZ = buildRollingZScore(typical, lookback);
        const mask = buildPolymarket1sExecutableAgreementMask(cleanData, context, { volLookback: lookback });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [clvStd, typicalZ],
            (i) => {
                if (i < lookback * 2) return null;

                const stdCLV = clvStd[i];
                const z = typicalZ[i];
                const yesAllowed = mask.yesAllowed[i];
                const noAllowed = mask.noAllowed[i];

                if (stdCLV === null || z === null) return null;

                // Close location compression check: standard deviation of rolling CLV is below 0.12
                if (stdCLV >= 0.12) return null;

                // Buy YES: typical price is below balance center by deviationLimit (typicalZ <= -deviationLimit), yesAllowed is true
                if (z <= -deviationLimit && yesAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `CLV compressed buy YES: stdCLV ${stdCLV.toFixed(3)} < 0.12, typicalZ ${z.toFixed(2)} <= -${deviationLimit}, YES allowed`
                    );
                }

                // Buy NO (expressed as Sell signal): typical price is above balance center by deviationLimit (typicalZ >= deviationLimit), noAllowed is true
                if (z >= deviationLimit && noAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `CLV compressed buy NO: stdCLV ${stdCLV.toFixed(3)} < 0.12, typicalZ ${z.toFixed(2)} >= ${deviationLimit}, NO allowed`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "deviationLimit"],
    },
};
