import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";
import {
	buildValueAreaAcceptanceRate,
	buildValueAreaRotation,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeAcceptanceSourcedMomentumQuorumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		accept_threshold: Math.max(0, Math.min(1, Number(params.accept_threshold ?? 0.45))),
	};
}

export const acceptance_sourced_momentum_quorum: Strategy = {
	name: "Acceptance Sourced Momentum Quorum",
	description: "Requires a two-vote quorum across initiative acceptance, structural rotation, and directional close streaks.",
	defaultParams: {
		lookback: 20,
		accept_threshold: 0.45,
	},
	paramLabels: {
		lookback: "VA Lookback",
		accept_threshold: "Acceptance Threshold",
	},
	normalizeParams: normalizeAcceptanceSourcedMomentumQuorumParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeAcceptanceSourcedMomentumQuorumParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const acceptThreshold = p.accept_threshold as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, lookback);
		const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);
		const closeFlags = prepared.closes.map((close, i) => {
			if (i === 0) return 0;
			if (close > prepared.closes[i - 1]) return 1;
			if (close < prepared.closes[i - 1]) return -1;
			return 0;
		});
		const streak = buildStreakCount(closeFlags);

		return createSignalLoop(prepared.cleanData, [acceptance, rotation.shift], (i) => {
			if (i < lookback * 2) return null;

			const currentAcceptance = acceptance[i];
			const currentShift = rotation.shift[i];
			if (currentAcceptance === null || currentShift === null) return null;

			const initiativeVote = currentAcceptance < acceptThreshold ? 1 : 0;
			const buyVotes = initiativeVote + (currentShift > 0 ? 1 : 0) + (streak[i] >= 2 ? 1 : 0);
			const sellVotes = initiativeVote + (currentShift < 0 ? 1 : 0) + (streak[i] <= -2 ? 1 : 0);

			if (buyVotes >= 2 && sellVotes >= 2) return null;
			if (buyVotes >= 2) {
				return createBuySignal(prepared.cleanData, i, "Acceptance-sourced momentum quorum bullish");
			}
			if (sellVotes >= 2) {
				return createSellSignal(prepared.cleanData, i, "Acceptance-sourced momentum quorum bearish");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		acceptance_sourced_momentum_quorum.executePrepared!(
			acceptance_sourced_momentum_quorum.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "accept_threshold"],
	},
};
