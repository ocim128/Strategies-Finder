import type { BacktestSettingsData } from "./settings-model";
import { serializeJsonPreservingNonFinite, stableNormalize } from "./json-utils";

export function settingsSnapshotKey(value: unknown): string {
    return serializeJsonPreservingNonFinite(stableNormalize(value));
}

export function getSettingsSectionSummary(section: string, s: BacktestSettingsData): string {
    const direction = { long: "Long", short: "Short", both: "Both (Flip)", both_no_flip: "Both (No Flip)", combined: "Combined (L+S)" };
    switch (section) {
        case "direction":
            return `${direction[s.tradeDirection] ?? s.tradeDirection}${s.invertSignals ? " · Signals inverted" : ""}`;
        case "risk": {
            const parts = [!s.riskSettingsToggle ? "Risk controls off" : s.riskMode === "percentage"
                ? `SL ${s.stopLossEnabled ? `${s.stopLossPercent}%` : "off"} · TP ${s.takeProfitEnabled ? `${s.takeProfitPercent}% (${s.takeProfitMode.replaceAll("_", " ")})` : "off"}`
                : `ATR · SL ${s.stopLossAtr}× · TP ${s.takeProfitAtr}× · Trail ${s.trailingAtr}×`];
            if (s.riskSettingsToggle && s.disableSignalExits) parts.push(s.exitStrategyOverrideEnabled ? "Exit strategy override" : "Signal exits off");
            if (s.riskSettingsToggle && s.pathExitEnabled) parts.push(`Path exit: ${s.pathExitMode.replaceAll("_", " ")}`);
            return parts.join(" · ");
        }
        case "sizing": {
            const mode = s.fixedTradeToggle ? s.sizingMode : "percent";
            const sizing = mode === "fixed" ? `$${s.fixedTradeAmount.toLocaleString("en-US")}/trade`
                : mode === "percent" ? `${s.positionSize}% of capital` : mode.replaceAll("_", " ");
            return `${sizing} · Commission ${s.commission}%`;
        }
        case "confirmation":
            return s.confirmationStrategiesToggle
                ? `${s.confirmationStrategies.length} selected · ${s.confirmationMode.replaceAll("_", " ")}${s.confirmationMode.includes("window") ? ` · ${s.confirmationWindowBars} bars` : ""}`
                : "Entry confirmation off";
        case "realism": {
            const execution = { next_open: "Next bar open", next_close: "Next bar close", signal_close: "Signal bar close" };
            return `${execution[s.executionModel]} · ${s.slippageBps} bps · ${s.maxOpenTrades >= 3 ? "Unlimited" : s.maxOpenTrades} open trades${s.strategyTimeframeEnabled ? ` · ${s.strategyTimeframeMinutes}m strategy TF` : ""}`;
        }
        case "engine": return s.useRustEngine ? "Prefer Rust when supported and available" : "TypeScript";
        default: return "";
    }
}
