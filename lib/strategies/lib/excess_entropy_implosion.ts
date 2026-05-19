import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import { buildRollingEntropy } from "./price-action-statistics-core";
import {
	buildPricePositionInVA,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeExcessEntropyImplosionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		pos_threshold: Math.max(1, Number(params.pos_threshold ?? 1.2)),
		entropy_threshold: Math.max(0, Number(params.entropy_threshold ?? 0.25)),
	};
}

export const excess_entropy_implosion: Strategy = {
	name: "Excess Entropy Implosion",
	description: "Fades Value Area excess when a low-entropy price sequence finally pivots against the crowded move.",
	defaultParams: {
		lookback: 20,
		pos_threshold: 1.2,
		entropy_threshold: 0.25,
	},
	paramLabels: {
		lookback: "VA Lookback",
		pos_threshold: "Position Threshold",
		entropy_threshold: "Entropy Threshold",
	},
	normalizeParams: normalizeExcessEntropyImplosionParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeExcessEntropyImplosionParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const posThreshold = p.pos_threshold as number;
		const entropyThreshold = p.entropy_threshold as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
		const closeDirection = prepared.closes.map((close, i) => {
			if (i === 0) return 0;
			if (close > prepared.closes[i - 1]) return 1;
			if (close < prepared.closes[i - 1]) return -1;
			return 0;
		});
		const entropy = buildRollingEntropy(closeDirection, lookback, 3);

		return createSignalLoop(prepared.cleanData, [position, entropy], (i) => {
			if (i < lookback) return null;

			const currentPosition = position[i];
			const currentEntropy = entropy[i];
			if (currentPosition === null || currentEntropy === null) return null;
			if (currentEntropy >= entropyThreshold) return null;

			if (currentPosition < -posThreshold && prepared.closes[i] > prepared.closes[i - 1]) {
				return createBuySignal(prepared.cleanData, i, "Low-entropy downside excess implosion");
			}
			if (currentPosition > posThreshold && prepared.closes[i] < prepared.closes[i - 1]) {
				return createSellSignal(prepared.cleanData, i, "Low-entropy upside excess implosion");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		excess_entropy_implosion.executePrepared!(
			excess_entropy_implosion.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "pos_threshold", "entropy_threshold"],
	},
};
