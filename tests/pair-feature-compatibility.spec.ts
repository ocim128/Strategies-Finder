import { expect } from "chai";
import { after, before, describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    EMBEDDED_FEATURES_V3_CAPABILITY,
    PAIR_HORIZON_OUTCOMES_CAPABILITY,
    resolvePairFeatureCompatibility,
} from "../lib/pair-features/compatibility";
import { discoverSelectionRulesCatalog } from "../lib/selection-rules/catalog";
import { loadPairSelectionArchive, tallyPairSelectionRule } from "../lib/pair-selection/tally";
import type { PairSelectionRule } from "../lib/pair-selection/types";

function makeRow(signalTime: number, pair: string, return20: number): Record<string, unknown> {
    const [baseSymbol, quoteSymbol] = pair.split("+");
    return {
        ledgerVersion: 3,
        pair,
        baseSymbol,
        quoteSymbol,
        direction: "long",
        signalTime,
        signalBarIndex: 20,
        fillTime: signalTime,
        fillPrice: 100,
        executed: false,
        notExecutedReason: null,
        feat_entryRangePosition: 50,
        feat_atrPct: 1,
        feat_return20: return20,
        feat_gapPct: 0,
        feat_dow: 1,
        feat_hour: 12,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 0,
        feat_barsSincePairLastFire: null,
        feat_pairSpreadVolatility20: 1,
        feat_legVolatilityRatio20: null,
        feat_rank: null,
        feat_candidatesAtTime: null,
        asIf: null,
        asIfReason: "right_censored",
        horizons: {
            "24": {
                entryTimeSec: signalTime,
                entryPrice: 100,
                exitTimeSec: signalTime + 24,
                exitPrice: 100,
                pnlPercent: return20 / 100,
                status: "ok",
            },
        },
    };
}

