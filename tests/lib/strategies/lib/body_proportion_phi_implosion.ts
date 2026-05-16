import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingMedian, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeBodyProportionPhiImplosionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 10)),
		body_phi_limit: Math.max(0.01, Math.min(1, Number(params.body_phi_limit ?? 0.382))),
	};
}

export const body_proportion_phi_implosion: Strategy = {
	name: "Body Proportion Phi Implosion",
	description: "Sustained median body proportion below 0.382 of true range identifies algorithmic churning; breaking a local extreme launches an unhindered impulse.",
	defaultParams: {
		lookback: 10,
		body_phi_limit: 0.382,
	},
	paramLabels: {
		lookback: "Lookback",
		body_phi_limit: "Body Phi Limit",
	},
	normalizeParams: normalizeBodyProportionPhiImplosionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyProportionPhiImplosionParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
		const medianBodyPct = buildRollingMedian(bodyPct, p.lookback);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.lookback);

		return createSignalLoop(cleanData, [medianBodyPct, highest, lowest], (i) => {
			if (i < p.lookback) return null;
			const medBP = medianBodyPct[i];
			const prevHigh = highest[i - 1];
			const prevLow = lowest[i - 1];
			if (medBP === null || prevHigh === null || prevLow === null) return null;
			if (medBP >= p.body_phi_limit) return null;

			if (closes[i] > prevHigh) return createBuySignal(cleanData, i, "Body implosion bullish breakout");
			if (closes[i] < prevLow) return createSellSignal(cleanData, i, "Body implosion bearish breakout");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "body_phi_limit"],
	},
};





