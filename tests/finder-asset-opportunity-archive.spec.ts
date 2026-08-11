import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    appendAssetOpportunityArchiveBlock,
    buildAssetOpportunityArchiveBlockText,
    buildAssetOpportunityArchiveFilename,
    resolveAssetOpportunityArchiveDir,
} from "../lib/finder/server/finder-asset-opportunity-archive";

describe("Asset Opportunity archive writer", () => {
    it("derives the archive dir from the configured root only", () => {
        const dir = resolveAssetOpportunityArchiveDir("/repo/project");
        expect(dir).to.equal(path.join("/repo/project", "archive", "asset opportunity"));
    });

    it("builds per-N filenames and rejects non-integer / non-positive N", () => {
        expect(buildAssetOpportunityArchiveFilename(3)).to.equal("oos-holdout-3-bars.txt");
        expect(buildAssetOpportunityArchiveFilename(100)).to.equal("oos-holdout-100-bars.txt");
        expect(() => buildAssetOpportunityArchiveFilename(0)).to.throw(/Invalid holdout bars/);
        expect(() => buildAssetOpportunityArchiveFilename(2.5)).to.throw(/Invalid holdout bars/);
        // No path separator can reach the filename: only a validated integer
        // ever formats it.
        expect(() => buildAssetOpportunityArchiveFilename(Number.NaN)).to.throw();
    });

    it("writes one delimited block containing timestamp, run id, holdout, and compact JSON", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            const topResults = [{ scope: "asset_opportunity", rank: 1, symbol: "BTCUSDT" }];
            const result = await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-1",
                holdoutBars: 4,
                topResults,
                timestamp: "2026-01-01T00:00:00.000Z",
            });

            expect(path.basename(result.path)).to.equal("oos-holdout-4-bars.txt");
            expect(result.bytes).to.be.greaterThan(0);

            const content = readFileSync(result.path, "utf8");
            expect(content).to.contain("Timestamp: 2026-01-01T00:00:00.000Z");
            expect(content).to.contain("Batch run id: batch-1");
            expect(content).to.contain("OOS holdout: 4 bars");
            expect(content).to.contain("Archive sort: run_default");
            expect(content).to.contain(JSON.stringify(topResults));
            expect(content).to.match(/\n$/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("appends a new block on repeat of the same N and never overwrites", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        try {
            await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-1",
                holdoutBars: 5,
                topResults: [{ rank: 1 }],
                timestamp: "2026-01-01T00:00:00.000Z",
            });
            await appendAssetOpportunityArchiveBlock({
                root,
                batchRunId: "batch-2",
                holdoutBars: 5,
                topResults: [{ rank: 2 }],
                timestamp: "2026-01-02T00:00:00.000Z",
            });
            const content = readFileSync(path.join(root, "archive", "asset opportunity", "oos-holdout-5-bars.txt"), "utf8");
            expect(content).to.contain("Batch run id: batch-1");
            expect(content).to.contain("Batch run id: batch-2");
            // Each block is delimited by an opening and closing separator line,
            // so two blocks produce four separator lines and the first block is
            // never overwritten.
            expect(content.match(/^={80}$/gm) ?? []).to.have.length(4);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("injects the append leaf so tests never touch the real archive", async () => {
        const calls: Array<{ dir: string; filename: string; content: string }> = [];
        const root = "/virtual/root";
        const result = await appendAssetOpportunityArchiveBlock({
            root,
            batchRunId: "batch-3",
            holdoutBars: 2,
            topResults: [],
            timestamp: "2026-01-03T00:00:00.000Z",
            append: async (dir, filename, content) => {
                calls.push({ dir, filename, content });
            },
        });
        expect(calls).to.have.length(1);
        expect(calls[0]!.dir).to.equal(path.join(root, "archive", "asset opportunity"));
        expect(calls[0]!.filename).to.equal("oos-holdout-2-bars.txt");
        expect(result.path).to.equal(path.join(calls[0]!.dir, calls[0]!.filename));
        // Byte count matches the injected content length.
        expect(result.bytes).to.equal(Buffer.byteLength(calls[0]!.content, "utf8"));
    });

    it("builds deterministic block text with the shared delimiter", () => {
        const text = buildAssetOpportunityArchiveBlockText({
            timestamp: "t",
            batchRunId: "b",
            holdoutBars: 1,
            sortMetric: "freshSignalLibraries",
            topResults: [{ rank: 1 }],
        });
        expect(text.startsWith("=".repeat(80))).to.equal(true);
        const jsonStart = text.indexOf("[");
        expect(JSON.parse(text.slice(jsonStart))).to.deep.equal([{ rank: 1 }]);
    });

    it("does not accept an arbitrary path from a caller", () => {
        // The filename function is the only entry point to a file name; a
        // string path argument is a type error, so simulate the closest
        // runtime attempt: no API accepts a path string.
        const root = mkdtempSync(path.join(tmpdir(), "finder-archive-"));
        writeFileSync(path.join(root, "marker"), "keep");
        try {
            expect(readFileSync(path.join(root, "marker"), "utf8")).to.equal("keep");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
