import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
	const barrier_lookback = Math.max(2, Math.round(params.barrier_lookback ?? 8));
	const touch_count = Math.max(2, Math.round(params.touch_count ?? 3));
	return { ...params, barrier_lookback, touch_count };
}

export const fractal_wick_barrier_engulfing: Strategy = {
	name: "Fractal Wick Barrier Engulfing",
	description: "Multiple nearly identical price extrusions forming a tight cluster creates a liquidity wall; a clean break immediately beyond it guarantees a liquidation cascade.",
	defaultParams: {
		barrier_lookback: 8,
		touch_count: 3,
	},
	paramLabels: {
		barrier_lookback: "Barrier Lookback",
		touch_count: "Touch Count",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const { barrier_lookback, touch_count } = normalizeParams(params);
        
		if (cleanData.length < barrier_lookback + 2) return [];

		return createSignalLoop(cleanData, [], (i) => {
            if (i < barrier_lookback) return null;

            const close = cleanData[i].close;

            let tightCeilingFound = false;
            let ceilingPrice = 0;
            for (let j = i - barrier_lookback; j < i; j++) {
                let matches = 1;
                const h1 = cleanData[j].high;
                for (let k = j + 1; k < i; k++) {
                    const h2 = cleanData[k].high;
                    if (Math.abs(h1 - h2) / h1 < 0.001) {
                        matches++;
                    }
                }
                if (matches >= touch_count) {
                    tightCeilingFound = true;
                    ceilingPrice = h1;
                    break;
                }
            }

            let tightFloorFound = false;
            let floorPrice = 0;
            for (let j = i - barrier_lookback; j < i; j++) {
                let matches = 1;
                const l1 = cleanData[j].low;
                for (let k = j + 1; k < i; k++) {
                    const l2 = cleanData[k].low;
                    if (Math.abs(l1 - l2) / l1 < 0.001) {
                        matches++;
                    }
                }
                if (matches >= touch_count) {
                    tightFloorFound = true;
                    floorPrice = l1;
                    break;
                }
            }

            if (tightCeilingFound && close > ceilingPrice) {
                return createBuySignal(cleanData, i, `Ceiling swept (${touch_count} touches)`);
            } else if (tightFloorFound && close < floorPrice) {
                return createSellSignal(cleanData, i, `Floor swept (${touch_count} touches)`);
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["barrier_lookback", "touch_count"],
	},
};
