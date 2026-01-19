import { state } from "../state";
import { debugLogger } from "../debugLogger";
import { uiManager } from "../uiManager";
import { dataManager } from "../dataManager";
import { chartManager } from "../chartManager";
import { backtestService } from "../backtestService";
import { strategyRegistry } from "../../strategyRegistry";
import { paramManager } from "../paramManager";
import { getRequiredElement } from "../domUtils";
import { SYMBOL_MAP } from "../constants";
import { clearAll } from "../appActions";

export function setupStateSubscriptions() {
    const setPriceLoading = () => {
        const priceEl = getRequiredElement('symbolPrice');
        const changeEl = getRequiredElement('symbolChange');
        priceEl.textContent = 'Loading...';
        priceEl.className = 'symbol-price';
        changeEl.textContent = '--';
        changeEl.className = 'symbol-change';
    };

    // Sync chart data
    state.subscribe('ohlcvData', (data) => {
        debugLogger.event('data.apply', {
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            candles: data.length,
        });
        const candleData = data.map(d => ({
            time: d.time, open: d.open, high: d.high, low: d.low, close: d.close,
        }));
        state.candlestickSeries.setData(candleData);
        uiManager.updatePriceDisplay();

        getRequiredElement('dataPoints').textContent = `${data.length} candles`;
        getRequiredElement('lastUpdate').textContent = `Last update: ${new Date().toLocaleTimeString()}`;

        state.chart.timeScale().setVisibleLogicalRange({
            from: data.length - 1000,
            to: data.length,
        });

        if (state.currentBacktestResult) {
            backtestService.runCurrentBacktest();
        }
    });

    // Sync backtest results
    state.subscribe('currentBacktestResult', (result) => {
        if (result) {
            const strategy = strategyRegistry.get(state.currentStrategyKey);
            const params = strategy ? paramManager.getValues(strategy) : {};

            backtestService.addStrategyIndicators(params);
            chartManager.displayTradeMarkers(result.trades, uiManager.formatPrice);
            chartManager.displayEquityCurve(result.equityCurve);
            uiManager.updateResultsUI(result);
            uiManager.updateTradesList(result.trades, (time) => {
                const dataIndex = state.ohlcvData.findIndex(d => d.time === time);
                if (dataIndex !== -1) {
                    const from = Math.max(0, dataIndex - 20);
                    const to = Math.min(state.ohlcvData.length - 1, dataIndex + 20);
                    state.chart.timeScale().setVisibleLogicalRange({ from, to });
                }
            });
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
        getRequiredElement('symbolName').textContent = SYMBOL_MAP[symbol];
        setPriceLoading();
        clearAll();
        dataManager.loadData(symbol, state.currentInterval);
    });

    state.subscribe('currentInterval', (interval) => {
        debugLogger.event('state.currentInterval', { interval });
        setPriceLoading();
        clearAll();
        dataManager.loadData(state.currentSymbol, interval);
    });

    // Strategy selection
    state.subscribe('currentStrategyKey', (key) => {
        uiManager.updateStrategyParams(key);
    });
}
