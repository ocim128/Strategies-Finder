import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildRangeSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

type CleanBodyPrepared = {
	data: OHLCVData[];
	ranges: number[];
	bodyPct: number[];
	medianRangeByLookback: Map<number, (number | null)[]>;
};

function normalizeCleanBodyParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
	};
}

function prepareCleanBodyData(data: OHLCVData[]): CleanBodyPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		ranges: buildRangeSeries(clean),
		bodyPct: extractBarMetricSeries(clean, "bodyPct"),
		medianRangeByLookback: new Map(),
	};
}

function getPreparedCleanBodyData(preparedData: unknown, data: OHLCVData[]): CleanBodyPrepared {
	if (preparedData && typeof preparedData === "object" && "medianRangeByLookback" in preparedData) {
		return preparedData as CleanBodyPrepared;
	}
	return prepareCleanBodyData(data);
}

export const clean_body_range_expansion: Strategy = {
	name: "Clean Body Range Expansion",
	description: "Trades range expansions where the candle is mostly body (> 70%) and range exceeds median.",
	defaultParams: {
		lookback: 25,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeCleanBodyParams,
	prepareFinderData: (data) => prepareCleanBodyData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedCleanBodyData(preparedData, data);
		const p = normalizeCleanBodyParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let medianRange = prepared.medianRangeByLookback.get(lookback);
		if (!medianRange) {
			medianRange = buildRollingMedian(prepared.ranges, lookback);
			prepared.medianRangeByLookback.set(lookback, medianRange);
		}

		return createSignalLoop(prepared.data, [medianRange], (i) => {
			if (i < lookback) return null;
			const med = medianRange[i];
			if (med === null) return null;

			const range = prepared.ranges[i];
			const bp = prepared.bodyPct[i];
			const bar = prepared.data[i];

			if (range > med && bp > 0.70 && bar.close > bar.open) {
				return createBuySignal(prepared.data, i, `Clean body breakout: range (${range.toFixed(4)} > ${med.toFixed(4)}) with bodyPct (${bp.toFixed(2)}) > 0.70 and close > open`);
			}
			if (range > med && bp > 0.70 && bar.close < bar.open) {
				return createSellSignal(prepared.data, i, `Clean body breakdown: range (${range.toFixed(4)} > ${med.toFixed(4)}) with bodyPct (${bp.toFixed(2)}) > 0.70 and close < open`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		clean_body_range_expansion.executePrepared?.(prepareCleanBodyData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
