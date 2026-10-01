import { expect } from "chai";
import { describe, it } from "node:test";
import { sweepScoreEvents } from "../lib/batch-backtest/open-score-replay/event-sweep";
import type { ScoreDelta } from "../lib/batch-backtest/open-score-replay/internal-types";

describe("OPEN_SCORE event sweep cancellation", () => {
    it("honors Stop during each bounded bucket-building pass", async () => {
        const chunkSize = 2_000;
        const deltas: ScoreDelta[] = Array.from({ length: chunkSize * 2 + 10 }, () => ({
            timeSec: 100,
            assetIndex: 0,
            delta: 1,
            isEntry: 1,
            pnlShare: 0,
            voteApplied: false,
            profitNowConfidenceWeight: 0,
        }));

        for (const targetStage of ["indexed decision times", "counted event deltas", "placed event deltas"]) {
            let stopRequested = false;
            const reports: string[] = [];
            const outcome = await sweepScoreEvents({
                streams: [deltas.slice()],
                profitableStreams: [false],
                sampleFromSec: undefined,
                sampleToSec: undefined,
                shouldStop: () => stopRequested,
                onPhase: (_phase, detail, completed) => {
                    reports.push(detail);
                    if (detail.startsWith(targetStage) && completed >= chunkSize) stopRequested = true;
                },
                pairCount: 1,
                assetCount: 1,
            });

            expect(outcome.ok, targetStage).to.equal(false);
            if (outcome.ok) throw new Error(`Expected cancellation during ${targetStage}.`);
            expect(outcome.earlyExit.reportLine).to.match(/cancelled during event sweep/i);
            expect(reports.some((detail) => detail.startsWith(targetStage)), targetStage).to.equal(true);
        }
    });
});
