import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingValueArea } from "./value-area-acceptance-core";
import { buildPolymarket1sGammaAgreement } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        profileLookback: Math.max(5, Math.round(Number(params.profileLookback ?? 50))),
        valueAreaPct: Math.max(10, Math.min(95, Number(params.valueAreaPct ?? 70))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const volume_profile_poc_reversion_consensus_gamma: Strategy = {
    name: "Volume Profile POC Reversion Consensus Gamma",
    description: "Fades extreme price deviations from the Volume Profile Point of Control (POC) on Binance, entering mean-reversion trades towards the POC when Gamma consensus confirms the pricing mismatch.",
    defaultParams: {
        profileLookback: 50,
        valueAreaPct: 70,
        minEdge: 0.015,
    },
    paramLabels: {
        profileLookback: "Profile Lookback",
        valueAreaPct: "Value Area %",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const profileLookback = p.profileLookback as number;
        const valueAreaPct = p.valueAreaPct as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < profileLookback) return [];

        const va = buildRollingValueArea(cleanData, profileLookback, valueAreaPct / 100);
        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback: profileLookback });

        if (!gamma.available) return [];

        return createSignalLoop(cleanData, [va.vah, va.val, va.poc, gamma.consensusLongEdge, gamma.consensusShortEdge], (i) => {
            if (i < 1) return null;

            const prevClose = cleanData[i - 1].close;
            const currentClose = cleanData[i].close;

            const prevVal = va.val[i - 1];
            const currentVal = va.val[i];
            const prevVah = va.vah[i - 1];
            const currentVah = va.vah[i];
            const currentPoc = va.poc[i];

            const consensusLong = gamma.consensusLongEdge[i];
            const consensusShort = gamma.consensusShortEdge[i];

            if (
                prevVal === null || currentVal === null ||
                prevVah === null || currentVah === null ||
                currentPoc === null ||
                consensusLong === null || consensusShort === null
            ) return null;

            // Buy: price crossed back above VAL towards POC
            if (prevClose < prevVal && currentClose >= currentVal && currentClose < currentPoc && consensusLong >= minEdge) {
                return createBuySignal(cleanData, i, `Reclaimed VAL ${currentVal.toFixed(2)} towards POC ${currentPoc.toFixed(2)} with Gamma consensus ${consensusLong.toFixed(3)}`);
            }

            // Sell: price crossed back below VAH towards POC
            if (prevClose > prevVah && currentClose <= currentVah && currentClose > currentPoc && consensusShort >= minEdge) {
                return createSellSignal(cleanData, i, `Reclaimed VAH ${currentVah.toFixed(2)} towards POC ${currentPoc.toFixed(2)} with Gamma consensus ${consensusShort.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["profileLookback", "valueAreaPct", "minEdge"],
    },
};
