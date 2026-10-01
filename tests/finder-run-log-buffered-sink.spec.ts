/**
 * Buffered JSONL run-log sink for Finder Asset Opportunity runs.
 *
 * A large batch emits ~100k `asset_complete` events; the unbuffered sink
 * issued one mkdir + one appendFile PER EVENT (~200k syscalls). The buffered
 * sink must collapse those into a few chunked appends while preserving:
 *
 *  - the line schema (`{ts, runId, event, ...data}`) and line ORDER;
 *  - immediate flushes at iteration boundaries (durability points — every
 *    completed iteration is on disk before the next archive append);
 *  - fire-and-forget failure semantics (a failed flush warns and clears the
 *    buffer; it never throws into the run and never retries stale lines).
 *
 * All filesystem effects are captured through the injectable `append` leaf —
 * no real archive directory is touched.
 */

import { expect } from "chai";
import { describe, it } from "node:test";
import {
    appendFinderRunLogEvent,
    buildFinderRunLogFilename,
    createBufferedFinderRunLogSink,
    resolveFinderRunLogDir,
    type FinderRunLogAppend,
} from "../lib/finder/server/finder-run-log";

interface CapturedAppend {
    dir: string;
    filename: string;
    content: string;
}

function createCaptureAppend(captures: CapturedAppend[], hooks?: { failOnce?: boolean }): {
    append: FinderRunLogAppend;
    calls: () => number;
} {
    let calls = 0;
    return {
        append: async (dir, filename, content) => {
            calls += 1;
            if (hooks?.failOnce && calls === 1) {
                throw new Error("simulated flush failure");
            }
            captures.push({ dir, filename, content });
        },
        calls: () => calls,
    };
}

