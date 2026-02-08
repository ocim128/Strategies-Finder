import { Time } from "lightweight-charts";
import { state } from "./state";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./paramManager";
import { backtestService } from "./backtestService";
import { runBacktest, OHLCVData } from "./strategies/index";
import { debugLogger } from "./debugLogger";
import { buildConfirmationStates, filterSignalsWithConfirmations, filterSignalsWithConfirmationsBoth } from "./confirmationStrategies";

// ============================================================================
// Logic Test Configuration
// ============================================================================

export interface LogicTestConfig {
    mockCount: number;       // Number of random datasets to test
    barsCount: number;       // Number of bars per dataset
    volatility: number;      // Base volatility percentage (e.g., 1.5 = 1.5%)
    startPrice: number;      // Starting price for mock data
}

export interface LogicTestResult {
    averageWinrate: number;
    totalTests: number;
    completedTests: number;
    averageTrades: number;
    averageProfitFactor: number;
    averageNetProfit: number;
    averageMaxDrawdown: number;
    minWinrate: number;
    maxWinrate: number;
    stdDevWinrate: number;
    profitableTests: number;
    testDurationMs: number;
    individualResults: IndividualTestResult[];
}

export interface IndividualTestResult {
    index: number;
    totalTrades: number;
    winrate: number;
    profitFactor: number;
    netProfit: number;
    maxDrawdown: number;
}

// ============================================================================
// Logic Test Service
// ============================================================================

class LogicTestService {
    private isRunning = false;
    private shouldStop = false;
    private lastResult: LogicTestResult | null = null;

    /**
     * Run the logic test with the current strategy against multiple mock datasets
     */
    async runLogicTest(): Promise<LogicTestResult | null> {
        if (this.isRunning) {
            this.updateStatus("Test already running...");
            return null;
        }

        this.isRunning = true;
        this.shouldStop = false;
        this.setLoading(true);
        this.showProgress(true);

        const startTime = Date.now();

        try {
            // Get current strategy
            const strategyKey = state.currentStrategyKey;
            const strategy = strategyRegistry.get(strategyKey);
            if (!strategy) {
                this.updateStatus("Error: No strategy selected");
                return null;
            }

            // Get configuration from UI
            const config = this.getConfigFromUI();
            this.updateStatus(`Starting logic test with ${config.mockCount} datasets...`);

            // Get strategy params and settings
            const params = paramManager.getValues(strategy);
            const capitalSettings = backtestService.getCapitalSettings();
            const backtestSettings = backtestService.getBacktestSettings();
            const confirmationStrategies = backtestSettings.confirmationStrategies ?? [];
            const confirmationParams = backtestSettings.confirmationStrategyParams;
            const hasConfirmationFilters = confirmationStrategies.length > 0;

            const results: IndividualTestResult[] = [];
            let completedTests = 0;

            // Run tests on each mock dataset
            for (let i = 0; i < config.mockCount; i++) {
                if (this.shouldStop) {
                    this.updateStatus(`Test stopped at ${i + 1}/${config.mockCount}`);
                    break;
                }

                // Update progress
                this.updateProgress(i, config.mockCount);
                this.updateStatus(`Testing dataset ${i + 1} of ${config.mockCount}...`);

                // Generate mock data with unique seed
                const mockData = this.generateMockData(config, i);

                // Generate signals
                let signals = strategy.execute(mockData, params);
                if (hasConfirmationFilters) {
                    const confirmationStates = buildConfirmationStates(mockData, confirmationStrategies, confirmationParams);
                    if (confirmationStates.length > 0) {
                        signals = backtestSettings.tradeDirection === 'both'
                            ? filterSignalsWithConfirmationsBoth(
                                mockData,
                                signals,
                                confirmationStates,
                                backtestSettings.tradeFilterMode ?? backtestSettings.entryConfirmation ?? 'none'
                            )
                            : filterSignalsWithConfirmations(
                                mockData,
                                signals,
                                confirmationStates,
                                backtestSettings.tradeFilterMode ?? backtestSettings.entryConfirmation ?? 'none',
                                backtestSettings.tradeDirection ?? 'long'
                            );
                    }
                }

                // Run backtest
                const backtestResult = runBacktest(
                    mockData,
                    signals,
                    capitalSettings.initialCapital,
                    capitalSettings.positionSize,
                    capitalSettings.commission,
                    backtestSettings,
                    { mode: capitalSettings.sizingMode, fixedTradeAmount: capitalSettings.fixedTradeAmount }
                );

                // Collect results
                results.push({
                    index: i + 1,
                    totalTrades: backtestResult.totalTrades,
                    winrate: backtestResult.winRate,
                    profitFactor: backtestResult.profitFactor,
                    netProfit: backtestResult.netProfit,
                    maxDrawdown: backtestResult.maxDrawdownPercent
                });

                completedTests++;

                // Yield to UI to keep it responsive
                if (i % 5 === 0) {
                    await this.sleep(10);
                }
            }

            // Calculate aggregate statistics
            const testResult = this.calculateAggregateResults(results, Date.now() - startTime);
            this.lastResult = testResult;

            // Display results
            this.displayResults(testResult);

            const status = this.shouldStop
                ? `Stopped - ${completedTests} tests completed`
                : `Completed ${testResult.totalTests} tests in ${(testResult.testDurationMs / 1000).toFixed(2)}s`;
            this.updateStatus(status);

            debugLogger.event('logictest.complete', {
                strategy: strategyKey,
                tests: testResult.totalTests,
                avgWinrate: testResult.averageWinrate,
                durationMs: testResult.testDurationMs
            });

            return testResult;

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.updateStatus(`Error: ${msg}`);
            console.error('[LogicTestService] Error:', err);
            return null;

        } finally {
            this.isRunning = false;
            this.shouldStop = false;
            this.setLoading(false);
            this.showProgress(false);
        }
    }

