import { debugLogger } from "./debug-logger";

export interface AppTimingSnapshot {
    bootstrapStart: number;
    bootstrapReady: number;
    bootstrapTotalMs: number;
    manifestLoadStart: number;
    manifestLoadEnd: number;
    manifestLoadMs: number;
    dataLoadStart: number;
    dataLoadEnd: number;
    dataLoadMs: number;
    firstBacktestStart: number;
    firstBacktestEnd: number;
    firstBacktestMs: number;
}

type TimingMark =
    | "bootstrapStart"
    | "bootstrapReady"
    | "manifestLoadStart"
    | "manifestLoadEnd"
    | "dataLoadStart"
    | "dataLoadEnd"
    | "firstBacktestStart"
    | "firstBacktestEnd";

const marks = new Map<TimingMark, number>();

export function markAppTiming(name: TimingMark): void {
    marks.set(name, performance.now());
}

export function getMark(name: TimingMark): number | undefined {
    return marks.get(name);
}

export function getAppTimingSnapshot(): AppTimingSnapshot | null {
    const bootstrapStart = marks.get("bootstrapStart");
    const bootstrapReady = marks.get("bootstrapReady");
    const manifestLoadStart = marks.get("manifestLoadStart");
    const manifestLoadEnd = marks.get("manifestLoadEnd");
    const dataLoadStart = marks.get("dataLoadStart");
    const dataLoadEnd = marks.get("dataLoadEnd");
    const firstBacktestStart = marks.get("firstBacktestStart");
    const firstBacktestEnd = marks.get("firstBacktestEnd");

    if (bootstrapStart === undefined || bootstrapReady === undefined) {
        return null;
    }

    return {
        bootstrapStart,
        bootstrapReady,
        bootstrapTotalMs: bootstrapReady - bootstrapStart,
        manifestLoadStart: manifestLoadStart ?? 0,
        manifestLoadEnd: manifestLoadEnd ?? 0,
        manifestLoadMs: manifestLoadStart !== undefined && manifestLoadEnd !== undefined
            ? manifestLoadEnd - manifestLoadStart
            : 0,
        dataLoadStart: dataLoadStart ?? 0,
        dataLoadEnd: dataLoadEnd ?? 0,
        dataLoadMs: dataLoadStart !== undefined && dataLoadEnd !== undefined
            ? dataLoadEnd - dataLoadStart
            : 0,
        firstBacktestStart: firstBacktestStart ?? 0,
        firstBacktestEnd: firstBacktestEnd ?? 0,
        firstBacktestMs: firstBacktestStart !== undefined && firstBacktestEnd !== undefined
            ? firstBacktestEnd - firstBacktestStart
            : 0,
    };
}

export function logAppTimingSnapshot(): void {
    const snapshot = getAppTimingSnapshot();
    if (snapshot) {
        debugLogger.event("app.timing.snapshot", snapshot);
    }
}

export function resetAppTiming(): void {
    marks.clear();
}
