import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";
import { buildRateOfChange, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeVolumeProfilePhiEscapeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		vp_lookback: Math.max(10, Math.round(params.vp_lookback ?? 50)),
		std_lookback: Math.max(2, Math.round(params.std_lookback ?? 20)),
		phi_escape_z: Math.max(0.01, Number(params.phi_escape_z ?? 0.382)),
	};
}

export const volume_profile_phi_escape: Strategy = {
	name: "Volume Profile Phi Escape",
	description: "Price breaking away from the Volume Profile POC is validated only when the single-bar ROC exceeds 0.382 standard deviations of local volatility, filtering microstructure noise.",
	defaultParams: {
		vp_lookback: 50,
		std_lookback: 20,
		phi_escape_z: 0.382,
	},
	paramLabels: {
		vp_lookback: "VP Lookback",
		std_lookback: "StdDev Lookback",
		phi_escape_z: "Phi Escape Z",
	},
	normalizeParams: normalizeVolumeProfilePhiEscapeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeProfilePhiEscapeParams(params);
		if (cleanData.length < Math.max(p.vp_lookback, p.std_lookback)) return [];

		const closes = getCloses(cleanData);
		const { poc } = calculateVolumeProfile(cleanData, p.vp_lookback, 10);
		const roc = buildRateOfChange(closes, 1);
		const stdDev = buildRollingStdDev(closes, p.std_lookback);

		return createSignalLoop(cleanData, [poc, roc, stdDev], (i) => {
			if (i < p.vp_lookback) return null;
			const currentPoc = poc[i];
			const prevPoc = poc[i - 1];
			const currentRoc = roc[i];
			const sd = stdDev[i];
			if (currentPoc === null || prevPoc === null || currentRoc === null || sd === null) return null;

			const thrust = sd * p.phi_escape_z;
			if (closes[i] > currentPoc && closes[i - 1] <= prevPoc && currentRoc > thrust)
				return createBuySignal(cleanData, i, "Bullish POC escape with phi thrust");
			if (closes[i] < currentPoc && closes[i - 1] >= prevPoc && currentRoc < -thrust)
				return createSellSignal(cleanData, i, "Bearish POC escape with phi thrust");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["vp_lookback", "std_lookback", "phi_escape_z"],
	},
};
