import { expect } from "chai";
import { describe, it } from "node:test";
import {
    normalizeTradeSizingMode,
    resolveCapitalSettingsFromRaw,
    SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS,
} from "./lib/backtest-capital-settings";

describe("Backtest capital settings", () => {
    it("upgrades deleted smart sizing modes to surviving canonical modes", () => {
        expect(normalizeTradeSizingMode("smart_fixed")).to.equal("smart_fixed_velocity_memory");
        expect(normalizeTradeSizingMode("smart_fixed_tp_distance_fit")).to.equal("smart_fixed_quality_x_velocity");
        expect(normalizeTradeSizingMode("percent")).to.equal("percent");
    });

    it("resolves capital settings from raw inputs with fixed-toggle fallback", () => {
        const fixed = resolveCapitalSettingsFromRaw({
            initialCapital: "25000",
            positionSize: "50",
            commission: "0.2",
            fixedTradeAmount: "1200",
            fixedTradeToggle: true,
            sizingMode: "invalid",
        });

        expect(fixed.initialCapital).to.equal(25000);
        expect(fixed.positionSize).to.equal(50);
        expect(fixed.commission).to.equal(0.2);
        expect(fixed.sizingMode).to.equal("fixed");
        expect(fixed.fixedTradeAmount).to.equal(1200);
        expect(fixed.advancedSizing?.kellyFraction).to.equal("half");
    });

    it("preserves subscription defaults when legacy payloads omit fixed toggle", () => {
        const resolved = resolveCapitalSettingsFromRaw({
            initialCapital: "5000",
            sizingMode: undefined,
            fixedTradeToggle: undefined,
        }, SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS);

        expect(resolved.sizingMode).to.equal("percent");
        expect(resolved.initialCapital).to.equal(5000);
        expect(resolved.commission).to.equal(0);
    });

    it("hydrates advanced sizing settings alongside capital fields", () => {
        const resolved = resolveCapitalSettingsFromRaw({
            sizingMode: "kelly_criterion",
            kellyFraction: "quarter",
            kellyWinRateCap: "0.8",
            secureFMethod: "analytical",
        });

        expect(resolved.sizingMode).to.equal("kelly_criterion");
        expect(resolved.advancedSizing?.kellyFraction).to.equal("quarter");
        expect(resolved.advancedSizing?.kellyWinRateCap).to.equal(0.8);
        expect(resolved.advancedSizing?.secureFMethod).to.equal("analytical");
    });
});
