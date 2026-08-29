import { expect } from "chai";
import { describe, it } from "node:test";
import {
    resolveAssetCandidateBacktestRunOptions,
    runAssetCandidateBacktest,
} from "../lib/finder/finder-asset-candidate-execution";
import { rustEngine } from "../lib/rust-engine-client";
import {
    RUST_EXIT_REASON_CAPABILITY,
    RUST_NEXT_OPEN_CAPABILITY,
    RUST_RISK_MAX_HOLD_CAPABILITY,
} from "../lib/rust-settings-sanitizer";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";
import type { FinderOptions } from "../lib/types/finder";

const data: OHLCVData[] = [
    { time: 1_700_000_000 as Time, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
    { time: 1_700_000_300 as Time, open: 10.5, high: 12, low: 10, close: 11, volume: 120 },
];

/**
 * Locks the exact `backtestRunOptions` matrix the two Asset Opportunity call
 * sites must agree on:
 *
 * - IS search candidate loop: compact engine, no trades, endpoint selection
 *   "auto" (enabled unless the resolved trade direction is `combined`, which
 *   retains trades instead).
 * - Fresh-entry recheck (signal_close): full engine, trades retained.
 * - Fresh-entry recheck (next_open/next_close): same plus signalsOnly.
 * - OOS validation: full engine, trades retained, no full analytics.
 * - Winner analytics recompute: compact engine, trades, Sharpe + drawdown.
 *
 * If a future engine-flag change drifts one surface, the spec that exercises
 * the new flag must land here too.
 */
describe("Asset Opportunity candidate execution run options", () => {
    it("keeps endpoint-selection candidates on TypeScript and preserves final-bar removal", async () => {
        const strategy: Strategy = {
            name: "Endpoint Selection Test",
            description: "Produces a trade that exits on the final bar.",
            defaultParams: {},
            paramLabels: {},
            execute(candles) {
                const first = candles[0];
                const last = candles.at(-1);
                return first && last
                    ? [
                        { time: first.time, type: "buy", price: first.close },
                        { time: last.time, type: "sell", price: last.close },
                    ]
                    : [];
            },
        };
        const backtestSettings: BacktestSettings = {
            executionModel: "signal_close",
            tradeDirection: "long",
            allowSameBarExit: true,
            slippageBps: 0,
            marketMode: "all",
        };
        const capitalSettings: CapitalSettings = {
            initialCapital: 10_000,
            positionSize: 100,
            commission: 0,
            sizingMode: "percent",
            fixedTradeAmount: 1_000,
        };
        const options = {
            scope: "asset_opportunity",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 1,
            steps: 1,
            rangePercent: 0,
            maxRuns: 1,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
        } satisfies FinderOptions;
        const originalRunBacktest = rustEngine.runBacktestWithStatus;
        let rustCalls = 0;
        rustEngine.runBacktestWithStatus = async () => {
            rustCalls += 1;
            throw new Error("Rust must not receive endpoint-selection candidates");
        };

        try {
            const output = await runAssetCandidateBacktest({
                data,
                symbol: "TEST",
                interval: "1m",
                strategy,
                strategyKey: "endpoint_selection_test",
                strategyParams: {},
                riskOverrideParams: {},
                settings: backtestSettings,
                capitalSettings,
                options,
                useRustEnginePreference: true,
                needs: {
                    compact: true,
                    trades: false,
                    fullAnalytics: false,
                    endpointSelection: "auto",
                },
            });
            expect(rustCalls).to.equal(0);
            expect(output.engineUsed).to.equal("typescript");
            expect(output.engineDiagnostics?.typescriptReason).to.equal("endpoint selection requires TypeScript");
            expect(output.endpointSelection?.adjusted).to.equal(true);
            expect(output.endpointSelection?.removedTrades).to.equal(1);
            expect(output.endpointSelection?.result.totalTrades).to.equal(0);
        } finally {
            rustEngine.runBacktestWithStatus = originalRunBacktest;
        }
    });

    it("preserves capability-gated settings before a Rust fallback", async () => {
        const strategy: Strategy = {
            name: "Capability Preservation Test",
            description: "Produces one simple next-open trade.",
            defaultParams: {},
            paramLabels: {},
            execute(candles) {
                const first = candles[0];
                const last = candles.at(-1);
                return first && last
                    ? [
                        { time: first.time, type: "buy", price: first.close },
                        { time: last.time, type: "sell", price: last.close },
                    ]
                    : [];
            },
        };
        const backtestSettings: BacktestSettings = {
            executionModel: "next_open",
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 2,
            tradeDirection: "long",
            allowSameBarExit: true,
            slippageBps: 0,
            marketMode: "all",
        };
        const capitalSettings: CapitalSettings = {
            initialCapital: 10_000,
            positionSize: 100,
            commission: 0,
            sizingMode: "percent",
            fixedTradeAmount: 1_000,
        };
        const options = {
            scope: "asset_opportunity",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 1,
            steps: 1,
            rangePercent: 0,
            maxRuns: 1,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
        } satisfies FinderOptions;
        const originalRunBacktest = rustEngine.runBacktestWithStatus;
        let sanitizedSettings: BacktestSettings | undefined;
        rustEngine.runBacktestWithStatus = async (...args) => {
            sanitizedSettings = args[5];
            return { ok: false, reason: "health_unavailable" };
        };

        try {
            await runAssetCandidateBacktest({
                data,
                symbol: "TEST",
                interval: "1m",
                strategy,
                strategyKey: "capability_preservation_test",
                strategyParams: {},
                riskOverrideParams: {},
                settings: backtestSettings,
                capitalSettings,
                options,
                useRustEnginePreference: true,
                rustCapabilities: new Set([
                    RUST_NEXT_OPEN_CAPABILITY,
                    RUST_RISK_MAX_HOLD_CAPABILITY,
                    RUST_EXIT_REASON_CAPABILITY,
                ]),
                needs: {
                    compact: false,
                    trades: true,
                    fullAnalytics: false,
                    endpointSelection: false,
                },
            });
            expect(sanitizedSettings?.executionModel).to.equal("next_open");
            expect(sanitizedSettings?.riskMaxHoldEnabled).to.equal(true);
            expect(sanitizedSettings?.riskMaxHoldBars).to.equal(2);
        } finally {
            rustEngine.runBacktestWithStatus = originalRunBacktest;
        }
    });

    it("IS search on a non-combined direction uses compact endpoint selection without trades", () => {
        const options = resolveAssetCandidateBacktestRunOptions(
            { compact: true, trades: false, fullAnalytics: false, endpointSelection: "auto" },
            data,
            "long",
        );
        expect(options.useCompactBacktest).to.equal(true);
        expect(options.includeAdvancedAnalytics).to.equal(false);
        expect(options.omitEquityCurve).to.equal(true);
        expect(options.skipResultPostProcessing).to.equal(true);
        expect(options.skipDrawdown).to.equal(true);
        expect(options.includeSharpeRatio).to.equal(false);
        expect(options.requireTradeHistory).to.equal(false);
        expect(options.endpointSelectionLastDataTime).to.equal(1_700_000_300);
    });

    it("IS search on a combined direction retains trades and disables endpoint selection", () => {
        const options = resolveAssetCandidateBacktestRunOptions(
            { compact: true, trades: false, fullAnalytics: false, endpointSelection: "auto" },
            data,
            "combined",
        );
        expect(options.useCompactBacktest).to.equal(true);
        expect(options.requireTradeHistory).to.equal(true);
        expect(options.endpointSelectionLastDataTime).to.equal(undefined);
    });

    it("IS search keeps full analytics when the sort priority requires them", () => {
        const options = resolveAssetCandidateBacktestRunOptions(
            { compact: true, trades: false, fullAnalytics: true, endpointSelection: "auto" },
            data,
            "long",
        );
        expect(options.includeSharpeRatio).to.equal(true);
        expect(options.skipDrawdown).to.equal(false);
    });

    it("fresh-entry recheck uses the full engine with trade history (signal_close)", () => {
        const options = resolveAssetCandidateBacktestRunOptions(
            { compact: false, trades: true, fullAnalytics: false, endpointSelection: false },
            data,
            "long",
        );
        expect(options.useCompactBacktest).to.equal(false);
        expect(options.requireTradeHistory).to.equal(true);
        expect(options.includeSharpeRatio).to.equal(false);
        expect(options.skipDrawdown).to.equal(true);
        expect(options.signalsOnly).to.equal(undefined);
        expect(options.endpointSelectionLastDataTime).to.equal(undefined);
    });

    it("fresh-entry recheck is signals-only for non-signal_close execution models", () => {
        const options = resolveAssetCandidateBacktestRunOptions(
            { compact: false, trades: true, fullAnalytics: false, signalsOnly: true, endpointSelection: false },
            data,
            "next_open",
        );
        expect(options.signalsOnly).to.equal(true);
        expect(options.requireTradeHistory).to.equal(true);
    });

    it("OOS validation uses the full engine with trades and no full analytics", () => {
        const options = resolveAssetCandidateBacktestRunOptions(
            { compact: false, trades: true, fullAnalytics: false, endpointSelection: false },
            data,
            "long",
        );
        expect(options.useCompactBacktest).to.equal(false);
        expect(options.requireTradeHistory).to.equal(true);
        expect(options.includeSharpeRatio).to.equal(false);
        expect(options.omitEquityCurve).to.equal(true);
    });

    it("winner analytics recompute uses the compact engine with trades and full analytics", () => {
        const options = resolveAssetCandidateBacktestRunOptions(
            { compact: true, trades: true, fullAnalytics: true, endpointSelection: false },
            data,
            "long",
        );
        expect(options.useCompactBacktest).to.equal(true);
        expect(options.requireTradeHistory).to.equal(true);
        expect(options.includeSharpeRatio).to.equal(true);
        expect(options.skipDrawdown).to.equal(false);
        expect(options.omitEquityCurve).to.equal(true);
        expect(options.endpointSelectionLastDataTime).to.equal(undefined);
    });

    it("never mutates the data array or reads beyond its last bar", () => {
        const options = resolveAssetCandidateBacktestRunOptions(
            { compact: true, trades: false, fullAnalytics: false, endpointSelection: "auto" },
            [],
            "long",
        );
        expect(options.endpointSelectionLastDataTime).to.equal(null);
    });
});
