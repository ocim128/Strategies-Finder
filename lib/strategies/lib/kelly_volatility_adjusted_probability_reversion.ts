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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		minKellyFraction: Number(params.minKellyFraction ?? 0.3),
	};
}

export const kelly_volatility_adjusted_probability_reversion: Strategy = {
	name: "Kelly Volatility Adjusted Probability Reversion",
	description: "Fades price deviations when win rate from low-volatility compression WinRate (1 - volatilityPercentile) maps to positive Kelly allocation above minKellyFraction.",
	defaultParams: {
		lookback: 30,
		minKellyFraction: 0.3,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minKellyFraction: "Min Kelly Fraction",
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
		const minKellyFraction = p.minKellyFraction as number;

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

			const winProb = 1 - vp;
			const kelly = 2 * winProb - 1;

			if (kelly > minKellyFraction) {
				if (z < -1.5) {
					return createBuySignal(cleanData, i, `Volatility adjusted Kelly buy: Z ${z.toFixed(2)}, Vol Pct ${vp.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
				if (z > 1.5) {
					return createSellSignal(cleanData, i, `Volatility adjusted Kelly sell: Z ${z.toFixed(2)}, Vol Pct ${vp.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		kelly_volatility_adjusted_probability_reversion.executePrepared!(
			kelly_volatility_adjusted_probability_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minKellyFraction"],
	},
};
