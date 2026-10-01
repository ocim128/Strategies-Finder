/**
 * Non-overlapping, fixed-notional asset-switch replay for the OPEN_SCORE arms.
 * This is deliberately separate from the fixed-horizon outcome path: a
 * position's sale, replacement, and terminal mark depend on prior fills.
 */
import { applySlippage, timeToNumber } from "../../strategies/backtest/backtest-utils";
import { DEFAULT_CANDLE_GAP_THRESHOLD_DAYS } from "../../ibkr-data/candle-gap";
import { parseIntervalSeconds } from "../../interval-utils";
import type { OHLCVData } from "../../types/strategies";
import type {
    AssetSwitchArmSummary,
    AssetSwitchOpenPosition,
    AssetSwitchPendingOrder,
    AssetSwitchReplaySummary,
    AssetSwitchTradeRecord,
    ReplayArmField,
    RunOpenScoreUsdReplayOptions,
} from "./types";
import type { AssetSwitchDecision, ReplayPhaseCallback, StageOutcome } from "./internal-types";
import { yieldLoop } from "./runtime";
import { REPLAY_ARM_FIELDS } from "./arm-contract";

const NOTIONAL_PER_ENTRY = 1_000;
const MAX_DIAGNOSTIC_COUNT = 1_000_000_000;
const PRICE_LOOKUP_CACHE_LIMIT = 8_192;
// Asset-switch replay has up to 15 independent arms. During a simultaneous
// switch they can reference one held and one replacement series each.
const SERIES_META_CACHE_LIMIT = 32;
// Each valid series retains three Float64 arrays (time/open/close): cap those
// arrays at about 192 MB (183 MiB) in addition to the entry bound above.
const SERIES_META_CACHE_MAX_POINTS = 8_000_000;
const GAP_META_CACHE_LIMIT = 32;
const TRADE_DETAIL_LIMIT = 1_000;
const GAP_THRESHOLD_SEC = DEFAULT_CANDLE_GAP_THRESHOLD_DAYS * 24 * 60 * 60;

interface CandlePoint {
    timeSec: number;
    open: number;
    close: number;
}

interface CandleGapInterval {
    from: number;
    to: number;
}

interface SeriesMeta {
    status: "ok" | "missing" | "invalid";
    gaps: CandleGapInterval[];
    times?: Float64Array;
    opens?: Float64Array;
    closes?: Float64Array;
}

interface LookupResult {
    status: "ok" | "missing" | "invalid";
    point: CandlePoint | null;
}

interface PlannedCandle {
    timeSec: number;
    open: number;
}

interface Position {
    asset: string;
    decisionTimeSec: number;
    entryTimeSec: number;
    entryPrice: number;
    quantity: number;
    entryFee: number;
    entrySlippage: number;
    tradeRecord?: AssetSwitchTradeRecord;
}

interface ArmState {
    enteredCount: number;
    completedTrades: number;
    realizedNetPnl: number;
    realizedNetPnlByAsset?: Map<string, number>;
    completedHoldingDurationSec: number;
    totalCosts: number;
    position: Position | null;
    desiredAsset: string | null;
    pendingDecisionTimeSec: number | null;
    pendingSell: PlannedCandle | null;
    pendingBuy: PlannedCandle | null;
    buyOrderFromSec: number | null;
    failed: boolean;
    diagnostics: AssetSwitchArmSummary["diagnosticCounts"];
}

function newState(includeContributorSummary: boolean): ArmState {
    return {
        enteredCount: 0,
        completedTrades: 0,
        realizedNetPnl: 0,
        ...(includeContributorSummary ? { realizedNetPnlByAsset: new Map<string, number>() } : {}),
        completedHoldingDurationSec: 0,
        totalCosts: 0,
        position: null,
        desiredAsset: null,
        pendingDecisionTimeSec: null,
        pendingSell: null,
        pendingBuy: null,
        buyOrderFromSec: null,
        failed: false,
        diagnostics: {
            missingTarget: 0,
            invalidTimestamp: 0,
            invalidPrice: 0,
            dataGap: 0,
            staleMark: 0,
            unvaluedPosition: 0,
        },
    };
}

class BoundedTradePreview {
    private readonly rows: AssetSwitchTradeRecord[] = [];
    private start = 0;

    constructor(private readonly limit: number) {}

    push(row: AssetSwitchTradeRecord): void {
        if (this.rows.length < this.limit) {
            this.rows.push(row);
            return;
        }
        this.rows[this.start] = row;
        this.start = (this.start + 1) % this.limit;
    }

