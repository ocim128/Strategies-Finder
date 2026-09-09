import { expect } from "chai";
import { after, before, describe, it } from "node:test";
import {
    readPersistedSelectionRulesLastRun,
    persistSelectionRulesLastRun,
    type SelectionRulesTerminalEvent,
} from "../lib/selection-rules/service";

describe("selection-rules result persistence", () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();

    before(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: {
                getItem: (key: string) => values.get(key) ?? null,
                setItem: (key: string, value: string) => { values.set(key, value); },
                removeItem: (key: string) => { values.delete(key); },
            },
        });
    });

    after(() => {
        if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
        else delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    it("round-trips the terminal result so a refreshed tab can restore it", () => {
        const terminal: SelectionRulesTerminalEvent = {
            type: "done",
            runId: "selection-rules-test-run",
            ok: true,
            cancelled: false,
            finishedAt: 123,
            summary: {
                runId: "selection-rules-test-run",
                folderPath: "archive/mining-ledger/folder",
                totalRules: 1,
                completedRules: 1,
                resultCount: 1,
                passedCount: 1,
                results: [],
                reportLines: ["summary"],
            },
            results: [],
            reportLines: ["report"],
            diagnosticsLines: ["diagnostic"],
        };

        persistSelectionRulesLastRun(terminal);
        expect(readPersistedSelectionRulesLastRun()).to.deep.equal(terminal);
    });

    it("rejects malformed saved results instead of restoring them", () => {
        values.set("playground_selection_rules_last_run", JSON.stringify({
            schema: "selection_rules.last_run",
            version: 1,
            data: { type: "done", runId: "broken" },
        }));
        expect(readPersistedSelectionRulesLastRun()).to.equal(null);
    });
});
