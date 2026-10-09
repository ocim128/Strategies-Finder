import { debugLogger } from './debug-logger';
import { bindFormAccessibility } from './form-accessibility';

const LAZY_STRATEGY_PANEL_TAB_LOADERS = {
    finder: () => import('../html-partials/tab-finder.html?raw'),
    alerts: () => import('../html-partials/tab-alerts.html?raw'),
    datamining: () => import('../html-partials/tab-datamining.html?raw'),
    ibkrdata: () => import('../html-partials/tab-ibkr-data.html?raw'),
    cryptodata: () => import('../html-partials/tab-crypto-data.html?raw'),
    batchbacktest: () => import('../html-partials/tab-batch-backtest.html?raw'),
    opportunityexplorer: () => import('../html-partials/tab-asset-opportunity-explorer.html?raw'),
    walkforward: () => import('../html-partials/tab-walkforward.html?raw'),
    montecarlo: () => import('../html-partials/tab-monte-carlo.html?raw'),
    rankpairs: () => import('../html-partials/tab-rank-pairs.html?raw'),
} as const;

/**
 * Canonical list of lazy-loaded strategy panel tab ids. Each entry must have:
 *   - a runtime placeholder `<div id="${tabId}Tab">` injected by
 *     `appendLazyStrategyPanelTabPlaceholders`, and
 *   - a matching `#${tabId}Tab` root in its `LAZY_STRATEGY_PANEL_TAB_LOADERS`
 *     partial, so `ensureStrategyPanelTabMarkup` can swap placeholder -> content.
 * Exposed as a readonly array (not the loader map) to avoid carrying the
 * `?raw` import side effects into test/consumer modules.
 */
export const LAZY_STRATEGY_PANEL_TAB_IDS: readonly string[] = Object.freeze(
    Object.keys(LAZY_STRATEGY_PANEL_TAB_LOADERS)
);

type LazyStrategyPanelTabId = keyof typeof LAZY_STRATEGY_PANEL_TAB_LOADERS;

function isLazyStrategyPanelTabId(tabId: string): tabId is LazyStrategyPanelTabId {
    return Object.prototype.hasOwnProperty.call(LAZY_STRATEGY_PANEL_TAB_LOADERS, tabId);
}

// Partial file names (without extension) used to build cache-busted retry
// imports. `Record<LazyStrategyPanelTabId, string>` makes the type system
// keep these keys in sync with LAZY_STRATEGY_PANEL_TAB_LOADERS.
const LAZY_STRATEGY_PANEL_TAB_PARTIAL_FILES: Record<LazyStrategyPanelTabId, string> = {
    finder: 'tab-finder',
    alerts: 'tab-alerts',
    datamining: 'tab-datamining',
    ibkrdata: 'tab-ibkr-data',
    cryptodata: 'tab-crypto-data',
    batchbacktest: 'tab-batch-backtest',
    opportunityexplorer: 'tab-asset-opportunity-explorer',
    walkforward: 'tab-walkforward',
    montecarlo: 'tab-monte-carlo',
    rankpairs: 'tab-rank-pairs',
};

// Failed import count per tab. Per the HTML module map, a dynamic import that
// fails to fetch stays rejected for the document's lifetime, so a Retry that
// repeats the same specifier can never succeed: retries must fetch a fresh
// specifier instead.
const tabMarkupImportFailures = new Map<string, number>();

type ViteImportEnv = { env?: { DEV?: boolean; BASE_URL?: string } };
const viteEnv = (import.meta as ViteImportEnv).env;

/**
 * Whether a failed tab-markup import can be retried in this build. The retry
 * re-fetches the dev server's source URL with a fresh query; production emits
 * hashed chunks under assets/, so there is no source URL to re-fetch and
 * Reload is the only recovery there. A missing Vite env (plain esbuild test
 * bundles) behaves like development, which is what those bundles exercise.
 */
export function supportsLazyMarkupRetry(): boolean {
    return viteEnv ? Boolean(viteEnv.DEV) : true;
}

async function loadTabMarkupModule(tabId: LazyStrategyPanelTabId): Promise<{ default: string }> {
    const failedAttempts = tabMarkupImportFailures.get(tabId) ?? 0;
    if (failedAttempts === 0 || !supportsLazyMarkupRetry()) {
        // Production (and the first dev attempt) uses the build-time import;
        // in production a failed chunk keeps failing until the page reloads.
        return LAZY_STRATEGY_PANEL_TAB_LOADERS[tabId]();
    }
    // Dev-only recovery: the static import above is resolved at build time,
    // so this runtime import only executes after a dev-server outage. The
    // query bump forces the browser past its failed-module cache entry. Two
    // Vite interactions shape this URL:
    //  - resolve against the Vite base, deliberately NOT
    //    `new URL(x, import.meta.url)`, which Vite's asset plugin rewrites
    //    into a glob and breaks for runtime-computed specifiers;
    //  - the query is built by hand because the bare `raw` flag triggers
    //    Vite's raw module handling, while URLSearchParams would re-serialize
    //    it as `raw=` (an empty value), which Vite strips.
    const partialFile = LAZY_STRATEGY_PANEL_TAB_PARTIAL_FILES[tabId];
    const base = viteEnv?.BASE_URL ?? "/";
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    const retryUrl = `${window.location.origin}${normalizedBase}html-partials/${partialFile}.html?raw&lazyRetry=${failedAttempts}`;
    return import(/* @vite-ignore */ retryUrl) as Promise<{ default: string }>;
}

export function appendLazyStrategyPanelTabPlaceholders(target: Element): void {
    for (const tabId of Object.keys(LAZY_STRATEGY_PANEL_TAB_LOADERS)) {
        target.insertAdjacentHTML('beforeend', `<div id="${tabId}Tab" data-lazy-tab="${tabId}"></div>`);
    }
}

