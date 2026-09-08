import { expect } from "chai";
import { describe, it, afterEach } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { canonicalJson, hashBytes } from "../lib/pair-features/artifact-io";
import { generatePairFeaturePack } from "../lib/pair-features/generate";
import {
    activatePairFeatures,
    ensurePairFeatures,
    writePairSelectionCheckReceipt,
} from "../lib/pair-selection/feature-access";
import { loadPairSelectionArchive, tallyPairSelectionRule } from "../lib/pair-selection/tally";
import { runSelectionRulesJob } from "../lib/selection-rules/job";
import type { PairSelectionRule } from "../lib/pair-selection/types";
import {
    createPairFeatureFixture,
    FIXTURE_BASE,
    FIXTURE_PAIR,
    FIXTURE_QUOTE,
} from "./fixtures/pair-features/fixture";

const spreadId = "feat_fp_spread_log_return_b12_r1";
const tradeId = "feat_fp_trade_mean_net_pct_t8_r1";
const sourceFile = "tests/pair-feature-access.spec.ts";

const spreadRule: PairSelectionRule = {
    key: "fixture_feature_spread",
    name: "FIXTURE_FEATURE_SPREAD",
    description: "Reads the prepared spread feature.",
    defaultParams: {},
    paramLabels: {},
    metadata: { featureRequirements: { libraryRelease: "v0", columns: [spreadId] }, sourceFiles: [sourceFile] },
    score: (candidate) => {
        if (Object.getOwnPropertySymbols(candidate).length > 0) throw new Error("private feature ordinal leaked into rule clone");
        return candidate[spreadId] ?? Number.NEGATIVE_INFINITY;
    },
};

const tradeRule: PairSelectionRule = {
    key: "fixture_feature_trade",
    name: "FIXTURE_FEATURE_TRADE",
    description: "Reads the prepared trade feature and its count.",
    defaultParams: {},
    paramLabels: {},
    metadata: { featureRequirements: { libraryRelease: "v0", columns: [tradeId, `${tradeId}_n`] }, sourceFiles: [sourceFile] },
    score: (candidate) => {
        if (spreadId in candidate) throw new Error("inactive feature leaked into rule clone");
        return candidate[tradeId] ?? Number.NEGATIVE_INFINITY;
    },
};

const nullableTradeRule: PairSelectionRule = {
    ...tradeRule,
    key: "fixture_feature_trade_nullable",
    name: "FIXTURE_FEATURE_TRADE_NULLABLE",
    score: (candidate) => candidate[tradeId] === null ? Number.NEGATIVE_INFINITY : candidate[tradeId]!,
};

const autoPreparedRule: PairSelectionRule = {
    key: "fixture_feature_auto_prepared",
    name: "FIXTURE_FEATURE_AUTO_PREPARED",
    description: "Reads a v1 column prepared by the selection-rules job.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_fp_spread_zscore_b12_r1"] },
        sourceFiles: [sourceFile],
    },
    score: (candidate) => candidate.feat_fp_spread_zscore_b12_r1 ?? Number.NEGATIVE_INFINITY,
};

let temporaryRoots: string[] = [];

async function writeCanonical(filePath: string, value: unknown): Promise<void> {
    await writeFile(filePath, Buffer.from(canonicalJson(value), "utf8"));
}

async function createLoadableFolder(entries: readonly [number, number, "long" | "short", number][] = [
    [0, 12, "long", 1012],
    [1, 13, "short", 1013],
    [2, 13, "long", 1013],
    [3, 20, "long", 1020],
    [4, 20, "short", 1020],
]): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "pair-feature-access-"));
    temporaryRoots.push(root);
    const folder = path.join(root, "fixture");
    const fixture = await createPairFeatureFixture(folder, {
        entries,
    });
    const rows = fixture.entries.map((entry, index) => ({
        ledgerVersion: 3,
        pair: FIXTURE_PAIR,
        baseSymbol: FIXTURE_BASE,
        quoteSymbol: FIXTURE_QUOTE,
        direction: entry[2],
        signalTime: entry[3],
        signalBarIndex: entry[1],
        fillTime: null,
        fillPrice: null,
        executed: false,
        notExecutedReason: "fixture",
        feat_entryRangePosition: 0.5,
        feat_atrPct: 1,
        feat_return20: 0,
        feat_gapPct: 0,
        feat_dow: 1,
        feat_hour: 12,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 0,
        feat_barsSincePairLastFire: null,
        feat_pairSpreadVolatility20: 1,
        feat_legVolatilityRatio20: 1,
        feat_rank: null,
        feat_candidatesAtTime: null,
        asIf: null,
        asIfReason: "fixture",
        horizons: {
            "24": {
                entryTimeSec: entry[3],
                entryPrice: 100,
                exitTimeSec: entry[3] + 24,
                exitPrice: 100,
                pnlPercent: index,
                status: "ok",
            },
        },
    }));
    const ledgerBytes = Buffer.from(`${rows.map((row) => canonicalJson(row)).join("\n")}\n`, "utf8");
    await writeFile(path.join(folder, "ledger.jsonl"), ledgerBytes);
    const provenance = {
        ledgerVersion: 3,
        featureVersion: 3,
        runId: "fixture-feature-access",
        startedAt: "fixture-start",
        interval: "4h",
        strategyKey: "fixture-strategy",
        ledgerHorizons: [24],
        replay: {
            replayEligible: true,
            replayBlockers: [],
            maxOpenTrades: 1,
            cooldownBars: 0,
            executionModel: "signal_close",
            tradeDirection: "both",
            allowSameBarExit: false,
            disableSignalExits: true,
            slippageRate: 0,
            commissionRate: 0,
        },
    };
    const summary = {
        ledgerVersion: 3,
        ledgerComplete: true,
        failedWrites: 0,
        totals: { pairs: 1, signals: rows.length, executed: 0, notExecuted: rows.length },
    };
    await writeCanonical(path.join(folder, "provenance.json"), provenance);
    await writeCanonical(path.join(folder, "summary.json"), summary);
    const manifestPath = path.join(folder, "source-snapshot", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.ledgerSha256 = hashBytes(ledgerBytes);
    manifest.ledgerBytes = ledgerBytes.length;
    manifest.ledgerRowCount = rows.length;
    manifest.provenanceSha256 = hashBytes(Buffer.from(canonicalJson(provenance), "utf8"));
    manifest.summarySha256 = hashBytes(Buffer.from(canonicalJson(summary), "utf8"));
    await writeCanonical(manifestPath, manifest);
    await generatePairFeaturePack(folder, "v0", [spreadId, tradeId]);
    return folder;
}

