import { state } from "../state";
import { buildOhlcvTimeMap } from "../state-actions";
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
import { livePositionsService } from "../live-positions-service";
import { isBinanceDataProvider } from "../binance-market";
import { activateLazyFeature } from "../lazy-feature-init";
import {
    logBacktestResultUiFailure,
    runBacktestResultUiSteps,
} from "./backtest-result-ui-steps";
import { createStateSubscriptionsDom } from "./state-subscriptions-dom";
import type { Time } from "lightweight-charts";
import { getMockBarsInput, getVisibleCandlesInput } from "./ui-event-handlers-dom";
import { coalesceAnimationFrame } from "../render-scheduler";

export function setupStateSubscriptions() {
    const dom = createStateSubscriptionsDom();
    const setPriceLoading = () => {
        const priceEl = getRequiredElement('symbolPrice');
        const changeEl = getRequiredElement('symbolChange');
        priceEl.textContent = 'Loading...';
        priceEl.className = 'symbol-price';
        changeEl.textContent = '--';
        changeEl.className = 'symbol-change';
        uiManager.updateSymbolDataSource(
            'Loading',
            'loading',
            'Loading chart data for the selected symbol and timeframe.'
        );
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
    let pendingBacktestResult: typeof state.currentBacktestResult = null;
    let jumpToTrade: (time: Time) => void;
    const deferredBacktestUiFrame = coalesceAnimationFrame(() => {
        const result = pendingBacktestResult;
        pendingBacktestResult = null;
        if (!result || state.currentBacktestResult !== result) {
            return;
        }

        runBacktestResultUiSteps([
            {
                step: "trade_markers",
                run: () => chartManager.displayTradeMarkers(result.trades, uiManager.formatPrice),
            },
        ]);
        void activateLazyFeature("quick-view")
            .then(async () => {
                if (state.currentBacktestResult !== result) {
                    return;
                }

                const { quickViewManager } = await import("../quick-view");
                quickViewManager.setJumpToTrade(jumpToTrade);
                return quickViewManager.onBacktestComplete(result);
            })
            .catch((error) => {
                debugLogger.warn("quick_view.lazy_init_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            });
    });
    const isPanelVisible = (tabId: string) => {
        const panel = document.getElementById(`${tabId}Tab`) as HTMLElement | null;
        return Boolean(panel && !panel.hidden && panel.style.display !== 'none');
    };
    jumpToTrade = (time: Time) => {
        const dataIndex = state.ohlcvData.findIndex(d => d.time === time);
        if (dataIndex !== -1) {
            const from = Math.max(0, dataIndex - 20);
            const to = Math.min(state.ohlcvData.length - 1, dataIndex + 20);
            state.chart.timeScale().setVisibleLogicalRange({ from, to });
        }
    };
    const renderTradesForCurrentState = async () => {
        const result = state.currentBacktestResult;
        if (!result) {
            uiManager.updateTradeBadge(0);
            return;
        }

        await uiManager.updateTradesList(result.trades, jumpToTrade);
    };
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
            void dataManager.loadData(state.currentSymbol, state.currentInterval).catch((error) => {
                debugLogger.error('data.reload_failed', {
                    symbol: state.currentSymbol,
                    interval: state.currentInterval,
                    error: error instanceof Error ? error.message : String(error),
                });
                uiManager.updateSymbolDataSource(
                    'Load failed',
                    'warning',
                    'Chart data reload failed. Check the debug log for details.'
                );
            });
        }, 0);
    };

    // Sync chart data
    state.subscribe('ohlcvData', (data) => {
        debugLogger.event('data.apply', {
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            candles: data.length,
        });
        // Rebuild O(1) time→data index for crosshair hot-path
        state._ohlcvTimeMap = buildOhlcvTimeMap(data);
        // Use chartManager to apply chart mode transformation (Heikin Ashi if enabled)
        chartManager.updateChartData();
        uiManager.updatePriceDisplay();
        livePositionsService.syncActiveChartPrice();

        getRequiredElement('dataPoints').textContent = `${data.length} candles`;
        const candlesInput = getVisibleCandlesInput();
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

        if (state.currentBacktestResult && state.currentBacktestResultSource === 'backtest') {
            void backtestService.runCurrentBacktest().catch((error) => {
                debugLogger.error('backtest.auto_refresh_failed', {
                    source: state.currentBacktestResultSource,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
    });

    // Sync backtest results
    state.subscribe('currentBacktestResult', (result) => {
        deferredBacktestUiFrame.cancel();
        pendingBacktestResult = null;

        if (result) {
            const strategy = strategyRegistry.get(state.currentStrategyKey);
            const params = strategy ? paramManager.getValues(strategy) : {};

            runBacktestResultUiSteps([
                {
                    step: "strategy_indicators",
                    run: () => backtestService.addStrategyIndicators(params),
                },
                {
                    step: "equity_curve",
                    run: () => chartManager.displayEquityCurve(result.equityCurve),
                },
                {
                    step: "results_panel",
                    run: () => uiManager.updateResultsUI(result),
                },
                {
                    step: "trades_panel",
                    run: () => {
                        if (isPanelVisible('trades')) {
                            void uiManager.updateTradesList(result.trades, jumpToTrade)
                                .catch((error) => logBacktestResultUiFailure("trades_list", error));
                        } else {
                            uiManager.updateTradeBadge(result.trades.length);
                        }
                    },
                },
            ]);

            pendingBacktestResult = result;
            deferredBacktestUiFrame.schedule();
        }
    });

    window.addEventListener("strategy-panel:tab-change", ((event: CustomEvent<{ tabId?: string }>) => {
        if (event.detail?.tabId !== 'trades' || !state.currentBacktestResult) {
            return;
        }
        void renderTradesForCurrentState();
    }) as EventListener);
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

    state.subscribe('binanceMarketType', (binanceMarketType) => {
        debugLogger.event('state.binanceMarketType', { binanceMarketType });
        if (!isBinanceDataProvider(dataManager.getProvider(state.currentSymbol))) {
            return;
        }
        scheduleDataReload();
    });

    state.subscribe('mockChartBars', (mockChartBars) => {
        debugLogger.event('state.mockChartBars', { mockChartBars });
        const input = getMockBarsInput();
        if (input) {
            input.value = String(mockChartBars);
        }
        if (!dataManager.isMockSymbol(state.currentSymbol)) return;
        scheduleDataReload();
    });

    // Chart mode changes (Candlestick / Heikin Ashi)
    state.subscribe('chartMode', (chartMode) => {
        debugLogger.event('state.chartMode', { chartMode });
        const toggle = dom.chartModeToggle;
        const label = dom.chartModeLabel;
        if (toggle) {
            const isHA = chartMode === 'heikin-ashi';
            toggle.classList.toggle('active', isHA);
            toggle.title = isHA ? 'Switch to Candlestick' : 'Switch to Heikin Ashi';
            if (label) label.textContent = isHA ? 'HA' : 'Candle';
        }
        if (state.ohlcvData.length > 0) {
            chartManager.updateChartData();
        }
    });

    // Strategy selection
    state.subscribe('currentStrategyKey', (key) => {
        uiManager.updateStrategyDropdown(key);
        uiManager.updateStrategyParams(key);
    });

}