    values(): AssetSwitchTradeRecord[] {
        if (this.rows.length < this.limit || this.start === 0) return [...this.rows];
        return [...this.rows.slice(this.start), ...this.rows.slice(0, this.start)];
    }
}

export function createEmptyAssetSwitchSummary(
    options: RunOpenScoreUsdReplayOptions,
    slippageRate = options.slippageRate ?? 0,
    commissionRate = options.commissionRate ?? 0,
): AssetSwitchReplaySummary {
    const cutoffSec = Number.isFinite(options.evaluationCutoffSec)
        ? options.evaluationCutoffSec!
        : Math.floor(Date.now() / 1000);
    const requestedEndSec = Number.isFinite(options.sampleToSec) ? options.sampleToSec! : cutoffSec;
    const arms = {} as AssetSwitchReplaySummary["arms"];
    for (const field of REPLAY_ARM_FIELDS) {
        arms[field] = {
            status: "no_entry",
            enteredCount: 0,
            completedTrades: 0,
            realizedNetPnl: null,
            openPositionNetPnl: null,
            totalNetPnl: null,
            partialRealizedNetPnl: 0,
            completedHoldingDurationSec: 0,
            averageCompletedHoldingDurationSec: null,
            totalCosts: 0,
            openPosition: null,
            pendingOrder: null,
            diagnosticCounts: {
                missingTarget: 0,
                invalidTimestamp: 0,
                invalidPrice: 0,
                dataGap: 0,
                staleMark: 0,
                unvaluedPosition: 0,
            },
        };
    }
    return {
        semanticsVersion: "asset_switch.v1",
        decisionCount: 0,
        windowStartSec: Number.isFinite(options.sampleFromSec) ? options.sampleFromSec! : null,
        windowEndSec: Math.min(requestedEndSec, cutoffSec),
        independentWindow: options.independentWindow === true,
        sizing: "fixed_entry_notional_non_compounding",
        notionalPerEntry: NOTIONAL_PER_ENTRY,
        slippageRate,
        commissionRate,
        valuation: "last_closed_candle_close_at_or_before_window_end",
        coverage: { requestedAssets: 0, loadedAssets: 0, missingAssets: 0, invalidSeries: 0 },
        arms,
        ...(options.includeEventDetails ? { trades: [], tradeCount: 0 } : {}),
    };
}

function addDiagnostic(state: ArmState, key: keyof ArmState["diagnostics"]): void {
    state.diagnostics[key] = Math.min(MAX_DIAGNOSTIC_COUNT, state.diagnostics[key] + 1);
    state.failed = true;
}

function seriesPointCount(meta: SeriesMeta | undefined): number {
    return meta?.status === "ok" ? meta.times?.length ?? 0 : 0;
}

function cappedGapSet(
    map: Map<string, Pick<SeriesMeta, "status" | "gaps">>,
    key: string,
    value: Pick<SeriesMeta, "status" | "gaps">,
): void {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > GAP_META_CACHE_LIMIT) map.delete(map.keys().next().value!);
}

function cappedLookup(map: Map<string, LookupResult>, key: string, value: LookupResult): void {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > PRICE_LOOKUP_CACHE_LIMIT) map.delete(map.keys().next().value!);
}

/** Normalize once per lazy read and keep only a bounded set of compact results. */
class SwitchTargetLookup {
    private readonly seriesMeta = new Map<string, SeriesMeta>();
    /** Validation and gap data outlive the bounded full-price cache. */
    private readonly gapMeta = new Map<string, Pick<SeriesMeta, "status" | "gaps">>();
    private readonly lookupCache = new Map<string, LookupResult>();
    private readonly requested = new Set<string>();
    private readonly loaded = new Set<string>();
    private readonly missing = new Set<string>();
    private readonly invalid = new Set<string>();
    private seriesMetaPoints = 0;

    constructor(
        private readonly load: (asset: string) => Promise<OHLCVData[] | null>,
        private readonly endSec: number,
        private readonly intervalSec: number,
    ) {}

