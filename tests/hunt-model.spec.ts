import { expect } from "chai";
import { describe, it } from "node:test";
import {
    HUNT_MAX_TRADES_UNBOUNDED,
    buildStableParamKey,
    getMarketSelectionAutoReloadSuppressCount,
    normalizeStoredHuntProfile,
    normalizeStoredHuntRunSettings,
    stableNormalizeParams,
} from "../lib/hunt/hunt-model";

describe("Hunt model", () => {
    it("normalizes stored profiles and preserves chart plus polymarket context", () => {
        const profile = normalizeStoredHuntProfile({
            id: "profile-1",
            name: "ETH 5m Poly",
            source: "endpoint_snapshot",
            symbol: "ethusdt",
            interval: "5M",
            blockRange: { from: 25, to: 125 },
            backtestSettings: {
                initialCapital: 2_500,
                positionSize: 12,
                commission: 0.2,
                fixedTradeToggle: true,
                fixedTradeAmount: 150,
                polymarketOutcomeSymbol: "BTCUSDT",
                polymarketEntryOffset: 3,
            },
            capitalSettings: {
                initialCapital: 2_500,
                positionSize: 12,
                commission: 0.2,
                sizingMode: "fixed",
                fixedTradeAmount: 150,
            },
        });

        expect(profile).to.not.equal(null);
        expect(profile!.symbol).to.equal("ETHUSDT");
        expect(profile!.interval).to.equal("5m");
        expect(profile!.blockRange).to.deep.equal({ from: 25, to: 125 });
        expect(profile!.backtestSettings.polymarketOutcomeSymbol).to.equal("BTCUSDT");
        expect(profile!.backtestSettings.polymarketEntryOffset).to.equal(3);
        expect(profile!.capitalSettings.initialCapital).to.equal(2_500);
        expect(profile!.capitalSettings.fixedTradeAmount).to.equal(150);
        expect(profile!.backtestSettings.initialCapital).to.equal(2_500);
        expect(profile!.backtestSettings.fixedTradeAmount).to.equal(150);
    });

    it("normalizes run settings and generates deterministic param keys", () => {
        const settings = normalizeStoredHuntRunSettings({
            minTrades: 55,
            maxTrades: 0,
            selectedStrategyKeys: [" mean_rev ", "mean_rev", "trend"],
            polymarketRankMode: "profitFactorTrades",
        });

        expect(settings.minTrades).to.equal(55);
        expect(settings.maxTrades).to.equal(HUNT_MAX_TRADES_UNBOUNDED);
        expect(settings.selectedStrategyKeys).to.deep.equal(["mean_rev", "trend"]);
        expect(settings.polymarketRankMode).to.equal("profitFactorTrades");

        const normalized = stableNormalizeParams({
            threshold: 1.234567891,
            lookback: 10.000000001,
        });

        expect(normalized).to.deep.equal({
            lookback: 10,
            threshold: 1.23456789,
        });
        expect(buildStableParamKey({ lookback: 10, threshold: 1.23456789 })).to.equal(
            buildStableParamKey({ threshold: 1.234567891, lookback: 10.000000001 })
        );
    });

    it("coerces Hunt rank mode to a supported option in signal-exit mode", () => {
        const settings = normalizeStoredHuntRunSettings({
            polymarketExitMode: "signal_exit_same_event",
            polymarketRankMode: "balanced",
        });

        expect(settings.polymarketExitMode).to.equal("signal_exit_same_event");
        expect(settings.polymarketRankMode).to.equal("expectancy");
    });

    it("only suppresses the auto-reloads that a Hunt selection change will actually trigger", () => {
        expect(getMarketSelectionAutoReloadSuppressCount(
            { symbol: "ETHUSDT", interval: "1d" },
            { symbol: "ETHUSDT", interval: "1d" }
        )).to.equal(0);

        expect(getMarketSelectionAutoReloadSuppressCount(
            { symbol: "ETHUSDT", interval: "1d" },
            { symbol: "BTCUSDT", interval: "1d" }
        )).to.equal(1);

        expect(getMarketSelectionAutoReloadSuppressCount(
            { symbol: "ETHUSDT", interval: "1d" },
            { symbol: "ETHUSDT", interval: "5m" }
        )).to.equal(1);

        expect(getMarketSelectionAutoReloadSuppressCount(
            { symbol: "ETHUSDT", interval: "1d" },
            { symbol: "BTCUSDT", interval: "5m" }
        )).to.equal(2);
    });
});
