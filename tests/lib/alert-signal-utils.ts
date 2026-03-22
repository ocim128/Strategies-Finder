import type { BacktestSettings } from "./types/strategies";
import { applySlippage, entrySideForDirection } from "./strategies/backtest/backtest-utils";
import { toFiniteNumber } from "./settings-parse-utils";

export const PENDING_ENTRY_SIGNAL_REASON = "pending_entry";

interface AlertSignalReasonLike {
    signal_reason?: string | null;
}

interface AlertSignalPayloadLike {
    payload_json?: string | null;
}

interface AlertSignalPriceLike extends AlertSignalPayloadLike {
    direction: "long" | "short";
    signal_price: number;
}

function toSlippageRate(backtestSettings?: Pick<BacktestSettings, "slippageBps">): number {
    const slippageBps = toFiniteNumber(backtestSettings?.slippageBps);
    return slippageBps !== null && slippageBps > 0 ? slippageBps / 10000 : 0;
}

export function parseAlertSignalPayload(signal: AlertSignalPayloadLike | null | undefined): Record<string, unknown> {
    if (!signal?.payload_json) return {};

    try {
        const parsed = JSON.parse(signal.payload_json);
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

export function getPersistedAlertSignalEntryPrice(
    signal: AlertSignalPayloadLike | null | undefined
): number | null {
    const payload = parseAlertSignalPayload(signal);
    const entryPrice = toFiniteNumber(payload.entryPrice);
    return entryPrice !== null && entryPrice > 0 ? entryPrice : null;
}

export function resolveAlertSignalEntryPrice(
    signal: AlertSignalPriceLike | null | undefined,
    backtestSettings?: Pick<BacktestSettings, "slippageBps">
): number | null {
    const persistedEntryPrice = getPersistedAlertSignalEntryPrice(signal);
    if (persistedEntryPrice !== null) return persistedEntryPrice;

    const signalPrice = toFiniteNumber(signal?.signal_price);
    if (signalPrice === null || signalPrice <= 0 || !signal) return null;

    return applySlippage(
        signalPrice,
        entrySideForDirection(signal.direction),
        toSlippageRate(backtestSettings)
    );
}

export function isPendingEntrySignalReason(reason: string | null | undefined): boolean {
    return reason === PENDING_ENTRY_SIGNAL_REASON;
}

export function isActionableAlertSignal<T extends AlertSignalReasonLike>(
    signal: T | null | undefined
): signal is T {
    return signal != null && !isPendingEntrySignalReason(signal.signal_reason);
}

export function getLatestActionableAlertSignal<T extends AlertSignalReasonLike>(
    signals: T[]
): T | null {
    for (const signal of signals) {
        if (isActionableAlertSignal(signal)) {
            return signal;
        }
    }
    return null;
}
