import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	autocorrByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 24))),
		minQuarterKelly: Number(params.minQuarterKelly ?? 0.05),
	};
}

export const quarter_kelly_autocorrelation_reversion: Strategy = {
	name: "Quarter Kelly Autocorrelation Reversion",
	description: "Fades price extremes when negative rolling autocorrelation WinRate (0.5 - autocorr/2) yields positive Quarter-Kelly allocation.",
	defaultParams: {
		lookback: 24,
		minQuarterKelly: 0.05,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minQuarterKelly: "Min Quarter Kelly",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		autocorrByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minQuarterKelly = p.minQuarterKelly as number;

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

		const autocorrByLookback = prepared?.autocorrByLookback ?? new Map<number, (number | null)[]>();
		let autocorr = autocorrByLookback.get(lookback);
		if (!autocorr) {
			autocorr = buildRollingAutoCorrelation(returns, lookback, 1);
			autocorrByLookback.set(lookback, autocorr);
		}

		return createSignalLoop(cleanData, [zscore, autocorr], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			const ac = autocorr[i];
			if (z === null || ac === null) return null;

			const winProb = 0.5 - ac / 2;
			const qKelly = 0.25 * (2 * winProb - 1);

			if (qKelly > minQuarterKelly) {
				if (z < -1.5) {
					return createBuySignal(cleanData, i, `Autocorrelation reversion buy: Z ${z.toFixed(2)}, Autocorr ${ac.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
				if (z > 1.5) {
					return createSellSignal(cleanData, i, `Autocorrelation reversion sell: Z ${z.toFixed(2)}, Autocorr ${ac.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		quarter_kelly_autocorrelation_reversion.executePrepared!(
			quarter_kelly_autocorrelation_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minQuarterKelly"],
	},
};
