import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getTypicalPrices } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		stateLookback: Math.max(2, Math.round(params.stateLookback ?? 50)),
		eigenLimit: Number(params.eigenLimit ?? 3.0)
	};
}

export const probability_boundary_eigen_shift: Strategy = {
	name: "Probability Boundary Eigen-Shift",
	description: "When the typical price (representing the session's Eigenvalue) breaches a 3-sigma boundary of its own rolling state, the local probability density function has failed, forcing violent mean reversion.",
	defaultParams: { stateLookback: 50, eigenLimit: 3.0 },
	paramLabels: { stateLookback: "State Lookback", eigenLimit: "Eigen Limit (Z-Score)" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["stateLookback", "eigenLimit"] },
	execute: (data, params) => {
		const clean = ensureCleanData(data);
		const p = normalizeParams(params);
		if (clean.length < p.stateLookback) return [];

		const typicalPrices = getTypicalPrices(clean);
		const zscore = buildRollingZScore(typicalPrices, p.stateLookback);

		return createSignalLoop(clean, [zscore], (i) => {
			if (i === 0) return null;

			const z = zscore[i - 1];

			if (z !== null) {
				if (z < -p.eigenLimit) {
					return createBuySignal(clean, i, "Eigen Boundary Snapback Long");
				}
				if (z > p.eigenLimit) {
					return createSellSignal(clean, i, "Eigen Boundary Snapback Short");
				}
			}

			return null;
		});
	}
};
