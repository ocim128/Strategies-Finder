import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

type RangePercentileTrendPrepared = {
	data: OHLCVData[];
	range: number[];
	closeLocation: number[];
	percentileByLookback: Map<number, (number | null)[]>;
};

function normalizeRangePercentileParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		threshold: Math.max(0.1, Number(params.threshold ?? 0.75)),
	};
}

function prepareRangePercentileData(data: OHLCVData[]): RangePercentileTrendPrepared {
	const clean = ensureCleanData(data);
	const range = buildRangeSeries(clean);
	const closeLocation = buildCloseLocationSeries(clean);
	return {
		data: clean,
		range,
		closeLocation,
		percentileByLookback: new Map(),
	};
}

function getPreparedRangePercentileData(preparedData: unknown, data: OHLCVData[]): RangePercentileTrendPrepared {
	if (preparedData && typeof preparedData === "object" && "percentileByLookback" in preparedData) {
		return preparedData as RangePercentileTrendPrepared;
	}
	return prepareRangePercentileData(data);
}

export const range_percentile_trend_reversal: Strategy = {
	name: "Range Percentile Trend Reversal",
	description: "Chases a breakout when the range percentile rank spikes after a prolonged period of compressed range.",
	defaultParams: {
		lookback: 30,
		threshold: 0.75,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Percentile Spike Threshold",
	},
	normalizeParams: normalizeRangePercentileParams,
	prepareFinderData: (data) => prepareRangePercentileData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangePercentileData(preparedData, data);
		const p = normalizeRangePercentileParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let percentile = prepared.percentileByLookback.get(lookback);
		if (!percentile) {
			percentile = buildPercentileRank(prepared.range, lookback);
			prepared.percentileByLookback.set(lookback, percentile);
		}

		return createSignalLoop(prepared.data, [percentile], (i) => {
			if (i < 5) return null;
			const currentPct = percentile[i];
			if (currentPct === null) return null;

			// Average of previous 5 bars range percentile
			let sum = 0;
			let validCount = 0;
			for (let j = 1; j <= 5; j++) {
				const val = percentile[i - j];
				if (val !== null) {
					sum += val;
					validCount++;
				}
			}
			if (validCount < 5) return null;
			const avgPrevPct = sum / 5;

			const closeLoc = prepared.closeLocation[i];

			if (avgPrevPct < 0.35 && currentPct > threshold) {
				if (closeLoc > 0.8) {
					return createBuySignal(prepared.data, i, `Range percentile trend buy breakout: prev average (${avgPrevPct.toFixed(2)}) < 0.35 with current spike (${currentPct.toFixed(2)}) > ${threshold.toFixed(2)} and close location (${closeLoc.toFixed(2)}) > 0.8`);
				}
				if (closeLoc < 0.2) {
					return createSellSignal(prepared.data, i, `Range percentile trend sell breakout: prev average (${avgPrevPct.toFixed(2)}) < 0.35 with current spike (${currentPct.toFixed(2)}) > ${threshold.toFixed(2)} and close location (${closeLoc.toFixed(2)}) < 0.2`);
				}
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_percentile_trend_reversal.executePrepared?.(prepareRangePercentileData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
