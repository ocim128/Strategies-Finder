import { state } from "./state";

import {
    StrategyParams,
    BacktestSettings,
    BacktestResult,
    Signal,
} from "./strategies/index";
import type { OHLCVData, Strategy } from "./strategies/index";
import { loadBuiltInStrategyByKey, strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";

import { requiresTypescriptEngine as requiresTsEngine } from "./rust-settings-sanitizer";
import {
} from "./alert-evaluation-window";
import {
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw
} from "./backtest-settings-resolver";
import { resolveSubscriptionExecutionBacktestSettings } from "./alert-subscription-utils";
import type { CapitalSettings } from "./types/backtest";
import type { BinanceMarketType } from "./binance-market";
import {
    createDomBacktestRunHandle,
    delayBacktestUi,
    formatCompletedBacktestStatus,
    setReplayStartButtonDisabled,
    updateDomBacktestRunProgress,
    type BacktestRunHandle,
} from "./backtest-run-presenter";
import { commitBacktestResult, getBacktestPublicationRevision } from "./state-actions";
import { executeBacktest, executeBacktestFromSignals } from "./backtest-executor";
import {
    getCapitalSettings as readCapitalSettings,
    getBacktestSettings as readBacktestSettings,
    resolveSubscriptionCapitalSettings as resolveSubCapitalSettings,
} from "./backtest-settings-reader";
import {
    createEndpointCopySnapshot,
    canCopyLatestUiBacktestEndpointRequest as canCopyEndpoint,
    canRunLatestUiBacktestEndpointPreview as canPreviewEndpoint,
    runLatestUiBacktestEndpointPreview as runEndpointPreview,
    buildLatestUiBacktestEndpointCopyBundle as buildEndpointBundle,
} from "./backtest-endpoint-facade";
import { addStrategyIndicators as renderStrategyIndicators } from "./backtest-chart-renderer";
import { markAppTiming, getMark } from "./app-timing";

type CurrentBacktestExecution = {
    result: BacktestResult;
    engineUsed: 'rust' | 'typescript';
    signals: Signal[];
    requestContext: {
        nowSec: number;
        blockRange: { from: number; to: number } | null;
    };
};

/**
 * The full request identity of one interactive backtest, captured before the
 * first UI delay. Live candle arrays mutate in place (raw ticks) and the user
 * can switch symbol/interval/strategy/block range mid-run, so publication
 * ownership is decided against this capture instead of current UI state.
 * Candle copies are shallow: the Time shape (string or number) is preserved
 * because the spread copies property values as-is.
 */
type CapturedBacktestRequest = {
    binanceMarketType: BinanceMarketType;
    symbol: string;
    interval: string;
    strategyKey: string;
    params: StrategyParams;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    blockRange: { from: number; to: number } | null;
    nowSec: number;
    candles: OHLCVData[];
    publicationRevision: number;
};

type RunCurrentBacktestOptions = {
    dataOverride?: OHLCVData[];
    reason?: string;
};

export class BacktestService {
    private timingBreakdownSampleCount = 0;
    private interactiveRunSequence = 0;

    private shouldCaptureTimingBreakdown(): boolean {
        return Boolean(import.meta.env?.DEV) || ((++this.timingBreakdownSampleCount & 31) === 0);
    }

    private beginInteractiveRun(): number {
        this.interactiveRunSequence += 1;
        return this.interactiveRunSequence;
    }

    private isLatestInteractiveRun(runId: number): boolean {
        return runId === this.interactiveRunSequence;
    }

    private blockRangeMatchesCaptured(
        current: { from: number; to: number } | null,
        captured: { from: number; to: number } | null
    ): boolean {
        if (current === captured) return true;
        if (!current || !captured) return false;
        return current.from === captured.from && current.to === captured.to;
    }

    /**
     * Whether this run may still publish: it must be the newest interactive
     * run, the publication revision must be unchanged since capture, and the
     * live context must still describe the captured request. Revision
     * advancement also covers change-away-and-back (BTC -> ETH -> BTC).
     */
    private ownsPublication(runId: number, captured: CapturedBacktestRequest): boolean {
        if (!this.isLatestInteractiveRun(runId)) return false;
        if (getBacktestPublicationRevision() !== captured.publicationRevision) return false;
        return state.currentSymbol === captured.symbol
            && state.currentInterval === captured.interval
            && state.currentStrategyKey === captured.strategyKey
            && state.binanceMarketType === captured.binanceMarketType
            && this.blockRangeMatchesCaptured(state.blockRange, captured.blockRange);
    }

    public async runCurrentBacktest(options: RunCurrentBacktestOptions = {}) {
        const runId = this.beginInteractiveRun();

        const startedAt = Date.now();
        if (getMark("firstBacktestStart") === undefined) {
            markAppTiming("firstBacktestStart");
        }
        debugLogger.event('backtest.start', {
            strategy: state.currentStrategyKey,
            candles: state.ohlcvData.length,
        });
        const runUi = createDomBacktestRunHandle('runBacktest', 'Running backtest...', true);
        let shouldDelayHide = false;
        const sourceStrategyKey = state.currentStrategyKey;
        const strategy = strategyRegistry.get(sourceStrategyKey);
        if (!strategy) {
            debugLogger.error("backtest.strategy_not_found", { strategyKey: sourceStrategyKey });
            runUi.setStatus('Strategy not found');
            return;
        }

        // Capture the whole request before the first UI delay. Everything the
        // publication decision needs is frozen here; the run itself executes
        // against the live dataset so raw tick mutations stay visible to it.
        const params = paramManager.getValues(strategy);
        const capitalSettings = this.getCapitalSettings();
        const settings = this.getBacktestSettings();
        const sourceData = options.dataOverride ?? state.ohlcvData;
        const capturedRequest: CapturedBacktestRequest = {
            binanceMarketType: state.binanceMarketType,
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            strategyKey: sourceStrategyKey,
            params: { ...params },
            settings: { ...settings },
            capitalSettings: {
                ...capitalSettings,
                advancedSizing: capitalSettings.advancedSizing ? { ...capitalSettings.advancedSizing } : undefined,
            },
            blockRange: state.blockRange ? { ...state.blockRange } : null,
            nowSec: Math.floor(Date.now() / 1000),
            candles: sourceData.map((candle) => ({ ...candle })),
            publicationRevision: getBacktestPublicationRevision(),
        };

        try {
            await updateDomBacktestRunProgress(runUi, '20%', 'Calculating indicators...', 100);
            await updateDomBacktestRunProgress(runUi, '40%', 'Generating signals...', 100);

            const { result, engineUsed, requestContext } = await this.executeBacktest(
                runUi,
                strategy,
                params,
                settings,
                capitalSettings,
                false,
                sourceData,
                capturedRequest.symbol,
                capturedRequest.interval,
                sourceStrategyKey,
                { nowSec: capturedRequest.nowSec, blockRange: capturedRequest.blockRange }
            );

            if (!this.ownsPublication(runId, capturedRequest)) {
                debugLogger.event('backtest.stale_ignored', {
                    strategy: sourceStrategyKey,
                    runId,
                    phase: 'commit',
                });
                return;
            }

            commitBacktestResult(result, 'backtest', {
                reason: options.reason ?? 'manual_backtest',
                endpointCopySnapshot: this.createEndpointCopySnapshot(
                    capturedRequest,
                    engineUsed,
                    requestContext.nowSec,
                    requestContext.blockRange
                ),
                endpointCopyCandles: capturedRequest.candles,
            });

            await updateDomBacktestRunProgress(runUi, '100%', 'Complete!');
            runUi.setStatus(formatCompletedBacktestStatus(result, engineUsed));
            shouldDelayHide = true;
            debugLogger.event('backtest.success', {
                strategy: sourceStrategyKey,
                trades: result.totalTrades,
                durationMs: Date.now() - startedAt,
                engine: engineUsed,
            });
            if (getMark("firstBacktestEnd") === undefined) {
                markAppTiming("firstBacktestEnd");
            }
            // Enable replay button if there are results
            setReplayStartButtonDisabled(result.totalTrades === 0);
        } catch (error) {
            if (!this.ownsPublication(runId, capturedRequest)) {
                debugLogger.event('backtest.stale_ignored', {
                    strategy: sourceStrategyKey,
                    runId,
                    phase: 'error',
                });
                return;
            }
            debugLogger.error('backtest.error', {
                strategy: sourceStrategyKey,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                durationMs: Date.now() - startedAt,
            });
            // Disable replay button on error
            setReplayStartButtonDisabled(true);

            throw error;
        } finally {
            if (shouldDelayHide && this.isLatestInteractiveRun(runId)) {
                await delayBacktestUi(500);
            }
            // Keep presenter finish/cleanup for obsolete runs so the shared
            // run indicator never sticks; only the publication/UI changes are
            // gated by ownership.
            runUi.finish();
        }
    }

    public async previewCurrentBacktestWithSettings(settingsOverride: Partial<BacktestSettings>): Promise<BacktestResult | null> {
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy) {
            return null;
        }

        const params = paramManager.getValues(strategy);
        const capitalSettings = this.getCapitalSettings();
        const mergedSettings = resolveBacktestSettingsFromRaw(
            {
                ...this.getBacktestSettings(),
                ...settingsOverride,
            } as BacktestSettings,
            { coerceWithoutUiToggles: false,
            }
        );

        mergedSettings.tradeDirection = mergedSettings.tradeDirection ?? EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
        mergedSettings.executionModel = mergedSettings.executionModel ?? EFFECTIVE_BACKTEST_DEFAULTS.executionModel;

        const run = await this.runBacktestForData(
            state.ohlcvData,
            state.currentSymbol,
            state.currentInterval,
            state.currentStrategyKey,
            strategy,
            params,
            mergedSettings,
            capitalSettings,
            false
        );

        return run.result;
    }

    private async executeBacktest(
        runUi: BacktestRunHandle,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings,
        capitalSettings: CapitalSettings,
        forceTypescript: boolean,
        ohlcvData: OHLCVData[] = state.ohlcvData,
        symbol: string = state.currentSymbol,
        interval: string = state.currentInterval,
        strategyKey: string = state.currentStrategyKey,
        requestContext?: {
            nowSec: number;
            blockRange: { from: number; to: number } | null;
        }
    ): Promise<CurrentBacktestExecution> {
        await updateDomBacktestRunProgress(runUi, '60%', 'Running backtest...', 100);
        const singleRun = await this.runBacktestForData(
            ohlcvData,
            symbol,
            interval,
            strategyKey,
            strategy,
            params,
            settings,
            capitalSettings,
            forceTypescript,
            requestContext
        );

        return {
            result: singleRun.result,
            engineUsed: singleRun.engineUsed,
            signals: singleRun.signals,
            requestContext: singleRun.requestContext,
        };
    }

    private async runBacktestForData(
        ohlcvData: OHLCVData[],
        symbol: string,
        interval: string,
        strategyKey: string,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings,
        capitalSettings: CapitalSettings,
        forceTypescript: boolean,
        requestContext?: {
            nowSec: number;
            blockRange: { from: number; to: number } | null;
        }
    ): Promise<{
        result: BacktestResult;
        engineUsed: 'rust' | 'typescript';
        signals: Signal[];
        requestContext: {
            nowSec: number;
            blockRange: { from: number; to: number } | null;
        };
    }> {
        const captureTiming = this.shouldCaptureTimingBreakdown();
        const runStart = captureTiming ? performance.now() : 0;
        // Interactive runs pass their captured evaluation time and block range
        // so the executor consumes exactly the captured request context.
        const nowSec = requestContext?.nowSec ?? Math.floor(Date.now() / 1000);
        const blockRange = requestContext
            ? requestContext.blockRange
            : state.blockRange ? { ...state.blockRange } : null;
        const run = await executeBacktest({
            ohlcvData,
            interval,
            primarySymbol: symbol,
            strategyKey,
            strategy,
            strategyParams: params,
            backtestSettings: {
                ...settings,
                symbol,
                interval,
            },
            capitalSettings,
            context: {
                nowSec,
                blockRange,
                // The shared executor performs the capability-aware Rust
                // preflight. Keep this context automatic so next_open and
                // max-hold can use Rust when the health handshake supports them.
                engineMode: forceTypescript ? 'typescript' : 'auto',
            },
            backtestRunOptions: {
                collectDiagnostics: true,
            },
        });

        if (captureTiming) {
            debugLogger.event('backtest.timing_breakdown', {
                engineUsed: run.engineUsed,
                bars: run.result.marketContext?.candleCount ?? 0,
                durations: {
                    total: performance.now() - runStart,
                },
            });
        }

        return {
            ...run,
            requestContext: {
                nowSec,
                blockRange,
            },
        };
    }

    private async runBacktestForPreparedSignals(
        ohlcvData: OHLCVData[],
        interval: string,
        signals: Signal[],
        settings: BacktestSettings,
        capitalSettings: CapitalSettings,
        forceTypescript: boolean
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        return executeBacktestFromSignals(
            ohlcvData,
            interval,
            signals,
            {
                ...settings,
                symbol: state.currentSymbol,
                interval,
            },
            capitalSettings,
            {
                nowSec: Math.floor(Date.now() / 1000),
                blockRange: state.blockRange,
                engineMode: forceTypescript ? 'typescript' : 'auto',
            }
        );
    }

    public requiresTypescriptEngine(settings: BacktestSettings): boolean {
        // Use shared helper for single-source-of-truth Rust eligibility
        return requiresTsEngine(settings);
    }

    public canCopyLatestUiBacktestEndpointRequest(): boolean {
        return canCopyEndpoint();
    }

    public canRunLatestUiBacktestEndpointPreview(): boolean {
        return canPreviewEndpoint();
    }

    public async runLatestUiBacktestEndpointPreview() {
        return runEndpointPreview();
    }

    public async buildLatestUiBacktestEndpointCopyBundle(baseUrl: string) {
        return buildEndpointBundle(baseUrl);
    }

    public getCapitalSettings(): CapitalSettings {
        return readCapitalSettings();
    }

    public getBacktestSettings(): BacktestSettings {
        return readBacktestSettings();
    }

    public async evaluateStrategyOnData(
        ohlcvData: OHLCVData[],
        interval: string,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings = this.getBacktestSettings(),
        capitalSettings: CapitalSettings = this.getCapitalSettings()
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        return this.runBacktestForData(
            ohlcvData,
            state.currentSymbol,
            interval,
            state.currentStrategyKey,
            strategy,
            params,
            settings,
            capitalSettings,
            false
        );
    }

    private resolveSubscriptionCapitalSettings(backtestSettings: BacktestSettings): CapitalSettings {
        return resolveSubCapitalSettings(backtestSettings);
    }

    public async evaluateSignalsOnData(
        ohlcvData: OHLCVData[],
        interval: string,
        signals: Signal[],
        settings: BacktestSettings = this.getBacktestSettings(),
        capitalSettings: CapitalSettings = this.getCapitalSettings()
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        return this.runBacktestForPreparedSignals(
            ohlcvData,
            interval,
            signals,
            settings,
            capitalSettings,
            false
        );
    }

    public addStrategyIndicators(params: StrategyParams) {
        renderStrategyIndicators(params);
    }

    /**
     * Run a backtest with custom strategy params and settings.
     * Used by alert handlers to show last trade for a subscription.
     */
    public async runBacktestForSubscription(
        ohlcvData: OHLCVData[],
        interval: string,
        strategyKey: string,
        strategyParams: Record<string, number>,
        backtestSettings: BacktestSettings
    ): Promise<BacktestResult> {
        const effectiveBacktestSettings = resolveSubscriptionExecutionBacktestSettings(backtestSettings);
        const strategy = strategyRegistry.get(strategyKey) ?? await loadBuiltInStrategyByKey(strategyKey);
        if (!strategy) {
            throw new Error(`Strategy not found: ${strategyKey}`);
        }

        const capitalSettings = this.resolveSubscriptionCapitalSettings(effectiveBacktestSettings);
        // Keep Alerts "Last Trade" aligned with Worker evaluation (TypeScript engine path).
        // Run the backtest
        const runResult = await this.runBacktestForData(
            ohlcvData,
            state.currentSymbol,
            interval,
            strategyKey,
            strategy,
            strategyParams,
            effectiveBacktestSettings,
            capitalSettings,
            true
        );

        return runResult.result;
    }

    private createEndpointCopySnapshot(
        captured: CapturedBacktestRequest,
        engineUsed: 'rust' | 'typescript',
        nowSec: number,
        blockRange: { from: number; to: number } | null
    ) {
        // Identity comes from the captured request, never current UI state:
        // by commit time the user may already describe a different market.
        return createEndpointCopySnapshot({
            symbol: captured.symbol,
            interval: captured.interval,
            strategyKey: captured.strategyKey,
            strategyParams: captured.params,
            backtestSettings: captured.settings,
            capitalSettings: captured.capitalSettings,
            engineUsed,
            nowSec,
            blockRange,
            datasetForFingerprint: captured.candles,
        });
    }
}

export const backtestService = new BacktestService();
