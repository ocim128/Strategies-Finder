import { getRequiredElement } from "../domUtils";
import { state } from "../state";
import { debugLogger } from "../debugLogger";

import { backtestService } from "../backtestService";
import { clearAll } from "../appActions";
import { uiManager } from "../uiManager";
import { chartManager } from "../chartManager";

export function setupEventHandlers() {
    // Symbol dropdown
    const symbolSelector = getRequiredElement('symbolSelector');
    const symbolDropdown = getRequiredElement('symbolDropdown');

    symbolSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        symbolDropdown.classList.toggle('active');
    });

    symbolSelector.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            symbolDropdown.classList.toggle('active');
        }
    });

    document.addEventListener('click', () => {
        symbolDropdown.classList.remove('active');
    });

    document.querySelectorAll('#symbolDropdown .dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const target = e.currentTarget as HTMLElement;
            const symbol = target.dataset.symbol;
            if (!symbol) return;
            document.querySelectorAll('#symbolDropdown .dropdown-item').forEach(i => i.classList.remove('active'));
            target.classList.add('active');
            symbolDropdown.classList.remove('active');

            if (symbol !== state.currentSymbol) {
                debugLogger.event('ui.symbol.select', { symbol });
                state.set('currentSymbol', symbol);
            }
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
            const interval = (e.target as HTMLElement).dataset.interval!;
            document.querySelectorAll('.timeframe-tab').forEach(t => t.classList.remove('active'));
            (e.target as HTMLElement).classList.add('active');

            debugLogger.event('ui.interval.select', { interval });
            state.set('currentInterval', interval);
        });
    });

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
        { toggleId: 'regimeSettingsToggle', sectionId: 'regimeSettings' },
        { toggleId: 'entrySettingsToggle', sectionId: 'entrySettings' }
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
    const riskAdvanced = getRequiredElement<HTMLElement>('riskAdvanced');
    const riskAdvancedGroups = Array.from(riskAdvanced.querySelectorAll<HTMLElement>('.param-group'));
    const riskAdvancedInputs = Array.from(riskAdvanced.querySelectorAll<HTMLInputElement>('input'));
    const applyRiskMode = () => {
        const isAdvanced = riskModeSelect.value === 'advanced';
        riskAdvanced.classList.toggle('is-hidden', !isAdvanced);
        riskAdvancedGroups.forEach(group => group.classList.toggle('is-disabled', !isAdvanced));
        riskAdvancedInputs.forEach(input => {
            input.disabled = !isAdvanced;
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
