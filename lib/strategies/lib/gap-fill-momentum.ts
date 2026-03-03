import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";

type GapDirection = "fill_down" | "fill_up";

export const gap_fill_momentum: Strategy = {
    name: "Gap Fill Momentum",
    description: "Detects bounded bar gaps and enters in the gap-fill direction after directional close confirmation.",
    defaultParams: {
        minGapPct: 0.005,
        maxGapPct: 0.03,
        confirmBars: 2,
    },
    paramLabels: {
        minGapPct: "Min Gap Size (%)",
        maxGapPct: "Max Gap Size (%)",
        confirmBars: "Confirmation Bars",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const minGapPct = Math.max(0.0001, params.minGapPct ?? 0.005);
        const maxGapPct = Math.max(minGapPct, params.maxGapPct ?? 0.03);
        const confirmBars = Math.max(1, Math.round(params.confirmBars ?? 2));

        const closes = getCloses(cleanData);
        const signals: Signal[] = [];

        let pendingGap: GapDirection | null = null;
        let confirmCount = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const prevClose = closes[i - 1];
            const open = cleanData[i].open;
            if (prevClose <= 0) continue;

            const gapPct = (open - prevClose) / prevClose;
            const absGapPct = Math.abs(gapPct);
            const isGapInRange = absGapPct >= minGapPct && absGapPct <= maxGapPct;

            if (isGapInRange) {
                pendingGap = gapPct > 0 ? "fill_down" : "fill_up";
                confirmCount = 0;
            }

            if (!pendingGap) continue;
            if (i < 1) continue;

            if (pendingGap === "fill_down") {
                if (closes[i] < closes[i - 1]) {
                    confirmCount++;
                    if (confirmCount >= confirmBars) {
                        signals.push(createSellSignal(cleanData, i, "Gap-up fill momentum short"));
                        pendingGap = null;
                        confirmCount = 0;
                    }
                } else {
                    pendingGap = null;
                    confirmCount = 0;
                }
                continue;
            }

            if (closes[i] > closes[i - 1]) {
                confirmCount++;
                if (confirmCount >= confirmBars) {
                    signals.push(createBuySignal(cleanData, i, "Gap-down fill momentum long"));
                    pendingGap = null;
                    confirmCount = 0;
                }
            } else {
                pendingGap = null;
                confirmCount = 0;
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["minGapPct", "maxGapPct", "confirmBars"],
    },
};

