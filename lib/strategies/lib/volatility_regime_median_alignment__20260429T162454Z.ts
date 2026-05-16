import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeVolatilityRegimeMedianAlignmentParams(params: StrategyParams): StrategyParams {
	const lookback = Math.max(2, Math.round(Number(params.lookback ?? 63)));
	const volThreshold = Math.max(1, Math.min(99, Math.round(Number(params.vol_threshold ?? 70))));
	return {
		...params,
		lookback,
		vol_threshold: volThreshold };
}

export const volatility_regime_median_alignment: Strategy = {
	name: "Volatility Regime Median Alignment",
	description: "Defines volatility regime via percentile rank of trailing standard deviation, then applies median centerline alignment only within the high-volatility regime.",
	defaultParams: {
		lookback: 63,
		vol_threshold: 70 },
	paramLabels: {
		lookback: "Lookback",
		vol_threshold: "Vol Percentile Threshold" },
	normalizeParams: normalizeVolatilityRegimeMedianAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolatilityRegimeMedianAlignmentParams(params);
		const lookback = p.lookback as number;
		const volThreshold = p.vol_threshold as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const median = buildRollingMedian(closes, lookback);
		const stddev = buildRollingStdDev(closes, lookback);

		// Normalize nulls to 0 for percentile rank computation
		const stddevValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			stddevValues[i] = stddev[i] ?? 0;
		}
		const volRank = buildPercentileRank(stddevValues, lookback);

		const volThresholdFraction = volThreshold / 100;

		return createSignalLoop(cleanData, [median, volRank], (i) => {
			const m = median[i];
			const vr = volRank[i];
			if (m === null || vr === null) return null;

			if (vr > volThresholdFraction && closes[i] > m) {
				return createBuySignal(cleanData, i, `Vol rank ${(vr * 100).toFixed(1)}% > ${volThreshold}%, close above median`);
			}
			if (vr > volThresholdFraction && closes[i] < m) {
				return createSellSignal(cleanData, i, `Vol rank ${(vr * 100).toFixed(1)}% > ${volThreshold}%, close below median`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "vol_threshold"] } };





