import { state } from "./state";
import { uiManager } from "./uiManager";
import { chartManager } from "./chartManager";
// import {
//     runBacktest,
//     StrategyParams,
//     BacktestSettings,
//     EntryConfirmationMode
// } from "../../../../src/strategies/index";

import { runBacktest, StrategyParams, BacktestSettings, EntryConfirmationMode } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./paramManager";
import { debugLogger } from "./debugLogger";

export class BacktestService {
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

            progressFill.style.width = '40%';
            progressText.textContent = 'Generating signals...';
            await this.sleep(100);

            const signals = strategy.execute(state.ohlcvData, params);

            progressFill.style.width = '60%';
            progressText.textContent = 'Running backtest...';
            await this.sleep(100);

            const result = runBacktest(
                state.ohlcvData,
                signals,
                initialCapital,
                positionSize,
                commission,
                settings,
                { mode: sizingMode, fixedTradeAmount }
            );
            state.set('currentBacktestResult', result);

            // Send webhook notifications for completed trades
            this.sendWebhookForTrades(result.trades, strategy.name, params);

            progressFill.style.width = '100%';
            progressText.textContent = 'Complete!';
            const expectancyText = `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`;
            const pfText = result.profitFactor === Infinity ? 'Inf' : result.profitFactor.toFixed(2);
            statusEl.textContent = `${result.totalTrades} trades | Exp ${expectancyText} | PF ${pfText}`;
            shouldDelayHide = true;
            debugLogger.event('backtest.success', {
                strategy: state.currentStrategyKey,
                trades: result.totalTrades,
                durationMs: Date.now() - startedAt,
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
        const initialCapital = parseFloat((document.getElementById('initialCapital') as HTMLInputElement).value) || 30000;
        const positionSize = parseFloat((document.getElementById('positionSize') as HTMLInputElement).value) || 100;
        const commission = parseFloat((document.getElementById('commission') as HTMLInputElement).value) || 0.1;
        const fixedTradeAmount = Math.max(
            0,
            parseFloat((document.getElementById('fixedTradeAmount') as HTMLInputElement).value) || 0
        );
        const fixedTradeToggle = document.getElementById('fixedTradeToggle') as HTMLInputElement | null;
        const sizingMode: 'percent' | 'fixed' = fixedTradeToggle?.checked ? 'fixed' : 'percent';
        return { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount };
    }

    public getBacktestSettings(): BacktestSettings {
        const riskEnabled = this.isToggleEnabled('riskSettingsToggle');
        const regimeEnabled = this.isToggleEnabled('regimeSettingsToggle');
        const entryEnabled = this.isToggleEnabled('entrySettingsToggle');
        const shortModeEnabled = this.isToggleEnabled('shortModeToggle', false);
        const riskMode = (document.getElementById('riskMode') as HTMLSelectElement | null)?.value as 'simple' | 'advanced' | 'percentage';
        const useAdvancedRisk = riskMode === 'advanced';
        const usePercentageRisk = riskMode === 'percentage';

        const entryConfirmation = (document.getElementById('entryConfirmation') as HTMLSelectElement | null)?.value as EntryConfirmationMode | undefined;
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

            trendEmaPeriod: regimeEnabled ? this.readNumberInput('trendEmaPeriod', 200) : 0,
            trendEmaSlopeBars: regimeEnabled ? this.readNumberInput('trendEmaSlopeBars', 0) : 0,
            atrPercentMin: regimeEnabled ? this.readNumberInput('atrPercentMin', 0) : 0,
            atrPercentMax: regimeEnabled ? this.readNumberInput('atrPercentMax', 0) : 0,
            adxPeriod: regimeEnabled ? this.readNumberInput('adxPeriod', 14) : 0,
            adxMin: regimeEnabled ? this.readNumberInput('adxMin', 0) : 0,
            adxMax: regimeEnabled ? this.readNumberInput('adxMax', 0) : 0,

            entryConfirmation: entryEnabled ? (entryConfirmation ?? 'none') : 'none',
            confirmLookback: entryEnabled ? this.readNumberInput('confirmLookback', 1) : 1,
            volumeSmaPeriod: entryEnabled ? this.readNumberInput('volumeSmaPeriod', 20) : 20,
            volumeMultiplier: entryEnabled ? this.readNumberInput('volumeMultiplier', 1.5) : 1.5,
            rsiPeriod: entryEnabled ? this.readNumberInput('confirmRsiPeriod', 14) : 14,
            rsiBullish: entryEnabled ? this.readNumberInput('confirmRsiBullish', 55) : 55,
            rsiBearish: entryEnabled ? this.readNumberInput('confirmRsiBearish', 45) : 45,
            tradeDirection: shortModeEnabled ? 'short' : 'long'
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

    public addStrategyIndicators(params: StrategyParams) {
        chartManager.clearIndicators();
        const indicatorsPanel = document.getElementById('indicatorsPanel');
        if (indicatorsPanel) indicatorsPanel.innerHTML = '';

        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy || !strategy.indicators) {
            return;
        }

        const indicators = strategy.indicators(state.ohlcvData, params);
        const times = state.ohlcvData.map(d => d.time);

        indicators.forEach(ind => {
            if (Array.isArray(ind.values)) {
                const values = ind.values as (number | null)[];
                const color = ind.color || (ind.type === 'histogram' ? '#ef5350' : '#2962ff');
                this.addIndicatorToChart(ind.name, values, times, color, ind.type);
            }
        });
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
