import headerHtml from '../html-partials/header.html?raw';
import toolbarHtml from '../html-partials/toolbar.html?raw';
import chartWrapperHtml from '../html-partials/chart-wrapper.html?raw';
import strategyPanelShellHtml from '../html-partials/strategy-panel-shell.html?raw';
import tabSettingsHtml from '../html-partials/tab-settings.html?raw';
import tabFinderHtml from '../html-partials/tab-finder.html?raw';
import tabCombinerHtml from '../html-partials/tab-combiner.html?raw';
import tabWalkforwardHtml from '../html-partials/tab-walkforward.html?raw';
import tabMontecarloHtml from '../html-partials/tab-montecarlo.html?raw';
import tabReplayHtml from '../html-partials/tab-replay.html?raw';
import tabResultsHtml from '../html-partials/tab-results.html?raw';
import tabTradesHtml from '../html-partials/tab-trades.html?raw';
import statusBarHtml from '../html-partials/status-bar.html?raw';
import debugPanelHtml from '../html-partials/debug-panel.html?raw';
import codeEditorHtml from '../html-partials/code-editor.html?raw';

/**
 * Injects the extracted HTML layout into the DOM.
 * This reconstructs the original index.html structure using the partials.
 */
export function injectLayout() {
    const root = document.getElementById('root');
    if (!root) {
        console.error("Root element not found! Layout injection failed.");
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
    appContainer.insertAdjacentHTML('beforeend', headerHtml);

    // 3. Main Content (Toolbar + Chart Area)
    const mainContent = document.createElement('div');
    mainContent.className = 'main-content';

    // Toolbar
    mainContent.insertAdjacentHTML('beforeend', toolbarHtml);

    // Chart Area
    const chartArea = document.createElement('div');
    chartArea.className = 'chart-area';

    // Chart Wrapper
    chartArea.insertAdjacentHTML('beforeend', chartWrapperHtml);

    // Strategy Panel
    // First, combine the tabs content
    const tabsContent =
        tabSettingsHtml +
        tabFinderHtml +
        tabCombinerHtml +
        tabWalkforwardHtml +
        tabMontecarloHtml +
        tabReplayHtml +
        tabResultsHtml +
        tabTradesHtml;

    // Create the panel shell
    const strategyPanelContainer = document.createElement('div');
    strategyPanelContainer.innerHTML = strategyPanelShellHtml;
    // The shell contains <div class="strategy-panel">...</div> as first child.
    const strategyPanelElement = strategyPanelContainer.firstElementChild;

    if (strategyPanelElement) {
        // Find the #panelContent container to inject tabs
        const panelContentElement = strategyPanelElement.querySelector('#panelContent');
        if (panelContentElement) {
            panelContentElement.innerHTML = tabsContent;
        }
        chartArea.appendChild(strategyPanelElement);
    }

    mainContent.appendChild(chartArea);
    appContainer.appendChild(mainContent);

    // 4. Status Bar
    appContainer.insertAdjacentHTML('beforeend', statusBarHtml);

    // Append App Container to Root
    root.appendChild(appContainer);

    // 5. Debug Panel and Code Editor (Siblings to app-container)
    // We append them to root as well, assuming root acts like the body context
    root.insertAdjacentHTML('beforeend', debugPanelHtml);
    root.insertAdjacentHTML('beforeend', codeEditorHtml);

    // Move modal-overlay to body direct child if needed for z-index, 
    // but usually root is fine if z-index is high enough.
    // The original structure was body > modal-overlay. 
    // root > modal-overlay should be fine given standard CSS reset.
}
