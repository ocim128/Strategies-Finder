import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildRollingZScore, buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        cmfPeriod: Math.max(2, Math.round(Number(params.cmfPeriod ?? 20))),
        streakRequirement: Math.max(1, Math.round(Number(params.streakRequirement ?? 4))),
    };
}

export const cmf_persistent_zscore_divergence: Strategy = {
	name: "CMF Persistent Z-Score Divergence",
	description: "Identifies localized price capitulation streaks occurring directly into an unbroken streak of opposing extreme Z-score capital flows.",
	defaultParams: {
		cmfPeriod: 20,
		streakRequirement: 4,
		zscoreThreshold: 1.5,
	},
	paramLabels: {
		cmfPeriod: "CMF Period",
		streakRequirement: "Streak Requirement",
		zscoreThreshold: "Z-Score Threshold",
	},
    normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
        const normParams = normalizeParams(params);
		const cmfLen = normParams.cmfPeriod as number;
		const reqStreak = normParams.streakRequirement as number;
		const threshold = Number(params.zscoreThreshold ?? 1.5);
        const zLookback = 50;

		if (cleanData.length < Math.max(cmfLen, zLookback)) return [];

		const cmf = calculateCMF(
            cleanData.map(d => d.high),
            cleanData.map(d => d.low),
            cleanData.map(d => d.close),
            cleanData.map(d => d.volume),
            cmfLen
        );

		const cleanCmf = cmf.map(c => c === null ? 0 : c);
		const zscore = buildRollingZScore(cleanCmf, zLookback);

        const buyStreakCondition = cleanData.map((d, i) => {
            if (i === 0 || zscore[i] === null) return 0;
            return (d.close < cleanData[i-1].close) && (zscore[i]! > threshold) ? 1 : 0;
        });

        const sellStreakCondition = cleanData.map((d, i) => {
            if (i === 0 || zscore[i] === null) return 0;
            return (d.close > cleanData[i-1].close) && (zscore[i]! < -threshold) ? -1 : 0;
        });

        const buyStreak = buildStreakCount(buyStreakCondition);
        const sellStreak = buildStreakCount(sellStreakCondition);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || buyStreak[i-1] === null || sellStreak[i-1] === null) return null;

            if (buyStreak[i-1]! >= reqStreak && cleanData[i].close > cleanData[i-1].close) {
                return createBuySignal(cleanData, i, "Persistent CMF Z-Score accumulation followed by first positive close.");
            }

            if (sellStreak[i-1]! >= reqStreak && cleanData[i].close < cleanData[i-1].close) {
                return createSellSignal(cleanData, i, "Persistent CMF Z-Score distribution followed by first negative close.");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["cmfPeriod", "streakRequirement", "zscoreThreshold"],
	},
};
