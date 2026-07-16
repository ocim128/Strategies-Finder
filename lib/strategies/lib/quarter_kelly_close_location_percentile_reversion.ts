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
		minQuarterKelly: Number(params.minQuarterKelly ?? 0.07),
	};
}

export const quarter_kelly_close_location_percentile_reversion: Strategy = {
	name: "Quarter Kelly Close Location Percentile Reversion",
	description: "Fades extreme settlement locations when empirical close location percentile rank WinRate maps to a positive Quarter-Kelly allocation.",
	defaultParams: {
		lookback: 35,
		minQuarterKelly: 0.07,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minQuarterKelly: "Min Quarter Kelly",
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
		const minQuarterKelly = p.minQuarterKelly as number;

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
				const qKelly = 0.25 * (2 * winProb - 1);
				if (qKelly > minQuarterKelly) {
					return createBuySignal(cleanData, i, `CL percentile reversion buy: Z ${z.toFixed(2)}, CL Pct ${clp.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			} else if (z > 1.5) {
				const winProb = clp;
				const qKelly = 0.25 * (2 * winProb - 1);
				if (qKelly > minQuarterKelly) {
					return createSellSignal(cleanData, i, `CL percentile reversion sell: Z ${z.toFixed(2)}, CL Pct ${clp.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		quarter_kelly_close_location_percentile_reversion.executePrepared!(
			quarter_kelly_close_location_percentile_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minQuarterKelly"],
	},
};
