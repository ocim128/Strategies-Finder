import type { SeriesMarker, Time } from "lightweight-charts";
import { loadBuiltInStrategyByKey, strategyRegistry } from "../../strategyRegistry";
import { getBacktestSettings, getCapitalSettings } from "../backtest-settings-reader";
import { executeBacktest } from "../backtest-executor";
import { chartManager, type ExecutionLabPolymarketPricePoint } from "../chart-manager";
import { ENHANCED_CANDLE_COLORS } from "../constants";
import { paramManager } from "../param-manager";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import { getEffectivePolymarketSeriesId, resolvePolymarketOutcomeSymbol } from "../polymarket-btc5m";
import { resolvePolymarketDomSettings } from "../polymarket-dom-reader";
import { getPolymarketEntryPriceFilterBounds } from "../polymarket-entry-price-filter";
import { resolveEffectivePolymarketExitMode } from "../polymarket-exit-mode";
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
    loadExecutionLabStoredQuotes,
    startExecutionLabMiner,
    startExecutionLabSession,
    stopExecutionLabMiner,
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
    type ExecutionLabEvaluatedSignal,
    type ExecutionLabOpenPaperPosition,
    type PaperUnfilledRecord,
    type ExecutionLabPaperMarker,
    type ExecutionLabPaperState,
    type ExecutionLabRecord,
    type ExecutionLabSessionSnapshot,
    type ExecutionParityMismatchRecord,
} from "./execution-lab-model";
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
import { settingsManager, sortStrategyConfigsNewestFirst } from "../settings-manager";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import type { CapitalSettings } from "../types/backtest";

const SETTINGS_SCHEMA = "execution-lab.settings";
const SETTINGS_VERSION = 1;
const POLL_MS = 1000;
const INITIAL_CANDLE_LIMIT = 900;
const MAX_STREAM_CANDLES = 20000;
const MAX_LIVE_CANDLE_LAG_SEC = 10;
const MAX_POLYMARKET_PRICE_POINTS = 3600;

type LivePollFetchResult<T> = { ok: true; value: T } | { ok: false };
type ComparisonSource = "original" | "current" | "saved";
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

function formatCents(value: number): string {
    return `${(value * 100).toFixed(1)}c`;
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

function readPersistedSettings(): { stakeUsd: number } {
    return readPersistedJson({
        key: EXECUTION_LAB_SETTINGS_STORAGE_KEY,
        schema: SETTINGS_SCHEMA,
        version: SETTINGS_VERSION,
        fallback: { stakeUsd: EXECUTION_LAB_DEFAULT_STAKE_USD },
        migrate: ({ data }) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;
            return { stakeUsd: normalizeStake((data as { stakeUsd?: unknown }).stakeUsd) };
        },
    });
}

function writePersistedSettings(stakeUsd: number): void {
    writePersistedJson({
        key: EXECUTION_LAB_SETTINGS_STORAGE_KEY,
        schema: SETTINGS_SCHEMA,
        version: SETTINGS_VERSION,
        data: { stakeUsd },
    });
}

export class ExecutionLabService {
    private dom: ExecutionLabDom | null = null;
    private initialized = false;
    private running = false;
    private starting = false;
    private polling = false;
    private timer: ReturnType<typeof setInterval> | null = null;
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
    private comparisonRunning = false;
    private latestComparison: ComparisonResult | null = null;
    private sessionStartCandleTimeSec: number | null = null;

    init(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.dom = queryExecutionLabDom();
        this.dom.stakeInput.value = String(readPersistedSettings().stakeUsd);
        this.syncSavedConfigOptions();
        this.bindEvents();
        this.renderIdle();
        void this.refreshMinerStatus();
        setInterval(() => void this.refreshMinerStatus(), 5000);
    }

    async startPaper(): Promise<void> {
        if (this.running || this.starting) return;
        this.init();
        this.starting = true;
        try {
            this.resetSessionState();
            this.setStatus("Starting");
            const prepared = await this.prepareSession();
            this.snapshot = prepared.snapshot;
            this.paperState = createExecutionLabPaperState(prepared.snapshot);
            this.strategy = prepared.strategy;
            this.logPath = prepared.logPath;
            await this.appendRecords([createSessionStartRecord(prepared.snapshot)]);
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
            this.timer = setInterval(() => void this.poll(), POLL_MS);
            await this.poll();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (this.paperState) {
                await this.stop("error", message);
            } else {
                this.setRunningState(false);
                this.setStatus(message, "error");
            }
        } finally {
            this.starting = false;
        }
    }

