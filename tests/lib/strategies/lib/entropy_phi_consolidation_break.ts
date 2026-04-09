import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingEntropy } from "./price-action-statistics-core";

function normalizeEntropyPhiConsolidationBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		entropy_limit: Math.max(0.01, Number(params.entropy_limit ?? 0.382)),
	};
}

export const entropy_phi_consolidation_break: Strategy = {
	name: "Entropy Phi Consolidation Break",
	description: "Rolling entropy collapsing below 0.382 identifies an unnaturally compressed market state. A breakout during this regime is highly efficient.",
	defaultParams: {
		lookback: 20,
		entropy_limit: 0.382,
	},
	paramLabels: {
		lookback: "Lookback",
		entropy_limit: "Entropy Limit",
	},
	normalizeParams: normalizeEntropyPhiConsolidationBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEntropyPhiConsolidationBreakParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const entropy = buildRollingEntropy(closes, p.lookback);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.lookback);

		return createSignalLoop(cleanData, [entropy, highest, lowest], (i) => {
			if (i < p.lookback) return null;
			const ent = entropy[i];
			const prevHigh = highest[i - 1];
			const prevLow = lowest[i - 1];
			if (ent === null || prevHigh === null || prevLow === null) return null;
			if (ent >= p.entropy_limit) return null;

			if (closes[i] > prevHigh) return createBuySignal(cleanData, i, "Entropy compressed bullish breakout");
			if (closes[i] < prevLow) return createSellSignal(cleanData, i, "Entropy compressed bearish breakout");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "entropy_limit"],
	},
};