    /**
     * Stop the running test
     */
    stopTest(): void {
        if (this.isRunning) {
            this.shouldStop = true;
            this.updateStatus("Stopping test...");
        }
    }

    /**
     * Generate mock OHLCV data using random walk algorithm
     */
    private generateMockData(config: LogicTestConfig, seed: number): OHLCVData[] {
        const data: OHLCVData[] = [];
        let price = config.startPrice;
        const now = Math.floor(Date.now() / 1000);
        const intervalSeconds = 60; // 1 minute bars

        // Use seed to create slightly different random sequences
        const randomOffset = seed * 12345.6789;

        // Start 'barsCount' periods ago
        let time = (now - (config.barsCount * intervalSeconds)) as Time;

        for (let i = 0; i < config.barsCount; i++) {
            const volatility = price * (config.volatility / 100);

            // Use pseudo-random based on iteration and seed for reproducibility
            const random1 = this.seededRandom(i + randomOffset);
            const random2 = this.seededRandom(i * 2 + randomOffset);
            const random3 = this.seededRandom(i * 3 + randomOffset);
            const random4 = this.seededRandom(i * 4 + randomOffset);

            const change = (random1 - 0.5) * volatility;
            const open = price;
            const close = price + change;
            const high = Math.max(open, close) + random2 * volatility * 0.5;
            const low = Math.min(open, close) - random3 * volatility * 0.5;
            const volume = Math.floor(random4 * 1000000) + 100000;

            data.push({
                time: time,
                open,
                high,
                low,
                close,
                volume,
            });

            price = close;
            // Ensure price stays positive
            if (price < config.startPrice * 0.1) {
                price = config.startPrice * 0.1;
            }
            time = (Number(time) + intervalSeconds) as Time;
        }

        return data;
    }

