import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	erByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		efficiencyLimit: Math.max(0.01, Math.min(1, Number(params.efficiencyLimit ?? 0.35))),
	};
}

export const medallion_fractal_dimension_reversion: Strategy = {
	name: "Medallion Fractal Dimension Reversion",
	description: "Fades price extremes when efficiency ratio drops, indicating high fractal path complexity.",
	defaultParams: {
		lookback: 30,
		efficiencyLimit: 0.35,
	},
	paramLabels: {
		lookback: "Lookback Window",
		efficiencyLimit: "Efficiency Limit",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		erByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const efficiencyLimit = p.efficiencyLimit as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const erByLookback = prepared?.erByLookback ?? new Map<number, (number | null)[]>();
		let er = erByLookback.get(lookback);
		if (!er) {
			er = buildEfficiencyRatio(cleanData, lookback);
			erByLookback.set(lookback, er);
		}

		return createSignalLoop(cleanData, [zscore, er], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			const efficiency = er[i];
			if (z === null || efficiency === null) return null;

			// Buy: close Z-score below -1.8, and efficiency ratio below efficiencyLimit
			if (z < -1.8 && efficiency < efficiencyLimit) {
				return createBuySignal(cleanData, i, `High fractal complexity buy: Z ${z.toFixed(2)}, ER ${efficiency.toFixed(2)}`);
			}
			// Sell: close Z-score above 1.8, and efficiency ratio below efficiencyLimit
			if (z > 1.8 && efficiency < efficiencyLimit) {
				return createSellSignal(cleanData, i, `High fractal complexity sell: Z ${z.toFixed(2)}, ER ${efficiency.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		medallion_fractal_dimension_reversion.executePrepared!(
			medallion_fractal_dimension_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "efficiencyLimit"],
	},
};
