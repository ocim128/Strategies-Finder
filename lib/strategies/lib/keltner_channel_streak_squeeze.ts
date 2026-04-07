import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	const kc_period = Math.max(2, Math.round(params.kc_period ?? 20));
	const streak_threshold = Math.max(1, Math.round(params.streak_threshold ?? 4));
	return { ...params, kc_period, streak_threshold };
}

export const keltner_channel_streak_squeeze: Strategy = {
	name: "Keltner Channel Streak Squeeze",
	description: "Sequential strong closes riding cleanly outside a basic Keltner Channel implies an unstoppable trend impulse.",
	defaultParams: {
		kc_period: 20,
		streak_threshold: 4 },
	paramLabels: {
		kc_period: "KC Period",
		streak_threshold: "Streak Threshold" },
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const { kc_period, streak_threshold } = normalizeParams(params);
        
		if (cleanData.length < kc_period + streak_threshold) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const kc = calculateKeltnerChannels(highs, lows, closes, kc_period, kc_period, 1.5);

        const signs = new Array(cleanData.length).fill(0);
        for(let i=0; i<cleanData.length; i++) {
            if (kc.upper[i] !== null && kc.lower[i] !== null) {
                if(closes[i] > kc.upper[i]!) {
                    signs[i] = 1;
                } else if(closes[i] < kc.lower[i]!) {
                    signs[i] = -1;
                }
            }
        }
        
        const streaks = buildStreakCount(signs);

		return createSignalLoop(cleanData, [streaks], (i) => {
            const streak = streaks[i];

            if (streak > streak_threshold) { // "exceeds streak_threshold"
                return createBuySignal(cleanData, i, `KC Upper Streak ${streak} > ${streak_threshold}`);
            } else if (streak < -streak_threshold) { // "exceeds streak_threshold" means less than -threshold
                return createSellSignal(cleanData, i, `KC Lower Streak ${-streak} > ${streak_threshold}`);
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["kc_period", "streak_threshold"] } };
