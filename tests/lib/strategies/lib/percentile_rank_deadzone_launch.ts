import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rankLookback: Math.max(2, Math.round(params.rankLookback ?? 30)),
		deadzoneWidth: Math.max(0, Math.min(50, Number(params.deadzoneWidth ?? 15))),
		launchThreshold: Math.max(50, Math.min(100, Number(params.launchThreshold ?? 90))),
	};
}

export const percentile_rank_deadzone_launch: Strategy = {
	name: "Percentile Rank Deadzone Launch",
	description: "The absolute percentile rank of the close stays flat near the median for a prolonged sequence, then aggressively snaps beyond an extreme launch threshold.",
	defaultParams: {
		rankLookback: 30,
		deadzoneWidth: 15,
		launchThreshold: 90,
	},
	paramLabels: {
		rankLookback: "Rank Lookback",
		deadzoneWidth: "Deadzone +/-",
		launchThreshold: "Launch Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const { rankLookback, deadzoneWidth, launchThreshold } = normalizeParams(params);
		
		if (cleanData.length <= rankLookback * 2) return [];

		const closes = getCloses(cleanData);
		const ranks = buildPercentileRank(closes, rankLookback);

		const lowerZone = 0.50 - (deadzoneWidth / 100);
		const upperZone = 0.50 + (deadzoneWidth / 100);
		const launchUp = launchThreshold / 100;
		const launchDown = (100 - launchThreshold) / 100;
		
		const deadzoneConsecutiveBars = 5;

		return createSignalLoop(cleanData, [ranks], (i) => {
			if (i <= rankLookback + deadzoneConsecutiveBars) return null;

			// Check if previous N bars were all in the deadzone
			let inDeadzone = true;
			for (let j = i - deadzoneConsecutiveBars; j < i; j++) {
				const r = ranks[j]!;
				if (r < lowerZone || r > upperZone) {
					inDeadzone = false;
					break;
				}
			}

			if (inDeadzone) {
				const currentRank = ranks[i]!;

				if (currentRank > launchUp) {
					return createBuySignal(cleanData, i, `Launch Rank ${(currentRank * 100).toFixed(1)} > ${launchThreshold}`);
				}
				if (currentRank < launchDown) {
					return createSellSignal(cleanData, i, `Launch Rank ${(currentRank * 100).toFixed(1)} < ${100 - launchThreshold}`);
				}
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rankLookback", "deadzoneWidth", "launchThreshold"],
	},
};
