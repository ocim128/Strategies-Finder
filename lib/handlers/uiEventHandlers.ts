import { getRequiredElement } from "../domUtils";
import { state } from "../state";
import { debugLogger } from "../debugLogger";

import { backtestService } from "../backtestService";
import { clearAll } from "../appActions";

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
            const tabName = (e.target as HTMLElement).dataset.tab!;
            document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
            (e.target as HTMLElement).classList.add('active');

            getRequiredElement('settingsTab').style.display = tabName === 'settings' ? 'block' : 'none';
            getRequiredElement('finderTab').style.display = tabName === 'finder' ? 'block' : 'none';
            getRequiredElement('walkforwardTab').style.display = tabName === 'walkforward' ? 'block' : 'none';
            getRequiredElement('resultsTab').style.display = tabName === 'results' ? 'block' : 'none';
            getRequiredElement('tradesTab').style.display = tabName === 'trades' ? 'block' : 'none';
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

    // Zoom controls
    getRequiredElement('zoomInTool').addEventListener('click', () => {
        const range = state.chart.timeScale().getVisibleLogicalRange();
        if (range) {
            const center = (range.from + range.to) / 2;
            const newWidth = (range.to - range.from) * 0.7;
            state.chart.timeScale().setVisibleLogicalRange({ from: center - newWidth / 2, to: center + newWidth / 2 });
        }
    });

    getRequiredElement('zoomOutTool').addEventListener('click', () => {
        const range = state.chart.timeScale().getVisibleLogicalRange();
        if (range) {
            const center = (range.from + range.to) / 2;
            const newWidth = (range.to - range.from) * 1.4;
            state.chart.timeScale().setVisibleLogicalRange({ from: center - newWidth / 2, to: center + newWidth / 2 });
        }
    });

    getRequiredElement('fitTool').addEventListener('click', () => {
        state.chart.timeScale().fitContent();
        state.equityChart.timeScale().fitContent();
    });

    // Strategy settings toggles
    [
        { toggleId: 'riskSettingsToggle', sectionId: 'riskSettings' },
        { toggleId: 'regimeSettingsToggle', sectionId: 'regimeSettings' },
        { toggleId: 'entrySettingsToggle', sectionId: 'entrySettings' }
    ].forEach(({ toggleId, sectionId }) => {
        const toggle = getRequiredElement<HTMLInputElement>(toggleId);
        const section = getRequiredElement<HTMLElement>(sectionId);
        const applyState = () => {
            section.classList.toggle('disabled', !toggle.checked);
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
        initialCapitalGroup.classList.toggle('is-disabled', useFixedAmount);
        fixedTradeGroup.classList.toggle('is-disabled', !useFixedAmount);
        positionSizeGroup.classList.toggle('is-disabled', useFixedAmount);
        initialCapitalInput.disabled = useFixedAmount;
        fixedTradeAmountInput.disabled = !useFixedAmount;
        positionSizeInput.disabled = useFixedAmount;
    };

    fixedTradeToggle.addEventListener('change', applyTradeSizingMode);
    applyTradeSizingMode();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') symbolDropdown.classList.remove('active');
        if (e.key === 'Enter' && e.ctrlKey) backtestService.runCurrentBacktest();
    });
}
