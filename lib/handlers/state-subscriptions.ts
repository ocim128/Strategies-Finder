import { state } from "../state";
import { debugLogger } from "../debug-logger";
import { uiManager } from "../ui-manager";
import { dataManager } from "../data-manager";
import { chartManager } from "../chart-manager";
import { backtestService } from "../backtest-service";
import { strategyRegistry } from "../../strategyRegistry";
import { paramManager } from "../param-manager";
import { getRequiredElement } from "../dom-utils";
import { SYMBOL_MAP } from "../constants";
import { clearAll } from "../app-actions";

export function setupStateSubscriptions() {
    const setPriceLoading = () => {
        const priceEl = getRequiredElement('symbolPrice');
        const changeEl = getRequiredElement('symbolChange');
        priceEl.textContent = 'Loading...';
        priceEl.className = 'symbol-price';
        changeEl.textContent = '--';
        changeEl.className = 'symbol-change';
    };

    const applyDefaultVisibleRange = (dataLength: number) => {
        const visibleBars = Math.max(50, Math.min(1000, dataLength));
        state.chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, dataLength - visibleBars),
            to: dataLength,
        });
    };

    let lastDataLength = 0;

    let reloadTimeout: number | null = null;
    const scheduleDataReload = () => {
        if (reloadTimeout !== null) {
            clearTimeout(reloadTimeout);
        }
        reloadTimeout = window.setTimeout(() => {
            reloadTimeout = null;
            if (dataManager.shouldSkipAutoReload()) {
                return;
            }
            setPriceLoading();
            clearAll();
            dataManager.loadData(state.currentSymbol, state.currentInterval);
        }, 0);
    };

    // Sync chart data
    state.subscribe('ohlcvData', (data) => {
        debugLogger.event('data.apply', {
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            candles: data.length,
        });
        // Use chartManager to apply chart mode transformation (Heikin Ashi if enabled)
        chartManager.updateChartData();
        uiManager.updatePriceDisplay();

        getRequiredElement('dataPoints').textContent = `${data.length} candles`;
        const candlesInput = document.getElementById('visibleCandlesInput') as HTMLInputElement | null;
        if (candlesInput) {
            candlesInput.value = String(data.length);
        }
        getRequiredElement('lastUpdate').textContent = `Last update: ${new Date().toLocaleTimeString()}`;

        const timeScale = state.chart.timeScale();
        const prevLength = lastDataLength;
        lastDataLength = data.length;
        const isRealtimeUpdate = prevLength > 0 && Math.abs(data.length - prevLength) <= 2;
        if (isRealtimeUpdate) {
            const scrollPos = timeScale.scrollPosition();
            if (scrollPos <= 1) {
                timeScale.scrollToPosition(0, false);
            }
        } else {
            applyDefaultVisibleRange(data.length);
        }

        if (state.currentBacktestResult) {
            backtestService.runCurrentBacktest();
        }
    });

    // Sync backtest results
    state.subscribe('currentBacktestResult', (result) => {
        if (state.replayMode) return;

        if (result) {
            const strategy = strategyRegistry.get(state.currentStrategyKey);
            const params = strategy ? paramManager.getValues(strategy) : {};

            backtestService.addStrategyIndicators(params);
            chartManager.displayTradeMarkers(result.trades, uiManager.formatPrice);
            chartManager.displayEquityCurve(result.equityCurve);
            uiManager.updateResultsUI(result);
            const jumpToTrade = (time: typeof result.trades[number]['entryTime']) => {
                const dataIndex = state.ohlcvData.findIndex(d => d.time === time);
                if (dataIndex !== -1) {
                    const from = Math.max(0, dataIndex - 20);
                    const to = Math.min(state.ohlcvData.length - 1, dataIndex + 20);
                    state.chart.timeScale().setVisibleLogicalRange({ from, to });
                }
            };

            const parityResults = state.twoHourParityBacktestResults;
            if (parityResults) {
                uiManager.updateParityTradesList(parityResults.odd.trades, parityResults.even.trades, jumpToTrade);
            } else {
                uiManager.updateTradesList(result.trades, jumpToTrade);
            }
        }
    });

    state.subscribe('twoHourParityBacktestResults', (results) => {
        if (state.replayMode) return;
        if (results) {
            uiManager.updateParityComparisonUI(results);
            uiManager.updateParityTradesList(results.odd.trades, results.even.trades, (time) => {
                const dataIndex = state.ohlcvData.findIndex(d => d.time === time);
                if (dataIndex !== -1) {
                    const from = Math.max(0, dataIndex - 20);
                    const to = Math.min(state.ohlcvData.length - 1, dataIndex + 20);
                    state.chart.timeScale().setVisibleLogicalRange({ from, to });
                }
            });
        } else {
            uiManager.clearParityComparisonUI();
            if (state.currentBacktestResult) {
                uiManager.updateTradesList(state.currentBacktestResult.trades, (time) => {
                    const dataIndex = state.ohlcvData.findIndex(d => d.time === time);
                    if (dataIndex !== -1) {
                        const from = Math.max(0, dataIndex - 20);
                        const to = Math.min(state.ohlcvData.length - 1, dataIndex + 20);
                        state.chart.timeScale().setVisibleLogicalRange({ from, to });
                    }
                });
            }
        }
    });

    // Theme changes
    state.subscribe('isDarkTheme', (isDark) => {
        document.body.classList.toggle('light-theme', !isDark);
        chartManager.updateTheme();
        getRequiredElement('moonIcon').style.display = isDark ? 'block' : 'none';
        getRequiredElement('sunIcon').style.display = isDark ? 'none' : 'block';
    });

    // Symbol/Interval changes
    state.subscribe('currentSymbol', (symbol) => {
        debugLogger.event('state.currentSymbol', { symbol });

        // Get display name from map, or generate one for Binance pairs
        let displayName = SYMBOL_MAP[symbol];
        if (!displayName) {
            // For Binance pairs like BTCUSDT, format as BTC/USDT
            if (symbol.endsWith('USDT')) {
                displayName = `${symbol.slice(0, -4)}/USDT`;
            } else if (symbol.endsWith('BUSD')) {
                displayName = `${symbol.slice(0, -4)}/BUSD`;
            } else if (symbol.endsWith('BTC')) {
                displayName = `${symbol.slice(0, -3)}/BTC`;
            } else if (symbol.endsWith('ETH')) {
                displayName = `${symbol.slice(0, -3)}/ETH`;
            } else if (symbol.endsWith('BNB')) {
                displayName = `${symbol.slice(0, -3)}/BNB`;
            } else if (symbol.endsWith('+')) {
                const base = symbol.slice(0, -1);
                displayName = /^[A-Z]{6}$/.test(base)
                    ? `${base.slice(0, 3)}/${base.slice(3, 6)}`
                    : base;
            } else if (symbol.toUpperCase().endsWith('.S')) {
                displayName = symbol.slice(0, -2);
            } else {
                displayName = symbol;
            }
        }

        getRequiredElement('symbolName').textContent = displayName;
        scheduleDataReload();
    });

    state.subscribe('currentInterval', (interval) => {
        debugLogger.event('state.currentInterval', { interval });
        uiManager.updateTimeframeUI(interval);
        scheduleDataReload();
    });

    state.subscribe('mockChartModel', (mockChartModel) => {
        debugLogger.event('state.mockChartModel', { mockChartModel });
        if (!dataManager.isMockSymbol(state.currentSymbol)) return;
        scheduleDataReload();
    });

    state.subscribe('mockChartBars', (mockChartBars) => {
        debugLogger.event('state.mockChartBars', { mockChartBars });
        const input = document.getElementById('mockBarsInput') as HTMLInputElement | null;
        if (input) {
            input.value = String(mockChartBars);
        }
        if (!dataManager.isMockSymbol(state.currentSymbol)) return;
        scheduleDataReload();
    });

    // Chart mode changes (Candlestick / Heikin Ashi)
    state.subscribe('chartMode', (chartMode) => {
        debugLogger.event('state.chartMode', { chartMode });
        // Sync toggle button visual state
        const toggle = document.getElementById('chartModeToggle');
        const label = document.getElementById('chartModeLabel');
        if (toggle) {
            const isHA = chartMode === 'heikin-ashi';
            toggle.classList.toggle('active', isHA);
            toggle.title = isHA ? 'Switch to Candlestick' : 'Switch to Heikin Ashi';
            if (label) label.textContent = isHA ? 'HA' : 'Candle';
        }
        // Re-render chart with appropriate transformation
        if (state.ohlcvData.length > 0) {
            chartManager.updateChartData();
        }
    });

    // Strategy selection
    state.subscribe('currentStrategyKey', (key) => {
        uiManager.updateStrategyParams(key);
    });

}
