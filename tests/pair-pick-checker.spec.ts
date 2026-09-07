import { expect } from "chai";
import { describe, it, before, after } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tieBreakDigest } from "../lib/batch-backtest/max-active-research-contract";
import { getPairSelectionRule } from "../lib/pair-selection/registry";
import {
    loadPairSelectionArchive,
    pickPairSelectionRule,
    tallyPairSelectionRule,
} from "../lib/pair-selection/tally";
import type { PairSelectionRule } from "../lib/pair-selection/types";
import { pair_win_rate_shrinkage } from "../lib/pair-selection/pair_win_rate_shrinkage";
import { relative_atr_cleanliness } from "../lib/pair-selection/relative_atr_cleanliness";
import { sharedLegOverlapFraction } from "../lib/pair-selection/rule-helpers";
import { shared_leg_overlap_target } from "../lib/pair-selection/shared_leg_overlap_target";

interface FixtureRowOptions {
    signalTime: number;
    pair: string;
    baseSymbol: string;
    quoteSymbol: string;
    direction?: "long" | "short";
    return20?: number;
    atrPct?: number | null;
    asIfPnlPercent: number | null;
    horizonPnlPercent?: number | null;
    horizonStatus?: "ok" | "right_censored";
}

function fixtureRow(options: FixtureRowOptions): Record<string, unknown> {
    const direction = options.direction ?? "long";
    const horizonStatus = options.horizonStatus ?? (options.horizonPnlPercent === null ? "right_censored" : "ok");
    const okHorizonPnl = options.horizonPnlPercent ?? options.asIfPnlPercent ?? 0;
    const asIf = options.asIfPnlPercent === null
        ? null
        : {
            fillTime: options.signalTime,
            fillPrice: 100,
            exitTime: options.signalTime + 1,
            exitPrice: 100,
            pnlPercent: options.asIfPnlPercent,
            barsHeld: 1,
            exitReason: "end_of_data",
        };
    return {
        ledgerVersion: 3,
        pair: options.pair,
        baseSymbol: options.baseSymbol,
        quoteSymbol: options.quoteSymbol,
        direction,
        signalTime: options.signalTime,
        signalBarIndex: 20,
        fillTime: options.signalTime,
        fillPrice: 100,
        executed: false,
        notExecutedReason: null,
        feat_entryRangePosition: 50,
        feat_atrPct: options.atrPct ?? 1,
        feat_return20: options.return20 ?? 0,
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
        asIf,
        asIfReason: asIf === null ? "right_censored" : null,
        horizons: {
            "24": {
                entryTimeSec: options.signalTime,
                entryPrice: 100,
                exitTimeSec: horizonStatus === "ok" ? options.signalTime + 24 : null,
                exitPrice: horizonStatus === "ok" ? 100 * (direction === "long" ? 1 + okHorizonPnl : 1 - okHorizonPnl) : null,
                pnlPercent: horizonStatus === "ok" ? okHorizonPnl : null,
                status: horizonStatus,
            },
        },
    };
}

