import { expect } from "chai";
import { describe, it } from "node:test";
import type { Signal, Time, Trade } from "./lib/strategies";
import {
    buildPortfolioSignalPresenceLookup,
    isIndependentPeer,
} from "./lib/portfolio-lab-helpers";
import { buildConsensusTradeSample } from "./lib/portfolioLab/portfolio-lab-consensus";
import {
    buildForecastSignalBreadthContext,
    computeSignalBreadthPersistence,
} from "./lib/portfolioLab/portfolio-lab-forecast";

type MinimalArtifacts = {
    signalPresenceByTime: Map<string, { buy: boolean; sell: boolean }>;
    timeKeys: string[];
    timeIndex: Map<string, number>;
    fullSignals: Signal[];
};

const TIME_KEY = "2026-04-09";

function buildMinimalArtifacts(buyAtKey: boolean, sellAtKey: boolean): MinimalArtifacts {
    const signals: Signal[] = [];
    if (buyAtKey) {
        signals.push({ time: TIME_KEY as Time, type: "buy", price: 1 });
    }
    if (sellAtKey) {
        signals.push({ time: TIME_KEY as Time, type: "sell", price: 1 });
    }
    return {
        signalPresenceByTime: buildPortfolioSignalPresenceLookup(signals),
        timeKeys: [TIME_KEY],
        timeIndex: new Map<string, number>([[TIME_KEY, 0]]),
        fullSignals: signals,
    };
}

function longTrade(): Trade {
    return {
        type: "long",
        entryTime: TIME_KEY as Time,
        entryPrice: 1,
        exitTime: TIME_KEY as Time,
        exitPrice: 2,
        exitReason: "signal",
        pnl: 1,
        pnlPercent: 100,
        size: 1,
    } as unknown as Trade;
}