    private resetSessionState(): void {
        this.snapshot = null;
        this.paperState = null;
        this.strategy = null;
        this.candles = [];
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
        this.latestComparison = null;
        this.sessionStartCandleTimeSec = null;
        this.renderIdle();
    }

    private bindEvents(): void {
        const dom = this.dom;
        if (!dom) return;
        dom.startButton.addEventListener("click", () => void this.startPaper());
        dom.stopButton.addEventListener("click", () => void this.stop("user_stop"));
        dom.startMinerButton.addEventListener("click", () => void this.startMiner());
        dom.stopMinerButton.addEventListener("click", () => void this.stopMiner());
        dom.comparisonSource.addEventListener("change", () => this.syncComparisonControls());
        dom.runComparisonButton.addEventListener("click", () => void this.runComparison());
        dom.stakeInput.addEventListener("change", () => {
            dom.stakeInput.value = String(normalizeStake(dom.stakeInput.value));
            writePersistedSettings(Number(dom.stakeInput.value));
        });
    }

    private setStatus(text: string, tone: "neutral" | "running" | "warning" | "error" = "neutral"): void {
        const status = this.dom?.status;
        if (!status) return;
        status.textContent = text;
        status.classList.toggle("is-running", tone === "running");
        status.classList.toggle("is-warning", tone === "warning");
        status.classList.toggle("is-error", tone === "error");
    }

    private setRunningState(running: boolean): void {
        this.running = running;
        const dom = this.dom;
        if (!dom) return;
        dom.startButton.disabled = running;
        dom.stopButton.disabled = !running;
        dom.stakeInput.disabled = running;
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
        dom.minerStatus.textContent = status.running
            ? `running pid ${status.pid ?? "--"} | ${status.logPath}`
            : `${status.message ?? "idle"} | ${status.logPath}`;
        dom.startMinerButton.disabled = status.running;
        dom.stopMinerButton.disabled = !status.running;
    }

    private async refreshMinerStatus(): Promise<void> {
        try {
            this.renderMinerStatus(await loadExecutionLabMinerStatus());
        } catch (error) {
            this.renderMinerStatus(null, executionLabErrorMessage(error));
        }
    }

    private async startMiner(): Promise<void> {
        try {
            this.renderMinerStatus(await startExecutionLabMiner());
        } catch (error) {
            this.renderMinerStatus(null, executionLabErrorMessage(error));
        }
    }

