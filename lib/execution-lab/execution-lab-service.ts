import { ensureLazyStylesheet } from "../lazy-styles";
import type { SeriesMarker, Time } from "lightweight-charts";
import { loadBuiltInStrategyByKey, strategyRegistry } from "../../strategyRegistry";
import { getBacktestSettings, getCapitalSettings } from "../backtest-settings-reader";
import { executeBacktest } from "../backtest-executor";
import { chartManager, type ExecutionLabPolymarketPricePoint } from "../chart-manager";
import { ENHANCED_CANDLE_COLORS } from "../constants";
import { debugLogger } from "../debug-logger";
import { paramManager } from "../param-manager";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import { getEffectivePolymarketSeriesId, resolvePolymarketOutcomeSymbol } from "../polymarket-btc5m";
import { resolvePolymarketDomSettings } from "../polymarket-dom-reader";
import { getPolymarketEntryPriceFilterBounds } from "../polymarket-entry-price-filter";
import { resolvePolymarketEntryCutoff } from "../polymarket-entry-cutoff";
import { isSameEventPolymarketExitMode, resolveEffectivePolymarketExitMode } from "../polymarket-exit-mode";
import {
    DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_CENTS,
    DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_ENABLED,
    DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_CENTS,
    DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_ENABLED,
    clampPolymarketProtectionCents,
    resolvePolymarketProtectionSettingFields,
    type PolymarketProtectionSettingFields,
} from "../polymarket-protection-settings";
import { normalizeSecondMarketChartSymbol } from "../second-market/api";
import type { PolymarketClob1sQuoteRow, SecondMarketPolymarketEvent, SecondMarketSide, SecondMarketSymbol } from "../second-market/types";
import { state } from "../state";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { BacktestSettings, OHLCVData, Strategy, Trade } from "../types/strategies";
import { uiManager } from "../ui-manager";
import {
    appendExecutionLabRecords,
    loadExecutionLabMinerStatus,
    loadExecutionLabLiveCandles,
    loadExecutionLabLiveEvents,
    loadExecutionLabLiveOutcomes,
    loadExecutionLabLiveQuote,
    loadExecutionLabLiveExecutorStatus,
    resolveExecutionLabLiveConfig,
    loadExecutionLabStoredQuotes,
    startExecutionLabMiner,
    startExecutionLabSession,
    stopExecutionLabMiner,
    submitExecutionLabLiveCancelAll,
    submitExecutionLabLiveTrade,
    type ExecutionLabLiveCandle,
    type ExecutionLabMinerStatus,
} from "./execution-lab-api";
import { queryExecutionLabDom, type ExecutionLabDom } from "./execution-lab-dom";
import {
    collectEntryPriceFilterParityMismatches,
    type ExecutionParityMismatch,
} from "./execution-parity";
import {
    EXECUTION_LAB_DEFAULT_STAKE_USD,
    EXECUTION_LAB_SETTINGS_STORAGE_KEY,
    type ExecutionLabLiveUiConfig,
    type ExecutionLabEvaluatedSignal,
    type ExecutionLabOpenPaperPosition,
    type PaperUnfilledRecord,
    type ExecutionLabPaperMarker,
    type ExecutionLabPaperState,
    type ExecutionLabRecord,
    type ExecutionLabSessionSnapshot,
    type ExecutionParityMismatchRecord,
    type LiveCancelAllResultRecord,
    type LiveCancelAllSubmitRequest,
    type LiveCancelAllSubmitResponse,
    type LiveEntrySubmitRequest,
    type LiveExecutorStatus,
    type LiveExitResultRecord,
    type LiveExitSubmitRequest,
    type LiveTakeProfitSubmitRequest,
    type LiveTradeSubmitResponse,
    type LiveTradeSizingMode,
    type LiveTradeResultRecord,
    type PaperExitRecord,
} from "./execution-lab-model";
import {
    LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS,
    LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS,
    LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE,
    LIVE_TRADE_DEFAULT_ORDER_TYPE,
    EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG,
    buildLiveCancelAllFailureResponse,
    buildLiveCancelAllRequestId,
    buildLiveCancelAllRequestRecord,
    buildLiveCancelAllResultRecord,
    buildLiveExitRequestRecord,
    buildLiveExitResultRecord,
    buildLiveExitSubmitRequest,
    buildLiveTakeProfitSubmitRequest,
    buildLiveTradeFailureResponse,
    buildLiveTradeRequestRecord,
    buildLiveTradeResultRecord,
    buildLiveTradeSubmitRequest,
    isLiveTradeGeoblockReason,
    normalizeExecutionLabLiveUiConfig,
    resolveLiveExitFloorPreflight,
    resolveLiveExitShareUpdate,
    resolveLiveTradeFilledShares,
    shouldAttemptLiveExitAfterLimitCancel,
} from "./live-trade-request";
import {
    buildEvaluatedSignals,
    createExecutionLabPaperState,
    createSessionStartRecord,
    createSessionStopRecord,
    evaluateExecutionLabPaperTick,
} from "./paper-session";
import { executionLabErrorMessage, isExecutionLabTransientPollError } from "./poll-errors";
import { buildExecutionLabStrategyExecutionContext } from "./execution-lab-strategy-context";
import { collectExecutionLabTradeQuoteTimes } from "./trade-quote-times";
import { mergeExecutionLabCandles, mergeExecutionLabQuotes, sortedMapValues } from "./execution-lab-buffers";
import { computeExecutionLabPerformanceMetrics, type ExecutionLabPerformanceMetrics } from "./execution-lab-metrics";
import {
    buildExecutionLabDiagnostics,
    createExecutionLabDiagnosticAccumulator,
    recordExecutionLabDiagnosticStats,
    resolveExecutionLabCandleSequenceWarning,
    type ExecutionLabDiagnosticAccumulator,
    type ExecutionLabDiagnostics,
    type ExecutionLabDiagnosticSample,
} from "./execution-lab-diagnostics";
import { settingsManager, sortStrategyConfigsNewestFirst } from "../settings-manager";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import type { CapitalSettings } from "../types/backtest";

const SETTINGS_SCHEMA = "execution-lab.settings";
const SETTINGS_VERSION = 2;
const POLL_MS = 1000;
const LIVE_CANDLE_CLOSED_LAG_SEC = 1;
const INITIAL_CANDLE_LIMIT = 900;
const MAX_STREAM_CANDLES = 20000;
const MAX_LIVE_CANDLE_LAG_SEC = 10;
const MAX_POLYMARKET_PRICE_POINTS = 3600;
const MAX_EXECUTION_LAB_DIAGNOSTIC_SAMPLES = 300;
const MAX_EXECUTION_LAB_DIAGNOSTIC_EXPORT_SEGMENTS = 12;
const MIN_LIVE_POSITION_SHARES = 0.000001;
const LIVE_EXIT_RETRY_COOLDOWN_SEC = 1;

type LivePollFetchResult<T> = { ok: true; value: T } | { ok: false };
type ComparisonSource = "original" | "current" | "saved";
type LiveExitPlan = {
    exitTimeSec: number;
    paperExitPrice: number;
    attempts: number;
    nextAttemptAtSec: number;
};
type LiveOpenExecutionPosition = {
    entryRequestId: string;
    paperTradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: SecondMarketSide;
    signalTimeSec: number;
    entryTimeSec: number;
    entryPrice: number;
    remainingShares: number;
    entryOrderId?: string;
    takeProfitRequestId?: string;
    takeProfitOrderId?: string;
    takeProfitPrice?: number;
    takeProfitStatus?: string;
    lastExitStatus?: string;
    lastExitReason?: string;
    pendingExit?: LiveExitPlan;
};
type PendingLimitSubmission = {
    requestId: string;
    paperTradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: SecondMarketSide;
    signalTimeSec: number;
    entryTimeSec: number;
    entryPrice: number;
    submittedShares?: number;
    limitPrice: number;
    orderId?: string;
    lastStatus: string;
};
type PendingTakeProfitSubmission = {
    requestId: string;
    entryRequestId: string;
    paperTradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: SecondMarketSide;
    signalTimeSec: number;
    entryTimeSec: number;
    entryPrice: number;
    shares: number;
    limitPrice: number;
    orderId?: string;
    lastStatus: string;
};
type PendingRestingSubmission = PendingLimitSubmission | PendingTakeProfitSubmission;
type LiveExitTriggerRecord = PaperExitRecord | PaperUnfilledRecord;
type LiveResultView =
    | { action: "entry"; record: LiveTradeResultRecord }
    | { action: "take_profit"; record: LiveTradeResultRecord }
    | { action: "exit"; record: LiveExitResultRecord }
    | { action: "cancel"; record: LiveCancelAllResultRecord };
type ExecutionLabPollTiming = Record<string, number>;
type ComparisonCandidate = {
    label: string;
    strategyKey: string;
    strategyName: string;
    strategy: Strategy;
    params: Record<string, number>;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
};
type ComparisonResult = {
    metrics: ExecutionLabPerformanceMetrics;
    totalEntries: number;
};
type ExecutionLabStreamContext = {
    symbol: SecondMarketSymbol;
    outcomeSymbol: SecondMarketSymbol | null;
    outcomeInterval: ExecutionLabSessionSnapshot["outcomeInterval"];
    seriesId: string | null;
    marketType: "spot" | "futures";
};
type ExecutionLabSignalState = "buy-up" | "neutral" | "buy-down";
type ExecutionLabPaperDecision = {
    kind: "accepted" | "rejected";
    signalState: ExecutionLabSignalState;
    side: SecondMarketSide | null;
    status: string;
    reason: string;
    quote: string;
    rejectedEntry: string | null;
};
type ExecutionLabExecutionMode = "paper" | "live";
type ExecutionLabPersistedSettings = {
    stakeUsd: number;
    liveConfig: ExecutionLabLiveUiConfig;
    protectionConfig: PolymarketProtectionSettingFields;
};

const DEFAULT_EXECUTION_LAB_PROTECTION_CONFIG: PolymarketProtectionSettingFields = {
    polymarketProtectionTakeProfitEnabled: DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_ENABLED,
    polymarketProtectionTakeProfitCents: DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_CENTS,
    polymarketProtectionStopLossEnabled: DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_ENABLED,
    polymarketProtectionStopLossCents: DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_CENTS,
};

function finiteUnixSeconds(time: OHLCVData["time"]): number | null {
    const seconds = parseTimeToUnixSeconds(time);
    return seconds === null || !Number.isFinite(seconds) ? null : Math.floor(seconds);
}

function formatDateTime(ts: number | null | undefined): string {
    if (ts === null || ts === undefined || !Number.isFinite(ts)) return "--";
    return new Date(Math.floor(ts) * 1000).toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

function formatPolyPrice(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toFixed(3);
}

function formatMoney(value: number): string {
    if (value > 0) return `+$${value.toFixed(2)}`;
    if (value < 0) return `-$${Math.abs(value).toFixed(2)}`;
    return "$0.00";
}

function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}

function formatSignedUsdNullable(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "--";
    return formatMoney(value);
}

function formatPercentNullable(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "--" : `${value.toFixed(1)}%`;
}

function formatRatioNullable(value: number | null): string {
    if (value === null || Number.isNaN(value)) return "--";
    if (value === Number.POSITIVE_INFINITY) return "Inf";
    return value.toFixed(2);
}

function formatSeconds(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "--" : `${Math.floor(value)}s`;
}

function formatSignedSeconds(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return "--";
    if (value > 0) return `+${Math.floor(value)}s`;
    return `${Math.floor(value)}s`;
}

function liveCandleLagSec(latestTs: number): number {
    return Math.max(0, Math.floor(Date.now() / 1000) - latestTs);
}

function liveLagMessage(latestTs: number, lagSec: number): string {
    return `Live Binance 1s feed is lagging: latest ${formatDateTime(latestTs)} (${formatSeconds(lagSec)} lag).`;
}