    private rememberSeriesMeta(asset: string, meta: SeriesMeta): void {
        const previous = this.seriesMeta.get(asset);
        if (previous) {
            this.seriesMeta.delete(asset);
            this.seriesMetaPoints -= seriesPointCount(previous);
        }
        this.seriesMeta.set(asset, meta);
        this.seriesMetaPoints += seriesPointCount(meta);
        while (this.seriesMeta.size > SERIES_META_CACHE_LIMIT
            || this.seriesMetaPoints > SERIES_META_CACHE_MAX_POINTS) {
            const oldestAsset = this.seriesMeta.keys().next().value;
            if (oldestAsset === undefined) break;
            const oldest = this.seriesMeta.get(oldestAsset);
            this.seriesMeta.delete(oldestAsset);
            this.seriesMetaPoints -= seriesPointCount(oldest);
        }
    }

    get coverage(): AssetSwitchReplaySummary["coverage"] {
        return {
            requestedAssets: this.requested.size,
            loadedAssets: this.loaded.size,
            missingAssets: this.missing.size,
            invalidSeries: this.invalid.size,
        };
    }

    private async loadMeta(asset: string): Promise<SeriesMeta> {
        const cached = this.seriesMeta.get(asset);
        if (cached) {
            this.seriesMeta.delete(asset);
            this.seriesMeta.set(asset, cached);
            return cached;
        }
        this.requested.add(asset);
        let data: OHLCVData[] | null;
        try {
            data = await this.load(asset);
        } catch {
            data = null;
        }
        if (!data || data.length === 0) {
            const meta = { status: "missing" as const, gaps: [] };
            this.missing.add(asset);
            cappedGapSet(this.gapMeta, asset, meta);
            this.rememberSeriesMeta(asset, meta);
            return meta;
        }
        this.loaded.add(asset);
        const times = new Float64Array(data.length);
        const opens = new Float64Array(data.length);
        const closes = new Float64Array(data.length);
        let invalidSeries = false;
        let previous = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < data.length; index += 1) {
            const candle = data[index]!;
            const normalizedTime = timeToNumber(candle.time);
            if (normalizedTime === null || !Number.isFinite(normalizedTime) || normalizedTime <= previous) {
                invalidSeries = true;
                break;
            }
            previous = normalizedTime;
            times[index] = normalizedTime;
            opens[index] = candle.open;
            closes[index] = candle.close;
        }
        if (invalidSeries) {
            const meta = { status: "invalid" as const, gaps: [] };
            this.invalid.add(asset);
            cappedGapSet(this.gapMeta, asset, meta);
            this.rememberSeriesMeta(asset, meta);
            return meta;
        }
        const gaps: CandleGapInterval[] = [];
        for (let i = 1; i < data.length; i += 1) {
            const from = times[i - 1]!;
            const to = times[i]!;
            if (to - from > GAP_THRESHOLD_SEC) gaps.push({ from, to });
        }
        const meta: SeriesMeta = {
            status: "ok",
            gaps,
            times,
            opens,
            closes,
        };
        cappedGapSet(this.gapMeta, asset, { status: meta.status, gaps });
        this.rememberSeriesMeta(asset, meta);
        return meta;
    }

    async next(assetRaw: string, boundarySec: number, inclusive: boolean): Promise<LookupResult> {
        const asset = assetRaw.trim().toUpperCase();
        const cacheKey = `${asset}|next|${inclusive ? "gte" : "gt"}|${boundarySec}`;
        const cached = this.lookupCache.get(cacheKey);
        if (cached) return cached;
        const meta = await this.loadMeta(asset);
        if (meta.status !== "ok") {
            const result = { status: meta.status, point: null } as LookupResult;
            cappedLookup(this.lookupCache, cacheKey, result);
            return result;
        }
        const times = meta.times!;
        let lo = 0;
        let hi = times.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const time = times[mid]!;
            if (time === null || (inclusive ? time < boundarySec : time <= boundarySec)) lo = mid + 1;
            else hi = mid;
        }
        let point: CandlePoint | null = null;
        if (lo < times.length) {
            const timeSec = times[lo]!;
            if (timeSec <= this.endSec) {
                point = { timeSec, open: meta.opens![lo]!, close: meta.closes![lo]! };
            }
        }
        const result: LookupResult = { status: "ok", point };
        cappedLookup(this.lookupCache, cacheKey, result);
        return result;
    }

    async last(assetRaw: string, boundarySec: number): Promise<LookupResult> {
        const asset = assetRaw.trim().toUpperCase();
        const cacheKey = `${asset}|last|lte|${boundarySec}`;
        const cached = this.lookupCache.get(cacheKey);
        if (cached) return cached;
        const meta = await this.loadMeta(asset);
        if (meta.status !== "ok") {
            const result = { status: meta.status, point: null } as LookupResult;
            cappedLookup(this.lookupCache, cacheKey, result);
            return result;
        }
        const times = meta.times!;
        let lo = 0;
        let hi = times.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const time = times[mid]!;
            if (time + this.intervalSec <= boundarySec) lo = mid + 1;
            else hi = mid;
        }
        const index = lo - 1;
        const point = index >= 0
            ? { timeSec: times[index]!, open: meta.opens![index]!, close: meta.closes![index]! }
            : null;
        const result: LookupResult = { status: "ok", point };
        cappedLookup(this.lookupCache, cacheKey, result);
        return result;
    }

    async hasGap(assetRaw: string, fromSec: number, toSec: number): Promise<boolean | "missing" | "invalid"> {
        const asset = assetRaw.trim().toUpperCase();
        const meta = this.gapMeta.get(asset) ?? await this.loadMeta(asset);
        if (meta.status !== "ok") return meta.status;
        return meta.gaps.some((gap) => gap.to > fromSec && gap.from < toSec);
    }
}

function finitePositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function markArmIncompleteForLookup(state: ArmState, lookup: LookupResult): void {
    if (lookup.status === "missing") addDiagnostic(state, "missingTarget");
    else if (lookup.status === "invalid") addDiagnostic(state, "invalidTimestamp");
}

async function checkGap(
    state: ArmState,
    lookup: SwitchTargetLookup,
    asset: string,
    fromSec: number,
    toSec: number,
): Promise<boolean> {
    const hasGap = await lookup.hasGap(asset, fromSec, toSec);
    if (hasGap === false) return true;
    if (hasGap === true) addDiagnostic(state, "dataGap");
    else if (hasGap === "missing") addDiagnostic(state, "missingTarget");
    else addDiagnostic(state, "invalidTimestamp");
    return false;
}

async function validatePendingBuyAtEnd(
    state: ArmState,
    lookup: SwitchTargetLookup,
    asset: string,
    fromSec: number,
    endSec: number,
    intervalSec: number,
): Promise<void> {
    const gap = await lookup.hasGap(asset, fromSec, endSec);
    if (gap === true) {
        addDiagnostic(state, "dataGap");
        return;
    }
    if (gap === "missing") {
        addDiagnostic(state, "missingTarget");
        return;
    }
    if (gap === "invalid") {
        addDiagnostic(state, "invalidTimestamp");
        return;
    }

    // A pending order can have no executable candle before the window end.
    // Internal gap intervals catch a long jump to a later candle; this also
    // catches a stale tail where no later candle exists in the loaded series.
    const last = await lookup.last(asset, endSec);
    if (last.status !== "ok") {
        markArmIncompleteForLookup(state, last);
        return;
    }
    const lastClosedTimeSec = last.point ? last.point.timeSec + intervalSec : fromSec;
    if (endSec - lastClosedTimeSec > GAP_THRESHOLD_SEC) addDiagnostic(state, "dataGap");
}

interface ArmRuntime {
    field: ReplayArmField;
    state: ArmState;
    schedule(assetIndex: number | null, decisionTimeSec: number): void | Promise<void>;
    processPendingThrough(throughSec: number): void | Promise<void>;
}

