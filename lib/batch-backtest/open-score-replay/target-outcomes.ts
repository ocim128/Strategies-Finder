/**
 * Replay stage 4 — target outcome evaluation. Groups requested events per
 * asset, resolves each target dataset exactly once (lazy loader with a
 * caller-owned cross-window shared cache, or a drained streaming loader),
 * computes per-horizon long returns/mark-to-market from the first bar strictly
 * after each decision timestamp, and emits the Phase 0b diagnostic rows
 * (candidate outcomes, pool snapshots, EMA breadth state) through the caller's
 * sinks. Gap/censoring/missing-data accounting is preserved verbatim: gap
 * exclusion reranks pools, missing or censored outcomes omit events, and
 * cache no-data markers prevent repeat dataset loads.
 */
import { applySlippage, timeToNumber } from "../../strategies/backtest/backtest-utils";
import { findCandleGaps, type CandleGap } from "../../ibkr-data/candle-gap";
import type { OHLCVData } from "../../types/strategies";
import type {
    CandidateOutcomeRecord,
    CandidateOutcomeStatus,
    OpenScoreUsdSharedOutcomeRecord,
    OpenScoreUsdTarget,
    PoolSnapshotRecord,
    RunOpenScoreUsdReplayOptions,
} from "./types";
import type { DecisionEvent, ReplayPhaseCallback, StageOutcome } from "./internal-types";
import { yieldLoop } from "./runtime";
import { selectClosedCandleWindow } from "../../alert-evaluation-window";

const POOL_SNAPSHOT_EMA_PERIOD = 200;

/**
 * Causal target-asset EMA used by the Phase 0b pool-snapshot diagnostics
 * (ema200Above / breadth / regime). Values before the SMA seed are NaN, so an
 * asset cannot qualify without 200 fully known closes.
 */
function buildEma200(data: readonly OHLCVData[]): number[] {
    const ema = new Array<number>(data.length).fill(Number.NaN);
    if (data.length < POOL_SNAPSHOT_EMA_PERIOD) return ema;
    let seed = 0;
    for (let i = 0; i < POOL_SNAPSHOT_EMA_PERIOD; i += 1) {
        const close = data[i]!.close;
        if (!Number.isFinite(close) || close <= 0) return ema;
        seed += close;
    }
    const seedIndex = POOL_SNAPSHOT_EMA_PERIOD - 1;
    ema[seedIndex] = seed / POOL_SNAPSHOT_EMA_PERIOD;
    const alpha = 2 / (POOL_SNAPSHOT_EMA_PERIOD + 1);
    for (let i = POOL_SNAPSHOT_EMA_PERIOD; i < data.length; i += 1) {
        const close = data[i]!.close;
        if (!Number.isFinite(close) || close <= 0) continue;
        ema[i] = close * alpha + ema[i - 1]! * (1 - alpha);
    }
    return ema;
}

function phase0bEventId(interval: string | undefined, decisionTimeSec: number): string {
    return `${interval ?? ""}:${decisionTimeSec}`;
}

interface DiagnosticDirectionalOutcome {
    returnValue: number | null;
    entryTimeSec: number | null;
    exitTimeSec: number | null;
    status: CandidateOutcomeStatus;
}

function computeDiagnosticOutcome(
    data: readonly OHLCVData[],
    times: readonly (number | null)[],
    entryBar: number,
    horizonBars: number,
    direction: "long" | "short",
    slippageRate: number,
    commissionRate: number,
): DiagnosticDirectionalOutcome {
    if (entryBar < 0) {
        return { returnValue: null, entryTimeSec: null, exitTimeSec: null, status: "missing_entry" };
    }
    const entryTimeSec = Number.isFinite(times[entryBar]) ? times[entryBar] : null;
    const exitBar = entryBar + horizonBars - 1;
    if (exitBar >= data.length) {
        return { returnValue: null, entryTimeSec, exitTimeSec: null, status: "right_censored" };
    }
    const exitTimeSec = Number.isFinite(times[exitBar]) ? times[exitBar] : null;
    const rawOpen = data[entryBar]?.open;
    const exitClose = data[exitBar]?.close;
    if (
        !Number.isFinite(rawOpen)
        || rawOpen <= 0
        || !Number.isFinite(exitClose)
        || exitClose <= 0
    ) {
        return { returnValue: null, entryTimeSec, exitTimeSec, status: "invalid_price" };
    }
    if (direction === "long") {
        const entryPrice = applySlippage(rawOpen, "buy", slippageRate);
        const exitPrice = applySlippage(exitClose, "sell", slippageRate);
        const fees = (entryPrice + exitPrice) * commissionRate;
        const returnValue = (exitPrice - entryPrice - fees) / entryPrice;
        return Number.isFinite(returnValue)
            ? { returnValue, entryTimeSec, exitTimeSec, status: "ok" }
            : { returnValue: null, entryTimeSec, exitTimeSec, status: "invalid_price" };
    }
    const entryPrice = applySlippage(rawOpen, "sell", slippageRate);
    const exitPrice = applySlippage(exitClose, "buy", slippageRate);
    const fees = (entryPrice + exitPrice) * commissionRate;
    const returnValue = (entryPrice - exitPrice - fees) / entryPrice;
    return Number.isFinite(returnValue)
        ? { returnValue, entryTimeSec, exitTimeSec, status: "ok" }
        : { returnValue: null, entryTimeSec, exitTimeSec, status: "invalid_price" };
}

