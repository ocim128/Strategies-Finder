import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateSMA } from "../indicators";

type PositionState = "flat" | "long" | "short";

function clampInteger(value: number, min: number, max: number): number {
    const rounded = Math.round(value);
    if (!Number.isFinite(rounded)) return min;
    return Math.max(min, Math.min(max, rounded));
}

function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

export const hypothesis_trend_persistence: Strategy = {
    name: "Hypothesis: Trend Persistence",
    description: "Minimal template. Tests whether consecutive closes beyond a trend baseline persist long enough to be tradable.",
    defaultParams: {
        trendLookback: 60,
        persistenceBars: 3,
        entryBufferPct: 0.001,
        exitBufferPct: 0.0,
        allowShorts: 1,
    },
    paramLabels: {
        trendLookback: "Trend SMA Lookback",
        persistenceBars: "Persistence Bars",
        entryBufferPct: "Entry Buffer (pct)",
        exitBufferPct: "Exit Buffer (pct)",
        allowShorts: "Allow Shorts (1/0)",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const trendLookback = clampInteger(params.trendLookback ?? 60, 5, 400);
        const persistenceBars = clampInteger(params.persistenceBars ?? 3, 2, 20);
        const entryBufferPct = clampNumber(params.entryBufferPct ?? 0.001, 0, 0.05);
        const exitBufferPct = clampNumber(params.exitBufferPct ?? 0, 0, 0.05);
        const allowShorts = (params.allowShorts ?? 1) >= 0.5;

        const closes = getCloses(cleanData);
        const trendSma = calculateSMA(closes, trendLookback);
        const warmup = Math.max(trendLookback, persistenceBars + 1);

        const isPersistentAbove = (index: number): boolean => {
            for (let j = 0; j < persistenceBars; j++) {
                const idx = index - j;
                const baseline = trendSma[idx];
                if (baseline === null) return false;
                if (closes[idx] <= baseline * (1 + entryBufferPct)) return false;
            }
            return true;
        };

        const isPersistentBelow = (index: number): boolean => {
            for (let j = 0; j < persistenceBars; j++) {
                const idx = index - j;
                const baseline = trendSma[idx];
                if (baseline === null) return false;
                if (closes[idx] >= baseline * (1 - entryBufferPct)) return false;
            }
            return true;
        };

        let position: PositionState = "flat";

        return createSignalLoop(cleanData, [trendSma], (i) => {
            if (i < warmup) return null;

            const baseline = trendSma[i];
            if (baseline === null) return null;

            const bullPersistent = isPersistentAbove(i);
            const bearPersistent = isPersistentBelow(i);
            const close = closes[i];

            if (position === "flat") {
                if (bullPersistent) {
                    position = "long";
                    return createBuySignal(cleanData, i, "Trend Persistence Long");
                }
                if (allowShorts && bearPersistent) {
                    position = "short";
                    return createSellSignal(cleanData, i, "Trend Persistence Short");
                }
                return null;
            }

            if (position === "long") {
                if (bearPersistent) {
                    position = allowShorts ? "short" : "flat";
                    return createSellSignal(cleanData, i, allowShorts ? "Trend Flip Short" : "Trend Exit Long");
                }
                if (close < baseline * (1 - exitBufferPct)) {
                    position = "flat";
                    return createSellSignal(cleanData, i, "Trend Break Exit Long");
                }
                return null;
            }

            if (bullPersistent) {
                position = "long";
                return createBuySignal(cleanData, i, "Trend Flip Long");
            }
            if (close > baseline * (1 + exitBufferPct)) {
                position = "flat";
                return createBuySignal(cleanData, i, "Trend Break Exit Short");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["trendLookback", "persistenceBars", "entryBufferPct", "exitBufferPct"],
    },
};
