import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy, buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	entropyByLookback: Map<number, (number | null)[]>;
	entropyPctByLookback: Map<string, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
		minKellyFraction: Number(params.minKellyFraction ?? 0.2),
	};
}

export const kelly_entropy_gated_reversion: Strategy = {
	name: "Kelly Entropy Gated Reversion",
	description: "Fades price deviations when high informational rolling entropy percentile WinRate maps to positive Kelly allocation above minKellyFraction.",
	defaultParams: {
		lookback: 40,
		minKellyFraction: 0.2,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minKellyFraction: "Min Kelly Fraction",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		entropyByLookback: new Map<number, (number | null)[]>(),
		entropyPctByLookback: new Map<string, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minKellyFraction = p.minKellyFraction as number;

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

		const entropyByLookback = prepared?.entropyByLookback ?? new Map<number, (number | null)[]>();
		let entropy = entropyByLookback.get(lookback);
		if (!entropy) {
			entropy = buildRollingEntropy(closes, lookback);
			entropyByLookback.set(lookback, entropy);
		}

		// Percentile rank of entropy. Map nulls in entropy to 0 to prevent compilation errors
		const cleanEntropy = entropy.map((v) => v ?? 0);
		const entropyPctByLookback = prepared?.entropyPctByLookback ?? new Map<string, (number | null)[]>();
		const pctKey = `${lookback}|${lookback}`;
		let entropyPct = entropyPctByLookback.get(pctKey);
		if (!entropyPct) {
			entropyPct = buildPercentileRank(cleanEntropy, lookback);
			entropyPctByLookback.set(pctKey, entropyPct);
		}

		return createSignalLoop(cleanData, [zscore, entropyPct], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			const ep = entropyPct[i];
			if (z === null || ep === null) return null;

			const winProb = ep;
			const kelly = 2 * winProb - 1;

			if (kelly > minKellyFraction) {
				if (z < -1.8) {
					return createBuySignal(cleanData, i, `Entropy gated Kelly buy: Z ${z.toFixed(2)}, Entropy Pct ${ep.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
				if (z > 1.8) {
					return createSellSignal(cleanData, i, `Entropy gated Kelly sell: Z ${z.toFixed(2)}, Entropy Pct ${ep.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		kelly_entropy_gated_reversion.executePrepared!(
			kelly_entropy_gated_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minKellyFraction"],
	},
};
