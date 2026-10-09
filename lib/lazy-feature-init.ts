import { debugLogger } from "./debug-logger";
import {
    clearLazyTabStatus,
    ensureStrategyPanelTabMarkup,
    resetLazyTabStatusState,
    showLazyTabFailure,
    showLazyTabLoading,
    supportsLazyMarkupRetry,
} from "./strategy-panel-tab-markup";

type LazyFeatureInit = () => void | Promise<void>;
type LazyFeatureTriggerOptions<TEvent extends Event = Event> = {
    featureId: string;
    target: EventTarget;
    eventName: string;
    shouldActivate?: (event: TEvent) => boolean;
    afterActivate?: (event: TEvent) => void;
};

const pendingFeatures = new Map<string, LazyFeatureInit>();
const initializedFeatures = new Set<string>();
const inFlightFeatures = new Map<string, Promise<void>>();
let listenerAttached = false;
let tabLazyListener: EventListener | null = null;

const TAB_TO_FEATURE: Record<string, string> = {
    finder: "finder",
    alerts: "alerts",
    batchbacktest: "batch-backtest",
    opportunityexplorer: "asset-opportunity-explorer",
    walkforward: "walk-forward",
    montecarlo: "monte-carlo",
    datamining: "data-mining",
    ibkrdata: "ibkr-data",
    cryptodata: "crypto-data",
    rankpairs: "rank-pairs",
};

const FEATURE_TO_TAB: Record<string, string> = Object.fromEntries(
    Object.entries(TAB_TO_FEATURE).map(([tabId, featureId]) => [featureId, tabId])
);

export function registerLazyFeature(featureId: string, init: LazyFeatureInit): void {
    pendingFeatures.set(featureId, init);
}

// ---------------------------------------------------------------------------
// Tab-scoped activation feedback and recovery
//
// Markup failures (partial import rejected or invalid markup) happen before
// the feature callback runs, so retrying activation is safe and the tab
// offers a Retry action where a retry can fetch a fresh specifier (the dev
// server; production hashes chunks, so markup failures degrade to Reload
// there). A feature-callback failure may have left partial initialization
// behind; retrying is not uniformly safe, so the tab offers Reload only and
// implicit tab-switch retries are suppressed until then. Direct programmatic
// activation keeps its existing retry contract.
// ---------------------------------------------------------------------------

type TabFailureKind = "markup" | "init";

const tabFailureKinds = new Map<string, TabFailureKind>();

function reloadPage(): void {
    if (typeof window !== "undefined" && window.location) {
        window.location.reload();
    }
}

function beginTabLoading(tabId: string): void {
    tabFailureKinds.delete(tabId);
    showLazyTabLoading(tabId);
}

function finishTabActivation(tabId: string): void {
    tabFailureKinds.delete(tabId);
    clearLazyTabStatus(tabId);
}

function showTabActivationFailure(tabId: string, featureId: string, kind: TabFailureKind): void {
    tabFailureKinds.set(tabId, kind);
    // A markup failure is retryable only where a retry can fetch a fresh
    // specifier (the dev server's source URL). Production emits hashed
    // chunks, so there is nothing to re-fetch and Reload is the recovery.
    const canRetry = kind === "markup" && supportsLazyMarkupRetry();
    showLazyTabFailure(tabId, {
        message: canRetry
            ? "This tab could not be loaded. Check your connection, then retry or reload the page."
            : kind === "markup"
                ? "This tab could not be loaded. Reload the page to try again."
                : "This tab failed to finish setting up. Reload the page to try again.",
        canRetry,
        onRetry: canRetry
            ? () => {
                void activateLazyFeature(featureId).catch(() => {});
            }
            : undefined,
        onReload: reloadPage,
    });
}

export async function activateLazyFeature(featureId: string): Promise<void> {
    if (initializedFeatures.has(featureId)) return;

    const existing = inFlightFeatures.get(featureId);
    if (existing) {
        await existing;
        return;
    }

    const init = pendingFeatures.get(featureId);
    if (!init) return;

    const tabId = FEATURE_TO_TAB[featureId];
    if (tabId) {
        beginTabLoading(tabId);
    }

    let markupReady = false;
    const activation = Promise.resolve()
        .then(() => {
            return tabId ? ensureStrategyPanelTabMarkup(tabId) : undefined;
        })
        .then(() => {
            markupReady = true;
            return init();
        })
        .then(() => {
            initializedFeatures.add(featureId);
            pendingFeatures.delete(featureId);
            if (tabId) {
                finishTabActivation(tabId);
            }
        })
        .catch((error: unknown) => {
            debugLogger.error("lazy_feature.init_failed", {
                featureId,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
            console.error(`[LazyInit] Failed to initialize feature "${featureId}":`, error);
            if (tabId) {
                showTabActivationFailure(tabId, featureId, markupReady ? "init" : "markup");
            }
            throw error;
        })
        .finally(() => {
            inFlightFeatures.delete(featureId);
        });

    inFlightFeatures.set(featureId, activation);
    await activation;
}

export function attachLazyFeatureTrigger<TEvent extends Event = Event>({
    featureId,
    target,
    eventName,
    shouldActivate,
    afterActivate,
}: LazyFeatureTriggerOptions<TEvent>): void {
    target.addEventListener(eventName, (event: Event) => {
        const typedEvent = event as TEvent;
        if (shouldActivate && !shouldActivate(typedEvent)) {
            return;
        }

        void activateLazyFeature(featureId)
            .then(() => {
                afterActivate?.(typedEvent);
            })
            .catch(() => {});
    });
}

export function attachTabLazyListener(): void {
    if (listenerAttached) return;
    listenerAttached = true;
    tabLazyListener = ((event: CustomEvent<{ tabId: string }>) => {
        const tabId = event.detail.tabId;
        const featureId = TAB_TO_FEATURE[tabId];
        if (!featureId) {
            return;
        }
        // After an unsafe feature-callback failure the tab offers Reload as
        // the only recovery; implicit tab switches must not silently retry.
        if (tabFailureKinds.get(tabId) === "init") {
            return;
        }
        void activateLazyFeature(featureId).catch(() => {});
    }) as EventListener;
    window.addEventListener("strategy-panel:tab-change", tabLazyListener);
}

export function isLazyFeatureInitialized(featureId: string): boolean {
    return initializedFeatures.has(featureId);
}

export function resetLazyFeatureInitState(): void {
    if (tabLazyListener && typeof window !== "undefined") {
        window.removeEventListener("strategy-panel:tab-change", tabLazyListener);
    }
    pendingFeatures.clear();
    initializedFeatures.clear();
    inFlightFeatures.clear();
    tabFailureKinds.clear();
    resetLazyTabStatusState();
    tabLazyListener = null;
    listenerAttached = false;
}
