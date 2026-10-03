import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearDomElementCache } from "../lib/dom-utils";
import { setupSettingsHandlers } from "../lib/handlers/settings-handlers";
import { DEFAULT_BACKTEST_SETTINGS, settingsManager, type StrategyConfig } from "../lib/settings-manager";
import { uiManager } from "../lib/ui-manager";
import { createFakeElement } from "./helpers/fake-element";

function withDeleteHarness(run: (harness: {
    select: ReturnType<typeof createFakeElement>;
    deleteButton: ReturnType<typeof createFakeElement>;
    toasts: Array<{ message: string; type: string }>;
    events: string[];
    failWrites(error: DOMException | null): void;
    confirmDeletion(confirmed: boolean): void;
}) => void): void {
    const globals = ["document", "window", "localStorage", "confirm"] as const;
    const descriptors = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const originalToast = uiManager.showToast;
    const select = createFakeElement();
    const deleteButton = createFakeElement();
    // Replacing a select's options resets its value to the placeholder.
    const replaceChildren = select.replaceChildren;
    select.replaceChildren = (...children) => {
        replaceChildren.call(select, ...children);
        select.value = "";
    };
    const elements = new Map([["configSelect", select], ["deleteConfigBtn", deleteButton]]);
    const store = new Map<string, string>();
    const toasts: Array<{ message: string; type: string }> = [];
    const events: string[] = [];
    let writeError: DOMException | null = null;
    let confirmed = true;
    const replacements = {
        document: {
            getElementById: (id: string) => elements.get(id) ?? null,
            createElement: () => createFakeElement(),
            createDocumentFragment: () => createFakeElement(),
        },
        window: {
            location: { href: "http://localhost/" },
            dispatchEvent: (event: Event) => { events.push(event.type); return true; },
        },
        localStorage: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => {
                if (writeError) throw writeError;
                store.set(key, value);
            },
        },
        confirm: () => confirmed,
    };
    for (const key of globals) {
        Object.defineProperty(globalThis, key, { configurable: true, value: replacements[key] });
    }
    uiManager.showToast = (message, type = "info") => { toasts.push({ message, type }); };
    clearDomElementCache();
    try {
        const config: StrategyConfig = {
            name: "Saved setup", strategyKey: "test", strategyParams: {},
            backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
            createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z",
        };
        settingsManager.upsertStrategyConfig(config);
        settingsManager.upsertStrategyConfig({ ...config, name: "Other setup" });
        setupSettingsHandlers();
        select.value = config.name;
        select.dispatchEvent({ type: "change" });
        run({
            select, deleteButton, toasts, events,
            failWrites: error => { writeError = error; },
            confirmDeletion: value => { confirmed = value; },
        });
    } finally {
        uiManager.showToast = originalToast;
        globals.forEach((key, index) => {
            const descriptor = descriptors[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
        clearDomElementCache();
    }
}

describe("Settings configuration deletion feedback", () => {
    for (const errorName of ["QuotaExceededError", "SecurityError"]) {
        it(`reports ${errorName} without claiming deletion, then permits a successful retry`, () => {
            withDeleteHarness(({ select, deleteButton, toasts, events, failWrites }) => {
                failWrites(new DOMException("Storage write rejected", errorName));
                const options = select.children;
                deleteButton.click();
                assert.deepEqual(toasts, [{ message: 'Failed to delete configuration "Saved setup"', type: "error" }]);
                assert.deepEqual(events, []);
                assert.equal(select.children, options, "failed deletion must not refresh the dropdown");
                assert.equal(select.value, "Saved setup");
                assert.equal(deleteButton.disabled, false);
                assert.deepEqual(settingsManager.loadAllStrategyConfigs().map(config => config.name), ["Saved setup", "Other setup"]);

                failWrites(null);
                deleteButton.click();
                assert.deepEqual(toasts.at(-1), { message: 'Configuration "Saved setup" deleted', type: "info" });
                assert.deepEqual(events, ["strategy-configs:changed"]);
                assert.deepEqual(settingsManager.loadAllStrategyConfigs().map(config => config.name), ["Other setup"]);
                assert.equal(select.value, "");
                assert.equal(deleteButton.disabled, true);
            });
        });
    }

    it("leaves the saved configuration untouched when confirmation is cancelled", () => {
        withDeleteHarness(({ select, deleteButton, toasts, events, confirmDeletion }) => {
            confirmDeletion(false);
            deleteButton.click();
            assert.deepEqual(toasts, []);
            assert.deepEqual(events, []);
            assert.equal(select.value, "Saved setup");
            assert.notEqual(settingsManager.loadStrategyConfig("Saved setup"), null);
        });
    });

    it("reports failure if the selected configuration disappeared before the click", () => {
        withDeleteHarness(({ deleteButton, toasts, events }) => {
            assert.equal(settingsManager.deleteStrategyConfig("Saved setup"), true);
            deleteButton.click();
            assert.deepEqual(toasts, [{ message: 'Failed to delete configuration "Saved setup"', type: "error" }]);
            assert.deepEqual(events, []);
        });
    });
});
