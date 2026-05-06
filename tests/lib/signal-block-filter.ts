import type { Signal } from "./types/strategies";
import { parseTimeToUnixSeconds } from "./time-normalization";

export type SignalBlockRange = { from: number; to: number } | null;

export function filterSignalsByBlockRange<T extends { time: Signal["time"] }>(
    signals: T[],
    blockRange: SignalBlockRange
): T[] {
    if (!blockRange || blockRange.from === blockRange.to) {
        return signals;
    }

    return signals.filter((signal) => {
        const time = parseTimeToUnixSeconds(signal.time);
        return time !== null && time >= blockRange.from && time <= blockRange.to;
    });
}