describe("Portfolio Lab shared-leg breadth correction", () => {
    describe("isIndependentPeer", () => {
        it("flags peers that share a base leg with the target as dependent", () => {
            // NEAR+APT as target; NEAR+SUI shares NEAR -> dependent
            expect(isIndependentPeer("NEAR+APT", "NEAR+SUI")).to.equal(false);
            // NEAR+APT as target; DOGE+ETH shares neither leg -> independent
            expect(isIndependentPeer("NEAR+APT", "DOGE+ETH")).to.equal(true);
        });

        it("flags peers that share a quote leg with the target as dependent", () => {
            // Target NEAR+APT; peer SUI+APT shares APT -> dependent
            expect(isIndependentPeer("NEAR+APT", "SUI+APT")).to.equal(false);
        });

        it("treats plain (non-synthetic) symbols as independent since no leg overlap can be detected", () => {
            expect(isIndependentPeer("BTCUSDT", "ETHUSDT")).to.equal(true);
            expect(isIndependentPeer("NEAR+APT", "BTCUSDT")).to.equal(true);
        });

        it("handles the compressed synthetic target form (NEARAPT, not NEAR+APT)", () => {
            // This is the actual Portfolio Lab shape: the benchmark arrives in
            // the compressed form deriveSyntheticSymbol produces (NEARUSDT +
            // APTUSDT -> NEARAPT), while the peer list stays in the explicit
            // BASE+QUOTE form. If this case is missed, every peer is treated as
            // independent and the breadth counter goes back to fake unanimity.
            expect(isIndependentPeer("NEARAPT", "NEAR+SUI")).to.equal(false);
            expect(isIndependentPeer("NEARAPT", "NEAR+DOGE")).to.equal(false);
            expect(isIndependentPeer("NEARAPT", "SUI+APT")).to.equal(false);
            expect(isIndependentPeer("NEARAPT", "BTC+ETH")).to.equal(true);
            expect(isIndependentPeer("NEARAPT", "SOLUSDT")).to.equal(true);
        });
    });

    describe("buildConsensusTradeSample", () => {
        it("reports zero agreement when every peer shares the NEAR leg with the target", () => {
            const targetSymbol = "NEAR+APT";
            const artifactsBySymbol = new Map<string, MinimalArtifacts>([
                // target: long trade on TIME_KEY
                [targetSymbol, buildMinimalArtifacts(true, false)],
                // peers all share NEAR and all fire buy on TIME_KEY
                ["NEAR+SUI", buildMinimalArtifacts(true, false)],
                ["NEAR+DOGE", buildMinimalArtifacts(true, false)],
                ["NEAR+ETH", buildMinimalArtifacts(true, false)],
            ]);

            const sample = buildConsensusTradeSample(
                targetSymbol,
                longTrade(),
                artifactsBySymbol as any,
                artifactsBySymbol.get(targetSymbol)! as any,
                1
            );

            expect(sample).to.not.equal(null);
            // Without the correction this would be 3; the whole point of the fix.
            expect(sample!.sameCount).to.equal(0);
            expect(sample!.oppositeCount).to.equal(0);
        });

        it("counts only genuinely independent peers toward agreement", () => {
            const targetSymbol = "NEAR+APT";
            const artifactsBySymbol = new Map<string, MinimalArtifacts>([
                [targetSymbol, buildMinimalArtifacts(true, false)],
                // shared-leg peers - must be ignored
                ["NEAR+SUI", buildMinimalArtifacts(true, false)],
                ["NEAR+DOGE", buildMinimalArtifacts(true, false)],
                // independent peers - both buy -> 2 agreements
                ["BTC+ETH", buildMinimalArtifacts(true, false)],
                ["SOL+XRP", buildMinimalArtifacts(true, false)],
            ]);

            const sample = buildConsensusTradeSample(
                targetSymbol,
                longTrade(),
                artifactsBySymbol as any,
                artifactsBySymbol.get(targetSymbol)! as any,
                1
            );

            expect(sample!.sameCount).to.equal(2);
            expect(sample!.oppositeCount).to.equal(0);
        });

        it("counts independent opposing peers as opposition, not agreement", () => {
            const targetSymbol = "NEAR+APT";
            const artifactsBySymbol = new Map<string, MinimalArtifacts>([
                [targetSymbol, buildMinimalArtifacts(true, false)],
                // shared-leg peer that would agree if counted - must be ignored
                ["NEAR+SUI", buildMinimalArtifacts(true, false)],
                // independent peer that fires sell -> opposition
                ["BTC+ETH", buildMinimalArtifacts(false, true)],
            ]);

            const sample = buildConsensusTradeSample(
                targetSymbol,
                longTrade(),
                artifactsBySymbol as any,
                artifactsBySymbol.get(targetSymbol)! as any,
                1
            );

            expect(sample!.sameCount).to.equal(0);
            expect(sample!.oppositeCount).to.equal(1);
        });

        it("reports zero agreement when target is the compressed form NEARAPT and peers are NEAR+X", () => {
            // Reproduces the exact shape Portfolio Lab produces in the wild:
            // benchmark = state.currentSymbol = "NEARAPT" (compressed),
            // peers = the user-entered "NEAR+X" list. Before the compressed-form
            // fix, isIndependentPeer returned true for every peer and the
            // breadth counter reported 12 agree / 0 oppose on a NEAR-only move.
            const targetSymbol = "NEARAPT";
            const artifactsBySymbol = new Map<string, MinimalArtifacts>([
                [targetSymbol, buildMinimalArtifacts(true, false)],
                ["NEAR+BNB", buildMinimalArtifacts(true, false)],
                ["NEAR+BTC", buildMinimalArtifacts(true, false)],
                ["NEAR+ETH", buildMinimalArtifacts(true, false)],
                ["NEAR+SUI", buildMinimalArtifacts(true, false)],
                ["NEAR+WLD", buildMinimalArtifacts(true, false)],
            ]);

            const sample = buildConsensusTradeSample(
                targetSymbol,
                longTrade(),
                artifactsBySymbol as any,
                artifactsBySymbol.get(targetSymbol)! as any,
                1
            );

            expect(sample).to.not.equal(null);
            expect(sample!.sameCount).to.equal(0);
            expect(sample!.oppositeCount).to.equal(0);
        });
    });

    describe("forecast breadth", () => {
        it("does not report persisted support when every peer shares a target leg", () => {
            const targetArtifacts = buildMinimalArtifacts(true, false);
            const artifactsBySymbol = new Map<string, MinimalArtifacts>([
                ["NEARAPT", targetArtifacts],
                ["NEAR+BNB", buildMinimalArtifacts(true, false)],
                ["NEAR+BTC", buildMinimalArtifacts(true, false)],
            ]);
            const weights = new Map<string, number>();

            const breadth = buildForecastSignalBreadthContext(
                "NEARAPT",
                targetArtifacts as any,
                0,
                "buy",
                artifactsBySymbol as any,
                1,
                weights
            );

            expect(breadth.activePeerCount).to.equal(0);
            expect(breadth.sameCount).to.equal(0);
            expect(computeSignalBreadthPersistence({
                benchmarkSymbol: "NEARAPT",
                runCache: artifactsBySymbol,
                lagBars: 1,
            } as any, targetArtifacts as any, 0, "buy", weights)).to.equal(0);
        });
    });
});
