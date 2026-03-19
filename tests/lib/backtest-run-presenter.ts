import { getOptionalElement, getRequiredElement } from "./dom-utils";

export type BacktestRunHandle = {
    setStatus(message: string): void;
    setProgress(width: string, text: string): void;
    finish(): void;
};

function setBacktestButtonLoading(buttonId: string, loading: boolean, manageAriaBusy = false): void {
    const button = getOptionalElement<HTMLButtonElement>(buttonId);
    if (!button) return;
    button.disabled = loading;
    button.classList.toggle('is-loading', loading);
    if (manageAriaBusy) {
        button.setAttribute('aria-busy', loading ? 'true' : 'false');
    }
}

export function createDomBacktestRunHandle(
    buttonId: string,
    initialStatus: string,
    manageAriaBusy = false
): BacktestRunHandle {
    const progressContainer = getRequiredElement('progressContainer');
    const progressFill = getRequiredElement('progressFill');
    const progressText = getRequiredElement('progressText');
    const statusEl = getRequiredElement('strategyStatus');

    setBacktestButtonLoading(buttonId, true, manageAriaBusy);
    progressContainer.classList.add('active');
    statusEl.textContent = initialStatus;

    return {
        setStatus(message: string) {
            statusEl.textContent = message;
        },
        setProgress(width: string, text: string) {
            progressFill.style.width = width;
            progressText.textContent = text;
        },
        finish() {
            progressContainer.classList.remove('active');
            progressFill.style.width = '0%';
            setBacktestButtonLoading(buttonId, false, manageAriaBusy);
        }
    };
}
