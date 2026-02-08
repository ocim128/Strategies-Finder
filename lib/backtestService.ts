import { state } from "./state";
import { uiManager } from "./uiManager";
import { chartManager } from "./chartManager";
// import {
//     runBacktest,
//     StrategyParams,
//     BacktestSettings,
//     EntryConfirmationMode
// } from "../../../../src/strategies/index";

import { runBacktest, StrategyParams, BacktestSettings, TradeFilterMode, ExecutionModel, buildEntryBacktestResult, BacktestResult } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./paramManager";
import { debugLogger } from "./debugLogger";
import { rustEngine } from "./rustEngineClient";
import { shouldUseRustEngine } from "./enginePreferences";
import { buildConfirmationStates, filterSignalsWithConfirmations, filterSignalsWithConfirmationsBoth, getConfirmationStrategyParams, getConfirmationStrategyValues } from "./confirmationStrategies";

export class BacktestService {
    private warnedStrictEngine = false;

    private resolveTradeFilterMode(settings: BacktestSettings): TradeFilterMode {
        return (settings.tradeFilterMode ?? settings.entryConfirmation ?? 'none') as TradeFilterMode;
    }

    public async runCurrentBacktest() {
        const startedAt = Date.now();
        debugLogger.event('backtest.start', {
            strategy: state.currentStrategyKey,
            candles: state.ohlcvData.length,
        });
        const progressContainer = document.getElementById('progressContainer')!;
        const progressFill = document.getElementById('progressFill')!;
        const progressText = document.getElementById('progressText')!;
        const statusEl = document.getElementById('strategyStatus')!;
        const runButton = document.getElementById('runBacktest') as HTMLButtonElement | null;

        const setLoading = (loading: boolean) => {
            if (!runButton) return;
            runButton.disabled = loading;
            runButton.classList.toggle('is-loading', loading);
            runButton.setAttribute('aria-busy', loading ? 'true' : 'false');
        };

        setLoading(true);
        progressContainer.classList.add('active');
        statusEl.textContent = 'Running backtest...';
        let shouldDelayHide = false;

        try {
            progressFill.style.width = '20%';
            progressText.textContent = 'Calculating indicators...';
            await this.sleep(100);

            const strategy = strategyRegistry.get(state.currentStrategyKey);
            if (!strategy) {
                console.error(`Strategy not found: ${state.currentStrategyKey}`);
                statusEl.textContent = 'Strategy not found';
                return;
            }

            const params = paramManager.getValues(strategy);
            const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = this.getCapitalSettings();
            const settings = this.getBacktestSettings();
            const requiresTsEngine = this.requiresTypescriptEngine(settings);

            progressFill.style.width = '40%';
            progressText.textContent = 'Generating signals...';
            await this.sleep(100);

            const signals = strategy.execute(state.ohlcvData, params);

            progressFill.style.width = '60%';
            progressText.textContent = 'Running backtest...';
            await this.sleep(100);

            const confirmationStrategies = settings.confirmationStrategies ?? [];
            const tradeFilterMode = this.resolveTradeFilterMode(settings);
            const confirmationStates = confirmationStrategies.length > 0
                ? buildConfirmationStates(state.ohlcvData, confirmationStrategies, settings.confirmationStrategyParams)
                : [];
            const filteredSignals = confirmationStates.length > 0
                ? ((strategy.metadata?.role === 'entry' || settings.tradeDirection === 'both')
                    ? filterSignalsWithConfirmationsBoth(
                        state.ohlcvData,
                        signals,
                        confirmationStates,
                        tradeFilterMode
                    )
                    : filterSignalsWithConfirmations(
                        state.ohlcvData,
                        signals,
                        confirmationStates,
                        tradeFilterMode,
                        settings.tradeDirection ?? 'long'
                    ))
                : signals;

            // Try Rust engine first for performance, fallback to TypeScript
            let result;
            let engineUsed: 'rust' | 'typescript' = 'typescript';

            const evaluation = strategy.evaluate?.(state.ohlcvData, params, filteredSignals);
            const entryStats = evaluation?.entryStats;

            const rustSettings: BacktestSettings = { ...settings };
            delete (rustSettings as { confirmationStrategies?: string[] }).confirmationStrategies;
            delete (rustSettings as { confirmationStrategyParams?: Record<string, StrategyParams> }).confirmationStrategyParams;
            delete (rustSettings as { executionModel?: string }).executionModel;
            delete (rustSettings as { allowSameBarExit?: boolean }).allowSameBarExit;
            delete (rustSettings as { slippageBps?: number }).slippageBps;
            delete (rustSettings as { marketMode?: string }).marketMode;

            if (strategy.metadata?.role === 'entry' && entryStats) {
                result = buildEntryBacktestResult(entryStats);
                engineUsed = 'typescript';
            }

            if (!result && shouldUseRustEngine() && !requiresTsEngine) {
                const rustResult = await rustEngine.runBacktest(
                    state.ohlcvData,
                    filteredSignals,
                    initialCapital,
                    positionSize,
                    commission,
                    rustSettings,
                    { mode: sizingMode, fixedTradeAmount }
                );

                if (rustResult) {
                    if (this.isResultConsistent(rustResult)) {
                        result = rustResult;
                        engineUsed = 'rust';
                        debugLogger.event('backtest.rust_used', { bars: state.ohlcvData.length });
                    } else {
                        debugLogger.warn('[Backtest] Rust result failed consistency checks, falling back to TypeScript');
                        uiManager.showToast('Rust backtest result inconsistent, rerunning in TypeScript', 'info');
                    }
                }
            }

            // Fallback to TypeScript if Rust unavailable or failed
            if (!result) {
                if (requiresTsEngine && shouldUseRustEngine() && !this.warnedStrictEngine) {
                    this.warnedStrictEngine = true;
                    uiManager.showToast('Backtest realism settings require TypeScript engine (Rust skipped).', 'info');
                }
                result = runBacktest(
                    state.ohlcvData,
                    filteredSignals,
                    initialCapital,
                    positionSize,
                    commission,
                    settings,
                    { mode: sizingMode, fixedTradeAmount }
                );
                engineUsed = 'typescript';
            }

            state.set('currentBacktestResult', result);

            // Send webhook notifications for completed trades
            if (result.trades.length > 0) {
                this.sendWebhookForTrades(result.trades, strategy.name, params);
            }

            progressFill.style.width = '100%';
            progressText.textContent = 'Complete!';
            if (result.entryStats) {
                const entryWin = result.entryStats.winRate.toFixed(1);
                const useTarget = result.entryStats.winDefinition === 'target' && (result.entryStats.targetPct ?? 0) > 0;
                const avgBars = useTarget
                    ? (result.entryStats.avgTargetBars ?? result.entryStats.avgRetestBars)
                    : result.entryStats.avgRetestBars;
                const label = useTarget ? 'Avg Target' : 'Avg Retest';
                statusEl.textContent = `${result.entryStats.totalEntries} entries | Win ${entryWin}% | ${label} ${avgBars.toFixed(1)} bars`;
            } else {
                const expectancyText = `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`;
                const pfText = result.profitFactor === Infinity ? 'Inf' : result.profitFactor.toFixed(2);
                const engineBadge = engineUsed === 'rust' ? ' ⚡' : '';
                statusEl.textContent = `${result.totalTrades} trades | Exp ${expectancyText} | PF ${pfText}${engineBadge}`;
            }
            shouldDelayHide = true;
            debugLogger.event('backtest.success', {
                strategy: state.currentStrategyKey,
                trades: result.totalTrades,
                durationMs: Date.now() - startedAt,
                engine: engineUsed,
            });

            // Enable replay button if there are results
            const replayStartBtn = document.getElementById('replayStartBtn') as HTMLButtonElement | null;
            if (replayStartBtn) {
                replayStartBtn.disabled = result.totalTrades === 0;
            }
        } catch (error) {
            debugLogger.error('backtest.error', {
                strategy: state.currentStrategyKey,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                durationMs: Date.now() - startedAt,
            });

            // Disable replay button on error
            const replayStartBtn = document.getElementById('replayStartBtn') as HTMLButtonElement | null;
            if (replayStartBtn) {
                replayStartBtn.disabled = true;
            }

            throw error;
        } finally {
            if (shouldDelayHide) {
                await this.sleep(500);
            }
            progressContainer.classList.remove('active');
            progressFill.style.width = '0%';
            setLoading(false);
        }
    }

