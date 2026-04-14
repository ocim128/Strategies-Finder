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

const TAB_TO_FEATURE: Record<string, string> = {
    finder: "finder",
    hunt: "hunt",
    walkforward: "walk-forward",
    montecarlo: "monte-carlo",
    portfolio: "portfolio-lab",
    ensemble: "strategy-ensemble",
    polymarket: "polymarket-panel",
    datamining: "data-mining",
};

export function registerLazyFeature(featureId: string, init: LazyFeatureInit): void {
    pendingFeatures.set(featureId, init);
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

    const activation = Promise.resolve()
        .then(() => init())
        .then(() => {
            initializedFeatures.add(featureId);
            pendingFeatures.delete(featureId);
        })
        .catch((error: unknown) => {
            console.error(`[LazyInit] Failed to initialize feature "${featureId}":`, error);
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
    window.addEventListener("strategy-panel:tab-change", ((event: CustomEvent<{ tabId: string }>) => {
        const featureId = TAB_TO_FEATURE[event.detail.tabId];
        if (featureId) {
            void activateLazyFeature(featureId).catch(() => {});
        }
    }) as EventListener);
}

export function isLazyFeatureInitialized(featureId: string): boolean {
    return initializedFeatures.has(featureId);
}

export function resetLazyFeatureInitState(): void {
    pendingFeatures.clear();
    initializedFeatures.clear();
    inFlightFeatures.clear();
    listenerAttached = false;
}
