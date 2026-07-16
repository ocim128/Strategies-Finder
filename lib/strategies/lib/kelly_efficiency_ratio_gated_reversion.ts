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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		kellyMinLeverage: Number(params.kellyMinLeverage ?? 0.3),
	};
}

export const kelly_efficiency_ratio_gated_reversion: Strategy = {
	name: "Kelly Efficiency Ratio Gated Reversion",
	description: "Fades price deviations when win rate proxy from low path efficiency (1 - Efficiency) maps to positive Kelly allocation above kellyMinLeverage.",
	defaultParams: {
		lookback: 30,
		kellyMinLeverage: 0.3,
	},
	paramLabels: {
		lookback: "Lookback Window",
		kellyMinLeverage: "Min Kelly Leverage",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		erByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const kellyMinLeverage = p.kellyMinLeverage as number;

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

			const winProb = 1 - efficiency;
			const kelly = 2 * winProb - 1;

			if (kelly > kellyMinLeverage) {
				if (z < -1.5) {
					return createBuySignal(cleanData, i, `Efficiency Kelly buy: Z ${z.toFixed(2)}, ER ${efficiency.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${kellyMinLeverage}`);
				}
				if (z > 1.5) {
					return createSellSignal(cleanData, i, `Efficiency Kelly sell: Z ${z.toFixed(2)}, ER ${efficiency.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${kellyMinLeverage}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		kelly_efficiency_ratio_gated_reversion.executePrepared!(
			kelly_efficiency_ratio_gated_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "kellyMinLeverage"],
	},
};