    /**
     * Send webhook notifications for completed trades
     */
    private async sendWebhookForTrades(
        trades: import('./strategies/types').Trade[],
        strategyName: string,
        params: StrategyParams
    ): Promise<void> {
        if (trades.length === 0) return;

        try {
            // Dynamic import to avoid circular dependencies
            const { webhookService } = await import('./webhookService');

            // Send just the most recent trade (to avoid flooding webhooks)
            const lastTrade = trades[trades.length - 1];

            await webhookService.sendTradeExit(
                {
                    id: lastTrade.id,
                    type: lastTrade.type,
                    entryPrice: lastTrade.entryPrice,
                    exitPrice: lastTrade.exitPrice,
                    entryTime: lastTrade.entryTime,
                    exitTime: lastTrade.exitTime,
                    pnl: lastTrade.pnl,
                    pnlPercent: lastTrade.pnlPercent,
                    size: lastTrade.size
                },
                strategyName,
                params
            );
        } catch (error) {
            // Silently fail - webhooks are not critical to backtest
            console.debug('[BacktestService] Webhook send failed:', error);
        }
    }

    public getCapitalSettings(): {
        initialCapital: number;
        positionSize: number;
        commission: number;
        sizingMode: 'percent' | 'fixed';
        fixedTradeAmount: number;
    } {
        const initialCapital = Math.max(0, this.readNumberInput('initialCapital', 10000));
        const positionSize = Math.max(0, this.readNumberInput('positionSize', 100));
        const commission = Math.max(0, this.readNumberInput('commission', 0.1));
        const fixedTradeAmount = Math.max(0, this.readNumberInput('fixedTradeAmount', 0));
        const fixedTradeToggle = document.getElementById('fixedTradeToggle') as HTMLInputElement | null;
        const sizingMode: 'percent' | 'fixed' = fixedTradeToggle?.checked ? 'fixed' : 'percent';
        return { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount };
    }

