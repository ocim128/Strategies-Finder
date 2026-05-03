import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

const GAP_SETTLEMENT_VOLUME_LOOKBACK = 20;

function normalizeGapSettlementQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        gap_threshold: Math.max(0, Number(params.gap_threshold ?? 0.005)),
        quorum_threshold: Math.max(1, Math.min(3, Math.round(Number(params.quorum_threshold ?? 2)))),
    };
}

export const gap_settlement_quorum: Strategy = {
    name: "Gap Settlement Quorum",
    description:
        "Requires quorum across gap size, prior close-location context, and participation for daily gap settlement entries.",
    defaultParams: {
        gap_threshold: 0.005,
        quorum_threshold: 2,
    },
    paramLabels: {
        gap_threshold: "Gap Threshold",
        quorum_threshold: "Quorum Threshold",
    },
    normalizeParams: normalizeGapSettlementQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeGapSettlementQuorumParams(params);
        const gapThreshold = p.gap_threshold as number;
        const quorum = p.quorum_threshold as number;
        if (cleanData.length < GAP_SETTLEMENT_VOLUME_LOOKBACK + 1) return [];

        const gaps = extractBarMetricSeries(cleanData, "gapPct");
        const closeLocation = buildCloseLocationSeries(cleanData);
        const volumes = cleanData.map((bar) => bar.volume);
        const averageVolume = buildRollingAverage(volumes, GAP_SETTLEMENT_VOLUME_LOOKBACK);

        return createSignalLoop(cleanData, [averageVolume], (i) => {
            const avgVolume = averageVolume[i];
            if (avgVolume === null) return null;

            let longVotes = 0;
            let shortVotes = 0;
            const bullishAcceptance = cleanData[i].close > cleanData[i].open;
            const bearishAcceptance = cleanData[i].close < cleanData[i].open;

            if (gaps[i] >= gapThreshold && bullishAcceptance) longVotes++;
            if (gaps[i] <= -gapThreshold && bearishAcceptance) shortVotes++;

            if (gaps[i] > 0 && closeLocation[i - 1] <= 0.25) longVotes++;
            if (gaps[i] < 0 && closeLocation[i - 1] >= 0.75) shortVotes++;

            if (cleanData[i].volume > avgVolume && bullishAcceptance) longVotes++;
            if (cleanData[i].volume > avgVolume && bearishAcceptance) shortVotes++;

            const longSignal = longVotes >= quorum;
            const shortSignal = shortVotes >= quorum;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Gap settlement quorum long ${longVotes}/3`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Gap settlement quorum short ${shortVotes}/3`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["gap_threshold", "quorum_threshold"],
    },
};
