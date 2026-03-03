import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { calculateSMA } from "../indicators";

export const volume_dry_up_reversal: Strategy = {
    name: "Volume Dry-Up Reversal",
    description: "Flags volume exhaustion and enters on the first directional volume-recovery bar.",
    defaultParams: {
        volumeLookback: 20,
        dryUpRatio: 0.3,
        recoveryMultiplier: 1.2,
    },
    paramLabels: {
        volumeLookback: "Volume MA Lookback",
        dryUpRatio: "Dry-Up Threshold (ratio)",
        recoveryMultiplier: "Volume Recovery Multiple",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 3) return [];

        const volumeLookback = Math.max(5, Math.round(params.volumeLookback ?? 20));
        const dryUpRatio = Math.max(0.05, Math.min(0.95, params.dryUpRatio ?? 0.3));
        const recoveryMultiplier = Math.max(1, params.recoveryMultiplier ?? 1.2);

        const volumes = getVolumes(cleanData);
        const closes = getCloses(cleanData);
        const volumeSma = calculateSMA(volumes, volumeLookback);

        const signals: Signal[] = [];
        let waitingForRecovery = false;

        for (let i = 1; i < cleanData.length; i++) {
            const sma = volumeSma[i];
            if (sma === null || sma <= 0) continue;

            const isDryUp = volumes[i] < sma * dryUpRatio;
            if (isDryUp) {
                waitingForRecovery = true;
                continue;
            }

            if (!waitingForRecovery) continue;

            const isRecovered = volumes[i] > sma * recoveryMultiplier;
            if (!isRecovered) continue;

            if (closes[i] > cleanData[i].open) {
                signals.push(createBuySignal(cleanData, i, "Volume dry-up long recovery"));
                waitingForRecovery = false;
                continue;
            }

            if (closes[i] < cleanData[i].open) {
                signals.push(createSellSignal(cleanData, i, "Volume dry-up short recovery"));
                waitingForRecovery = false;
                continue;
            }

            waitingForRecovery = false;
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volumeLookback", "dryUpRatio", "recoveryMultiplier"],
    },
};

