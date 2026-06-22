import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum, buildRollingZScore } from "./price-action-statistics-core";

type CloseAcceptanceDecayPrepared = {
	data: OHLCVData[];
	decaySum: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeDecayParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
	};
}

function prepareDecayData(data: OHLCVData[]): CloseAcceptanceDecayPrepared {
	const clean = ensureCleanData(data);
	const acceptance = buildCloseAcceptanceSeries(clean);
	const decaySum = buildCumulativeDecaySum(acceptance, 0.80);
	return {
		data: clean,
		decaySum,
		zScoreByLookback: new Map(),
	};
}

function getPreparedDecayData(preparedData: unknown, data: OHLCVData[]): CloseAcceptanceDecayPrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as CloseAcceptanceDecayPrepared;
	}
	return prepareDecayData(data);
}

export const close_acceptance_decay_fade: Strategy = {
	name: "Close Acceptance Decay Fade",
	description: "Fades the ratio when the decay-weighted sum of close acceptance is at a z-score extreme.",
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: "Z-Score Lookback Window",
	},
	normalizeParams: normalizeDecayParams,
	prepareFinderData: (data) => prepareDecayData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedDecayData(preparedData, data);
		const p = normalizeDecayParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.decaySum, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [zscore], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			if (z === null) return null;

			if (z <= -2.0) {
				return createBuySignal(prepared.data, i, `Close acceptance decay z-score negative extreme: Z-Score (${z.toFixed(2)}) <= -2.0`);
			}
			if (z >= 2.0) {
				return createSellSignal(prepared.data, i, `Close acceptance decay z-score positive extreme: Z-Score (${z.toFixed(2)}) >= 2.0`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_acceptance_decay_fade.executePrepared?.(prepareDecayData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