function quoteMid(bid: number | null, ask: number | null, mid: number | null): number | null {
    if (mid !== null && Number.isFinite(mid)) return mid;
    if (bid !== null && ask !== null && Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
    if (bid !== null && Number.isFinite(bid)) return bid;
    if (ask !== null && Number.isFinite(ask)) return ask;
    return null;
}

function signalSide(signalType: ExecutionLabEvaluatedSignal["signalType"]): "YES" | "NO" {
    return signalType === "buy" ? "YES" : "NO";
}

function signalTypeToState(signalType: ExecutionLabEvaluatedSignal["signalType"]): ExecutionLabSignalState {
    return signalType === "buy" ? "buy-up" : "buy-down";
}

function sideToSignalState(side: SecondMarketSide | null | undefined): ExecutionLabSignalState {
    return side === "yes" ? "buy-up" : side === "no" ? "buy-down" : "neutral";
}

function formatDecisionSide(side: SecondMarketSide | null | undefined): string {
    return side === "yes" ? "Buy Up / YES" : side === "no" ? "Buy Down / NO" : "--";
}

function formatLiveStatus(status: string): string {
    return status.replace(/_/g, " ");
}

function liveUiConfigKey(config: ExecutionLabLiveUiConfig): string {
    return [
        config.orderMode,
        config.takerOrderType,
        config.sizingMode,
        config.maxStakeUsd,
        config.entryMaxSlippageCents,
        config.exitMaxSlippageCents,
        config.limitOffsetEnabled ? 1 : 0,
        config.limitOffsetCents,
        config.limitFixedPriceEnabled ? 1 : 0,
        config.limitFixedPriceCents,
        config.limitCancelAllOnExitEnabled ? 1 : 0,
    ].join("|");
}

function formatCents(value: number): string {
    return `${(value * 100).toFixed(1)}c`;
}

function formatConfiguredCents(value: unknown): string {
    return `${clampPolymarketProtectionCents(value).toFixed(1)}c`;
}

function formatProtectionSummary(settings: Partial<PolymarketProtectionSettingFields>): string | null {
    const parts: string[] = [];
    if (settings.polymarketProtectionTakeProfitEnabled === true) {
        parts.push(`TP ${formatConfiguredCents(settings.polymarketProtectionTakeProfitCents)}`);
    }
    if (settings.polymarketProtectionStopLossEnabled === true) {
        parts.push(`SL ${formatConfiguredCents(settings.polymarketProtectionStopLossCents)}`);
    }
    return parts.length > 0 ? parts.join("/") : null;
}

function quotePriceForSide(
    quote: PolymarketClob1sQuoteRow | null,
    side: SecondMarketSide | null,
    priceSide: "entry" | "exit"
): number | null {
    if (!quote || !side) return null;
    const value = side === "yes"
        ? (priceSide === "entry" ? quote.yes_ask : quote.yes_bid)
        : (priceSide === "entry" ? quote.no_ask : quote.no_bid);
    return value !== null && Number.isFinite(value) ? value : null;
}

function normalizeStake(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1
        ? Math.round(parsed * 100) / 100
        : EXECUTION_LAB_DEFAULT_STAKE_USD;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeExecutionLabProtectionConfig(
    value: unknown,
    fallback: PolymarketProtectionSettingFields = DEFAULT_EXECUTION_LAB_PROTECTION_CONFIG
): PolymarketProtectionSettingFields {
    const raw = isPlainRecord(value) ? value : {};
    return resolvePolymarketProtectionSettingFields({
        ...fallback,
        ...raw,
    });
}

function readPersistedSettings(): ExecutionLabPersistedSettings {
    return readPersistedJson({
        key: EXECUTION_LAB_SETTINGS_STORAGE_KEY,
        schema: SETTINGS_SCHEMA,
        version: SETTINGS_VERSION,
        fallback: {
            stakeUsd: EXECUTION_LAB_DEFAULT_STAKE_USD,
            liveConfig: EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG,
            protectionConfig: DEFAULT_EXECUTION_LAB_PROTECTION_CONFIG,
        },
        migrate: ({ data }) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;
            const record = data as { stakeUsd?: unknown; liveConfig?: unknown; protectionConfig?: unknown };
            return {
                stakeUsd: normalizeStake(record.stakeUsd),
                liveConfig: normalizeExecutionLabLiveUiConfig(record.liveConfig),
                protectionConfig: normalizeExecutionLabProtectionConfig(record.protectionConfig),
            };
        },
    });
}

function writePersistedSettings(settings: ExecutionLabPersistedSettings): void {
    writePersistedJson({
        key: EXECUTION_LAB_SETTINGS_STORAGE_KEY,
        schema: SETTINGS_SCHEMA,
        version: SETTINGS_VERSION,
        data: settings,
    });
}

export class ExecutionLabService {
    private dom: ExecutionLabDom | null = null;
    private initialized = false;
    private running = false;
    private starting = false;
    private polling = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private streamTimer: ReturnType<typeof setInterval> | null = null;
    private candleRefreshPromise: Promise<OHLCVData[]> | null = null;
    private minerChartTimer: ReturnType<typeof setInterval> | null = null;
    private minerChartStarting = false;
    private minerChartRefreshPromise: Promise<void> | null = null;
    private minerChartContext: ExecutionLabStreamContext | null = null;
    private minerStatusTimer: ReturnType<typeof setInterval> | null = null;
    private liveExecutorStatusTimer: ReturnType<typeof setInterval> | null = null;
    private snapshot: ExecutionLabSessionSnapshot | null = null;
    private paperState: ExecutionLabPaperState | null = null;
    private strategy: Strategy | null = null;
    private candles: OHLCVData[] = [];
    private markerById = new Map<string, SeriesMarker<Time>>();
    private logPath: string | null = null;
    private latestSignals: ExecutionLabEvaluatedSignal[] = [];
    private latestPaperDecision: ExecutionLabPaperDecision | null = null;
    private latestQuote: PolymarketClob1sQuoteRow | null = null;
    private feedLagSec: number | null = null;
    private liveEvents: SecondMarketPolymarketEvent[] = [];
    private liveQuoteByTime = new Map<number, PolymarketClob1sQuoteRow>();
    private strategyQuoteByTime = new Map<number, PolymarketClob1sQuoteRow>();
    private polymarketPriceByTime = new Map<number, ExecutionLabPolymarketPricePoint>();
    private executionParityOk: boolean | null = null;
    private executionMismatchTotal = 0;
    private latestExecutionMismatch: ExecutionParityMismatch | null = null;
    private loggedExecutionMismatchKeys = new Set<string>();
    private diagnosticSamples: ExecutionLabDiagnosticSample[] = [];
    private diagnosticStats: ExecutionLabDiagnosticAccumulator = createExecutionLabDiagnosticAccumulator();
    private comparisonRunning = false;
    private latestComparison: ComparisonResult | null = null;
    private sessionStartCandleTimeSec: number | null = null;
    private executionMode: ExecutionLabExecutionMode = "paper";
    private liveUiConfig: ExecutionLabLiveUiConfig = EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG;
    private protectionUiConfig: PolymarketProtectionSettingFields = DEFAULT_EXECUTION_LAB_PROTECTION_CONFIG;
    private sessionLiveUiConfig: ExecutionLabLiveUiConfig | null = null;
    private liveTradeInFlightByPaperTradeId = new Set<string>();
    private liveTradeSubmittedByPaperTradeId = new Set<string>();
    private liveExitInFlightByPaperTradeId = new Set<string>();
    private liveOpenPositionByPaperTradeId = new Map<string, LiveOpenExecutionPosition>();
    private pendingLimitSubmissionByRequestId = new Map<string, PendingLimitSubmission>();
    private pendingLimitSubmissionByPaperTradeId = new Map<string, PendingLimitSubmission>();
    private queuedTakeProfitSubmissionByPaperTradeId = new Map<string, {
        position: LiveOpenExecutionPosition;
        sessionToken: number;
    }>();
    private liveTakeProfitInFlightByPaperTradeId = new Set<string>();
    private pendingTakeProfitSubmissionByRequestId = new Map<string, PendingTakeProfitSubmission>();
    private pendingTakeProfitSubmissionByPaperTradeId = new Map<string, PendingTakeProfitSubmission>();
    private liveCancelInFlightByKey = new Set<string>();
    private liveCancelSubmittedByKey = new Set<string>();
    private latestLiveTradeResult: LiveTradeResultRecord | null = null;
    private latestLiveExitResult: LiveExitResultRecord | null = null;
    private latestLiveCancelResult: LiveCancelAllResultRecord | null = null;
    private latestLiveExecutorStatus: LiveExecutorStatus | null = null;
    private latestLiveExecutorStatusConfigKey = "";
    private liveSubmissionBlockedReason: string | null = null;
    private liveStatusRefreshToken = 0;
    private sessionRunToken = 0;

    init(): void {
        ensureLazyStylesheet("execution-lab-styles", new URL("../../styles/execution-lab.css", import.meta.url).href);
        if (this.initialized) return;
        this.initialized = true;
        this.dom = queryExecutionLabDom();
        const settings = readPersistedSettings();
        this.liveUiConfig = settings.liveConfig;
        this.protectionUiConfig = settings.protectionConfig;
        this.dom.stakeInput.value = String(settings.stakeUsd);
        this.applyLiveUiConfigToDom(this.liveUiConfig);
        this.applyProtectionUiConfigToDom(this.protectionUiConfig);
        this.dom.executionMode.value = "paper";
        this.syncExecutionMode();
        this.syncLiveConfigControls();
        this.syncProtectionConfigControls();
        this.syncSavedConfigOptions();
        this.bindEvents();
        this.renderIdle();
        void this.refreshMinerStatus();
        void this.refreshLiveExecutorStatus();
        this.startStatusTimers();
    }

    public dispose(): void {
        this.stopStatusTimers();
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.stopStreamTimer();
        this.stopMinerChartStream(false);
        this.candleRefreshPromise = null;
    }

    private startStatusTimers(): void {
        this.stopStatusTimers();
        this.minerStatusTimer = setInterval(() => void this.refreshMinerStatus(), 5000);
        this.liveExecutorStatusTimer = setInterval(() => void this.refreshLiveExecutorStatus(), 5000);
    }

    private stopStatusTimers(): void {
        if (this.minerStatusTimer) {
            clearInterval(this.minerStatusTimer);
            this.minerStatusTimer = null;
        }
        if (this.liveExecutorStatusTimer) {
            clearInterval(this.liveExecutorStatusTimer);
            this.liveExecutorStatusTimer = null;
        }
    }

    async startPaper(): Promise<void> {
        await this.startExecutionSession("paper");
    }

    private async startExecutionSession(mode: ExecutionLabExecutionMode): Promise<void> {
        if (this.running || this.starting) return;
        this.init();
        this.starting = true;
        try {
            this.executionMode = mode;
            if (mode === "live" && !this.confirmLiveStart()) {
                return;
            }
            this.stopMinerChartStream(false);
            this.resetSessionState();
            this.setStatus(mode === "live" ? "Starting Live Trade" : "Starting");
            if (mode === "live") {
                await this.refreshLiveExecutorStatus();
            }
            const prepared = await this.prepareSession();
            this.snapshot = prepared.snapshot;
            this.paperState = createExecutionLabPaperState(prepared.snapshot);
            this.strategy = prepared.strategy;
            this.logPath = prepared.logPath;
            await this.appendRecords([
                createSessionStartRecord(
                    prepared.snapshot,
                    mode === "live" ? this.activeLiveUiConfig() : undefined
                ),
            ]);
            this.candles = await this.loadInitialCandles(prepared.snapshot.symbol);
            this.liveEvents = await loadExecutionLabLiveEvents({
                symbol: prepared.snapshot.outcomeSymbol,
                outcomeInterval: prepared.snapshot.outcomeInterval,
                seriesId: prepared.snapshot.seriesId,
            });
            if (this.candles.length === 0) throw new Error("No live Binance 1s candles available for the selected symbol.");

            const latestInitialTs = this.getLastBufferedTs();
            if (latestInitialTs === null) throw new Error("No valid 1s candle timestamps available for the selected symbol.");
            const initialLagSec = liveCandleLagSec(latestInitialTs);
            if (initialLagSec > MAX_LIVE_CANDLE_LAG_SEC) throw new Error(liveLagMessage(latestInitialTs, initialLagSec));

            this.paperState.lastProcessedCandleTimeSec = latestInitialTs;
            this.sessionStartCandleTimeSec = latestInitialTs;
            this.setRunningState(true);
            this.render();
            chartManager.clearTradeMarkers();
            chartManager.displayPaperStreamData(this.candles);
            this.startStreamTimer();
            this.timer = setInterval(() => void this.poll(), POLL_MS);
            await this.poll();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (this.paperState) {
                await this.stop("error", message);
            } else {
                this.setRunningState(false);
                this.sessionLiveUiConfig = null;
                this.restoreStateChart();
                this.setStatus(message, "error");
                this.renderIdle();
            }
        } finally {
            this.starting = false;
        }
    }

    private resetSessionState(): void {
        this.sessionRunToken += 1;
        this.snapshot = null;
        this.paperState = null;
        this.strategy = null;
        this.candles = [];
        this.candleRefreshPromise = null;
        this.logPath = null;
        this.liveEvents = [];
        chartManager.clearExecutionLabMarkers();
        chartManager.clearExecutionLabPolymarketPrices();
        this.markerById.clear();
        this.latestSignals = [];
        this.latestPaperDecision = null;
        this.latestQuote = null;
        this.feedLagSec = null;
        this.liveQuoteByTime.clear();
        this.strategyQuoteByTime.clear();
        this.polymarketPriceByTime.clear();
        this.executionParityOk = null;
        this.executionMismatchTotal = 0;
        this.latestExecutionMismatch = null;
        this.loggedExecutionMismatchKeys.clear();
        this.diagnosticSamples = [];
        this.diagnosticStats = createExecutionLabDiagnosticAccumulator();
        this.latestComparison = null;
        this.sessionStartCandleTimeSec = null;
        this.liveTradeInFlightByPaperTradeId.clear();
        this.liveTradeSubmittedByPaperTradeId.clear();
        this.liveExitInFlightByPaperTradeId.clear();
        this.liveOpenPositionByPaperTradeId.clear();
        this.pendingLimitSubmissionByRequestId.clear();
        this.pendingLimitSubmissionByPaperTradeId.clear();
        this.queuedTakeProfitSubmissionByPaperTradeId.clear();
        this.liveTakeProfitInFlightByPaperTradeId.clear();
        this.pendingTakeProfitSubmissionByRequestId.clear();
        this.pendingTakeProfitSubmissionByPaperTradeId.clear();
        this.liveCancelInFlightByKey.clear();
        this.liveCancelSubmittedByKey.clear();
        this.latestLiveTradeResult = null;
        this.latestLiveExitResult = null;
        this.latestLiveCancelResult = null;
        this.liveSubmissionBlockedReason = null;
        this.sessionLiveUiConfig = this.liveUiConfig;
        this.renderIdle();
    }

    private isSessionActive(sessionToken: number, snapshot: ExecutionLabSessionSnapshot): boolean {
        return this.running
            && this.sessionRunToken === sessionToken
            && this.snapshot?.sessionId === snapshot.sessionId;
    }

    private startStreamTimer(): void {
        this.stopStreamTimer();
        this.streamTimer = setInterval(() => void this.refreshCandleStreamInBackground(), POLL_MS);
    }

    private stopStreamTimer(): void {
        if (this.streamTimer) {
            clearInterval(this.streamTimer);
            this.streamTimer = null;
        }
    }

    private stopMinerChartStream(restoreChart = true): void {
        const wasStreaming = this.minerChartTimer !== null
            || this.minerChartContext !== null
            || this.minerChartStarting
            || this.minerChartRefreshPromise !== null;
        if (this.minerChartTimer) {
            clearInterval(this.minerChartTimer);
            this.minerChartTimer = null;
        }
        this.minerChartRefreshPromise = null;
        this.minerChartStarting = false;
        this.minerChartContext = null;
        if (!restoreChart || !wasStreaming) return;
        this.restoreStateChart();
        this.renderIdle();
    }

    private restoreStateChart(): void {
        chartManager.clearExecutionLabMarkers();
        chartManager.clearExecutionLabPolymarketPrices();
        chartManager.restoreStateChartData();
        if (state.currentBacktestResult) {
            chartManager.displayTradeMarkers(state.currentBacktestResult.trades, uiManager.formatPrice);
        }
    }

    private refreshCandleStreamInBackground(): void {
        void this.refreshCandleStream().catch((error: unknown) => {
            if (isExecutionLabTransientPollError(error)) {
                this.setStatus(`Live candle refresh skipped: ${executionLabErrorMessage(error)}`, "warning");
                this.render();
                return;
            }
            void this.stop("error", executionLabErrorMessage(error));
        });
    }

    private liveRecordContext(): { dryRun?: boolean; sizingMode?: LiveTradeSizingMode } {
        const status = this.currentLiveExecutorStatus();
        return {
            dryRun: status?.dryRun,
            sizingMode: status?.sizingMode,
        };
    }

    private maybeBlockLiveSubmissions(response: Pick<LiveTradeSubmitResponse, "reason">): void {
        if (!isLiveTradeGeoblockReason(response.reason)) return;
        this.liveSubmissionBlockedReason = response.reason ?? "geoblocked";
        this.renderLiveExecutorStatus(this.latestLiveExecutorStatus);
    }

    private currentLiveExecutorStatus(): LiveExecutorStatus | null {
        return this.latestLiveExecutorStatus
            && this.latestLiveExecutorStatusConfigKey === liveUiConfigKey(this.activeLiveUiConfig())
            ? this.latestLiveExecutorStatus
            : null;
    }

    private bindEvents(): void {
        const dom = this.dom;
        if (!dom) return;
        dom.startButton.addEventListener("click", () => void this.startExecutionSession(this.executionMode));
        dom.stopButton.addEventListener("click", () => void this.stop("user_stop"));
        dom.startMinerButton.addEventListener("click", () => void this.startMiner());
        dom.stopMinerButton.addEventListener("click", () => void this.stopMiner());
        dom.copyDiagnosticsButton.addEventListener("click", () => void this.copyDiagnostics());
        dom.executionMode.addEventListener("change", () => this.syncExecutionMode());
        dom.comparisonSource.addEventListener("change", () => this.syncComparisonControls());
        dom.runComparisonButton.addEventListener("click", () => void this.runComparison());
        dom.stakeInput.addEventListener("change", () => {
            dom.stakeInput.value = String(normalizeStake(dom.stakeInput.value));
            this.persistSettingsFromDom();
        });
        const syncLiveConfig = () => {
            this.liveUiConfig = this.readLiveUiConfigFromDom();
            this.applyLiveUiConfigToDom(this.liveUiConfig);
            this.syncLiveConfigControls();
            this.persistSettingsFromDom();
            void this.refreshLiveExecutorStatus();
        };
        dom.liveOrderMode.addEventListener("change", syncLiveConfig);
        dom.liveTakerOrderType.addEventListener("change", syncLiveConfig);
        dom.liveSizingMode.addEventListener("change", syncLiveConfig);
        dom.liveMaxStakeUsd.addEventListener("change", syncLiveConfig);
        dom.liveEntrySlippageCents.addEventListener("change", syncLiveConfig);
        dom.liveExitSlippageCents.addEventListener("change", syncLiveConfig);
        dom.liveLimitOffsetEnabled.addEventListener("change", syncLiveConfig);
        dom.liveLimitOffsetCents.addEventListener("change", syncLiveConfig);
        dom.liveLimitFixedPriceEnabled.addEventListener("change", syncLiveConfig);
        dom.liveLimitFixedPriceCents.addEventListener("change", syncLiveConfig);
        dom.liveLimitCancelAllOnExit.addEventListener("change", syncLiveConfig);
        const syncProtectionConfig = () => {
            this.protectionUiConfig = this.readProtectionUiConfigFromDom();
            this.applyProtectionUiConfigToDom(this.protectionUiConfig);
            this.syncProtectionConfigControls();
            this.persistSettingsFromDom();
        };
        dom.protectionTakeProfitEnabled.addEventListener("change", syncProtectionConfig);
        dom.protectionTakeProfitCents.addEventListener("change", syncProtectionConfig);
        dom.protectionStopLossEnabled.addEventListener("change", syncProtectionConfig);
        dom.protectionStopLossCents.addEventListener("change", syncProtectionConfig);
    }

    private activeLiveUiConfig(): ExecutionLabLiveUiConfig {
        return this.sessionLiveUiConfig ?? this.liveUiConfig;
    }

    private readLiveUiConfigFromDom(): ExecutionLabLiveUiConfig {
        const dom = this.dom;
        if (!dom) return this.liveUiConfig;
        return normalizeExecutionLabLiveUiConfig({
            orderMode: dom.liveOrderMode.value,
            takerOrderType: dom.liveTakerOrderType.value,
            sizingMode: dom.liveSizingMode.value,
            maxStakeUsd: dom.liveMaxStakeUsd.value,
            entryMaxSlippageCents: dom.liveEntrySlippageCents.value,
            exitMaxSlippageCents: dom.liveExitSlippageCents.value,
            limitOffsetEnabled: dom.liveLimitOffsetEnabled.checked,
            limitOffsetCents: dom.liveLimitOffsetCents.value,
            limitFixedPriceEnabled: dom.liveLimitFixedPriceEnabled.checked,
            limitFixedPriceCents: dom.liveLimitFixedPriceCents.value,
            limitCancelAllOnExitEnabled: dom.liveLimitCancelAllOnExit.checked,
        });
    }

    private applyLiveUiConfigToDom(config: ExecutionLabLiveUiConfig): void {
        const dom = this.dom;
        if (!dom) return;
        dom.liveOrderMode.value = config.orderMode;
        dom.liveTakerOrderType.value = config.takerOrderType;
        dom.liveSizingMode.value = config.sizingMode;
        dom.liveMaxStakeUsd.value = String(config.maxStakeUsd);
        dom.liveEntrySlippageCents.value = String(config.entryMaxSlippageCents);
        dom.liveExitSlippageCents.value = String(config.exitMaxSlippageCents);
        dom.liveLimitOffsetEnabled.checked = config.limitOffsetEnabled;
        dom.liveLimitOffsetCents.value = String(config.limitOffsetCents);
        dom.liveLimitFixedPriceEnabled.checked = config.limitFixedPriceEnabled;
        dom.liveLimitFixedPriceCents.value = String(config.limitFixedPriceCents);
        dom.liveLimitCancelAllOnExit.checked = config.limitCancelAllOnExitEnabled;
    }

    private readProtectionUiConfigFromDom(): PolymarketProtectionSettingFields {
        const dom = this.dom;
        if (!dom) return this.protectionUiConfig;
        return normalizeExecutionLabProtectionConfig({
            polymarketProtectionTakeProfitEnabled: dom.protectionTakeProfitEnabled.checked,
            polymarketProtectionTakeProfitCents: dom.protectionTakeProfitCents.value,
            polymarketProtectionStopLossEnabled: dom.protectionStopLossEnabled.checked,
            polymarketProtectionStopLossCents: dom.protectionStopLossCents.value,
        });
    }

    private applyProtectionUiConfigToDom(config: PolymarketProtectionSettingFields): void {
        const dom = this.dom;
        if (!dom) return;
        dom.protectionTakeProfitEnabled.checked = config.polymarketProtectionTakeProfitEnabled;
        dom.protectionTakeProfitCents.value = String(config.polymarketProtectionTakeProfitCents);
        dom.protectionStopLossEnabled.checked = config.polymarketProtectionStopLossEnabled;
        dom.protectionStopLossCents.value = String(config.polymarketProtectionStopLossCents);
    }

    private persistSettingsFromDom(): void {
        const dom = this.dom;
        if (!dom) return;
        writePersistedSettings({
            stakeUsd: normalizeStake(dom.stakeInput.value),
            liveConfig: this.liveUiConfig,
            protectionConfig: this.protectionUiConfig,
        });
    }

    private syncLiveConfigControls(): void {
        const dom = this.dom;
        if (!dom) return;
        const isLimit = this.liveUiConfig.orderMode === "limit";
        dom.liveLimitOffsetEnabled.disabled = this.running || !isLimit;
        dom.liveLimitOffsetCents.disabled = this.running || !isLimit || !this.liveUiConfig.limitOffsetEnabled;
        dom.liveLimitFixedPriceEnabled.disabled = this.running || !isLimit;
        dom.liveLimitFixedPriceCents.disabled = this.running || !isLimit || !this.liveUiConfig.limitFixedPriceEnabled;
        dom.liveLimitCancelAllOnExit.disabled = this.running || !isLimit;
        dom.liveTakerOrderType.disabled = this.running || isLimit;
        dom.liveEntrySlippageCents.disabled = this.running || isLimit;
        dom.liveOrderMode.disabled = this.running;
        dom.liveSizingMode.disabled = this.running;
        dom.liveMaxStakeUsd.disabled = this.running;
        dom.liveExitSlippageCents.disabled = this.running;
    }

    private syncProtectionConfigControls(): void {
        const dom = this.dom;
        if (!dom) return;
        dom.protectionTakeProfitEnabled.disabled = this.running;
        dom.protectionTakeProfitCents.disabled = this.running || !this.protectionUiConfig.polymarketProtectionTakeProfitEnabled;
        dom.protectionStopLossEnabled.disabled = this.running;
        dom.protectionStopLossCents.disabled = this.running || !this.protectionUiConfig.polymarketProtectionStopLossEnabled;
    }

    private syncExecutionMode(): void {
        const dom = this.dom;
        if (!dom) return;
        this.executionMode = dom.executionMode.value === "live" ? "live" : "paper";
        dom.executionMode.value = this.executionMode;
        dom.startButton.textContent = this.executionMode === "live" ? "Start Live" : "Start Paper";
        dom.startButton.classList.toggle("btn-primary", this.executionMode === "paper");
        dom.startButton.classList.toggle("btn-danger", this.executionMode === "live");
        if (!this.running) {
            this.setStatus(this.executionMode === "live" ? "Live Trade selected. Session will still start in Paper after reload." : "Ready");
        }
    }

    private confirmLiveStart(): boolean {
        return window.confirm("Start Live Trade? If the local executor is live-enabled, accepted entries can place real Polymarket orders.");
    }

    private setStatus(text: string, tone: "neutral" | "running" | "warning" | "error" | "live" = "neutral"): void {
        const status = this.dom?.status;
        if (!status) return;
        status.textContent = text;
        status.classList.toggle("is-running", tone === "running");
        status.classList.toggle("is-warning", tone === "warning");
        status.classList.toggle("is-error", tone === "error");
        status.classList.toggle("is-live", tone === "live");
    }

    private setRunningState(running: boolean): void {
        this.running = running;
        const dom = this.dom;
        if (!dom) return;
        dom.startButton.disabled = running;
        dom.stopButton.disabled = !running;
        dom.stakeInput.disabled = running;
        dom.executionMode.disabled = running;
        this.syncLiveConfigControls();
        this.syncProtectionConfigControls();
    }

    private setComparisonStatus(text: string, tone: "neutral" | "running" | "warning" | "error" = "neutral"): void {
        const status = this.dom?.comparisonStatus;
        if (!status) return;
        status.textContent = text;
        status.classList.toggle("is-running", tone === "running");
        status.classList.toggle("is-warning", tone === "warning");
        status.classList.toggle("is-error", tone === "error");
    }

    private renderMinerStatus(status: ExecutionLabMinerStatus | null, fallback?: string): void {
        const dom = this.dom;
        if (!dom) return;
        if (!status) {
            dom.minerStatus.textContent = fallback ?? "--";
            dom.startMinerButton.disabled = false;
            dom.stopMinerButton.disabled = true;
            return;
        }
        const marketType = status.marketType ?? state.binanceMarketType;
        dom.minerStatus.textContent = status.running
            ? `running ${marketType} pid ${status.pid ?? "--"} | ${status.logPath}`
            : `${status.message ?? "idle"} | ${status.logPath}`;
        dom.startMinerButton.disabled = status.running;
        dom.stopMinerButton.disabled = !status.running;
    }

    private renderLiveExecutorStatus(status: LiveExecutorStatus | null, fallback?: string): void {
        const dom = this.dom;
        if (!dom) return;
        if (!status) {
            dom.liveExecutorStatus.textContent = fallback ?? "--";
            dom.liveExecutorStatus.classList.remove("is-ok", "is-warning");
            return;
        }
        const geoblockStatus = this.liveSubmissionBlockedReason
            ? `blocked ${this.liveSubmissionBlockedReason}`
            : status.geoblockAllowed === true
                ? "geoblock allowed"
                : status.geoblockAllowed === false
                    ? "geoblock blocked"
                    : status.liveEnabled
                        ? "geoblock unknown"
                        : null;
        dom.liveExecutorStatus.textContent = [
            status.available ? "available" : status.configured ? "missing" : "not configured",
            status.liveEnabled ? "live enabled" : "dry-run",
            geoblockStatus,
            `mode ${status.orderMode}`,
            `cap $${status.maxStakeUsd.toFixed(2)}`,
            `sizing ${status.sizingMode === "exchange_min" ? "exchange min" : "fixed"}`,
            `taker ${status.takerOrderType ?? LIVE_TRADE_DEFAULT_ORDER_TYPE}`,
            status.orderMode === "taker"
                ? `entry slip ${(status.entryMaxSlippageCents ?? LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS).toFixed(0)}c`
                : null,
            `exit slip ${(status.exitMaxSlippageCents ?? LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS).toFixed(0)}c`,
            status.orderMode === "limit"
                ? `limit ${status.supportedLimitOrderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE}`
                : null,
            status.orderMode === "limit"
                ? `offset ${status.limitOffsetEnabled ? `${status.limitOffsetCents.toFixed(1)}c` : "off"}`
                : null,
            status.orderMode === "limit"
                ? `fixed ${status.limitFixedPriceEnabled ? `${status.limitFixedPriceCents.toFixed(1)}c` : "off"}`
                : null,
            status.orderMode === "limit"
                ? `cancel ${status.limitCancelAllOnExitEnabled ? `on exit (${status.cancelScope})` : "off"}`
                : null,
            status.message,
        ].filter(Boolean).join(" | ");
        dom.liveExecutorStatus.classList.toggle("is-ok", status.available && !status.liveEnabled);
        dom.liveExecutorStatus.classList.toggle("is-warning", status.liveEnabled || !status.available || this.liveSubmissionBlockedReason !== null);
    }

    private async refreshMinerStatus(): Promise<void> {
        try {
            const status = await loadExecutionLabMinerStatus();
            this.renderMinerStatus(status);
            this.syncMinerChartStream(status);
        } catch (error) {
            this.renderMinerStatus(null, executionLabErrorMessage(error));
        }
    }

    private async refreshLiveExecutorStatus(): Promise<LiveExecutorStatus | null> {
        const refreshToken = ++this.liveStatusRefreshToken;
        const liveConfig = this.activeLiveUiConfig();
        const configKey = liveUiConfigKey(liveConfig);
        try {
            const status = await resolveExecutionLabLiveConfig(liveConfig)
                .catch(() => loadExecutionLabLiveExecutorStatus());
            if (refreshToken !== this.liveStatusRefreshToken) return null;
            if (configKey !== liveUiConfigKey(this.activeLiveUiConfig())) return null;
            this.latestLiveExecutorStatus = status;
            this.latestLiveExecutorStatusConfigKey = configKey;
            this.renderLiveExecutorStatus(this.latestLiveExecutorStatus);
            return status;
        } catch (error) {
            if (refreshToken !== this.liveStatusRefreshToken) return null;
            this.latestLiveExecutorStatus = null;
            this.latestLiveExecutorStatusConfigKey = "";
            this.renderLiveExecutorStatus(null, executionLabErrorMessage(error));
            return null;
        }
    }

    private async startMiner(): Promise<void> {
        try {
            const status = await startExecutionLabMiner({ marketType: state.binanceMarketType });
            this.renderMinerStatus(status);
            this.syncMinerChartStream(status);
        } catch (error) {
            this.renderMinerStatus(null, executionLabErrorMessage(error));
        }
    }

    private async stopMiner(): Promise<void> {
        try {
            const status = await stopExecutionLabMiner();
            this.renderMinerStatus(status);
            this.syncMinerChartStream(status);
        } catch (error) {
            this.renderMinerStatus(null, executionLabErrorMessage(error));
        }
    }

    private syncMinerChartStream(status: ExecutionLabMinerStatus): void {
        if (!status.running) {
            this.stopMinerChartStream(!this.running && !this.starting);
            return;
        }
        if (this.running || this.starting) return;
        void this.ensureMinerChartStream();
    }

    private streamContextKey(context: ExecutionLabStreamContext): string {
        return [
            context.symbol,
            context.marketType,
            context.outcomeSymbol ?? "",
            context.outcomeInterval,
            context.seriesId ?? "",
        ].join("|");
    }

    private isMinerChartContextActive(context: ExecutionLabStreamContext): boolean {
        return !this.running
            && !this.starting
            && this.minerChartContext !== null
            && this.streamContextKey(this.minerChartContext) === this.streamContextKey(context);
    }

    private resolveMinerStreamContext(): ExecutionLabStreamContext | null {
        const chartSymbol = normalizeSecondMarketChartSymbol(state.currentSymbol);
        if (state.currentInterval !== "1s" || !chartSymbol) return null;

        const backtestSettings = getBacktestSettings();
        const polymarketDom = resolvePolymarketDomSettings();
        const outcomeSymbolRaw = resolvePolymarketOutcomeSymbol(
            chartSymbol,
            backtestSettings.polymarketOutcomeSymbol ?? polymarketDom.outcomeSymbol,
        );
        const outcomeSymbol = outcomeSymbolRaw ? normalizeSecondMarketChartSymbol(outcomeSymbolRaw) : null;
        const outcomeInterval = backtestSettings.polymarketOutcomeInterval ?? polymarketDom.outcomeInterval;
        const seriesId = outcomeSymbol
            ? getEffectivePolymarketSeriesId(chartSymbol, outcomeInterval, outcomeSymbol)
            : null;

        return {
            symbol: chartSymbol,
            outcomeSymbol,
            outcomeInterval,
            seriesId,
            marketType: state.binanceMarketType,
        };
    }

    private async ensureMinerChartStream(): Promise<void> {
        if (this.running || this.starting || this.minerChartStarting) return;
        const context = this.resolveMinerStreamContext();
        if (!context) {
            this.setStatus("1s miner running | switch to a supported BTCUSDT/XRPUSDT 1s chart to stream candles.", "warning");
            return;
        }
        if (
            this.minerChartTimer
            && this.minerChartContext
            && this.streamContextKey(this.minerChartContext) === this.streamContextKey(context)
        ) {
            return;
        }

        this.stopMinerChartStream(false);
        this.minerChartStarting = true;
        this.minerChartContext = context;
        this.candles = [];
        this.liveEvents = [];
        this.latestQuote = null;
        this.feedLagSec = null;
        this.liveQuoteByTime.clear();
        this.strategyQuoteByTime.clear();
        this.polymarketPriceByTime.clear();
        this.diagnosticSamples = [];
        this.diagnosticStats = createExecutionLabDiagnosticAccumulator();
        try {
            this.setStatus(`1s miner streaming ${context.symbol} ${context.marketType}`, "running");
            const initialCandles = await this.loadInitialCandles(context.symbol, context.marketType);
            if (!this.isMinerChartContextActive(context)) return;
            this.candles = initialCandles;
            chartManager.clearTradeMarkers();
            chartManager.clearExecutionLabMarkers();
            chartManager.clearExecutionLabPolymarketPrices();
            if (this.candles.length > 0) {
                chartManager.displayPaperStreamData(this.candles);
            }
            await this.refreshMinerChartStream();
            if (!this.isMinerChartContextActive(context)) return;
            this.minerChartTimer = setInterval(() => void this.refreshMinerChartStreamInBackground(), POLL_MS);
        } catch (error) {
            this.setStatus(executionLabErrorMessage(error), "warning");
        } finally {
            this.minerChartStarting = false;
        }
    }

    private syncSavedConfigOptions(): void {
        const dom = this.dom;
        if (!dom) return;
        const previous = dom.comparisonSavedConfig.value;
        const configs = sortStrategyConfigsNewestFirst(settingsManager.loadAllStrategyConfigs());
        dom.comparisonSavedConfig.innerHTML = '<option value="">-- Select configuration --</option>';
        for (const config of configs) {
            const option = document.createElement("option");
            option.value = config.name;
            option.textContent = `${config.name} (${config.strategyKey})`;
            dom.comparisonSavedConfig.appendChild(option);
        }
        if (previous && configs.some((config) => config.name === previous)) {
            dom.comparisonSavedConfig.value = previous;
        }
        this.syncComparisonControls();
    }

    private syncComparisonControls(): void {
        const dom = this.dom;
        if (!dom) return;
        dom.comparisonSavedConfig.disabled = dom.comparisonSource.value !== "saved";
    }

    private currentComparisonSource(): ComparisonSource {
        const value = this.dom?.comparisonSource.value;
        return value === "current" || value === "saved" ? value : "original";
    }

    private async copyTextToClipboard(text: string): Promise<void> {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return;
            } catch {
                // Fall through to the textarea path for browsers that reject clipboard writes without focus.
            }
        }

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            if (!document.execCommand("copy")) {
                throw new Error("Fallback clipboard copy returned false");
            }
        } finally {
            textarea.remove();
        }
    }

    private async copyDiagnostics(): Promise<void> {
        const diagnostics = this.buildDiagnostics();
        if (!diagnostics) {
            uiManager.showToast("No Execution Lab diagnostics to copy", "info");
            return;
        }

        try {
            await this.copyTextToClipboard(JSON.stringify(diagnostics, null, 2));
            uiManager.showToast("Execution Lab diagnostics copied", "success");
        } catch (error) {
            debugLogger.error("execution_lab.copy_diagnostics_failed", { error: executionLabErrorMessage(error) });
            uiManager.showToast("Copy failed - check browser permissions", "error");
        }
    }

    private async resolveStrategyForKey(strategyKey: string): Promise<Strategy> {
        let strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            strategy = await loadBuiltInStrategyByKey(strategyKey);
        }
        if (!strategy) throw new Error(`Strategy not loaded: ${strategyKey}`);
        if (strategy.crossSymbolConfig) throw new Error("Execution Lab comparison does not support cross-symbol strategies.");
        return strategy;
    }

    private async buildComparisonCandidate(source: ComparisonSource): Promise<ComparisonCandidate | null> {
        const snapshot = this.snapshot;
        if (!snapshot) return null;
        if (source === "original") {
            const strategy = this.strategy ?? await this.resolveStrategyForKey(snapshot.strategyKey);
            return {
                label: "Original Paper Trade",
                strategyKey: snapshot.strategyKey,
                strategyName: snapshot.strategyName,
                strategy,
                params: { ...snapshot.params },
                backtestSettings: { ...snapshot.backtestSettings },
                capitalSettings: { ...snapshot.capitalSettings },
            };
        }

        if (source === "current") {
            const strategy = await this.resolveStrategyForKey(state.currentStrategyKey);
            const rawParams = paramManager.getValues(strategy);
            return {
                label: "Current Settings",
                strategyKey: state.currentStrategyKey,
                strategyName: strategy.name,
                strategy,
                params: strategy.normalizeParams ? strategy.normalizeParams(rawParams) : rawParams,
                backtestSettings: { ...getBacktestSettings(), symbol: snapshot.symbol, interval: "1s" } as BacktestSettings,
                capitalSettings: getCapitalSettings(),
            };
        }

        this.syncSavedConfigOptions();
        const configName = this.dom?.comparisonSavedConfig.value ?? "";
        if (!configName) throw new Error("Select a saved configuration first.");
        const config = settingsManager.loadStrategyConfig(configName);
        if (!config) throw new Error(`Saved configuration "${configName}" was not found.`);
        const strategy = await this.resolveStrategyForKey(config.strategyKey);
        const params = strategy.normalizeParams
            ? strategy.normalizeParams(config.strategyParams)
            : config.strategyParams;
        return {
            label: `Saved: ${config.name}`,
            strategyKey: config.strategyKey,
            strategyName: strategy.name,
            strategy,
            params,
            backtestSettings: { ...config.backtestSettings, symbol: snapshot.symbol, interval: "1s" } as unknown as BacktestSettings,
            capitalSettings: resolveCapitalSettingsFromRaw(config.backtestSettings as unknown as Record<string, unknown>),
        };
    }

    private comparisonSnapshot(candidate: ComparisonCandidate): ExecutionLabSessionSnapshot {
        const snapshot = this.snapshot;
        if (!snapshot) throw new Error("Start Paper first.");
        const comparisonBacktestSettings = {
            ...candidate.backtestSettings,
            symbol: snapshot.symbol,
            interval: "1s",
            polymarketAnnotationEnabled: true,
            polymarketOutcomeSymbol: snapshot.outcomeSymbol,
            polymarketOutcomeInterval: snapshot.outcomeInterval,
        } as BacktestSettings;
        const exitMode = resolveEffectivePolymarketExitMode({
            requestedMode: comparisonBacktestSettings.polymarketExitMode,
            interval: "1s",
            executionModel: comparisonBacktestSettings.executionModel,
            polymarketAnnotationEnabled: true,
        });
        const allowMultipleTradesPerEvent = isSameEventPolymarketExitMode(exitMode)
            && comparisonBacktestSettings.polymarketSignalExitAllowMultipleTradesPerEvent === true;
        return {
            ...snapshot,
            strategyKey: candidate.strategyKey,
            strategyName: candidate.strategyName,
            params: candidate.params,
            backtestSettings: comparisonBacktestSettings,
            capitalSettings: candidate.capitalSettings,
            polymarketSettings: {
                ...snapshot.polymarketSettings,
                exitMode,
                allowMultipleTradesPerEvent,
            },
            exitMode,
            allowMultipleTradesPerEvent,
        };
    }

    private async loadComparisonOutcomes(snapshot: ExecutionLabSessionSnapshot, latestTs: number) {
        const firstTs = this.candles[0] ? finiteUnixSeconds(this.candles[0].time) : null;
        if (firstTs === null) return [];
        return loadExecutionLabLiveOutcomes({
            symbol: snapshot.outcomeSymbol,
            outcomeInterval: snapshot.outcomeInterval,
            seriesId: snapshot.seriesId,
            startTs: Math.max(0, firstTs - 60),
            endTs: latestTs + 60,
        });
    }

    private async runComparison(): Promise<void> {
        if (this.comparisonRunning) return;
        const snapshot = this.snapshot;
        const latestCandle = this.candles[this.candles.length - 1] ?? null;
        const latestTs = latestCandle ? finiteUnixSeconds(latestCandle.time) : null;
        const sessionStartTs = this.sessionStartCandleTimeSec;
        if (!snapshot || !latestCandle || latestTs === null || sessionStartTs === null) {
            this.setComparisonStatus("Start Paper first.", "warning");
            return;
        }

        this.comparisonRunning = true;
        this.dom!.runComparisonButton.disabled = true;
        this.setComparisonStatus("Running comparison", "running");
        try {
            const source = this.currentComparisonSource();
            const candidate = await this.buildComparisonCandidate(source);
            if (!candidate) throw new Error("Start Paper first.");
            const comparisonSnapshot = this.comparisonSnapshot(candidate);
            const firstTs = this.candles[0] ? finiteUnixSeconds(this.candles[0].time) : null;
            if (firstTs === null) throw new Error("No valid comparison candle range.");
            const storedQuotes = await this.loadStoredQuoteRange(comparisonSnapshot, firstTs, latestTs);
            const replayQuotes = mergeExecutionLabQuotes(storedQuotes, this.getLiveQuoteBuffer());
            const backtestResult = await executeBacktest({
                ohlcvData: this.candles,
                interval: "1s",
                primarySymbol: snapshot.symbol,
                strategyKey: candidate.strategyKey,
                strategy: candidate.strategy,
                strategyParams: candidate.params,
                backtestSettings: { ...comparisonSnapshot.backtestSettings, polymarketAnnotationEnabled: false },
                capitalSettings: candidate.capitalSettings,
                context: {
                    nowSec: latestTs + 2,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "typescript",
                },
                strategyExecutionContext: buildExecutionLabStrategyExecutionContext({
                    snapshot: comparisonSnapshot,
                    quotes: replayQuotes,
                }),
                polymarket1sContextMode: "provided",
            });
            const outcomes = await this.loadComparisonOutcomes(comparisonSnapshot, latestTs);
            const scratch = createExecutionLabPaperState(comparisonSnapshot);
            scratch.lastProcessedCandleTimeSec = sessionStartTs;
            evaluateExecutionLabPaperTick(scratch, {
                latestCandleTimeSec: latestTs,
                latestCandle,
                trades: backtestResult.result.trades,
                signals: buildEvaluatedSignals(backtestResult.signals).filter((signal) => signal.signalTimeSec <= latestTs),
                quotes: replayQuotes,
                outcomes,
                recordedAtIso: new Date().toISOString(),
                feedLagSec: this.feedLagSec,
            });
            this.latestComparison = {
                metrics: computeExecutionLabPerformanceMetrics(scratch.closedTrades),
                totalEntries: scratch.totalEntries,
            };
            this.renderComparisonMetrics();
            this.setComparisonStatus(`${candidate.label} | no logs written`, "running");
        } catch (error) {
            this.latestComparison = null;
            this.renderComparisonMetrics();
            this.setComparisonStatus(executionLabErrorMessage(error), "error");
        } finally {
            this.comparisonRunning = false;
            if (this.dom) this.dom.runComparisonButton.disabled = false;
        }
    }

    private async prepareSession(): Promise<{ snapshot: ExecutionLabSessionSnapshot; strategy: Strategy; logPath: string }> {
        const chartSymbol = normalizeSecondMarketChartSymbol(state.currentSymbol);
        if (state.currentInterval !== "1s" || !chartSymbol) {
            throw new Error("Execution Lab requires a supported 1s chart: BTCUSDT or XRPUSDT.");
        }
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy) throw new Error(`Strategy not loaded: ${state.currentStrategyKey}`);
        if (strategy.crossSymbolConfig) throw new Error("Execution Lab does not support cross-symbol strategies in the first version.");

        const backtestSettings = getBacktestSettings();
        const capitalSettings = getCapitalSettings();
        const polymarketDom = resolvePolymarketDomSettings();
        const polymarketAnnotationEnabled = true;
        const outcomeSymbolRaw = resolvePolymarketOutcomeSymbol(
            chartSymbol,
            backtestSettings.polymarketOutcomeSymbol ?? polymarketDom.outcomeSymbol,
        );
        const outcomeSymbol = outcomeSymbolRaw ? normalizeSecondMarketChartSymbol(outcomeSymbolRaw) : null;
        if (!outcomeSymbol) throw new Error("Selected Polymarket outcome symbol is not available in second-market 1s data.");

        const outcomeInterval = backtestSettings.polymarketOutcomeInterval ?? polymarketDom.outcomeInterval;
        const seriesId = getEffectivePolymarketSeriesId(chartSymbol, outcomeInterval, outcomeSymbol);
        if (!seriesId) throw new Error("No Polymarket series id found for the selected outcome settings.");

        const params = strategy.normalizeParams
            ? strategy.normalizeParams(paramManager.getValues(strategy))
            : paramManager.getValues(strategy);
        const stakeUsd = normalizeStake(this.dom?.stakeInput.value);
        const protectionSettings = this.readProtectionUiConfigFromDom();
        this.protectionUiConfig = protectionSettings;
        const startedAtIso = new Date().toISOString();
        const session = await startExecutionLabSession({ strategyKey: state.currentStrategyKey, symbol: chartSymbol, startedAtIso });
        const exitMode = resolveEffectivePolymarketExitMode({
            requestedMode: backtestSettings.polymarketExitMode ?? polymarketDom.exitMode,
            interval: "1s",
            executionModel: backtestSettings.executionModel,
            polymarketAnnotationEnabled,
        });
        const allowMultipleTradesPerEvent = isSameEventPolymarketExitMode(exitMode)
            && (backtestSettings.polymarketSignalExitAllowMultipleTradesPerEvent
                ?? polymarketDom.signalExitAllowMultipleTradesPerEvent) === true;
        const snapshotBacktestSettings = {
            ...backtestSettings,
            ...protectionSettings,
            symbol: chartSymbol,
            interval: "1s",
            polymarketAnnotationEnabled: true,
            polymarketOutcomeSymbol: outcomeSymbol,
            polymarketOutcomeInterval: outcomeInterval,
            polymarketExitMode: exitMode,
            polymarketSignalExitAllowMultipleTradesPerEvent: allowMultipleTradesPerEvent,
        } as BacktestSettings;

        return {
            strategy,
            logPath: session.logPath,
            snapshot: {
                sessionId: session.sessionId,
                symbol: chartSymbol,
                outcomeSymbol,
                interval: "1s",
                strategyKey: state.currentStrategyKey,
                strategyName: strategy.name,
                params,
                backtestSettings: snapshotBacktestSettings,
                capitalSettings,
                polymarketSettings: { outcomeSymbol, outcomeInterval, exitMode, allowMultipleTradesPerEvent },
                outcomeInterval,
                seriesId,
                exitMode,
                allowMultipleTradesPerEvent,
                stakeUsd,
                startedAtIso,
            },
        };
    }

    private loadInitialCandles(symbol: SecondMarketSymbol, marketType = state.binanceMarketType): Promise<OHLCVData[]> {
        return loadExecutionLabLiveCandles({
            symbol,
            marketType,
            limit: INITIAL_CANDLE_LIMIT,
        });
    }

    private loadNextCandleBatch(symbol: SecondMarketSymbol, marketType = state.binanceMarketType): Promise<OHLCVData[]> {
        const lastBufferedTs = this.getLastBufferedTs();
        if (lastBufferedTs === null) {
            return loadExecutionLabLiveCandles({
                symbol,
                marketType,
                limit: 1,
            });
        }
        const endTs = Math.floor(Date.now() / 1000) - LIVE_CANDLE_CLOSED_LAG_SEC;
        if (endTs < lastBufferedTs) return Promise.resolve([]);
        return loadExecutionLabLiveCandles({
            symbol,
            marketType,
            startTs: lastBufferedTs,
            endTs,
            limit: Math.min(10000, Math.max(1, endTs - lastBufferedTs + 1)),
        });
    }

    private refreshCandleStream(): Promise<OHLCVData[]> {
        const snapshot = this.snapshot;
        if (!this.running || !snapshot) return Promise.resolve([]);
        if (this.candleRefreshPromise) return this.candleRefreshPromise;

        const sessionToken = this.sessionRunToken;
        let promise: Promise<OHLCVData[]>;
        promise = this.loadNextCandleBatch(snapshot.symbol)
            .then((latestBatch) => {
                if (!this.isSessionActive(sessionToken, snapshot)) return [];

                if (latestBatch.length > 0) {
                    this.mergeCandles(latestBatch);
                    chartManager.updatePaperStreamData(this.candles, latestBatch);
                }

                const latestBufferedTs = this.getLastBufferedTs();
                if (latestBufferedTs !== null) {
                    this.feedLagSec = liveCandleLagSec(latestBufferedTs);
                }
                this.render();
                return latestBatch;
            })
            .finally(() => {
                if (this.candleRefreshPromise === promise) {
                    this.candleRefreshPromise = null;
                }
            });

        this.candleRefreshPromise = promise;
        return promise;
    }

    private refreshMinerChartStreamInBackground(): void {
        void this.refreshMinerChartStream().catch((error: unknown) => {
            if (isExecutionLabTransientPollError(error)) {
                this.setStatus(`1s miner chart refresh skipped: ${executionLabErrorMessage(error)}`, "warning");
                this.renderMinerChart();
                return;
            }
            this.setStatus(executionLabErrorMessage(error), "warning");
        });
    }

    private async refreshMinerChartStream(): Promise<void> {
        const context = this.minerChartContext;
        if (!context || this.running || this.starting) return;
        const nextContext = this.resolveMinerStreamContext();
        if (!nextContext) {
            this.setStatus("1s miner running | switch to a supported BTCUSDT/XRPUSDT 1s chart to stream candles.", "warning");
            return;
        }
        if (this.streamContextKey(nextContext) !== this.streamContextKey(context)) {
            this.stopMinerChartStream(false);
            await this.ensureMinerChartStream();
            return;
        }
        if (this.minerChartRefreshPromise) return this.minerChartRefreshPromise;

        let promise: Promise<void>;
        promise = (async () => {
            const latestBatch = await this.loadNextCandleBatch(context.symbol, context.marketType);
            if (!this.isMinerChartContextActive(context)) return;
            if (latestBatch.length > 0) {
                const hadCandles = this.candles.length > 0;
                this.mergeCandles(latestBatch);
                if (hadCandles) {
                    chartManager.updatePaperStreamData(this.candles, latestBatch);
                } else {
                    chartManager.displayPaperStreamData(this.candles);
                }
            }

            const latestBuffered = this.candles[this.candles.length - 1] ?? null;
            const latestBufferedTs = latestBuffered ? finiteUnixSeconds(latestBuffered.time) : null;
            if (!latestBuffered || latestBufferedTs === null) {
                this.renderMinerChart();
                return;
            }

            this.feedLagSec = liveCandleLagSec(latestBufferedTs);
            const activeEvent = await this.getLiveEventForStreamContext(context, latestBufferedTs);
            if (!this.isMinerChartContextActive(context)) return;
            const liveQuote = activeEvent
                ? await loadExecutionLabLiveQuote({ event: activeEvent, sampleTs: latestBufferedTs }).catch(() => null)
                : null;
            if (!this.isMinerChartContextActive(context)) return;
            this.latestQuote = liveQuote;
            if (liveQuote) {
                this.addPolymarketQuote(liveQuote, false);
                chartManager.displayExecutionLabPolymarketPrices(this.getPolymarketPricePoints());
            }
            this.recordPriceDiagnostic({
                mode: "miner",
                symbol: context.symbol,
                marketType: context.marketType,
                latestCandleTimeSec: latestBufferedTs,
                latestCandle: latestBuffered,
                quote: liveQuote,
                feedLagSec: this.feedLagSec,
            });
            this.renderMinerChart();
            this.setStatus(`1s miner streaming ${context.symbol} ${context.marketType} | latest ${formatDateTime(latestBufferedTs)}`, "running");
        })().finally(() => {
            if (this.minerChartRefreshPromise === promise) {
                this.minerChartRefreshPromise = null;
            }
        });

        this.minerChartRefreshPromise = promise;
        return promise;
    }

    private async getLiveEventForTime(snapshot: ExecutionLabSessionSnapshot, ts: number): Promise<SecondMarketPolymarketEvent | null> {
        let event = this.liveEvents.find((candidate) =>
            candidate.seriesId === snapshot.seriesId
            && candidate.symbol === snapshot.outcomeSymbol
            && candidate.eventStartTs <= ts
            && ts < candidate.eventEndTs
        ) ?? null;
        if (event) return event;
        this.liveEvents = await loadExecutionLabLiveEvents({
            symbol: snapshot.outcomeSymbol,
            outcomeInterval: snapshot.outcomeInterval,
            seriesId: snapshot.seriesId,
        });
        event = this.liveEvents.find((candidate) =>
            candidate.seriesId === snapshot.seriesId
            && candidate.symbol === snapshot.outcomeSymbol
            && candidate.eventStartTs <= ts
            && ts < candidate.eventEndTs
        ) ?? null;
        return event;
    }

    private async getLiveEventForStreamContext(
        context: ExecutionLabStreamContext,
        ts: number
    ): Promise<SecondMarketPolymarketEvent | null> {
        if (!context.outcomeSymbol || !context.seriesId) return null;
        let event = this.liveEvents.find((candidate) =>
            candidate.seriesId === context.seriesId
            && candidate.symbol === context.outcomeSymbol
            && candidate.eventStartTs <= ts
            && ts < candidate.eventEndTs
        ) ?? null;
        if (event) return event;
        this.liveEvents = await loadExecutionLabLiveEvents({
            symbol: context.outcomeSymbol,
            outcomeInterval: context.outcomeInterval,
            seriesId: context.seriesId,
        });
        event = this.liveEvents.find((candidate) =>
            candidate.seriesId === context.seriesId
            && candidate.symbol === context.outcomeSymbol
            && candidate.eventStartTs <= ts
            && ts < candidate.eventEndTs
        ) ?? null;
        return event;
    }

    private async loadLiveOutcomesForOpenPositions(snapshot: ExecutionLabSessionSnapshot, latestTs: number) {
        const paperState = this.paperState;
        if (!paperState) return [];
        const positions = [
            ...paperState.openPositions.values(),
            ...paperState.pendingSettlements.values(),
        ];
        const endedPositions = positions.filter((position) => position.eventEndTs <= latestTs);
        if (endedPositions.length === 0) return [];
        const minEndTs = Math.min(...endedPositions.map((position) => position.eventEndTs));
        return loadExecutionLabLiveOutcomes({
            symbol: snapshot.outcomeSymbol,
            outcomeInterval: snapshot.outcomeInterval,
            seriesId: snapshot.seriesId,
            startTs: minEndTs - 60,
            endTs: latestTs + 60,
        });
    }

    private async loadStoredQuoteRange(
        snapshot: ExecutionLabSessionSnapshot,
        startTs: number,
        endTs: number,
        required = true
    ): Promise<PolymarketClob1sQuoteRow[]> {
        const start = Math.floor(startTs);
        const end = Math.floor(endTs);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
        try {
            return await loadExecutionLabStoredQuotes({
                symbol: snapshot.outcomeSymbol,
                seriesId: snapshot.seriesId,
                startTs: start,
                endTs: end,
            });
        } catch (error) {
            if (required) throw error;
            return [];
        }
    }

    private async addStoredQuoteRange(
        snapshot: ExecutionLabSessionSnapshot,
        startTs: number,
        endTs: number,
        includeStrategyContext: boolean,
        required = false
    ): Promise<void> {
        const quotes = await this.loadStoredQuoteRange(snapshot, startTs, endTs, required);
        for (const quote of quotes) {
            this.addPolymarketQuote(quote, includeStrategyContext);
        }
    }

    private hasReadyLiveExitRetry(nowSec: number): boolean {
        if (this.executionMode !== "live") return false;
        for (const position of this.liveOpenPositionByPaperTradeId.values()) {
            const plan = position.pendingExit;
            if (
                plan
                && position.remainingShares > MIN_LIVE_POSITION_SHARES
                && !this.liveExitInFlightByPaperTradeId.has(position.paperTradeId)
                && nowSec >= plan.nextAttemptAtSec
                && nowSec < position.eventEndTs
            ) {
                return true;
            }
        }
        return false;
    }

    private async poll(): Promise<void> {
        if (!this.running || this.polling) return;
        const snapshot = this.snapshot;
        const paperState = this.paperState;
        const strategy = this.strategy;
        if (!snapshot || !paperState || !strategy) return;
        const sessionToken = this.sessionRunToken;

        this.polling = true;
        const pollStartedMs = Date.now();
        const pollTiming: ExecutionLabPollTiming = {};
        try {
            this.assertSessionContext(snapshot);
            const candleStartedMs = Date.now();
            const latestBatchResult = await this.tryLivePollFetch(() =>
                this.refreshCandleStream()
            );
            pollTiming.candlesMs = Date.now() - candleStartedMs;
            if (!latestBatchResult.ok) return;

            const latestBuffered = this.candles[this.candles.length - 1];
            const latestBufferedTs = latestBuffered ? finiteUnixSeconds(latestBuffered.time) : null;
            if (!latestBuffered || latestBufferedTs === null) {
                this.setStatus("Waiting for latest 1s candle", "warning");
                return;
            }
            const lagSec = liveCandleLagSec(latestBufferedTs);
            if (lagSec > MAX_LIVE_CANDLE_LAG_SEC) {
                this.feedLagSec = lagSec;
                this.setStatus(liveLagMessage(latestBufferedTs, lagSec), "warning");
                this.render();
                return;
            }

            const eventStartedMs = Date.now();
            const activeEventResult = await this.tryLivePollFetch(() => this.getLiveEventForTime(snapshot, latestBufferedTs));
            pollTiming.eventMs = Date.now() - eventStartedMs;
            if (!this.isSessionActive(sessionToken, snapshot)) return;
            if (!activeEventResult.ok) return;
            const activeEvent = activeEventResult.value;
            const previousPaperTs = paperState.lastProcessedCandleTimeSec;
            const liveQuoteStartedMs = Date.now();
            const liveQuoteResult = activeEvent
                ? await this.tryLivePollFetch(() => loadExecutionLabLiveQuote({ event: activeEvent, sampleTs: latestBufferedTs }))
                : { ok: true as const, value: null };
            pollTiming.liveQuoteMs = Date.now() - liveQuoteStartedMs;
            if (!this.isSessionActive(sessionToken, snapshot)) return;
            if (!liveQuoteResult.ok) return;
            const liveQuote = liveQuoteResult.value;
            if (liveQuote) this.addPolymarketQuote(liveQuote);
            const storedQuoteStart = previousPaperTs === null ? latestBufferedTs : previousPaperTs + 1;
            const storedQuotesStartedMs = Date.now();
            const storedQuotesResult = await this.tryLivePollFetch(() =>
                this.addStoredQuoteRange(snapshot, storedQuoteStart, latestBufferedTs, true)
            );
            pollTiming.storedQuotesMs = Date.now() - storedQuotesStartedMs;
            if (!this.isSessionActive(sessionToken, snapshot)) return;
            if (!storedQuotesResult.ok) return;
            const strategyQuotes = this.getStrategyQuoteBuffer();
            const feedLag = liveCandleLagSec(latestBufferedTs);
            if (
                previousPaperTs !== null
                && latestBufferedTs <= previousPaperTs
                && !this.hasReadyLiveExitRetry(Math.floor(Date.now() / 1000))
            ) {
                this.latestQuote = liveQuote;
                this.feedLagSec = feedLag;
                this.render();
                this.setStatus(
                    `Running ${this.executionMode === "live" ? "LIVE TRADE" : "Paper Trade"} ${snapshot.symbol} 1s | waiting for next candle after ${formatDateTime(latestBufferedTs)}`,
                    this.executionMode === "live" ? "live" : "running"
                );
                return;
            }

            const backtestStartedMs = Date.now();
            const backtestPromise = executeBacktest({
                ohlcvData: this.candles,
                interval: "1s",
                primarySymbol: snapshot.symbol,
                strategyKey: snapshot.strategyKey,
                strategy,
                strategyParams: snapshot.params,
                backtestSettings: { ...snapshot.backtestSettings, polymarketAnnotationEnabled: false },
                capitalSettings: snapshot.capitalSettings,
                context: {
                    nowSec: latestBufferedTs + 2,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "typescript",
                },
                strategyExecutionContext: buildExecutionLabStrategyExecutionContext({
                    snapshot,
                    quotes: strategyQuotes,
                }),
                polymarket1sContextMode: "provided",
            }).finally(() => {
                pollTiming.backtestMs = Date.now() - backtestStartedMs;
            });
            const outcomesStartedMs = Date.now();
            const outcomesPromise = this.tryLivePollFetch(() => this.loadLiveOutcomesForOpenPositions(snapshot, latestBufferedTs))
                .finally(() => {
                    pollTiming.outcomesMs = Date.now() - outcomesStartedMs;
                });
            const [backtestResult, outcomesResult] = await Promise.all([backtestPromise, outcomesPromise]);
            if (!this.isSessionActive(sessionToken, snapshot)) return;
            if (!outcomesResult.ok) return;
            const outcomes = outcomesResult.value;

            const backtestSignals = buildEvaluatedSignals(backtestResult.signals)
                .filter((signal) => signal.signalTimeSec <= latestBufferedTs);
            const missingQuotesStartedMs = Date.now();
            const missingTradeQuotesResult = await this.tryLivePollFetch(() =>
                this.loadMissingTradeQuotes(snapshot, backtestResult.result.trades, latestBufferedTs, previousPaperTs)
            );
            pollTiming.missingTradeQuotesMs = Date.now() - missingQuotesStartedMs;
            if (!this.isSessionActive(sessionToken, snapshot)) return;
            if (!missingTradeQuotesResult.ok) return;
            const liveQuotes = this.getLiveQuoteBuffer();
            const recordedAtIso = new Date().toISOString();
            const paperEvalStartedMs = Date.now();
            const tickResult = evaluateExecutionLabPaperTick(paperState, {
                latestCandleTimeSec: latestBufferedTs,
                latestCandle: latestBuffered,
                trades: backtestResult.result.trades,
                signals: backtestSignals,
                quotes: liveQuotes,
                outcomes,
                recordedAtIso,
                feedLagSec: feedLag,
            });
            pollTiming.paperEvalMs = Date.now() - paperEvalStartedMs;
            const parityMismatches = this.collectExecutionParityMismatches(backtestResult.result.trades, tickResult.records, latestBufferedTs);
            const parityRecords = this.buildExecutionMismatchRecords(parityMismatches, recordedAtIso);
            const paperLogRecords = [...parityRecords, ...tickResult.records];
            if (paperLogRecords.length > 0) {
                const paperLogStartedMs = Date.now();
                await this.appendRecords(paperLogRecords);
                pollTiming.paperLogMs = Date.now() - paperLogStartedMs;
                if (!this.isSessionActive(sessionToken, snapshot)) return;
            }
            const liveStartedMs = Date.now();
            const liveExecutionRecords = await this.buildLiveExecutionRecords(
                tickResult.records,
                tickResult.acceptedEntries,
                recordedAtIso,
                sessionToken
            );
            pollTiming.liveExecutionMs = Date.now() - liveStartedMs;
            if (!this.isSessionActive(sessionToken, snapshot)) return;

            if (liveExecutionRecords.length > 0) {
                const liveLogStartedMs = Date.now();
                await this.appendRecords(liveExecutionRecords);
                pollTiming.liveResultLogMs = Date.now() - liveLogStartedMs;
                if (!this.isSessionActive(sessionToken, snapshot)) return;
            }
            this.flushLiveTakeProfitSubmissions(sessionToken);
            this.updateExecutionParityState(parityMismatches);
            this.updateLatestPaperDecision(tickResult.records);
            this.appendLatestLoggedSignals(tickResult.records, backtestSignals);
            this.latestQuote = liveQuote;
            this.feedLagSec = feedLag;
            this.recordPriceDiagnostic({
                mode: this.executionMode,
                symbol: snapshot.symbol,
                marketType: state.binanceMarketType,
                latestCandleTimeSec: latestBufferedTs,
                latestCandle: latestBuffered,
                quote: liveQuote,
                feedLagSec: feedLag,
            });
            this.addMarkers(tickResult.markers);
            if (liveQuote) {
                chartManager.displayExecutionLabPolymarketPrices(this.getPolymarketPricePoints());
            }
            this.render();
            const hasActiveEvent = Boolean(activeEvent || liveQuote);
            const statusText = this.executionMismatchTotal > 0
                ? `Execution parity mismatch | ${this.latestExecutionMismatch?.detail ?? "see detail"}`
                : hasActiveEvent
                    ? `Running ${this.executionMode === "live" ? "LIVE TRADE" : "Paper Trade"} ${snapshot.symbol} 1s | latest ${formatDateTime(latestBufferedTs)}`
                    : `Running ${this.executionMode === "live" ? "LIVE TRADE" : "Paper Trade"} ${snapshot.symbol} 1s | no active Polymarket event for ${formatDateTime(latestBufferedTs)}`;
            this.setStatus(
                statusText,
                this.executionMode === "live"
                    ? "live"
                    : this.executionMismatchTotal === 0 && hasActiveEvent ? "running" : "warning"
            );
            this.logPollTiming(snapshot, latestBufferedTs, pollStartedMs, pollTiming);
        } catch (error) {
            await this.stop("error", executionLabErrorMessage(error));
        } finally {
            this.polling = false;
        }
    }

    private logPollTiming(
        snapshot: ExecutionLabSessionSnapshot,
        latestCandleTimeSec: number,
        startedMs: number,
        timing: ExecutionLabPollTiming
    ): void {
        const totalMs = Date.now() - startedMs;
        if (this.executionMode !== "live" && totalMs < 500) return;
        debugLogger.event("execution_lab.poll_timing", {
            sessionId: snapshot.sessionId,
            symbol: snapshot.symbol,
            latestCandleTimeSec,
            mode: this.executionMode,
            totalMs,
            ...timing,
        });
    }

    private assertSessionContext(snapshot: ExecutionLabSessionSnapshot): void {
        if (state.currentSymbol !== snapshot.symbol || state.currentInterval !== "1s") {
            throw new Error("Chart market changed. Stop and start a new Execution Lab session.");
        }
    }

    private getLastBufferedTs(): number | null {
        if (this.candles.length === 0) return null;
        return finiteUnixSeconds(this.candles[this.candles.length - 1].time);
    }

    private mergeCandles(candles: readonly OHLCVData[]): void {
        this.candles = mergeExecutionLabCandles(this.candles, candles, MAX_STREAM_CANDLES);
    }

    private async appendRecords(records: readonly ExecutionLabRecord[]): Promise<void> {
        await appendExecutionLabRecords(records);
    }

    private async appendLiveRequestRecord(
        record: ExecutionLabRecord,
        sessionToken: number,
        snapshot: ExecutionLabSessionSnapshot
    ): Promise<boolean> {
        if (!this.isSessionActive(sessionToken, snapshot)) return false;
        await this.appendRecords([record]);
        return this.isSessionActive(sessionToken, snapshot);
    }

    private async buildLiveExecutionRecords(
        paperRecords: readonly ExecutionLabRecord[],
        acceptedEntries: readonly ExecutionLabOpenPaperPosition[],
        recordedAtIso: string,
        sessionToken: number
    ): Promise<ExecutionLabRecord[]> {
        if (this.executionMode !== "live") return [];
        const snapshot = this.snapshot;
        const exitRecords = paperRecords.filter((record): record is PaperExitRecord => record.recordType === "paper_exit");
        const missingExitRecords = paperRecords.filter((record): record is PaperUnfilledRecord =>
            record.recordType === "paper_unfilled"
            && record.reason === "missing_exit_quote"
            && record.expectedExitTimeSec !== undefined
        );
        if (snapshot?.exitMode === "resolve_hold") {
            this.retireResolvedLivePositions(exitRecords);
        }
        const liveExitTriggers = snapshot?.exitMode === "resolve_hold"
            ? []
            : [...exitRecords, ...missingExitRecords];
        const sameBatchExitedTradeIds = new Set([
            ...[...exitRecords, ...missingExitRecords].map((record) =>
                record.recordType === "paper_exit"
                    ? record.tradeId
                    : this.findLivePositionForExitTrigger(record)?.paperTradeId ?? record.tradeId ?? ""
            ),
        ].filter((tradeId) => tradeId.length > 0));
        return [
            ...await this.buildLiveCancelRecords(liveExitTriggers, recordedAtIso, sessionToken),
            ...await this.buildLiveExitRecords(
                snapshot?.exitMode === "resolve_hold" ? [] : exitRecords,
                snapshot?.exitMode === "resolve_hold" ? [] : missingExitRecords,
                recordedAtIso,
                sessionToken
            ),
            ...await this.buildLiveTradeRecords(acceptedEntries, recordedAtIso, sameBatchExitedTradeIds, sessionToken),
        ];
    }

    private retireResolvedLivePositions(exitRecords: readonly PaperExitRecord[]): void {
        for (const exit of exitRecords) {
            if (exit.exitReason !== "resolution") continue;
            this.liveOpenPositionByPaperTradeId.delete(exit.tradeId);
        }
    }

    private async buildLiveCancelRecords(
        exits: readonly LiveExitTriggerRecord[],
        recordedAtIso: string,
        sessionToken: number
    ): Promise<ExecutionLabRecord[]> {
        const snapshot = this.snapshot;
        const liveConfig = this.activeLiveUiConfig();
        const liveStatus = this.currentLiveExecutorStatus();
        const hasPendingTakeProfitToCancel = exits.some((exit) => this.findPendingTakeProfitForExitTrigger(exit) !== null);
        const hasTargetedPendingLimitToCancel = exits.some((exit) => {
            const pending = this.findPendingLimitForExitTrigger(exit);
            return Boolean(pending?.orderId);
        });
        const canUseConfiguredCancel = liveConfig.orderMode === "limit" && liveConfig.limitCancelAllOnExitEnabled;
        if (
            !snapshot
            || this.executionMode !== "live"
            || !liveStatus
        ) {
            return [];
        }
        if (!hasPendingTakeProfitToCancel && !hasTargetedPendingLimitToCancel && !canUseConfiguredCancel) {
            return [];
        }

        const records: ExecutionLabRecord[] = [];
        for (const exit of exits) {
            const pendingTakeProfit = this.findPendingTakeProfitForExitTrigger(exit);
            const pendingLimit = this.findPendingLimitForExitTrigger(exit);
            if (!pendingTakeProfit && !pendingLimit?.orderId && !canUseConfiguredCancel) continue;
            const request = this.buildLiveCancelAllRequest(exit, recordedAtIso);
            if (!request) continue;
            if (
                this.liveCancelInFlightByKey.has(request.exitTriggerKey)
                || this.liveCancelSubmittedByKey.has(request.exitTriggerKey)
            ) {
                continue;
            }
            const recordContext = this.liveRecordContext();
            const requestRecord = buildLiveCancelAllRequestRecord(snapshot, request, recordedAtIso, recordContext);

            this.liveCancelSubmittedByKey.add(request.exitTriggerKey);
            this.liveCancelInFlightByKey.add(request.exitTriggerKey);
            try {
                if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
                const startedMs = Date.now();
                const response = await submitExecutionLabLiveCancelAll(
                    request,
                    this.cancelLiveUiConfigForRequest(request)
                ).catch(() =>
                    buildLiveCancelAllFailureResponse({
                        requestId: request.requestId,
                        scope: request.scope,
                        reason: "executor_unavailable",
                    })
                );
                if (!this.isSessionActive(sessionToken, snapshot)) return records;
                const result = buildLiveCancelAllResultRecord(snapshot, request, response, new Date().toISOString(), {
                    latencyMs: Date.now() - startedMs,
                });
                this.trackUncanceledLimitAsLivePosition(request, response);
                this.clearPendingLimitSubmissionsAfterCancel(request, response.status);
                this.clearPendingTakeProfitAfterCancel(request, response);
                this.latestLiveCancelResult = result;
                records.push(result);
            } finally {
                this.liveCancelInFlightByKey.delete(request.exitTriggerKey);
            }
        }
        return records;
    }

    private cancelLiveUiConfigForRequest(request: LiveCancelAllSubmitRequest): ExecutionLabLiveUiConfig {
        if (!this.findPendingTakeProfitForCancelRequest(request)) return this.activeLiveUiConfig();
        return {
            ...this.activeLiveUiConfig(),
            orderMode: "limit",
            limitCancelAllOnExitEnabled: true,
        };
    }

    private findPendingLimitForCancelRequest(request: LiveCancelAllSubmitRequest): PendingLimitSubmission | null {
        if (request.paperTradeId) {
            const pending = this.pendingLimitSubmissionByPaperTradeId.get(request.paperTradeId);
            if (pending) return pending;
        }
        const orderIds = new Set((request.orderIds ?? []).filter((orderId) => orderId.length > 0));
        if (orderIds.size > 0) {
            return Array.from(this.pendingLimitSubmissionByRequestId.values()).find((pending) =>
                pending.orderId !== undefined && orderIds.has(pending.orderId)
            ) ?? null;
        }
        return null;
    }

    private findPendingTakeProfitForCancelRequest(request: LiveCancelAllSubmitRequest): PendingTakeProfitSubmission | null {
        if (request.paperTradeId) {
            const pending = this.pendingTakeProfitSubmissionByPaperTradeId.get(request.paperTradeId);
            if (pending) return pending;
        }
        const orderIds = new Set((request.orderIds ?? []).filter((orderId) => orderId.length > 0));
        if (orderIds.size > 0) {
            return Array.from(this.pendingTakeProfitSubmissionByRequestId.values()).find((pending) =>
                pending.orderId !== undefined && orderIds.has(pending.orderId)
            ) ?? null;
        }
        return null;
    }

    private clearPendingTakeProfitAfterCancel(
        request: LiveCancelAllSubmitRequest,
        response: LiveCancelAllSubmitResponse
    ): void {
        const pending = this.findPendingTakeProfitForCancelRequest(request);
        if (!pending) return;
        if (shouldAttemptLiveExitAfterLimitCancel(response)) {
            this.pendingTakeProfitSubmissionByRequestId.delete(pending.requestId);
            this.pendingTakeProfitSubmissionByPaperTradeId.delete(pending.paperTradeId);
            this.liveOpenPositionByPaperTradeId.delete(pending.paperTradeId);
            return;
        }
        if (response.status !== "submitted" && response.status !== "dry_run" && response.status !== "duplicate") return;
        this.pendingTakeProfitSubmissionByRequestId.delete(pending.requestId);
        this.pendingTakeProfitSubmissionByPaperTradeId.delete(pending.paperTradeId);
        const position = this.liveOpenPositionByPaperTradeId.get(pending.paperTradeId);
        if (position) {
            position.takeProfitRequestId = undefined;
            position.takeProfitOrderId = undefined;
            position.takeProfitStatus = undefined;
        }
    }

    private trackUncanceledLimitAsLivePosition(
        request: LiveCancelAllSubmitRequest,
        response: LiveCancelAllSubmitResponse
    ): void {
        if (!shouldAttemptLiveExitAfterLimitCancel(response)) return;
        const pending = this.findPendingLimitForCancelRequest(request);
        if (
            !pending
            || pending.submittedShares === undefined
            || pending.submittedShares <= MIN_LIVE_POSITION_SHARES
            || this.liveOpenPositionByPaperTradeId.has(pending.paperTradeId)
        ) {
            return;
        }
        this.liveOpenPositionByPaperTradeId.set(pending.paperTradeId, {
            entryRequestId: pending.requestId,
            paperTradeId: pending.paperTradeId,
            eventStartTs: pending.eventStartTs,
            eventEndTs: pending.eventEndTs,
            marketSlug: pending.marketSlug,
            conditionId: pending.conditionId,
            tokenId: pending.tokenId,
            side: pending.side,
            signalTimeSec: pending.signalTimeSec,
            entryTimeSec: pending.entryTimeSec,
            entryPrice: pending.entryPrice,
            remainingShares: pending.submittedShares,
            entryOrderId: pending.orderId,
            lastExitStatus: response.status,
            lastExitReason: response.reason,
        });
    }

    private clearPendingLimitSubmissionsAfterCancel(
        request: LiveCancelAllSubmitRequest,
        status: LiveCancelAllResultRecord["status"]
    ): void {
        if (status !== "submitted" && status !== "dry_run" && status !== "duplicate") return;
        const orderIds = new Set((request.orderIds ?? []).filter((orderId) => orderId.length > 0));

        const shouldClear = (pending: PendingLimitSubmission): boolean => {
            if (orderIds.size > 0) return pending.orderId !== undefined && orderIds.has(pending.orderId);
            if (request.scope === "account" || request.scope === "session") return true;
            if (request.paperTradeId && pending.paperTradeId === request.paperTradeId) return true;
            if (request.scope === "market" && request.marketSlug && pending.marketSlug === request.marketSlug) return true;
            if (request.scope === "token" && request.tokenId && pending.tokenId === request.tokenId) return true;
            return false;
        };

        for (const pending of Array.from(this.pendingLimitSubmissionByRequestId.values())) {
            if (!shouldClear(pending)) continue;
            this.pendingLimitSubmissionByRequestId.delete(pending.requestId);
            this.pendingLimitSubmissionByPaperTradeId.delete(pending.paperTradeId);
        }
    }

    private async buildLiveExitRecords(
        exits: readonly PaperExitRecord[],
        missingExits: readonly PaperUnfilledRecord[],
        recordedAtIso: string,
        sessionToken: number
    ): Promise<ExecutionLabRecord[]> {
        const snapshot = this.snapshot;
        if (!snapshot) return [];
        for (const exit of exits) {
            this.queueLiveExit(exit);
        }
        for (const exit of missingExits) {
            this.queueLiveExit(exit);
        }

        const records: ExecutionLabRecord[] = [];
        const nowSec = Math.floor(Date.now() / 1000);
        for (const position of this.liveOpenPositionByPaperTradeId.values()) {
            const plan = position.pendingExit;
            if (
                !plan
                || position.remainingShares <= MIN_LIVE_POSITION_SHARES
                || this.liveExitInFlightByPaperTradeId.has(position.paperTradeId)
                || nowSec < plan.nextAttemptAtSec
            ) {
                continue;
            }
            if (this.pendingTakeProfitSubmissionByPaperTradeId.has(position.paperTradeId)) {
                position.lastExitStatus = "waiting_take_profit_cancel";
                position.lastExitReason = "take_profit_order_still_resting";
                continue;
            }
            if (nowSec >= position.eventEndTs) {
                position.pendingExit = undefined;
                position.lastExitStatus = "rejected";
                position.lastExitReason = "event_closed_before_exit";
                continue;
            }
            if (!this.isSessionActive(sessionToken, snapshot)) return records;

            const nextAttempt = plan.attempts + 1;
            const currentExitQuote = this.latestQuote?.event_start_ts === position.eventStartTs
                ? this.latestQuote
                : null;
            const currentBid = quotePriceForSide(currentExitQuote, position.side, "exit");
            const exitReferencePrice = nextAttempt > 1 && typeof currentBid === "number" && Number.isFinite(currentBid)
                ? currentBid
                : plan.paperExitPrice;
            const liveStatus = this.currentLiveExecutorStatus();
            const request = buildLiveExitSubmitRequest({
                snapshot,
                entryRequestId: position.entryRequestId,
                paperTradeId: position.paperTradeId,
                eventStartTs: position.eventStartTs,
                eventEndTs: position.eventEndTs,
                marketSlug: position.marketSlug,
                conditionId: position.conditionId,
                tokenId: position.tokenId,
                side: position.side,
                shares: position.remainingShares,
                signalTimeSec: position.signalTimeSec,
                entryTimeSec: position.entryTimeSec,
                exitTimeSec: plan.exitTimeSec,
                paperExitPrice: exitReferencePrice,
                liveEntryPrice: position.entryPrice,
                attempt: nextAttempt,
                orderType: liveStatus?.takerOrderType ?? LIVE_TRADE_DEFAULT_ORDER_TYPE,
                maxExitSlippageCents: liveStatus?.exitMaxSlippageCents ?? LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS,
                createdAtIso: recordedAtIso,
                nowSec,
            });
            const floorPreflight = resolveLiveExitFloorPreflight({
                currentBid,
                minPrice: request.minPrice,
            });
            const recordContext = this.liveRecordContext();
            const requestRecord = buildLiveExitRequestRecord(snapshot, request, recordedAtIso, recordContext);
            plan.attempts = nextAttempt;
            plan.nextAttemptAtSec = nowSec + LIVE_EXIT_RETRY_COOLDOWN_SEC;
            if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
            if (!floorPreflight.shouldSubmit) {
                position.lastExitStatus = "waiting_floor";
                position.lastExitReason = floorPreflight.reason;
                const result = buildLiveExitResultRecord(
                    snapshot,
                    request,
                    buildLiveTradeFailureResponse({
                        requestId: request.requestId,
                        status: "rejected",
                        reason: floorPreflight.reason,
                        minPrice: request.minPrice,
                        currentBid: currentBid ?? undefined,
                    }),
                    new Date().toISOString()
                );
                this.latestLiveExitResult = result;
                records.push(result);
                continue;
            }

            if (this.liveSubmissionBlockedReason) {
                position.pendingExit = undefined;
                position.lastExitStatus = "rejected";
                position.lastExitReason = this.liveSubmissionBlockedReason;
                const result = buildLiveExitResultRecord(
                    snapshot,
                    request,
                    buildLiveTradeFailureResponse({
                        requestId: request.requestId,
                        status: "rejected",
                        reason: this.liveSubmissionBlockedReason,
                        minPrice: request.minPrice,
                        currentBid: currentBid ?? undefined,
                    }),
                    new Date().toISOString()
                );
                this.latestLiveExitResult = result;
                records.push(result);
                continue;
            }

            this.liveExitInFlightByPaperTradeId.add(position.paperTradeId);
            this.startLiveExitSubmission(position, request, sessionToken);
        }

        return records;
    }

    private startLiveExitSubmission(
        position: LiveOpenExecutionPosition,
        request: LiveExitSubmitRequest,
        sessionToken: number
    ): void {
        const snapshot = this.snapshot;
        if (!snapshot || this.executionMode !== "live") {
            this.liveExitInFlightByPaperTradeId.delete(position.paperTradeId);
            return;
        }
        void this.submitLiveExit(position, request, sessionToken, snapshot).catch((error) => {
            debugLogger.error("execution_lab.live_exit_submission_failed", {
                sessionId: snapshot.sessionId,
                paperTradeId: position.paperTradeId,
                requestId: request.requestId,
                error: executionLabErrorMessage(error),
            });
        });
    }

    private async submitLiveExit(
        position: LiveOpenExecutionPosition,
        request: LiveExitSubmitRequest,
        sessionToken: number,
        snapshot: ExecutionLabSessionSnapshot
    ): Promise<void> {
        try {
            if (!this.isSessionActive(sessionToken, snapshot)) return;
            const startedMs = Date.now();
            const response = await submitExecutionLabLiveTrade(request, this.activeLiveUiConfig()).catch(() =>
                buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_unavailable",
                    minPrice: request.minPrice,
                })
            );
            if (!this.isSessionActive(sessionToken, snapshot)) return;
            const result = buildLiveExitResultRecord(snapshot, request, response, new Date().toISOString(), {
                latencyMs: Date.now() - startedMs,
            });
            this.latestLiveExitResult = result;
            this.maybeBlockLiveSubmissions(response);
            this.updateLiveExitPosition(position, response);
            await this.appendRecords([result]);
            if (!this.isSessionActive(sessionToken, snapshot)) return;
            this.render();
        } finally {
            this.liveExitInFlightByPaperTradeId.delete(position.paperTradeId);
        }
    }

    private findLivePositionForExitTrigger(exit: LiveExitTriggerRecord): LiveOpenExecutionPosition | null {
        const tradeId = exit.tradeId;
        if (tradeId) {
            const position = this.liveOpenPositionByPaperTradeId.get(tradeId);
            if (position) return position;
        }
        if (exit.recordType !== "paper_unfilled" || exit.eventStartTs === undefined || !exit.side) return null;
        return Array.from(this.liveOpenPositionByPaperTradeId.values()).find((position) =>
            position.eventStartTs === exit.eventStartTs
            && position.side === exit.side
            && position.remainingShares > MIN_LIVE_POSITION_SHARES
        ) ?? null;
    }

    private resolveLiveExitTriggerPlan(exit: LiveExitTriggerRecord, position: LiveOpenExecutionPosition): LiveExitPlan | null {
        if (exit.recordType === "paper_exit") {
            return {
                exitTimeSec: exit.exitTimeSec,
                paperExitPrice: exit.exitPrice,
                attempts: 0,
                nextAttemptAtSec: 0,
            };
        }
        if (exit.expectedExitTimeSec === undefined || !Number.isFinite(exit.expectedExitTimeSec)) return null;
        const currentExitQuote = this.latestQuote?.event_start_ts === position.eventStartTs
            ? this.latestQuote
            : null;
        const currentBid = quotePriceForSide(currentExitQuote, position.side, "exit");
        return {
            exitTimeSec: exit.expectedExitTimeSec,
            paperExitPrice: currentBid ?? position.entryPrice,
            attempts: 0,
            nextAttemptAtSec: 0,
        };
    }

    private queueLiveExit(exit: LiveExitTriggerRecord): void {
        const position = this.findLivePositionForExitTrigger(exit);
        if (!position || position.pendingExit) return;
        const plan = this.resolveLiveExitTriggerPlan(exit, position);
        if (!plan) return;
        position.pendingExit = plan;
    }

    private findPendingLimitForExitTrigger(exit: LiveExitTriggerRecord): PendingLimitSubmission | null {
        if (exit.tradeId) {
            const pending = this.pendingLimitSubmissionByPaperTradeId.get(exit.tradeId);
            if (pending) return pending;
        }
        if (exit.recordType !== "paper_unfilled" || exit.eventStartTs === undefined || !exit.side) return null;
        return Array.from(this.pendingLimitSubmissionByRequestId.values()).find((pending) =>
            pending.eventStartTs === exit.eventStartTs
            && pending.side === exit.side
        ) ?? null;
    }

    private findPendingTakeProfitForExitTrigger(exit: LiveExitTriggerRecord): PendingTakeProfitSubmission | null {
        if (exit.tradeId) {
            const pending = this.pendingTakeProfitSubmissionByPaperTradeId.get(exit.tradeId);
            if (pending) return pending;
        }
        if (exit.recordType !== "paper_unfilled" || exit.eventStartTs === undefined || !exit.side) return null;
        return Array.from(this.pendingTakeProfitSubmissionByRequestId.values()).find((pending) =>
            pending.eventStartTs === exit.eventStartTs
            && pending.side === exit.side
        ) ?? null;
    }

    private buildCancelExitTriggerKey(exit: LiveExitTriggerRecord, pending: PendingRestingSubmission | null): string {
        const exitTime = exit.recordType === "paper_exit"
            ? exit.exitTimeSec
            : exit.expectedExitTimeSec ?? "";
        const eventStart = exit.recordType === "paper_unfilled"
            ? exit.eventStartTs ?? pending?.eventStartTs ?? ""
            : pending?.eventStartTs ?? "";
        const side = exit.recordType === "paper_unfilled"
            ? exit.side ?? pending?.side ?? ""
            : pending?.side ?? "";
        return [
            this.snapshot?.sessionId ?? "",
            eventStart,
            side,
            pending?.tokenId ?? "",
            exit.tradeId ?? pending?.paperTradeId ?? "",
            exitTime,
            exit.recordType === "paper_exit" ? exit.exitReason : exit.expectedExitReason ?? exit.reason,
        ].join("|");
    }

    private buildLiveCancelAllRequest(exit: LiveExitTriggerRecord, recordedAtIso: string): LiveCancelAllSubmitRequest | null {
        const snapshot = this.snapshot;
        if (!snapshot) return null;
        const pending = this.findPendingLimitForExitTrigger(exit) ?? this.findPendingTakeProfitForExitTrigger(exit);
        const livePosition = this.findLivePositionForExitTrigger(exit);
        const exitTriggerKey = this.buildCancelExitTriggerKey(exit, pending);
        const paperTradeId = exit.tradeId ?? pending?.paperTradeId ?? livePosition?.paperTradeId;
        const marketSlug = pending?.marketSlug ?? livePosition?.marketSlug ?? exit.marketSlug;
        const conditionId = pending?.conditionId ?? livePosition?.conditionId;
        const tokenId = pending?.tokenId ?? livePosition?.tokenId;
        const orderIds = pending?.orderId ? [pending.orderId] : undefined;
        const scope = orderIds ? "session" : this.currentLiveExecutorStatus()?.cancelScope ?? "unknown";
        return {
            action: "cancel_all",
            requestId: buildLiveCancelAllRequestId({
                sessionId: snapshot.sessionId,
                exitTriggerKey,
            }),
            sessionId: snapshot.sessionId,
            paperTradeId,
            exitTriggerKey,
            createdAtIso: recordedAtIso,
            symbol: snapshot.outcomeSymbol,
            strategyKey: snapshot.strategyKey,
            marketSlug,
            conditionId,
            tokenId,
            orderIds,
            scope,
            reason: "limit_exit_signal",
            orderMode: "limit",
        };
    }

    private async buildLiveTradeRecords(
        acceptedEntries: readonly ExecutionLabOpenPaperPosition[],
        recordedAtIso: string,
        sameBatchExitedTradeIds: ReadonlySet<string>,
        sessionToken: number
    ): Promise<ExecutionLabRecord[]> {
        const snapshot = this.snapshot;
        if (this.executionMode !== "live" || !snapshot || acceptedEntries.length === 0) return [];
        const liveConfig = this.activeLiveUiConfig();

        const records: ExecutionLabRecord[] = [];
        for (const position of acceptedEntries) {
            if (
                this.liveTradeSubmittedByPaperTradeId.has(position.tradeId)
                || this.liveTradeInFlightByPaperTradeId.has(position.tradeId)
            ) {
                continue;
            }

            this.liveTradeInFlightByPaperTradeId.add(position.tradeId);
            this.liveTradeSubmittedByPaperTradeId.add(position.tradeId);
            const nowSec = Math.floor(Date.now() / 1000);
            const liveStatus = this.currentLiveExecutorStatus();
            const request = buildLiveTradeSubmitRequest({
                snapshot,
                position,
                createdAtIso: recordedAtIso,
                nowSec,
                liveConfig,
                orderType: liveStatus?.takerOrderType ?? liveConfig.takerOrderType,
                limitOrderType: liveStatus?.supportedLimitOrderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE,
                maxEntrySlippageCents: liveStatus?.entryMaxSlippageCents
                    ?? LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS,
            });
            const requestPriceFields = {
                maxPrice: request.maxPrice,
                limitPrice: request.orderMode === "limit" ? request.limitPrice : undefined,
                limitReferencePrice: request.orderMode === "limit" ? request.limitReferencePrice : undefined,
                limitOffsetEnabled: request.orderMode === "limit" ? request.limitOffsetEnabled : undefined,
                limitOffsetCents: request.orderMode === "limit" ? request.limitOffsetCents : undefined,
                limitFixedPriceEnabled: request.orderMode === "limit" ? request.limitFixedPriceEnabled : undefined,
                limitFixedPriceCents: request.orderMode === "limit" ? request.limitFixedPriceCents : undefined,
            };

            try {
                if (!this.isSessionActive(sessionToken, snapshot)) return records;
                const recordContext = this.liveRecordContext();
                const requestRecord = buildLiveTradeRequestRecord(snapshot, request, recordedAtIso, recordContext);
                if (sameBatchExitedTradeIds.has(position.tradeId)) {
                    if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
                    const result = buildLiveTradeResultRecord(
                        snapshot,
                        request,
                        buildLiveTradeFailureResponse({
                            requestId: request.requestId,
                            status: "rejected",
                            reason: "paper_exit_same_tick",
                            ...requestPriceFields,
                        }),
                        new Date().toISOString()
                    );
                    this.latestLiveTradeResult = result;
                    records.push(result);
                    continue;
                }

                const timingPreflight = resolvePolymarketEntryCutoff({
                    entryTimeSec: position.entryTimeSec,
                    eventEndTs: position.eventEndTs,
                    currentTimeSec: nowSec,
                    enabled: snapshot.backtestSettings.polymarketEntryCutoffEnabled,
                    cutoffSeconds: snapshot.backtestSettings.polymarketEntryCutoffSeconds,
                });
                if (nowSec >= position.eventEndTs) {
                    if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
                    const result = buildLiveTradeResultRecord(
                        snapshot,
                        request,
                        buildLiveTradeFailureResponse({
                            requestId: request.requestId,
                            status: "rejected",
                            reason: "event_already_closed",
                            ...requestPriceFields,
                        }),
                        new Date().toISOString()
                    );
                    this.latestLiveTradeResult = result;
                    records.push(result);
                    continue;
                }
                if (!timingPreflight.allowed) {
                    if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
                    const result = buildLiveTradeResultRecord(
                        snapshot,
                        request,
                        buildLiveTradeFailureResponse({
                            requestId: request.requestId,
                            status: "rejected",
                            reason: "event_too_close_to_close",
                            ...requestPriceFields,
                        }),
                        new Date().toISOString()
                    );
                    this.latestLiveTradeResult = result;
                    records.push(result);
                    continue;
                }

                const blockingPosition = this.findOpenLivePositionForEvent(position.eventStartTs);
                if (blockingPosition && blockingPosition.paperTradeId !== position.tradeId) {
                    if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
                    const result = buildLiveTradeResultRecord(
                        snapshot,
                        request,
                        buildLiveTradeFailureResponse({
                            requestId: request.requestId,
                            status: "rejected",
                            reason: "live_position_open",
                            ...requestPriceFields,
                        }),
                        new Date().toISOString()
                    );
                    this.latestLiveTradeResult = result;
                    records.push(result);
                    continue;
                }

                if (!request.marketSlug || !request.conditionId || !request.tokenId) {
                    if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
                    const result = buildLiveTradeResultRecord(
                        snapshot,
                        request,
                        buildLiveTradeFailureResponse({
                            requestId: request.requestId,
                            status: "rejected",
                            reason: "missing_market_identity",
                            ...requestPriceFields,
                        }),
                        new Date().toISOString()
                    );
                    this.latestLiveTradeResult = result;
                    records.push(result);
                    continue;
                }

                if (this.liveSubmissionBlockedReason) {
                    if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
                    const result = buildLiveTradeResultRecord(
                        snapshot,
                        request,
                        buildLiveTradeFailureResponse({
                            requestId: request.requestId,
                            status: "rejected",
                            reason: this.liveSubmissionBlockedReason,
                            ...requestPriceFields,
                        }),
                        new Date().toISOString()
                    );
                    this.latestLiveTradeResult = result;
                    records.push(result);
                    continue;
                }

                if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return records;
                const startedMs = Date.now();
                const response = await submitExecutionLabLiveTrade(request, liveConfig).catch(() =>
                    buildLiveTradeFailureResponse({
                        requestId: request.requestId,
                        reason: "executor_unavailable",
                        ...requestPriceFields,
                    })
                );
                if (!this.isSessionActive(sessionToken, snapshot)) return records;
                const resultResponse = request.orderMode === "limit"
                    ? {
                        ...response,
                        maxPrice: response.maxPrice ?? request.maxPrice,
                        limitPrice: response.limitPrice ?? request.limitPrice,
                        limitReferencePrice: response.limitReferencePrice ?? request.limitReferencePrice,
                        limitOffsetEnabled: response.limitOffsetEnabled ?? request.limitOffsetEnabled,
                        limitOffsetCents: response.limitOffsetCents ?? request.limitOffsetCents,
                        limitFixedPriceEnabled: response.limitFixedPriceEnabled ?? request.limitFixedPriceEnabled,
                        limitFixedPriceCents: response.limitFixedPriceCents ?? request.limitFixedPriceCents,
                    }
                    : response;
                const result = buildLiveTradeResultRecord(snapshot, request, resultResponse, new Date().toISOString(), {
                    latencyMs: Date.now() - startedMs,
                });
                this.latestLiveTradeResult = result;
                this.maybeBlockLiveSubmissions(response);
                records.push(result);
                this.trackPendingLimitSubmission(position, request, response);
                const livePosition = this.trackLiveEntryPosition(position, request.requestId, response);
                if (livePosition) {
                    this.queueLiveTakeProfitSubmission(livePosition, sessionToken);
                }
            } finally {
                this.liveTradeInFlightByPaperTradeId.delete(position.tradeId);
            }
        }

        return records;
    }

    private liveTakeProfitCents(): number | null {
        if (this.snapshot?.exitMode === "resolve_hold") return null;
        const settings = this.snapshot?.backtestSettings;
        if (!settings?.polymarketProtectionTakeProfitEnabled) return null;
        const cents = clampPolymarketProtectionCents(settings.polymarketProtectionTakeProfitCents);
        return cents > 0 ? cents : null;
    }

    private queueLiveTakeProfitSubmission(
        position: LiveOpenExecutionPosition,
        sessionToken: number
    ): void {
        if (
            this.queuedTakeProfitSubmissionByPaperTradeId.has(position.paperTradeId)
            || this.liveTakeProfitInFlightByPaperTradeId.has(position.paperTradeId)
            || this.pendingTakeProfitSubmissionByPaperTradeId.has(position.paperTradeId)
        ) {
            return;
        }
        this.queuedTakeProfitSubmissionByPaperTradeId.set(position.paperTradeId, { position, sessionToken });
    }

    private flushLiveTakeProfitSubmissions(sessionToken: number): void {
        for (const [paperTradeId, queued] of this.queuedTakeProfitSubmissionByPaperTradeId) {
            if (queued.sessionToken !== sessionToken) continue;
            this.queuedTakeProfitSubmissionByPaperTradeId.delete(paperTradeId);
            this.startLiveTakeProfitSubmission(queued.position, queued.sessionToken);
        }
    }

    private startLiveTakeProfitSubmission(
        position: LiveOpenExecutionPosition,
        sessionToken: number
    ): void {
        const snapshot = this.snapshot;
        if (!snapshot || this.executionMode !== "live") return;
        if (
            this.liveTakeProfitInFlightByPaperTradeId.has(position.paperTradeId)
            || this.pendingTakeProfitSubmissionByPaperTradeId.has(position.paperTradeId)
        ) {
            return;
        }
        void this.buildLiveTakeProfitRecords(position, sessionToken)
            .then(async (records) => {
                if (!this.isSessionActive(sessionToken, snapshot) || records.length === 0) return;
                await this.appendRecords(records);
                if (!this.isSessionActive(sessionToken, snapshot)) return;
                this.render();
            })
            .catch((error) => {
                debugLogger.error("execution_lab.live_take_profit_submission_failed", {
                    sessionId: snapshot.sessionId,
                    paperTradeId: position.paperTradeId,
                    error: executionLabErrorMessage(error),
                });
            });
    }

    private async buildLiveTakeProfitRecords(
        position: LiveOpenExecutionPosition,
        sessionToken: number
    ): Promise<ExecutionLabRecord[]> {
        const snapshot = this.snapshot;
        if (!snapshot || this.executionMode !== "live") return [];
        if (
            this.liveTakeProfitInFlightByPaperTradeId.has(position.paperTradeId)
            || this.pendingTakeProfitSubmissionByPaperTradeId.has(position.paperTradeId)
        ) {
            return [];
        }
        const takeProfitCents = this.liveTakeProfitCents();
        if (takeProfitCents === null || position.remainingShares <= MIN_LIVE_POSITION_SHARES) return [];
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec >= position.eventEndTs) return [];
        this.liveTakeProfitInFlightByPaperTradeId.add(position.paperTradeId);
        try {
            const liveStatus = this.currentLiveExecutorStatus();
            const recordedAtIso = new Date().toISOString();
            const request = buildLiveTakeProfitSubmitRequest({
                snapshot,
                entryRequestId: position.entryRequestId,
                paperTradeId: position.paperTradeId,
                eventStartTs: position.eventStartTs,
                eventEndTs: position.eventEndTs,
                marketSlug: position.marketSlug,
                conditionId: position.conditionId,
                tokenId: position.tokenId,
                side: position.side,
                shares: position.remainingShares,
                signalTimeSec: position.signalTimeSec,
                entryTimeSec: position.entryTimeSec,
                entryPrice: position.entryPrice,
                takeProfitCents,
                orderType: liveStatus?.supportedLimitOrderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE,
                createdAtIso: recordedAtIso,
                nowSec,
            });
            if (!request) {
                position.takeProfitStatus = "rejected";
                position.lastExitStatus = "rejected";
                position.lastExitReason = "take_profit_price_out_of_range";
                return [];
            }

            const requestRecord = buildLiveTradeRequestRecord(snapshot, request, recordedAtIso, this.liveRecordContext());
            if (!await this.appendLiveRequestRecord(requestRecord, sessionToken, snapshot)) return [];
            const startedMs = Date.now();
            const response = await submitExecutionLabLiveTrade(request, {
                ...this.activeLiveUiConfig(),
                orderMode: "limit",
            }).catch(() =>
                buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_unavailable",
                    maxPrice: request.maxPrice,
                    limitPrice: request.limitPrice,
                    limitReferencePrice: request.limitReferencePrice,
                    minPrice: request.minPrice,
                })
            );
            if (!this.isSessionActive(sessionToken, snapshot)) return [];
            const resultResponse = {
                ...response,
                maxPrice: response.maxPrice ?? request.maxPrice,
                limitPrice: response.limitPrice ?? request.limitPrice,
                limitReferencePrice: response.limitReferencePrice ?? request.limitReferencePrice,
                minPrice: response.minPrice ?? request.minPrice,
            };
            const result = buildLiveTradeResultRecord(snapshot, request, resultResponse, new Date().toISOString(), {
                latencyMs: Date.now() - startedMs,
            });
            this.latestLiveTradeResult = result;
            this.maybeBlockLiveSubmissions(response);
            this.trackTakeProfitSubmission(position, request, response);
            return [result];
        } finally {
            this.liveTakeProfitInFlightByPaperTradeId.delete(position.paperTradeId);
        }
    }

    private findOpenLivePositionForEvent(eventStartTs: number): LiveOpenExecutionPosition | null {
        for (const position of this.liveOpenPositionByPaperTradeId.values()) {
            if (position.eventStartTs === eventStartTs && position.remainingShares > MIN_LIVE_POSITION_SHARES) {
                return position;
            }
        }
        return null;
    }

    private trackPendingLimitSubmission(
        position: ExecutionLabOpenPaperPosition,
        request: LiveEntrySubmitRequest,
        response: { status: string; orderId?: string; submittedPrice?: number; submittedShares?: number }
    ): void {
        if (request.orderMode !== "limit") return;
        if (
            response.status !== "posted_live"
            && response.status !== "delayed"
            && !(response.status === "duplicate" && response.orderId)
        ) {
            return;
        }
        const pending: PendingLimitSubmission = {
            requestId: request.requestId,
            paperTradeId: position.tradeId,
            eventStartTs: position.eventStartTs,
            eventEndTs: position.eventEndTs,
            marketSlug: position.marketSlug,
            conditionId: position.conditionId,
            tokenId: request.tokenId,
            side: position.side,
            signalTimeSec: position.signalTimeSec,
            entryTimeSec: position.entryTimeSec,
            entryPrice: response.submittedPrice ?? request.limitPrice,
            submittedShares: response.submittedShares,
            limitPrice: request.limitPrice,
            orderId: response.orderId,
            lastStatus: response.status,
        };
        this.pendingLimitSubmissionByRequestId.set(request.requestId, pending);
        this.pendingLimitSubmissionByPaperTradeId.set(position.tradeId, pending);
    }

    private trackTakeProfitSubmission(
        position: LiveOpenExecutionPosition,
        request: LiveTakeProfitSubmitRequest,
        response: { status: string; reason?: string; orderId?: string; submittedShares?: number; filledShares?: number }
    ): void {
        position.takeProfitRequestId = request.requestId;
        position.takeProfitPrice = request.limitPrice;
        position.takeProfitStatus = response.status;
        position.takeProfitOrderId = response.orderId;
        if (
            response.status === "posted_live"
            || response.status === "delayed"
            || (response.status === "duplicate" && response.orderId)
        ) {
            const pending: PendingTakeProfitSubmission = {
                requestId: request.requestId,
                entryRequestId: request.entryRequestId,
                paperTradeId: position.paperTradeId,
                eventStartTs: position.eventStartTs,
                eventEndTs: position.eventEndTs,
                marketSlug: position.marketSlug,
                conditionId: position.conditionId,
                tokenId: position.tokenId,
                side: position.side,
                signalTimeSec: position.signalTimeSec,
                entryTimeSec: position.entryTimeSec,
                entryPrice: position.entryPrice,
                shares: response.submittedShares ?? request.shares,
                limitPrice: request.limitPrice,
                orderId: response.orderId,
                lastStatus: response.status,
            };
            this.pendingTakeProfitSubmissionByRequestId.set(request.requestId, pending);
            this.pendingTakeProfitSubmissionByPaperTradeId.set(position.paperTradeId, pending);
            return;
        }
        if (response.status !== "matched" && response.status !== "partial") return;
        const update = resolveLiveExitShareUpdate({
            remainingShares: position.remainingShares,
            response,
            minRemainingShares: MIN_LIVE_POSITION_SHARES,
        });
        if (update.filledShares === null) {
            if (update.closePosition) this.liveOpenPositionByPaperTradeId.delete(position.paperTradeId);
            return;
        }
        position.remainingShares = update.remainingShares;
        if (update.closePosition) {
            this.liveOpenPositionByPaperTradeId.delete(position.paperTradeId);
        }
    }

    private trackLiveEntryPosition(
        position: ExecutionLabOpenPaperPosition,
        entryRequestId: string,
        response: { status: string; submittedPrice?: number; submittedShares?: number; filledShares?: number; orderId?: string }
    ): LiveOpenExecutionPosition | null {
        if (response.status !== "matched" && response.status !== "partial") return null;
        const filledShares = resolveLiveTradeFilledShares(response);
        if (filledShares === null || filledShares <= MIN_LIVE_POSITION_SHARES) return null;
        const livePosition: LiveOpenExecutionPosition = {
            entryRequestId,
            paperTradeId: position.tradeId,
            eventStartTs: position.eventStartTs,
            eventEndTs: position.eventEndTs,
            marketSlug: position.marketSlug,
            conditionId: position.conditionId,
            tokenId: position.side === "yes" ? position.yesTokenId : position.noTokenId,
            side: position.side,
            signalTimeSec: position.signalTimeSec,
            entryTimeSec: position.entryTimeSec,
            entryPrice: response.submittedPrice ?? position.entryPrice,
            remainingShares: filledShares,
            entryOrderId: response.orderId,
        };
        this.liveOpenPositionByPaperTradeId.set(position.tradeId, livePosition);
        return livePosition;
    }

    private updateLiveExitPosition(
        position: LiveOpenExecutionPosition,
        response: { status: string; reason?: string; submittedShares?: number; filledShares?: number }
    ): void {
        position.lastExitStatus = response.status;
        position.lastExitReason = response.reason;
        if (isLiveTradeGeoblockReason(response.reason)) {
            position.pendingExit = undefined;
            return;
        }
        if (response.status === "delayed" || response.status === "posted_live") {
            position.pendingExit = undefined;
            return;
        }
        if (response.status !== "matched" && response.status !== "partial") return;
        const update = resolveLiveExitShareUpdate({
            remainingShares: position.remainingShares,
            response,
            minRemainingShares: MIN_LIVE_POSITION_SHARES,
        });
        if (update.filledShares === null) {
            if (update.closePosition) this.liveOpenPositionByPaperTradeId.delete(position.paperTradeId);
            return;
        }
        position.remainingShares = update.remainingShares;
        if (update.closePosition) {
            this.liveOpenPositionByPaperTradeId.delete(position.paperTradeId);
        }
    }

    private async tryLivePollFetch<T>(operation: () => Promise<T>): Promise<LivePollFetchResult<T>> {
        try {
            return { ok: true, value: await operation() };
        } catch (error) {
            if (!isExecutionLabTransientPollError(error)) throw error;
            this.setStatus(`Live fetch skipped: ${executionLabErrorMessage(error)}`, "warning");
            this.render();
            return { ok: false };
        }
    }

    private findBacktestTradeForPosition(
        position: ExecutionLabOpenPaperPosition,
        trades: readonly Trade[]
    ): Trade | null {
        return trades.find((trade) =>
            trade.type === position.chartDirection
            && finiteUnixSeconds(trade.entryTime) === position.entryTimeSec
        ) ?? null;
    }

    private collectExecutionParityMismatches(
        trades: readonly Trade[],
        records: readonly ExecutionLabRecord[],
        latestCandleTimeSec: number
    ): ExecutionParityMismatch[] {
        const paperState = this.paperState;
        if (!paperState) return [];
        const mismatches: ExecutionParityMismatch[] = [];
        const missingExitKeys = new Set<string>();
        for (const record of records) {
            if (record.recordType !== "paper_unfilled" || record.reason !== "missing_exit_quote") continue;
            missingExitKeys.add(`${record.side ?? ""}|${record.expectedExitTimeSec ?? ""}|${record.eventEndTs ?? ""}`);
            mismatches.push({
                mismatchType: "missing_exit_quote",
                latestCandleTimeSec,
                detail: `missing Polymarket exit quote for ${record.side?.toUpperCase() ?? "trade"} ${record.expectedExitReason ?? "exit"} at ${formatDateTime(record.expectedExitTimeSec)}`,
                expectedExitTimeSec: record.expectedExitTimeSec,
                expectedExitReason: record.expectedExitReason,
                eventEndTs: record.eventEndTs,
            });
        }

        mismatches.push(...collectEntryPriceFilterParityMismatches(paperState, latestCandleTimeSec));

        for (const position of paperState.openPositions.values()) {
            const trade = this.findBacktestTradeForPosition(position, trades);
            const expectedExitTimeSec = trade && trade.exitReason && trade.exitReason !== "end_of_data" && trade.exitReason !== "partial"
                ? finiteUnixSeconds(trade.exitTime)
                : null;
            if (
                trade
                && this.snapshot?.exitMode !== "resolve_hold"
                && expectedExitTimeSec !== null
                && expectedExitTimeSec <= latestCandleTimeSec
                && expectedExitTimeSec < position.eventEndTs
            ) {
                const missingExitKey = `${position.side}|${expectedExitTimeSec}|${position.eventEndTs}`;
                if (missingExitKeys.has(missingExitKey)) continue;
                mismatches.push({
                    mismatchType: "paper_open_after_backtest_exit",
                    latestCandleTimeSec,
                    detail: `paper ${position.side.toUpperCase()} still open; backtest closed ${trade.exitReason} at ${formatDateTime(expectedExitTimeSec)}`,
                    tradeId: position.tradeId,
                    expectedExitTimeSec,
                    expectedExitReason: trade.exitReason,
                    eventEndTs: position.eventEndTs,
                });
                continue;
            }
            if (latestCandleTimeSec >= position.eventEndTs) {
                mismatches.push({
                    mismatchType: "paper_open_after_event_end",
                    latestCandleTimeSec,
                    detail: `paper ${position.side.toUpperCase()} still open after event ended ${formatDateTime(position.eventEndTs)}`,
                    tradeId: position.tradeId,
                    eventEndTs: position.eventEndTs,
                });
            }
        }
        return mismatches;
    }

    private executionMismatchKey(mismatch: ExecutionParityMismatch): string {
        return [
            mismatch.mismatchType,
            mismatch.tradeId ?? "",
            mismatch.expectedExitTimeSec ?? "",
            mismatch.expectedExitReason ?? "",
            mismatch.eventEndTs ?? "",
        ].join("|");
    }

    private buildExecutionMismatchRecords(
        mismatches: readonly ExecutionParityMismatch[],
        recordedAtIso: string
    ): ExecutionParityMismatchRecord[] {
        const snapshot = this.snapshot;
        if (!snapshot || mismatches.length === 0) return [];
        const records: ExecutionParityMismatchRecord[] = [];
        for (const mismatch of mismatches) {
            const key = this.executionMismatchKey(mismatch);
            if (this.loggedExecutionMismatchKeys.has(key)) continue;
            this.loggedExecutionMismatchKeys.add(key);
            this.executionMismatchTotal += 1;
            records.push({
                recordType: "execution_parity_mismatch",
                sessionId: snapshot.sessionId,
                recordedAtIso,
                symbol: snapshot.symbol,
                interval: "1s",
                strategyKey: snapshot.strategyKey,
                mismatchType: mismatch.mismatchType,
                latestCandleTimeSec: mismatch.latestCandleTimeSec,
                detail: mismatch.detail,
                tradeId: mismatch.tradeId,
                expectedExitTimeSec: mismatch.expectedExitTimeSec,
                expectedExitReason: mismatch.expectedExitReason,
                eventEndTs: mismatch.eventEndTs,
            });
        }
        return records;
    }

    private updateExecutionParityState(mismatches: readonly ExecutionParityMismatch[]): void {
        if (mismatches.length === 0) {
            this.executionParityOk = this.executionMismatchTotal === 0;
            if (this.executionMismatchTotal === 0) this.latestExecutionMismatch = null;
            return;
        }
        this.executionParityOk = false;
        this.latestExecutionMismatch = mismatches[mismatches.length - 1] ?? null;
    }

    private appendLatestLoggedSignals(records: readonly ExecutionLabRecord[], signals: readonly ExecutionLabEvaluatedSignal[]): void {
        const loggedSignalKeys = new Set<string>();
        for (const record of records) {
            if (record.recordType === "signal_seen") loggedSignalKeys.add(`${record.signalType}:${record.signalTimeSec}`);
        }
        if (loggedSignalKeys.size === 0) return;
        const nextSignals = signals.filter((signal) => loggedSignalKeys.has(`${signal.signalType}:${signal.signalTimeSec}`));
        if (nextSignals.length > 0) this.latestSignals = [...this.latestSignals, ...nextSignals].slice(-20);
    }

    private formatDecisionQuote(side: SecondMarketSide | null, entryPrice?: number): string {
        if (side && entryPrice !== undefined && Number.isFinite(entryPrice)) {
            return `${side.toUpperCase()} ${formatCents(entryPrice)}`;
        }
        return "--";
    }

    private formatEntryFilterRejection(record: PaperUnfilledRecord): string {
        const bounds = getPolymarketEntryPriceFilterBounds(this.snapshot?.backtestSettings.polymarketEntryPriceFilterCents);
        const side = formatDecisionSide(record.side);
        if (!bounds || record.entryPrice === undefined || !Number.isFinite(record.entryPrice)) {
            return `${side} rejected by entry price filter`;
        }
        if (record.entryPrice <= bounds.lower) {
            return `${side} ${formatCents(record.entryPrice)} below min ${formatCents(bounds.lower)}`;
        }
        if (record.entryPrice >= bounds.upper) {
            return `${side} ${formatCents(record.entryPrice)} above max ${formatCents(bounds.upper)}`;
        }
        return `${side} ${formatCents(record.entryPrice)} rejected by entry price filter`;
    }

    private paperUnfilledReason(record: PaperUnfilledRecord): string {
        switch (record.reason) {
            case "entry_price_filtered":
                return `Rejected ${formatDecisionSide(record.side)} by Polymarket Entry Price Filter`;
            case "entry_too_close_to_close":
                return "Rejected because the event is too close to close";
            case "missing_entry_quote":
                return `Rejected because the exact entry quote at ${formatDateTime(record.entryTimeSec)} is missing`;
            case "missing_event":
                return "Rejected because no active event matched the signal";
            case "duplicate_event":
                return "Rejected because this event was already claimed";
            case "open_position":
                return "Rejected because another paper position is open";
            case "invalid_price":
                return "Rejected because the entry price is invalid";
            case "missing_exit_quote":
                return record.expectedExitTimeSec === undefined
                    ? "Rejected because the expected exit quote is missing"
                    : `Rejected because the expected exit quote at ${formatDateTime(record.expectedExitTimeSec)} is missing`;
        }
    }

    private updateLatestPaperDecision(records: readonly ExecutionLabRecord[]): void {
        for (let i = records.length - 1; i >= 0; i -= 1) {
            const record = records[i];
            if (record.recordType === "paper_entry") {
                this.latestPaperDecision = {
                    kind: "accepted",
                    signalState: sideToSignalState(record.side),
                    side: record.side,
                    status: "Accepted",
                    reason: "Paper entry opened",
                    quote: this.formatDecisionQuote(record.side, record.entryPrice),
                    rejectedEntry: null,
                };
                return;
            }
            if (record.recordType === "paper_unfilled") {
                this.latestPaperDecision = {
                    kind: "rejected",
                    signalState: sideToSignalState(record.side),
                    side: record.side,
                    status: "Rejected",
                    reason: this.paperUnfilledReason(record),
                    quote: this.formatDecisionQuote(record.side, record.entryPrice),
                    rejectedEntry: record.reason === "entry_price_filtered"
                        ? this.formatEntryFilterRejection(record)
                        : null,
                };
                return;
            }
        }
    }

    private addPolymarketQuote(quote: PolymarketClob1sQuoteRow, includeStrategyContext = true): void {
        this.liveQuoteByTime.set(quote.sample_ts, quote);
        if (includeStrategyContext) {
            this.strategyQuoteByTime.set(quote.sample_ts, quote);
        }
        this.polymarketPriceByTime.set(quote.sample_ts, {
            time: quote.sample_ts as Time,
            yes: quoteMid(quote.yes_bid, quote.yes_ask, quote.yes_mid),
            no: quoteMid(quote.no_bid, quote.no_ask, quote.no_mid),
        });
        this.trimQuoteBuffers();
    }

    private trimQuoteBuffers(): void {
        this.trimQuoteBuffer(this.liveQuoteByTime);
        this.trimQuoteBuffer(this.strategyQuoteByTime);
        this.trimQuoteBuffer(this.polymarketPriceByTime);
    }

    private trimQuoteBuffer<T>(buffer: Map<number, T>): void {
        if (buffer.size <= MAX_POLYMARKET_PRICE_POINTS) return;
        const sortedKeys = Array.from(buffer.keys()).sort((left, right) => left - right);
        for (const key of sortedKeys.slice(0, buffer.size - MAX_POLYMARKET_PRICE_POINTS)) {
            buffer.delete(key);
        }
    }

    private getLiveQuoteBuffer(): PolymarketClob1sQuoteRow[] {
        return sortedMapValues(this.liveQuoteByTime);
    }

    private getStrategyQuoteBuffer(): PolymarketClob1sQuoteRow[] {
        return sortedMapValues(this.strategyQuoteByTime);
    }

    private async loadMissingTradeQuotes(
        snapshot: ExecutionLabSessionSnapshot,
        trades: readonly Trade[],
        latestCandleTimeSec: number,
        previousProcessedCandleTimeSec: number | null
    ): Promise<void> {
        const quoteTimes = collectExecutionLabTradeQuoteTimes({
            backtestSettings: snapshot.backtestSettings,
            trades,
            latestCandleTimeSec,
            previousProcessedCandleTimeSec,
        });
        const missingTimes = quoteTimes.filter((sampleTs) => !this.liveQuoteByTime.has(sampleTs));
        if (missingTimes.length === 0) return;
        await this.addStoredQuoteRange(
            snapshot,
            Math.min(...missingTimes),
            Math.max(...missingTimes),
            false
        );
    }

    private getPolymarketPricePoints(): ExecutionLabPolymarketPricePoint[] {
        return sortedMapValues(this.polymarketPriceByTime);
    }

    private findCandleCloseAt(ts: number): number | null {
        for (let index = this.candles.length - 1; index >= 0; index -= 1) {
            const candleTs = finiteUnixSeconds(this.candles[index]!.time);
            if (candleTs === ts) return this.candles[index]!.close;
            if (candleTs !== null && candleTs < ts) return null;
        }
        return null;
    }

    private recordPriceDiagnostic(args: {
        mode: "miner" | "paper" | "live";
        symbol: SecondMarketSymbol;
        marketType: "spot" | "futures";
        latestCandleTimeSec: number;
        latestCandle: OHLCVData;
        quote: PolymarketClob1sQuoteRow | null;
        feedLagSec: number | null;
    }): void {
        const warnings: string[] = [];
        const liveCandle = args.latestCandle as ExecutionLabLiveCandle;
        const candleTradeCount = Number.isFinite(Number(liveCandle.tradeCount))
            ? Math.floor(Number(liveCandle.tradeCount))
            : null;
        const candleSource = typeof liveCandle.source === "string" && liveCandle.source.trim()
            ? liveCandle.source.trim()
            : null;
        const candleUpdatedAtSec = Number.isFinite(Number(liveCandle.updatedAt))
            ? Math.floor(Number(liveCandle.updatedAt))
            : null;
        if (args.feedLagSec !== null && args.feedLagSec > MAX_LIVE_CANDLE_LAG_SEC) {
            warnings.push("binance_feed_lag");
        }
        if (!args.quote) {
            warnings.push("missing_polymarket_quote");
        }

        const quoteAgeSec = args.quote?.quote_age_ms === null || args.quote?.quote_age_ms === undefined
            ? null
            : args.quote.quote_age_ms / 1000;
        const sourceAgeSec = args.quote?.source_ts_ms
            ? Math.max(0, (Date.now() - args.quote.source_ts_ms) / 1000)
            : null;
        const sampleMinusCandleSec = args.quote ? args.quote.sample_ts - args.latestCandleTimeSec : null;
        if (sampleMinusCandleSec !== null && Math.abs(sampleMinusCandleSec) > 1) {
            warnings.push(sampleMinusCandleSec < 0 ? "polymarket_quote_stale_vs_candle" : "polymarket_quote_ahead_of_candle");
        }
        if (quoteAgeSec !== null && quoteAgeSec > MAX_LIVE_CANDLE_LAG_SEC) {
            warnings.push("polymarket_quote_age");
        }
        if (sourceAgeSec !== null && sourceAgeSec > MAX_LIVE_CANDLE_LAG_SEC) {
            warnings.push("polymarket_source_age");
        }

        const qualityFlags = args.quote?.quality_flags
            ? args.quote.quality_flags.split(",").map((flag) => flag.trim()).filter(Boolean)
            : [];
        warnings.push(...qualityFlags.map((flag) => `quote_${flag}`));

        const candleHasNoTrades = (args.latestCandle.volume ?? 0) === 0 && (candleTradeCount === null || candleTradeCount === 0);
        const candleIsFill = candleSource?.includes("fill") ?? false;
        if (candleHasNoTrades) {
            warnings.push("binance_zero_volume_candle");
        }
        if (candleIsFill) {
            warnings.push("binance_fill_candle");
        }
        const previousSample = this.diagnosticSamples[this.diagnosticSamples.length - 1] ?? null;
        if (previousSample?.symbol === args.symbol && previousSample.marketType === args.marketType) {
            const candleSequenceWarning = resolveExecutionLabCandleSequenceWarning({
                currentTimeSec: args.latestCandleTimeSec,
                previousTimeSec: previousSample.candle.timeSec,
                currentHasNoTrades: candleHasNoTrades,
                currentIsFill: candleIsFill,
            });
            if (candleSequenceWarning) {
                warnings.push(candleSequenceWarning);
            }
        }

        const eventStartClose = args.quote ? this.findCandleCloseAt(args.quote.event_start_ts) : null;
        const moveFromStart = eventStartClose === null ? null : args.latestCandle.close - eventStartClose;
        const moveFromStartPct = eventStartClose === null || eventStartClose === 0
            ? null
            : (moveFromStart as number) / eventStartClose * 100;

        const sample: ExecutionLabDiagnosticSample = {
            recordedAtIso: new Date().toISOString(),
            mode: args.mode,
            symbol: args.symbol,
            marketType: args.marketType,
            candle: {
                timeSec: args.latestCandleTimeSec,
                open: args.latestCandle.open,
                high: args.latestCandle.high,
                low: args.latestCandle.low,
                close: args.latestCandle.close,
                volume: args.latestCandle.volume ?? 0,
                tradeCount: candleTradeCount,
                source: candleSource,
                updatedAtIso: candleUpdatedAtSec === null ? null : new Date(candleUpdatedAtSec * 1000).toISOString(),
            },
            feedLagSec: args.feedLagSec,
            quote: args.quote
                ? {
                    sampleTs: args.quote.sample_ts,
                    sampleMinusCandleSec: sampleMinusCandleSec ?? 0,
                    quoteAgeSec,
                    source: args.quote.source,
                    sourceAgeSec,
                    yesBid: args.quote.yes_bid,
                    yesAsk: args.quote.yes_ask,
                    yesMid: quoteMid(args.quote.yes_bid, args.quote.yes_ask, args.quote.yes_mid),
                    noBid: args.quote.no_bid,
                    noAsk: args.quote.no_ask,
                    noMid: quoteMid(args.quote.no_bid, args.quote.no_ask, args.quote.no_mid),
                    qualityFlags,
                }
                : null,
            event: args.quote
                ? {
                    marketSlug: args.quote.market_slug,
                    eventStartTs: args.quote.event_start_ts,
                    eventEndTs: args.quote.event_end_ts,
                    secondsToEnd: args.quote.event_end_ts - args.latestCandleTimeSec,
                    startClose: eventStartClose,
                    moveFromStart,
                    moveFromStartPct,
                }
                : null,
            warnings: Array.from(new Set(warnings)),
        };

        recordExecutionLabDiagnosticStats(this.diagnosticStats, sample);
        this.diagnosticSamples.push(sample);
        if (this.diagnosticSamples.length > MAX_EXECUTION_LAB_DIAGNOSTIC_SAMPLES) {
            this.diagnosticSamples.splice(0, this.diagnosticSamples.length - MAX_EXECUTION_LAB_DIAGNOSTIC_SAMPLES);
        }
        this.renderDiagnostics();
    }

    private buildDiagnostics(): ExecutionLabDiagnostics | null {
        return buildExecutionLabDiagnostics(this.diagnosticSamples, this.diagnosticStats, {
            retainedSampleLimit: MAX_EXECUTION_LAB_DIAGNOSTIC_SAMPLES,
            segmentLimit: MAX_EXECUTION_LAB_DIAGNOSTIC_EXPORT_SEGMENTS,
            maxLiveCandleLagSec: MAX_LIVE_CANDLE_LAG_SEC,
        });
    }

    private async stop(reason: "user_stop" | "error", message?: string): Promise<void> {
        this.sessionRunToken += 1;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.stopStreamTimer();
        this.candleRefreshPromise = null;
        const paperState = this.paperState;
        this.setRunningState(false);
        this.sessionLiveUiConfig = null;
        if (paperState) {
            try {
                await this.appendRecords([createSessionStopRecord(paperState, reason, new Date().toISOString(), message)]);
            } catch {
                // Chart restore should not depend on the final log append.
            }
        }
        this.restoreStateChart();
        this.setStatus(message ?? "Stopped", reason === "error" ? "error" : "neutral");
        this.render();
    }

    private addMarkers(markers: readonly ExecutionLabPaperMarker[]): void {
        for (const marker of markers) this.markerById.set(marker.id, this.toSeriesMarker(marker));
        chartManager.displayExecutionLabMarkers(Array.from(this.markerById.values()));
    }

    private toSeriesMarker(marker: ExecutionLabPaperMarker): SeriesMarker<Time> {
        const isSellLike = marker.side === "no";
        if (marker.kind === "entry") {
            return {
                time: marker.time,
                position: isSellLike ? "aboveBar" : "belowBar",
                color: isSellLike ? ENHANCED_CANDLE_COLORS.down : ENHANCED_CANDLE_COLORS.up,
                shape: isSellLike ? "arrowDown" : "arrowUp",
                text: marker.text,
                size: 2,
            };
        }
        return {
            time: marker.time,
            position: isSellLike ? "belowBar" : "aboveBar",
            color: ENHANCED_CANDLE_COLORS.up,
            shape: isSellLike ? "arrowUp" : "arrowDown",
            text: marker.text,
            size: 2,
        };
    }

    private renderMetricGrid(container: HTMLElement, metrics: ExecutionLabPerformanceMetrics | null, extras?: { entries?: number }): void {
        container.innerHTML = "";
        const values = metrics
            ? [
                ["Trades", String(metrics.trades)],
                ["Entries", String(extras?.entries ?? metrics.trades)],
                ["Win Rate", formatPercentNullable(metrics.winRatePct)],
                ["Profit Factor", formatRatioNullable(metrics.profitFactor)],
                ["Expectancy", formatSignedUsdNullable(metrics.expectancyUsd)],
                ["Avg Win", formatSignedUsdNullable(metrics.avgWinUsd)],
                ["Avg Loss", formatSignedUsdNullable(metrics.avgLossUsd)],
                ["Total PnL", formatMoney(metrics.totalPnlUsd)],
            ]
            : [
                ["Trades", "--"],
                ["Entries", "--"],
                ["Win Rate", "--"],
                ["Profit Factor", "--"],
                ["Expectancy", "--"],
                ["Avg Win", "--"],
                ["Avg Loss", "--"],
                ["Total PnL", "--"],
            ];
        for (const [label, value] of values) {
            const item = document.createElement("div");
            item.className = "execution-lab-metric";
            const labelEl = document.createElement("div");
            labelEl.className = "execution-lab-metric-label";
            labelEl.textContent = label;
            const valueEl = document.createElement("div");
            valueEl.className = "execution-lab-metric-value";
            valueEl.textContent = value;
            if (label.includes("PnL") || label.includes("Expectancy") || label.includes("Avg")) {
                const numeric = value.startsWith("+$") ? 1 : value.startsWith("-$") ? -1 : 0;
                valueEl.classList.toggle("is-positive", numeric > 0);
                valueEl.classList.toggle("is-negative", numeric < 0);
            }
            item.appendChild(labelEl);
            item.appendChild(valueEl);
            container.appendChild(item);
        }
    }

    private renderPaperMetrics(): void {
        const dom = this.dom;
        if (!dom) return;
        const paperState = this.paperState;
        this.renderMetricGrid(
            dom.paperMetrics,
            paperState ? computeExecutionLabPerformanceMetrics(paperState.closedTrades) : null,
            paperState
                ? {
                    entries: paperState.totalEntries,
                }
                : undefined
        );
    }

    private renderComparisonMetrics(): void {
        const dom = this.dom;
        if (!dom) return;
        const comparison = this.latestComparison;
        this.renderMetricGrid(
            dom.comparisonMetrics,
            comparison?.metrics ?? null,
            comparison
                ? {
                    entries: comparison.totalEntries,
                }
                : undefined
        );
    }

    private renderDiagnostics(): void {
        const dom = this.dom;
        if (!dom) return;
        const latest = this.diagnosticSamples[this.diagnosticSamples.length - 1] ?? null;
        dom.copyDiagnosticsButton.disabled = !latest;
        if (!latest) {
            dom.diagnosticsSummary.textContent = "No diagnostics yet.";
            dom.diagnosticsSummary.classList.remove("is-warning", "is-running");
            return;
        }

        const quoteLag = latest.quote ? latest.quote.sampleMinusCandleSec : null;
        const parts = [
            `${latest.mode.toUpperCase()} ${latest.symbol} ${latest.marketType}`,
            `candle ${formatDateTime(latest.candle.timeSec)} close ${latest.candle.close.toFixed(2)}`,
            `feed lag ${formatSeconds(latest.feedLagSec)}`,
            latest.quote
                ? `quote lag ${formatSignedSeconds(quoteLag)} age ${formatSeconds(latest.quote.quoteAgeSec)}`
                : "quote --",
            latest.event?.moveFromStartPct !== null && latest.event?.moveFromStartPct !== undefined
                ? `event move ${latest.event.moveFromStartPct >= 0 ? "+" : ""}${latest.event.moveFromStartPct.toFixed(3)}%`
                : null,
            latest.warnings.length > 0 ? `warnings ${latest.warnings.join(", ")}` : "OK",
        ].filter(Boolean);
        dom.diagnosticsSummary.textContent = parts.join(" | ");
        dom.diagnosticsSummary.classList.toggle("is-warning", latest.warnings.length > 0);
        dom.diagnosticsSummary.classList.toggle("is-running", latest.warnings.length === 0);
    }

    private renderDecision(
        latestSignal: ExecutionLabEvaluatedSignal | null,
        openPosition: ExecutionLabOpenPaperPosition | null
    ): void {
        const dom = this.dom;
        if (!dom) return;
        let signalState: ExecutionLabSignalState = "neutral";
        let status = "Waiting";
        let reason = latestSignal
            ? `Latest strategy signal maps to ${signalSide(latestSignal.signalType)}.`
            : "No paper decision yet.";
        let quote = "--";
        let currentSide: SecondMarketSide | null = latestSignal ? (latestSignal.signalType === "buy" ? "yes" : "no") : null;
        let currentPriceMode: "entry" | "exit" = "entry";
        let rejectedEntry: string | null = null;
        let tone: "waiting" | "accepted" | "rejected" | "open" = "waiting";

        if (this.latestPaperDecision) {
            currentSide = this.latestPaperDecision.side;
            status = this.latestPaperDecision.status;
            reason = this.latestPaperDecision.reason;
            quote = this.latestPaperDecision.quote;
            rejectedEntry = this.latestPaperDecision.rejectedEntry;
            tone = this.latestPaperDecision.kind === "accepted" ? "accepted" : "rejected";
        }

        if (openPosition) {
            signalState = sideToSignalState(openPosition.side);
            currentSide = openPosition.side;
            currentPriceMode = "exit";
            status = "Open";
            reason = `Paper ${openPosition.side.toUpperCase()} position is active.`;
            quote = this.formatDecisionQuote(openPosition.side, openPosition.entryPrice);
            rejectedEntry = null;
            tone = "open";
        }

        if (!openPosition && latestSignal && !this.latestPaperDecision) {
            status = "Signal";
            signalState = signalTypeToState(latestSignal.signalType);
        }

        const currentPrice = quotePriceForSide(this.latestQuote, currentSide, currentPriceMode);
        dom.signalState.dataset.state = signalState;
        dom.decisionStatus.textContent = status;
        dom.decisionReason.textContent = reason;
        dom.decisionQuote.textContent = quote;
        dom.decisionCurrentPrice.textContent = currentSide && currentPrice !== null
            ? `${currentSide.toUpperCase()} ${currentPriceMode === "entry" ? "ask" : "bid"} ${formatCents(currentPrice)}`
            : "--";
        dom.decisionRejectedLabel.hidden = !rejectedEntry;
        dom.decisionRejectedEntry.hidden = !rejectedEntry;
        dom.decisionRejectedEntry.textContent = rejectedEntry ?? "--";
        dom.decisionCard.classList.toggle("is-waiting", tone === "waiting");
        dom.decisionCard.classList.toggle("is-accepted", tone === "accepted");
        dom.decisionCard.classList.toggle("is-rejected", tone === "rejected");
        dom.decisionCard.classList.toggle("is-open", tone === "open");
    }

    private renderIdle(): void {
        const dom = this.dom;
        if (!dom) return;
        dom.configSnapshot.textContent = "Ready";
        dom.latestCandle.textContent = "--";
        dom.quoteSnapshot.textContent = "--";
        dom.feedLag.textContent = "--";
        dom.quoteAge.textContent = "--";
        dom.activeEvent.textContent = "--";
        this.renderLiveExecutorStatus(this.latestLiveExecutorStatus);
        dom.latestSignal.textContent = "--";
        dom.signalParity.textContent = "--";
        dom.signalParity.classList.remove("is-ok", "is-warning");
        dom.signalMismatch.textContent = "--";
        dom.openPosition.textContent = "--";
        dom.livePosition.textContent = "--";
        dom.liveResult.textContent = "--";
        dom.sessionPnl.textContent = "--";
        dom.logPath.textContent = "--";
        this.renderDecision(null, null);
        this.renderPaperMetrics();
        this.renderComparisonMetrics();
        this.renderDiagnostics();
        this.setComparisonStatus("No comparison run.");
        dom.recentTrades.innerHTML = '<div class="execution-lab-empty">No paper trades yet.</div>';
    }

    private renderMinerChart(): void {
        const dom = this.dom;
        const context = this.minerChartContext;
        if (!dom || !context || this.running) return;
        const latestCandle = this.candles[this.candles.length - 1] ?? null;
        const latestTs = latestCandle ? finiteUnixSeconds(latestCandle.time) : null;
        const quoteAgeSec = this.latestQuote?.quote_age_ms === null || this.latestQuote?.quote_age_ms === undefined
            ? null
            : this.latestQuote.quote_age_ms / 1000;

        dom.configSnapshot.textContent = [
            "1s Miner",
            context.symbol,
            context.marketType,
            context.outcomeSymbol ? `${context.symbol}->${context.outcomeSymbol}` : null,
        ].filter(Boolean).join(" | ");
        dom.latestCandle.textContent = latestCandle && latestTs !== null ? formatDateTime(latestTs) : "--";
        dom.quoteSnapshot.textContent = this.latestQuote
            ? [
                `YES bid ${formatPolyPrice(this.latestQuote.yes_bid)} ask ${formatPolyPrice(this.latestQuote.yes_ask)} mid ${formatPolyPrice(this.latestQuote.yes_mid)}`,
                `NO bid ${formatPolyPrice(this.latestQuote.no_bid)} ask ${formatPolyPrice(this.latestQuote.no_ask)} mid ${formatPolyPrice(this.latestQuote.no_mid)}`,
            ].join(" | ")
            : "--";
        dom.feedLag.textContent = formatSeconds(this.feedLagSec);
        dom.quoteAge.textContent = formatSeconds(quoteAgeSec);
        dom.activeEvent.textContent = this.latestQuote
            ? `${this.latestQuote.market_slug} ends ${formatDateTime(this.latestQuote.event_end_ts)}`
            : "--";
        dom.logPath.textContent = "--";
        dom.latestSignal.textContent = "--";
        dom.signalParity.classList.remove("is-ok", "is-warning");
        dom.signalParity.textContent = "--";
        dom.signalMismatch.textContent = "--";
        dom.openPosition.textContent = "--";
        dom.livePosition.textContent = "--";
        dom.liveResult.textContent = "--";
        dom.sessionPnl.textContent = "--";
        this.renderDecision(null, null);
        this.renderPaperMetrics();
        this.renderComparisonMetrics();
        this.renderDiagnostics();
        dom.recentTrades.innerHTML = '<div class="execution-lab-empty">No paper trades yet.</div>';
    }

    private render(): void {
        const dom = this.dom;
        const snapshot = this.snapshot;
        if (!dom || !snapshot) return;
        const latestCandle = this.candles[this.candles.length - 1] ?? null;
        const latestTs = latestCandle ? finiteUnixSeconds(latestCandle.time) : null;
        const latestSignal = this.latestSignals[this.latestSignals.length - 1] ?? null;
        const quoteAgeSec = this.latestQuote?.quote_age_ms === null || this.latestQuote?.quote_age_ms === undefined
            ? null
            : this.latestQuote.quote_age_ms / 1000;

        dom.configSnapshot.textContent = [
            this.executionMode === "live" ? "LIVE TRADE" : "Paper Trade",
            snapshot.strategyName,
            `${snapshot.symbol}->${snapshot.outcomeSymbol}`,
            `$${snapshot.stakeUsd.toFixed(2)}`,
            this.executionMode === "live" ? this.activeLiveUiConfig().orderMode : null,
            formatProtectionSummary(snapshot.backtestSettings),
            snapshot.exitMode,
            snapshot.allowMultipleTradesPerEvent ? "multi-event on" : "one/event",
        ].filter(Boolean).join(" | ");
        dom.latestCandle.textContent = latestCandle && latestTs !== null ? formatDateTime(latestTs) : "--";
        dom.quoteSnapshot.textContent = this.latestQuote
            ? [
                `YES bid ${formatPolyPrice(this.latestQuote.yes_bid)} ask ${formatPolyPrice(this.latestQuote.yes_ask)} mid ${formatPolyPrice(this.latestQuote.yes_mid)}`,
                `NO bid ${formatPolyPrice(this.latestQuote.no_bid)} ask ${formatPolyPrice(this.latestQuote.no_ask)} mid ${formatPolyPrice(this.latestQuote.no_mid)}`,
            ].join(" | ")
            : "--";
        dom.feedLag.textContent = formatSeconds(this.feedLagSec);
        dom.quoteAge.textContent = formatSeconds(quoteAgeSec);
        dom.activeEvent.textContent = this.latestQuote
            ? `${this.latestQuote.market_slug} ends ${formatDateTime(this.latestQuote.event_end_ts)}`
            : "--";
        dom.logPath.textContent = this.logPath ?? "--";
        dom.latestSignal.textContent = latestSignal
            ? `${latestSignal.signalType.toUpperCase()} -> ${signalSide(latestSignal.signalType)} | ${formatDateTime(latestSignal.signalTimeSec)}`
            : "--";
        dom.signalParity.classList.toggle("is-ok", this.executionParityOk === true);
        dom.signalParity.classList.toggle("is-warning", this.executionParityOk === false);
        dom.signalParity.textContent = this.executionParityOk === null
            ? "--"
            : this.executionParityOk
                ? `OK | mismatches ${this.executionMismatchTotal}`
                : `MISMATCH | total ${this.executionMismatchTotal}`;
        dom.signalMismatch.textContent = this.latestExecutionMismatch
            ? this.latestExecutionMismatch.detail
            : "--";

        const openPositions = this.paperState ? Array.from(this.paperState.openPositions.values()) : [];
        const pendingSettlements = this.paperState ? Array.from(this.paperState.pendingSettlements.values()) : [];
        const firstOpen = openPositions[0] ?? null;
        const firstPending = pendingSettlements[0] ?? null;
        this.renderDecision(latestSignal, firstOpen);
        const openState = firstOpen && latestTs !== null && firstOpen.eventEndTs <= latestTs
            ? `pending resolution since ${formatDateTime(firstOpen.eventEndTs)}`
            : firstOpen
                ? `event ends ${formatDateTime(firstOpen.eventEndTs)}`
                : "";
        dom.openPosition.textContent = firstOpen
            ? `${firstOpen.side.toUpperCase()} | stake ${formatUsd(firstOpen.stakeUsd)} | entry ${formatPolyPrice(firstOpen.entryPrice)} | shares ${firstOpen.shares.toFixed(4)} | ${openState}`
            : firstPending
                ? `pending settlement ${pendingSettlements.length} | latest ${firstPending.side.toUpperCase()} ended ${formatDateTime(firstPending.eventEndTs)}`
            : "--";

        const livePosition = this.firstOpenLivePosition();
        const pendingLimit = this.firstPendingLimitSubmission();
        dom.livePosition.textContent = livePosition
            ? [
                livePosition.side.toUpperCase(),
                `shares ${livePosition.remainingShares.toFixed(4)}`,
                `entry ${formatPolyPrice(livePosition.entryPrice)}`,
                livePosition.takeProfitPrice ? `tp ${formatPolyPrice(livePosition.takeProfitPrice)}` : null,
                livePosition.takeProfitStatus ? `tp ${formatLiveStatus(livePosition.takeProfitStatus)}` : null,
                livePosition.lastExitStatus ? `exit ${formatLiveStatus(livePosition.lastExitStatus)}` : null,
                livePosition.lastExitReason,
            ].filter(Boolean).join(" | ")
            : pendingLimit
                ? [
                    "LIMIT PENDING",
                    pendingLimit.side.toUpperCase(),
                    `limit ${formatPolyPrice(pendingLimit.limitPrice)}`,
                    pendingLimit.lastStatus,
                    pendingLimit.orderId ? `order ${pendingLimit.orderId}` : null,
                ].filter(Boolean).join(" | ")
            : "--";

        const liveResult = this.latestLiveResult();
        dom.liveResult.textContent = liveResult
            ? [
                liveResult.action,
                formatLiveStatus(liveResult.record.status),
                liveResult.record.reason,
                liveResult.action !== "cancel" && liveResult.record.orderId ? `order ${liveResult.record.orderId}` : null,
                liveResult.action === "entry" && liveResult.record.currentAsk !== undefined ? `ask ${formatPolyPrice(liveResult.record.currentAsk)}` : null,
                liveResult.action === "entry" && liveResult.record.maxPrice !== undefined && liveResult.record.limitPrice === undefined ? `cap ${formatPolyPrice(liveResult.record.maxPrice)}` : null,
                (liveResult.action === "entry" || liveResult.action === "take_profit") && liveResult.record.limitPrice !== undefined
                    ? `limit ${formatPolyPrice(liveResult.record.limitPrice)}`
                    : null,
                liveResult.action === "exit" && liveResult.record.currentBid !== undefined ? `bid ${formatPolyPrice(liveResult.record.currentBid)}` : null,
                liveResult.action === "exit" && liveResult.record.minPrice !== undefined ? `floor ${formatPolyPrice(liveResult.record.minPrice)}` : null,
                liveResult.action === "cancel" ? `scope ${liveResult.record.scope}` : null,
                liveResult.action === "cancel" && liveResult.record.canceledCount !== undefined ? `canceled ${liveResult.record.canceledCount}` : null,
            ].filter(Boolean).join(" | ")
            : "--";

        const realized = this.paperState?.realizedPnlUsd ?? 0;
        dom.sessionPnl.textContent = `realized ${formatMoney(realized)} | entries ${this.paperState?.totalEntries ?? 0} | open ${openPositions.length} | pending ${pendingSettlements.length} | closed ${this.paperState?.totalClosed ?? 0}`;
        this.renderPaperMetrics();
        this.renderDiagnostics();
        this.renderRecentTrades();
    }

    private firstOpenLivePosition(): LiveOpenExecutionPosition | null {
        return Array.from(this.liveOpenPositionByPaperTradeId.values())
            .find((position) => position.remainingShares > MIN_LIVE_POSITION_SHARES) ?? null;
    }

    private firstPendingLimitSubmission(): PendingLimitSubmission | null {
        return Array.from(this.pendingLimitSubmissionByRequestId.values())[0] ?? null;
    }

    private latestLiveResult(): LiveResultView | null {
        const entry = this.latestLiveTradeResult
            ? {
                action: this.latestLiveTradeResult.action === "take_profit" ? "take_profit" as const : "entry" as const,
                record: this.latestLiveTradeResult,
            }
            : null;
        const exit = this.latestLiveExitResult
            ? { action: "exit" as const, record: this.latestLiveExitResult }
            : null;
        const cancel = this.latestLiveCancelResult
            ? { action: "cancel" as const, record: this.latestLiveCancelResult }
            : null;
        return [entry, exit, cancel]
            .filter((item): item is LiveResultView => item !== null)
            .sort((left, right) => Date.parse(right.record.recordedAtIso) - Date.parse(left.record.recordedAtIso))[0] ?? null;
    }

    private renderRecentTrades(): void {
        const dom = this.dom;
        const paperState = this.paperState;
        if (!dom || !paperState) return;
        dom.recentTrades.innerHTML = "";
        const trades = paperState.closedTrades.slice(-6).reverse();
        const liveResult = this.latestLiveResult();
        if (liveResult) {
            const row = document.createElement("div");
            row.className = "execution-lab-trade-row";
            const side = document.createElement("div");
            side.className = "execution-lab-trade-side";
            side.textContent = liveResult.action === "entry"
                ? "LIVE ENTRY"
                : liveResult.action === "take_profit"
                    ? "LIVE TP"
                    : liveResult.action === "exit"
                    ? "LIVE EXIT"
                    : "LIVE CANCEL";
            const meta = document.createElement("div");
            meta.className = "execution-lab-trade-meta";
            meta.textContent = [
                formatLiveStatus(liveResult.record.status),
                liveResult.record.reason,
                liveResult.record.paperTradeId ? `paper ${liveResult.record.paperTradeId}` : null,
                liveResult.action !== "cancel" && liveResult.record.orderId ? `order ${liveResult.record.orderId}` : null,
                liveResult.action === "cancel" ? `scope ${liveResult.record.scope}` : null,
            ].filter(Boolean).join(" | ");
            const pnl = document.createElement("div");
            pnl.className = liveResult.record.status === "failed" || liveResult.record.status === "rejected"
                ? "execution-lab-pnl-negative"
                : "execution-lab-pnl-positive";
            pnl.textContent = formatLiveStatus(liveResult.record.status);
            row.appendChild(side);
            row.appendChild(meta);
            row.appendChild(pnl);
            dom.recentTrades.appendChild(row);
        }
        if (trades.length === 0 && !liveResult) {
            const empty = document.createElement("div");
            empty.className = "execution-lab-empty";
            empty.textContent = "No paper trades yet.";
            dom.recentTrades.appendChild(empty);
            return;
        }
        for (const trade of trades) {
            const row = document.createElement("div");
            row.className = "execution-lab-trade-row";
            const side = document.createElement("div");
            side.className = `execution-lab-trade-side is-${trade.side}`;
            side.textContent = trade.side.toUpperCase();
            const meta = document.createElement("div");
            meta.className = "execution-lab-trade-meta";
            meta.textContent = [
                `${formatDateTime(trade.entryTimeSec)} -> ${formatDateTime(trade.exitTimeSec)}`,
                trade.exitReason,
                `entry ${formatPolyPrice(trade.entryPrice)}`,
                `exit ${formatPolyPrice(trade.exitPrice)}`,
                `shares ${trade.shares.toFixed(4)}`,
                `roi ${trade.roiPct.toFixed(2)}%`,
            ].join(" | ");
            const pnl = document.createElement("div");
            pnl.className = trade.pnlUsd >= 0 ? "execution-lab-pnl-positive" : "execution-lab-pnl-negative";
            pnl.textContent = formatMoney(trade.pnlUsd);
            row.appendChild(side);
            row.appendChild(meta);
            row.appendChild(pnl);
            dom.recentTrades.appendChild(row);
        }
    }
}

export const executionLabService = new ExecutionLabService();

if (import.meta.hot) {
    import.meta.hot.dispose(() => executionLabService.dispose());
}
