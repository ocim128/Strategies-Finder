import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingStdDev, buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	stddevReturnsByLookback: Map<number, (number | null)[]>;
	volPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
		zScoreThreshold: Number(params.zScoreThreshold ?? 2.2),
	};
}

export const rolling_zscore_volatility_adjusted_reversion: Strategy = {
	name: "Rolling Z-Score Volatility Adjusted Reversion",
	description: "Fades price deviations at Z-score extremes when rolling returns volatility percentile rank is below 0.30 (declining volatility).",
	defaultParams: {
		lookback: 35,
		zScoreThreshold: 2.2,
	},
	paramLabels: {
		lookback: "Lookback Window",
		zScoreThreshold: "Z-Score Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		stddevReturnsByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const zScoreThreshold = p.zScoreThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const stddevReturnsByLookback = prepared?.stddevReturnsByLookback ?? new Map<number, (number | null)[]>();
		let stddev = stddevReturnsByLookback.get(lookback);
		if (!stddev) {
			stddev = buildRollingStdDev(returns, lookback);
			stddevReturnsByLookback.set(lookback, stddev);
		}

		const cleanStddev = stddev.map((v) => v ?? 0);
		const volPctByLookback = prepared?.volPctByLookback ?? new Map<number, (number | null)[]>();
		let volPct = volPctByLookback.get(lookback);
		if (!volPct) {
			volPct = buildPercentileRank(cleanStddev, lookback);
			volPctByLookback.set(lookback, volPct);
		}

		return createSignalLoop(cleanData, [zscore, volPct], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			const vp = volPct[i];
			if (z === null || vp === null) return null;

			// Buy: close z-score below -zScoreThreshold, and returns volatility percentile rank below 0.30
			if (z < -zScoreThreshold && vp < 0.30) {
				return createBuySignal(cleanData, i, `Volatility adjusted buy: Z ${z.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
			}
			// Sell: close z-score above zScoreThreshold, and returns volatility percentile rank below 0.30
			if (z > zScoreThreshold && vp < 0.30) {
				return createSellSignal(cleanData, i, `Volatility adjusted sell: Z ${z.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		rolling_zscore_volatility_adjusted_reversion.executePrepared!(
			rolling_zscore_volatility_adjusted_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zScoreThreshold"],
	},
};
