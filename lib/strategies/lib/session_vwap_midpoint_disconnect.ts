import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { calculateSessionVWAP } from "../indicators";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeSessionVwapMidpointDisconnectParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 50)),
		rank_thresh: Math.max(0.5, Math.min(1, Number(params.rank_thresh ?? 0.95))) };
}

export const session_vwap_midpoint_disconnect: Strategy = {
	name: "Session VWAP Midpoint Disconnect",
	description: "When typical price deviates from Session VWAP to an extreme historical percentile rank, the intraday auction has stretched too far from volume-weighted fair value.",
	defaultParams: {
		lookback: 50,
		rank_thresh: 0.95 },
	paramLabels: {
		lookback: "Lookback",
		rank_thresh: "Rank Threshold" },
	normalizeParams: normalizeSessionVwapMidpointDisconnectParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSessionVwapMidpointDisconnectParams(params);
		if (cleanData.length < p.lookback) return [];

		const typical = getTypicalPrices(cleanData);
		const vwap = calculateSessionVWAP(cleanData);

		const vwapAbove: number[] = new Array(cleanData.length).fill(0);
		const typicalAbove: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const v = vwap[i] ?? typical[i];
			vwapAbove[i] = v - typical[i];
			typicalAbove[i] = typical[i] - v;
		}
		const rankVwapAbove = buildPercentileRank(vwapAbove, p.lookback);
		const rankTypicalAbove = buildPercentileRank(typicalAbove, p.lookback);

		return createSignalLoop(cleanData, [rankVwapAbove, rankTypicalAbove], (i) => {
			if (i < p.lookback) return null;
			const rva = rankVwapAbove[i];
			const rta = rankTypicalAbove[i];
			if (rva === null || rta === null) return null;

			if (rva > p.rank_thresh) {
				return createBuySignal(cleanData, i, `VWAP-typical deviation rank ${rva.toFixed(3)} > ${p.rank_thresh}, VWAP far above typical`);
			}
			if (rta > p.rank_thresh) {
				return createSellSignal(cleanData, i, `Typical-VWAP deviation rank ${rta.toFixed(3)} > ${p.rank_thresh}, typical far above VWAP`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "rank_thresh"] } };