function filterEvents(
    archive: Awaited<ReturnType<typeof loadPairSelectionArchive>>,
    fromSec: number | null,
    toSec: number | null,
) {
    return { ...archive, events: archive.events.filter((event) =>
        (fromSec === null || event.context.signalTime >= fromSec)
        && (toSec === null || event.context.signalTime <= toSec)) };
}

afterEach(async () => {
    const roots = temporaryRoots;
    temporaryRoots = [];
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("pair feature access", () => {
    it("decodes exact values/counts and injects only the active rule columns", async () => {
        const folder = await createLoadableFolder();
        const prepared = await ensurePairFeatures(folder, [spreadRule, tradeRule]);
        const spread = await activatePairFeatures(prepared, spreadRule);
        expect(spread).to.not.equal(null);
        expect(spread!.readCandidateFeatures(0)).to.deep.equal({ [spreadId]: null });
        expect(spread!.readCandidateFeatures(1)[spreadId]).to.be.closeTo(Math.log(4096), 1e-12);
        expect(spread!.readCandidateFeatures(3)[spreadId]).to.be.closeTo(Math.log(1) - Math.log(128), 1e-12);
        const archive = await loadPairSelectionArchive(folder);
        const spreadResult = tallyPairSelectionRule(archive, spreadRule, undefined, 24, spread!);
        expect(spreadResult.tally.eligibleEvents).to.equal(2);
        expect(Object.getOwnPropertySymbols(archive.events[0]!.candidates[0]!).length).to.equal(1);
        const trade = await activatePairFeatures(prepared, tradeRule);
        expect(() => spread!.readCandidateFeatures(0)).to.throw(/has been released/);
        expect(trade!.readCandidateFeatures(3)).to.deep.equal({ [tradeId]: 4.5, [`${tradeId}_n`]: 8 });
        const tradeResult = tallyPairSelectionRule(archive, tradeRule, undefined, 24, trade!);
        expect(tradeResult.tally.eligibleEvents).to.equal(1);
    });

    it("keeps original ordinals and feature history when date filters are applied", async () => {
        const folder = await createLoadableFolder();
        const prepared = await ensurePairFeatures(folder, [spreadRule]);
        const active = await activatePairFeatures(prepared, spreadRule);
        const archive = await loadPairSelectionArchive(folder);
        expect(filterEvents(archive, null, null).events).to.have.length(3);
        expect(filterEvents(archive, 1013, null).events).to.have.length(2);
        expect(filterEvents(archive, null, 1012).events).to.have.length(1);
        expect(filterEvents(archive, 1012, 1013).events).to.have.length(2);
        const filtered = filterEvents(archive, 1013, 1013);
        const result = tallyPairSelectionRule(filtered, spreadRule, undefined, 24, active!);
        expect(result.tally.eventCount).to.equal(1);
        expect(result.tally.eligibleEvents).to.equal(1);
        expect(active!.readCandidateFeatures(1)[spreadId]).to.be.closeTo(Math.log(4096), 1e-12);
    });

    it("preserves zero-valid candidates under the unchanged -Infinity gate", async () => {
        const folder = await createLoadableFolder([
            [0, 12, "long", 1012],
            [1, 12, "short", 1012],
            [2, 13, "long", 1013],
        ]);
        const prepared = await ensurePairFeatures(folder, [nullableTradeRule]);
        const active = await activatePairFeatures(prepared, nullableTradeRule);
        const archive = await loadPairSelectionArchive(folder);
        const result = tallyPairSelectionRule(archive, nullableTradeRule, undefined, 24, active!);
        expect(result.tally.candidateEvents).to.equal(1);
        expect(result.tally.eligibleEvents).to.equal(0);
        expect(result.diagnostics.unscoredEvents).to.equal(1);
    });

    it("automatically prepares missing requested columns", async () => {
        const folder = await mkdtemp(path.join(os.tmpdir(), "pair-feature-access-missing-"));
        temporaryRoots.push(folder);
        await createPairFeatureFixture(path.join(folder, "fixture"));
        const fixtureFolder = path.join(folder, "fixture");
        const progress: string[] = [];
        const prepared = await ensurePairFeatures(fixtureFolder, [spreadRule], undefined, (event) => progress.push(event.familyId));
        expect(prepared.columns.has(`v0\u0000${spreadId}`)).to.equal(true);
        expect(progress).to.deep.equal(["spread"]);
    });

    it("rejects a missing referenced column with the exact repair command", async () => {
        const folder = await createLoadableFolder();
        const packPath = path.join(folder, "feature-packs", "manifests", (await readdir(path.join(folder, "feature-packs", "manifests")))[0]!);
        const pack = JSON.parse(await readFile(packPath, "utf8")) as { familyManifests: Array<{ path: string }> };
        const family = JSON.parse(await readFile(path.join(folder, pack.familyManifests[0]!.path), "utf8")) as { features: Array<{ id: string; pairs: Array<{ values: { path: string } }> }> };
        const spread = family.features.find((feature) => feature.id === spreadId)!;
        await rm(path.join(folder, spread.pairs[0]!.values.path));
        let message = "";
        try {
            await ensurePairFeatures(folder, [spreadRule]);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.equal(`esno scripts/pair-feature-pack.ts ${folder} v0 ${spreadId}`);
    });

    it("refuses a changed ledger before a tally can consume the pack", async () => {
        const folder = await createLoadableFolder();
        const ledgerPath = path.join(folder, "ledger.jsonl");
        await writeFile(ledgerPath, `${await readFile(ledgerPath, "utf8")}\n`, "utf8");
        let message = "";
        try {
            await ensurePairFeatures(folder, [spreadRule]);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.match(/ledger\.jsonl hash or byte count/);
    });

    it("writes an offline receipt with normalized parameters and deterministic result bytes", async () => {
        const folder = await createLoadableFolder();
        const prepared = await ensurePairFeatures(folder, [spreadRule]);
        const active = await activatePairFeatures(prepared, spreadRule);
        const archive = await loadPairSelectionArchive(folder);
        const result = tallyPairSelectionRule(filterEvents(archive, 1012, 1013), spreadRule, undefined, 24, active!);
        const receipt = await writePairSelectionCheckReceipt({
            prepared,
            rules: [spreadRule],
            horizons: [24],
            results: [result],
            fromSec: 1012,
            toSec: 1013,
        });
        const receiptAgain = await writePairSelectionCheckReceipt({
            prepared,
            rules: [spreadRule],
            horizons: [24],
            results: [{ ...result, diagnostics: { ...result.diagnostics, scoreMs: 999 } }],
            fromSec: 1012,
            toSec: 1013,
        });
        expect(receiptAgain.receiptDigest).to.equal(receipt.receiptDigest);
        expect(receipt.dateBoundaries).to.deep.equal({ fromSec: 1012, toSec: 1013 });
        expect(receipt.definitionDigests).to.have.length(1);
        expect(path.isAbsolute(receipt.packDigests[0]!.path)).to.equal(false);
        expect(receipt.rules[0]!.sourceFiles[0]!.path).to.equal(sourceFile);
        expect(path.isAbsolute(receipt.rules[0]!.sourceFiles[0]!.path)).to.equal(false);
        const checks = await readdir(path.join(folder, "feature-packs", "checks"));
        expect(checks).to.deep.equal([`${receipt.receiptDigest}.json`]);
        const stored = JSON.parse(await readFile(path.join(folder, "feature-packs", "checks", checks[0]!), "utf8")) as typeof receipt;
        expect(stored).to.deep.equal(receipt);
    });

    it("prepares once, activates each rule, and writes one successful job receipt", async () => {
        const folder = await createLoadableFolder();
        const events: string[] = [];
        const controller = new AbortController();
        await runSelectionRulesJob({
            runId: "feature-job",
            folderPath: folder,
            horizonBars: 24,
            rules: [spreadRule, tradeRule, autoPreparedRule],
            signal: controller.signal,
            emit: (event) => { events.push(event.type === "phase" ? event.detail : event.type); },
            update: () => undefined,
        });
        expect(events.at(-1)).to.equal("done");
        expect(events.some((event) => event.startsWith("Preparing pair features (spread:"))).to.equal(true);
        const checks = await readdir(path.join(folder, "feature-packs", "checks"));
        expect(checks).to.have.length(1);
    });
});
