import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	closeLocation: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	clPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
		minKellyThreshold: Number(params.minKellyThreshold ?? 0.25),
	};
}

export const kelly_close_location_distribution_reversion: Strategy = {
	name: "Kelly Close Location Distribution Reversion",
	description: "Fades close location distribution extremes when win probability from percentile rank close location yields a positive Kelly allocation above minKellyThreshold.",
	defaultParams: {
		lookback: 35,
		minKellyThreshold: 0.25,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minKellyThreshold: "Min Kelly Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		closeLocation: buildCloseLocationSeries(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		clPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minKellyThreshold = p.minKellyThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const clPctByLookback = prepared?.clPctByLookback ?? new Map<number, (number | null)[]>();
		let clPct = clPctByLookback.get(lookback);
		if (!clPct) {
			clPct = buildPercentileRank(closeLocation, lookback);
			clPctByLookback.set(lookback, clPct);
		}

		return createSignalLoop(cleanData, [zscore, clPct], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			const clp = clPct[i];
			if (z === null || clp === null) return null;

			if (z < -1.5) {
				const winProb = 1 - clp;
				const kelly = 2 * winProb - 1;
				if (kelly > minKellyThreshold) {
					return createBuySignal(cleanData, i, `CL distribution buy: Z ${z.toFixed(2)}, CL Pct ${clp.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyThreshold}`);
				}
			} else if (z > 1.5) {
				const winProb = clp;
				const kelly = 2 * winProb - 1;
				if (kelly > minKellyThreshold) {
					return createSellSignal(cleanData, i, `CL distribution sell: Z ${z.toFixed(2)}, CL Pct ${clp.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyThreshold}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		kelly_close_location_distribution_reversion.executePrepared!(
			kelly_close_location_distribution_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minKellyThreshold"],
	},
};
