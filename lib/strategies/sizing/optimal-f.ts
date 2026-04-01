import { ADVANCED_SIZING_DEFAULTS } from "../../advanced-sizing-settings";
import type { AdvancedSizingSettings } from "../../types/backtest";
import { clamp, percentile } from "./shared";

export interface OptimalFState {
    tradeHistory: number[];
    calculatedOptimalF: number | null;
    calculatedSecureF: number | null;
}

export interface OptimalFResult {
    optimalF: number;
    secureF: number;
    appliedFraction: number;
    isValid: boolean;
}

export function createOptimalFState(): OptimalFState {
    return {
        tradeHistory: [],
        calculatedOptimalF: null,
        calculatedSecureF: null,
    };
}

function computeTwr(trades: number[], maxLoss: number, fraction: number): number {
    let product = 1;
    for (const trade of trades) {
        const holdingPeriodReturn = 1 + (fraction * (trade / maxLoss));
        if (!Number.isFinite(holdingPeriodReturn) || holdingPeriodReturn <= 0) {
            return -Infinity;
        }
        product *= holdingPeriodReturn;
    }
    return product;
}

export function calculateOptimalF(trades: number[]): number {
    const losses = trades.filter((trade) => trade < 0).map((trade) => Math.abs(trade));
    const maxLoss = losses.length > 0 ? Math.max(...losses) : 0;
    if (maxLoss <= 0 || trades.length < 5) {
        return 0;
    }

    let bestF = 0;
    let bestTwr = -Infinity;
    for (let step = 1; step <= 100; step++) {
        const candidate = step / 100;
        const twr = computeTwr(trades, maxLoss, candidate);
        if (twr > bestTwr) {
            bestTwr = twr;
            bestF = candidate;
        }
    }
    return clamp(bestF, 0, 0.5);
}

function createBootstrapSequence(length: number, seed: number): number[] {
    let state = seed >>> 0;
    const indexes: number[] = [];
    for (let i = 0; i < length; i++) {
        state = (1664525 * state + 1013904223) >>> 0;
        indexes.push(state);
    }
    return indexes;
}

export function calculateSecureF(trades: number[], settings?: AdvancedSizingSettings): OptimalFResult {
    const optimalF = calculateOptimalF(trades);
    if (optimalF <= 0) {
        return { optimalF: 0, secureF: 0, appliedFraction: 0, isValid: false };
    }

    const method = settings?.secureFMethod ?? ADVANCED_SIZING_DEFAULTS.secureFMethod;
    let secureF = optimalF;

    if (method === "bootstrap") {
        const samples = Math.max(10, Math.min(500, settings?.optimalFBootstrapSamples ?? ADVANCED_SIZING_DEFAULTS.optimalFBootstrapSamples));
        const bootstrapFs: number[] = [];
        for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
            const sequence = createBootstrapSequence(trades.length, sampleIndex + 1);
            const resampled = sequence.map((value) => trades[value % trades.length]);
            bootstrapFs.push(calculateOptimalF(resampled));
        }
        const tailProbability = 1 - (settings?.secureFConfidence ?? ADVANCED_SIZING_DEFAULTS.secureFConfidence);
        secureF = percentile(bootstrapFs, tailProbability);
    } else {
        const confidence = settings?.secureFConfidence ?? ADVANCED_SIZING_DEFAULTS.secureFConfidence;
        const samplePenalty = Math.sqrt(Math.max(1, trades.length) / (Math.max(1, trades.length) + 20));
        secureF = optimalF * confidence * samplePenalty;
    }

    secureF = clamp(secureF, 0, optimalF);
    return {
        optimalF,
        secureF,
        appliedFraction: secureF,
        isValid: secureF > 0,
    };
}

export function updateOptimalFState(
    state: OptimalFState,
    pnl: number,
    settings?: AdvancedSizingSettings
): OptimalFState {
    state.tradeHistory.push(pnl);
    const maxLookback = settings?.optimalFLookback ?? ADVANCED_SIZING_DEFAULTS.optimalFLookback;
    if (state.tradeHistory.length > maxLookback) {
        state.tradeHistory.shift();
    }

    const result = calculateSecureF(state.tradeHistory, settings);
    state.calculatedOptimalF = result.optimalF;
    state.calculatedSecureF = result.secureF;
    return state;
}