    /**
     * Simple seeded random number generator (0 to 1)
     */
    private seededRandom(seed: number): number {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    /**
     * Calculate aggregate results from individual tests
     */
    private calculateAggregateResults(
        results: IndividualTestResult[],
        durationMs: number
    ): LogicTestResult {
        if (results.length === 0) {
            return {
                averageWinrate: 0,
                totalTests: 0,
                completedTests: 0,
                averageTrades: 0,
                averageProfitFactor: 0,
                averageNetProfit: 0,
                averageMaxDrawdown: 0,
                minWinrate: 0,
                maxWinrate: 0,
                stdDevWinrate: 0,
                profitableTests: 0,
                testDurationMs: durationMs,
                individualResults: results
            };
        }

        const winrates = results.map(r => r.winrate);
        const trades = results.map(r => r.totalTrades);
        const profitFactors = results.map(r => r.profitFactor === Infinity ? 100 : r.profitFactor);
        const netProfits = results.map(r => r.netProfit);
        const maxDrawdowns = results.map(r => r.maxDrawdown);

        const avgWinrate = this.average(winrates);
        const stdDev = this.standardDeviation(winrates);

        return {
            averageWinrate: avgWinrate,
            totalTests: results.length,
            completedTests: results.length,
            averageTrades: this.average(trades),
            averageProfitFactor: this.average(profitFactors),
            averageNetProfit: this.average(netProfits),
            averageMaxDrawdown: this.average(maxDrawdowns),
            minWinrate: Math.min(...winrates),
            maxWinrate: Math.max(...winrates),
            stdDevWinrate: stdDev,
            profitableTests: results.filter(r => r.netProfit > 0).length,
            testDurationMs: durationMs,
            individualResults: results
        };
    }

    private average(arr: number[]): number {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    private standardDeviation(arr: number[]): number {
        if (arr.length === 0) return 0;
        const avg = this.average(arr);
        const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
        const avgSquareDiff = this.average(squareDiffs);
        return Math.sqrt(avgSquareDiff);
    }

    /**
     * Get configuration from UI inputs
     */
    private getConfigFromUI(): LogicTestConfig {
        return {
            mockCount: this.readNumberInput('lt-mock-count', 10),
            barsCount: this.readNumberInput('lt-bars-count', 5000),
            volatility: this.readNumberInput('lt-volatility', 1.5),
            startPrice: this.readNumberInput('lt-start-price', 100)
        };
    }

    private readNumberInput(id: string, fallback: number): number {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return fallback;
        const value = parseFloat(el.value);
        return Number.isFinite(value) ? value : fallback;
    }

    /**
     * Display results in the UI
     */
    private displayResults(result: LogicTestResult): void {
        this.updateGauge(result.averageWinrate);
        this.updateSummaryPanel(result);
        this.updateResultsTable(result);
        this.updateResultDescription(result);
    }

    private updateGauge(winrate: number): void {
        const gauge = document.getElementById('lt-gauge');
        const scoreEl = document.getElementById('lt-score');

        if (gauge) {
            gauge.style.setProperty('--score', String(winrate));
            gauge.classList.remove('running', 'excellent', 'good', 'moderate', 'poor', 'critical');

            // Add appropriate class based on winrate
            if (winrate >= 60) gauge.classList.add('excellent');
            else if (winrate >= 50) gauge.classList.add('good');
            else if (winrate >= 40) gauge.classList.add('moderate');
            else if (winrate >= 30) gauge.classList.add('poor');
            else gauge.classList.add('critical');
        }

        if (scoreEl) {
            scoreEl.textContent = winrate.toFixed(1);
        }
    }

    private updateResultDescription(result: LogicTestResult): void {
        const descEl = document.getElementById('lt-result-desc');
        if (!descEl) return;

        const winrate = result.averageWinrate;
        const profitableRatio = (result.profitableTests / result.totalTests * 100).toFixed(0);

        let desc = '';
        if (winrate >= 60) {
            desc = `🟢 Excellent - ${profitableRatio}% of tests were profitable. Strategy shows consistent edge.`;
        } else if (winrate >= 50) {
            desc = `🟡 Good - ${profitableRatio}% profitable tests. Strategy has slight positive edge.`;
        } else if (winrate >= 40) {
            desc = `🟠 Moderate - ${profitableRatio}% profitable tests. May need risk management improvements.`;
        } else if (winrate >= 30) {
            desc = `🔴 Poor - Only ${profitableRatio}% profitable tests. Strategy may be unreliable.`;
        } else {
            desc = `⛔ Critical - ${profitableRatio}% profitable. Strategy performs worse than random.`;
        }

        descEl.textContent = desc;
    }

    private updateSummaryPanel(result: LogicTestResult): void {
        const panel = document.getElementById('lt-summary-panel');
        if (!panel) return;

        const formatPF = (pf: number) => pf >= 100 ? 'Inf' : pf.toFixed(2);
        const formatCurrency = (n: number) => {
            const sign = n >= 0 ? '+' : '';
            return `${sign}$${n.toFixed(0)}`;
        };
        const formatPercent = (n: number) => `${n.toFixed(1)}%`;

        const stats = [
            { label: 'Total Tests', value: String(result.totalTests), positive: true },
            { label: 'Avg Trades', value: result.averageTrades.toFixed(0), positive: result.averageTrades > 10 },
            { label: 'Avg Winrate', value: formatPercent(result.averageWinrate), positive: result.averageWinrate >= 50 },
            { label: 'WR Std Dev', value: formatPercent(result.stdDevWinrate), positive: result.stdDevWinrate < 15 },
            { label: 'Min Winrate', value: formatPercent(result.minWinrate), positive: result.minWinrate >= 40 },
            { label: 'Max Winrate', value: formatPercent(result.maxWinrate), positive: result.maxWinrate >= 50 },
            { label: 'Avg PF', value: formatPF(result.averageProfitFactor), positive: result.averageProfitFactor >= 1.5 },
            { label: 'Avg Profit', value: formatCurrency(result.averageNetProfit), positive: result.averageNetProfit > 0 },
            { label: 'Avg MaxDD', value: formatPercent(result.averageMaxDrawdown), positive: result.averageMaxDrawdown < 20 },
            { label: 'Profitable', value: `${result.profitableTests}/${result.totalTests}`, positive: result.profitableTests > result.totalTests / 2 }
        ];

        panel.innerHTML = stats.map(stat => `
            <div class="lt-stat">
                <div class="lt-label">${stat.label}</div>
                <div class="lt-value ${stat.positive ? 'positive' : 'negative'}">${stat.value}</div>
            </div>
        `).join('');
    }

    private updateResultsTable(result: LogicTestResult): void {
        const tbody = document.getElementById('lt-results-table-body');
        if (!tbody) return;

        if (result.individualResults.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No results</td></tr>';
            return;
        }

        const formatPF = (pf: number) => pf >= 100 ? 'Inf' : pf.toFixed(2);
        const formatCurrency = (n: number) => `$${n.toFixed(0)}`;

        tbody.innerHTML = result.individualResults.map(r => {
            const rowClass = r.netProfit > 0 ? 'positive' : 'negative';
            return `
                <tr class="${rowClass}">
                    <td>${r.index}</td>
                    <td>${r.totalTrades}</td>
                    <td class="${r.winrate >= 50 ? 'positive' : 'negative'}">${r.winrate.toFixed(1)}%</td>
                    <td>${formatPF(r.profitFactor)}</td>
                    <td class="${r.netProfit >= 0 ? 'positive' : 'negative'}">${formatCurrency(r.netProfit)}</td>
                    <td>${r.maxDrawdown.toFixed(1)}%</td>
                </tr>
            `;
        }).join('');
    }

    private updateProgress(current: number, total: number): void {
        const progressFill = document.getElementById('lt-progress-fill');
        const progressText = document.getElementById('lt-progress-text');

        if (progressFill) {
            const percent = (current / total) * 100;
            progressFill.style.width = `${percent}%`;
        }

        if (progressText) {
            progressText.textContent = `${current} / ${total}`;
        }
    }

    private showProgress(show: boolean): void {
        const container = document.getElementById('lt-progress-container');
        if (container) {
            container.classList.toggle('active', show);
        }
    }

    private setLoading(loading: boolean): void {
        const spinner = document.getElementById('lt-spinner');
        const runBtn = document.getElementById('lt-run-btn') as HTMLButtonElement | null;
        const stopBtn = document.getElementById('lt-stop-btn') as HTMLButtonElement | null;
        const gauge = document.getElementById('lt-gauge');

        if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
        if (runBtn) runBtn.disabled = loading;
        if (stopBtn) stopBtn.disabled = !loading;
        if (gauge) gauge.classList.toggle('running', loading);
    }

    private updateStatus(message: string): void {
        const statusEl = document.getElementById('lt-status');
        if (statusEl) statusEl.textContent = message;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get the last test result
     */
    getLastResult(): LogicTestResult | null {
        return this.lastResult;
    }

    /**
     * Check if a test is currently running
     */
    getIsRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Initialize UI event listeners
     */
    initUI(): void {
        const runBtn = document.getElementById('lt-run-btn');
        const stopBtn = document.getElementById('lt-stop-btn');

        if (runBtn) {
            runBtn.addEventListener('click', () => this.runLogicTest());
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopTest());
        }

        debugLogger.info('logictest.ui.init');
    }
}

export const logicTestService = new LogicTestService();
