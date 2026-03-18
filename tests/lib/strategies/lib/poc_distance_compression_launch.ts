import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";

function buildRollingMinMax(data: number[], period: number): { min: (number | null)[], max: (number | null)[] } {
    const min: (number | null)[] = new Array(data.length).fill(null);
    const max: (number | null)[] = new Array(data.length).fill(null);
    const minDeque: number[] = [];
    const maxDeque: number[] = [];

    for (let i = 0; i < data.length; i++) {
        while (minDeque.length > 0 && data[minDeque[minDeque.length - 1]] >= data[i]) minDeque.pop();
        minDeque.push(i);
        if (minDeque[0] <= i - period) minDeque.shift();

        while (maxDeque.length > 0 && data[maxDeque[maxDeque.length - 1]] <= data[i]) maxDeque.pop();
        maxDeque.push(i);
        if (maxDeque[0] <= i - period) maxDeque.shift();

        if (i >= period - 1) {
            min[i] = data[minDeque[0]];
            max[i] = data[maxDeque[0]];
        }
    }
    return { min, max };
}

export const poc_distance_compression_launch: Strategy = {
	name: "Volume POC Distance Compression Launch",
	description: "Locates macro dead zones where the absolute physical distance from Price to the Volume Point of Control shrinks to the lowest localized minimum seen perfectly before the ensuing structural launch.",
	defaultParams: {
		profileLookback: 100,
		macroLookback: 50,
		rocTrigger: 3.0,
	},
	paramLabels: {
		profileLookback: "Profile Lookback",
		macroLookback: "Macro Lookback",
		rocTrigger: "ROC Trigger",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const profParams = Number(params.profileLookback ?? 100);
		const lookback = Number(params.macroLookback ?? 50);
		const trigger = Number(params.rocTrigger ?? 3.0);

		if (cleanData.length < Math.max(profParams, lookback)) return [];

		const { poc } = calculateVolumeProfile(cleanData, profParams, 24);

        const absDist = cleanData.map((d, i) => {
            if (poc[i] === null) return 0;
            return Math.abs(d.close - poc[i]!);
        });

        const { min, max } = buildRollingMinMax(absDist, lookback);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || min[i-1] === null || max[i-1] === null || poc[i-1] === null) return null;

            const rangeDist = max[i-1]! - min[i-1]!;
            let isCompressed = false;
            if (rangeDist > 0) {
                const pct = (absDist[i-1] - min[i-1]!) / rangeDist;
                if (pct <= 0.05) isCompressed = true;
            } else if (rangeDist === 0) {
                isCompressed = true; 
            }

            const currentRoc = ((cleanData[i].close - cleanData[i-1].close) / cleanData[i-1].close) * 100;

            if (isCompressed && currentRoc > trigger) {
                return createBuySignal(cleanData, i, "POC Compression breakout thrust long");
            }

            if (isCompressed && currentRoc < -trigger) {
                return createSellSignal(cleanData, i, "POC Compression breakout thrust short");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["profileLookback", "macroLookback", "rocTrigger"],
	},
};
