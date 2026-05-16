import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizePocLiquidityRejectionFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		poc_proximity_pct: Math.max(0.0001, Number(params.poc_proximity_pct ?? 0.002)),
		rejection_threshold: Math.max(0.05, Math.min(0.5, Number(params.rejection_threshold ?? 0.25))),
		profile_period: Math.max(5, Math.round(params.profile_period ?? 30)),
		profile_bins: Math.max(5, Math.round(params.profile_bins ?? 20)),
	};
}

export const poc_liquidity_rejection_fade: Strategy = {
	name: "POC Liquidity Rejection Fade",
	description:
		"The Volume Profile Point of Control acts as a high-liquidity magnet. When price touches the POC but suffers immediate, severe close rejection, passive liquidity has completely absorbed the directional attempt.",
	defaultParams: {
		poc_proximity_pct: 0.002,
		rejection_threshold: 0.25,
		profile_period: 30,
		profile_bins: 20,
	},
	paramLabels: {
		poc_proximity_pct: "POC Proximity %",
		rejection_threshold: "Rejection Threshold",
		profile_period: "Profile Period",
		profile_bins: "Profile Bins",
	},
	normalizeParams: normalizePocLiquidityRejectionFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizePocLiquidityRejectionFadeParams(params);
		if (cleanData.length < (p.profile_period as number) + 2) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closeLocation = buildCloseLocationSeries(cleanData);
		const profile = calculateVolumeProfile(cleanData, p.profile_period as number, p.profile_bins as number);

		return createSignalLoop(cleanData, [profile.poc], (i) => {
			if (i < p.profile_period) return null;
			const poc = profile.poc[i];
			if (poc === null || poc === 0) return null;

			const prox = p.poc_proximity_pct as number;
			const touchesPocLow = Math.abs(lows[i] - poc) / poc < prox;
			const touchesPocHigh = Math.abs(highs[i] - poc) / poc < prox;

			if (touchesPocLow && closeLocation[i] > (1 - (p.rejection_threshold as number))) {
				return createBuySignal(
					cleanData,
					i,
					`POC liquidity rejection fade (long): CL=${closeLocation[i].toFixed(3)}`
				);
			}
			if (touchesPocHigh && closeLocation[i] < p.rejection_threshold) {
				return createSellSignal(
					cleanData,
					i,
					`POC liquidity rejection fade (short): CL=${closeLocation[i].toFixed(3)}`
				);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["poc_proximity_pct", "rejection_threshold", "profile_period"],
	},
};





