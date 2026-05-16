import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeVolatilityPercentileReversalParams(params: StrategyParams): StrategyParams {
	const stdDevWindow = Math.max(2, Math.round(params.stdDevWindow ?? 20));
	const percentileWindow = Math.max(stdDevWindow + 1, Math.round(params.percentileWindow ?? 60));
	return {
		...params,
		stdDevWindow,
		percentileWindow };
}

export const volatility_percentile_reversal: Strategy = {
	name: "Volatility Percentile Reversal",
	description: "When rolling std dev of returns reaches an extreme percentile, the market is in a volatility climax. A two-bar directional reversal within this state confirms the climax has reversed.",
	defaultParams: {
		stdDevWindow: 20,
		percentileWindow: 60 },
	paramLabels: {
		stdDevWindow: "StdDev Window",
		percentileWindow: "Percentile Window" },
	normalizeParams: normalizeVolatilityPercentileReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolatilityPercentileReversalParams(params);
		if (cleanData.length < p.percentileWindow) return [];

		const closes = getCloses(cleanData);
		const returns = buildRateOfChange(closes, 1);
		const returnValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			returnValues[i] = returns[i] ?? 0;
		}
		const stddev = buildRollingStdDev(returnValues, p.stdDevWindow);
		const stddevValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			stddevValues[i] = stddev[i] ?? 0;
		}
		const rank = buildPercentileRank(stddevValues, p.percentileWindow);

		return createSignalLoop(cleanData, [rank], (i) => {
			if (i < 1 || i < p.percentileWindow) return null;
			const r = rank[i];
			if (r === null) return null;

			if (r <= 0.9) return null;

			const currUp = cleanData[i].close > cleanData[i].open;
			const prevDown = cleanData[i - 1].close < cleanData[i - 1].open;
			const currDown = cleanData[i].close < cleanData[i].open;
			const prevUp = cleanData[i - 1].close > cleanData[i - 1].open;

			if (currUp && prevDown) {
				return createBuySignal(cleanData, i, `Vol rank ${r.toFixed(3)} > 90th pctile, two-bar reversal up, selling panic absorbed`);
			}
			if (currDown && prevUp) {
				return createSellSignal(cleanData, i, `Vol rank ${r.toFixed(3)} > 90th pctile, two-bar reversal down, buying panic absorbed`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["stdDevWindow", "percentileWindow"] } };





