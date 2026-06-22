import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingZScore, buildPercentileRank } from "./price-action-statistics-core";

type ZScoreRocDivergencePrepared = {
	data: OHLCVData[];
	returnsClean: number[];
	trueRange: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
	percentileByLookback: Map<number, (number | null)[]>;
};

function normalizeZScoreRocParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		threshold: Math.max(0.1, Number(params.threshold ?? 2.0)),
	};
}

function prepareZScoreRocData(data: OHLCVData[]): ZScoreRocDivergencePrepared {
	const clean = ensureCleanData(data);
	const closes = getCloses(clean);
	const returns = buildRateOfChange(closes, 1);
	const returnsClean = returns.map(r => r ?? 0);
	const trueRange = extractBarMetricSeries(clean, "trueRange");
	return {
		data: clean,
		returnsClean,
		trueRange,
		zScoreByLookback: new Map(),
		percentileByLookback: new Map(),
	};
}

function getPreparedZScoreRocData(preparedData: unknown, data: OHLCVData[]): ZScoreRocDivergencePrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as ZScoreRocDivergencePrepared;
	}
	return prepareZScoreRocData(data);
}

export const zscore_roc_divergence_reversion: Strategy = {
	name: "Z-Score ROC Divergence Reversion",
	description: "Fades extreme price rate of change (ROC) moves when they occur on low range (legs did not diverge significantly).",
	defaultParams: {
		lookback: 30,
		threshold: 2.0,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeZScoreRocParams,
	prepareFinderData: (data) => prepareZScoreRocData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedZScoreRocData(preparedData, data);
		const p = normalizeZScoreRocParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.returnsClean, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		let percentile = prepared.percentileByLookback.get(lookback);
		if (!percentile) {
			percentile = buildPercentileRank(prepared.trueRange, lookback);
			prepared.percentileByLookback.set(lookback, percentile);
		}

		return createSignalLoop(prepared.data, [zscore, percentile], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			const pct = percentile[i];
			if (z === null || pct === null) return null;

			if (z <= -threshold && pct < 0.40) {
				return createBuySignal(prepared.data, i, `Z-Score ROC divergence buy: Z-Score (${z.toFixed(2)}) <= -${threshold.toFixed(2)} with true range percentile (${pct.toFixed(2)}) < 0.40`);
			}
			if (z >= threshold && pct < 0.40) {
				return createSellSignal(prepared.data, i, `Z-Score ROC divergence sell: Z-Score (${z.toFixed(2)}) >= ${threshold.toFixed(2)} with true range percentile (${pct.toFixed(2)}) < 0.40`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		zscore_roc_divergence_reversion.executePrepared?.(prepareZScoreRocData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
