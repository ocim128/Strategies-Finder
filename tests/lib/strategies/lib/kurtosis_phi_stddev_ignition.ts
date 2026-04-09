import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingKurtosis, buildRollingStdDev, buildRollingMedian, buildRateOfChange } from "./price-action-statistics-core";

function normalizeKurtosisPhiStddevIgnitionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(4, Math.round(params.lookback ?? 30)),
		phi_kurtosis: Math.max(0.01, Math.abs(Number(params.phi_kurtosis ?? 0.382))),
		phi_expansion: Math.max(0.01, Math.abs(Number(params.phi_expansion ?? 0.382))) };
}

export const kurtosis_phi_stddev_ignition: Strategy = {
	name: "Kurtosis Phi StdDev Ignition",
	description: "A structural breakout is authenticated when rolling kurtosis collapses below phi (tails normalizing) precisely as rolling standard deviation spikes above its median by the golden ratio.",
	defaultParams: {
		lookback: 30,
		phi_kurtosis: 0.382,
		phi_expansion: 0.382 },
	paramLabels: {
		lookback: "Lookback",
		phi_kurtosis: "Phi Kurtosis",
		phi_expansion: "Phi Expansion" },
	normalizeParams: normalizeKurtosisPhiStddevIgnitionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeKurtosisPhiStddevIgnitionParams(params);
		if (cleanData.length < p.lookback) return [];

		const returns = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			returns[i] = cleanData[i - 1].close !== 0
				? (cleanData[i].close - cleanData[i - 1].close) / cleanData[i - 1].close
				: 0;
		}

		const kurtosis = buildRollingKurtosis(returns, p.lookback);
		const stddev = buildRollingStdDev(returns, p.lookback);
		const stddevValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			stddevValues[i] = stddev[i] ?? 0;
		}
		const medianStddev = buildRollingMedian(stddevValues, p.lookback);
		const closes = cleanData.map(d => d.close);
		const roc = buildRateOfChange(closes, p.lookback);

		return createSignalLoop(cleanData, [kurtosis, stddev, medianStddev, roc], (i) => {
			if (i < p.lookback) return null;
			const k = kurtosis[i];
			const sd = stddev[i];
			const medSd = medianStddev[i];
			const rocVal = roc[i];
			if (k === null || sd === null || medSd === null || medSd <= 0 || rocVal === null) return null;

			if (k < p.phi_kurtosis && sd > medSd * (1 + p.phi_expansion) && rocVal > 0) {
				return createBuySignal(cleanData, i, `Kurtosis ${k.toFixed(3)} < phi, StdDev ${sd.toFixed(5)} > ${(medSd * (1 + p.phi_expansion)).toFixed(5)}, bullish ignition`);
			}
			if (k < p.phi_kurtosis && sd > medSd * (1 + p.phi_expansion) && rocVal < 0) {
				return createSellSignal(cleanData, i, `Kurtosis ${k.toFixed(3)} < phi, StdDev ${sd.toFixed(5)} > ${(medSd * (1 + p.phi_expansion)).toFixed(5)}, bearish ignition`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_kurtosis", "phi_expansion"] } };
