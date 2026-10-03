import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BACKTEST_SETTINGS } from "../lib/settings-model";
import { getSettingsSectionSummary, settingsSnapshotKey } from "../lib/settings-workspace-model";

describe("Settings workspace summaries and configuration comparison", () => {
    it("summarizes percentage sizing when the alternative sizing toggle is off", () => {
        const settings = { ...DEFAULT_BACKTEST_SETTINGS, fixedTradeToggle: false, sizingMode: "fixed" as const, positionSize: 25, commission: 0 };
        assert.equal(getSettingsSectionSummary("sizing", settings), "25% of capital · Commission 0%");
        assert.equal(getSettingsSectionSummary("sizing", { ...settings, fixedTradeToggle: true, fixedTradeAmount: 1000 }), "$1,000/trade · Commission 0%");
    });

    it("keeps disabled features clear and reflects execution and confirmation changes", () => {
        const settings = { ...DEFAULT_BACKTEST_SETTINGS, riskSettingsToggle: false, stopLossEnabled: true, stopLossPercent: 9, confirmationStrategiesToggle: false };
        assert.equal(getSettingsSectionSummary("risk", settings), "Risk controls off");
        assert.equal(getSettingsSectionSummary("confirmation", settings), "Entry confirmation off");
        assert.match(getSettingsSectionSummary("risk", { ...settings, riskSettingsToggle: true, riskMode: "percentage", takeProfitEnabled: false }), /SL 9% · TP off/);
        assert.equal(getSettingsSectionSummary("realism", { ...settings, executionModel: "next_open", maxOpenTrades: 3, slippageBps: 0, strategyTimeframeEnabled: true, strategyTimeframeMinutes: 120 }), "Next bar open · 0 bps · Unlimited open trades · 120m strategy TF");
        assert.equal(getSettingsSectionSummary("confirmation", { ...settings, confirmationStrategiesToggle: true, confirmationStrategies: ["ema_confirmation"], confirmationMode: "confirm_within_window", confirmationWindowBars: 2 }), "1 selected · confirm within window · 2 bars");
    });

    it("compares nested values independently of object key order without conflating nonfinite values", () => {
        const first = { strategyParams: { period: 5, threshold: 0 }, backtestSettings: { exits: { takeProfit: 3, stopLoss: 1 }, maxOpenTrades: Infinity } };
        const reordered = { backtestSettings: { maxOpenTrades: Infinity, exits: { stopLoss: 1, takeProfit: 3 } }, strategyParams: { threshold: 0, period: 5 } };
        assert.equal(settingsSnapshotKey(first), settingsSnapshotKey(reordered));
        assert.notEqual(settingsSnapshotKey(first), settingsSnapshotKey({ ...first, strategyParams: { period: 6, threshold: 0 } }));
        assert.notEqual(settingsSnapshotKey({ value: Infinity }), settingsSnapshotKey({ value: null }));
    });
});
