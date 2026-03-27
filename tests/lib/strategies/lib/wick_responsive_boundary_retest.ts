import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
	const boundaryLookback = Math.max(2, Math.round(params.boundary_lookback ?? 15));
	const testThreshold = Math.max(1, Math.round(params.test_threshold ?? 3));
	const retestTolerance = Math.max(0.001, Math.min(0.1, params.retest_tolerance ?? 0.01));

	return {
		...params,
		boundary_lookback: boundaryLookback,
		test_threshold: testThreshold,
		retest_tolerance: retestTolerance,
	};
}

export const wick_responsive_boundary_retest: Strategy = {
	name: "Boundary Retest Entry",
	description: "Variant 2: Requires price to retest the boundary after initial tests. More conservative - waits for pullback confirmation.",
	defaultParams: {
		boundary_lookback: 15,
		test_threshold: 3,
		retest_tolerance: 0.01,
	},
	paramLabels: {
		boundary_lookback: "Boundary Lookback",
		test_threshold: "Test Threshold",
		retest_tolerance: "Retest Tolerance",
	},
	normalizeParams: normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeParams(params);
		const { boundary_lookback: boundaryLookback, test_threshold: testThreshold, retest_tolerance: retestTolerance } = normalizedParams;

		if (cleanData.length < boundaryLookback + 2) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);

		const signals: ReturnType<typeof createBuySignal>[] = [];

		for (let i = boundaryLookback; i < cleanData.length; i++) {
			let upperWickTests = 0;
			let lowerWickTests = 0;
			let upperBoundary = highs[i - boundaryLookback];
			let lowerBoundary = lows[i - boundaryLookback];

			for (let j = i - boundaryLookback; j < i; j++) {
				const high = highs[j];
				const low = lows[j];
				const close = closes[j];

				if (Math.abs(high - upperBoundary) < 0.0001 || close >= upperBoundary) {
					upperWickTests++;
				}
				if (Math.abs(low - lowerBoundary) < 0.0001 || close <= lowerBoundary) {
					lowerWickTests++;
				}

				if (high > upperBoundary) upperBoundary = high;
				if (low < lowerBoundary) lowerBoundary = low;
			}

			// Check if current bar is a retest (pullback from boundary)
			const priorClose = closes[i - 1];
			const isRetestBuy = lowerWickTests >= testThreshold && priorClose > lowerBoundary && closes[i] <= lowerBoundary * (1 + retestTolerance);
			const isRetestSell = upperWickTests >= testThreshold && priorClose < upperBoundary && closes[i] >= upperBoundary * (1 - retestTolerance);

			// Buy: retest of strong lower boundary
			if (isRetestBuy) {
				signals.push(createBuySignal(cleanData, i, `Lower tested ${lowerWickTests}, retested at ${closes[i].toFixed(2)}`));
				continue;
			}

			// Sell: retest of strong upper boundary
			if (isRetestSell) {
				signals.push(createSellSignal(cleanData, i, `Upper tested ${upperWickTests}, retested at ${closes[i].toFixed(2)}`));
			}
		}

		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["boundary_lookback", "test_threshold", "retest_tolerance"],
	},
};