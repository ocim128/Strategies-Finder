import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingCorrelation } from "./price-action-statistics-core";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";

function normalizeSyntheticDecoherencePhiReversionParams(params: StrategyParams): StrategyParams {
	const corrLookback = Math.max(5, Math.round(params.corrLookback ?? 21));
	const phiDecoherence = Math.max(-0.99, Math.min(-0.01, Number(params.phiDecoherence ?? -0.618)));
	return { ...params, corrLookback, phiDecoherence };
}

export const synthetic_decoherence_phi_reversion: Strategy = {
	name: "Synthetic Decoherence Phi Reversion",
	description:
		"Fades synthetic liquidity ghost-prints where price-volume correlation drops below -0.618 (decoherence), confirmed by a golden wick rejection signal.",
	defaultParams: { corrLookback: 21, phiDecoherence: -0.618 },
	paramLabels: { corrLookback: "Correlation Lookback", phiDecoherence: "Phi Decoherence" },
	normalizeParams: normalizeSyntheticDecoherencePhiReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeSyntheticDecoherencePhiReversionParams(params);
		if (cleanData.length < np.corrLookback + 2) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const correlation = buildRollingCorrelation(closes, volumes, np.corrLookback);

		const signals = [];
		for (let i = np.corrLookback; i < cleanData.length; i++) {
			const corr = correlation[i];
			if (corr === null || corr >= np.phiDecoherence) continue;

			const bar = cleanData[i];
			const metrics = getPriceActionBarMetrics(bar);
			const range = metrics.range;
			if (range === 0) continue;

			const lowerWickPct = metrics.lowerWick / range;
			const upperWickPct = metrics.upperWick / range;
			const isBullish = bar.close > bar.open;
			const isBearish = bar.close < bar.open;

			if (isBullish && lowerWickPct > 0.618) {
				signals.push(createBuySignal(cleanData, i, `Decoherence corr < ${np.phiDecoherence} & golden lower wick`));
			}
			if (isBearish && upperWickPct > 0.618) {
				signals.push(createSellSignal(cleanData, i, `Decoherence corr < ${np.phiDecoherence} & golden upper wick`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["corrLookback", "phiDecoherence"],
	},
};
