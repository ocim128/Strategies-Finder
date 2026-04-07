import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeVolumeVacuumPhiImplosionParams(params: StrategyParams): StrategyParams {
	const volLookback = Math.max(2, Math.round(params.volLookback ?? 55));
	const phiImplosionRatio = Math.min(1, Math.max(0, Number(params.phiImplosionRatio ?? 0.382)));
	return { ...params, volLookback, phiImplosionRatio };
}

export const volume_vacuum_phi_implosion: Strategy = {
	name: "Volume Vacuum Phi Implosion",
	description:
		"Triggers on structural voids where volume implodes to less than 38.2% of its rolling average, buying the exact bar that establishes a dominant geometric presence in the vacuum.",
	defaultParams: { volLookback: 55, phiImplosionRatio: 0.382 },
	paramLabels: { volLookback: "Volume Lookback", phiImplosionRatio: "Phi Implosion Ratio" },
	normalizeParams: normalizeVolumeVacuumPhiImplosionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeVolumeVacuumPhiImplosionParams(params);
		if (cleanData.length < np.volLookback + 1) return [];
		const volumes = getVolumes(cleanData);
		const volSma = buildRollingAverage(volumes, np.volLookback);
		const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const volRatio: (number | null)[] = new Array(cleanData.length).fill(null);
		for (let i = 0; i < cleanData.length; i++) {
			const sma = volSma[i];
			if (sma !== null && sma > 0) volRatio[i] = volumes[i] / sma;
		}
		return createSignalLoop(cleanData, [volRatio], (i) => {
			const ratio = volRatio[i];
			if (ratio === null) return null;
			if (ratio < np.phiImplosionRatio && bodyPct[i] > 0.618) {
				if (bodyDir[i] === 1) return createBuySignal(cleanData, i, `Volume vacuum ${ratio.toFixed(3)} < ${np.phiImplosionRatio}, body dominance`);
				if (bodyDir[i] === -1) return createSellSignal(cleanData, i, `Volume vacuum ${ratio.toFixed(3)} < ${np.phiImplosionRatio}, body dominance`);
			}
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["volLookback", "phiImplosionRatio"] } };
