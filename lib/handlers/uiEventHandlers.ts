import { getRequiredElement } from "../domUtils";
import { state } from "../state";
import { debugLogger } from "../debugLogger";

import { backtestService } from "../backtestService";
import { clearAll } from "../appActions";
import { uiManager } from "../uiManager";
import { chartManager } from "../chartManager";
import { binanceSearchService, BinanceSymbol } from "../binanceSearchService";

// Debounce helper for search input
function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): (...args: Parameters<T>) => void {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    return (...args: Parameters<T>) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

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

    let isSearchInitialized = false;
    let selectedIndex = -1;

    if (mockModelSelect) {
        mockModelSelect.value = state.mockChartModel;
        mockModelSelect.addEventListener('change', () => {
            const value = mockModelSelect.value;
            if (value === 'simple' || value === 'hard' || value === 'v3' || value === 'v4') {
                state.set('mockChartModel', value);
            }
        });
    }

    if (mockBarsInput) {
        const MIN_MOCK_BARS = 100;
        const MAX_MOCK_BARS = 30000000;

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
    const renderSearchResults = (symbols: BinanceSymbol[], query: string = '') => {
        if (!symbolSearchResults) return;

        // Clear existing results (except loading/empty states)
        const existingItems = symbolSearchResults.querySelectorAll('.symbol-search-item, .symbol-search-results-header');
        existingItems.forEach(item => item.remove());

        // Hide loading and empty states
        symbolSearchLoading?.classList.add('is-hidden');
        symbolSearchEmpty?.classList.add('is-hidden');

        if (symbols.length === 0) {
            symbolSearchEmpty?.classList.remove('is-hidden');
            return;
        }

        // Add header
        const header = document.createElement('div');
        header.className = 'symbol-search-results-header';
        header.textContent = query ? `Results for "${query}"` : 'Popular Pairs';
        symbolSearchResults.insertBefore(header, symbolSearchResults.firstChild);

        // Add result items
        symbols.forEach((symbol) => {
            const item = document.createElement('div');
            item.className = 'symbol-search-item';
            item.dataset.symbol = symbol.symbol;
            item.role = 'button';
            item.tabIndex = 0;

            // Mark active if current symbol matches
            if (symbol.symbol === state.currentSymbol) {
                item.classList.add('active');
            }

            // Get first 2-3 letters for icon
            const iconText = symbol.baseAsset.substring(0, 3);

            item.innerHTML = `
                <div class="symbol-item-icon">${iconText}</div>
                <div class="symbol-item-details">
                    <div class="symbol-item-name">
                        ${symbol.displayName}
                        <span class="symbol-item-badge crypto">Binance</span>
                    </div>
                    <div class="symbol-item-pair">${symbol.symbol}</div>
                </div>
            `;

            // Click handler
            item.addEventListener('click', () => selectSymbol(symbol.symbol, symbol.displayName));

            // Keyboard handler
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectSymbol(symbol.symbol, symbol.displayName);
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
            const results = await binanceSearchService.searchSymbols(query, 20);
            renderSearchResults(results, query);
        } catch (error) {
            console.error('Symbol search failed:', error);
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
            const popularPairs = await binanceSearchService.searchSymbols('', 20);
            renderSearchResults(popularPairs);
        } catch (error) {
            console.error('Failed to initialize symbol search:', error);
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

            // Update active state
            document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
            target.classList.add('active');

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
        { toggleId: 'entrySettingsToggle', sectionId: 'entrySettings' },
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

        // Alt + 1-6 for tab switching
        if (e.altKey && e.key >= '1' && e.key <= '6') {
            const index = parseInt(e.key) - 1;
            const tabs = document.querySelectorAll('.panel-tab');
            if (tabs[index]) {
                (tabs[index] as HTMLElement).click();
                debugLogger.event('ui.shortcut.tab_switch', { index });
            }
        }
    });

    // Combined strategy backtest runner
    window.addEventListener('run-combined-strategy', ((event: CustomEvent<{ strategyKey: string; definition: any; isPreview?: boolean }>) => {
        const { strategyKey, definition, isPreview } = event.detail;

        // The strategy has already been registered in combinerManager.ts
        // Now we need to set it as the current strategy and run the backtest

        // Update the current strategy key in state
        state.set('currentStrategyKey', strategyKey);

        // Update the strategy dropdown to reflect this selection
        uiManager.updateStrategyDropdown(strategyKey);

        // Log the action
        debugLogger.event('combiner.run', {
            strategyKey,
            strategyName: definition.name,
            isPreview: !!isPreview,
        });

        // Run the backtest
        backtestService.runCurrentBacktest();
    }) as EventListener);
}
