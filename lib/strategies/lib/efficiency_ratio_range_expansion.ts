import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

type EfficiencyRangePrepared = {
	data: OHLCVData[];
	ranges: number[];
	closeLocation: number[];
	medianRangeByLookback: Map<number, (number | null)[]>;
	efficiencyByLookback: Map<number, (number | null)[]>;
};

function normalizeEfficiencyRangeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
	};
}

function prepareEfficiencyRangeData(data: OHLCVData[]): EfficiencyRangePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		ranges: buildRangeSeries(clean),
		closeLocation: buildCloseLocationSeries(clean),
		medianRangeByLookback: new Map(),
		efficiencyByLookback: new Map(),
	};
}

function getPreparedEfficiencyRangeData(
	preparedData: unknown,
	data: OHLCVData[]
): EfficiencyRangePrepared {
	if (preparedData && typeof preparedData === "object" && "efficiencyByLookback" in preparedData) {
		return preparedData as EfficiencyRangePrepared;
	}
	return prepareEfficiencyRangeData(data);
}

export const efficiency_ratio_range_expansion: Strategy = {
	name: "Efficiency Ratio Range Expansion",
	description: "Chases range expansions only when the efficiency ratio is high (> 0.40), confirming trend purity.",
	defaultParams: {
		lookback: 25,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeEfficiencyRangeParams,
	prepareFinderData: (data) => prepareEfficiencyRangeData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedEfficiencyRangeData(preparedData, data);
		const p = normalizeEfficiencyRangeParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let medianRange = prepared.medianRangeByLookback.get(lookback);
		if (!medianRange) {
			medianRange = buildRollingMedian(prepared.ranges, lookback);
			prepared.medianRangeByLookback.set(lookback, medianRange);
		}

		let efficiency = prepared.efficiencyByLookback.get(lookback);
		if (!efficiency) {
			efficiency = buildEfficiencyRatio(prepared.data, lookback);
			prepared.efficiencyByLookback.set(lookback, efficiency);
		}

		return createSignalLoop(prepared.data, [medianRange, efficiency], (i) => {
			if (i < lookback) return null;
			const med = medianRange[i];
			const eff = efficiency[i];
			if (med === null || eff === null) return null;

			const range = prepared.ranges[i];
			const cl = prepared.closeLocation[i];

			if (range > med && eff > 0.40 && cl > 0.70) {
				return createBuySignal(prepared.data, i, `Efficiency range breakout: range (${range.toFixed(4)} > ${med.toFixed(4)}) and efficiency (${eff.toFixed(2)}) > 0.40 with close location (${cl.toFixed(2)}) > 0.70`);
			}
			if (range > med && eff > 0.40 && cl < 0.30) {
				return createSellSignal(prepared.data, i, `Efficiency range breakdown: range (${range.toFixed(4)} > ${med.toFixed(4)}) and efficiency (${eff.toFixed(2)}) > 0.40 with close location (${cl.toFixed(2)}) < 0.30`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		efficiency_ratio_range_expansion.executePrepared?.(prepareEfficiencyRangeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
