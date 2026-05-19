import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

const CENTERLINE_LOOKBACK = 55;

function normalizeEfficiencyPersistenceQuorumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		er_lookback: Math.max(2, Math.round(params.er_lookback ?? 20)),
		er_threshold: Math.max(0, Math.min(1, Number(params.er_threshold ?? 0.6))),
	};
}

export const efficiency_persistence_quorum: Strategy = {
	name: "Efficiency Persistence Quorum",
	description: "Requires a two-of-three vote from directional efficiency, close persistence, and 55-bar median superiority.",
	defaultParams: {
		er_lookback: 20,
		er_threshold: 0.6,
	},
	paramLabels: {
		er_lookback: "Efficiency Lookback",
		er_threshold: "Efficiency Threshold",
	},
	normalizeParams: normalizeEfficiencyPersistenceQuorumParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyPersistenceQuorumParams(params);
		const erLookback = p.er_lookback as number;
		const erThreshold = p.er_threshold as number;
		if (cleanData.length < Math.max(erLookback, CENTERLINE_LOOKBACK) + 2) return [];

		const closes = getCloses(cleanData);
		const efficiency = buildEfficiencyRatio(cleanData, erLookback);
		const median = buildRollingMedian(closes, CENTERLINE_LOOKBACK);
		const closeFlags = closes.map((close, i) => {
			if (i === 0) return 0;
			if (close > closes[i - 1]) return 1;
			if (close < closes[i - 1]) return -1;
			return 0;
		});
		const streak = buildStreakCount(closeFlags);

		return createSignalLoop(cleanData, [efficiency, median], (i) => {
			if (i < Math.max(erLookback, CENTERLINE_LOOKBACK)) return null;

			const er = efficiency[i];
			const currentMedian = median[i];
			if (er === null || currentMedian === null) return null;

			const buyVotes = (er > erThreshold && closes[i] > closes[i - erLookback] ? 1 : 0)
				+ (streak[i] > 0 ? 1 : 0)
				+ (closes[i] > currentMedian ? 1 : 0);
			const sellVotes = (er > erThreshold && closes[i] < closes[i - erLookback] ? 1 : 0)
				+ (streak[i] < 0 ? 1 : 0)
				+ (closes[i] < currentMedian ? 1 : 0);

			if (buyVotes >= 2 && sellVotes >= 2) return null;
			if (buyVotes >= 2) {
				return createBuySignal(cleanData, i, "Efficiency persistence quorum bullish");
			}
			if (sellVotes >= 2) {
				return createSellSignal(cleanData, i, "Efficiency persistence quorum bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["er_lookback", "er_threshold"],
	},
};
