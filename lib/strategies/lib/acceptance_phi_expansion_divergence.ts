import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaAcceptanceRate,
	buildValueAreaWidth,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeAcceptancePhiExpansionDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 55)),
		phi_width: Math.max(0, Number(params.phi_width ?? 0.1618)),
		phi_acceptance: Math.max(0, Math.min(1, Number(params.phi_acceptance ?? 0.618))),
	};
}

export const acceptance_phi_expansion_divergence: Strategy = {
	name: "Acceptance Phi Expansion Divergence",
	description: "Fades Value Area edges when width is fat-tailed but acceptance still confirms a balanced chop regime.",
	defaultParams: {
		lookback: 55,
		phi_width: 0.1618,
		phi_acceptance: 0.618,
	},
	paramLabels: {
		lookback: "VA Lookback",
		phi_width: "Phi Width",
		phi_acceptance: "Phi Acceptance",
	},
	normalizeParams: normalizeAcceptancePhiExpansionDivergenceParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeAcceptancePhiExpansionDivergenceParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const phiWidth = p.phi_width as number;
		const phiAcceptance = p.phi_acceptance as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);
		const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, lookback);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

		return createSignalLoop(prepared.cleanData, [width, acceptance, position], (i) => {
			if (i < lookback * 2) return null;

			const currentWidth = width[i];
			const currentAcceptance = acceptance[i];
			const currentPosition = position[i];
			if (currentWidth === null || currentAcceptance === null || currentPosition === null) return null;
			if (currentWidth <= phiWidth || currentAcceptance <= phiAcceptance) return null;

			if (currentPosition < -0.8) {
				return createBuySignal(prepared.cleanData, i, "Fade lower edge of wide high-acceptance value");
			}
			if (currentPosition > 0.8) {
				return createSellSignal(prepared.cleanData, i, "Fade upper edge of wide high-acceptance value");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		acceptance_phi_expansion_divergence.executePrepared!(
			acceptance_phi_expansion_divergence.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_width", "phi_acceptance"],
	},
};
