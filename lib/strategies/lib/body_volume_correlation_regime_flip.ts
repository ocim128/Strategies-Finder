import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeBodyVolumeCorrelationRegimeFlipParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		corrWindow: Math.max(3, Math.round(params.corrWindow ?? 20)),
		minAbsCorr: Math.max(0, Math.abs(Number(params.minAbsCorr ?? 0.2))) };
}

export const body_volume_correlation_regime_flip: Strategy = {
	name: "Body Volume Correlation Regime Flip",
	description: "Rolling correlation between bar body direction and volume measures whether directional moves attract participation. When this correlation flips sign, the dealer participation regime has shifted. Enter in the direction indicated by the new regime alignment.",
	defaultParams: {
		corrWindow: 20,
		minAbsCorr: 0.2 },
	paramLabels: {
		corrWindow: "Correlation Window",
		minAbsCorr: "Min |Correlation|" },
	normalizeParams: normalizeBodyVolumeCorrelationRegimeFlipParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyVolumeCorrelationRegimeFlipParams(params);
		const corrWindow = p.corrWindow as number;
		const minAbsCorr = p.minAbsCorr as number;
		if (cleanData.length < corrWindow + 2) return [];

		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const volumes = getVolumes(cleanData);
		const corr = buildRollingCorrelation(bodyDir, volumes, corrWindow);

		return createSignalLoop(cleanData, [corr], (i) => {
			if (i < corrWindow + 1) return null;
			const priorCorr = corr[i - 1];
			const currCorr = corr[i];
			if (priorCorr === null || currCorr === null) return null;

			if (priorCorr > minAbsCorr && currCorr <= 0 && bodyDir[i] > 0) {
				return createBuySignal(cleanData, i, `Body-vol correlation flipped positive→negative, body bullish — regime shift`);
			}
			if (priorCorr < -minAbsCorr && currCorr >= 0 && bodyDir[i] < 0) {
				return createSellSignal(cleanData, i, `Body-vol correlation flipped negative→positive, body bearish — regime shift`);
			}
			if (priorCorr < -minAbsCorr && currCorr >= 0 && bodyDir[i] > 0) {
				return createBuySignal(cleanData, i, `Body-vol correlation flipped to positive regime, body confirms bullish`);
			}
			if (priorCorr > minAbsCorr && currCorr <= 0 && bodyDir[i] < 0) {
				return createSellSignal(cleanData, i, `Body-vol correlation flipped to negative regime, body confirms bearish`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["corrWindow", "minAbsCorr"] } };
