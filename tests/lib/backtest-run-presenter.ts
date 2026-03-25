import { getOptionalElement, getRequiredElement } from "./dom-utils";
import type { BacktestResult } from "./strategies/index";

export type BacktestRunHandle = {
    setStatus(message: string): void;
    setProgress(width: string, text: string): void;
    finish(): void;
};

export type BacktestRunEngine = "rust" | "typescript";
export type BacktestParityComparison = {
    odd: BacktestResult;
    even: BacktestResult;
    baseline: "odd" | "even";
};

function setBacktestButtonLoading(buttonId: string, loading: boolean, manageAriaBusy = false): void {
    const button = getOptionalElement<HTMLButtonElement>(buttonId);
    if (!button) return;
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
    if (manageAriaBusy) {
        button.setAttribute("aria-busy", loading ? "true" : "false");
    }
}

export function createDomBacktestRunHandle(
    buttonId: string,
    initialStatus: string,
    manageAriaBusy = false
): BacktestRunHandle {
    const progressContainer = getRequiredElement("progressContainer");
    const progressFill = getRequiredElement("progressFill");
    const progressText = getRequiredElement("progressText");
    const statusEl = getRequiredElement("strategyStatus");

    setBacktestButtonLoading(buttonId, true, manageAriaBusy);
    progressContainer.classList.add("active");
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
            progressContainer.classList.remove("active");
            progressFill.style.width = "0%";
            setBacktestButtonLoading(buttonId, false, manageAriaBusy);
        }
    };
}

export async function updateDomBacktestRunProgress(
    runUi: BacktestRunHandle,
    width: string,
    text: string,
    delayMs = 0
): Promise<void> {
    runUi.setProgress(width, text);
    if (delayMs > 0) {
        await delayBacktestUi(delayMs);
    }
}

export function formatCompletedBacktestStatus(
    result: BacktestResult,
    engineUsed: BacktestRunEngine,
    parityComparison: BacktestParityComparison | null
): string {
    if (parityComparison && !result.entryStats) {
        return `2H compare | Odd ${parityComparison.odd.netProfitPercent.toFixed(2)}% | Even ${parityComparison.even.netProfitPercent.toFixed(2)}%`;
    }

    if (result.entryStats) {
        const entryWin = result.entryStats.winRate.toFixed(1);
        const useTarget = result.entryStats.winDefinition === "target" && (result.entryStats.targetPct ?? 0) > 0;
        const avgBars = useTarget
            ? (result.entryStats.avgTargetBars ?? result.entryStats.avgRetestBars)
            : result.entryStats.avgRetestBars;
        const label = useTarget ? "Avg Target" : "Avg Retest";
        return `${result.entryStats.totalEntries} entries | Win ${entryWin}% | ${label} ${avgBars.toFixed(1)} bars`;
    }

    const expectancyText = `${result.expectancy >= 0 ? "+" : ""}$${result.expectancy.toFixed(2)}`;
    const pfText = result.profitFactor === Infinity ? "Inf" : result.profitFactor.toFixed(2);
    const engineBadge = engineUsed === "rust" ? " [rust]" : "";
    return `${result.totalTrades} trades | Exp ${expectancyText} | PF ${pfText}${engineBadge}`;
}

export function formatCompletedCombinedBacktestStatus(
    mode: "and" | "or",
    result: BacktestResult
): string {
    const expectancyText = `${result.expectancy >= 0 ? "+" : ""}$${result.expectancy.toFixed(2)}`;
    const pfText = result.profitFactor === Infinity ? "Inf" : result.profitFactor.toFixed(2);
    return `Combined (${mode.toUpperCase()}) | ${result.totalTrades} trades | Exp ${expectancyText} | PF ${pfText}`;
}

export function setReplayStartButtonDisabled(disabled: boolean): void {
    const replayStartBtn = getOptionalElement<HTMLButtonElement>("replayStartBtn");
    if (replayStartBtn) {
        replayStartBtn.disabled = disabled;
    }
}

export function delayBacktestUi(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
