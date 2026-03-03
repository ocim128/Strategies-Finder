import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateATR, calculateVWAP } from "../indicators";

const MIN_ATR_RATIO = 0.0001;

export const vwap_reclaim_sniper: Strategy = {
    name: "VWAP Reclaim Sniper",
    description: "Enters when price reclaims VWAP after sustained displacement with strong close location and minimum volatility.",
    defaultParams: {
        consolidationBars: 5,
        reclaimStrength: 0.6,
        atrFilterPeriod: 14,
    },
    paramLabels: {
        consolidationBars: "Min Bars Below/Above VWAP",
        reclaimStrength: "Close Position in Bar (0-1)",
        atrFilterPeriod: "ATR Period (vol gate)",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const consolidationBars = Math.max(2, Math.round(params.consolidationBars ?? 5));
        const reclaimStrength = Math.max(0, Math.min(1, params.reclaimStrength ?? 0.6));
        const atrFilterPeriod = Math.max(3, Math.round(params.atrFilterPeriod ?? 14));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const vwap = calculateVWAP(cleanData);
        const atr = calculateATR(highs, lows, closes, atrFilterPeriod);

        const signals: Signal[] = [];
        let belowVwapCount = 0;
        let aboveVwapCount = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const vwapNow = vwap[i];
            const atrNow = atr[i];
            if (vwapNow === null || atrNow === null) continue;
            if (closes[i] <= 0 || atrNow / closes[i] < MIN_ATR_RATIO) continue;

            const barRange = highs[i] - lows[i];
            if (barRange <= 0) continue;

            const priorBelow = belowVwapCount;
            const priorAbove = aboveVwapCount;

            const bullishClosePosition = (closes[i] - lows[i]) / barRange;
            const bearishClosePosition = (highs[i] - closes[i]) / barRange;

            if (
                priorBelow >= consolidationBars &&
                closes[i] > vwapNow &&
                bullishClosePosition >= reclaimStrength
            ) {
                signals.push(createBuySignal(cleanData, i, "VWAP reclaim long"));
            } else if (
                priorAbove >= consolidationBars &&
                closes[i] < vwapNow &&
                bearishClosePosition >= reclaimStrength
            ) {
                signals.push(createSellSignal(cleanData, i, "VWAP reclaim short"));
            }

            if (closes[i] < vwapNow) {
                belowVwapCount++;
                aboveVwapCount = 0;
            } else if (closes[i] > vwapNow) {
                aboveVwapCount++;
                belowVwapCount = 0;
            } else {
                aboveVwapCount = 0;
                belowVwapCount = 0;
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["consolidationBars", "reclaimStrength", "atrFilterPeriod"],
    },
};

