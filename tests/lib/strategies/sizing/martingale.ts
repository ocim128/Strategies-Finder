import { ADVANCED_SIZING_DEFAULTS } from "../../advanced-sizing-settings";
import type { AdvancedSizingSettings } from "../../types/backtest";
import { clamp } from "./shared";

export interface MartingaleState {
    currentSequence: number;
    consecutiveLosses: number;
    consecutiveWins: number;
}

export interface MartingaleTradeResult {
    pnl: number;
    isWin: boolean;
}

export function createMartingaleState(): MartingaleState {
    return {
        currentSequence: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
    };
}

export function resolveMartingaleMultiplier(
    state: MartingaleState | undefined,
    settings: AdvancedSizingSettings | undefined
): number {
    const currentSequence = state?.currentSequence ?? 0;
    const multiplier = settings?.martingaleMultiplier ?? ADVANCED_SIZING_DEFAULTS.martingaleMultiplier;
    return clamp(multiplier ** currentSequence, 1, 16);
}

export function updateMartingaleState(
    state: MartingaleState,
    tradeResult: MartingaleTradeResult,
    settings: AdvancedSizingSettings | undefined,
    antiMartingale: boolean
): MartingaleState {
    const maxSequence = settings?.martingaleMaxSequence ?? ADVANCED_SIZING_DEFAULTS.martingaleMaxSequence;
    const resetOnWin = settings?.martingaleResetOnWin ?? ADVANCED_SIZING_DEFAULTS.martingaleResetOnWin;
    const resetOnLoss = settings?.martingaleResetOnLoss ?? ADVANCED_SIZING_DEFAULTS.martingaleResetOnLoss;

    if (tradeResult.isWin) {
        state.consecutiveWins += 1;
        state.consecutiveLosses = 0;
        if (antiMartingale) {
            state.currentSequence = Math.min(maxSequence, state.currentSequence + 1);
        } else if (resetOnWin) {
            state.currentSequence = 0;
        }
    } else {
        state.consecutiveLosses += 1;
        state.consecutiveWins = 0;
        if (antiMartingale) {
            if (resetOnLoss || antiMartingale) {
                state.currentSequence = 0;
            }
        } else {
            if (resetOnLoss) {
                state.currentSequence = 0;
            } else {
                state.currentSequence = Math.min(maxSequence, state.currentSequence + 1);
            }
        }
    }

    return state;
}
