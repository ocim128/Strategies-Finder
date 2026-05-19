import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";
import {
	buildPricePositionInVA,
	buildValueAreaRotation,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeRotationPhiThrustQuorumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		phi_rotation: Math.max(0, Number(params.phi_rotation ?? 1.618)),
	};
}

export const rotation_phi_thrust_quorum: Strategy = {
	name: "Rotation Phi Thrust Quorum",
	description: "Trades only when structural rotation, close streak, and Value Area displacement agree on the thrust direction.",
	defaultParams: {
		lookback: 20,
		phi_rotation: 1.618,
	},
	paramLabels: {
		lookback: "VA Lookback",
		phi_rotation: "Phi Rotation",
	},
	normalizeParams: normalizeRotationPhiThrustQuorumParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeRotationPhiThrustQuorumParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const phiRotation = p.phi_rotation as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
		const closeFlags = prepared.closes.map((close, i) => {
			if (i === 0) return 0;
			if (close > prepared.closes[i - 1]) return 1;
			if (close < prepared.closes[i - 1]) return -1;
			return 0;
		});
		const streak = buildStreakCount(closeFlags);

		return createSignalLoop(prepared.cleanData, [rotation.shift, position], (i) => {
			if (i < lookback * 2) return null;

			const currentShift = rotation.shift[i];
			const currentPosition = position[i];
			if (currentShift === null || currentPosition === null) return null;

			if (currentShift > phiRotation && streak[i] >= 2 && currentPosition > 1.0) {
				return createBuySignal(prepared.cleanData, i, "Phi rotation thrust quorum bullish");
			}
			if (currentShift < -phiRotation && streak[i] <= -2 && currentPosition < -1.0) {
				return createSellSignal(prepared.cleanData, i, "Phi rotation thrust quorum bearish");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		rotation_phi_thrust_quorum.executePrepared!(
			rotation_phi_thrust_quorum.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_rotation"],
	},
};
