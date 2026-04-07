import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildStreakCount } from "./price-action-statistics-core";
import { buildRangeSeries } from "./price-action-frequency-core";

function normalizeRangeVelocityReversalParams(params: StrategyParams): StrategyParams {
	const rocPeriod = Math.min(5, Math.max(1, Math.round(params.rocPeriod ?? 3)));
	const minExpansionStreak = Math.min(5, Math.max(2, Math.round(params.minExpansionStreak ?? 2)));
	return { ...params, rocPeriod, minExpansionStreak };
}

export const range_velocity_reversal: Strategy = {
	name: "Range Velocity Reversal",
	description:
		"The rate of change of bar ranges themselves measures volatility velocity. When range ROC goes from strongly positive (rapidly expanding ranges) to negative (ranges start contracting), a volatility burst is ending. Enter in the direction of the close at the inflection point — the tail end of the burst carries directional information about the new equilibrium.",
	defaultParams: { rocPeriod: 3, minExpansionStreak: 2 },
	paramLabels: { rocPeriod: "ROC Period", minExpansionStreak: "Min Expansion Streak" },
	normalizeParams: normalizeRangeVelocityReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeRangeVelocityReversalParams(params);
		if (cleanData.length < np.rocPeriod + np.minExpansionStreak + 3) return [];
		const closes = getCloses(cleanData);
		const ranges = buildRangeSeries(cleanData);
		const rangeRoc = buildRateOfChange(ranges, np.rocPeriod);
		const expansionFlags: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (rangeRoc[i] !== null && rangeRoc[i]! > 0) expansionFlags[i] = 1;
		}
		const streaks = buildStreakCount(expansionFlags);
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = 1; i < cleanData.length; i++) {
			if (rangeRoc[i] === null || rangeRoc[i - 1] === null) continue;
			if (streaks[i - 1] >= np.minExpansionStreak && expansionFlags[i] === 0) {
				if (closes[i] > closes[i - 1])
					signals.push(createBuySignal(cleanData, i, `Range expansion streak ${streaks[i - 1]} reversed, upward close`));
				else if (closes[i] < closes[i - 1])
					signals.push(createSellSignal(cleanData, i, `Range expansion streak ${streaks[i - 1]} reversed, downward close`));
			}
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["rocPeriod", "minExpansionStreak"] } };
