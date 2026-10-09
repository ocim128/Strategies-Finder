import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setupSettingsHandlers, updateConfigDropdown } from "../lib/handlers/settings-handlers";
import { DEFAULT_BACKTEST_SETTINGS, settingsManager, type StrategyConfig } from "../lib/settings-manager";
import { uiManager } from "../lib/ui-manager";
import { createFakeElement } from "./helpers/fake-element";

function withDeleteHarness(run: (harness: {
    select: ReturnType<typeof createFakeElement>;
    deleteButton: ReturnType<typeof createFakeElement>;
    bulkList: ReturnType<typeof createFakeElement>;
    selectAll: ReturnType<typeof createFakeElement> & { indeterminate?: boolean };
    bulkDeleteButton: ReturnType<typeof createFakeElement>;
    selectionCount: ReturnType<typeof createFakeElement>;
    checkboxes(): ReturnType<typeof createFakeElement>[];
    writeCount(): number;
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
    const bulkList = createFakeElement();
    const selectAll = createFakeElement();
    const bulkDeleteButton = createFakeElement();
    const selectionCount = createFakeElement();
    const checkboxes = () => ((bulkList.children[0] as ReturnType<typeof createFakeElement> | undefined)?.children ?? [])
        .flatMap(child => (child as ReturnType<typeof createFakeElement>).children.slice(0, 1)) as ReturnType<typeof createFakeElement>[];
    bulkList.querySelectorAll = checkboxes as typeof bulkList.querySelectorAll;
    // Replacing a select's options resets its value to the placeholder.
    const replaceChildren = select.replaceChildren;
    select.replaceChildren = (...children) => {
        replaceChildren.call(select, ...children);
        select.value = "";
    };
    const elements = new Map([
        ["configSelect", select], ["deleteConfigBtn", deleteButton], ["bulkConfigList", bulkList],
        ["selectAllConfigs", selectAll], ["deleteSelectedConfigsBtn", bulkDeleteButton], ["bulkConfigSelectionCount", selectionCount],
    ]);
    const store = new Map<string, string>();
    const toasts: Array<{ message: string; type: string }> = [];
    const events: string[] = [];
    let writeError: DOMException | null = null;
    let confirmed = true;
    let writes = 0;
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
                writes += 1;
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
            select, deleteButton, bulkList, selectAll, bulkDeleteButton, selectionCount, checkboxes, toasts, events,
            writeCount: () => writes,
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

describe("Settings bulk configuration deletion", () => {
    it("Shift-click selects and clears ranges in both directions and preserves the anchor on refresh", () => {
        withDeleteHarness(({ checkboxes, selectionCount, selectAll }) => {
            const config = settingsManager.loadAllStrategyConfigs()[0];
            for (const name of ['Third setup', 'Fourth setup']) settingsManager.upsertStrategyConfig({ ...config, name });
            updateConfigDropdown();
            const click = (index: number, shiftKey = false) => {
                const input = checkboxes()[index];
                input.checked = !input.checked;
                input.dispatchEvent({ type: 'click', shiftKey });
            };
            click(0);
            updateConfigDropdown();
            click(2, true);
            assert.deepEqual(checkboxes().map(input => input.checked), [true, true, true, false]);
            assert.equal(selectionCount.textContent, '3 selected');
            assert.equal(selectAll.indeterminate, true);
            click(0, true);
            assert.deepEqual(checkboxes().map(input => input.checked), [false, false, false, false]);
            click(3);
            click(1, true);
            assert.deepEqual(checkboxes().map(input => input.checked), [false, true, true, true]);
            click(3, true);
            assert.deepEqual(checkboxes().map(input => input.checked), [false, false, false, false]);
        });
    });

    it("Shift-click behaves as an individual click after Select all or removal of the anchor", () => {
        withDeleteHarness(({ checkboxes, selectAll }) => {
            let input = checkboxes()[0];
            input.checked = true;
            input.dispatchEvent({ type: 'click' });
            selectAll.checked = true;
            selectAll.dispatchEvent({ type: 'change' });
            input = checkboxes()[1];
            input.checked = false;
            input.dispatchEvent({ type: 'click', shiftKey: true });
            assert.deepEqual(checkboxes().map(input => input.checked), [true, false]);
            settingsManager.deleteStrategyConfig(input.value);
            updateConfigDropdown();
            input = checkboxes()[0];
            input.checked = false;
            input.dispatchEvent({ type: 'click', shiftKey: true });
            assert.deepEqual(checkboxes().map(input => input.checked), [false]);
        });
    });

    it("tracks individual selection, preserves it on refresh, and deletes only checked configurations in one write", () => {
        withDeleteHarness(({ checkboxes, selectAll, selectionCount, bulkDeleteButton, events, writeCount, select }) => {
            assert.equal(bulkDeleteButton.disabled, true);
            const input = checkboxes().find(checkbox => checkbox.value === 'Other setup')!;
            input.checked = true;
            input.dispatchEvent({ type: 'change' });
            assert.equal(selectAll.indeterminate, true);
            assert.equal(selectionCount.textContent, '1 selected');
            assert.equal(bulkDeleteButton.disabled, false);
            updateConfigDropdown();
            assert.equal(checkboxes().find(checkbox => checkbox.value === 'Other setup')!.checked, true);
            const writes = writeCount();
            bulkDeleteButton.click();
            assert.equal(writeCount(), writes + 1);
            assert.deepEqual(settingsManager.loadAllStrategyConfigs().map(config => config.name), ['Saved setup']);
            assert.equal(select.value, 'Saved setup');
            assert.equal(selectionCount.textContent, '0 selected');
            assert.equal(bulkDeleteButton.disabled, true);
            assert.deepEqual(events, ['strategy-configs:changed']);
        });
    });

    for (const errorName of ['QuotaExceededError', 'SecurityError']) {
        it(`keeps the whole selection on ${errorName} and permits a retry that deletes all`, () => {
            withDeleteHarness(({ checkboxes, selectAll, selectionCount, bulkDeleteButton, events, toasts, failWrites, writeCount }) => {
                selectAll.checked = true;
                selectAll.dispatchEvent({ type: 'change' });
                assert.equal(selectionCount.textContent, '2 selected');
                assert.equal(selectAll.indeterminate, false);
                failWrites(new DOMException('Storage write rejected', errorName));
                bulkDeleteButton.click();
                assert.equal(settingsManager.loadAllStrategyConfigs().length, 2);
                assert.equal(checkboxes().every(input => input.checked), true);
                assert.equal(bulkDeleteButton.disabled, false);
                assert.deepEqual(events, []);
                assert.equal(toasts.at(-1)?.type, 'error');
                failWrites(null);
                const writes = writeCount();
                bulkDeleteButton.click();
                assert.equal(writeCount(), writes + 1);
                assert.deepEqual(settingsManager.loadAllStrategyConfigs(), []);
                assert.deepEqual(events, ['strategy-configs:changed']);
                assert.equal(toasts.at(-1)?.message, '2 configurations deleted');
                assert.equal(selectAll.disabled, true);
                assert.equal(selectAll.checked, false);
                assert.equal(bulkDeleteButton.disabled, true);
                assert.equal(selectionCount.textContent, '0 selected');
            });
        });
    }

    it("supports deselect all and leaves storage untouched when confirmation is cancelled", () => {
        withDeleteHarness(({ selectAll, selectionCount, bulkDeleteButton, confirmDeletion, writeCount, events, toasts }) => {
            selectAll.checked = true;
            selectAll.dispatchEvent({ type: 'change' });
            selectAll.checked = false;
            selectAll.dispatchEvent({ type: 'change' });
            assert.equal(selectionCount.textContent, '0 selected');
            assert.equal(bulkDeleteButton.disabled, true);
            selectAll.checked = true;
            selectAll.dispatchEvent({ type: 'change' });
            confirmDeletion(false);
            const writes = writeCount();
            bulkDeleteButton.click();
            assert.equal(writeCount(), writes);
            assert.equal(settingsManager.loadAllStrategyConfigs().length, 2);
            assert.equal(selectionCount.textContent, '2 selected');
            assert.deepEqual(events, []);
            assert.deepEqual(toasts, []);
        });
    });

    it("rejects an empty or stale selection without deleting remaining configurations", () => {
        withDeleteHarness(({ selectAll, bulkDeleteButton, events, toasts, writeCount }) => {
            const initialWrites = writeCount();
            assert.equal(settingsManager.deleteStrategyConfigs(new Set()), false);
            assert.equal(writeCount(), initialWrites);
            selectAll.checked = true;
            selectAll.dispatchEvent({ type: 'change' });
            assert.equal(settingsManager.deleteStrategyConfig('Saved setup'), true);
            const writes = writeCount();
            bulkDeleteButton.click();
            assert.equal(writeCount(), writes);
            assert.deepEqual(settingsManager.loadAllStrategyConfigs().map(config => config.name), ['Other setup']);
            assert.deepEqual(events, []);
            assert.equal(toasts.at(-1)?.type, 'error');
        });
    });

    it("preserves loaded configuration tracking on failure and clears it only when that configuration is deleted", () => {
        withDeleteHarness(({ failWrites }) => {
            const originalRead = settingsManager.getBacktestSettings;
            settingsManager.getBacktestSettings = () => ({ ...DEFAULT_BACKTEST_SETTINGS });
            try {
                settingsManager.saveStrategyConfig('Tracked setup');
                failWrites(new DOMException('Storage write rejected', 'QuotaExceededError'));
                assert.equal(settingsManager.deleteStrategyConfigs(new Set(['Tracked setup', 'Other setup'])), false);
                assert.equal(settingsManager.getActiveConfiguration()?.name, 'Tracked setup');
                failWrites(null);
                assert.equal(settingsManager.deleteStrategyConfigs(new Set(['Saved setup', 'Other setup'])), true);
                assert.equal(settingsManager.getActiveConfiguration()?.name, 'Tracked setup');
                assert.equal(settingsManager.deleteStrategyConfigs(new Set(['Tracked setup'])), true);
                assert.equal(settingsManager.getActiveConfiguration(), null);
            } finally {
                failWrites(null);
                settingsManager.deleteStrategyConfig('Tracked setup');
                settingsManager.getBacktestSettings = originalRead;
            }
        });
    });
});
