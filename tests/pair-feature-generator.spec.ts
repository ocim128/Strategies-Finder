import { expect } from "chai";
import { describe, it, after } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { decodeFloat64Le, decodeUint32Le, decodeUint8 } from "../lib/pair-features/artifact-io";
import {
    generatePairFeaturePack,
    SOURCE_REQUIRED_MESSAGE,
    validatePairFeatureSnapshot,
    validatePairFeatureSnapshotForGeneration,
} from "../lib/pair-features/generate";
import { ensurePairFeatures } from "../lib/pair-selection/feature-access";
import type { PairFeatureFamilyManifest, PairFeaturePackManifest } from "../lib/pair-features/types";
import { createPairFeatureFixture } from "./fixtures/pair-features/fixture";
import { spreadRule } from "./fixtures/pair-features/rules";

const roots: string[] = [];

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "pair-feature-generator-"));
    roots.push(root);
    return root;
}

async function loadFamily(root: string, pack: PairFeaturePackManifest, familyId: string): Promise<PairFeatureFamilyManifest> {
    const reference = pack.familyManifests.find((candidate) => candidate.path.includes(`/families/${familyId}/`));
    expect(reference).to.not.equal(undefined);
    return JSON.parse((await readFile(join(root, ...reference!.path.split("/")))).toString("utf8")) as PairFeatureFamilyManifest;
}

async function loadColumn(root: string, path: string, kind: "values" | "valid" | "observations"): Promise<number[]> {
    const bytes = await readFile(join(root, ...path.split("/")));
    return kind === "values" ? decodeFloat64Le(bytes) : kind === "valid" ? decodeUint8(bytes) : decodeUint32Le(bytes);
}

async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    try {
        await promise;
    } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).to.match(pattern);
        return;
    }
    expect.fail("Expected the promise to reject.");
}

