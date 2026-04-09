import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildRollingZScore } from "./price-action-statistics-core";

function normalizeInitiativePressurePersistenceRegimeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 30)),
		autoCorrThreshold: Math.max(0, Math.abs(Number(params.autoCorrThreshold ?? 0.3))) };
}

export const initiative_pressure_persistence_regime: Strategy = {
	name: "Initiative Pressure Persistence Regime",
	description: "Autocorrelation of initiative pressure reveals whether aggressive participation is temporally structured (coordinated dealer flow) or random. When autocorrelation is elevated and pressure itself is extreme, coordinated aggression is likely to continue. Trade continuation.",
	defaultParams: {
		lookback: 30,
		autoCorrThreshold: 0.3 },
	paramLabels: {
		lookback: "Lookback",
		autoCorrThreshold: "Autocorrelation Threshold" },
	normalizeParams: normalizeInitiativePressurePersistenceRegimeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativePressurePersistenceRegimeParams(params);
		const lookback = p.lookback as number;
		const autoCorrThreshold = p.autoCorrThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const ipSeries = buildInitiativePressureSeries(cleanData, lookback);
		const ipClean = ipSeries.map(v => v ?? 0);
		const ipAutocorr = buildRollingAutoCorrelation(ipClean, lookback);
		const ipZscore = buildRollingZScore(ipClean, lookback);

		return createSignalLoop(cleanData, [ipAutocorr, ipZscore], (i) => {
			if (i < lookback) return null;
			const ac = ipAutocorr[i];
			const z = ipZscore[i];
			if (ac === null || z === null) return null;

			if (ac > autoCorrThreshold && z > 2.0) {
				return createBuySignal(cleanData, i, `Coordinated buying initiative (AC=${ac.toFixed(2)}, z=${z.toFixed(2)}) — continuation`);
			}
			if (ac > autoCorrThreshold && z < -2.0) {
				return createSellSignal(cleanData, i, `Coordinated selling initiative (AC=${ac.toFixed(2)}, z=${z.toFixed(2)}) — continuation`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "autoCorrThreshold"] } };
