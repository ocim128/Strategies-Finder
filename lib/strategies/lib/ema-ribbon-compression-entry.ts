import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateEMA } from "../indicators";

export const ema_ribbon_compression_entry: Strategy = {
    name: "EMA Ribbon Compression Entry",
    description: "Arms during 3-EMA ribbon compression and enters on the first fast/slow directional expansion cross.",
    defaultParams: {
        fastEma: 8,
        slowEma: 34,
        compressionPct: 0.003,
    },
    paramLabels: {
        fastEma: "Fast EMA Period",
        slowEma: "Slow EMA Period",
        compressionPct: "Max Ribbon Width (%)",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 5) return [];

        const fastEma = Math.max(2, Math.round(params.fastEma ?? 8));
        const slowEma = Math.max(fastEma + 1, Math.round(params.slowEma ?? 34));
        const compressionPct = Math.max(0, params.compressionPct ?? 0.003);
        const midEma = Math.max(fastEma + 1, Math.min(slowEma - 1, Math.round((fastEma + slowEma) / 2)));

        const closes = getCloses(cleanData);
        const fast = calculateEMA(closes, fastEma);
        const mid = calculateEMA(closes, midEma);
        const slow = calculateEMA(closes, slowEma);

        const signals: Signal[] = [];
        let compressionArmed = false;

        for (let i = 1; i < cleanData.length; i++) {
            const f = fast[i];
            const m = mid[i];
            const s = slow[i];
            const prevF = fast[i - 1];
            const prevS = slow[i - 1];
            const close = closes[i];
            if (
                f === null ||
                m === null ||
                s === null ||
                prevF === null ||
                prevS === null ||
                close <= 0
            ) {
                continue;
            }

            const ribbonMax = Math.max(f, m, s);
            const ribbonMin = Math.min(f, m, s);
            const ribbonWidth = (ribbonMax - ribbonMin) / close;

            if (ribbonWidth <= compressionPct) {
                compressionArmed = true;
                continue;
            }

            if (!compressionArmed) continue;

            if (prevF <= prevS && f > s) {
                signals.push(createBuySignal(cleanData, i, "EMA ribbon expansion long"));
                compressionArmed = false;
                continue;
            }

            if (prevF >= prevS && f < s) {
                signals.push(createSellSignal(cleanData, i, "EMA ribbon expansion short"));
                compressionArmed = false;
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastEma", "slowEma", "compressionPct"],
    },
};