function createArmRuntime(args: {
    field: ReplayArmField;
    lookup: SwitchTargetLookup;
    assetNames: readonly string[];
    slippageRate: number;
    commissionRate: number;
    includeContributorSummary: boolean;
    retainTradeRows: boolean;
    onTradeFinalized(row: AssetSwitchTradeRecord): Promise<void>;
    onTradeOpened(row: AssetSwitchTradeRecord): void;
}): ArmRuntime {
    const { field, lookup, assetNames, slippageRate, commissionRate, includeContributorSummary, retainTradeRows, onTradeFinalized, onTradeOpened } = args;
    const state = newState(includeContributorSummary);
    const planNext = async (asset: string, boundarySec: number, inclusive: boolean): Promise<PlannedCandle | null> => {
        const response = await lookup.next(asset, boundarySec, inclusive);
        if (response.status !== "ok") {
            markArmIncompleteForLookup(state, response);
            return null;
        }
        return response.point ? { timeSec: response.point.timeSec, open: response.point.open } : null;
    };
    const schedule = (assetIndex: number | null, decisionTimeSec: number): void | Promise<void> => {
        const targetAsset = assetIndex === null ? null : assetNames[assetIndex] ?? null;
        if (!targetAsset) {
            state.pendingDecisionTimeSec = null;
            state.pendingSell = null;
            state.pendingBuy = null;
            state.buyOrderFromSec = null;
            state.desiredAsset = state.position?.asset ?? null;
            return;
        }
        if (targetAsset === state.position?.asset) {
            state.pendingDecisionTimeSec = null;
            state.pendingSell = null;
            state.pendingBuy = null;
            state.buyOrderFromSec = null;
            state.desiredAsset = targetAsset;
            return;
        }
        if (targetAsset === state.desiredAsset && state.pendingDecisionTimeSec !== null) {
            // Repeating a pending pick must not move its original order.
            return;
        }
        state.desiredAsset = targetAsset;
        state.pendingDecisionTimeSec = decisionTimeSec;
        if (state.position) {
            const heldAsset = state.position.asset;
            return (async () => {
                const sale = state.pendingSell ?? await planNext(heldAsset, decisionTimeSec, false);
                state.pendingSell = sale;
                state.buyOrderFromSec = sale?.timeSec ?? null;
                state.pendingBuy = sale ? await planNext(targetAsset, sale.timeSec, true) : null;
            })();
        } else {
            state.pendingSell = null;
            state.buyOrderFromSec = decisionTimeSec;
            return planNext(targetAsset, decisionTimeSec, false).then((buy) => {
                state.pendingBuy = buy;
            });
        }
    };
    const processPendingThroughAsync = async (throughSec: number): Promise<void> => {
        // At one open, complete a scheduled sale and replacement buy before
        // processing the score decision at that timestamp.
        let changed = true;
        while (changed && !state.failed) {
            changed = false;
            if (state.position && state.pendingSell && state.pendingSell.timeSec <= throughSec) {
                const old = state.position;
                const sell = state.pendingSell;
                if (!await checkGap(state, lookup, old.asset, old.entryTimeSec, sell.timeSec)) return;
                if (!finitePositive(sell.open)) {
                    addDiagnostic(state, "invalidPrice");
                    state.pendingSell = null;
                    break;
                }
                const exitPrice = applySlippage(sell.open, "sell", slippageRate);
                if (!finitePositive(exitPrice)) {
                    addDiagnostic(state, "invalidPrice");
                    state.pendingSell = null;
                    break;
                }
                const exitFee = old.quantity * exitPrice * commissionRate;
                const exitSlippage = old.quantity * (sell.open - exitPrice);
                const netPnl = old.quantity * (exitPrice - old.entryPrice) - old.entryFee - exitFee;
                const duration = Math.max(0, sell.timeSec - old.entryTimeSec);
                state.realizedNetPnl += netPnl;
                if (state.realizedNetPnlByAsset) {
                    state.realizedNetPnlByAsset.set(old.asset, (state.realizedNetPnlByAsset.get(old.asset) ?? 0) + netPnl);
                }
                state.completedTrades += 1;
                state.completedHoldingDurationSec += duration;
                state.totalCosts += exitFee + exitSlippage;
                if (old.tradeRecord) {
                    old.tradeRecord.exitTimeSec = sell.timeSec;
                    old.tradeRecord.exitPrice = exitPrice;
                    old.tradeRecord.holdingDurationSec = duration;
                    old.tradeRecord.netPnl = netPnl;
                    old.tradeRecord.exitCost = exitFee + exitSlippage;
                    old.tradeRecord.status = "closed";
                    await onTradeFinalized(old.tradeRecord);
                }
                state.position = null;
                state.pendingSell = null;
                state.buyOrderFromSec = sell.timeSec;
                changed = true;
            }
            if (!state.position && state.desiredAsset && state.pendingBuy && state.pendingBuy.timeSec <= throughSec) {
                const destination = state.desiredAsset;
                const buy = state.pendingBuy;
                const fromSec = state.buyOrderFromSec ?? state.pendingDecisionTimeSec ?? buy.timeSec;
                if (!await checkGap(state, lookup, destination, fromSec, buy.timeSec)) return;
                if (!finitePositive(buy.open)) {
                    addDiagnostic(state, "invalidPrice");
                    state.pendingBuy = null;
                    break;
                }
                const entryPrice = applySlippage(buy.open, "buy", slippageRate);
                if (!finitePositive(entryPrice)) {
                    addDiagnostic(state, "invalidPrice");
                    state.pendingBuy = null;
                    break;
                }
                const quantity = NOTIONAL_PER_ENTRY / entryPrice;
                const entryFee = quantity * entryPrice * commissionRate;
                const entrySlippage = quantity * (entryPrice - buy.open);
                const decisionTimeSec = state.pendingDecisionTimeSec ?? buy.timeSec;
                const tradeRecord: AssetSwitchTradeRecord | undefined = retainTradeRows ? {
                    arm: field,
                    asset: destination,
                    decisionTimeSec,
                    entryTimeSec: buy.timeSec,
                    entryPrice,
                    exitTimeSec: null,
                    exitPrice: null,
                    holdingDurationSec: null,
                    netPnl: null,
                    entryCost: entryFee + entrySlippage,
                    exitCost: 0,
                    status: "open",
                } : undefined;
                state.position = {
                    asset: destination,
                    decisionTimeSec,
                    entryTimeSec: buy.timeSec,
                    entryPrice,
                    quantity,
                    entryFee,
                    entrySlippage,
                    ...(tradeRecord ? { tradeRecord } : {}),
                };
                state.enteredCount += 1;
                state.totalCosts += entryFee + entrySlippage;
                state.desiredAsset = destination;
                state.pendingDecisionTimeSec = null;
                state.pendingSell = null;
                state.pendingBuy = null;
                state.buyOrderFromSec = null;
                if (tradeRecord) onTradeOpened(tradeRecord);
                changed = true;
            }
        }
    };
    const processPendingThrough = (throughSec: number): void | Promise<void> => {
        if (state.failed) return;
        const saleDue = state.position !== null
            && state.pendingSell !== null
            && state.pendingSell.timeSec <= throughSec;
        const buyDue = state.position === null
            && state.desiredAsset !== null
            && state.pendingBuy !== null
            && state.pendingBuy.timeSec <= throughSec;
        return saleDue || buyDue ? processPendingThroughAsync(throughSec) : undefined;
    };
    return { field, state, schedule, processPendingThrough };
}

