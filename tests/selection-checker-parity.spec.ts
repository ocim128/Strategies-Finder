import { expect } from "chai";
import { describe, it } from "node:test";
import path from "node:path";
import { getSelectionRule } from "../lib/selection-rules/registry";
import { loadSelectionArchive, tallySelectionRule } from "../lib/selection-rules/tally";

const archiveFolder = path.resolve("archive/batch-open-score/sp500_top_mean_1788560534200_jedw");

describe("selection checker P1 parity", () => {
    it("reproduces every archived TOP_MEAN pick, including ties", () => {
        const archive = loadSelectionArchive(archiveFolder);
        const rule = getSelectionRule("top_mean");
        expect(rule).to.not.equal(undefined);
        const result = tallySelectionRule(archive, rule!);
        const horizon = result.horizons.find((entry) => entry.horizonBars === 24)!;
        const expected = [...archive.baselines.values()]
            .filter((row) => row.selector === "TOP_MEAN" && row.direction === "long" && row.horizonBars === 24)
            .sort((left, right) => left.decisionTimeSec - right.decisionTimeSec || left.eventId.localeCompare(right.eventId));
        const actual = result.picks
            .filter((pick) => pick.horizonBars === 24)
            .sort((left, right) => left.decisionTimeSec - right.decisionTimeSec || left.eventId.localeCompare(right.eventId));
        let matched = 0;
        for (let index = 0; index < expected.length; index += 1) {
            expect(actual[index]?.eventId).to.equal(expected[index]?.eventId);
            expect(actual[index]?.asset).to.equal(expected[index]?.asset);
            matched += 1;
        }
        const tiedEvents = actual.filter((pick) => pick.tiedCount > 1).length;
        expect(expected.length).to.equal(937);
        expect(actual.length).to.equal(937);
        expect(matched).to.equal(937);
        expect(horizon.eligibleEvents).to.equal(937);
        expect(tiedEvents).to.equal(230);
        console.log(`TOP_MEAN parity: ${matched}/${expected.length} picks matched; tied events=${tiedEvents}`);
    });

    it("keeps outcome rows out of rule inputs", () => {
        const archive = loadSelectionArchive(archiveFolder);
        const rule = getSelectionRule("top_mean")!;
        const before = tallySelectionRule(archive, rule);
        const outcome = [...archive.outcomes.values()].find((row) => row.direction === "long" && row.return !== null)!;
        outcome.return = outcome.return! + 0.25;
        const after = tallySelectionRule(archive, rule);
        expect(after.picks.map((pick) => `${pick.horizonBars}|${pick.eventId}|${pick.asset}`))
            .to.deep.equal(before.picks.map((pick) => `${pick.horizonBars}|${pick.eventId}|${pick.asset}`));
        expect(after.horizons[0]!.comparisons.othersMean.benchmark.mean)
            .to.not.equal(before.horizons[0]!.comparisons.othersMean.benchmark.mean);
        console.log("TOP_MEAN leakage regression: picks unchanged after outcome mutation");
    });

    it("reproduces every archived TOP_RAW pick", () => {
        const archive = loadSelectionArchive(archiveFolder);
        const rule = getSelectionRule("top_raw");
        expect(rule).to.not.equal(undefined);
        const result = tallySelectionRule(archive, rule!);
        const expected = [...archive.baselines.values()]
            .filter((row) => row.selector === "TOP_RAW" && row.direction === "long" && row.horizonBars === 24)
            .sort((left, right) => left.decisionTimeSec - right.decisionTimeSec || left.eventId.localeCompare(right.eventId));
        const actual = result.picks
            .filter((pick) => pick.horizonBars === 24)
            .sort((left, right) => left.decisionTimeSec - right.decisionTimeSec || left.eventId.localeCompare(right.eventId));
        let matched = 0;
        for (let index = 0; index < expected.length; index += 1) {
            expect(actual[index]?.eventId).to.equal(expected[index]?.eventId);
            expect(actual[index]?.asset).to.equal(expected[index]?.asset);
            matched += 1;
        }
        const tiedEvents = actual.filter((pick) => pick.tiedCount > 1).length;
        expect(expected.length).to.equal(937);
        expect(actual.length).to.equal(937);
        expect(matched).to.equal(937);
        console.log(`TOP_RAW parity: ${matched}/${expected.length} picks matched; tied events=${tiedEvents}`);
    });
});