    public getBacktestSettings(): BacktestSettings {
        const riskEnabled = this.isToggleEnabled('riskSettingsToggle');
        const tradeFilterEnabled = this.isToggleEnabled('tradeFilterSettingsToggle');
        const confirmationEnabled = this.isToggleEnabled('confirmationStrategiesToggle', false);
        const riskMode = (document.getElementById('riskMode') as HTMLSelectElement | null)?.value as 'simple' | 'advanced' | 'percentage';
        const useAdvancedRisk = riskMode === 'advanced';
        const usePercentageRisk = riskMode === 'percentage';

        const tradeFilterMode = (document.getElementById('tradeFilterMode') as HTMLSelectElement | null)?.value as TradeFilterMode | undefined;
        const confirmationStrategies = confirmationEnabled ? getConfirmationStrategyValues() : [];
        const confirmationStrategyParams = confirmationEnabled ? getConfirmationStrategyParams() : {};
        const executionModel = (document.getElementById('executionModel') as HTMLSelectElement | null)?.value as ExecutionModel | undefined;
        const resolvedExecutionModel: ExecutionModel = executionModel ?? 'signal_close';
        const tradeDirectionRaw = (document.getElementById('tradeDirection') as HTMLSelectElement | null)?.value;
        const tradeDirection = tradeDirectionRaw === 'short' || tradeDirectionRaw === 'both' ? tradeDirectionRaw : 'long';
        const marketModeRaw = (document.getElementById('marketMode') as HTMLSelectElement | null)?.value;
        const marketMode = marketModeRaw === 'uptrend' || marketModeRaw === 'downtrend' || marketModeRaw === 'sideway'
            ? marketModeRaw
            : 'all';
        return {
            atrPeriod: this.readNumberInput('atrPeriod', 14),
            stopLossAtr: riskEnabled && (riskMode === 'simple' || riskMode === 'advanced') ? this.readNumberInput('stopLossAtr', 1.5) : 0,
            takeProfitAtr: riskEnabled && (riskMode === 'simple' || riskMode === 'advanced') ? this.readNumberInput('takeProfitAtr', 3) : 0,
            trailingAtr: riskEnabled && (riskMode === 'simple' || riskMode === 'advanced') ? this.readNumberInput('trailingAtr', 2) : 0,
            partialTakeProfitAtR: riskEnabled && useAdvancedRisk ? this.readNumberInput('partialTakeProfitAtR', 1) : 0,
            partialTakeProfitPercent: riskEnabled && useAdvancedRisk ? this.readNumberInput('partialTakeProfitPercent', 50) : 0,
            breakEvenAtR: riskEnabled && useAdvancedRisk ? this.readNumberInput('breakEvenAtR', 1) : 0,
            timeStopBars: riskEnabled && useAdvancedRisk ? this.readNumberInput('timeStopBars', 0) : 0,

            // New percentage settings
            riskMode,
            stopLossPercent: riskEnabled && usePercentageRisk ? this.readNumberInput('stopLossPercent', 5) : 0,
            takeProfitPercent: riskEnabled && usePercentageRisk ? this.readNumberInput('takeProfitPercent', 10) : 0,
            stopLossEnabled: riskEnabled && usePercentageRisk ? this.isToggleEnabled('stopLossToggle', true) : false,
            takeProfitEnabled: riskEnabled && usePercentageRisk ? this.isToggleEnabled('takeProfitToggle', true) : false,
            marketMode,

            // Regime filters (not exposed in UI here; keep explicit defaults for engine parity)
            trendEmaPeriod: 0,
            trendEmaSlopeBars: 0,
            atrPercentMin: 0,
            atrPercentMax: 0,
            adxPeriod: 14,
            adxMin: 0,
            adxMax: 0,

            tradeFilterMode: tradeFilterEnabled ? (tradeFilterMode ?? 'none') : 'none',
            // Legacy field for compatibility with existing Rust payloads and old saved configs.
            entryConfirmation: tradeFilterEnabled ? (tradeFilterMode ?? 'none') : 'none',
            confirmLookback: tradeFilterEnabled ? this.readNumberInput('confirmLookback', 1) : 1,
            volumeSmaPeriod: tradeFilterEnabled ? this.readNumberInput('volumeSmaPeriod', 20) : 20,
            volumeMultiplier: tradeFilterEnabled ? this.readNumberInput('volumeMultiplier', 1.5) : 1.5,
            rsiPeriod: tradeFilterEnabled ? this.readNumberInput('confirmRsiPeriod', 14) : 14,
            rsiBullish: tradeFilterEnabled ? this.readNumberInput('confirmRsiBullish', 55) : 55,
            rsiBearish: tradeFilterEnabled ? this.readNumberInput('confirmRsiBearish', 45) : 45,
            confirmationStrategies,
            confirmationStrategyParams,
            tradeDirection,
            executionModel: resolvedExecutionModel,
            allowSameBarExit: this.isToggleEnabled('allowSameBarExitToggle', false),
            slippageBps: this.readNumberInput('slippageBps', 5)
        };
    }