export async function runAssetSwitchReplay(args: {
    views: readonly AssetSwitchDecision[];
    assetNames: readonly string[];
    options: RunOpenScoreUsdReplayOptions;
    slippageRate: number;
    commissionRate: number;
    onPhase: ReplayPhaseCallback;
    shouldStop: () => boolean;
    pairCount: number;
    assetCount: number;
    selectedAssets?: ReadonlySet<string>;
}): Promise<StageOutcome<AssetSwitchReplaySummary>> {
    const { views, assetNames, options, slippageRate, commissionRate, onPhase, shouldStop, pairCount, assetCount } = args;
    if (!options.loadTargetDataset) throw new Error("Asset-switch replay requires the lazy loadTargetDataset source.");
    const intervalSec = parseIntervalSeconds(options.interval ?? "");
    if (!intervalSec) throw new Error("Asset-switch replay requires a valid interval for closed-candle window clipping.");
    const cutoffSec = Number.isFinite(options.evaluationCutoffSec) ? options.evaluationCutoffSec! : Math.floor(Date.now() / 1000);
    const requestedEndSec = Number.isFinite(options.sampleToSec) ? options.sampleToSec! : cutoffSec;
    const windowEndSec = Math.min(requestedEndSec, cutoffSec);
    const windowStartSec = Number.isFinite(options.sampleFromSec) ? options.sampleFromSec! : null;
    const lookup = new SwitchTargetLookup(options.loadTargetDataset, windowEndSec, intervalSec);
    const selectedAssets = args.selectedAssets;
    if (!selectedAssets) {
        const scannedAssets = new Set<string>();
        for (const view of views) {
            for (const arm of REPLAY_ARM_FIELDS) {
                const selectedIndex = view.picks[arm];
                if (selectedIndex !== null) scannedAssets.add(assetNames[selectedIndex] ?? "");
            }
        }
        options.prefetchTargetDatasets?.([...scannedAssets].filter(Boolean));
    } else {
        options.prefetchTargetDatasets?.([...selectedAssets]);
    }

    const retainTradeRows = options.includeEventDetails === true || typeof options.onAssetSwitchTrade === "function";
    const detailsByArm = options.includeEventDetails
        ? new Map(REPLAY_ARM_FIELDS.map((field) => [field, new BoundedTradePreview(TRADE_DETAIL_LIMIT)] as const))
        : undefined;
    let tradeCount = 0;
    const onTradeOpened = (row: AssetSwitchTradeRecord): void => {
        tradeCount += 1;
        detailsByArm?.get(row.arm)?.push(row);
    };
    const onTradeFinalized = async (row: AssetSwitchTradeRecord): Promise<void> => {
        await options.onAssetSwitchTrade?.(row);
    };
    const runtimes = REPLAY_ARM_FIELDS.map((field) => createArmRuntime({
        field,
        lookup,
        assetNames,
        slippageRate,
        commissionRate,
        includeContributorSummary: options.includeAssetSwitchContributorSummary === true,
        retainTradeRows,
        onTradeOpened,
        onTradeFinalized,
    }));
    const totalSteps = views.length * runtimes.length;
    onPhase("switch", "simulating asset-switch positions", 0, totalSteps);
    for (let eventIndex = 0; eventIndex < views.length; eventIndex += 1) {
        if (shouldStop()) {
            return { ok: false, earlyExit: {
                reportLine: "OPEN_SCORE USD | cancelled during asset-switch replay.",
                pairs: pairCount, assets: assetCount, totalEvents: views.length,
            } };
        }
        const view = views[eventIndex]!;
        for (const runtime of runtimes) {
            const pendingWork = runtime.processPendingThrough(view.timeSec);
            if (pendingWork) await pendingWork;
            if (!runtime.state.failed) {
                const scheduleWork = runtime.schedule(view.picks[runtime.field], view.timeSec);
                if (scheduleWork) await scheduleWork;
            }
        }
        if (eventIndex % 500 === 499) {
            const completed = (eventIndex + 1) * runtimes.length;
            onPhase("switch", `processed ${eventIndex + 1}/${views.length} decisions across ${runtimes.length} arms`, completed, totalSteps);
            await yieldLoop();
        }
    }

    for (const runtime of runtimes) {
        if (!runtime.state.failed) {
            const pendingWork = runtime.processPendingThrough(windowEndSec);
            if (pendingWork) await pendingWork;
        }
        const { state } = runtime;
        if (!state.failed && !state.position && state.pendingDecisionTimeSec !== null && state.desiredAsset) {
            await validatePendingBuyAtEnd(
                state,
                lookup,
                state.desiredAsset,
                state.buyOrderFromSec ?? state.pendingDecisionTimeSec,
                windowEndSec,
                intervalSec,
            );
        }
    }
    const finalArms = {} as AssetSwitchReplaySummary["arms"];
    for (const runtime of runtimes) {
        const { field, state } = runtime;
        let openPosition: AssetSwitchOpenPosition | null = null;
        let openPnl: number | null = state.enteredCount > 0 && state.position === null ? 0 : null;
        if (state.position) {
            const position = state.position;
            openPosition = {
                asset: position.asset,
                entryDecisionTimeSec: position.decisionTimeSec,
                entryTimeSec: position.entryTimeSec,
                entryPrice: position.entryPrice,
                markTimeSec: null,
                markPrice: null,
                markAgeSec: null,
                openNetPnl: null,
                entryCost: position.entryFee + position.entrySlippage,
                holdingDurationSec: null,
            };
            if (!state.failed) {
                const response = await lookup.last(position.asset, windowEndSec);
                if (response.status !== "ok") {
                    markArmIncompleteForLookup(state, response);
                    addDiagnostic(state, "unvaluedPosition");
                } else if (!response.point || response.point.timeSec < position.entryTimeSec) {
                    addDiagnostic(state, "unvaluedPosition");
                } else if (!finitePositive(response.point.close)) {
                    addDiagnostic(state, "invalidPrice");
                } else {
                    const point = response.point;
                    const markTimeSec = point.timeSec + intervalSec;
                    const age = Math.max(0, windowEndSec - markTimeSec);
                    if (age > GAP_THRESHOLD_SEC) addDiagnostic(state, "staleMark");
                    if (await checkGap(state, lookup, position.asset, position.entryTimeSec, point.timeSec)) {
                        openPnl = position.quantity * (point.close - position.entryPrice) - position.entryFee;
                        openPosition = {
                            ...openPosition,
                            markTimeSec,
                            markPrice: point.close,
                            markAgeSec: age,
                            openNetPnl: openPnl,
                            holdingDurationSec: Math.max(0, markTimeSec - position.entryTimeSec),
                        };
                        if (position.tradeRecord) {
                            position.tradeRecord.holdingDurationSec = Math.max(0, markTimeSec - position.entryTimeSec);
                            position.tradeRecord.netPnl = openPnl;
                        }
                    }
                }
            }
            if (position.tradeRecord) await onTradeFinalized(position.tradeRecord);
        }
        const pendingOrder: AssetSwitchPendingOrder | null = state.pendingDecisionTimeSec === null
            ? null
            : {
                side: state.position ? "sell" : "buy",
                destinationAsset: state.desiredAsset,
                decisionTimeSec: state.pendingDecisionTimeSec,
                scheduledTimeSec: state.position ? state.pendingSell?.timeSec ?? null : state.pendingBuy?.timeSec ?? null,
            };
        const status = state.failed ? "incomplete" : state.enteredCount === 0 ? "no_entry" : "complete";
        const rankable = status === "complete";
        let topContributorExclusion: AssetSwitchArmSummary["topContributorExclusion"];
        if (rankable && state.realizedNetPnlByAsset && openPnl !== null && Number.isFinite(openPnl)) {
            const netPnlByAsset = new Map(state.realizedNetPnlByAsset);
            if (state.position) {
                netPnlByAsset.set(
                    state.position.asset,
                    (netPnlByAsset.get(state.position.asset) ?? 0) + openPnl,
                );
            }
            let topAsset: string | null = null;
            let topContribution = Number.NEGATIVE_INFINITY;
            for (const [asset, contribution] of netPnlByAsset) {
                if (!Number.isFinite(contribution)) continue;
                if (contribution > topContribution
                    || (contribution === topContribution && topAsset !== null && asset.localeCompare(topAsset) < 0)) {
                    topAsset = asset;
                    topContribution = contribution;
                }
            }
            if (topAsset !== null) {
                const realizedContribution = state.realizedNetPnlByAsset.get(topAsset) ?? 0;
                const openContribution = state.position?.asset === topAsset ? openPnl : 0;
                const adjustedTotalNetPnl = state.realizedNetPnl + openPnl - topContribution;
                const adjustedRealizedNetPnl = state.realizedNetPnl - realizedContribution;
                const adjustedOpenPositionNetPnl = openPnl - openContribution;
                if ([adjustedTotalNetPnl, adjustedRealizedNetPnl, adjustedOpenPositionNetPnl].every(Number.isFinite)) {
                    topContributorExclusion = {
                        asset: topAsset,
                        contributionNetPnl: topContribution,
                        adjustedTotalNetPnl,
                        adjustedRealizedNetPnl,
                        adjustedOpenPositionNetPnl,
                    };
                }
            }
        }
        finalArms[field] = {
            status,
            enteredCount: state.enteredCount,
            completedTrades: state.completedTrades,
            realizedNetPnl: rankable ? state.realizedNetPnl : null,
            openPositionNetPnl: openPnl,
            totalNetPnl: rankable ? state.realizedNetPnl + (openPnl ?? 0) : null,
            partialRealizedNetPnl: state.realizedNetPnl,
            completedHoldingDurationSec: state.completedHoldingDurationSec,
            averageCompletedHoldingDurationSec: state.completedTrades > 0 ? state.completedHoldingDurationSec / state.completedTrades : null,
            totalCosts: state.totalCosts,
            openPosition,
            pendingOrder,
            ...(topContributorExclusion ? { topContributorExclusion } : {}),
            diagnosticCounts: { ...state.diagnostics },
        };
    }
    if (shouldStop()) {
        return { ok: false, earlyExit: {
            reportLine: "OPEN_SCORE USD | cancelled during asset-switch replay.",
            pairs: pairCount, assets: assetCount, totalEvents: views.length,
        } };
    }
    const details = detailsByArm
        ? REPLAY_ARM_FIELDS.flatMap((field) => detailsByArm.get(field)!.values())
        : undefined;
    onPhase("switch", "finished asset-switch replay", totalSteps, totalSteps);
    return {
        ok: true,
        result: {
            semanticsVersion: "asset_switch.v1",
            decisionCount: views.length,
            windowStartSec,
            windowEndSec,
            independentWindow: options.independentWindow === true,
            sizing: "fixed_entry_notional_non_compounding",
            notionalPerEntry: NOTIONAL_PER_ENTRY,
            slippageRate,
            commissionRate,
            valuation: "last_closed_candle_close_at_or_before_window_end",
            coverage: lookup.coverage,
            arms: finalArms,
            ...(details ? { trades: details, tradeCount } : retainTradeRows ? { tradeCount } : {}),
        },
    };
}
