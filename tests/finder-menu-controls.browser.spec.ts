import { expect } from "chai";
import { after, afterEach, before, describe, it } from "node:test";
import { FinderControls } from "../lib/finder/browser/finder-controls";
import { FinderStrategySelection } from "../lib/finder/browser/finder-strategy-selection";
import { createFakeFinderManagerDom } from "./helpers/fake-finder-manager-dom";

const backtestSettings = { executionModel: "next_open", disableSignalExits: false, exitStrategyOverrideEnabled: false } as const;
const activeControls: FinderControls[] = [];
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");

before(() => {
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { getElementById: () => null },
    });
});
after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
});
afterEach(() => {
    for (const controls of activeControls.splice(0)) controls.flushPendingPersistence();
});

function makeHarness() {
    const dom = createFakeFinderManagerDom();
    const selection: FinderStrategySelection = new FinderStrategySelection({
        getDom: () => dom,
        getUiState: () => controls.uiState,
        isUniverseSelectionScope: () => controls.usesUniverseStrategySelection(),
        persist: () => controls.saveUiState(),
    });
    const controls: FinderControls = new FinderControls({
        getDom: () => dom,
        selection,
        setStatus: () => {},
        renderLatestResults: () => {},
        populateResortOptions: () => {},
        applyResort: () => {},
        requestRun: () => {},
        renderRandomBenchmark: () => {},
    });
    controls.saveUiState = () => {};
    controls.applyPersistedUiStateToDom();
    controls.initUniverseUI();
    controls.initFinderSettingsPersistenceUI();
    activeControls.push(controls);
    const changeScope = (scope: string) => {
        dom.finderScope.value = scope;
        dom.finderScope.dispatchEvent(new Event("change"));
    };
    return { controls, dom, changeScope };
}

describe("Finder menu scope transitions", () => {
    for (const mode of ["grid", "random"] as const) {
        it(`retains ${mode} across locked scopes and unrelated settings edits`, () => {
            const { controls, dom, changeScope } = makeHarness();
            dom.finderMode.value = mode;
            dom.finderMode.dispatchEvent(new Event("change"));
            for (const scope of ["symbol_universe", "asset_opportunity", "strategy_quality"]) {
                changeScope(scope);
                expect(dom.finderMode.disabled).to.equal(true);
                expect(dom.finderMode.value).to.equal("random");
                dom.finderTopN.value = "7";
                dom.finderTopN.dispatchEvent(new Event("input"));
                expect(controls.uiState.mode).to.equal(mode);
                expect(controls.readOptions(backtestSettings).mode).to.equal("random");
            }
            for (const scope of ["current_chart", "arm_performance"]) {
                changeScope(scope);
                expect(dom.finderMode.disabled).to.equal(false);
                expect(dom.finderMode.value).to.equal(mode);
                expect(controls.readOptions(backtestSettings).mode).to.equal(mode);
            }
        });
    }

    it("keeps hidden Arm OOS validation off without clearing the chart preference", () => {
        const { controls, dom, changeScope } = makeHarness();
        dom.finderDataSlice.value = "date_range";
        dom.finderOosValidationToggle.checked = true;
        changeScope("arm_performance");
        expect(dom.finderOosValidationToggle.disabled).to.equal(true);
        expect(dom.finderOosValidationRow.style.display).to.equal("none");
        expect(controls.readOptions(backtestSettings).oosValidationEnabled).to.equal(false);
        changeScope("current_chart");
        expect(dom.finderOosValidationToggle.checked).to.equal(true);
        expect(controls.readOptions(backtestSettings).oosValidationEnabled).to.equal(true);
    });

    it("recounts the universe and updates its units on every scope change", () => {
        const { dom, changeScope } = makeHarness();
        dom.finderUniverseSymbols.value = "BTC+ETH\nSOL+BNB";
        changeScope("symbol_universe");
        expect(dom.finderUniverseSummary.textContent).to.equal("2 symbols");
        changeScope("arm_performance");
        expect(dom.finderUniverseSummary.textContent).to.equal("2 pairs");
        changeScope("asset_opportunity");
        expect(dom.finderUniverseSummary.textContent).to.equal("2 symbols");
    });
});
