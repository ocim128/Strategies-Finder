import { expect } from "chai";
import { describe, it } from "node:test";
import path from "node:path";
import {
    appendFinderRunLogEvent,
    buildFinderRunLogFilename,
    resolveFinderRunLogDir,
} from "../lib/finder/server/finder-run-log";

describe("Finder run log", () => {
    it("resolves to <root>/archive/finder-runs by default", () => {
        expect(resolveFinderRunLogDir("/repo/project", {})).to.equal(
            path.join("/repo/project", "archive", "finder-runs"),
        );
    });

    it("honors the FINDER_RUN_LOG_DIR override", () => {
        expect(resolveFinderRunLogDir("/repo/project", { FINDER_RUN_LOG_DIR: "/logs/finder" }))
            .to.equal(path.resolve("/logs/finder"));
        // Relative overrides resolve against the process cwd.
        expect(resolveFinderRunLogDir("/repo/project", { FINDER_RUN_LOG_DIR: "logs" }))
            .to.equal(path.resolve("logs"));
    });

    it("sanitizes run ids so a pathological value cannot smuggle path segments", () => {
        expect(buildFinderRunLogFilename("batch-2026-08-12_T01")).to.equal("batch-2026-08-12_T01.jsonl");
        // Separators and whitespace are replaced; dots are preserved (they are
        // safe inside a single filename segment).
        expect(buildFinderRunLogFilename("../evil/run id")).to.equal(".._evil_run_id.jsonl");
        expect(buildFinderRunLogFilename("")).to.equal("run.jsonl");
    });

    it("appends one JSON line per event through the injectable append leaf", async () => {
        const writes: Array<{ dir: string; filename: string; content: string }> = [];
        await appendFinderRunLogEvent({
            root: "/virtual/root",
            runId: "run-1",
            event: "asset_failed",
            data: { symbol: "BTCUSDT", reason: "no data" },
            ts: 1_700_000_000_000,
            append: async (dir, filename, content) => {
                writes.push({ dir, filename, content });
            },
        });
        expect(writes).to.have.length(1);
        expect(writes[0]!.dir).to.equal(path.join("/virtual/root", "archive", "finder-runs"));
        expect(writes[0]!.filename).to.equal("run-1.jsonl");
        const parsed = JSON.parse(writes[0]!.content);
        expect(parsed.ts).to.equal(1_700_000_000_000);
        expect(parsed.runId).to.equal("run-1");
        expect(parsed.event).to.equal("asset_failed");
        expect(parsed.symbol).to.equal("BTCUSDT");
        expect(parsed.reason).to.equal("no data");
    });
});
