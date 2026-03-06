import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData } from "../strategy-helpers";

function bodyDirection(bar: OHLCVData): number {
    if (bar.close > bar.open) return 1;
    if (bar.close < bar.open) return -1;
    return 0;
}

export const intrabar_polarity_reversal_count: Strategy = {
    name: "Intrabar Polarity Reversal Count",
    description: "Combines polarity flip frequency with net directional bar count to detect persistent directional regimes.",
    defaultParams: {
        lookback: 8,
        maxFlips: 2,
        minNetBias: 5,
    },
    paramLabels: {
        lookback: "Polarity Window (bars)",
        maxFlips: "Max Allowed Flips",
        minNetBias: "Min Net Directional Bars",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 8));
        const maxFlips = Math.max(0, Math.round(params.maxFlips ?? 2));
        const minNetBias = Math.max(1, Math.min(lookback, Math.round(params.minNetBias ?? 5)));
        const polarity = cleanData.map(bodyDirection);
        const signals: Signal[] = [];

        for (let i = lookback - 1; i < cleanData.length; i++) {
            const start = i - lookback + 1;
            let flips = 0;
            let bullishBars = 0;
            let bearishBars = 0;
            let lastNonFlatPolarity = 0;

            for (let j = start; j <= i; j++) {
                const p = polarity[j];
                if (p > 0) bullishBars++;
                if (p < 0) bearishBars++;

                if (p !== 0) {
                    if (lastNonFlatPolarity !== 0 && p !== lastNonFlatPolarity) {
                        flips++;
                    }
                    lastNonFlatPolarity = p;
                }
            }

            if (flips > maxFlips) continue;

            if (bullishBars >= minNetBias) {
                signals.push(createBuySignal(cleanData, i, "Low-flip bullish polarity persistence"));
            } else if (bearishBars >= minNetBias) {
                signals.push(createSellSignal(cleanData, i, "Low-flip bearish polarity persistence"));
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxFlips", "minNetBias"],
    },
};
