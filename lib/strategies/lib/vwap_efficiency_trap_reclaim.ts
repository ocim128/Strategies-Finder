import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

export const vwap_efficiency_trap_reclaim: Strategy = {
	name: "VWAP Efficiency Trap Reclaim",
	description: "Enters cleanly after a strictly high-efficiency macro trend drops slightly to pierce the VWAP trap line, but strictly and immediately reclaims the level with an absolute Engulfing setup on the next tick.",
	defaultParams: {
		efficiencyPeriod: 20,
		minEfficiency: 0.35,
		vwapBuffer: 0.05,
	},
	paramLabels: {
		efficiencyPeriod: "Efficiency Period",
		minEfficiency: "Min Efficiency",
		vwapBuffer: "VWAP Buffer (%)",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const period = Number(params.efficiencyPeriod ?? 20);
		const minEff = Number(params.minEfficiency ?? 0.35);
		const bufferPct = Number(params.vwapBuffer ?? 0.05) / 100.0;

        if (cleanData.length < period) return [];

		const vwap = calculateVWAP(cleanData);
        const er = buildEfficiencyRatio(cleanData, period);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || vwap[i-1] === null || vwap[i] === null || er[i-1] === null) return null;

            const prevVwap = vwap[i-1]!;
            const currVwap = vwap[i]!;

            const isPrevUnderVWAP = cleanData[i-1].low < prevVwap && cleanData[i-1].close < prevVwap;
            const isBullEngulf = cleanData[i].high > cleanData[i-1].high && cleanData[i].close > currVwap * (1 + bufferPct);

            if (er[i-1]! > minEff && isPrevUnderVWAP && isBullEngulf) {
                return createBuySignal(cleanData, i, "VWAP trap pierced, immediate bullish engulf reclaim");
            }

            const isPrevOverVWAP = cleanData[i-1].high > prevVwap && cleanData[i-1].close > prevVwap;
            const isBearEngulf = cleanData[i].low < cleanData[i-1].low && cleanData[i].close < currVwap * (1 - bufferPct);

            if (er[i-1]! < -minEff && isPrevOverVWAP && isBearEngulf) {
                return createSellSignal(cleanData, i, "VWAP trap pierced, immediate bearish engulf reclaim");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["efficiencyPeriod", "minEfficiency", "vwapBuffer"],
	},
};
