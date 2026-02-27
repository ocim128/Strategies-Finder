import type { Time } from "lightweight-charts";
import { parseTimeToUnixSeconds } from "./time-normalization";

export type TwoHourParity = "odd" | "even";

function twoHourRemainder(seconds: number): number {
    return ((seconds % 7200) + 7200) % 7200;
}

export function resolveTwoHourParityFromTime(time: Time | unknown): TwoHourParity | null {
    const seconds = parseTimeToUnixSeconds(time);
    if (seconds === null) return null;
    return twoHourRemainder(seconds) === 3600 ? "even" : "odd";
}

export function isTwoHourParityAligned(
    candles: Array<{ time: Time | unknown }>,
    parity: TwoHourParity
): boolean {
    if (candles.length === 0) return true;
    const firstParity = resolveTwoHourParityFromTime(candles[0].time);
    if (firstParity === null) return false;
    return firstParity === parity;
}
