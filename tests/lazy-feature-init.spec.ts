import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    activateLazyFeature,
    attachLazyFeatureTrigger,
    attachTabLazyListener,
    isLazyFeatureInitialized,
    registerLazyFeature,
    resetLazyFeatureInitState,
} from "../lib/lazy-feature-init";

function waitForMicrotaskTurn(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Lazy feature init", () => {
    afterEach(() => {
        resetLazyFeatureInitState();
    });

    it("initializes a feature only once even with concurrent activation", async () => {
        let initCount = 0;
        registerLazyFeature("finder", async () => {
            initCount += 1;
            await waitForMicrotaskTurn();
        });

        await Promise.all([
            activateLazyFeature("finder"),
            activateLazyFeature("finder"),
            activateLazyFeature("finder"),
        ]);

        expect(initCount).to.equal(1);
        expect(isLazyFeatureInitialized("finder")).to.equal(true);
    });

    it("keeps a failed feature pending so it can retry cleanly", async () => {
        let initCount = 0;
        let shouldFail = true;
        const originalConsoleError = console.error;
        console.error = () => {};

        registerLazyFeature("debug-panel", async () => {
            initCount += 1;
            if (shouldFail) {
                throw new Error("boom");
            }
        });

        try {
            let error: unknown;
            try {
                await activateLazyFeature("debug-panel");
            } catch (caught) {
                error = caught;
            }

            expect(error).to.be.instanceOf(Error);
            expect(isLazyFeatureInitialized("debug-panel")).to.equal(false);

            shouldFail = false;
            await activateLazyFeature("debug-panel");

            expect(initCount).to.equal(2);
            expect(isLazyFeatureInitialized("debug-panel")).to.equal(true);
        } finally {
            console.error = originalConsoleError;
        }
    });

    it("activates from an explicit trigger only when the predicate passes", async () => {
        const target = new EventTarget();
        let initCount = 0;
        let afterActivateCount = 0;
        let allowActivation = false;

        registerLazyFeature("strategy-library-admin", () => {
            initCount += 1;
        });

        attachLazyFeatureTrigger<Event>({
            featureId: "strategy-library-admin",
            target,
            eventName: "toggle",
            shouldActivate: () => allowActivation,
            afterActivate: () => {
                afterActivateCount += 1;
            },
        });

        target.dispatchEvent(new Event("toggle"));
        await waitForMicrotaskTurn();
        expect(initCount).to.equal(0);
        expect(afterActivateCount).to.equal(0);

        allowActivation = true;
        target.dispatchEvent(new Event("toggle"));
        await waitForMicrotaskTurn();

        expect(initCount).to.equal(1);
        expect(afterActivateCount).to.equal(1);
        expect(isLazyFeatureInitialized("strategy-library-admin")).to.equal(true);
    });

    it("suppresses implicit tab-switch retries after an unsafe feature-callback failure", async () => {
        const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
        (globalThis as { window?: unknown }).window = new EventTarget();
        const originalConsoleError = console.error;
        console.error = () => {};

        try {
            let initCount = 0;
            let shouldFail = true;
            registerLazyFeature("finder", async () => {
                initCount += 1;
                if (shouldFail) {
                    throw new Error("boom");
                }
            });
            attachTabLazyListener();

            const switchToFinderTab = () => {
                window.dispatchEvent(
                    new CustomEvent("strategy-panel:tab-change", { detail: { tabId: "finder" } })
                );
            };

            switchToFinderTab();
            await waitForMicrotaskTurn();
            expect(initCount).to.equal(1);
            expect(isLazyFeatureInitialized("finder")).to.equal(false);

            // The callback failed after possible side effects, so tab
            // switches must not silently retry; Reload is the offered path.
            switchToFinderTab();
            await waitForMicrotaskTurn();
            expect(initCount).to.equal(1);

            // Direct programmatic activation keeps its retry contract.
            shouldFail = false;
            await activateLazyFeature("finder");
            expect(initCount).to.equal(2);
            expect(isLazyFeatureInitialized("finder")).to.equal(true);

            // Once initialized, tab switches are cheap no-ops again.
            switchToFinderTab();
            await waitForMicrotaskTurn();
            expect(initCount).to.equal(2);
        } finally {
            console.error = originalConsoleError;
            if (windowDescriptor) {
                Object.defineProperty(globalThis, "window", windowDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, "window");
            }
        }
    });
});
