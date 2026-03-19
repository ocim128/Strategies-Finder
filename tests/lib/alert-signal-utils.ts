export const PENDING_ENTRY_SIGNAL_REASON = "pending_entry";

interface AlertSignalReasonLike {
    signal_reason?: string | null;
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
