import headerHtml from '../html-partials/header.html?raw';
import toolbarHtml from '../html-partials/toolbar.html?raw';
import chartWrapperHtml from '../html-partials/chart-wrapper.html?raw';
import livePositionsHtml from '../html-partials/live-positions.html?raw';
import strategyPanelShellHtml from '../html-partials/strategy-panel-shell.html?raw';
import tabSettingsStartHtml from '../html-partials/tab-settings-start.html?raw';
import tabSettingsSectionCoreHtml from '../html-partials/tab-settings-section-core.html?raw';
import tabSettingsSectionExecutionHtml from '../html-partials/tab-settings-section-execution.html?raw';

import tabSettingsEndHtml from '../html-partials/tab-settings-end.html?raw';

import tabResultsHtml from '../html-partials/tab-results.html?raw';
import tabTradesHtml from '../html-partials/tab-trades.html?raw';

import statusBarHtml from '../html-partials/status-bar.html?raw';
import debugPanelHtml from '../html-partials/debug-panel.html?raw';
import { debugLogger } from './debug-logger';
import codeEditorHtml from '../html-partials/code-editor.html?raw';
import { appendLazyStrategyPanelTabPlaceholders } from './strategy-panel-tab-markup';

const MAIN_CONTENT_PARTIALS = [
    toolbarHtml,
    livePositionsHtml,
] as const;

const SETTINGS_TAB_HTML = [
    tabSettingsStartHtml,
    tabSettingsSectionCoreHtml,
    tabSettingsSectionExecutionHtml,
    tabSettingsEndHtml,
].join('');

const EAGER_STRATEGY_PANEL_TAB_PARTIALS = [
    SETTINGS_TAB_HTML,
    tabResultsHtml,
    tabTradesHtml,
] as const;

const ROOT_OVERLAY_PARTIALS = [
    debugPanelHtml,
    codeEditorHtml,
] as const;

function appendMarkup(target: Element, partials: readonly string[]): void {
    for (const partial of partials) {
        target.insertAdjacentHTML('beforeend', partial);
    }
}

/**
 * Injects the extracted HTML layout into the DOM.
 * This reconstructs the original index.html structure using the partials.
 */
export function injectLayout() {
    const root = document.getElementById('root');
    if (!root) {
        debugLogger.error("layout.root_missing");
        return;
    }

    // Ensure root and body have full height for the layout to work
    document.documentElement.style.height = '100%';
    document.body.style.height = '100%';
    document.body.style.margin = '0';
    root.style.height = '100%';
    root.style.width = '100%';

    // 1. App Container
    const appContainer = document.createElement('div');
    appContainer.className = 'app-container';

    // 2. Header
    appendMarkup(appContainer, [headerHtml]);

    // 3. Main Content (Toolbar + Chart Area)
    const mainContent = document.createElement('main');
    mainContent.className = 'main-content';
    mainContent.id = 'mainContent';

    appendMarkup(mainContent, MAIN_CONTENT_PARTIALS);

    // Chart Area
    const chartArea = document.createElement('div');
    chartArea.className = 'chart-area';

    // Chart Wrapper
    chartArea.insertAdjacentHTML('beforeend', chartWrapperHtml);

    // Strategy Panel
    // Create the panel shell
    const strategyPanelContainer = document.createElement('div');
    strategyPanelContainer.innerHTML = strategyPanelShellHtml;
    // The shell contains <div class="strategy-panel">...</div> as first child.
    const strategyPanelElement = strategyPanelContainer.firstElementChild;

    if (strategyPanelElement) {
        // Find the #panelContent container to inject tabs
        const panelContentElement = strategyPanelElement.querySelector('#panelContent');
        if (panelContentElement) {
            appendMarkup(panelContentElement, EAGER_STRATEGY_PANEL_TAB_PARTIALS);
            appendLazyStrategyPanelTabPlaceholders(panelContentElement);
        }
        chartArea.appendChild(strategyPanelElement);
    }

    mainContent.appendChild(chartArea);
    appContainer.appendChild(mainContent);

    // 4. Status Bar
    appendMarkup(appContainer, [statusBarHtml]);

    // Append App Container to Root
    root.appendChild(appContainer);

    // 5. Debug Panel and Code Editor (Siblings to app-container)
    // We append them to root as well, assuming root acts like the body context
    appendMarkup(root, ROOT_OVERLAY_PARTIALS);

    // Move modal-overlay to body direct child if needed for z-index, 
    // but usually root is fine if z-index is high enough.
    // The original structure was body > modal-overlay. 
    // root > modal-overlay should be fine given standard CSS reset.
}
