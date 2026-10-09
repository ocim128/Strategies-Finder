import { expect } from "chai";
import { describe, it } from "node:test";
import { sweepScoreEvents } from "../lib/batch-backtest/open-score-replay/event-sweep";
import type { ScoreDelta } from "../lib/batch-backtest/open-score-replay/internal-types";
import { ScoreDeltaBuffer } from "../lib/batch-backtest/open-score-replay/score-delta-buffer";
import type { IndexedScoreDeltas } from "../lib/batch-backtest/open-score-replay/event-sweep";

describe("OPEN_SCORE event sweep cancellation", () => {
    it("yields to Stop during a reused delta-index sweep", async () => {
        const deltas: ScoreDelta[] = Array.from({ length: 4_100 }, (_, i) => ({
            timeSec: i, assetIndex: 0, delta: 1, isEntry: 1, pnlShare: 0,
            voteApplied: false, profitNowConfidenceWeight: 0,
        }));
        let index: IndexedScoreDeltas | undefined;
        const args = { streams: [ScoreDeltaBuffer.from(deltas)], profitableStreams: [false],
            sampleFromSec: undefined, sampleToSec: undefined, pairCount: 1, assetCount: 1,
            shouldStop: () => false, onPhase: () => undefined };
        const first = await sweepScoreEvents({ ...args, onIndexedDeltas: (value) => { index = value; } });
        expect(first.ok).to.equal(true);
        expect(args.streams).to.have.length(0);
        let stopped = false;
        const reused = await sweepScoreEvents({ ...args, indexedDeltas: index,
            shouldStop: () => stopped,
            onPhase: (_phase, detail) => {
                if (detail.startsWith("merged ")) setImmediate(() => { stopped = true; });
            },
        });
        expect(stopped).to.equal(true);
        expect(reused.ok).to.equal(false);
    });
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
                streams: [ScoreDeltaBuffer.from(deltas)],
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
