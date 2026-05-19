import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import {
	buildPricePositionInVA,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizePhiPositionExhaustionVetoParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		median_lookback: Math.max(3, Math.round(params.median_lookback ?? 55)),
		va_lookback: Math.max(3, Math.round(params.va_lookback ?? 20)),
		phi_veto: Math.max(1, Number(params.phi_veto ?? 1.618)),
	};
}

export const phi_position_exhaustion_veto: Strategy = {
	name: "Phi Position Exhaustion Veto",
	description: "A close-median crossover is allowed only when Value Area position has not already reached phi exhaustion.",
	defaultParams: {
		median_lookback: 55,
		va_lookback: 20,
		phi_veto: 1.618,
	},
	paramLabels: {
		median_lookback: "Median Lookback",
		va_lookback: "VA Lookback",
		phi_veto: "Phi Veto",
	},
	normalizeParams: normalizePhiPositionExhaustionVetoParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizePhiPositionExhaustionVetoParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const medianLookback = p.median_lookback as number;
		const vaLookback = p.va_lookback as number;
		const phiVeto = p.phi_veto as number;

		const median = buildRollingMedian(prepared.closes, medianLookback);
		const vaSeries = getValueAreaSeries(prepared, vaLookback, 0.68, 12);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

		return createSignalLoop(prepared.cleanData, [median, position], (i) => {
			if (i < Math.max(medianLookback, vaLookback)) return null;

			const currentMedian = median[i];
			const previousMedian = median[i - 1];
			const currentPosition = position[i];
			if (currentMedian === null || previousMedian === null || currentPosition === null) return null;

			if (prepared.closes[i - 1] <= previousMedian && prepared.closes[i] > currentMedian && currentPosition < phiVeto) {
				return createBuySignal(prepared.cleanData, i, "Median cross up without phi position exhaustion");
			}
			if (prepared.closes[i - 1] >= previousMedian && prepared.closes[i] < currentMedian && currentPosition > -phiVeto) {
				return createSellSignal(prepared.cleanData, i, "Median cross down without phi position exhaustion");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		phi_position_exhaustion_veto.executePrepared!(
			phi_position_exhaustion_veto.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["median_lookback", "va_lookback", "phi_veto"],
	},
};
