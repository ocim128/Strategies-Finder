import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    activateLazyFeature,
    attachLazyFeatureTrigger,
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
});