function parseLines(captures: CapturedAppend[]): Array<Record<string, unknown>> {
    return captures
        .flatMap((capture) => capture.content.split("\n").filter((line) => line !== ""))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ROOT = "/virtual/root";
const RUN_ID = "buffered-sink-test";

async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

describe("finder run-log buffered sink", () => {
    it("awaits buffered and in-flight appends at explicit candidate durability boundaries", async () => {
        const captures: CapturedAppend[] = [];
        let releaseAppend!: () => void;
        const gate = new Promise<void>((resolve) => { releaseAppend = resolve; });
        const sink = createBufferedFinderRunLogSink(ROOT, RUN_ID, {
            flushAfterMs: Number.POSITIVE_INFINITY,
            boundaryEvents: new Set(["arm_candidate_complete"]),
            append: async (dir, filename, content) => {
                await gate;
                captures.push({ dir, filename, content });
            },
        });
        sink("arm_candidate_complete", { candidateOrdinal: 0 });
        sink("arm_candidate_failed", { candidateOrdinal: 1 });
        let drained = false;
        const pending = sink.flush().then(() => { drained = true; });
        await flushMicrotasks();
        expect(drained).to.equal(false);
        releaseAppend();
        await pending;
        expect(drained).to.equal(true);
        expect(captures.flatMap((capture) => capture.content.trim().split("\n"))
            .map((line) => JSON.parse(line).event)).to.deep.equal(["arm_candidate_complete", "arm_candidate_failed"]);
        await sink.flush();
        expect(captures).to.have.length(2, "empty flush does not append again");
    });

    it("keeps explicit diagnostic flushing best-effort after write failure", async () => {
        let warnings = 0;
        const sink = createBufferedFinderRunLogSink(ROOT, RUN_ID, {
            flushAfterMs: Number.POSITIVE_INFINITY,
            append: async () => { throw new Error("disk unavailable"); },
            onWriteError: () => { warnings += 1; },
        });
        sink("arm_candidate_failed", { candidateOrdinal: 0 });
        await sink.flush();
        expect(warnings).to.equal(1);
    });

    it("collapses a burst of asset events into one chunked append at the line cap", async () => {
        const captures: CapturedAppend[] = [];
        const capture = createCaptureAppend(captures);
        const sink = createBufferedFinderRunLogSink(ROOT, RUN_ID, {
            append: capture.append,
            // Timer-based flush disabled so the spec is deterministic: only
            // the 256-line cap and boundary events flush.
            flushAfterMs: Number.POSITIVE_INFINITY,
        });

        for (let index = 0; index < 300; index += 1) {
            sink("asset_complete", { symbol: `SYM${index}`, assetIndex: index });
        }
        await flushMicrotasks();

        // One append for the first 256 lines; 44 remain buffered (no timer).
        expect(capture.calls()).to.equal(1);
        const lines = parseLines(captures);
        expect(lines.length).to.equal(256);
        expect(lines[0]).to.include({ runId: RUN_ID, event: "asset_complete", symbol: "SYM0" });
        expect(captures[0]!.dir).to.equal(resolveFinderRunLogDir(ROOT));
        expect(captures[0]!.filename).to.equal(buildFinderRunLogFilename(RUN_ID));
    });

    it("flushes immediately on iteration boundary events, preserving order", async () => {
        const captures: CapturedAppend[] = [];
        const capture = createCaptureAppend(captures);
        const sink = createBufferedFinderRunLogSink(ROOT, RUN_ID, {
            append: capture.append,
            flushAfterMs: Number.POSITIVE_INFINITY,
        });

        sink("iteration_start", { symbols: 2 });
        for (let index = 0; index < 5; index += 1) {
            sink("asset_complete", { symbol: `SYM${index}` });
        }
        sink("iteration_complete", { retainedResults: 3 });
        await flushMicrotasks();

        // Flush #1: the boundary event alone. Flush #2: the 5 buffered asset
        // lines ride along with the closing boundary. 2 appends, 7 lines,
        // order preserved.
        expect(capture.calls()).to.equal(2);
        expect(captures[0]!.content.split("\n").filter((line) => line !== "")).to.have.lengthOf(1);
        const lines = parseLines(captures);
        expect(lines.map((line) => line.event)).to.deep.equal([
            "iteration_start",
            ...Array.from({ length: 5 }, () => "asset_complete"),
            "iteration_complete",
        ]);
    });

    it("warns and clears the buffer on a failed flush; later events still land", async () => {
        const captures: CapturedAppend[] = [];
        const errors: unknown[] = [];
        let firstAppendConsumed = false;
        let calls = 0;
        const append: FinderRunLogAppend = async (dir, filename, content) => {
            calls += 1;
            if (!firstAppendConsumed) {
                firstAppendConsumed = true;
                throw new Error("simulated flush failure");
            }
            captures.push({ dir, filename, content });
        };
        const sink = createBufferedFinderRunLogSink(ROOT, RUN_ID, {
            append,
            flushAfterMs: Number.POSITIVE_INFINITY,
            onWriteError: (error) => errors.push(error),
        });

        sink("iteration_start", { symbols: 1 });          // flush #1: fails
        sink("asset_complete", { symbol: "LATE" });
        sink("iteration_complete", { retainedResults: 1 }); // flush #2: succeeds
        await flushMicrotasks();

        expect(calls).to.equal(2);
        expect(errors.length).to.equal(1);
        // The failed chunk was dropped (never retried); only the post-failure
        // lines are in the successful append.
        const lines = parseLines(captures);
        expect(lines.map((line) => line.event)).to.deep.equal(["asset_complete", "iteration_complete"]);
    });

    it("keeps the line schema identical to appendFinderRunLogEvent", async () => {
        const singleCapture: CapturedAppend[] = [];
        await appendFinderRunLogEvent({
            root: ROOT,
            runId: RUN_ID,
            event: "asset_complete",
            data: { symbol: "SYM", durationMs: 7 },
            ts: 1234567890,
            append: async (dir, filename, content) => {
                singleCapture.push({ dir, filename, content });
            },
        });

        const bufferedCapture: CapturedAppend[] = [];
        const sink = createBufferedFinderRunLogSink(ROOT, RUN_ID, {
            append: async (dir, filename, content) => {
                bufferedCapture.push({ dir, filename, content });
            },
            flushAfterMs: Number.POSITIVE_INFINITY,
        });
        sink("asset_complete", { symbol: "SYM", durationMs: 7, ts: 1234567890 });
        sink("iteration_complete", {});
        await flushMicrotasks();

        // Same JSON fields, same order (ts/runId/event first). The buffered
        // chunk is multi-line; compare its first line (the asset_complete).
        const expected = JSON.parse(singleCapture[0]!.content) as Record<string, unknown>;
        const firstLine = bufferedCapture[0]!.content.split("\n")[0]!;
        const actual = JSON.parse(firstLine) as Record<string, unknown>;
        expect(actual).to.deep.equal(expected);
        expect(bufferedCapture[0]!.content.endsWith("\n")).to.equal(true);
    });
});
