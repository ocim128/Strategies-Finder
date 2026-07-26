import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateKlingerOscillator } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        signalPeriod: Math.max(2, Math.round(Number(params.signalPeriod ?? 13))),
    };
}

export const klinger_oscillator_confirmation: Strategy = {
    name: "Klinger Oscillator Confirmation",
    description: "Signals from the current standard 34/55 Klinger oscillator relative to its causal signal EMA.",
    defaultParams: {
        signalPeriod: 13,
    },
    paramLabels: {
        signalPeriod: "Klinger Signal Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const signalPeriod = normalizeParams(params).signalPeriod as number;
        const klinger = calculateKlingerOscillator(cleanData, signalPeriod);
        return createCurrentBarSignalLoop(cleanData, [klinger.oscillator, klinger.signal], (i) => {
            if (klinger.oscillator[i]! > klinger.signal[i]!) {
                return createBuySignal(cleanData, i, "Klinger oscillator above signal line");
            }
            if (klinger.oscillator[i]! < klinger.signal[i]!) {
                return createSellSignal(cleanData, i, "Klinger oscillator below signal line");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["signalPeriod"],
    },
};
