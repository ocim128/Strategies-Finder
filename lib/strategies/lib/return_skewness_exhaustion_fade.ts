import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingSkewness, buildRollingZScore } from "./price-action-statistics-core";

type ReturnSkewnessExhaustionFadePrepared = {
	cleanData: OHLCVData[];
	returns: number[];
	skewZByWindow: Map<number, (number | null)[]>;
};

function normalizeReturnSkewnessExhaustionFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		skew_window: Math.max(3, Math.round(params.skew_window ?? 30)),
		zscore_threshold: Math.max(0.5, Number(params.zscore_threshold ?? 2.5)),
	};
}

function prepareReturnSkewnessExhaustionFadeData(data: OHLCVData[]): ReturnSkewnessExhaustionFadePrepared {
	const cleanData = ensureCleanData(data);
	return {
		cleanData,
		returns: extractBarMetricSeries(cleanData, "closeReturn"),
		skewZByWindow: new Map<number, (number | null)[]>(),
	};
}

function getPreparedReturnSkewnessExhaustionFadeData(
	preparedData: unknown,
	data: OHLCVData[]
): ReturnSkewnessExhaustionFadePrepared {
	if (preparedData && typeof preparedData === "object" && "skewZByWindow" in preparedData) {
		return preparedData as ReturnSkewnessExhaustionFadePrepared;
	}
	return prepareReturnSkewnessExhaustionFadeData(data);
}

function getSkewZSeries(
	prepared: ReturnSkewnessExhaustionFadePrepared,
	lookback: number
): (number | null)[] {
	let skewZ = prepared.skewZByWindow.get(lookback);
	if (!skewZ) {
		const skewness = buildRollingSkewness(prepared.returns, lookback);
		const skewClean = skewness.map((value) => value ?? 0);
		skewZ = buildRollingZScore(skewClean, lookback);
		prepared.skewZByWindow.set(lookback, skewZ);
	}
	return skewZ;
}

export const return_skewness_exhaustion_fade: Strategy = {
	name: "Return Skewness Exhaustion Fade",
	description: "A highly skewed distribution of returns indicates unilateral panic. Fading the extreme z-score of this skewness targets the exact moment the one-sided panic runs out of participants.",
	defaultParams: {
		skew_window: 30,
		zscore_threshold: 2.5,
	},
	paramLabels: {
		skew_window: "Skewness Window",
		zscore_threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeReturnSkewnessExhaustionFadeParams,
	prepareFinderData: (data) => prepareReturnSkewnessExhaustionFadeData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedReturnSkewnessExhaustionFadeData(preparedData, data);
		const p = normalizeReturnSkewnessExhaustionFadeParams(params);
		if (prepared.cleanData.length < p.skew_window * 2) return [];

		const skewZ = getSkewZSeries(prepared, p.skew_window);

		return createSignalLoop(prepared.cleanData, [skewZ], (i) => {
			if (i < p.skew_window) return null;
			const z = skewZ[i];
			if (z === null) return null;

			if (z < -p.zscore_threshold) {
				return createBuySignal(prepared.cleanData, i, `Return skewness exhaustion Z=${z.toFixed(2)}, downside tail climaxed`);
			}
			if (z > p.zscore_threshold) {
				return createSellSignal(prepared.cleanData, i, `Return skewness exhaustion Z=${z.toFixed(2)}, upside tail climaxed`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		return_skewness_exhaustion_fade.executePrepared?.(prepareReturnSkewnessExhaustionFadeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["skew_window", "zscore_threshold"],
	},
};





