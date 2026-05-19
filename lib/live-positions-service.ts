/**
 * Live Positions Service
 *
 * Polls Cloudflare Worker subscriptions and compares worker-evaluated state
 * against local backtest state for mismatch detection.
 */

import {
    alertService,
    AlertSignalRecord,
    AlertSubscription,
    AlertSubscriptionState,
    parseAlertConfigNameFromStreamId,
} from './alert-service';
import {
    getLatestActionableAlertSignal,
    getPersistedAlertSignalEntryPrice,
} from './alert-signal-utils';
import { fetchBybitTradFiLatest } from './dataProviders/bybit';
import { parseIntervalSeconds } from './interval-utils';
import { parseTimeToUnixSeconds } from './time-normalization';
import { state } from './state';
import type { BacktestSettings, Trade } from './strategies/index';
import type { DataProvider } from './types/data-providers';
import { resolveSubscriptionExecutionBacktestSettings } from './alert-subscription-utils';
import { debugLogger } from './debug-logger';
import { safeJsonParse } from './json-utils';
import {
    getDefaultAlertMinClosedCandles,
    selectExecutionAwareClosedCandles,
} from './alert-evaluation-window';
import {
    buildAlertWorkerProviderMismatchMessage,
    isAlertWorkerProviderCompatible,
} from './alert-worker-compat';
import { applySlippage, entrySideForDirection } from './strategies/backtest/backtest-utils';
import { getBinanceProviderForMarketType, isBinanceDataProvider, resolveBinanceMarketType } from './binance-market';

export interface LivePosition {
    streamId: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    strategyParams: Record<string, number>;
    backtestSettings: BacktestSettings;
    configName: string | null;
    direction: 'long' | 'short';
    entryPrice: number;
    entryTime: number;
    currentPrice: number | null;
    unrealizedPnl: number | null;
    unrealizedPnlPercent: number | null;
    stopLossPrice: number | null;
    takeProfitPrice: number | null;
    isOpen: boolean;
    lastSignalFromWorker: AlertSignalRecord | null;
    localBacktestTrade: Trade | null;
    mismatch: boolean;
    mismatchReason: string | null;
    lastUpdated: number;
}

export interface ClosedTrade extends LivePosition {
    exitPrice: number;
    exitTime: number;
    realizedPnl: number;
    realizedPnlPercent: number;
    exitReason: string;
}

interface PriceCache {
    symbol: string;
    price: number;
    timestamp: number;
}

interface LivePositionsState {
    positions: LivePosition[];
    closedTrades: ClosedTrade[];
    lastPollTime: number | null;
    isPolling: boolean;
    viewMode: 'open' | 'closed';
    error: string | null;
}

interface WorkerEntrySnapshot {
    direction: 'long' | 'short';
    signalTimeSec: number;
    signalPrice: number;
    entryPrice: number | null;
}

interface WorkerSnapshot {
    stateAvailable: boolean;
    hasOpen: boolean;
    latestEntry: WorkerEntrySnapshot | null;
}

interface LocalSnapshot {
    latestTrade: Trade | null;
    openTrade: Trade | null;
    latestClosedTrade: Trade | null;
}

interface AnalysisResult {
    openPosition: LivePosition | null;
    closedTrade: ClosedTrade | null;
}

const POLL_INTERVAL_MS = 30000;
const PRICE_CACHE_TTL_MS = Math.max(5000, Math.floor(POLL_INTERVAL_MS / 2));
const LOCAL_BACKTEST_CACHE_GRACE_MS = 5000;
const SIGNAL_HISTORY_LIMIT = 30;
const ANALYZE_CONCURRENCY = 4;
const MAX_LOCAL_COMPARE_CANDLE_LIMIT = 50000;
const PRICE_CACHE: Map<string, PriceCache> = new Map();
const PRICE_REQUESTS: Map<string, Promise<number | null>> = new Map();

interface LocalBacktestCacheEntry {
    signature: string;
    trades: Trade[];
    expiresAt: number;
}

class LivePositionsService {
    private state: LivePositionsState = {
        positions: [],
        closedTrades: [],
        lastPollTime: null,
        isPolling: false,
        viewMode: 'open',
        error: null,
    };

