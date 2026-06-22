import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

type EfficiencyTrendPrepared = {
	data: OHLCVData[];
	closeLocation: number[];
	efficiencyByLookback: Map<number, (number | null)[]>;
};

function normalizeEfficiencyParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		threshold: Math.max(0.01, Math.min(0.99, Number(params.threshold ?? 0.40))),
	};
}

function prepareEfficiencyData(data: OHLCVData[]): EfficiencyTrendPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		closeLocation: buildCloseLocationSeries(clean),
		efficiencyByLookback: new Map(),
	};
}

function getPreparedEfficiencyData(preparedData: unknown, data: OHLCVData[]): EfficiencyTrendPrepared {
	if (preparedData && typeof preparedData === "object" && "efficiencyByLookback" in preparedData) {
		return preparedData as EfficiencyTrendPrepared;
	}
	return prepareEfficiencyData(data);
}

export const efficiency_ratio_trend_filter: Strategy = {
	name: "Efficiency Ratio Trend Filter",
	description: "Chases momentum only when the efficiency ratio is high.",
	defaultParams: {
		lookback: 30,
		threshold: 0.40,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeEfficiencyParams,
	prepareFinderData: (data) => prepareEfficiencyData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedEfficiencyData(preparedData, data);
		const p = normalizeEfficiencyParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let efficiency = prepared.efficiencyByLookback.get(lookback);
		if (!efficiency) {
			efficiency = buildEfficiencyRatio(prepared.data, lookback);
			prepared.efficiencyByLookback.set(lookback, efficiency);
		}

		return createSignalLoop(prepared.data, [efficiency], (i) => {
			if (i < lookback) return null;
			const eff = efficiency[i];
			if (eff === null) return null;

			const cl = prepared.closeLocation[i];

			if (eff > threshold && cl > 0.7) {
				return createBuySignal(prepared.data, i, `High Efficiency Trend: efficiency (${eff.toFixed(2)}) > threshold (${threshold}) with close location ${cl.toFixed(2)}`);
			}
			if (eff > threshold && cl < 0.3) {
				return createSellSignal(prepared.data, i, `High Efficiency Trend: efficiency (${eff.toFixed(2)}) > threshold (${threshold}) with close location ${cl.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		efficiency_ratio_trend_filter.executePrepared?.(prepareEfficiencyData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