describe("offline pair feature generator", () => {
    after(() => {
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    it("generates causal columns, contiguous row artifacts, and an immutable pack", async () => {
        const root = makeRoot();
        const fixture = await createPairFeatureFixture(root);
        const result = await generatePairFeaturePack(root, "v0", [
            "feat_fp_trade_mean_net_pct_t8_r1",
            "feat_fp_spread_log_return_b12_r1_n",
            "feat_fp_spread_log_return_b12_r1",
        ].filter((id, index, ids) => ids.indexOf(id) === index));
        const pack = JSON.parse(readFileSync(join(root, ...result.packPath.split("/")), "utf8")) as PairFeaturePackManifest;
        expect(pack.requestedFeatureIds).to.deep.equal([
            "feat_fp_spread_log_return_b12_r1",
            "feat_fp_spread_log_return_b12_r1_n",
            "feat_fp_trade_mean_net_pct_t8_r1",
        ]);
        expect(pack.ledgerRowCount).to.equal(3);
        expect(pack.sourceSnapshotSha256).to.match(/^[0-9a-f]{64}$/);

        const spread = await loadFamily(root, pack, "spread");
        const trades = await loadFamily(root, pack, "trades");
        expect(spread.features).to.have.length(1);
        expect(trades.features).to.have.length(1);
        const spreadPair = spread.features[0]!.pairs[0]!;
        const tradePair = trades.features[0]!.pairs[0]!;
        expect(spreadPair.pairKey).to.equal(fixture.pairKey);
        expect(spreadPair.rowCount).to.equal(fixture.entries.length);
        expect(spreadPair.nullCount).to.equal(1);
        expect(tradePair.nullCount).to.equal(2);
        expect(await loadColumn(root, spreadPair.values.path, "values")).to.deep.equal([
            0,
            Math.log(4096) - Math.log(1),
            Math.log(1) - Math.log(128),
        ]);
        expect(await loadColumn(root, spreadPair.valid.path, "valid")).to.deep.equal([0, 1, 1]);
        expect(await loadColumn(root, spreadPair.observations.path, "observations")).to.deep.equal([12, 13, 13]);
        expect(await loadColumn(root, tradePair.values.path, "values")).to.deep.equal([0, 0, 4.5]);
        expect(await loadColumn(root, tradePair.valid.path, "valid")).to.deep.equal([0, 0, 1]);
        expect(await loadColumn(root, tradePair.observations.path, "observations")).to.deep.equal([0, 1, 8]);
        expect(fixture.bars).to.have.length(30);
        expect(fixture.trades).to.have.length(9);
        expect(result.computedColumns).to.equal(6);
        expect(result.reusedColumns).to.equal(0);
    });

    it("keeps a zero-entry pair valid", async () => {
        const root = makeRoot();
        await createPairFeatureFixture(root, { entries: [] });
        const result = await generatePairFeaturePack(root, "v0", ["feat_fp_spread_log_return_b12_r1"]);
        expect(result.computedColumns).to.equal(3);
        const pack = JSON.parse(readFileSync(join(root, ...result.packPath.split("/")), "utf8")) as PairFeaturePackManifest;
        const family = await loadFamily(root, pack, "spread");
        const pair = family.features[0]!.pairs[0]!;
        expect(pair.rowCount).to.equal(0);
        expect(pair.nullCount).to.equal(0);
        expect(pair.observationMin).to.equal(0);
        expect(pair.observationMax).to.equal(0);
        expect(await loadColumn(root, pair.values.path, "values")).to.deep.equal([]);
    });

    it("folds pre-window accepted entries into fire history without inflating support", async () => {
        const root = makeRoot();
        const fixture = await createPairFeatureFixture(root, {
            entries: [[0, 20, "long", 1020]],
            warmupEntries: [
                [1, "long", 1001],
                [5, "short", 1005],
                [10, "long", 1010],
            ],
        });
        const result = await generatePairFeaturePack(root, "v1", [
            "feat_pairFiresInLast20Bars",
            "feat_pairInterFireIntervalCvPrior",
        ]);
        const pack = JSON.parse(readFileSync(join(root, ...result.packPath.split("/")), "utf8")) as PairFeaturePackManifest;
        const family = await loadFamily(root, pack, "fires");
        const fire = family.features.find((feature) => feature.id === "feat_pairFiresInLast20Bars")!.pairs[0]!;
        const cadence = family.features.find((feature) => feature.id === "feat_pairInterFireIntervalCvPrior")!.pairs[0]!;
        expect(await loadColumn(root, fire.values.path, "values")).to.deep.equal([3]);
        expect(await loadColumn(root, fire.observations.path, "observations")).to.deep.equal([20]);
        expect((await loadColumn(root, cadence.values.path, "values"))[0]).to.be.closeTo(1 / 9, 1e-12);
        expect(await loadColumn(root, cadence.observations.path, "observations")).to.deep.equal([2]);
        expect(fixture.entries).to.have.length(1);
    });

    it("refuses an incomplete source snapshot without creating feature-pack output", async () => {
        const root = makeRoot();
        await mkdir(join(root, "source-snapshot"), { recursive: true });
        await writeFile(join(root, "source-snapshot", "manifest.json"), "{}", "utf8");
        await expectRejected(generatePairFeaturePack(root, "v0", ["feat_fp_spread_log_return_b12_r1"]), new RegExp(SOURCE_REQUIRED_MESSAGE));
        expect(existsSync(join(root, "feature-packs"))).to.equal(false);
    });

    it("rejects altered ledger bytes before writing a pack", async () => {
        const root = makeRoot();
        await createPairFeatureFixture(root);
        await writeFile(join(root, "ledger.jsonl"), `${readFileSync(join(root, "ledger.jsonl"), "utf8")}\n`, "utf8");
        await expectRejected(generatePairFeaturePack(root, "v0", ["feat_fp_spread_log_return_b12_r1"]), /ledger\.jsonl hash or byte count/);
        expect(existsSync(join(root, "feature-packs"))).to.equal(false);
    });

    it("keeps stored snapshots readable across runtime patches while pinning generation", async () => {
        const root = makeRoot();
        await createPairFeatureFixture(root);
        await generatePairFeaturePack(root, "v0", ["feat_fp_spread_log_return_b12_r1"]);
        const originalVersion = process.version;
        Object.defineProperty(process, "version", { configurable: true, value: "patched-node-runtime" });
        try {
            await validatePairFeatureSnapshot(root);
            const prepared = await ensurePairFeatures(root, [spreadRule]);
            expect(prepared.columns.size).to.equal(1);
            await expectRejected(validatePairFeatureSnapshotForGeneration(root), /runtime fingerprint/);
        } finally {
            Object.defineProperty(process, "version", { configurable: true, value: originalVersion });
        }
    });

    it("starts the feature-generation worker through the CommonJS bootstrap", async () => {
        const root = makeRoot();
        await createPairFeatureFixture(root);
        const snapshot = await validatePairFeatureSnapshot(root, { verifySourceRecords: false });
        const worker = new Worker(fileURLToPath(new URL("../scripts/pair-feature-generation-worker.cjs", import.meta.url)));
        try {
            const generated = await new Promise<readonly [string, unknown][]>((resolve, reject) => {
                worker.on("message", (message: { type: string; generated?: readonly [string, unknown][]; error?: string }) => {
                    if (message.type === "ready") {
                        worker.postMessage({
                            taskId: "fixture-worker",
                            folder: root,
                            libraryRelease: "v0",
                            pair: snapshot.manifest.pairs[0],
                            featureIds: ["feat_fp_spread_log_return_b12_r1"],
                        });
                    } else if (message.type === "done") {
                        resolve(message.generated ?? []);
                    } else if (message.type === "error") {
                        reject(new Error(message.error ?? "feature worker failed"));
                    }
                });
                worker.once("error", reject);
            });
            expect(generated).to.have.length(1);
        } finally {
            await worker.terminate();
        }
    });
});
