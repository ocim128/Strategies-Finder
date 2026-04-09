import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingCorrelation, buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeReturnCorrelationBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		correlationLookback: Math.max(3, Math.round(params.correlationLookback ?? 30)),
		zLookback: Math.max(3, Math.round(params.zLookback ?? 60)) };
}

export const volume_return_correlation_break: Strategy = {
	name: "Volume Return Correlation Break",
	description: "When rolling correlation between returns and volume collapses from positive to a Z-score extreme low, the prevailing move lacks volume support and exhaustion reversal is favored.",
	defaultParams: {
		correlationLookback: 30,
		zLookback: 60 },
	paramLabels: {
		correlationLookback: "Correlation Lookback",
		zLookback: "Z-Score Lookback" },
	normalizeParams: normalizeVolumeReturnCorrelationBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeReturnCorrelationBreakParams(params);
		if (cleanData.length < p.correlationLookback + p.zLookback) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const returns = buildRateOfChange(closes, 1);
		const returnValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			returnValues[i] = returns[i] ?? 0;
		}
		const correlation = buildRollingCorrelation(returnValues, volumes, p.correlationLookback);
		const corrValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			corrValues[i] = correlation[i] ?? 0;
		}
		const corrZ = buildRollingZScore(corrValues, p.zLookback);

		return createSignalLoop(cleanData, [corrZ], (i) => {
			if (i < p.correlationLookback + p.zLookback) return null;
			const z = corrZ[i];
			if (z === null) return null;

			if (z < -1.5 && closes[i] < closes[i - 1]) {
				return createBuySignal(cleanData, i, `Return-Vol corr Z ${z.toFixed(2)} collapsed, price fell without support`);
			}
			if (z < -1.5 && closes[i] > closes[i - 1]) {
				return createSellSignal(cleanData, i, `Return-Vol corr Z ${z.toFixed(2)} collapsed, price rose without support`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["correlationLookback", "zLookback"] } };