    private pollTimer: number | null = null;
    private listeners: Set<(state: LivePositionsState) => void> = new Set();
    private localBacktestCache: Map<string, LocalBacktestCacheEntry> = new Map();

    getState(): Readonly<LivePositionsState> {
        return { ...this.state };
    }

    subscribe(callback: (state: LivePositionsState) => void): () => void {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    syncActiveChartPrice(): void {
        const symbol = state.currentSymbol.trim().toUpperCase();
        const interval = state.currentInterval;
        const lastClose = Number(state.ohlcvData[state.ohlcvData.length - 1]?.close);
        if (!symbol || !interval || !Number.isFinite(lastClose)) {
            return;
        }

        let changed = false;
        const positions = this.state.positions.map((position) => {
            if (!position.isOpen) return position;
            if (position.symbol.trim().toUpperCase() !== symbol) return position;
            if (position.interval !== interval) return position;
            if (position.currentPrice === lastClose) return position;

            let unrealizedPnl: number | null = null;
            let unrealizedPnlPercent: number | null = null;
            if (position.entryPrice > 0) {
                const diff = position.direction === 'long'
                    ? lastClose - position.entryPrice
                    : position.entryPrice - lastClose;
                unrealizedPnl = diff;
                unrealizedPnlPercent = (diff / position.entryPrice) * 100;
            }

            changed = true;
            return {
                ...position,
                currentPrice: lastClose,
                unrealizedPnl,
                unrealizedPnlPercent,
                lastUpdated: Date.now(),
            };
        });

        if (!changed) {
            return;
        }

        this.state = {
            ...this.state,
            positions,
        };
        this.notifyListeners();
    }

    setViewMode(mode: 'open' | 'closed'): void {
        this.state = { ...this.state, viewMode: mode };
        this.notifyListeners();
    }

    async refresh(force = false): Promise<void> {
        if (force) {
            this.clearCaches();
        }
        await this.pollPositions(force);
    }

    startPolling(): void {
        if (this.pollTimer) return;
        void this.pollPositions();
        this.pollTimer = window.setInterval(() => {
            void this.pollPositions();
        }, POLL_INTERVAL_MS);
    }

    stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            this.notifyListeners();
        }
    }

    isPolling(): boolean {
        return this.pollTimer !== null;
    }

    async getPositionDetails(streamId: string): Promise<{
        position: LivePosition | ClosedTrade | null;
        localTrades: Trade[];
        workerSignals: AlertSignalRecord[];
    }> {
        const sub = await this.fetchSubscription(streamId);
        if (!sub) return { position: null, localTrades: [], workerSignals: [] };

        const [workerSignals, localTrades] = await Promise.all([
            alertService.getSignalHistory(streamId, 50),
            this.runLocalBacktest(sub),
        ]);

        const position = this.state.positions.find((p) => p.streamId === streamId)
            ?? this.state.closedTrades.find((p) => p.streamId === streamId)
            ?? null;

        return { position, localTrades, workerSignals };
    }

    private notifyListeners(): void {
        const snapshot = this.getState();
        this.listeners.forEach((cb) => cb(snapshot));
    }

    private clearCaches(): void {
        this.localBacktestCache.clear();
        PRICE_CACHE.clear();
    }

    private async pollPositions(force = false): Promise<void> {
        if (this.state.isPolling) return;

        this.state = { ...this.state, isPolling: true, error: null };
        this.notifyListeners();

        try {
            const subscriptions = await alertService.listSubscriptions();
            const activeSubscriptions = subscriptions.filter((s) => s.enabled === 1);

            const analyses = await this.mapWithConcurrency(
                activeSubscriptions,
                ANALYZE_CONCURRENCY,
                async (sub) => {
                    try {
                        return await this.analyzeSubscription(sub, force);
                    } catch (err) {
                        debugLogger.warn("[LivePositions] Failed to analyze subscription", {
                            streamId: sub.stream_id,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        return { openPosition: null, closedTrade: null } as AnalysisResult;
                    }
                }
            );

            const positions: LivePosition[] = [];
            const closedTrades: ClosedTrade[] = [];
            for (const entry of analyses) {
                if (entry.openPosition) positions.push(entry.openPosition);
                if (entry.closedTrade) closedTrades.push(entry.closedTrade);
            }

            positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
            closedTrades.sort((a, b) => b.exitTime - a.exitTime);

            this.state = {
                ...this.state,
                positions,
                closedTrades,
                lastPollTime: Date.now(),
                isPolling: false,
            };
        } catch (err) {
            this.state = {
                ...this.state,
                isPolling: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }

        this.notifyListeners();
    }

    private async analyzeSubscription(sub: AlertSubscription, force = false): Promise<AnalysisResult> {
        const strategyParams = safeJsonParse<Record<string, number>>(sub.strategy_params_json, {});
        const backtestSettings = this.resolveBacktestSettings(sub);
        const configName = parseAlertConfigNameFromStreamId(sub.stream_id);
        const provider = await this.resolveProviderForSymbol(sub.symbol, backtestSettings);
        const localComparisonCompatible = isAlertWorkerProviderCompatible(provider);

        const [signals, workerState, localTrades] = await Promise.all([
            alertService.getSignalHistory(sub.stream_id, SIGNAL_HISTORY_LIMIT),
            this.fetchWorkerState(sub.stream_id),
            localComparisonCompatible
                ? this.runLocalBacktest(sub, strategyParams, backtestSettings, force)
                : Promise.resolve([]),
        ]);

        const latestWorkerSignal = this.getLatestActionableSignal(signals);
        const workerSnapshot = this.deriveWorkerSnapshot(workerState, latestWorkerSignal);
        const localSnapshot = this.deriveLocalSnapshot(localTrades);
        const mismatch = localComparisonCompatible
            ? this.detectMismatch(workerSnapshot, localSnapshot, sub.interval, backtestSettings)
            : {
                mismatch: true,
                reason: buildAlertWorkerProviderMismatchMessage(sub.symbol, provider),
            };

        const shouldShowOpen = localSnapshot.openTrade !== null || (workerSnapshot.stateAvailable && workerSnapshot.hasOpen);
        const currentPrice = shouldShowOpen ? await this.fetchCurrentPrice(sub.symbol, sub.interval, provider) : null;

        const openPosition = shouldShowOpen
            ? this.buildOpenPosition(
                sub,
                strategyParams,
                backtestSettings,
                configName,
                latestWorkerSignal,
                workerSnapshot,
                localSnapshot,
                mismatch,
                currentPrice
            )
            : null;

        const closedTrade = !shouldShowOpen
            ? this.buildClosedTrade(
                sub,
                strategyParams,
                backtestSettings,
                configName,
                latestWorkerSignal,
                localSnapshot.latestClosedTrade,
                mismatch
            )
            : null;

        return { openPosition, closedTrade };
    }

    private buildOpenPosition(
        sub: AlertSubscription,
        strategyParams: Record<string, number>,
        backtestSettings: BacktestSettings,
        configName: string | null,
        latestWorkerSignal: AlertSignalRecord | null,
        workerSnapshot: WorkerSnapshot,
        localSnapshot: LocalSnapshot,
        mismatch: { mismatch: boolean; reason: string | null },
        currentPrice: number | null
    ): LivePosition | null {
        const localOpen = localSnapshot.openTrade;
        const localOpenEntryTime = localOpen ? parseTimeToUnixSeconds(localOpen.entryTime) : null;
        const workerOpenEntry = workerSnapshot.stateAvailable && workerSnapshot.hasOpen
            ? workerSnapshot.latestEntry
            : null;

        const direction = workerOpenEntry?.direction
            ?? localOpen?.type
            ?? null;
        const workerEntryPrice = workerOpenEntry
            ? this.resolveEffectiveWorkerEntryPrice(workerOpenEntry, backtestSettings)
            : null;
        const entryPrice = workerEntryPrice
            ?? localOpen?.entryPrice
            ?? null;
        const entryTime = workerOpenEntry?.signalTimeSec
            ?? localOpenEntryTime
            ?? null;

        if (!direction || entryPrice === null || entryTime === null) {
            return null;
        }

        let unrealizedPnl: number | null = null;
        let unrealizedPnlPercent: number | null = null;
        if (currentPrice !== null && entryPrice > 0) {
            const diff = direction === 'long'
                ? currentPrice - entryPrice
                : entryPrice - currentPrice;
            unrealizedPnl = diff;
            unrealizedPnlPercent = (diff / entryPrice) * 100;
        }

        const workerPayload = latestWorkerSignal
            ? safeJsonParse<Record<string, unknown>>(latestWorkerSignal.payload_json, {})
            : {};
        const tpPrice = typeof workerPayload.takeProfitPrice === 'number'
            ? workerPayload.takeProfitPrice
            : (localOpen?.takeProfitPrice ?? null);
        const slPrice = typeof workerPayload.stopLossPrice === 'number'
            ? workerPayload.stopLossPrice
            : (localOpen?.stopLossPrice ?? null);

        return {
            streamId: sub.stream_id,
            symbol: sub.symbol,
            interval: sub.interval,
            strategyKey: sub.strategy_key,
            strategyParams,
            backtestSettings,
            configName,
            direction,
            entryPrice,
            entryTime,
            currentPrice,
            unrealizedPnl,
            unrealizedPnlPercent,
            stopLossPrice: slPrice,
            takeProfitPrice: tpPrice,
            isOpen: true,
            lastSignalFromWorker: latestWorkerSignal,
            localBacktestTrade: localOpen ?? localSnapshot.latestTrade,
            mismatch: mismatch.mismatch,
            mismatchReason: mismatch.reason,
            lastUpdated: Date.now(),
        };
    }

    private buildClosedTrade(
        sub: AlertSubscription,
        strategyParams: Record<string, number>,
        backtestSettings: BacktestSettings,
        configName: string | null,
        latestWorkerSignal: AlertSignalRecord | null,
        latestClosedTrade: Trade | null,
        mismatch: { mismatch: boolean; reason: string | null }
    ): ClosedTrade | null {
        if (!latestClosedTrade) return null;

        const entryTime = parseTimeToUnixSeconds(latestClosedTrade.entryTime);
        const exitTime = parseTimeToUnixSeconds(latestClosedTrade.exitTime);
        if (entryTime === null || exitTime === null) return null;

        return {
            streamId: sub.stream_id,
            symbol: sub.symbol,
            interval: sub.interval,
            strategyKey: sub.strategy_key,
            strategyParams,
            backtestSettings,
            configName,
            direction: latestClosedTrade.type,
            entryPrice: latestClosedTrade.entryPrice,
            entryTime,
            currentPrice: null,
            unrealizedPnl: null,
            unrealizedPnlPercent: null,
            stopLossPrice: latestClosedTrade.stopLossPrice ?? null,
            takeProfitPrice: latestClosedTrade.takeProfitPrice ?? null,
            isOpen: false,
            lastSignalFromWorker: latestWorkerSignal,
            localBacktestTrade: latestClosedTrade,
            mismatch: mismatch.mismatch,
            mismatchReason: mismatch.reason,
            lastUpdated: Date.now(),
            exitPrice: latestClosedTrade.exitPrice,
            exitTime,
            realizedPnl: latestClosedTrade.pnl,
            realizedPnlPercent: latestClosedTrade.pnlPercent,
            exitReason: latestClosedTrade.exitReason || 'unknown',
        };
    }

    private deriveLocalSnapshot(trades: Trade[]): LocalSnapshot {
        const latestTrade = trades.length > 0 ? trades[trades.length - 1] : null;
        const openTrade = latestTrade && latestTrade.exitReason === 'end_of_data' ? latestTrade : null;

        let latestClosedTrade: Trade | null = null;
        for (let i = trades.length - 1; i >= 0; i--) {
            if (trades[i].exitReason !== 'end_of_data') {
                latestClosedTrade = trades[i];
                break;
            }
        }

        return { latestTrade, openTrade, latestClosedTrade };
    }

    private deriveWorkerSnapshot(
        workerState: AlertSubscriptionState | null,
        latestWorkerSignal: AlertSignalRecord | null
    ): WorkerSnapshot {
        if (workerState?.latestTrade) {
            return {
                stateAvailable: true,
                hasOpen: workerState.latestTrade.isOpen === true,
                latestEntry: workerState.latestEntry
                    ? {
                        direction: workerState.latestEntry.direction,
                        signalTimeSec: workerState.latestEntry.signalTimeSec,
                        signalPrice: workerState.latestEntry.signalPrice,
                        entryPrice: workerState.latestEntry.entryPrice ?? workerState.latestTrade?.entryPrice ?? null,
                    }
                    : this.signalToEntrySnapshot(latestWorkerSignal),
            };
        }

        // Do not infer "open" from entry history alone. History only records entries,
        // so using it as position state creates false positives when worker state
        // is unavailable or the endpoint fails.
        return {
            stateAvailable: false,
            hasOpen: false,
            latestEntry: this.signalToEntrySnapshot(latestWorkerSignal),
        };
    }

    private detectMismatch(
        worker: WorkerSnapshot,
        local: LocalSnapshot,
        interval: string,
        backtestSettings: BacktestSettings
    ): { mismatch: boolean; reason: string | null } {
        if (!worker.stateAvailable) {
            return { mismatch: false, reason: null };
        }
        const localHasOpen = local.openTrade !== null;

        if (worker.hasOpen && !localHasOpen) {
            return { mismatch: true, reason: 'Worker shows open, local backtest shows closed' };
        }
        if (!worker.hasOpen && localHasOpen) {
            return { mismatch: true, reason: 'Local backtest shows open, worker shows closed' };
        }
        if (!worker.hasOpen || !localHasOpen || !worker.latestEntry || !local.openTrade) {
            return { mismatch: false, reason: null };
        }

        if (worker.latestEntry.direction !== local.openTrade.type) {
            return { mismatch: true, reason: 'Open trade direction differs (worker vs local)' };
        }

        const localEntryTime = parseTimeToUnixSeconds(local.openTrade.entryTime);
        if (localEntryTime !== null) {
            const intervalSec = parseIntervalSeconds(interval) ?? 60;
            const allowedDriftSec = Math.max(60, Math.floor(intervalSec * 1.5));
            if (Math.abs(worker.latestEntry.signalTimeSec - localEntryTime) > allowedDriftSec) {
                return { mismatch: true, reason: 'Open trade entry time differs materially (worker vs local)' };
            }
        }

        const effectiveWorkerEntryPrice = this.resolveEffectiveWorkerEntryPrice(worker.latestEntry, backtestSettings);
        if (effectiveWorkerEntryPrice > 0) {
            const priceDiffPct = Math.abs(effectiveWorkerEntryPrice - local.openTrade.entryPrice) / effectiveWorkerEntryPrice * 100;
            if (priceDiffPct > 0.5) {
                return { mismatch: true, reason: 'Open trade entry price differs materially (worker vs local)' };
            }
        }

        return { mismatch: false, reason: null };
    }

    private async fetchWorkerState(streamId: string): Promise<AlertSubscriptionState | null> {
        try {
            return await alertService.getSubscriptionState(streamId);
        } catch {
            return null;
        }
    }

    private getLatestActionableSignal(signals: AlertSignalRecord[]): AlertSignalRecord | null {
        return getLatestActionableAlertSignal(signals);
    }

    private signalToEntrySnapshot(signal: AlertSignalRecord | null): WorkerEntrySnapshot | null {
        if (!signal) return null;
        return {
            direction: signal.direction,
            signalTimeSec: signal.signal_time,
            signalPrice: signal.signal_price,
            entryPrice: getPersistedAlertSignalEntryPrice(signal),
        };
    }

    private resolveEffectiveWorkerEntryPrice(
        entry: WorkerEntrySnapshot,
        backtestSettings: BacktestSettings
    ): number {
        if (Number.isFinite(entry.entryPrice) && (entry.entryPrice as number) > 0) {
            return entry.entryPrice as number;
        }

        const basePrice = Number(entry.signalPrice);
        if (!Number.isFinite(basePrice) || basePrice <= 0) {
            return basePrice;
        }

        const slippageBps = Number(backtestSettings.slippageBps ?? 0);
        const slippageRate = Number.isFinite(slippageBps) && slippageBps > 0
            ? slippageBps / 10000
            : 0;

        return applySlippage(basePrice, entrySideForDirection(entry.direction), slippageRate);
    }

    private resolveBacktestSettings(sub: AlertSubscription): BacktestSettings {
        const parsed = resolveSubscriptionExecutionBacktestSettings(
            safeJsonParse<BacktestSettings>(sub.backtest_settings_json, {})
        );
        if (parseIntervalSeconds(sub.interval) !== 7200) {
            return parsed;
        }
        return parsed;
    }

    private async resolveProviderForSymbol(symbol: string, backtestSettings?: BacktestSettings): Promise<DataProvider> {
        const { dataManager } = await import('./data-manager');
        const provider = dataManager.getProvider(symbol);
        if (!isBinanceDataProvider(provider)) {
            return provider;
        }

        const marketType = resolveBinanceMarketType(
            (backtestSettings as Record<string, unknown> | undefined)?.binanceMarketType,
            'spot'
        );
        return getBinanceProviderForMarketType(marketType);
    }

    private getLocalBacktestCacheKey(sub: AlertSubscription): string {
        return sub.stream_id;
    }

    private getLocalBacktestCacheSignature(sub: AlertSubscription): string {
        return [
            sub.symbol,
            sub.interval,
            sub.strategy_key,
            String(sub.candle_limit || 350),
            sub.strategy_params_json,
            sub.backtest_settings_json,
            sub.updated_at,
        ].join('::');
    }

    private getLocalBacktestCacheExpiry(sub: AlertSubscription, nowMs = Date.now()): number {
        const intervalSec = parseIntervalSeconds(sub.interval) ?? 60;
        const nowSec = Math.floor(nowMs / 1000);
        const alignedCursor = Math.floor(nowSec / intervalSec);
        const nextCloseSec = (alignedCursor + 1) * intervalSec;
        return nextCloseSec * 1000 + LOCAL_BACKTEST_CACHE_GRACE_MS;
    }

    private async runLocalBacktest(
        sub: AlertSubscription,
        strategyParams?: Record<string, number>,
        backtestSettings?: BacktestSettings,
        force = false
    ): Promise<Trade[]> {
        try {
            const resolvedParams = strategyParams ?? safeJsonParse<Record<string, number>>(sub.strategy_params_json, {});
            const resolvedSettings = backtestSettings ?? this.resolveBacktestSettings(sub);
            const cacheKey = this.getLocalBacktestCacheKey(sub);
            const cacheSignature = this.getLocalBacktestCacheSignature(sub);
            const cached = this.localBacktestCache.get(cacheKey);

            if (!force && cached && cached.signature === cacheSignature && Date.now() < cached.expiresAt) {
                return cached.trades;
            }

            const { dataManager } = await import('./data-manager');
            const ohlcvData = await dataManager.fetchDataWithLimit(
                sub.symbol,
                sub.interval,
                Math.min(
                    Math.max(200, Math.floor(sub.candle_limit || 350)),
                    MAX_LOCAL_COMPARE_CANDLE_LIMIT
                )
            );

            if (ohlcvData.length === 0) {
                this.localBacktestCache.set(cacheKey, {
                    signature: cacheSignature,
                    trades: [],
                    expiresAt: this.getLocalBacktestCacheExpiry(sub),
                });
                return [];
            }

            const evaluationCandles = selectExecutionAwareClosedCandles(
                ohlcvData,
                sub.interval,
                resolvedSettings,
                {
                    nowSec: Math.floor(Date.now() / 1000),
                    minClosedCandles: getDefaultAlertMinClosedCandles(),
                }
            );
            if (!evaluationCandles) {
                this.localBacktestCache.set(cacheKey, {
                    signature: cacheSignature,
                    trades: [],
                    expiresAt: this.getLocalBacktestCacheExpiry(sub),
                });
                return [];
            }

            const { backtestService } = await import('./backtest-service');
            const result = await backtestService.runBacktestForSubscription(
                evaluationCandles,
                sub.interval,
                sub.strategy_key,
                resolvedParams,
                resolvedSettings
            );

            const trades = result.trades ?? [];
            this.localBacktestCache.set(cacheKey, {
                signature: cacheSignature,
                trades,
                expiresAt: this.getLocalBacktestCacheExpiry(sub),
            });
            return trades;
        } catch (err) {
            debugLogger.warn("[LivePositions] Local backtest failed", {
                streamId: sub.stream_id,
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }

    private async fetchCurrentPrice(symbol: string, interval: string, providerOverride?: DataProvider): Promise<number | null> {
        const normalizedSymbol = symbol.trim().toUpperCase();
        const activeChartPrice = this.getActiveChartPrice(normalizedSymbol, interval);
        if (activeChartPrice !== null) {
            return activeChartPrice;
        }

        const cached = PRICE_CACHE.get(normalizedSymbol);
        if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL_MS) {
            return cached.price;
        }

        const inFlight = PRICE_REQUESTS.get(normalizedSymbol);
        if (inFlight) {
            return inFlight;
        }

        const request = (async () => {
            const provider = providerOverride ?? (await import('./data-manager')).dataManager.getProvider(normalizedSymbol);

            try {
                if (provider === 'bybit-tradfi') {
                    const fast = await fetchBybitTradFiLatest(normalizedSymbol, '1m');
                    const slow = fast ?? await fetchBybitTradFiLatest(normalizedSymbol, interval || '1d');
                    const price = Number(slow?.close);
                    if (Number.isFinite(price)) {
                        PRICE_CACHE.set(normalizedSymbol, { symbol: normalizedSymbol, price, timestamp: Date.now() });
                        return price;
                    }
                    return null;
                }

                if (provider === 'binance' || provider === 'binance-futures') {
                    const endpoint = provider === 'binance-futures'
                        ? 'https://fapi.binance.com/fapi/v1/ticker/price'
                        : 'https://api.binance.com/api/v3/ticker/price';
                    const response = await fetch(`${endpoint}?symbol=${normalizedSymbol}`);
                    if (!response.ok) throw new Error('Price fetch failed');

                    const data = await response.json() as { price: string };
                    const price = parseFloat(data.price);
                    if (Number.isFinite(price)) {
                        PRICE_CACHE.set(normalizedSymbol, { symbol: normalizedSymbol, price, timestamp: Date.now() });
                        return price;
                    }
                }
            } catch (err) {
                try {
                    const response = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${normalizedSymbol}`);
                    if (!response.ok) throw new Error('Bybit price fetch failed');

                    const data = await response.json() as { result?: { list?: Array<{ lastPrice: string }> } };
                    const price = parseFloat(data.result?.list?.[0]?.lastPrice || '');
                    if (Number.isFinite(price)) {
                        PRICE_CACHE.set(normalizedSymbol, { symbol: normalizedSymbol, price, timestamp: Date.now() });
                        return price;
                    }
                } catch {
                    debugLogger.warn("[LivePositions] Failed to fetch price", {
                        symbol: normalizedSymbol,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            return null;
        })().finally(() => {
            PRICE_REQUESTS.delete(normalizedSymbol);
        });

        PRICE_REQUESTS.set(normalizedSymbol, request);
        return request;
    }

    private getActiveChartPrice(symbol: string, interval: string): number | null {
        if (state.currentSymbol.trim().toUpperCase() !== symbol) {
            return null;
        }
        if (state.currentInterval !== interval) {
            return null;
        }
        if (state.ohlcvData.length === 0) {
            return null;
        }

        const lastClose = Number(state.ohlcvData[state.ohlcvData.length - 1]?.close);
        return Number.isFinite(lastClose) ? lastClose : null;
    }

    private async fetchSubscription(streamId: string): Promise<AlertSubscription | null> {
        try {
            const subs = await alertService.listSubscriptions();
            return subs.find((s) => s.stream_id === streamId) ?? null;
        } catch {
            return null;
        }
    }

    private async mapWithConcurrency<T, R>(
        items: T[],
        concurrency: number,
        mapper: (item: T) => Promise<R>
    ): Promise<R[]> {
        if (items.length === 0) return [];

        const limit = Math.max(1, Math.floor(concurrency));
        const results = new Array<R>(items.length);
        let cursor = 0;

        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (true) {
                const idx = cursor++;
                if (idx >= items.length) break;
                results[idx] = await mapper(items[idx]);
            }
        });

        await Promise.all(workers);
        return results;
    }
}

export const livePositionsService = new LivePositionsService();
