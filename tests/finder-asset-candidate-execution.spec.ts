import { expect } from "chai";
import { describe, it } from "node:test";
import { resolveAssetCandidateBacktestRunOptions } from "../lib/finder/finder-asset-candidate-execution";
import type { OHLCVData, Time } from "../lib/types/strategies";

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
