import { getRequiredElement } from "../dom-utils";
import { state, type ChartMode, type MockChartModel } from "../state";
import { debugLogger } from "../debug-logger";
import { debounce } from "../debounce";
import { MAX_MOCK_BARS, MIN_MOCK_BARS } from "../dataProviders/mock";

import { backtestService } from "../backtest-service";
import { clearAll } from "../app-actions";
import { uiManager } from "../ui-manager";
import { chartManager } from "../chart-manager";
import { dataManager } from "../data-manager";
import { assetSearchService, Asset } from "../asset-search-service";
import { finderManager } from "../finder-manager";
import { scannerManager } from "../scanner/scanner-manager";

export function setupEventHandlers() {
    // Symbol dropdown with search
    const symbolSelector = getRequiredElement('symbolSelector');
    const symbolDropdown = getRequiredElement('symbolDropdown');
    const symbolSearchInput = document.getElementById('symbolSearchInput') as HTMLInputElement | null;
    const symbolSearchResults = document.getElementById('symbolSearchResults');
    const symbolSearchSpinner = document.getElementById('symbolSearchSpinner');
    const symbolSearchClear = document.getElementById('symbolSearchClear');
    const symbolSearchLoading = document.getElementById('symbolSearchLoading');
    const symbolSearchEmpty = document.getElementById('symbolSearchEmpty');
    const mockModelSelect = document.getElementById('mockModelSelect') as HTMLSelectElement | null;
    const mockBarsInput = document.getElementById('mockBarsInput') as HTMLInputElement | null;
    const chartModeToggle = document.getElementById('chartModeToggle') as HTMLButtonElement | null;
    const chartModeLabel = document.getElementById('chartModeLabel');

    let isSearchInitialized = false;
    let selectedIndex = -1;

    if (mockModelSelect) {
        const allowedMockModels = new Set<MockChartModel>(['simple', 'hard', 'v3', 'v4', 'v5', 'v6']);
        mockModelSelect.value = state.mockChartModel;
        mockModelSelect.addEventListener('change', () => {
            const value = mockModelSelect.value;
            if (allowedMockModels.has(value as MockChartModel)) {
                state.set('mockChartModel', value as MockChartModel);
            }
        });
    }

    // Chart mode toggle (Candlestick / Heikin Ashi)
    const syncChartModeToggle = () => {
        if (!chartModeToggle || !chartModeLabel) return;
        const isHA = state.chartMode === 'heikin-ashi';
        chartModeLabel.textContent = isHA ? 'HA' : 'Candle';
        chartModeToggle.classList.toggle('active', isHA);
        chartModeToggle.title = isHA ? 'Switch to Candlestick' : 'Switch to Heikin Ashi';
    };
    syncChartModeToggle();

    if (chartModeToggle) {
        chartModeToggle.addEventListener('click', () => {
            const newMode: ChartMode = state.chartMode === 'candlestick' ? 'heikin-ashi' : 'candlestick';
            debugLogger.event('ui.chartMode.toggle', { mode: newMode });
            state.set('chartMode', newMode);
            syncChartModeToggle();
        });
    }

    if (mockBarsInput) {
        mockBarsInput.value = String(state.mockChartBars);

        const applyMockBars = () => {
            const rawValue = mockBarsInput.value.trim();
            const bars = parseInt(rawValue, 10);

            if (!Number.isFinite(bars)) {
                uiManager.showToast('Enter a valid mock candle count.', 'error');
                mockBarsInput.value = String(state.mockChartBars);
                return;
            }

            const clamped = Math.min(MAX_MOCK_BARS, Math.max(MIN_MOCK_BARS, Math.floor(bars)));
            if (clamped !== bars) {
                uiManager.showToast(`Mock candles must be between ${MIN_MOCK_BARS} and ${MAX_MOCK_BARS}.`, 'error');
            }

            mockBarsInput.value = String(clamped);
            if (clamped !== state.mockChartBars) {
                debugLogger.event('ui.mock.bars', { bars: clamped });
                state.set('mockChartBars', clamped);
            }
        };

        mockBarsInput.addEventListener('change', applyMockBars);
        mockBarsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyMockBars();
            }
        });
    }

    // Render search results
    const renderSearchResults = (assets: Asset[], query: string = '') => {
        if (!symbolSearchResults) return;

        // Clear existing results (except loading/empty states)
        const existingItems = symbolSearchResults.querySelectorAll('.symbol-search-item, .symbol-search-results-header');
        existingItems.forEach(item => item.remove());

        // Hide loading and empty states
        symbolSearchLoading?.classList.add('is-hidden');
        symbolSearchEmpty?.classList.add('is-hidden');

        if (assets.length === 0) {
            symbolSearchEmpty?.classList.remove('is-hidden');
            return;
        }

        // Add header
        const header = document.createElement('div');
        header.className = 'symbol-search-results-header';
        header.textContent = query ? `Results for "${query}"` : 'Popular Assets';
        symbolSearchResults.insertBefore(header, symbolSearchResults.firstChild);

        // Add result items
        assets.forEach((asset) => {
            const item = document.createElement('div');
            item.className = 'symbol-search-item';
            item.dataset.symbol = asset.symbol;
            item.role = 'button';
            item.tabIndex = 0;

            // Mark active if current symbol matches
            if (asset.symbol === state.currentSymbol) {
                item.classList.add('active');
            }

            // Get badge class based on asset type
            const badgeClass = asset.type === 'crypto' ? 'crypto' :
                asset.type === 'stock' ? 'stock' :
                    asset.type === 'forex' ? 'forex' : 'commodity';

            // Get icon text (first 2-3 letters)
            const iconText = asset.baseAsset?.substring(0, 3) || asset.symbol.substring(0, 3);

            // Get badge text
            const badgeText = asset.type === 'crypto' ? 'Crypto' :
                asset.type === 'stock' ? 'Stock' :
                    asset.type === 'forex' ? 'Forex' : 'Commodity';

            const icon = document.createElement('div');
            icon.className = 'symbol-item-icon';
            icon.textContent = iconText;

            const details = document.createElement('div');
            details.className = 'symbol-item-details';

            const name = document.createElement('div');
            name.className = 'symbol-item-name';
            name.textContent = asset.displayName;

            const badge = document.createElement('span');
            badge.className = `symbol-item-badge ${badgeClass}`;
            badge.textContent = badgeText;
            name.appendChild(badge);

            const pair = document.createElement('div');
            pair.className = 'symbol-item-pair';
            pair.textContent = asset.symbol;

            details.appendChild(name);
            details.appendChild(pair);
            item.appendChild(icon);
            item.appendChild(details);

            // Click handler
            item.addEventListener('click', () => selectSymbol(asset.symbol, asset.displayName));

            // Keyboard handler
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectSymbol(asset.symbol, asset.displayName);
                }
            });

            symbolSearchResults.insertBefore(item, symbolSearchLoading);
        });

        selectedIndex = -1;
    };

    // Select symbol handler
    const selectSymbol = (symbol: string, displayName?: string) => {
        // Update UI
        document.querySelectorAll('.symbol-search-item, .dropdown-item').forEach(i => i.classList.remove('active'));
        const selectedItem = document.querySelector(`[data-symbol="${symbol}"]`);
        selectedItem?.classList.add('active');

        // Close dropdown
        symbolDropdown.classList.remove('active');

        // Clear search input
        if (symbolSearchInput) {
            symbolSearchInput.value = '';
        }
        symbolSearchClear?.classList.add('is-hidden');

        if (symbol !== state.currentSymbol) {
            debugLogger.event('ui.symbol.select', { symbol, displayName });
            state.set('currentSymbol', symbol);
        }
    };

    // Search function with debounce
    const performSearch = debounce(async (query: string) => {
        symbolSearchSpinner?.classList.remove('is-hidden');

        try {
            const results = await assetSearchService.searchAssets(query, 20);
            renderSearchResults(results, query);
        } catch (error) {
            console.error('Asset search failed:', error);
            symbolSearchEmpty?.classList.remove('is-hidden');
        } finally {
            symbolSearchSpinner?.classList.add('is-hidden');
        }
    }, 250);

    // Initialize search on first open
    const initializeSearch = async () => {
        if (isSearchInitialized) return;
        isSearchInitialized = true;

        symbolSearchLoading?.classList.remove('is-hidden');

        try {
            const popularAssets = await assetSearchService.searchAssets('', 20);
            renderSearchResults(popularAssets);
        } catch (error) {
            console.error('Failed to initialize asset search:', error);
        }
    };

    // Toggle dropdown
    symbolSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        symbolDropdown.classList.toggle('active');

        if (symbolDropdown.classList.contains('active')) {
            initializeSearch();
            // Focus search input when opening
            setTimeout(() => symbolSearchInput?.focus(), 50);
        }
    });

    symbolSelector.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            symbolDropdown.classList.toggle('active');
            if (symbolDropdown.classList.contains('active')) {
                initializeSearch();
                setTimeout(() => symbolSearchInput?.focus(), 50);
            }
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!symbolDropdown.contains(e.target as Node) && !symbolSelector.contains(e.target as Node)) {
            symbolDropdown.classList.remove('active');
        }
    });

    // Search input handlers
    if (symbolSearchInput) {
        // Prevent dropdown from closing when clicking in search
        symbolSearchInput.addEventListener('click', (e) => e.stopPropagation());

        symbolSearchInput.addEventListener('input', (e) => {
            const query = (e.target as HTMLInputElement).value;

            // Show/hide clear button
            if (query) {
                symbolSearchClear?.classList.remove('is-hidden');
            } else {
                symbolSearchClear?.classList.add('is-hidden');
            }

            performSearch(query);
        });

        // Keyboard navigation
        symbolSearchInput.addEventListener('keydown', (e) => {
            const items = symbolSearchResults?.querySelectorAll('.symbol-search-item');
            if (!items || items.length === 0) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
                updateKeyboardSelection(items as NodeListOf<Element>);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                updateKeyboardSelection(items as NodeListOf<Element>);
            } else if (e.key === 'Enter' && selectedIndex >= 0) {
                e.preventDefault();
                const selected = items[selectedIndex] as HTMLElement;
                if (selected) {
                    const symbol = selected.dataset.symbol!;
                    const displayName = selected.querySelector('.symbol-item-name')?.textContent?.trim();
                    selectSymbol(symbol, displayName);
                }
            } else if (e.key === 'Escape') {
                symbolDropdown.classList.remove('active');
            }
        });
    }

    // Clear button handler
    symbolSearchClear?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (symbolSearchInput) {
            symbolSearchInput.value = '';
            symbolSearchInput.focus();
        }
        symbolSearchClear.classList.add('is-hidden');
        performSearch('');
    });

    // Update keyboard selection highlight
    const updateKeyboardSelection = (items: NodeListOf<Element>) => {
        items.forEach((item, index) => {
            item.classList.toggle('keyboard-focus', index === selectedIndex);
        });

        // Scroll selected item into view
        if (selectedIndex >= 0 && items[selectedIndex]) {
            (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
        }
    };

    // Handle clicks on static dropdown items (stocks, forex, etc.)
    document.querySelectorAll('#symbolDropdown .dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = e.currentTarget as HTMLElement;
            const symbol = target.dataset.symbol;
            if (!symbol) return;
            selectSymbol(symbol);
        });

        item.addEventListener('keydown', (e: Event) => {
            const keyboardEvent = e as KeyboardEvent;
            if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
                e.preventDefault();
                (item as HTMLElement).click();
            }
        });
    });

    // Timeframe tabs
    document.querySelectorAll('.timeframe-tab').forEach(tab => {
        tab.addEventListener('click', async (e) => {
            const interval = (e.currentTarget as HTMLElement).dataset.interval;
            if (!interval) return;
            debugLogger.event('ui.interval.select', { interval });
            state.set('currentInterval', interval);
        });
    });

    const timeframeMinutesInput = document.getElementById('timeframeMinutesInput') as HTMLInputElement | null;
    const timeframeMinutesApply = document.getElementById('timeframeMinutesApply');
    const MAX_CUSTOM_MINUTES = 60 * 24 * 7;
    const visibleCandlesInput = document.getElementById('visibleCandlesInput') as HTMLInputElement | null;
    const visibleCandlesApply = document.getElementById('visibleCandlesApply');
    const MIN_VISIBLE_CANDLES = 200;
    const MAX_VISIBLE_CANDLES = 50000;

    const applyCustomMinutes = () => {
        if (!timeframeMinutesInput) return;
        const rawValue = timeframeMinutesInput.value.trim();
        const minutes = parseInt(rawValue, 10);

        if (!Number.isFinite(minutes)) {
            uiManager.showToast('Enter minutes between 1 and 10080.', 'error');
            return;
        }

        const clamped = Math.min(MAX_CUSTOM_MINUTES, Math.max(1, minutes));
        if (clamped !== minutes) {
            uiManager.showToast('Minutes must be between 1 and 10080.', 'error');
            timeframeMinutesInput.value = String(clamped);
        }

        const interval = `${clamped}m`;
        debugLogger.event('ui.interval.custom', { interval, minutes: clamped });
        state.set('currentInterval', interval);
    };

    if (timeframeMinutesInput) {
        timeframeMinutesInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyCustomMinutes();
            }
        });
    }

    if (timeframeMinutesApply) {
        timeframeMinutesApply.addEventListener('click', applyCustomMinutes);
    }

    const applyVisibleCandles = async () => {
        if (!visibleCandlesInput) return;
        const raw = visibleCandlesInput.value.trim();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed)) {
            uiManager.showToast(`Enter candles between ${MIN_VISIBLE_CANDLES} and ${MAX_VISIBLE_CANDLES}.`, 'error');
            const lookback = dataManager.getChartLookbackBars();
            visibleCandlesInput.value = String(lookback ?? Math.max(MIN_VISIBLE_CANDLES, state.ohlcvData.length || 15000));
            return;
        }

        const clamped = Math.max(MIN_VISIBLE_CANDLES, Math.min(MAX_VISIBLE_CANDLES, Math.floor(parsed)));
        if (clamped !== parsed) {
            uiManager.showToast(`Candles must be between ${MIN_VISIBLE_CANDLES} and ${MAX_VISIBLE_CANDLES}.`, 'error');
        }

        visibleCandlesInput.value = String(clamped);
        dataManager.setChartLookbackBars(clamped);
        await dataManager.loadData(state.currentSymbol, state.currentInterval);
        uiManager.showToast(`Reloaded with ${clamped} candles.`, 'success');
    };

    if (visibleCandlesInput) {
        const lookback = dataManager.getChartLookbackBars();
        visibleCandlesInput.value = String(lookback ?? Math.max(MIN_VISIBLE_CANDLES, state.ohlcvData.length || 15000));
        visibleCandlesInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void applyVisibleCandles();
            }
        });
    }

    if (visibleCandlesApply) {
        visibleCandlesApply.addEventListener('click', () => {
            void applyVisibleCandles();
        });
    }

    // Theme toggle
    getRequiredElement('themeToggle').addEventListener('click', () => {
        state.set('isDarkTheme', !state.isDarkTheme);
    });

    // Strategy selector
    const strategySelect = getRequiredElement<HTMLSelectElement>('strategySelect');
    strategySelect.addEventListener('change', () => {
        state.set('currentStrategyKey', strategySelect.value);
    });

    // Panel tabs
    document.querySelectorAll('.panel-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            const target = e.currentTarget as HTMLElement;
            const tabName = target.dataset.tab!;

            // Update active state and ARIA
            document.querySelectorAll('.panel-tab').forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            target.classList.add('active');
            target.setAttribute('aria-selected', 'true');

            // Toggle visibility dynamically
            const content = document.getElementById('panelContent');
            if (content) {
                const tabDivs = content.querySelectorAll('[id$="Tab"]');
                tabDivs.forEach(div => {
                    (div as HTMLElement).style.display = div.id === `${tabName}Tab` ? 'block' : 'none';
                });
            }

            debugLogger.event('ui.tab.switch', { tab: tabName });
        });

        // Keyboard navigation within tab list
        tab.addEventListener('keydown', (e) => {
            const keyboardEvent = e as KeyboardEvent;
            const tabs = Array.from(document.querySelectorAll('.panel-tab')) as HTMLElement[];
            const currentIndex = tabs.indexOf(e.currentTarget as HTMLElement);

            if (keyboardEvent.key === 'ArrowDown' || keyboardEvent.key === 'ArrowRight') {
                e.preventDefault();
                const nextIndex = (currentIndex + 1) % tabs.length;
                tabs[nextIndex].focus();
            } else if (keyboardEvent.key === 'ArrowUp' || keyboardEvent.key === 'ArrowLeft') {
                e.preventDefault();
                const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                tabs[prevIndex].focus();
            } else if (keyboardEvent.key === 'Home') {
                e.preventDefault();
                tabs[0].focus();
            } else if (keyboardEvent.key === 'End') {
                e.preventDefault();
                tabs[tabs.length - 1].focus();
            }
        });
    });

    // Run backtest button
    getRequiredElement('runBacktest').addEventListener('click', () => backtestService.runCurrentBacktest());

    // Clear trades button
    getRequiredElement('clearTradesBtn').addEventListener('click', clearAll);

    // Toggle panel
    getRequiredElement('togglePanel').addEventListener('click', () => {
        getRequiredElement('strategyPanel').classList.toggle('collapsed');
    });

    // Zoom controls - using enhanced chartManager methods
    getRequiredElement('zoomInTool').addEventListener('click', () => {
        chartManager.zoomIn(0.7);
    });

    getRequiredElement('zoomOutTool').addEventListener('click', () => {
        chartManager.zoomOut(1.4);
    });

    getRequiredElement('fitTool').addEventListener('click', () => {
        state.chart.timeScale().fitContent();
        state.equityChart.timeScale().fitContent();
    });

    // Screenshot button
    const screenshotBtn = document.getElementById('screenshotTool');
    if (screenshotBtn) {
        screenshotBtn.addEventListener('click', async () => {
            try {
                const dataUrl = await chartManager.captureScreenshot();
                chartManager.downloadScreenshot(dataUrl);
                uiManager.showToast('Screenshot saved!', 'success');
            } catch (error) {
                console.error('Screenshot failed:', error);
                uiManager.showToast('Screenshot failed - try again', 'error');
            }
        });
    }

    // Copy chart to clipboard button
    const copyChartBtn = document.getElementById('copyChartBtn');
    if (copyChartBtn) {
        copyChartBtn.addEventListener('click', async () => {
            try {
                const dataUrl = await chartManager.captureScreenshot();
                const success = await chartManager.copyScreenshotToClipboard(dataUrl);
                if (success) {
                    uiManager.showToast('Chart copied to clipboard!', 'success');
                } else {
                    uiManager.showToast('Copy failed - check browser permissions', 'error');
                }
            } catch (error) {
                console.error('Copy failed:', error);
                uiManager.showToast('Copy failed - try again', 'error');
            }
        });
    }

    // Strategy settings toggles
    [
        { toggleId: 'riskSettingsToggle', sectionId: 'riskSettings' },
        { toggleId: 'tradeFilterSettingsToggle', sectionId: 'tradeFilterSettings' },
        { toggleId: 'confirmationStrategiesToggle', sectionId: 'confirmationStrategies' }
    ].forEach(({ toggleId, sectionId }) => {
        const toggle = getRequiredElement<HTMLInputElement>(toggleId);
        const section = getRequiredElement<HTMLElement>(sectionId);
        const applyState = () => {
            section.classList.toggle('is-hidden', !toggle.checked);
        };

        toggle.addEventListener('change', applyState);
        applyState();
    });

    const riskModeSelect = getRequiredElement<HTMLSelectElement>('riskMode');
    const riskSimpleAdvanced = document.getElementById('riskSimpleAdvanced');
    const riskPercentage = document.getElementById('riskPercentage');
    const riskAdvanced = getRequiredElement<HTMLElement>('riskAdvanced');
    const riskAdvancedGroups = Array.from(riskAdvanced.querySelectorAll<HTMLElement>('.param-group'));
    const riskAdvancedInputs = Array.from(riskAdvanced.querySelectorAll<HTMLInputElement>('input'));

    const riskPercentageGroups = riskPercentage ? Array.from(riskPercentage.querySelectorAll<HTMLElement>('.param-group')) : [];
    const riskPercentageInputs = riskPercentage ? Array.from(riskPercentage.querySelectorAll<HTMLInputElement>('input')) : [];

    const applyRiskMode = () => {
        const mode = riskModeSelect.value;
        const isAdvanced = mode === 'advanced';
        const isPercentage = mode === 'percentage';
        const isSimpleOrAdvanced = mode === 'simple' || mode === 'advanced';

        if (riskSimpleAdvanced) {
            riskSimpleAdvanced.classList.toggle('is-hidden', !isSimpleOrAdvanced);
        }
        if (riskPercentage) {
            riskPercentage.classList.toggle('is-hidden', !isPercentage);
        }

        riskAdvanced.classList.toggle('is-hidden', !isAdvanced);
        riskAdvancedGroups.forEach(group => group.classList.toggle('is-disabled', !isAdvanced));
        riskAdvancedInputs.forEach(input => {
            input.disabled = !isAdvanced;
        });

        riskPercentageGroups.forEach(group => group.classList.toggle('is-disabled', !isPercentage));
        riskPercentageInputs.forEach(input => {
            input.disabled = !isPercentage;
        });
    };

    riskModeSelect.addEventListener('change', applyRiskMode);
    applyRiskMode();

    const strategyTimeframeToggle = getRequiredElement<HTMLInputElement>('strategyTimeframeToggle');
    const strategyTimeframeMinutes = getRequiredElement<HTMLInputElement>('strategyTimeframeMinutes');
    const strategyTimeframeMinutesGroup = document.getElementById('strategyTimeframeMinutesGroup');

    const applyStrategyTimeframeMode = () => {
        const enabled = strategyTimeframeToggle.checked;
        strategyTimeframeMinutes.disabled = !enabled;
        if (strategyTimeframeMinutesGroup) {
            strategyTimeframeMinutesGroup.classList.toggle('is-disabled', !enabled);
        }
    };

    strategyTimeframeToggle.addEventListener('change', applyStrategyTimeframeMode);
    applyStrategyTimeframeMode();

    const twoHourCloseParity = document.getElementById('twoHourCloseParity') as HTMLSelectElement | null;
    if (twoHourCloseParity) {
        const resolveParityMode = (value: string): 'odd' | 'even' | 'both' => {
            if (value === 'even' || value === 'both') return value;
            return 'odd';
        };

        let lastAppliedParity: 'odd' | 'even' | 'both' = resolveParityMode(twoHourCloseParity.value);
        twoHourCloseParity.addEventListener('change', () => {
            const nextParity: 'odd' | 'even' | 'both' = resolveParityMode(twoHourCloseParity.value);
            if (nextParity === lastAppliedParity) {
                return;
            }

            lastAppliedParity = nextParity;
            finderManager.clearTimeframeCache();
            scannerManager.clearCache();
            debugLogger.event('ui.settings.2h_close_parity', { parity: nextParity });

            // During startup/config bootstrap, settings can be applied before data is loaded.
            if (state.ohlcvData.length === 0) {
                return;
            }

            if (nextParity === 'both') {
                uiManager.showToast('2H parity compare mode enabled (odd + even). Run backtest to view both results.', 'info');
                return;
            }

            void dataManager.loadData(state.currentSymbol, state.currentInterval).then(() => {
                uiManager.showToast(`2H close parity set to ${nextParity}. Data reloaded.`, 'info');
            }).catch((error) => {
                console.error('Failed to reload data after parity change:', error);
                uiManager.showToast('Failed to reload data for new 2H parity.', 'error');
            });
        });
    }

    // Finder settings toggles
    [
        { toggleId: 'finderTradesToggle', sectionId: 'finderTradeFilters' }
    ].forEach(({ toggleId, sectionId }) => {
        const toggle = getRequiredElement<HTMLInputElement>(toggleId);
        const section = getRequiredElement<HTMLElement>(sectionId);
        const applyState = () => {
            section.classList.toggle('disabled', !toggle.checked);
        };

        toggle.addEventListener('change', applyState);
        applyState();
    });

    // Trade sizing mode toggle
    const fixedTradeToggle = getRequiredElement<HTMLInputElement>('fixedTradeToggle');
    const initialCapitalGroup = getRequiredElement<HTMLElement>('initialCapitalGroup');
    const fixedTradeGroup = getRequiredElement<HTMLElement>('fixedTradeGroup');
    const positionSizeGroup = getRequiredElement<HTMLElement>('positionSizeGroup');
    const initialCapitalInput = getRequiredElement<HTMLInputElement>('initialCapital');
    const fixedTradeAmountInput = getRequiredElement<HTMLInputElement>('fixedTradeAmount');
    const positionSizeInput = getRequiredElement<HTMLInputElement>('positionSize');

    const applyTradeSizingMode = () => {
        const useFixedAmount = fixedTradeToggle.checked;
        initialCapitalGroup.classList.toggle('is-hidden', useFixedAmount);
        fixedTradeGroup.classList.toggle('is-hidden', !useFixedAmount);
        positionSizeGroup.classList.toggle('is-hidden', useFixedAmount);

        initialCapitalInput.disabled = useFixedAmount;
        fixedTradeAmountInput.disabled = !useFixedAmount;
        positionSizeInput.disabled = useFixedAmount;
    };

    fixedTradeToggle.addEventListener('change', applyTradeSizingMode);
    applyTradeSizingMode();

    // Resizable panel
    const panel = getRequiredElement('strategyPanel');
    const handle = getRequiredElement('panelResizeHandle');
    let isResizing = false;

    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.classList.add('is-resizing');
        handle.classList.add('is-resizing');
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        // Calculate new width: viewport width - mouse X position
        const newWidth = window.innerWidth - e.clientX;
        const minWidth = 280;
        const maxWidth = window.innerWidth * 0.8;

        if (newWidth >= minWidth && newWidth <= maxWidth) {
            panel.style.width = `${newWidth}px`;
            // Trigger chart resize if needed
            state.chart.resize(0, 0);
            state.equityChart.resize(0, 0);
        }
    });

    window.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.classList.remove('is-resizing');
            handle.classList.remove('is-resizing');
            // Final chart sync
            window.dispatchEvent(new Event('resize'));
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') symbolDropdown.classList.remove('active');
        if (e.key === 'Enter' && e.ctrlKey) backtestService.runCurrentBacktest();

        // Alt + 1-9 for tab switching (uses data-shortcut attribute)
        if (e.altKey && e.key >= '1' && e.key <= '9') {
            e.preventDefault();
            const shortcut = e.key;
            const tab = document.querySelector(`.panel-tab[data-shortcut="${shortcut}"]`) as HTMLElement;
            if (tab) {
                tab.click();
                tab.focus();
                debugLogger.event('ui.shortcut.tab_switch', { shortcut, tab: tab.dataset.tab });
            }
        }
    });

}
