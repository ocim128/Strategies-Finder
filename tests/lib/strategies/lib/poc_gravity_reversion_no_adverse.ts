import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingValueArea } from "./value-area-acceptance-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming rolling Value Area POC, VAH, and VAL from TPO volume profile calculations serve as reliable anchors
// #SUGGEST_VERIFY: Verify deviation threshold and value area boundaries accurately identify POC reversion opportunities
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
        pocOffset: Math.max(0.0001, Math.min(0.5, Number(params.pocOffset ?? 0.04))),
    };
}

export const poc_gravity_reversion_no_adverse: Strategy = {
    name: "Point of Control Gravity Reversion with No Adverse Mask",
    description: "Fades price deviations away from the Volume Profile Point of Control (POC) gravity well, using Polymarket's no-adverse mask to shield entries from breakout risks.",
    defaultParams: {
        lookback: 60,
        pocOffset: 0.04,
    },
    paramLabels: {
        lookback: "Volume Profile Lookback",
        pocOffset: "POC Deviation Offset",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const pocOffset = p.pocOffset as number;

        if (cleanData.length < lookback) return [];

        const typical = getTypicalPrices(cleanData);
        const closes = getCloses(cleanData);

        const va = buildRollingValueArea(cleanData, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [va.poc, va.vah, va.val],
            (i) => {
                if (i < lookback) return null;

                const currentTypical = typical[i];
                const currentClose = closes[i];
                const poc = va.poc[i];
                const vah = va.vah[i];
                const val = va.val[i];
                const yesAllowed = mask.yesAllowed[i];
                const noAllowed = mask.noAllowed[i];

                if (poc === null || vah === null || val === null) return null;

                const belowPocOffset = poc * (1 - pocOffset);
                const abovePocOffset = poc * (1 + pocOffset);

                // Buy YES: typical price is below POC by at least pocOffset percent, current close is above VAL, and yesAllowed is true
                if (currentTypical <= belowPocOffset && currentClose > val && yesAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `POC reversion buy YES: typical ${currentTypical.toFixed(2)} <= offset ${belowPocOffset.toFixed(2)}, close ${currentClose.toFixed(2)} > val ${val.toFixed(2)}, YES allowed`
                    );
                }

                // Buy NO (expressed as Sell signal): typical price is above POC by at least pocOffset percent, current close is below VAH, and noAllowed is true
                if (currentTypical >= abovePocOffset && currentClose < vah && noAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `POC reversion buy NO: typical ${currentTypical.toFixed(2)} >= offset ${abovePocOffset.toFixed(2)}, close ${currentClose.toFixed(2)} < vah ${vah.toFixed(2)}, NO allowed`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pocOffset"],
    },
};
