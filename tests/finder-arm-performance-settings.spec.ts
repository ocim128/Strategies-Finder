import { expect } from "chai";
import { describe, it } from "node:test";
import { BACKTEST_SETTINGS_DOM_CONTRACTS } from "../lib/backtest-settings-dom-contract";
import { clearDomElementCache } from "../lib/dom-utils";
import { buildFinderArmPerformanceApplySettings } from "../lib/finder/finder-arm-performance-settings";
import { DEFAULT_BACKTEST_SETTINGS } from "../lib/settings-model";
import { settingsManager } from "../lib/settings-manager";
import type {
    FinderArmPerformanceCandidate,
    FinderArmPerformanceRunContext,
} from "../lib/types/finder";

class FakeInputElement {
    type = "text";
    value = "";
    checked = false;
    isConnected = true;
    dispatchEvent(): boolean { return true; }
}

class FakeSelectElement extends FakeInputElement {}
class FakeTextAreaElement extends FakeInputElement {}

describe("Finder Arm Performance Apply settings round-trip", () => {
    it("preserves risk, sizing, capital, and engine toggles through the settings writer and reader", () => {
        const previousDocument = (globalThis as any).document;
        const previousInput = (globalThis as any).HTMLInputElement;
        const previousSelect = (globalThis as any).HTMLSelectElement;
        const previousTextArea = (globalThis as any).HTMLTextAreaElement;
        const elements = new Map<string, FakeInputElement>();
        const contracts = new Map(BACKTEST_SETTINGS_DOM_CONTRACTS.map((contract) => [contract.domId, contract]));

        const getElement = (id: string): FakeInputElement => {
            let element = elements.get(id);
            if (element) return element;
            const contract = contracts.get(id);
            const isSelect = ["riskMode", "takeProfitMode", "tradeDirection", "tradeSizingMode"].includes(id);
            element = isSelect ? new FakeSelectElement() : new FakeInputElement();
            if (contract?.parser === "boolean") element.type = "checkbox";
            elements.set(id, element);
            return element;
        };

        (globalThis as any).document = { getElementById: getElement };
        (globalThis as any).HTMLInputElement = FakeInputElement;
        (globalThis as any).HTMLSelectElement = FakeSelectElement;
        (globalThis as any).HTMLTextAreaElement = FakeTextAreaElement;
        clearDomElementCache();

        try {
            const context = {
                uiBacktestSettings: {
                    ...DEFAULT_BACKTEST_SETTINGS,
                    riskSettingsToggle: true,
                    riskMode: "percentage",
                    stopLossEnabled: true,
                    takeProfitEnabled: true,
                    fixedTradeToggle: false,
                    sizingMode: "percent",
                    useRustEngine: true,
                },
                capitalSettings: {
                    initialCapital: 50_000,
                    positionSize: 17,
                    commission: 0.2,
                    sizingMode: "percent",
                    fixedTradeAmount: 300,
                },
            } as FinderArmPerformanceRunContext;
            const candidate = {
                backtestSettings: {
                    executionModel: "next_open",
                    stopLossEnabled: true,
                    takeProfitEnabled: true,
                },
            } as FinderArmPerformanceCandidate;

            const applySettings = buildFinderArmPerformanceApplySettings(context, candidate);
            settingsManager.applyBacktestSettings(applySettings);
            const writtenAndRead = settingsManager.getBacktestSettings();

            expect(writtenAndRead.riskSettingsToggle).to.equal(true);
            expect(writtenAndRead.stopLossEnabled).to.equal(true);
            expect(writtenAndRead.takeProfitEnabled).to.equal(true);
            expect(writtenAndRead.fixedTradeToggle).to.equal(false);
            expect(writtenAndRead.sizingMode).to.equal("percent");
            expect(writtenAndRead.initialCapital).to.equal(50_000);
            expect(writtenAndRead.positionSize).to.equal(17);
            expect(writtenAndRead.commission).to.equal(0.2);
            expect(writtenAndRead.useRustEngine).to.equal(true);
            expect(writtenAndRead.executionModel).to.equal("next_open");
        } finally {
            clearDomElementCache();
            if (previousDocument === undefined) delete (globalThis as any).document;
            else (globalThis as any).document = previousDocument;
            if (previousInput === undefined) delete (globalThis as any).HTMLInputElement;
            else (globalThis as any).HTMLInputElement = previousInput;
            if (previousSelect === undefined) delete (globalThis as any).HTMLSelectElement;
            else (globalThis as any).HTMLSelectElement = previousSelect;
            if (previousTextArea === undefined) delete (globalThis as any).HTMLTextAreaElement;
            else (globalThis as any).HTMLTextAreaElement = previousTextArea;
        }
    });
});
