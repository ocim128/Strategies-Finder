import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeDualHorizonGoldenExcessParams(params: StrategyParams): StrategyParams {
	const shortLookback = Math.max(3, Math.round(params.short_lookback ?? 10));
	return {
		...params,
		short_lookback: shortLookback,
		long_lookback: Math.max(shortLookback + 1, Math.round(params.long_lookback ?? 63)),
		phi_extreme: Math.max(1, Number(params.phi_extreme ?? 1.618)),
	};
}

export const dual_horizon_golden_excess: Strategy = {
	name: "Dual Horizon Golden Excess",
	description: "Fades only when both reactive and structural Value Areas show simultaneous phi-level excess.",
	defaultParams: {
		short_lookback: 10,
		long_lookback: 63,
		phi_extreme: 1.618,
	},
	paramLabels: {
		short_lookback: "Short VA Lookback",
		long_lookback: "Long VA Lookback",
		phi_extreme: "Phi Extreme",
	},
	normalizeParams: normalizeDualHorizonGoldenExcessParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeDualHorizonGoldenExcessParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const shortLookback = p.short_lookback as number;
		const longLookback = p.long_lookback as number;
		const phiExtreme = p.phi_extreme as number;

		const shortVa = getValueAreaSeries(prepared, shortLookback, 0.68, 12);
		const longVa = getValueAreaSeries(prepared, longLookback, 0.68, 12);
		const shortPosition = buildPricePositionInVA(prepared.closes, shortVa.vah, shortVa.val, shortVa.poc);
		const longPosition = buildPricePositionInVA(prepared.closes, longVa.vah, longVa.val, longVa.poc);

		return createSignalLoop(prepared.cleanData, [shortPosition, longPosition], (i) => {
			if (i < longLookback) return null;

			const currentShortPosition = shortPosition[i];
			const currentLongPosition = longPosition[i];
			if (currentShortPosition === null || currentLongPosition === null) return null;

			if (
				currentShortPosition < -phiExtreme
				&& currentLongPosition < -phiExtreme
				&& prepared.closes[i] > prepared.closes[i - 1]
			) {
				return createBuySignal(prepared.cleanData, i, "Dual-horizon golden downside excess reversal");
			}
			if (
				currentShortPosition > phiExtreme
				&& currentLongPosition > phiExtreme
				&& prepared.closes[i] < prepared.closes[i - 1]
			) {
				return createSellSignal(prepared.cleanData, i, "Dual-horizon golden upside excess reversal");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		dual_horizon_golden_excess.executePrepared!(
			dual_horizon_golden_excess.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["short_lookback", "long_lookback", "phi_extreme"],
	},
};
