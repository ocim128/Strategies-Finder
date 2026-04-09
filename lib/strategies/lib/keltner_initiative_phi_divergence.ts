import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeKeltnerInitiativePhiDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		kc_lookback: Math.max(2, Math.round(params.kc_lookback ?? 20)),
		corr_lookback: Math.max(3, Math.round(params.corr_lookback ?? 14)),
		phi_divergence: Math.max(0.01, Math.abs(Number(params.phi_divergence ?? 0.382))) };
}

export const keltner_initiative_phi_divergence: Strategy = {
	name: "Keltner Initiative Phi Divergence",
	description: "Price interacting with Keltner bands while the correlation between price and initiative pressure drops below phi proves the boundary push is lacking aggressive sponsorship — mean reversion setup.",
	defaultParams: {
		kc_lookback: 20,
		corr_lookback: 14,
		phi_divergence: 0.382 },
	paramLabels: {
		kc_lookback: "KC Lookback",
		corr_lookback: "Correlation Lookback",
		phi_divergence: "Phi Divergence" },
	normalizeParams: normalizeKeltnerInitiativePhiDivergenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeKeltnerInitiativePhiDivergenceParams(params);
		if (cleanData.length < p.kc_lookback + p.corr_lookback) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const kc = calculateKeltnerChannels(highs, lows, closes, p.kc_lookback, p.kc_lookback, 2);

		const pressure = buildInitiativePressureSeries(cleanData, p.kc_lookback);
		const pressureValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			pressureValues[i] = pressure[i] ?? 0;
		}
		const correlation = buildRollingCorrelation(closes, pressureValues, p.corr_lookback);

		return createSignalLoop(cleanData, [kc.upper, kc.lower, correlation], (i) => {
			if (i < p.kc_lookback) return null;
			const upper = kc.upper[i];
			const lower = kc.lower[i];
			const corr = correlation[i];
			if (upper === null || lower === null || corr === null) return null;

			if (closes[i] < lower && corr < p.phi_divergence) {
				return createBuySignal(cleanData, i, `Close below KC lower, price-pressure corr ${corr.toFixed(3)} < phi — no sponsorship`);
			}
			if (closes[i] > upper && corr < p.phi_divergence) {
				return createSellSignal(cleanData, i, `Close above KC upper, price-pressure corr ${corr.toFixed(3)} < phi — no sponsorship`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["kc_lookback", "corr_lookback", "phi_divergence"] } };