    private readNumberInput(id: string, fallback: number): number {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (!input) return fallback;
        const value = parseFloat(input.value);
        return Number.isFinite(value) ? value : fallback;
    }

    private isToggleEnabled(id: string, fallback: boolean = true): boolean {
        const toggle = document.getElementById(id) as HTMLInputElement | null;
        return toggle ? toggle.checked : fallback;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private isResultConsistent(result: BacktestResult): boolean {
        const totalTrades = result.totalTrades;
        if (totalTrades !== result.winningTrades + result.losingTrades) return false;
        if (totalTrades <= 0) return true;

        const expectedWinRate = (result.winningTrades / totalTrades) * 100;
        if (Math.abs(expectedWinRate - result.winRate) > 1) return false;

        const expectedAvgTrade = result.netProfit / totalTrades;
        const tolerance = Math.max(0.01, Math.abs(expectedAvgTrade) * 0.15);
        if (Math.abs(expectedAvgTrade - result.avgTrade) > tolerance) return false;

        return true;
    }

    public requiresTypescriptEngine(settings: BacktestSettings): boolean {
        const executionModel = settings.executionModel ?? 'signal_close';
        const allowSameBarExit = settings.allowSameBarExit ?? true;
        const slippageBps = settings.slippageBps ?? 0;
        return executionModel !== 'signal_close' || slippageBps > 0 || !allowSameBarExit || settings.tradeDirection === 'both';
    }

    public addStrategyIndicators(params: StrategyParams) {
        chartManager.clearIndicators();
        const indicatorsPanel = document.getElementById('indicatorsPanel');
        if (indicatorsPanel) indicatorsPanel.innerHTML = '';

        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy) {
            uiManager.updateEntryPreview(null);
            return;
        }

        const indicators = strategy.indicators ? strategy.indicators(state.ohlcvData, params) : [];
        const times = state.ohlcvData.map(d => d.time);

        indicators.forEach(ind => {
            if (Array.isArray(ind.values)) {
                const values = ind.values as (number | null)[];
                const color = ind.color || (ind.type === 'histogram' ? '#ef5350' : '#2962ff');
                this.addIndicatorToChart(ind.name, values, times, color, ind.type);
            }
        });

        const preview = strategy.entryPreview ? strategy.entryPreview(state.ohlcvData, params) : null;
        uiManager.updateEntryPreview(preview);
    }

    private addIndicatorToChart(name: string, values: (number | null)[], times: any[], color: string, type: 'line' | 'band' | 'histogram') {
        const lineData = values
            .map((v, i) => v !== null ? { time: times[i], value: v } : null)
            .filter(d => d !== null) as { time: any; value: number }[];

        if (type === 'histogram') {
            const id = chartManager.addIndicatorHistogram(name, 0, lineData, color);
            uiManager.addIndicatorBadge(id, name, 0, color);
        } else {
            const id = chartManager.addIndicatorLine(name, 0, lineData, color);
            uiManager.addIndicatorBadge(id, name, 0, color);
        }
    }
}

export const backtestService = new BacktestService();