function fixtureRows(): Record<string, unknown>[] {
    return [
        fixtureRow({ signalTime: 100, pair: "A+B", baseSymbol: "A", quoteSymbol: "B", return20: 3, atrPct: 2, asIfPnlPercent: 0.90, horizonPnlPercent: 0.10 }),
        fixtureRow({ signalTime: 100, pair: "C+D", baseSymbol: "C", quoteSymbol: "D", return20: 2, atrPct: 3, asIfPnlPercent: -0.90, horizonPnlPercent: 0.00 }),
        fixtureRow({ signalTime: 100, pair: "E+F", baseSymbol: "E", quoteSymbol: "F", direction: "short", return20: 1, atrPct: 1, asIfPnlPercent: 0.80, horizonPnlPercent: 0.20 }),
        fixtureRow({ signalTime: 200, pair: "G+H", baseSymbol: "G", quoteSymbol: "H", return20: 6, atrPct: 1, asIfPnlPercent: -0.80, horizonPnlPercent: 0.20 }),
        fixtureRow({ signalTime: 200, pair: "I+J", baseSymbol: "I", quoteSymbol: "J", return20: 5, atrPct: 1, asIfPnlPercent: 0.80, horizonPnlPercent: -0.10 }),
        fixtureRow({ signalTime: 300, pair: "K+L", baseSymbol: "K", quoteSymbol: "L", return20: 9, atrPct: 9, asIfPnlPercent: 0.30, horizonPnlPercent: 0.30 }),
        fixtureRow({ signalTime: 400, pair: "M+N", baseSymbol: "M", quoteSymbol: "N", return20: 9, atrPct: 9, asIfPnlPercent: 0.30, horizonPnlPercent: null }),
        fixtureRow({ signalTime: 400, pair: "O+P", baseSymbol: "O", quoteSymbol: "P", return20: 1, atrPct: 1, asIfPnlPercent: 0.05, horizonPnlPercent: 0.05 }),
        {
            ...fixtureRow({ signalTime: 500, pair: "Q+R", baseSymbol: "Q", quoteSymbol: "R", return20: 9, atrPct: 9, asIfPnlPercent: null, horizonPnlPercent: null }),
            asIf: { fillTime: 500, fillPrice: 100, exitTime: 501, exitPrice: 100, pnlPercent: null, barsHeld: 1, exitReason: "end_of_data" },
            asIfReason: "right_censored",
        },
        fixtureRow({ signalTime: 500, pair: "S+T", baseSymbol: "S", quoteSymbol: "T", return20: 1, atrPct: 1, asIfPnlPercent: 0.05, horizonPnlPercent: 0.05 }),
    ];
}