async function writeFolder(folder: string, ledgerVersion = 3, featureVersion = 3): Promise<void> {
    const rows = [
        makeRow(100, "A+B", 10),
        makeRow(100, "C+D", 1),
    ];
    await writeFile(path.join(folder, "provenance.json"), JSON.stringify({
        ledgerVersion,
        featureVersion,
        runId: "compatibility-fixture",
        startedAt: "2026-09-06T00:00:00.000Z",
        interval: "4h",
        strategyKey: "fixture-strategy",
        strategyParams: {},
        backtestSettings: {},
        capitalSettings: {},
        engineMode: "typescript",
        executionModel: "signal_close",
        tradeDirection: "long",
        riskMode: "none",
        fees: { commissionPercent: 0, slippageBps: 0 },
        ledgerHorizons: [24],
        pairCount: 2,
        symbols: ["A+B", "C+D"],
        replay: {
            replayEligible: true,
            replayBlockers: [],
            maxOpenTrades: "unlimited",
            cooldownBars: 0,
            executionModel: "signal_close",
            tradeDirection: "long",
            allowSameBarExit: true,
            disableSignalExits: false,
            slippageRate: 0,
            commissionRate: 0,
        },
    }), "utf8");
    await writeFile(path.join(folder, "summary.json"), JSON.stringify({
        ledgerVersion,
        featureVersion,
        runId: "compatibility-fixture",
        startedAt: "2026-09-06T00:00:00.000Z",
        finishedAt: "2026-09-06T00:01:00.000Z",
        ledgerComplete: true,
        failedWrites: 0,
        totals: { pairs: 2, signals: 2, executed: 0, notExecuted: 2 },
    }), "utf8");
    await writeFile(path.join(folder, "signal-ranks.jsonl"), "", "utf8");
    await writeFile(path.join(folder, "ledger.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

const argmaxRule: PairSelectionRule = {
    key: "fixture_argmax",
    name: "FIXTURE_ARGMAX",
    description: "Selects the largest legacy return feature.",
    defaultParams: {},
    paramLabels: {},
    score: (candidate) => candidate.feat_return20 ?? Number.NEGATIVE_INFINITY,
};

describe("pair feature compatibility", () => {
    let root = "";
    let folder = "";

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), "pair-feature-compatibility-"));
        folder = path.join(root, "archive", "mining-ledger", "fixture");
        await mkdir(folder, { recursive: true });
        await writeFolder(folder);
        await mkdir(path.join(root, "archive", "mining-ledger", "legacy"), { recursive: true });
        await writeFolder(path.join(root, "archive", "mining-ledger", "legacy"), 2, 2);
    });

    after(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("resolves only explicit version pairs and reports capabilities", () => {
        const v3 = resolvePairFeatureCompatibility({
            ledgerVersion: 3,
            featureVersion: 3,
            requiredCapabilities: [PAIR_HORIZON_OUTCOMES_CAPABILITY],
        });
        expect(v3.supported).to.equal(true);
        expect(v3.capabilities).to.include(PAIR_HORIZON_OUTCOMES_CAPABILITY);
        expect(v3.capabilities).to.include(EMBEDDED_FEATURES_V3_CAPABILITY);

        const legacy = resolvePairFeatureCompatibility({ ledgerVersion: 2, featureVersion: 2 });
        expect(legacy.supported).to.equal(true);
        expect(legacy.capabilities).to.not.include(PAIR_HORIZON_OUTCOMES_CAPABILITY);
        const v2ForPairSelection = resolvePairFeatureCompatibility({
            ledgerVersion: 2,
            featureVersion: 2,
            requiredCapabilities: [PAIR_HORIZON_OUTCOMES_CAPABILITY],
        });
        expect(v2ForPairSelection.supported).to.equal(false);
        expect(v2ForPairSelection.reason).to.equal("missing_capability");
        expect(v2ForPairSelection.missingCapabilities).to.deep.equal([PAIR_HORIZON_OUTCOMES_CAPABILITY]);

        expect(resolvePairFeatureCompatibility({ ledgerVersion: 4, featureVersion: 4 }).supported).to.equal(false);
        expect(resolvePairFeatureCompatibility({ ledgerVersion: 3, featureVersion: 4 }).supported).to.equal(false);
    });

    it("keeps catalog discovery and direct tally compatibility aligned", async () => {
        const catalog = await discoverSelectionRulesCatalog(root);
        expect(catalog.folders.map((entry) => entry.folderId)).to.deep.equal(["fixture"]);
        expect(catalog.folders[0]!.capabilities).to.include(PAIR_HORIZON_OUTCOMES_CAPABILITY);
        expect(catalog.skippedFolders).to.deep.include({ folderId: "legacy", reason: "unsupported_version" });

        const archive = await loadPairSelectionArchive(folder);
        expect(tallyPairSelectionRule(archive, argmaxRule).picks[0]!.pair).to.equal("A+B");

        let error = "";
        try {
            await loadPairSelectionArchive(path.join(root, "archive", "mining-ledger", "legacy"));
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        expect(error).to.contain(PAIR_HORIZON_OUTCOMES_CAPABILITY);
        expect(error).to.contain("Re-run the batch");
    });

    it("names a missing rule capability without applying a global release gate", async () => {
        const archive = await loadPairSelectionArchive(folder);
        const unavailableRule: PairSelectionRule = {
            ...argmaxRule,
            key: "fixture_unavailable_feature",
            name: "FIXTURE_UNAVAILABLE_FEATURE",
            metadata: {
                featureRequirements: {
                    libraryRelease: "v1",
                    columns: ["feat_fp_missing_r1"],
                },
            },
        };
        expect(() => tallyPairSelectionRule(archive, unavailableRule)).to.throw(
            /FIXTURE_UNAVAILABLE_FEATURE.*feat_fp_missing_r1/,
        );

        const unrelatedReleaseRule: PairSelectionRule = {
            ...argmaxRule,
            key: "fixture_unrelated_release",
            metadata: {
                featureRequirements: {
                    libraryRelease: "unrelated-release",
                    columns: ["feat_return20"],
                },
            },
        };
        expect(tallyPairSelectionRule(archive, unrelatedReleaseRule).picks[0]!.pair).to.equal("A+B");

        const rawLedger = await readFile(path.join(folder, "ledger.jsonl"), "utf8");
        expect(rawLedger).to.contain('"feat_legVolatilityRatio20":null');
    });
});
