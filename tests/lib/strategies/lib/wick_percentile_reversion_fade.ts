import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries, buildPercentileRank } from "./price-action-statistics-core";

type WickPercentileReversionPrepared = {
	data: OHLCVData[];
	upperWick: number[];
	lowerWick: number[];
	upperPercentileByLookback: Map<number, (number | null)[]>;
	lowerPercentileByLookback: Map<number, (number | null)[]>;
};

function normalizeWickPercentileParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		threshold: Math.max(0.5, Number(params.threshold ?? 0.90)),
	};
}

function prepareWickPercentileData(data: OHLCVData[]): WickPercentileReversionPrepared {
	const clean = ensureCleanData(data);
	const upperWick = extractBarMetricSeries(clean, "upperWick");
	const lowerWick = extractBarMetricSeries(clean, "lowerWick");
	return {
		data: clean,
		upperWick,
		lowerWick,
		upperPercentileByLookback: new Map(),
		lowerPercentileByLookback: new Map(),
	};
}

function getPreparedWickPercentileData(preparedData: unknown, data: OHLCVData[]): WickPercentileReversionPrepared {
	if (preparedData && typeof preparedData === "object" && "upperPercentileByLookback" in preparedData) {
		return preparedData as WickPercentileReversionPrepared;
	}
	return prepareWickPercentileData(data);
}

export const wick_percentile_reversion_fade: Strategy = {
	name: "Wick Percentile Reversion Fade",
	description: "Fades the ratio when upper or lower wicks reach extreme historical percentiles.",
	defaultParams: {
		lookback: 30,
		threshold: 0.90,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Percentile Threshold",
	},
	normalizeParams: normalizeWickPercentileParams,
	prepareFinderData: (data) => prepareWickPercentileData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedWickPercentileData(preparedData, data);
		const p = normalizeWickPercentileParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let upperPct = prepared.upperPercentileByLookback.get(lookback);
		if (!upperPct) {
			upperPct = buildPercentileRank(prepared.upperWick, lookback);
			prepared.upperPercentileByLookback.set(lookback, upperPct);
		}

		let lowerPct = prepared.lowerPercentileByLookback.get(lookback);
		if (!lowerPct) {
			lowerPct = buildPercentileRank(prepared.lowerWick, lookback);
			prepared.lowerPercentileByLookback.set(lookback, lowerPct);
		}

		return createSignalLoop(prepared.data, [upperPct, lowerPct], (i) => {
			if (i < lookback) return null;
			const up = upperPct[i];
			const dn = lowerPct[i];

			if (dn !== null && dn > threshold) {
				return createBuySignal(prepared.data, i, `Wick percentile buy fade: lower wick percentile (${dn.toFixed(2)}) > ${threshold.toFixed(2)}`);
			}
			if (up !== null && up > threshold) {
				return createSellSignal(prepared.data, i, `Wick percentile sell fade: upper wick percentile (${up.toFixed(2)}) > ${threshold.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		wick_percentile_reversion_fade.executePrepared?.(prepareWickPercentileData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
