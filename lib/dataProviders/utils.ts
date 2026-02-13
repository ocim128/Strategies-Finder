import { getIntervalSecondsOrDefault } from "../interval-utils";

export function getIntervalSeconds(interval: string): number {
    return getIntervalSecondsOrDefault(interval, 0);
}

export async function wait(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
}
