/**
 * Signal Committee handlers. Thin wiring layer that initializes the service
 * and refreshes on tab open. The service owns all events on its own DOM.
 */
import { signalCommitteeService } from "../signal-committee-service";
import { state } from "../state";
import { getOptionalElement } from "../dom-utils";

const COMMITTEE_TAB_ID = "signalcommittee";

export function initSignalCommitteeHandlers(): void {
    signalCommitteeService.init();

    // Refresh on subsequent re-opens of the tab. NOTE: this listener is added
    // during the lazy-init that runs ON THE FIRST tab-open, so it cannot catch
    // that first event (the event has already been dispatched). The first-open
    // refresh is handled by the direct call at the bottom of this function.
    window.addEventListener("strategy-panel:tab-change", ((event: Event) => {
        const customEvent = event as CustomEvent<{ tabId?: string }>;
        if (customEvent.detail?.tabId === COMMITTEE_TAB_ID) {
            void signalCommitteeService.refreshOnTabOpen();
        }
    }) as EventListener);

    // Keep the Add button's disabled state in sync with the current strategy.
    // Cross-symbol / 1s-Polymarket strategies cannot be committee members.
    state.subscribe("currentStrategyKey", () => syncAddButtonState());
    syncAddButtonState();

    // First-open refresh. This handler runs as the final step of the lazy
    // activation triggered by clicking the Committee tab, so the markup is
    // loaded and this is the right moment to kick off the initial fetch.
    void signalCommitteeService.refreshOnTabOpen();
}

function syncAddButtonState(): void {
    const btn = getOptionalElement<HTMLButtonElement>("signalCommitteeAddBtn");
    if (!btn) return;
    const addable = signalCommitteeService.isCurrentStrategyAddable();
    btn.disabled = !addable;
    btn.title = addable
        ? "Add the current chart configuration to the committee."
        : "Cannot add: switch to a chart-data strategy. Cross-symbol and 1s-Polymarket strategies are not supported here.";
}
