import type {
	Strategy,
	OHLCVData,
	StrategyParams,
	StrategyExecutionContext,
} from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildRelativeVolumeStrength } from "./cross-symbol-helpers";

function normalizeCrossVolumeRelativeZscoreParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		threshold: Math.max(0.1, Number(params.threshold ?? 1.5)),
	};
}

export const cross_volume_relative_zscore: Strategy = {
	name: "Cross-Volume Relative Z-Score",
	description: "Relative volume strength computes the ratio of primary to secondary volume participation. When z-scored, extremes reveal capital rotation between correlated assets. Positive z-score means the primary is attracting disproportionate participation.",
	crossSymbolConfig: {
		defaultSymbol: "ETHUSDT",
		userSelectable: true,
		minBars: 50,
	},
	defaultParams: {
		lookback: 20,
		threshold: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeCrossVolumeRelativeZscoreParams,
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
		if (!context?.crossSymbol) return [];

		const cleanData = ensureCleanData(data);
		const p = normalizeCrossVolumeRelativeZscoreParams(params);
		if (cleanData.length < p.lookback) return [];

		const primaryVolumes = getVolumes(cleanData);
		const secondaryVolumes = getVolumes(context.crossSymbol.secondaryData);
		const relVolStrength = buildRelativeVolumeStrength(primaryVolumes, secondaryVolumes, p.lookback);
		const zScore = buildRollingZScore(
			relVolStrength.map((v) => (v === null ? 0 : v)),
			p.lookback
		);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < p.lookback) return null;
			const z = zScore[i];
			if (z === null) return null;

			if (z > p.threshold) {
				return createBuySignal(cleanData, i, `Relative volume z-score ${z.toFixed(3)} — primary attracting flow`);
			}
			if (z < -p.threshold) {
				return createSellSignal(cleanData, i, `Relative volume z-score ${z.toFixed(3)} — secondary attracting flow`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
