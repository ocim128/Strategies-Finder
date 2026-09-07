import type {
    PairFeatureEvaluationResult,
    PairFeatureSnapshotBar,
} from "../types";

const LOOKBACK_BARS = 12;
const REQUIRED_CLOSES = LOOKBACK_BARS + 1;

/** Strictly-before log return over the fixed v0 twelve-bar spread window. */
export function computeSpreadLogReturn(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
): PairFeatureEvaluationResult {
    let observations = 0;
    let complete = true;
    for (let index = signalBarIndex - REQUIRED_CLOSES; index < signalBarIndex; index += 1) {
        const close = index >= 0 && index < bars.length ? bars[index]![4] : null;
        if (typeof close === "number" && Number.isFinite(close) && close > 0) observations += 1;
        else complete = false;
    }
    observations = Math.min(observations, REQUIRED_CLOSES);
    if (!complete) return { value: null, observations };

    const firstClose = bars[signalBarIndex - REQUIRED_CLOSES]![4];
    const lastClose = bars[signalBarIndex - 1]![4];
    const value = Math.log(lastClose) - Math.log(firstClose);
    return { value: Object.is(value, -0) ? 0 : value, observations };
}