    private async stopMiner(): Promise<void> {
        try {
            this.renderMinerStatus(await stopExecutionLabMiner());
        } catch (error) {
            this.renderMinerStatus(null, executionLabErrorMessage(error));
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
        const allowMultipleTradesPerEvent = exitMode === "signal_exit_same_event"
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
        const startedAtIso = new Date().toISOString();
        const session = await startExecutionLabSession({ strategyKey: state.currentStrategyKey, symbol: chartSymbol, startedAtIso });
        const exitMode = resolveEffectivePolymarketExitMode({
            requestedMode: backtestSettings.polymarketExitMode ?? polymarketDom.exitMode,
            interval: "1s",
            executionModel: backtestSettings.executionModel,
            polymarketAnnotationEnabled,
        });
        const allowMultipleTradesPerEvent = exitMode === "signal_exit_same_event"
            && (backtestSettings.polymarketSignalExitAllowMultipleTradesPerEvent
                ?? polymarketDom.signalExitAllowMultipleTradesPerEvent) === true;
        const snapshotBacktestSettings = {
            ...backtestSettings,
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

    private loadInitialCandles(symbol: SecondMarketSymbol): Promise<OHLCVData[]> {
        return loadExecutionLabLiveCandles({
            symbol,
            marketType: state.binanceMarketType,
            limit: INITIAL_CANDLE_LIMIT,
        });
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

    private async poll(): Promise<void> {
        if (!this.running || this.polling) return;
        const snapshot = this.snapshot;
        const paperState = this.paperState;
        const strategy = this.strategy;
        if (!snapshot || !paperState || !strategy) return;

        this.polling = true;
        try {
            this.assertSessionContext(snapshot);
            const latestBatchResult = await this.tryLivePollFetch(() =>
                loadExecutionLabLiveCandles({ symbol: snapshot.symbol, marketType: state.binanceMarketType, limit: 1 })
            );
            if (!latestBatchResult.ok) return;
            const latestBatch = latestBatchResult.value;
            const latestCandle = latestBatch[latestBatch.length - 1];
            const latestTs = latestCandle ? finiteUnixSeconds(latestCandle.time) : null;
            if (!latestCandle || latestTs === null) {
                this.setStatus("Waiting for latest 1s candle", "warning");
                return;
            }
            const lagSec = liveCandleLagSec(latestTs);
            if (lagSec > MAX_LIVE_CANDLE_LAG_SEC) {
                this.feedLagSec = lagSec;
                this.setStatus(liveLagMessage(latestTs, lagSec), "warning");
                this.render();
                return;
            }

            const lastBufferedTs = this.getLastBufferedTs();
            if (lastBufferedTs === null || latestTs >= lastBufferedTs) {
                const newCandlesResult = lastBufferedTs === null
                    ? { ok: true as const, value: latestBatch }
                    : latestTs === lastBufferedTs
                        ? { ok: true as const, value: latestBatch }
                        : await this.tryLivePollFetch(() => loadExecutionLabLiveCandles({
                            symbol: snapshot.symbol,
                            marketType: state.binanceMarketType,
                            startTs: lastBufferedTs + 1,
                            endTs: latestTs,
                            limit: Math.min(10000, latestTs - lastBufferedTs),
                        }));
                if (!newCandlesResult.ok) return;
                this.mergeCandles(newCandlesResult.value);
            }

            const latestBuffered = this.candles[this.candles.length - 1];
            const latestBufferedTs = latestBuffered ? finiteUnixSeconds(latestBuffered.time) : null;
            if (!latestBuffered || latestBufferedTs === null) return;

            const activeEventResult = await this.tryLivePollFetch(() => this.getLiveEventForTime(snapshot, latestBufferedTs));
            if (!activeEventResult.ok) return;
            const activeEvent = activeEventResult.value;
            const previousPaperTs = paperState.lastProcessedCandleTimeSec;
            const liveQuoteResult = activeEvent
                ? await this.tryLivePollFetch(() => loadExecutionLabLiveQuote({ event: activeEvent, sampleTs: latestBufferedTs }))
                : { ok: true as const, value: null };
            if (!liveQuoteResult.ok) return;
            const liveQuote = liveQuoteResult.value;
            if (liveQuote) this.addPolymarketQuote(liveQuote);
            const storedQuoteStart = previousPaperTs === null ? latestBufferedTs : previousPaperTs + 1;
            const storedQuotesResult = await this.tryLivePollFetch(() =>
                this.addStoredQuoteRange(snapshot, storedQuoteStart, latestBufferedTs, true)
            );
            if (!storedQuotesResult.ok) return;
            const strategyQuotes = this.getStrategyQuoteBuffer();

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
            });
            const outcomesPromise = this.tryLivePollFetch(() => this.loadLiveOutcomesForOpenPositions(snapshot, latestBufferedTs));
            const [backtestResult, outcomesResult] = await Promise.all([backtestPromise, outcomesPromise]);
            if (!outcomesResult.ok) return;
            const outcomes = outcomesResult.value;

            const backtestSignals = buildEvaluatedSignals(backtestResult.signals)
                .filter((signal) => signal.signalTimeSec <= latestBufferedTs);
            const missingTradeQuotesResult = await this.tryLivePollFetch(() =>
                this.loadMissingTradeQuotes(snapshot, backtestResult.result.trades, latestBufferedTs, previousPaperTs)
            );
            if (!missingTradeQuotesResult.ok) return;
            const feedLag = liveCandleLagSec(latestBufferedTs);
            const liveQuotes = this.getLiveQuoteBuffer();
            const recordedAtIso = new Date().toISOString();
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
            const parityMismatches = this.collectExecutionParityMismatches(backtestResult.result.trades, tickResult.records, latestBufferedTs);
            const parityRecords = this.buildExecutionMismatchRecords(parityMismatches, recordedAtIso);

            await this.appendRecords([...parityRecords, ...tickResult.records]);
            this.updateExecutionParityState(parityMismatches);
            this.updateLatestPaperDecision(tickResult.records);
            this.appendLatestLoggedSignals(tickResult.records, backtestSignals);
            this.latestQuote = liveQuote;
            this.feedLagSec = feedLag;
            this.addMarkers(tickResult.markers);
            chartManager.displayPaperStreamData(this.candles);
            if (liveQuote) {
                chartManager.displayExecutionLabPolymarketPrices(this.getPolymarketPricePoints());
            }
            this.render();
            const hasActiveEvent = Boolean(activeEvent || liveQuote);
            const statusText = this.executionMismatchTotal > 0
                ? `Execution parity mismatch | ${this.latestExecutionMismatch?.detail ?? "see detail"}`
                : hasActiveEvent
                    ? `Running live ${snapshot.symbol} 1s | latest ${formatDateTime(latestBufferedTs)}`
                    : `Running live ${snapshot.symbol} 1s | no active Polymarket event for ${formatDateTime(latestBufferedTs)}`;
            this.setStatus(statusText, this.executionMismatchTotal === 0 && hasActiveEvent ? "running" : "warning");
        } catch (error) {
            await this.stop("error", executionLabErrorMessage(error));
        } finally {
            this.polling = false;
        }
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
            case "missing_entry_quote":
                return "Rejected because the exact entry quote is missing";
            case "missing_event":
                return "Rejected because no active event matched the signal";
            case "duplicate_event":
                return "Rejected because this event was already claimed";
            case "open_position":
                return "Rejected because another paper position is open";
            case "invalid_price":
                return "Rejected because the entry price is invalid";
            case "missing_exit_quote":
                return "Rejected because the expected exit quote is missing";
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

    private async stop(reason: "user_stop" | "error", message?: string): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        const paperState = this.paperState;
        this.setRunningState(false);
        if (paperState) {
            try {
                await this.appendRecords([createSessionStopRecord(paperState, reason, new Date().toISOString(), message)]);
            } catch {
                // Chart restore should not depend on the final log append.
            }
        }
        chartManager.clearExecutionLabMarkers();
        chartManager.clearExecutionLabPolymarketPrices();
        chartManager.restoreStateChartData();
        if (state.currentBacktestResult) {
            chartManager.displayTradeMarkers(state.currentBacktestResult.trades, uiManager.formatPrice);
        }
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
        dom.latestSignal.textContent = "--";
        dom.signalParity.textContent = "--";
        dom.signalParity.classList.remove("is-ok", "is-warning");
        dom.signalMismatch.textContent = "--";
        dom.openPosition.textContent = "--";
        dom.sessionPnl.textContent = "--";
        dom.logPath.textContent = "--";
        this.renderDecision(null, null);
        this.renderPaperMetrics();
        this.renderComparisonMetrics();
        this.setComparisonStatus("No comparison run.");
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
            snapshot.strategyName,
            `${snapshot.symbol}->${snapshot.outcomeSymbol}`,
            `$${snapshot.stakeUsd.toFixed(2)}`,
            snapshot.exitMode,
            snapshot.allowMultipleTradesPerEvent ? "multi-event on" : "one/event",
        ].join(" | ");
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

        const realized = this.paperState?.realizedPnlUsd ?? 0;
        dom.sessionPnl.textContent = `realized ${formatMoney(realized)} | entries ${this.paperState?.totalEntries ?? 0} | open ${openPositions.length} | pending ${pendingSettlements.length} | closed ${this.paperState?.totalClosed ?? 0}`;
        this.renderPaperMetrics();
        this.renderRecentTrades();
    }

    private renderRecentTrades(): void {
        const dom = this.dom;
        const paperState = this.paperState;
        if (!dom || !paperState) return;
        dom.recentTrades.innerHTML = "";
        const trades = paperState.closedTrades.slice(-6).reverse();
        if (trades.length === 0) {
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
