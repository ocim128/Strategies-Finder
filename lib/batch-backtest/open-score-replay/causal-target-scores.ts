import type { OHLCVData } from "../../types/strategies";
import { timeToNumber } from "../../strategies/backtest/backtest-utils";
import { parseIntervalSeconds } from "../../interval-utils";
import { selectClosedCandleWindow } from "../../alert-evaluation-window";
import { findCandleGaps, DEFAULT_CANDLE_GAP_THRESHOLD_DAYS } from "../../ibkr-data/candle-gap";
import { FINDER_CAUSAL_ARMS_V1 as DEFINITIONS } from "./causal-arm-constants";
import { insertRankingPick, RANKING_ARM_SPECS } from "./candidate-selection";
import type { DecisionEvent } from "./internal-types";
import type { RunOpenScoreUsdReplayOptions, CausalArmDiagnostics } from "./types";
import { yieldLoop } from "./runtime";

/** Normalize once per dataset. Invalid timestamps stop the trusted prefix. */
export function prepareCausalPriceHistory(data: readonly OHLCVData[], interval: string, cutoff: number) {
    const normalized: OHLCVData[] = [];
    let previous = -Infinity, invalidAfter: number | undefined;
    for (const candle of data) {
        const time = timeToNumber(candle.time);
        if (time === null || !Number.isFinite(time) || time <= previous) { invalidAfter = previous; break; }
        normalized.push({ ...candle, time: time as OHLCVData["time"] }); previous = time;
        if (time > cutoff) break;
    }
    const closed = selectClosedCandleWindow(normalized, interval, cutoff, 1)?.candles ?? [];
    const times = closed.map((candle) => timeToNumber(candle.time)!);
    return { data: closed, times, gaps: findCandleGaps(closed), invalidAfter };
}

export function causalPriceScore(history: ReturnType<typeof prepareCausalPriceHistory>, decisionSec: number, barSeconds: number): { score?: number; reason?: keyof NonNullable<CausalArmDiagnostics["priceUnavailableReasons"]> } {
    if (history.invalidAfter !== undefined && decisionSec >= history.invalidAfter + barSeconds) return { reason: "invalid_timestamp" };
    let lo = 0, hi = history.times.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (history.times[mid]! + barSeconds <= decisionSec) lo = mid + 1; else hi = mid; }
    const last = lo - 1, first = last - DEFINITIONS.priceReturns;
    if (first < 0) return { reason: "insufficient_history" };
    // Reuse the existing calendar policy: ordinary market closures are allowed.
    if (decisionSec - (history.times[last]! + barSeconds) > DEFAULT_CANDLE_GAP_THRESHOLD_DAYS * 86400) return { reason: "stale_history" };
    if (history.gaps.some((gap) => gap.to > history.times[first]! && gap.from < history.times[last]!)) return { reason: "data_gap" };
    let sum = 0, squares = 0;
    const returns: number[] = [];
    for (let i = first; i <= last; i++) {
        const close = history.data[i]!.close;
        if (!(close > 0) || !Number.isFinite(close)) return { reason: "invalid_price" };
        if (i > first) { const r = Math.log(close / history.data[i - 1]!.close); if (!Number.isFinite(r)) return { reason: "invalid_price" }; returns.push(r); sum += r; }
    }
    const mean = sum / DEFINITIONS.priceReturns;
    for (const r of returns) squares += (r - mean) ** 2;
    const score = sum / (Math.sqrt(DEFINITIONS.priceReturns) * Math.max(Math.sqrt(squares / DEFINITIONS.priceReturns), DEFINITIONS.volatilityFloor));
    return Number.isFinite(score) ? { score } : { reason: "invalid_price" };
}

export function causalPriceStrength(history: ReturnType<typeof prepareCausalPriceHistory>, decisionSec: number, barSeconds: number): number | undefined {
    return causalPriceScore(history, decisionSec, barSeconds).score;
}

/** One asset at a time; switch records retain only five keys and an eligible count. */
export async function addCausalPriceScores(events: readonly DecisionEvent[], names: readonly string[], options: RunOpenScoreUsdReplayOptions,
    diagnostics: CausalArmDiagnostics): Promise<Set<string>> {
    if (!options.loadTargetDataset) throw new Error("Causal price scoring requires the Finder lazy target loader.");
    const barSeconds = parseIntervalSeconds(options.interval ?? "");
    if (!barSeconds) throw new Error("Causal price scoring requires a valid interval.");
    const missing = new Set<string>();
    const assets = names.map((name, index) => ({ name, index })).filter(({ index }) => events.some((event) => event.rawScore[index]! > 0));
    options.prefetchTargetDatasets?.(assets.map(({ name }) => name)); // Coordinator owns the bounded prefetch queue.
    const check = (): void => { if (options.shouldStop?.()) throw new Error("OPEN_SCORE USD replay cancelled during causal price loading."); };
    const spec = RANKING_ARM_SPECS.find((spec) => spec.field === "topPriceStrength")!;
    for (let i = 0; i < assets.length; i++) {
        check();
        const { name, index } = assets[i]!;
        const data: OHLCVData[] | null = await options.loadTargetDataset(name); check();
        if (data === null) missing.add(name);
        const history = prepareCausalPriceHistory(data ?? [], options.interval!, options.evaluationCutoffSec!);
        for (let e = 0; e < events.length; e++) {
            if (e % 2000 === 0) { await yieldLoop(); check(); }
            const event = events[e]!;
            if (event.rawScore[index]! <= 0) continue;
            const result = causalPriceScore(history, event.timeSec, barSeconds), score = result.score;
            if (score === undefined) {
                diagnostics.unavailablePriceHistory++;
                const reason = data === null ? "missing_target" : result.reason!;
                const reasons = diagnostics.priceUnavailableReasons ??= {};
                reasons[reason] = (reasons[reason] ?? 0) + 1;
                continue;
            }
            diagnostics.eligibleCandidates.topPriceStrength = (diagnostics.eligibleCandidates.topPriceStrength ?? 0) + 1;
            if (event.causalScores) event.causalScores.get(index)!.topPriceStrength = score;
            else {
                const row = event.causalArms!.topPriceStrength!; row.eligibleCount++;
                insertRankingPick(row.picks, { assetIndex: index, raw: event.rawScore[index]!, adjusted: 0, mean: 0, activePairs: event.activePairCount[index]!, topPriceStrength: score }, spec, event.timeSec, names);
            }
        }
        options.onPhase?.("targets", `causal price history ${i + 1}/${assets.length}`, i + 1, assets.length);
        await yieldLoop(); check();
    }
    return missing;
}