async function writeFixture(folder: string, featureVersion = 3, ledgerVersion = 3): Promise<void> {
    const rows = fixtureRows();
    const provenance = {
        ledgerVersion,
        featureVersion,
        runId: "pair-pick-fixture",
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
        pairCount: 10,
        symbols: rows.map((row) => row.pair as string),
        ledgerHorizons: [24],
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
    };
    const summary = {
        ledgerVersion,
        featureVersion,
        ledgerComplete: true,
        failedWrites: 0,
        totals: { pairs: rows.length, signals: rows.length, executed: 0, notExecuted: rows.length },
    };
    await writeFile(path.join(folder, "provenance.json"), JSON.stringify(provenance), "utf8");
    await writeFile(path.join(folder, "summary.json"), JSON.stringify(summary), "utf8");
    await writeFile(path.join(folder, "signal-ranks.jsonl"), "", "utf8");
    await writeFile(path.join(folder, "ledger.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

const argmaxRule: PairSelectionRule = {
    key: "fixture_argmax",
    name: "FIXTURE_ARGMAX",
    description: "Fixture rule that selects the highest return feature.",
    defaultParams: { threshold: 0 },
    paramLabels: { threshold: "Threshold" },
    score: (candidate, _event, params) => (candidate.feat_return20 ?? Number.NEGATIVE_INFINITY) - params.threshold,
};

describe("pair-pick checker", () => {
    let root = "";
    let folder = "";

    before(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "pair-pick-checker-"));
        folder = path.join(root, "pair-pick-fixture");
        await mkdir(folder, { recursive: true });
        await writeFixture(folder);
    });

    after(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("selects the argmax candidate and applies the strict event gate", async () => {
        const archive = await loadPairSelectionArchive(folder);
        const result = tallyPairSelectionRule(archive, argmaxRule);
        expect(result.tally.eventCount).to.equal(5);
        expect(result.tally.candidateEvents).to.equal(4);
        expect(result.tally.eligibleEvents).to.equal(2);
        expect(result.picks.map((pick) => `${pick.signalTime}|${pick.pair}`)).to.deep.equal(["100|A+B", "200|G+H"]);
        expect(result.tally.comparisons.othersMean.selected.count).to.equal(2);
        expect(result.tally.comparisons.othersMean.selected.mean).to.be.closeTo(0.15, 1e-12);
        expect(result.tally.comparisons.othersMean.benchmark.mean).to.be.closeTo(0, 1e-12);
        expect(result.tally.comparisons.othersMean.delta.mean).to.be.closeTo(0.15, 1e-12);
    });

    it("uses the shared FNV digest for deterministic default ties", async () => {
        const archive = await loadPairSelectionArchive(folder);
        const event = archive.events.find((entry) => entry.context.signalTime === 200)!;
        const first = pickPairSelectionRule(event, { ...argmaxRule, score: () => 1 }, { threshold: 0 });
        const second = pickPairSelectionRule(event, { ...argmaxRule, score: () => 1 }, { threshold: 0 });
        const expected = ["G+H|long", "I+J|long"].sort((left, right) => tieBreakDigest(200, left).localeCompare(tieBreakDigest(200, right)))[0]!.split("|")[0];
        expect(first).to.deep.equal(second);
        expect(first.pair).to.equal(expected);
        expect(first.tiedCount).to.equal(2);
    });

    it("keeps outcomes out of scoring while outcome mutation changes the tally", async () => {
        const archive = await loadPairSelectionArchive(folder);
        const before = tallyPairSelectionRule(archive, argmaxRule);
        const mutatedReturns = new Map(archive.horizonReturns);
        mutatedReturns.set(JSON.stringify([24, 100, "A+B", "long"]), 0.90);
        const after = tallyPairSelectionRule({ ...archive, horizonReturns: mutatedReturns }, argmaxRule);
        expect(after.picks).to.deep.equal(before.picks);
        expect(after.tally.comparisons.othersMean.delta.mean).to.not.equal(before.tally.comparisons.othersMean.delta.mean);
    });

    it("implements both reference rules and produces byte-stable reports", async () => {
        const archiveA = await loadPairSelectionArchive(folder);
        const archiveB = await loadPairSelectionArchive(folder);
        const alphabetical = tallyPairSelectionRule(archiveA, getPairSelectionRule("reference_alphabetical")!);
        const loudest = tallyPairSelectionRule(archiveA, getPairSelectionRule("reference_loudest_atr")!);
        expect(alphabetical.picks[0]!.pair).to.equal("A+B");
        expect(loudest.picks[0]!.pair).to.equal("C+D");
        const first = tallyPairSelectionRule(archiveA, argmaxRule);
        const second = tallyPairSelectionRule(archiveB, argmaxRule);
        expect(first.picks).to.deep.equal(second.picks);
        expect(Buffer.from(first.reportLines.join("\n"))).to.deep.equal(Buffer.from(second.reportLines.join("\n")));
        expect(first.reportLines.some((line) => line.includes("dominant BASE"))).to.equal(true);
        expect(first.reportLines.some((line) => line.includes("FIXTURE_ARGMAX_EX_A+B"))).to.equal(true);
    });

    it("preserves event-median and shared-leg rule picks", () => {
        const event = {
            context: { signalTime: 600, interval: "4h", strategyKey: "fixture-strategy" },
            candidates: [
                {
                    pair: "A+B", baseSymbol: "A", quoteSymbol: "B", direction: "long" as const,
                    signalTime: 600, signalBarIndex: 20, feat_entryRangePosition: 50,
                    feat_atrPct: 1, feat_return20: 0, feat_gapPct: 0, feat_dow: 1, feat_hour: 12,
                    feat_pairWinRatePrior: 0.2, feat_pairTradesPrior: 1, feat_barsSincePairLastFire: null,
                    feat_pairSpreadVolatility20: 1, feat_legVolatilityRatio20: 1, feat_candidatesAtTime: 4,
                },
                {
                    pair: "A+C", baseSymbol: "A", quoteSymbol: "C", direction: "long" as const,
                    signalTime: 600, signalBarIndex: 20, feat_entryRangePosition: 50,
                    feat_atrPct: 2, feat_return20: 0, feat_gapPct: 0, feat_dow: 1, feat_hour: 12,
                    feat_pairWinRatePrior: 0.8, feat_pairTradesPrior: 10, feat_barsSincePairLastFire: null,
                    feat_pairSpreadVolatility20: 1, feat_legVolatilityRatio20: 1, feat_candidatesAtTime: 4,
                },
                {
                    pair: "D+B", baseSymbol: "D", quoteSymbol: "B", direction: "long" as const,
                    signalTime: 600, signalBarIndex: 20, feat_entryRangePosition: 50,
                    feat_atrPct: 4, feat_return20: 0, feat_gapPct: 0, feat_dow: 1, feat_hour: 12,
                    feat_pairWinRatePrior: 0.5, feat_pairTradesPrior: 4, feat_barsSincePairLastFire: null,
                    feat_pairSpreadVolatility20: 1, feat_legVolatilityRatio20: 1, feat_candidatesAtTime: 4,
                },
                {
                    pair: "E+F", baseSymbol: "E", quoteSymbol: "F", direction: "long" as const,
                    signalTime: 600, signalBarIndex: 20, feat_entryRangePosition: 50,
                    feat_atrPct: 8, feat_return20: 0, feat_gapPct: 0, feat_dow: 1, feat_hour: 12,
                    feat_pairWinRatePrior: 0.9, feat_pairTradesPrior: 1, feat_barsSincePairLastFire: null,
                    feat_pairSpreadVolatility20: 1, feat_legVolatilityRatio20: 1, feat_candidatesAtTime: 4,
                },
            ],
        };

        expect(pickPairSelectionRule(event, relative_atr_cleanliness, relative_atr_cleanliness.defaultParams).pair).to.equal("A+C");
        expect(pickPairSelectionRule(event, pair_win_rate_shrinkage, pair_win_rate_shrinkage.defaultParams).pair).to.equal("A+C");
        expect(pickPairSelectionRule(event, shared_leg_overlap_target, shared_leg_overlap_target.defaultParams).pair).to.equal("E+F");
    });

    it("counts a degenerate A+A leg once, matching the pairwise overlap predicate", () => {
        const event = {
            context: { signalTime: 601, interval: "4h", strategyKey: "fixture-strategy" },
            candidates: [
                {
                    pair: "A+A", baseSymbol: "A", quoteSymbol: "A", direction: "long" as const,
                    signalTime: 601, signalBarIndex: 20, feat_entryRangePosition: 50,
                    feat_atrPct: 1, feat_return20: 0, feat_gapPct: 0, feat_dow: 1, feat_hour: 12,
                    feat_pairWinRatePrior: null, feat_pairTradesPrior: 0, feat_barsSincePairLastFire: null,
                    feat_pairSpreadVolatility20: 1, feat_legVolatilityRatio20: 1, feat_candidatesAtTime: 2,
                },
                {
                    pair: "A+B", baseSymbol: "A", quoteSymbol: "B", direction: "long" as const,
                    signalTime: 601, signalBarIndex: 20, feat_entryRangePosition: 50,
                    feat_atrPct: 2, feat_return20: 0, feat_gapPct: 0, feat_dow: 1, feat_hour: 12,
                    feat_pairWinRatePrior: null, feat_pairTradesPrior: 0, feat_barsSincePairLastFire: null,
                    feat_pairSpreadVolatility20: 1, feat_legVolatilityRatio20: 1, feat_candidatesAtTime: 2,
                },
            ],
        };

        expect(sharedLegOverlapFraction(event.candidates[0]!, event.candidates)).to.equal(1);
        expect(sharedLegOverlapFraction(event.candidates[1]!, event.candidates)).to.equal(1);
    });

    it("refuses v2 folders before pair selection", async () => {
        const v2Folder = path.join(root, "v2");
        await mkdir(v2Folder, { recursive: true });
        await writeFixture(v2Folder, 3, 2);
        let error = "";
        try {
            await loadPairSelectionArchive(v2Folder);
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        expect(error).to.match(/ledger v2|requires ledgerVersion 3|re-run the batch/);
    });

    it("refuses a horizon that is not in folder provenance", async () => {
        const archive = await loadPairSelectionArchive(folder);
        expect(() => tallyPairSelectionRule(archive, argmaxRule, undefined, 48)).to.throw(/not present in folder provenance/);
    });

    it("fails loudly on duplicate candidate keys", async () => {
        const duplicateFolder = path.join(root, "duplicate");
        await mkdir(duplicateFolder, { recursive: true });
        await writeFixture(duplicateFolder);
        const ledgerPath = path.join(duplicateFolder, "ledger.jsonl");
        const ledger = await readFile(ledgerPath, "utf8");
        await writeFile(ledgerPath, `${ledger}${ledger.split("\n")[0]}\n`, "utf8");
        let error = "";
        try {
            await loadPairSelectionArchive(duplicateFolder);
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        expect(error).to.match(/duplicate candidate/);
    });
});
