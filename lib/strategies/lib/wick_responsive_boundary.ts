import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
	const boundaryLookback = Math.max(2, Math.round(params.boundary_lookback ?? 15));
	const testThreshold = Math.max(1, Math.round(params.test_threshold ?? 3));

	return {
		...params,
		boundary_lookback: boundaryLookback,
		test_threshold: testThreshold,
	};
}

export const wick_responsive_boundary: Strategy = {
	name: "Wick Responsive Boundary",
	description: "A boundary forms where price repeatedly tests but fails to break through wicks. The boundary strength equals test count; break of strong boundary triggers entry.",
	defaultParams: {
		boundary_lookback: 15,
		test_threshold: 3,
	},
	paramLabels: {
		boundary_lookback: "Boundary Lookback",
		test_threshold: "Test Threshold",
	},
	normalizeParams: normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeParams(params);
		const { boundary_lookback: boundaryLookback, test_threshold: testThreshold } = normalizedParams;

		if (cleanData.length < boundaryLookback + 1) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);

		const signals: ReturnType<typeof createBuySignal>[] = [];

		for (let i = boundaryLookback; i < cleanData.length; i++) {
			// Track wick boundary tests in the lookback window
			// Use wick extremes as boundaries
			let upperWickTests = 0;
			let lowerWickTests = 0;
			let upperBoundary = highs[i - boundaryLookback];
			let lowerBoundary = lows[i - boundaryLookback];

			for (let j = i - boundaryLookback; j < i; j++) {
				const high = highs[j];
				const low = lows[j];
				const close = closes[j];

				// Track wick touches at the boundaries
				if (Math.abs(high - upperBoundary) < 0.0001 || close >= upperBoundary) {
					upperWickTests++;
				}
				if (Math.abs(low - lowerBoundary) < 0.0001 || close <= lowerBoundary) {
					lowerWickTests++;
				}

				// Update boundaries with extremes
				if (high > upperBoundary) upperBoundary = high;
				if (low < lowerBoundary) lowerBoundary = low;
			}

			// Buy: lower wick boundary tested test_threshold times without break AND current close breaks above
			if (lowerWickTests >= testThreshold && closes[i] > lowerBoundary) {
				signals.push(createBuySignal(cleanData, i, `Lower wick tested ${lowerWickTests} >= ${testThreshold}, broke above ${lowerBoundary.toFixed(2)}`));
				continue;
			}

			// Sell: upper wick boundary tested test_threshold times without break AND current close breaks below
			if (upperWickTests >= testThreshold && closes[i] < upperBoundary) {
				signals.push(createSellSignal(cleanData, i, `Upper wick tested ${upperWickTests} >= ${testThreshold}, broke below ${upperBoundary.toFixed(2)}`));
			}
		}

		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["boundary_lookback", "test_threshold"],
	},
};
