import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import {
    augmentReportWithTakeSkipLines,
    countPositiveDeltaBlocks,
    evaluateGates,
    type EvalEvent,
} from "../scripts/take-skip-eval";

const LEDGER_DIR = path.resolve("archive/batch-open-score/sp500_top_mean_1788560534200_jedw");
const REPORT_PATH = path.join(LEDGER_DIR, "report.txt");

function runReport(): { status: number | null; stdout: string; stderr: string } {
    const esno = path.resolve(process.cwd(), "../../../node_modules/esno/esno.js");
    const script = path.resolve(process.cwd(), "scripts/take-skip-eval.ts");
    const result = spawnSync(process.execPath, [
        esno,
        script,
        LEDGER_DIR,
        "--report",
        "--window",
        "discovery",
    ], {
        cwd: process.cwd(),
        encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeEvent(index: number, asset: string, incReturn: number): EvalEvent {
    const candidate = {
        eventId: `4h:${index}`,
        decisionTimeSec: index,
        asset,
        signedVotes: 8,
        activePairCount: 10,
        longEligible: true,
        ema200Above: true,
        breadth: 0.6,
        regime: "bullish",
    };
    return {
        t: index,
        eventId: candidate.eventId,
        inc: candidate,
        incReturn,
        candidates: [candidate],
    };
}

describe("take-skip-eval report mode", () => {
    it("inserts both lines immediately after the first full-report TOP_MEAN line", () => {
        const before = readFileSync(REPORT_PATH);
        const result = runReport();
        assert.equal(result.status, 0, result.stderr);

        const lines = result.stdout.split(/\r?\n/);
        const topMeanIndex = lines.findIndex((line) => /^TOP_MEAN\s+n=/.test(line));
        assert.ok(topMeanIndex >= 0);
        assert.match(lines[topMeanIndex + 1]!, /^LOSS_VETO\s+n=619\s+top=\+13\.37%\s+all=\+5\.07%\s+skip=\+3516\.82pp\s+\+blocks=\d+\/10$/);
        assert.match(lines[topMeanIndex + 2]!, /^REGIME_FLOOR\s+n=592\s+top=\+12\.67%\s+all=\+5\.07%\s+skip=\+2743\.82pp\s+\+blocks=\d+\/10$/);
        assert.match(lines[topMeanIndex + 3]!, /^TOP_MEAN_RAW_UNIQUE_V1\s+n=/);
        assert.deepEqual(readFileSync(REPORT_PATH), before, "report.txt must remain byte-for-byte unchanged");
    });

    it("uses the exact ten-block partition and positive delta count", () => {
        const deltas = Array.from({ length: 20 }, () => 0);
        deltas[2] = 1;
        assert.equal(countPositiveDeltaBlocks(deltas), 1);

        const events = [
            makeEvent(0, "A", 1),
            makeEvent(1, "A", -1),
            makeEvent(2, "A", -1),
            makeEvent(3, "B", 1),
            ...Array.from({ length: 16 }, (_, offset) => makeEvent(offset + 4, `C${offset}`, 1)),
        ];
        const evaluations = evaluateGates(events);
        const lossVeto = evaluations.find((evaluation) => evaluation.name === "same_asset_two_loss_veto")!;
        const regimeFloor = evaluations.find((evaluation) => evaluation.name === "global_return_regime_10")!;
        assert.equal(lossVeto.taken, 19);
        assert.equal(lossVeto.positiveBlocks, 1);
        assert.equal(regimeFloor.taken, 20);
        assert.equal(regimeFloor.positiveBlocks, 0);
    });

    it("rejects a missing TOP_MEAN line", () => {
        const report = [
            "OPEN_SCORE USD | DATA_COMPLETE",
            "--- horizon 24 bar(s) | coverage=1/1 FULL ---",
            "TOP_RAW n=1",
        ].join("\n");
        assert.throws(
            () => augmentReportWithTakeSkipLines(report, ["LOSS_VETO    n=1", "REGIME_FLOOR n=1"]),
            /TOP_MEAN line is missing/,
        );
    });

    it("rejects duplicate insertion", () => {
        const report = [
            "OPEN_SCORE USD | DATA_COMPLETE",
            "--- horizon 24 bar(s) | coverage=1/1 FULL ---",
            "TOP_MEAN       n=1",
            "LOSS_VETO    n=1",
        ].join("\n");
        assert.throws(
            () => augmentReportWithTakeSkipLines(report, ["LOSS_VETO    n=1", "REGIME_FLOOR n=1"]),
            /already exist/,
        );
    });
});
