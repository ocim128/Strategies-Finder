/**
 * Focused tests for the Timing Surface Copy/UI formatting helpers. They keep
 * `evidenceScope: "historical_conditional"` and `exploitEligible: false`
 * without abbreviation or omission.
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import { formatTimingSurfaceSummary } from "../lib/batch-backtest/batch-timing-surface-copy";
import type { TimingSurfaceResult } from "../lib/batch-backtest/batch-timing-surface-types";

function makeMinimalResult(overrides: Partial<TimingSurfaceResult> = {}): TimingSurfaceResult {
    return {
        schemaVersion: 1,
        fingerprint: "test-fingerprint",
        interval: "5m",
        generatedAt: 1_700_000_000_000,
        asOfTimeKey: "1700000000",
        stability: { reruns: 8, subsetSize: 10, seed: 1, totalPairs: 12, targetAssets: 1 },
        costModel: { commissionPercent: 0, slippageBps: 0, executionModel: "signal_close" },
        evidenceScope: "historical_conditional",
        exploitEligible: false,
        rows: [],
        rowCells: {},
        profile: {
            targetLoadMs: 0,
            subsetReconstructionMs: 0,
            analogReconstructionMs: 0,
            engineMs: 0,
            aggregationMs: 0,
            targetsEvaluated: 0,
            rerunsEvaluated: 0,
            cellsEvaluated: 0,
            cellsEmitted: 0,
            boundaryCheckedSamples: 0,
            boundaryPurgedSamples: 0,
        },
        warnings: [],
        ...overrides,
    };
}

describe("batch-timing-surface-copy — header always carries scope and exploit-eligible", () => {
    it("includes EVIDENCE_SCOPE historical_conditional and EXPLOIT_ELIGIBLE false", () => {
        const lines = formatTimingSurfaceSummary(makeMinimalResult());
        const joined = lines.join("\n");
        expect(joined).to.include("EVIDENCE_SCOPE historical_conditional");
        expect(joined).to.include("EXPLOIT_ELIGIBLE false");
        expect(joined).to.include("HISTORICAL_CONDITIONAL");
    });

    it("distinguishes evaluated and emitted cells and reports the boundary purge rate", () => {
        const result = makeMinimalResult({
            profile: {
                ...makeMinimalResult().profile,
                cellsEvaluated: 12,
                cellsEmitted: 4,
                boundaryCheckedSamples: 100,
                boundaryPurgedSamples: 25,
            },
        });
        const joined = formatTimingSurfaceSummary(result).join("\n");
        expect(joined).to.include("cellsEvaluated 12 | cellsEmitted 4");
        expect(joined).to.include("boundaryPurged 25/100 (25.0%)");
    });

    it("never abbreviates or omits the scope label even with rows", () => {
        const result = makeMinimalResult({
            rows: [{
                asset: "BTC",
                direction: "LONG",
                decision: "ENTER_NOW",
                reasonCodes: ["ACTIONABLE_NOW", "ACCEPTED_PLATEAU"],
                chosenDelay: 0,
                chosenHorizon: 12,
                evidenceDelay: 0,
                evidenceHorizon: 12,
                asOfTimeKey: "1700000000",
                revalidationBarIndex: null,
                sourceStabilityAction: "ENTER",
                discoveryEpisodes: 10,
                selectionEpisodes: 8,
                validationEpisodes: 6,
                discoveryEvaluatedReruns: 8,
                selectionEvaluatedReruns: 8,
                validationEvaluatedReruns: 8,
                discoveryQualifyingReruns: 8,
                selectionQualifyingReruns: 7,
                validationQualifyingReruns: 6,
                discoveryPositiveReruns: 7,
                selectionPositiveReruns: 6,
                validationPositiveReruns: 5,
                selectionMedianNetReturnPct: 1.5,
                selectionP10NetReturnPct: 0.4,
                selectionMedianLiftPct: null,
                validationMedianNetReturnPct: 0.8,
                validationP10NetReturnPct: 0.2,
                validationMedianLiftPct: null,
                medianWinRate: 0.6,
                plateauPositiveNeighborCount: 3,
                sourceTimingEdgeScore: 45,
            }],
        });
        const joined = formatTimingSurfaceSummary(result).join("\n");
        // Header still carries the scope verbatim.
        expect(joined).to.include("EVIDENCE_SCOPE historical_conditional");
        expect(joined).to.include("EXPLOIT_ELIGIBLE false");
        // Row exists with the chosen delay/horizon.
        expect(joined).to.include("ROW | BTC | LONG | ENTER_NOW");
        expect(joined).to.include("delay 0 | horizon 12b");
        expect(joined).to.include("evidenceCell d0h12");
        expect(joined).to.include("discoveryEvalReruns 8");
        expect(joined).to.include("validationQualReruns 6");
        expect(joined).to.include("selectionMedianWinRate 60.0%");
        expect(joined).to.include("valP10NetPct 0.200%");
        expect(joined).to.include("validationPositiveReruns 5/6");
        // No forbidden array field appears in the output.
        expect(joined).to.not.match(/\bdata:/);
        expect(joined).to.not.match(/\bsignals:/);
        expect(joined).to.not.match(/\btrades:/);
        expect(joined).to.not.match(/\bequityCurve:/);
    });

    it("emits a WATCH row with reason codes from the closed union", () => {
        const result = makeMinimalResult({
            rows: [{
                asset: "ETH",
                direction: "SHORT",
                decision: "WATCH",
                reasonCodes: ["ISOLATED_OPTIMUM"],
                chosenDelay: null,
                chosenHorizon: null,
                evidenceDelay: null,
                evidenceHorizon: null,
                asOfTimeKey: "1700000000",
                revalidationBarIndex: null,
                sourceStabilityAction: "ENTER",
                discoveryEpisodes: 0,
                selectionEpisodes: 0,
                validationEpisodes: 0,
                discoveryEvaluatedReruns: 0,
                selectionEvaluatedReruns: 0,
                validationEvaluatedReruns: 0,
                discoveryQualifyingReruns: 0,
                selectionQualifyingReruns: 0,
                validationQualifyingReruns: 0,
                discoveryPositiveReruns: 0,
                selectionPositiveReruns: 0,
                validationPositiveReruns: 0,
                selectionMedianNetReturnPct: null,
                selectionP10NetReturnPct: null,
                selectionMedianLiftPct: null,
                validationMedianNetReturnPct: null,
                validationP10NetReturnPct: null,
                validationMedianLiftPct: null,
                medianWinRate: null,
                plateauPositiveNeighborCount: 0,
                sourceTimingEdgeScore: 30,
            }],
        });
        const joined = formatTimingSurfaceSummary(result).join("\n");
        expect(joined).to.include("ROW | ETH | SHORT | WATCH");
        expect(joined).to.include("reasons [ISOLATED_OPTIMUM]");
    });
});
