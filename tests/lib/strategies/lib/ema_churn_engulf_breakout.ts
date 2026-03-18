import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateEMA } from "../indicators";

function buildThresholdCrossingCount(crossings: boolean[], lookback: number): number[] {
    const res = new Array(crossings.length).fill(0);
    let count = 0;
    for (let i = 0; i < crossings.length; i++) {
        if (crossings[i]) count++;
        if (i >= lookback && crossings[i - lookback]) count--;
        res[i] = count;
    }
    return res;
}

export const ema_churn_engulf_breakout: Strategy = {
	name: "EMA Churn Engulf Breakout",
	description: "Evaluates raw sideways noise by actively counting threshold crossing touches of an EMA, striking immediately strictly when a massive 2-bar engulfing setup bursts clear out of the defined noise cluster.",
	defaultParams: {
		emaPeriod: 34,
		churnLookback: 15,
		minCrossings: 5,
	},
	paramLabels: {
		emaPeriod: "EMA Period",
		churnLookback: "Churn Lookback",
		minCrossings: "Min Crossings",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const emaLen = Number(params.emaPeriod ?? 34);
		const churnLookback = Number(params.churnLookback ?? 15);
		const minCrossings = Number(params.minCrossings ?? 5);

		if (cleanData.length < Math.max(emaLen, churnLookback)) return [];

		const ema = calculateEMA(cleanData.map(d => d.close), emaLen);

        const crossings = cleanData.map((d, i) => {
            if (i === 0 || ema[i] === null || ema[i-1] === null) return false;
            const prevAbove = cleanData[i-1].close > ema[i-1]!;
            const currAbove = d.close > ema[i]!;
            return prevAbove !== currAbove;
        });

        const crossingCounts = buildThresholdCrossingCount(crossings, churnLookback);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || ema[i] === null || ema[i-1] === null) return null;

            const emaCurrent = ema[i]!;
            const emaPrev = ema[i-1]!;

            const isIntertwined = (cleanData[i-1].low < emaPrev && cleanData[i-1].high > emaPrev);
            
            // Engulfs Bar(i-1) geometry
            const isBullEngulf = cleanData[i].low < cleanData[i-1].low && cleanData[i].high > cleanData[i-1].high && cleanData[i].close > cleanData[i-1].high;
            const closesAbove = cleanData[i].close > emaCurrent;

            if (crossingCounts[i-1] >= minCrossings && isIntertwined && isBullEngulf && closesAbove) {
                return createBuySignal(cleanData, i, "EMA churn cluster resolved via bullish engulf");
            }

            const isBearEngulf = cleanData[i].high > cleanData[i-1].high && cleanData[i].low < cleanData[i-1].low && cleanData[i].close < cleanData[i-1].low;
            const closesBelow = cleanData[i].close < emaCurrent;

            if (crossingCounts[i-1] >= minCrossings && isIntertwined && isBearEngulf && closesBelow) {
                return createSellSignal(cleanData, i, "EMA churn cluster resolved via bearish engulf");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["emaPeriod", "churnLookback", "minCrossings"],
	},
};
