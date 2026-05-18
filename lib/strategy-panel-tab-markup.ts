import { debugLogger } from './debug-logger';
import { bindFormAccessibility } from './form-accessibility';

const LAZY_STRATEGY_PANEL_TAB_LOADERS = {
    datamining: () => import('../html-partials/tab-datamining.html?raw'),
    hunt: () => import('../html-partials/tab-hunt.html?raw'),
    polymarket: () => import('../html-partials/tab-polymarket.html?raw'),
    executionlab: () => import('../html-partials/tab-execution-lab.html?raw'),
    walkforward: () => import('../html-partials/tab-walkforward.html?raw'),
    montecarlo: () => import('../html-partials/tab-monte-carlo.html?raw'),
    portfolio: () => import('../html-partials/tab-portfolio.html?raw'),
    ensemble: () => import('../html-partials/tab-ensemble.html?raw'),
} as const;

type LazyStrategyPanelTabId = keyof typeof LAZY_STRATEGY_PANEL_TAB_LOADERS;

function isLazyStrategyPanelTabId(tabId: string): tabId is LazyStrategyPanelTabId {
    return Object.prototype.hasOwnProperty.call(LAZY_STRATEGY_PANEL_TAB_LOADERS, tabId);
}

export function appendLazyStrategyPanelTabPlaceholders(target: Element): void {
    for (const tabId of Object.keys(LAZY_STRATEGY_PANEL_TAB_LOADERS)) {
        target.insertAdjacentHTML('beforeend', `<div id="${tabId}Tab" data-lazy-tab="${tabId}"></div>`);
    }
}

export async function ensureStrategyPanelTabMarkup(tabId: string): Promise<void> {
    if (typeof document === 'undefined' || !isLazyStrategyPanelTabId(tabId)) {
        return;
    }

    const panel = document.getElementById(`${tabId}Tab`);
    if (!panel || panel.dataset.lazyMarkupLoaded === 'true') {
        return;
    }

    const module = await LAZY_STRATEGY_PANEL_TAB_LOADERS[tabId]();
    const template = document.createElement('template');
    template.innerHTML = module.default.trim();
    const loadedPanel = template.content.querySelector<HTMLElement>(`#${tabId}Tab`);
    if (!loadedPanel) {
        debugLogger.error('layout.lazy_tab_missing_root', { tabId });
        return;
    }

    const runtimeHidden = panel.hidden;
    const runtimeDisplay = panel.style.display;

    panel.replaceChildren(...Array.from(loadedPanel.childNodes));
    panel.className = loadedPanel.className;
    for (const attribute of Array.from(loadedPanel.attributes)) {
        if (attribute.name === 'id' || attribute.name === 'class' || attribute.name === 'style') {
            continue;
        }
        panel.setAttribute(attribute.name, attribute.value);
    }
    panel.hidden = runtimeHidden;
    panel.style.display = runtimeDisplay;
    panel.dataset.lazyMarkupLoaded = 'true';
    bindFormAccessibility(panel);

    window.dispatchEvent(new CustomEvent('strategy-panel:tab-markup-loaded', {
        detail: { tabId },
    }));
}
