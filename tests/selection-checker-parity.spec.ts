import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { getSelectionRule } from "../lib/selection-rules/registry";
import { loadSelectionArchive, tallySelectionRule, type SelectionOutcome } from "../lib/selection-rules/tally";
import type { PoolSnapshotRecord } from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

// Independent expected picks, never derived from either rule under test.
// FNV ties choose BBB at events 1/2 and AAA at event 3 under max_active_tie_v1.
// Event 0 distinguishes vote counts (TOP_RAW) from coverage-normalized scores (TOP_MEAN).
const CASES = [
    { votes: [8, 6, 2], counts: [20, 10, 10], mean: "BBB", raw: "AAA" },
    { votes: [4, 8, 3], counts: [10, 20, 10], mean: "BBB", raw: "BBB" },
    { votes: [8, 8, 2], counts: [10, 10, 10], mean: "BBB", raw: "BBB" },
    { votes: [8, 8, 2], counts: [10, 10, 10], mean: "AAA", raw: "AAA" },
    { votes: [3, 4, 9], counts: [10, 10, 10], mean: "CCC", raw: "CCC" },
] as const;
const ASSETS = ["AAA", "BBB", "CCC"] as const;
const START_SEC = 1_700_006_400;
const eventTime = (index: number) => START_SEC + index * 14_400;
const eventId = (index: number) => `4h:${eventTime(index)}`;
const assetReturn = (asset: string) => (ASSETS.indexOf(asset as typeof ASSETS[number]) + 1) / 10;

function writeArchive(folder: string): void {
    const snapshots: PoolSnapshotRecord[] = [];
    const outcomes: SelectionOutcome[] = [];
    const baselines: Record<string, unknown>[] = [];
    for (const [index, fixture] of CASES.entries()) {
        for (const [assetIndex, asset] of ASSETS.entries()) {
            snapshots.push({
                eventId: eventId(index), decisionTimeSec: eventTime(index), interval: "4h", poolVersion: null,
                asset, inPool: true, activePairCount: fixture.counts[assetIndex]!,
                signedVotes: fixture.votes[assetIndex]!, score: fixture.votes[assetIndex]! / fixture.counts[assetIndex]!,
                longEligible: true, shortEligible: false, ema200Above: true, breadth: 0.6, regime: "bullish",
            });
            for (const direction of ["long", "short"] as const) {
                outcomes.push({
                    eventId: eventId(index), decisionTimeSec: eventTime(index), horizonBars: 24, direction,
                    asset, inPool: true, eligible: true, return: assetReturn(asset) * (direction === "long" ? 1 : -1),
                    entryTimeSec: eventTime(index) + 14_400, exitTimeSec: eventTime(index) + 25 * 14_400, status: "ok",
                });
            }
        }
        for (const [selector, asset] of [["TOP_MEAN", fixture.mean], ["TOP_RAW", fixture.raw]]) {
            baselines.push({
                eventId: eventId(index), decisionTime: eventTime(index), horizonBars: 24, direction: "long",
                selector, asset, selectedReturn: assetReturn(asset!), controlReturn: 0,
            });
        }
    }
    const files: Record<string, string> = {};
    for (const [filename, rows] of Object.entries({
        "pool-snapshots.jsonl": snapshots,
        "candidate-outcomes.jsonl": outcomes,
        "events-full.jsonl": baselines,
    })) {
        const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
        writeFileSync(join(folder, filename), text);
        files[filename] = createHash("sha256").update(text).digest("hex");
    }
    writeFileSync(join(folder, "meta.json"), JSON.stringify({
        schema: "top_mean_archive.v3", runId: basename(folder), interval: "4h", horizons: [24], files,
    }));
}

describe("selection checker P1 parity", () => {
    let archiveFolder: string;
    before(() => {
        archiveFolder = mkdtempSync(join(tmpdir(), "selection-parity-"));
        writeArchive(archiveFolder);
    });
    after(() => rmSync(archiveFolder, { recursive: true, force: true }));

    for (const [key, selector, expectedTies] of [
        ["top_mean", "TOP_MEAN", 3], ["top_raw", "TOP_RAW", 2],
    ] as const) {
        it(`reproduces every archived ${selector} pick, including ties`, () => {
            const archive = loadSelectionArchive(archiveFolder);
            const rule = getSelectionRule(key);
            expect(rule).to.not.equal(undefined);
            const result = tallySelectionRule(archive, rule!);
            const expected = CASES.map((fixture, index) => ({
                eventId: eventId(index), asset: key === "top_mean" ? fixture.mean : fixture.raw,
            }));
            const baseline = [...archive.baselines.values()]
                .filter((row) => row.selector === selector && row.direction === "long" && row.horizonBars === 24)
                .map(({ eventId, asset }) => ({ eventId, asset }));
            expect(baseline).to.deep.equal(expected);
            expect(result.picks.map(({ eventId, asset }) => ({ eventId, asset }))).to.deep.equal(expected);
            expect(result.horizons[0]!.eligibleEvents).to.equal(CASES.length);
            expect(result.picks.filter((pick) => pick.tiedCount > 1)).to.have.length(expectedTies);
        });
    }

    it("keeps outcome rows out of rule inputs", () => {
        const archive = loadSelectionArchive(archiveFolder);
        const rule = getSelectionRule("top_mean")!;
        const before = tallySelectionRule(archive, rule);
        // AAA is not selected at event 0, so its return changes the others-mean benchmark.
        const outcome = [...archive.outcomes.values()].find((row) =>
            row.eventId === eventId(0) && row.direction === "long" && row.asset === "AAA")!;
        outcome.return = outcome.return! + 0.25;
        const after = tallySelectionRule(archive, rule);
        expect(before.picks).to.have.length(CASES.length);
        expect(after.picks).to.deep.equal(before.picks);
        expect(after.horizons[0]!.comparisons.othersMean.benchmark.mean)
            .to.not.equal(before.horizons[0]!.comparisons.othersMean.benchmark.mean);
    });
});
