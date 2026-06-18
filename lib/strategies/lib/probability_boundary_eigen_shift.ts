import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getTypicalPrices } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

type ProbabilityBoundaryEigenShiftPrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		stateLookback: Math.max(2, Math.round(params.stateLookback ?? 50)),
		eigenLimit: Number(params.eigenLimit ?? 3.0)
	};
}

function prepareProbabilityBoundaryEigenShiftData(data: OHLCVData[]): ProbabilityBoundaryEigenShiftPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		typicalPrices: getTypicalPrices(clean),
	};
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): ProbabilityBoundaryEigenShiftPrepared {
	if (preparedData && typeof preparedData === "object" && "typicalPrices" in preparedData) {
		return preparedData as ProbabilityBoundaryEigenShiftPrepared;
	}
	return prepareProbabilityBoundaryEigenShiftData(data);
}

export const probability_boundary_eigen_shift: Strategy = {
	name: "Probability Boundary Eigen-Shift",
	description: "When the typical price (representing the session's Eigenvalue) breaches a 3-sigma boundary of its own rolling state, the local probability density function has failed, forcing violent mean reversion.",
	defaultParams: { stateLookback: 50, eigenLimit: 3.0 },
	paramLabels: { stateLookback: "State Lookback", eigenLimit: "Eigen Limit (Z-Score)" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["stateLookback", "eigenLimit"] },
	prepareFinderData: (data) => prepareProbabilityBoundaryEigenShiftData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedData(preparedData, data);
		const p = normalizeParams(params);
		if (prepared.data.length < p.stateLookback) return [];

		// buildRollingZScore caches by array identity in a WeakMap; holding a
		// stable typicalPrices reference across param runs turns the per-symbol,
		// per-lookback recomputation into a cache hit after the first run.
		const zscore = buildRollingZScore(prepared.typicalPrices, p.stateLookback);

		return createSignalLoop(prepared.data, [zscore], (i) => {
			if (i === 0) return null;

			const z = zscore[i - 1];

			if (z !== null) {
				if (z < -p.eigenLimit) {
					return createBuySignal(prepared.data, i, "Eigen Boundary Snapback Long");
				}
				if (z > p.eigenLimit) {
					return createSellSignal(prepared.data, i, "Eigen Boundary Snapback Short");
				}
			}

			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		probability_boundary_eigen_shift.executePrepared?.(prepareProbabilityBoundaryEigenShiftData(data), params, data) ?? [],
};