/** Binary search: index of the first bar with time strictly greater than t, or -1. */
function firstBarAfter(times: readonly (number | null)[], t: number): number {
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = times[mid];
        if (v === null) { lo = mid + 1; continue; }
        if (v > t) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
}

/** Per-(event, asset) outcome record stored sparsely in returnsByView. */
export type ViewOutcomeRecord = OpenScoreUsdSharedOutcomeRecord;

export interface TargetOutcomeStageResult {
    invalidRankingAssets?: Set<number>;
    rankingGapAssetsByView?: Map<number, Set<number>>;
    returnsByView: Array<Map<number, ViewOutcomeRecord> | null>;
    missingAssets: Set<number>;
    dataGapAssets: Map<number, CandleGap>;
    dataGapEvents: Set<number>;
    censoredEvents: Set<number>;
    noDataEvents: Set<number>;
    /** Compact target candle boundaries aligned to request/event indexes. */
    boundaryIndicesByView: Array<Map<number, number> | null>;
}

/** Binary search: index of the last candle at or before t, or -1 before the target begins. */
function lastBarAtOrBefore(times: readonly (number | null)[], t: number): number {
    let lo = 0;
    let hi = times.length - 1;
    let answer = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const value = times[mid];
        if (value === null) lo = mid + 1;
        else if (value <= t) { answer = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return answer;
}

export async function evaluateTargetOutcomes(args: {
    /** Switch datasets also carry a known current open; ranking requires completed candles. */
    requireClosedBars?: boolean;
    options: RunOpenScoreUsdReplayOptions;
    targetLoader: (() => AsyncIterable<OpenScoreUsdTarget>) | undefined;
    horizons: number[];
    slippageRate: number;
    commissionRate: number;
    assetNames: readonly string[];
    assetIndexByName: ReadonlyMap<string, number>;
    /**
     * Event snapshots for the Phase 0b diagnostic paths. The engine passes the
     * (possibly already released) array; every consumer here is
     * candidateOutcomes/poolSnapshots-guarded.
     */
    events: readonly DecisionEvent[];
    diagnosticsEnabled: boolean;
    diagnosticAssetNames: readonly string[];
    diagnosticAssetIndexByName: ReadonlyMap<string, number> | null;
    /** Engine-owned accumulators filled when no sink is injected. */
    poolSnapshots: PoolSnapshotRecord[] | undefined;
    candidateOutcomes: CandidateOutcomeRecord[] | undefined;
    requestsByAsset: ReadonlyMap<number, number[]>;
    positiveRequestedAssets: ReadonlySet<number>;
    totalEventCount: number;
    eventTimeOf: (idx: number) => number;
    shouldStop: () => boolean;
    onPhase: ReplayPhaseCallback;
    /** Report-window counts reused by cancellation early exits. */
    pairCount: number;
    assetCount: number;
}): Promise<StageOutcome<TargetOutcomeStageResult>> {
    const {
        options, targetLoader, horizons, slippageRate, commissionRate,
        assetNames, assetIndexByName, events, diagnosticsEnabled,
        diagnosticAssetNames, diagnosticAssetIndexByName,
        poolSnapshots, candidateOutcomes,
        requestsByAsset, positiveRequestedAssets, totalEventCount, eventTimeOf,
        shouldStop, onPhase, pairCount, assetCount,
    } = args;


    const emitPoolSnapshot = async (row: PoolSnapshotRecord): Promise<void> => {
        if (options.onPoolSnapshot) await options.onPoolSnapshot(row);
        else poolSnapshots?.push(row);
    };
    const emitCandidateOutcome = (row: CandidateOutcomeRecord): void | Promise<void> => {
        if (options.onCandidateOutcome) return options.onCandidateOutcome(row);
        candidateOutcomes?.push(row);
    };
    // EMA side state is compactly retained until all catalog targets have been
    // consumed so breadth can be emitted consistently for every asset at an
    // event.  0=unavailable, 1=above, 2=below.
    const emaSideByEvent = diagnosticsEnabled
        ? new Uint8Array(events.length * diagnosticAssetNames.length)
        : null;
    const emaObservedByEvent = diagnosticsEnabled ? new Uint16Array(events.length) : null;
    const emaAboveByEvent = diagnosticsEnabled ? new Uint16Array(events.length) : null;
    // --- Phase 4: evaluate USD outcomes per target (load -> consume -> free) -
    // Per event-view, per horizon: net return for each candidate assetIndex.
    // Stored sparsely: only eligible-candidate assets are queried.
    let returnsByView: Array<Map<number, {
        long: number[];
        mtmLong: (number | null)[];
        /** First bar after the decision timestamp — identical for EVERY
         * horizon of this (event, asset), so stored once, not per horizon. */
        entryTime: number;
        exitTimes: number[];
        statuses: CandidateOutcomeStatus[];
    }> | null> = new Array(totalEventCount).fill(null);
    const boundaryIndicesByView: Array<Map<number, number> | null> = new Array(totalEventCount).fill(null);
    const missingAssets = new Set<number>();
    const invalidRankingAssets = options.rankingHorizon !== undefined ? new Set<number>() : undefined;
    const rankingGapAssetsByView = options.rankingHorizon !== undefined ? new Map<number, Set<number>>() : undefined;
    const dataGapAssets = new Map<number, CandleGap>();
    const dataGapEvents = new Set<number>();
    const censoredEvents = new Set<number>();
    const noDataEvents = new Set<number>();

    let targetsSeen = 0;
    const diagnosticTargetsSeen = diagnosticsEnabled ? new Set<number>() : null;
    const totalTargets = diagnosticsEnabled ? diagnosticAssetNames.length : requestsByAsset.size;
    onPhase("outcomes", "evaluating USD outcomes", 0, totalTargets);

    // Work list: every requested asset plus every diagnostic asset, ascending
    // by the matched name. Per-target processing is independent, so traversal
    // order cannot change results — only progress text.
    const workItems: Array<{
        name: string;
        aIdx: number | undefined;
        diagnosticIdx: number | undefined;
        requests: number[] | undefined;
    }> = [];
    const workItemNames = new Set<string>();
    const addWorkItem = (rawName: string): void => {
        const name = rawName.trim().toUpperCase();
        if (workItemNames.has(name)) return;
        workItemNames.add(name);
        const aIdx = assetIndexByName.get(name);
        workItems.push({
            name,
            aIdx,
            diagnosticIdx: diagnosticAssetIndexByName?.get(name),
            requests: aIdx === undefined ? undefined : requestsByAsset.get(aIdx),
        });
    };
    for (const aIdx of requestsByAsset.keys()) {
        const name = assetNames[aIdx];
        if (name) addWorkItem(name);
    }
    for (const name of diagnosticAssetNames) addWorkItem(name);
    workItems.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Dataset resolution (annual-reload finding). When a lazy loader is
    // injected, only assets NOT fully served by the shared target cache are
    // loaded at all — annual passes whose request sets are cached load zero
    // datasets. Without a lazy loader the streaming `targetLoader` is drained
    // up front and matched by name (prior behavior; also the test path).
    if (!options.loadTargetDataset && !targetLoader) {
        throw new Error("runOpenScoreUsdReplay requires targetLoader or loadTargetDataset");
    }
    const datasetByAsset = new Map<string, OpenScoreUsdTarget>();
    if (!options.loadTargetDataset && targetLoader) {
        for await (const target of targetLoader()) {
            if (shouldStop()) return { ok: false, earlyExit: { reportLine: "OPEN_SCORE USD | cancelled during outcome evaluation.", pairs: pairCount, assets: assetCount, totalEvents: totalEventCount } };
            datasetByAsset.set(target.asset.trim().toUpperCase(), target);
        }
    }
    if (options.prefetchTargetDatasets) {
        options.prefetchTargetDatasets(workItems
            .filter((item) => item.diagnosticIdx !== undefined || !options.sharedTargetCache?.has(item.name))
            .map((item) => item.name));
    }
    // Window-scoped first-overlap test over cached gap intervals — identical
    // to findCandleGapOverlapping's scan, but derived from the intervals
    // captured when the dataset was first loaded.
    const firstGapOverlapping = (gapIntervals: readonly CandleGap[]): CandleGap | null => {
        for (const gap of gapIntervals) {
            if (gap.to > (options.sampleFromSec ?? Number.NEGATIVE_INFINITY)
                && gap.from < (options.sampleToSec ?? Number.POSITIVE_INFINITY)) {
                return gap;
            }
        }
        return null;
    };
    // Outcome per (decision time, target) — pure function of the dataset, so
    // the same record serves this pass and every later window's pass.
    const computeSharedOutcomeRecord = (
        data: OHLCVData[],
        times: (number | null)[],
        entryBar: number,
    ): OpenScoreUsdSharedOutcomeRecord => {
        const longReturns: number[] = [];
        const mtmLong: (number | null)[] = [];
        // Same entry bar for every horizon (entry is the first bar after
        // the decision timestamp; horizons only move the exit).
        const entryTime = times[entryBar] ?? Number.NaN;
        const exitTimes: number[] = [];
        const statuses: CandidateOutcomeStatus[] = [];
        for (const h of horizons) {
            const exitBar = entryBar + h - 1; // h bars forward, close of that bar
            if (exitBar >= data.length) {
                longReturns.push(Number.NaN);
                exitTimes.push(Number.NaN);
                statuses.push("right_censored");
                // Unrealized mark-to-market for the ONGOING detail rows:
                // entry open (slippage-adjusted) to the last available bar
                // close, same cost model as the completed path. Null when
                // either price is unusable.
                const rawOpen = data[entryBar]!.open;
                const lastClose = data[data.length - 1]!.close;
                if (
                    Number.isFinite(rawOpen) && rawOpen > 0
                    && Number.isFinite(lastClose) && lastClose > 0
                ) {
                    const mtmEntry = applySlippage(rawOpen, "buy", slippageRate);
                    const mtmExit = applySlippage(lastClose, "sell", slippageRate);
                    const mtmFees = (mtmEntry + mtmExit) * commissionRate;
                    const mtm = (mtmExit - mtmEntry - mtmFees) / mtmEntry;
                    mtmLong.push(Number.isFinite(mtm) ? mtm : null);
                } else {
                    mtmLong.push(null);
                }
                continue;
            }
            const rawOpen = data[entryBar]!.open;
            const exitClose = data[exitBar]!.close;
            if (!Number.isFinite(rawOpen) || rawOpen <= 0 || !Number.isFinite(exitClose) || exitClose <= 0) {
                longReturns.push(Number.NaN);
                mtmLong.push(null);
                exitTimes.push(Number.NaN);
                statuses.push("invalid_price");
                continue;
            }
            exitTimes.push(times[exitBar] ?? Number.NaN);
            mtmLong.push(null);
            // Long USD trade: buy at next bar open (slippage up), sell at
            // horizon close (slippage down), round-trip commission. Commission
            // is applied canonically (matches position-stats.ts): entryValue*rate
            // + exitValue*rate for a 1-unit notional. This is NOT a flat drag
            // off gross return — it varies with price level.
            const entryPrice = applySlippage(rawOpen, "buy", slippageRate);
            const exitPrice = applySlippage(exitClose, "sell", slippageRate);
            // size = 1 unit of the asset; entryValue=entryPrice, exitValue=exitPrice.
            const fees = (entryPrice + exitPrice) * commissionRate;
            const netReturn = (exitPrice - entryPrice - fees) / entryPrice;
            longReturns.push(Number.isFinite(netReturn) ? netReturn : Number.NaN);
            statuses.push(Number.isFinite(netReturn) ? "ok" : "invalid_price");
        }
        return { long: longReturns, mtmLong, entryTime, exitTimes, statuses };
    };

    for (const item of workItems) {
        if (shouldStop()) return { ok: false, earlyExit: { reportLine: "OPEN_SCORE USD | cancelled during outcome evaluation.", pairs: pairCount, assets: assetCount, totalEvents: totalEventCount } };
        let data: OHLCVData[] | null = null;
        let cacheEntry = options.sharedTargetCache?.get(item.name) ?? null;
        if (item.diagnosticIdx !== undefined || !cacheEntry) {
            let loaded = options.loadTargetDataset
                ? await options.loadTargetDataset(item.name)
                : datasetByAsset.get(item.name)?.data ?? null;
            if (args.requireClosedBars && loaded && options.interval && options.evaluationCutoffSec !== undefined) {
                loaded = selectClosedCandleWindow(loaded, options.interval, options.evaluationCutoffSec, 1)?.candles ?? [];
            }
            // Absent target (mode-dependent): the missing-target backfill
            // below covers it, matching the prior loader-yield semantics.
            if (loaded === null) {
                if (item.aIdx !== undefined) missingAssets.add(item.aIdx);
                continue;
            }
            data = loaded;
            if (!cacheEntry) {
                cacheEntry = {
                    // The gap helper expects seconds; target series also support
                    // milliseconds, ISO strings and BusinessDay timestamps.
                    gapIntervals: findCandleGaps(data.some((bar) => typeof bar.time !== "number" || timeToNumber(bar.time) !== bar.time)
                        ? data.map((bar) => ({ ...bar, time: timeToNumber(bar.time)! as OHLCVData["time"] })) : data),
                    outcomesByEventTimeSec: new Map(),
                    boundaryIndexByEventTimeSec: new Map(),
                };
                options.sharedTargetCache?.set(item.name, cacheEntry);
            }
        }
        const aIdx = item.aIdx;
        const diagnosticIdx = item.diagnosticIdx;
        const requests = item.requests;
        cacheEntry!.boundaryIndexByEventTimeSec ??= new Map();
        const dataGap = firstGapOverlapping(cacheEntry!.gapIntervals);
        if ((!requests || requests.length === 0) && diagnosticIdx === undefined) {
            if (dataGap && aIdx !== undefined) dataGapAssets.set(aIdx, dataGap);
            continue;
        }
        targetsSeen += 1;
        if (diagnosticIdx !== undefined) diagnosticTargetsSeen?.add(diagnosticIdx);
        let times = data ? data.map((b) => timeToNumber(b.time)) : null;
        if (invalidRankingAssets && aIdx !== undefined && times && times.some((time, index) => time === null || !Number.isFinite(time) || (index > 0 && time <= times![index - 1]!))) invalidRankingAssets.add(aIdx);
        if (dataGap) {
            if (aIdx !== undefined) dataGapAssets.set(aIdx, dataGap);
            if (candidateOutcomes && diagnosticIdx !== undefined) {
                for (const event of events) {
                    const rawScore = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                    for (const horizonBars of horizons) {
                        const eventId = phase0bEventId(options.interval, event.timeSec);
                        const pendingLongWrite = emitCandidateOutcome({
                            eventId,
                            decisionTimeSec: event.timeSec,
                            horizonBars,
                            direction: "long",
                            asset: diagnosticAssetNames[diagnosticIdx]!,
                            inPool: true,
                            eligible: rawScore > 0,
                            return: null,
                            entryTimeSec: null,
                            exitTimeSec: null,
                            status: "data_gap",
                        });
                        if (pendingLongWrite) await pendingLongWrite;
                        const pendingShortWrite = emitCandidateOutcome({
                            eventId,
                            decisionTimeSec: event.timeSec,
                            horizonBars,
                            direction: "short",
                            asset: diagnosticAssetNames[diagnosticIdx]!,
                            inPool: true,
                            eligible: rawScore < 0,
                            return: null,
                            entryTimeSec: null,
                            exitTimeSec: null,
                            status: "data_gap",
                        });
                        if (pendingShortWrite) await pendingShortWrite;
                    }
                }
            }
            onPhase(
                "outcomes",
                `skipped ${item.name} (data gap ${new Date(dataGap.from * 1000).toISOString()}..${new Date(dataGap.to * 1000).toISOString()})`,
                targetsSeen,
                totalTargets,
            );
            await yieldLoop();
            continue;
        }
        if (diagnosticIdx !== undefined) {
            // Diagnostic assets always resolve with a dataset above — the
            // resolver loads them before a cache entry can serve this asset.
            const diagnosticData = data!;
            const diagnosticTimes = times!;
            const requestedTimes = requests && requests.length > 0
                ? new Set(requests.map((viewIdx) => eventTimeOf(viewIdx)))
                : null;
            const ema200 = buildEma200(diagnosticData);
            let entryBar = 0;
            for (let eventIdx = 0; eventIdx < events.length; eventIdx += 1) {
                const event = events[eventIdx]!;
                while (entryBar < diagnosticTimes.length) {
                    const barTime = diagnosticTimes[entryBar];
                    if (barTime === null || barTime <= event.timeSec) entryBar += 1;
                    else break;
                }
                const resolvedEntryBar = entryBar < diagnosticTimes.length ? entryBar : -1;
                const trendBar = resolvedEntryBar - 1;
                const trendClose = trendBar >= 0 ? diagnosticData[trendBar]!.close : Number.NaN;
                const trendEma = trendBar >= 0 ? ema200[trendBar]! : Number.NaN;
                const emaSide = Number.isFinite(trendClose) && Number.isFinite(trendEma)
                    ? trendClose > trendEma ? 1 : trendClose < trendEma ? 2 : 0
                    : 0;
                if (emaSideByEvent && emaObservedByEvent && emaAboveByEvent && emaSide !== 0) {
                    const stateOffset = eventIdx * diagnosticAssetNames.length + diagnosticIdx;
                    emaSideByEvent[stateOffset] = emaSide;
                    emaObservedByEvent[eventIdx] += 1;
                    if (emaSide === 1) emaAboveByEvent[eventIdx] += 1;
                }
                if (!candidateOutcomes) continue;
                // Selector-requested timestamps for this asset (top-mean
                // coordinator optimization plan, idea #1): their outcome
                // records are built right here from the resolved entry bar
                // and the diagnostic long results, so the request loop below
                // consumes them from the cache without repeating the entry
                // lookup or long-return computation. Only requested events
                // are cached — never every diagnostic row.
                const cacheRecord = resolvedEntryBar >= 0 && requestedTimes?.has(event.timeSec)
                    ? {
                        long: [] as number[],
                        mtmLong: [] as (number | null)[],
                        entryTime: Number.isFinite(diagnosticTimes[resolvedEntryBar]) ? diagnosticTimes[resolvedEntryBar]! : Number.NaN,
                        exitTimes: [] as number[],
                        statuses: [] as CandidateOutcomeStatus[],
                    }
                    : null;
                if (resolvedEntryBar < 0 && requestedTimes?.has(event.timeSec)) {
                    // Missing entry is the existing null cache entry —
                    // distinct from an absent cache key.
                    cacheEntry!.outcomesByEventTimeSec.set(event.timeSec, null);
                }
                const rawScore = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                const longEligible = rawScore > 0;
                const shortEligible = rawScore < 0;
                for (let hIdx = 0; hIdx < horizons.length; hIdx += 1) {
                    const horizonBars = horizons[hIdx]!;
                    const longOutcome = computeDiagnosticOutcome(
                        diagnosticData,
                        diagnosticTimes,
                        resolvedEntryBar,
                        horizonBars,
                        "long",
                        slippageRate,
                        commissionRate,
                    );
                    const shortOutcome = computeDiagnosticOutcome(
                        diagnosticData,
                        diagnosticTimes,
                        resolvedEntryBar,
                        horizonBars,
                        "short",
                        slippageRate,
                        commissionRate,
                    );
                    if (cacheRecord) {
                        // Same arithmetic, mapped into the selector record's
                        // representation (censored-before-price status
                        // precedence is identical in both builders). Censored
                        // mark-to-market uses the existing formula —
                        // diagnostic realized returns cannot supply it.
                        if (longOutcome.status === "right_censored") {
                            cacheRecord.long.push(Number.NaN);
                            cacheRecord.exitTimes.push(Number.NaN);
                            cacheRecord.statuses.push("right_censored");
                            const rawOpen = diagnosticData[resolvedEntryBar]!.open;
                            const lastClose = diagnosticData[diagnosticData.length - 1]!.close;
                            if (Number.isFinite(rawOpen) && rawOpen > 0 && Number.isFinite(lastClose) && lastClose > 0) {
                                const mtmEntry = applySlippage(rawOpen, "buy", slippageRate);
                                const mtmExit = applySlippage(lastClose, "sell", slippageRate);
                                const mtmFees = (mtmEntry + mtmExit) * commissionRate;
                                const mtm = (mtmExit - mtmEntry - mtmFees) / mtmEntry;
                                cacheRecord.mtmLong.push(Number.isFinite(mtm) ? mtm : null);
                            } else {
                                cacheRecord.mtmLong.push(null);
                            }
                        } else if (longOutcome.status === "ok") {
                            cacheRecord.long.push(longOutcome.returnValue!);
                            cacheRecord.exitTimes.push(longOutcome.exitTimeSec ?? Number.NaN);
                            cacheRecord.statuses.push("ok");
                            cacheRecord.mtmLong.push(null);
                        } else {
                            cacheRecord.long.push(Number.NaN);
                            cacheRecord.exitTimes.push(Number.NaN);
                            cacheRecord.statuses.push("invalid_price");
                            cacheRecord.mtmLong.push(null);
                        }
                    }
                    const eventId = phase0bEventId(options.interval, event.timeSec);
                    const pendingLongWrite = emitCandidateOutcome({
                        eventId,
                        decisionTimeSec: event.timeSec,
                        horizonBars,
                        direction: "long",
                        asset: diagnosticAssetNames[diagnosticIdx]!,
                        inPool: true,
                        eligible: longEligible,
                        return: longOutcome.returnValue,
                        entryTimeSec: longOutcome.entryTimeSec,
                        exitTimeSec: longOutcome.exitTimeSec,
                        status: longOutcome.status,
                    });
                    if (pendingLongWrite) await pendingLongWrite;
                    const pendingShortWrite = emitCandidateOutcome({
                        eventId,
                        decisionTimeSec: event.timeSec,
                        horizonBars,
                        direction: "short",
                        asset: diagnosticAssetNames[diagnosticIdx]!,
                        inPool: true,
                        eligible: shortEligible,
                        return: shortOutcome.returnValue,
                        entryTimeSec: shortOutcome.entryTimeSec,
                        exitTimeSec: shortOutcome.exitTimeSec,
                        status: shortOutcome.status,
                    });
                    if (pendingShortWrite) await pendingShortWrite;
                }
                if (cacheRecord) {
                    cacheEntry!.outcomesByEventTimeSec.set(event.timeSec, cacheRecord);
                }
            }
        }
        if (aIdx === undefined || !requests || requests.length === 0) continue;
        for (const viewIdx of requests) {
            const eventTime = eventTimeOf(viewIdx);
            let boundaryIndex = cacheEntry.boundaryIndexByEventTimeSec?.get(eventTime);
            if (boundaryIndex === undefined && data && times) {
                boundaryIndex = lastBarAtOrBefore(times, eventTime);
                cacheEntry.boundaryIndexByEventTimeSec?.set(eventTime, boundaryIndex);
            }
            if (boundaryIndex !== undefined) {
                let boundaries = boundaryIndicesByView[viewIdx];
                if (!boundaries) { boundaries = new Map(); boundaryIndicesByView[viewIdx] = boundaries; }
                boundaries.set(aIdx, boundaryIndex);
            }
            let record = cacheEntry
                ? cacheEntry.outcomesByEventTimeSec.get(eventTime)
                : undefined;
            if (record === undefined && (!data || !times)) {
                // Subset-invariant fallback: the cache was populated by a
                // narrower event set than this pass requests. Reload and
                // compute rather than misreport the event.
                const reloaded = options.loadTargetDataset
                    ? await options.loadTargetDataset(item.name)
                    : datasetByAsset.get(item.name)?.data ?? null;
                if (reloaded === null) continue;
                data = reloaded;
                times = data.map((b) => timeToNumber(b.time));
                boundaryIndex = lastBarAtOrBefore(times, eventTime);
                cacheEntry.boundaryIndexByEventTimeSec?.set(eventTime, boundaryIndex);
                if (boundaryIndex !== undefined) {
                    let boundaries = boundaryIndicesByView[viewIdx];
                    if (!boundaries) { boundaries = new Map(); boundaryIndicesByView[viewIdx] = boundaries; }
                    boundaries.set(aIdx, boundaryIndex);
                }
            }
            if (record === undefined) {
                // First target bar strictly after the decision timestamp.
                const entryBar = firstBarAfter(times!, eventTime);
                if (entryBar < 0) {
                    cacheEntry?.outcomesByEventTimeSec.set(eventTime, null);
                    if (positiveRequestedAssets.has(aIdx)) noDataEvents.add(viewIdx);
                    continue;
                }
                record = computeSharedOutcomeRecord(data!, times!, entryBar);
                cacheEntry?.outcomesByEventTimeSec.set(eventTime, record);
            }
            if (!record) {
                // Cached noData marker for this decision timestamp.
                if (positiveRequestedAssets.has(aIdx)) noDataEvents.add(viewIdx);
                continue;
            }
            let perAsset = returnsByView[viewIdx];
            if (!perAsset) { perAsset = new Map(); returnsByView[viewIdx] = perAsset; }
            perAsset.set(aIdx, record);
            if (rankingGapAssetsByView) {
                const horizonIndex = horizons.indexOf(options.rankingHorizon!);
                if (cacheEntry.gapIntervals.some((gap) => gap.to > record.entryTime && gap.from < record.exitTimes[horizonIndex]!)) {
                    const set = rankingGapAssetsByView.get(viewIdx) ?? new Set<number>();
                    set.add(aIdx); rankingGapAssetsByView.set(viewIdx, set);
                }
            }
            if (record.long.some((r) => !Number.isFinite(r))) censoredEvents.add(viewIdx);
        }
        onPhase("outcomes", `evaluated ${item.name} (${targetsSeen}/${totalTargets})`, targetsSeen, totalTargets);
        await yieldLoop();
        // target OHLCV reference released here (goes out of scope next iteration).
    }

    if (candidateOutcomes) {
        for (let diagnosticIdx = 0; diagnosticIdx < diagnosticAssetNames.length; diagnosticIdx += 1) {
            if (diagnosticTargetsSeen?.has(diagnosticIdx)) continue;
            const asset = diagnosticAssetNames[diagnosticIdx]!;
            const aIdx = assetIndexByName.get(asset);
            for (const event of events) {
                const rawScore = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                for (const horizonBars of horizons) {
                    const eventId = phase0bEventId(options.interval, event.timeSec);
                    const pendingLongWrite = emitCandidateOutcome({
                        eventId,
                        decisionTimeSec: event.timeSec,
                        horizonBars,
                        direction: "long",
                        asset,
                        inPool: true,
                        eligible: rawScore > 0,
                        return: null,
                        entryTimeSec: null,
                        exitTimeSec: null,
                        status: "missing_target",
                    });
                    if (pendingLongWrite) await pendingLongWrite;
                    const pendingShortWrite = emitCandidateOutcome({
                        eventId,
                        decisionTimeSec: event.timeSec,
                        horizonBars,
                        direction: "short",
                        asset,
                        inPool: true,
                        eligible: rawScore < 0,
                        return: null,
                        entryTimeSec: null,
                        exitTimeSec: null,
                        status: "missing_target",
                    });
                    if (pendingShortWrite) await pendingShortWrite;
                }
            }
        }
    }

    if (poolSnapshots) {
        const interval = options.interval ?? "";
        const poolVersion = options.poolVersion ?? null;
        for (let eventIdx = 0; eventIdx < events.length; eventIdx += 1) {
            const event = events[eventIdx]!;
            const observed = emaObservedByEvent?.[eventIdx] ?? 0;
            const above = emaAboveByEvent?.[eventIdx] ?? 0;
            const breadth = observed > 0 ? above / observed : null;
            const regime: PoolSnapshotRecord["regime"] = observed >= 2
                ? above / observed > 0.5 ? "bullish" : "bearish"
                : "unavailable";
            const eventId = phase0bEventId(options.interval, event.timeSec);
            for (let diagnosticIdx = 0; diagnosticIdx < diagnosticAssetNames.length; diagnosticIdx += 1) {
                const asset = diagnosticAssetNames[diagnosticIdx]!;
                const aIdx = assetIndexByName.get(asset);
                const activeCount = aIdx === undefined ? 0 : event.activePairCount[aIdx] ?? 0;
                const signedVotes = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                await emitPoolSnapshot({
                    eventId,
                    decisionTimeSec: event.timeSec,
                    interval,
                    poolVersion,
                    asset,
                    inPool: true,
                    activePairCount: activeCount,
                    signedVotes,
                    score: activeCount > 0 ? signedVotes / activeCount : null,
                    longEligible: signedVotes > 0,
                    shortEligible: signedVotes < 0,
                    ema200Above: emaSideByEvent?.[eventIdx * diagnosticAssetNames.length + diagnosticIdx] === 1,
                    breadth,
                    regime,
                });
            }
        }
    }

    return {
        ok: true,
        result: { returnsByView, missingAssets, dataGapAssets, dataGapEvents, censoredEvents, noDataEvents, boundaryIndicesByView, ...(invalidRankingAssets ? { invalidRankingAssets, rankingGapAssetsByView } : {}) },
    };
}
