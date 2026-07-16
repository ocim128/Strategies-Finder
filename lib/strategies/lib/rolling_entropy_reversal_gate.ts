import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	checkCrossover,
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
		entropyPercentileCutoff: Number(params.entropyPercentileCutoff ?? 0.6),
	};
}

export const rolling_entropy_reversal_gate: Strategy = {
	name: "Rolling Entropy Reversal Gate",
	description: "Gates mean reversion entries at price Z-score extremes when rolling entropy percentile crosses below its historical median (entropyPercentileCutoff).",
	defaultParams: {
		lookback: 40,
		entropyPercentileCutoff: 0.6,
	},
	paramLabels: {
		lookback: "Lookback Window",
		entropyPercentileCutoff: "Entropy Percentile Cutoff",
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
		const entropyPercentileCutoff = p.entropyPercentileCutoff as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		const len = cleanData.length;
		if (len < lookback + 2) return [];

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

		const thresholdArray = new Array(len).fill(entropyPercentileCutoff);

		return createSignalLoop(cleanData, [zscore, entropyPct], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Check if rolling entropy percentile crosses below the cutoff (bearish crossover)
			const cross = checkCrossover(entropyPct, thresholdArray, i);

			if (cross === "bearish") {
				if (z < -2.0) {
					return createBuySignal(cleanData, i, `Entropy reversal gate buy: Z ${z.toFixed(2)}, entropy crossed below ${entropyPercentileCutoff}`);
				}
				if (z > 2.0) {
					return createSellSignal(cleanData, i, `Entropy reversal gate sell: Z ${z.toFixed(2)}, entropy crossed below ${entropyPercentileCutoff}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		rolling_entropy_reversal_gate.executePrepared!(
			rolling_entropy_reversal_gate.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "entropyPercentileCutoff"],
	},
};