// ---------------------------------------------------------------------------
// Lazy-tab activation feedback
//
// One status host per tab, addressed by class/data selectors (no per-tab ids).
// The host is created on demand inside the tab panel and is preserved across
// the placeholder -> content swap in ensureStrategyPanelTabMarkup so loading
// feedback stays visible until the feature initializer settles. Only a
// successful activation removes the host.
// ---------------------------------------------------------------------------

export type LazyTabFailureOptions = {
    /** Concise, user-actionable message; never raw exception text. */
    message: string;
    canRetry: boolean;
    onRetry?: () => void;
    onReload: () => void;
};

const tabStatusHosts = new Map<string, HTMLElement>();

function getTabPanel(tabId: string): HTMLElement | null {
    if (typeof document === 'undefined') {
        return null;
    }
    return document.getElementById(`${tabId}Tab`);
}

function getOrCreateStatusHost(tabId: string, panel: HTMLElement): HTMLElement {
    let host = tabStatusHosts.get(tabId);
    if (!host) {
        host = document.createElement('div');
        host.className = 'lazy-tab-status';
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        tabStatusHosts.set(tabId, host);
    }
    if (host.parentNode !== panel) {
        panel.appendChild(host);
    }
    return host;
}

export function showLazyTabLoading(tabId: string): void {
    const panel = getTabPanel(tabId);
    if (!panel) return;

    panel.setAttribute('aria-busy', 'true');
    const host = getOrCreateStatusHost(tabId, panel);
    host.setAttribute('data-lazy-tab-status', 'loading');

    const message = document.createElement('p');
    message.className = 'lazy-tab-status-message';
    message.textContent = 'Loading this tab…';
    host.replaceChildren(message);
}

export function showLazyTabFailure(tabId: string, options: LazyTabFailureOptions): void {
    const panel = getTabPanel(tabId);
    if (!panel) return;

    // Activation settled; the tab is no longer busy.
    panel.removeAttribute('aria-busy');
    const host = getOrCreateStatusHost(tabId, panel);
    host.setAttribute('data-lazy-tab-status', 'failure');

    const message = document.createElement('p');
    message.className = 'lazy-tab-status-message';
    message.textContent = options.message;

    const actions = document.createElement('div');
    actions.className = 'lazy-tab-status-actions';

    if (options.canRetry && options.onRetry) {
        const retryButton = document.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'btn btn-secondary lazy-tab-status-retry';
        retryButton.setAttribute('data-lazy-tab-retry', '');
        retryButton.textContent = 'Retry';
        retryButton.addEventListener('click', () => {
            // One retry per click; the activation replaces this feedback with
            // the loading state, so the button stays disabled until then.
            retryButton.disabled = true;
            options.onRetry!();
        });
        actions.appendChild(retryButton);
    }

    const reloadButton = document.createElement('button');
    reloadButton.type = 'button';
    reloadButton.className = 'btn btn-secondary lazy-tab-status-reload';
    reloadButton.setAttribute('data-lazy-tab-reload', '');
    reloadButton.textContent = 'Reload page';
    reloadButton.addEventListener('click', () => {
        options.onReload();
    });
    actions.appendChild(reloadButton);

    host.replaceChildren(message, actions);
}

export function clearLazyTabStatus(tabId: string): void {
    const panel = getTabPanel(tabId);
    panel?.removeAttribute('aria-busy');

    const host = tabStatusHosts.get(tabId);
    if (host) {
        host.remove();
        tabStatusHosts.delete(tabId);
    }
}

/** Drops all tab feedback; called by resetLazyFeatureInitState. */
export function resetLazyTabStatusState(): void {
    for (const tabId of [...tabStatusHosts.keys()]) {
        clearLazyTabStatus(tabId);
    }
    tabMarkupImportFailures.clear();
}

export async function ensureStrategyPanelTabMarkup(tabId: string): Promise<void> {
    if (typeof document === 'undefined' || !isLazyStrategyPanelTabId(tabId)) {
        return;
    }

    const panel = document.getElementById(`${tabId}Tab`);
    if (!panel || panel.dataset.lazyMarkupLoaded === 'true') {
        return;
    }

    let module: { default: string };
    try {
        module = await loadTabMarkupModule(tabId);
    } catch (error) {
        // Bump before rethrowing so the next attempt fetches a fresh
        // specifier instead of the module map's failed entry.
        tabMarkupImportFailures.set(tabId, (tabMarkupImportFailures.get(tabId) ?? 0) + 1);
        throw error;
    }
    const template = document.createElement('template');
    template.innerHTML = module.default.trim();
    const loadedPanel = template.content.querySelector<HTMLElement>(`#${tabId}Tab`);
    if (!loadedPanel) {
        // Missing/invalid markup is an activation failure: continuing into
        // feature initialization would bind the feature against empty DOM.
        debugLogger.error('layout.lazy_tab_missing_root', { tabId });
        throw new Error(`Lazy tab "${tabId}" markup is missing its #${tabId}Tab root`);
    }

    const runtimeHidden = panel.hidden;
    const runtimeDisplay = panel.style.display;
    // Preserve the activation feedback host across the swap so loading state
    // stays visible until the feature initializer settles.
    const statusHost = tabStatusHosts.get(tabId) ?? null;

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
    if (statusHost) {
        panel.appendChild(statusHost);
    }
    bindFormAccessibility(panel);

    window.dispatchEvent(new CustomEvent('strategy-panel:tab-markup-loaded', {
        detail: { tabId },
    }));
}
