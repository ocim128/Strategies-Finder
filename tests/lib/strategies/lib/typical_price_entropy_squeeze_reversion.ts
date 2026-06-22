import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingEntropy, buildRollingZScore } from "./price-action-statistics-core";

type EntropySqueezePrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	entropyByLookback: Map<number, (number | null)[]>;
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeEntropySqueezeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareEntropySqueezeData(data: OHLCVData[]): EntropySqueezePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		typicalPrices: getTypicalPrices(clean),
		entropyByLookback: new Map(),
		zScoreByLookback: new Map(),
	};
}

function getPreparedEntropySqueezeData(preparedData: unknown, data: OHLCVData[]): EntropySqueezePrepared {
	if (preparedData && typeof preparedData === "object" && "entropyByLookback" in preparedData) {
		return preparedData as EntropySqueezePrepared;
	}
	return prepareEntropySqueezeData(data);
}

export const typical_price_entropy_squeeze_reversion: Strategy = {
	name: "Typical Price Entropy Squeeze Reversion",
	description: "Fades typical price breakouts when typical price entropy is low (< 0.35) and z-score is at an extreme.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeEntropySqueezeParams,
	prepareFinderData: (data) => prepareEntropySqueezeData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedEntropySqueezeData(preparedData, data);
		const p = normalizeEntropySqueezeParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let entropy = prepared.entropyByLookback.get(lookback);
		if (!entropy) {
			entropy = buildRollingEntropy(prepared.typicalPrices, lookback);
			prepared.entropyByLookback.set(lookback, entropy);
		}

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.typicalPrices, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [entropy, zscore], (i) => {
			if (i < lookback) return null;
			const ent = entropy[i];
			const z = zscore[i];
			if (ent === null || z === null) return null;

			if (ent < 0.35 && z <= -2.0) {
				return createBuySignal(prepared.data, i, `Entropy squeeze buy: entropy (${ent.toFixed(3)}) < 0.35 and typical price Z-Score (${z.toFixed(2)}) <= -2.0`);
			}
			if (ent < 0.35 && z >= 2.0) {
				return createSellSignal(prepared.data, i, `Entropy squeeze sell: entropy (${ent.toFixed(3)}) < 0.35 and typical price Z-Score (${z.toFixed(2)}) >= 2.0`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		typical_price_entropy_squeeze_reversion.executePrepared?.(prepareEntropySqueezeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
