import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
		rangeThreshold: Math.max(0.01, Math.min(0.99, Number(params.rangeThreshold ?? 0.80))),
		efficiencyMin: Math.max(0.01, Math.min(1.0, Number(params.efficiencyMin ?? 0.55))),
	};
}

export const efficiency_gated_range_breakout: Strategy = {
	name: "Efficiency Gated Range Breakout",
	description: "Follows range expansions (leg disagreement) only when they are highly efficient, indicating a clean structural decoupling.",
	defaultParams: {
		lookback: 25,
		rangeThreshold: 0.80,
		efficiencyMin: 0.55,
	},
	paramLabels: {
		lookback: "Lookback Window",
		rangeThreshold: "Range Percentile Threshold",
		efficiencyMin: "Min Efficiency Ratio",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const rangeThreshold = p.rangeThreshold as number;
		const efficiencyMin = p.efficiencyMin as number;
		if (cleanData.length < lookback + 1) return [];

		const ranges = buildRangeSeries(cleanData);
		const rangePercentile = buildPercentileRank(ranges, lookback);
		const efficiency = buildEfficiencyRatio(cleanData, lookback);
		const closeLocation = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [rangePercentile, efficiency], (i) => {
			if (i < lookback) return null;
			const rp = rangePercentile[i];
			const eff = efficiency[i];
			const cl = closeLocation[i];
			if (rp === null || eff === null || cl === null) return null;

			if (rp <= rangeThreshold) return null;
			if (eff <= efficiencyMin) return null;

			if (cl > 0.75) {
				return createBuySignal(cleanData, i, `Range breakout: percentile (${rp.toFixed(2)}) > ${rangeThreshold}, efficiency (${eff.toFixed(2)}) > ${efficiencyMin}, close location ${cl.toFixed(2)} > 0.75`);
			}
			if (cl < 0.25) {
				return createSellSignal(cleanData, i, `Range breakout: percentile (${rp.toFixed(2)}) > ${rangeThreshold}, efficiency (${eff.toFixed(2)}) > ${efficiencyMin}, close location ${cl.toFixed(2)} < 0.25`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "rangeThreshold", "efficiencyMin"],
	},
};
