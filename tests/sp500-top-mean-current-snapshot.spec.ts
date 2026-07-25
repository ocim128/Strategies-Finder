import { expect } from "chai";
import { describe, it } from "node:test";
import {
    computeCurrentTopMeanSnapshot,
    reduceCurrentTopMeanSnapshot,
    resolveCommonEndpoint,
    resolveOpenPairContribution,
} from "../lib/batch-backtest/sp500-top-mean-current-snapshot";
import type { CompactPairArtifact } from "../lib/batch-backtest/compact-pair-artifact";
import type { Time } from "lightweight-charts";

/**
 * Phase-1 current-snapshot reducer tests. The conventions mirrored here are
 * the live-snapshot semantics already locked by `tests/batch-backtest-copy.spec.ts`
 * for the Batch `TOP_MEAN NOW` line:
 *
 *   - open long pair:  base +1, quote -1
 *   - open short pair: base -1, quote +1
 *   - candidate:       rawScore > 0 AND activePairs > 0
 *   - selection key:   rawScore / activePairs
 *
 * The fixture at the bottom (AAA/BBB/CCC at mean=1.0) is the SAME fixture the
 * Batch `TOP_MEAN NOW` parity test uses, so the two surfaces stay in lockstep.
 */

const ENDPOINT = 1_700_000_000;

function openPair(
    symbol: string,
    type: "long" | "short",
    opts: {
        baseAsset?: string;
        quoteAsset?: string;
        dataEndTime?: number;
        pairIndex?: number;
        entryTime?: number;
    } = {},
): CompactPairArtifact {
    const parsedBase = opts.baseAsset ?? symbol.split("+")[0] ?? symbol;
    const parsedQuote = opts.quoteAsset ?? symbol.split("+")[1] ?? symbol;
    return {
        schema: "compact_pair_artifact.v1",
        pairIndex: opts.pairIndex ?? 0,
        symbol,
        baseAsset: parsedBase,
        quoteAsset: parsedQuote,
        baseSymbol: `${parsedBase}USDT`,
        quoteSymbol: `${parsedQuote}USDT`,
        trades: [
            { type, entryTime: (opts.entryTime ?? 1) as Time, exitTime: 2 as Time, exitReason: "end_of_data" },
        ],
        ...(opts.dataEndTime !== undefined ? { dataEndTime: opts.dataEndTime } : {}),
    };
}

function closedPair(symbol: string, exitReason = "signal"): CompactPairArtifact {
    const [baseAsset = symbol, quoteAsset = symbol] = symbol.split("+");
    return {
        schema: "compact_pair_artifact.v1",
        pairIndex: 0,
        symbol,
        baseAsset,
        quoteAsset,
        baseSymbol: `${baseAsset}USDT`,
        quoteSymbol: `${quoteAsset}USDT`,
        trades: [
            { type: "long", entryTime: 1 as Time, exitTime: 2 as Time, exitReason },
        ],
        dataEndTime: ENDPOINT,
    };
}

function asyncFrom(...arts: CompactPairArtifact[]): AsyncIterable<CompactPairArtifact> {
    return (async function* () {
        for (const a of arts) yield a;
    })();
}

describe("resolveOpenPairContribution", () => {
    it("long pair -> base +1, quote -1", () => {
        const c = resolveOpenPairContribution(openPair("AAA+BBB", "long"));
        expect(c).to.not.equal(null);
        expect(c!.sign).to.equal(1);
        expect(c!.baseAsset).to.equal("AAA");
        expect(c!.quoteAsset).to.equal("BBB");
    });

    it("short pair flips signs (base -1, quote +1)", () => {
        const c = resolveOpenPairContribution(openPair("AAA+BBB", "short"));
        expect(c).to.not.equal(null);
        expect(c!.sign).to.equal(-1);
    });

    it("returns null when the last trade is closed (non end_of_data)", () => {
        expect(resolveOpenPairContribution(closedPair("AAA+BBB", "signal"))).to.equal(null);
        expect(resolveOpenPairContribution(closedPair("AAA+BBB", "stop_loss"))).to.equal(null);
    });

    it("returns null when there are no trades", () => {
        const empty: CompactPairArtifact = {
            schema: "compact_pair_artifact.v1",
            pairIndex: 0,
            symbol: "AAA+BBB",
            baseAsset: "AAA",
            quoteAsset: "BBB",
            baseSymbol: "AAAUSDT",
            quoteSymbol: "BBBUSDT",
            trades: [],
            dataEndTime: ENDPOINT,
        };
        expect(resolveOpenPairContribution(empty)).to.equal(null);
    });
});

describe("resolveCommonEndpoint", () => {
    it("picks the most common finite dataEndTime", async () => {
        const r = await resolveCommonEndpoint(asyncFrom(
            openPair("A+B", "long", { dataEndTime: 100 }),
            openPair("C+D", "long", { dataEndTime: 100 }),
            openPair("E+F", "long", { dataEndTime: 200 }),
        ));
        expect(r.endpoint).to.equal(100);
        expect(r.processed).to.equal(3);
        expect(r.missing).to.equal(0);
    });

    it("counts artifacts missing dataEndTime as missing (not malformed)", async () => {
        const r = await resolveCommonEndpoint(asyncFrom(
            openPair("A+B", "long"),
            openPair("C+D", "long", { dataEndTime: 100 }),
        ));
        expect(r.endpoint).to.equal(100);
        expect(r.missing).to.equal(1);
        expect(r.malformed).to.equal(0);
    });

    it("rejects non-finite endpoints as malformed without throwing", async () => {
        const malformed: CompactPairArtifact = {
            ...openPair("A+B", "long"),
            dataEndTime: Number.NaN,
        };
        const r = await resolveCommonEndpoint(asyncFrom(malformed));
        expect(r.endpoint).to.equal(null);
        expect(r.malformed).to.equal(1);
    });

    it("returns null endpoint when no artifact carries a usable dataEndTime", async () => {
        const r = await resolveCommonEndpoint(asyncFrom(
            openPair("A+B", "long"),
            openPair("C+D", "long"),
        ));
        expect(r.endpoint).to.equal(null);
        expect(r.missing).to.equal(2);
    });

    it("F3: rejects a 50/50 endpoint split as no consensus (no strict majority)", async () => {
        // 1x endpoint 200, 1x endpoint 100 -> 50/50 split. Voting on either
        // would rank on half the universe; refuse a pick instead.
        const r = await resolveCommonEndpoint(asyncFrom(
            openPair("A+B", "long", { dataEndTime: 200 }),
            openPair("C+D", "long", { dataEndTime: 100 }),
        ));
        expect(r.endpoint).to.equal(null);
        expect(r.noConsensus).to.equal(true);
        expect(r.endpointTotal).to.equal(2);
        expect(r.endpointCount).to.equal(1);
    });

    it("F3: accepts a strict-majority endpoint (>50%)", async () => {
        // endpoint 100 appears 3x, endpoint 200 appears 1x -> 3/4 = 75% > 50%.
        const r = await resolveCommonEndpoint(asyncFrom(
            openPair("A+B", "long", { dataEndTime: 100 }),
            openPair("C+D", "long", { dataEndTime: 100 }),
            openPair("E+F", "long", { dataEndTime: 100 }),
            openPair("G+H", "long", { dataEndTime: 200 }),
        ));
        expect(r.endpoint).to.equal(100);
        expect(r.noConsensus).to.equal(false);
        expect(r.endpointCount).to.equal(3);
        expect(r.endpointTotal).to.equal(4);
    });

    it("F3: rejects a 3/3/1 split (top count 3, total 7, 3*2 <= 7 -> no majority)", async () => {
        const r = await resolveCommonEndpoint(asyncFrom(
            openPair("A+B", "long", { dataEndTime: 100 }),
            openPair("C+D", "long", { dataEndTime: 100 }),
            openPair("E+F", "long", { dataEndTime: 100 }),
            openPair("G+H", "long", { dataEndTime: 200 }),
            openPair("I+J", "long", { dataEndTime: 200 }),
            openPair("K+L", "long", { dataEndTime: 200 }),
            openPair("M+N", "long", { dataEndTime: 300 }),
        ));
        expect(r.endpoint).to.equal(null);
        expect(r.noConsensus).to.equal(true);
    });

    it("F3: requireStrictMajority=false falls back to plurality (older endpoint on tie)", async () => {
        // Same 50/50 split, but plurality mode: older endpoint (100) wins.
        const r = await resolveCommonEndpoint(
            asyncFrom(
                openPair("A+B", "long", { dataEndTime: 200 }),
                openPair("C+D", "long", { dataEndTime: 100 }),
            ),
            undefined,
            { requireStrictMajority: false },
        );
        expect(r.endpoint).to.equal(100);
        expect(r.noConsensus).to.equal(false);
    });
});

describe("reduceCurrentTopMeanSnapshot", () => {
    it("returns empty reason for no artifacts", async () => {
        const r = await reduceCurrentTopMeanSnapshot(asyncFrom(), { commonEndpoint: ENDPOINT });
        expect(r.snapshot.reason).to.equal("empty");
        expect(r.snapshot.winners).to.deep.equal([]);
        // No artifacts -> no observable endpoint even when a filter is set.
        expect(r.snapshot.asOf).to.equal(null);
        expect(r.snapshot.artifacts).to.equal(0);
    });

    it("returns no_open_positions when all trades are closed", async () => {
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(closedPair("AAA+BBB")),
            { commonEndpoint: ENDPOINT },
        );
        expect(r.snapshot.reason).to.equal("no_open_positions");
        expect(r.snapshot.openPositions).to.equal(0);
        // Saw artifacts at the endpoint (just none open) -> asOf reports it.
        expect(r.snapshot.asOf).to.equal(ENDPOINT);
    });

    it("accumulates long-pair votes: base +1, quote -1", async () => {
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(openPair("AAA+BBB", "long", { dataEndTime: ENDPOINT })),
            { commonEndpoint: ENDPOINT },
        );
        const map = new Map(r.snapshot.candidates.map((c) => [c.asset, c]));
        // AAA: score +1, activePairs 1, mean 1.0 (positive candidate)
        expect(map.get("AAA")).to.deep.include({ asset: "AAA", score: 1, activePairs: 1 });
        expect(map.get("AAA")!.mean).to.be.closeTo(1, 1e-9);
        // BBB: score -1 -> not a positive candidate, absent.
        expect(map.has("BBB")).to.equal(false);
        expect(r.snapshot.winners.map((w) => w.asset)).to.deep.equal(["AAA"]);
    });

    it("short pair: base -1, quote +1 makes the QUOTE the positive candidate", async () => {
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(openPair("AAA+BBB", "short", { dataEndTime: ENDPOINT })),
            { commonEndpoint: ENDPOINT },
        );
        const map = new Map(r.snapshot.candidates.map((c) => [c.asset, c]));
        expect(map.has("AAA")).to.equal(false);
        expect(map.get("BBB")).to.deep.include({ asset: "BBB", score: 1, activePairs: 1 });
        expect(r.snapshot.winners.map((w) => w.asset)).to.deep.equal(["BBB"]);
    });

    it("nets opposing directions across pairs on the same asset", async () => {
        // AAA+BBB long (AAA +1, BBB -1) and AAA+CCC short (AAA -1, CCC +1)
        // -> AAA nets to 0, BBB -1, CCC +1. Only CCC is a positive candidate.
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(
                openPair("AAA+BBB", "long", { dataEndTime: ENDPOINT, pairIndex: 0 }),
                openPair("AAA+CCC", "short", { dataEndTime: ENDPOINT, pairIndex: 1 }),
            ),
            { commonEndpoint: ENDPOINT },
        );
        const map = new Map(r.snapshot.candidates.map((c) => [c.asset, c]));
        expect(map.has("AAA")).to.equal(false); // nets to 0, not > 0
        expect(map.has("BBB")).to.equal(false); // -1
        expect(map.get("CCC")).to.deep.include({ asset: "CCC", score: 1, activePairs: 1 });
    });

    it("excludes stale-endpoint artifacts and reports their count", async () => {
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(
                openPair("AAA+BBB", "long", { dataEndTime: ENDPOINT }),
                openPair("CCC+DDD", "long", { dataEndTime: ENDPOINT + 9999 }),
            ),
            { commonEndpoint: ENDPOINT },
        );
        expect(r.stats.staleEndpoints).to.equal(1);
        // Only AAA+BBB contributed; CCC+DDD was excluded by endpoint filter.
        expect(r.snapshot.winners.map((w) => w.asset)).to.deep.equal(["AAA"]);
        // F5: snapshot.artifacts counts ONLY endpoint-eligible contributors
        // (1 here, since CCC+DDD was stale). stats.artifactsProcessed counts
        // every artifact seen (2). The two must NOT be equal when anything
        // was filtered out.
        expect(r.snapshot.artifacts).to.equal(1);
        expect(r.stats.artifactsProcessed).to.equal(2);
    });

    it("returns no_positive_candidates when every asset nets to <= 0", async () => {
        // Two short pairs whose bases are unique but quotes cancel out the
        // positive candidates:
        //   "BBB+AAA" short -> BBB -1, AAA +1
        //   "AAA+BBB" short -> AAA -1, BBB +1
        // Net: AAA 0, BBB 0 -> no positive candidate.
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(
                openPair("BBB+AAA", "short", { dataEndTime: ENDPOINT, pairIndex: 0 }),
                openPair("AAA+BBB", "short", { dataEndTime: ENDPOINT, pairIndex: 1 }),
            ),
            { commonEndpoint: ENDPOINT },
        );
        expect(r.snapshot.reason).to.equal("no_positive_candidates");
        expect(r.snapshot.winners).to.deep.equal([]);
        expect(r.snapshot.openPositions).to.equal(2);
    });

    it("PARITY: matches the Batch TOP_MEAN NOW fixture (AAA/BBB/CCC tie at mean=1.0)", async () => {
        // Same fixture as tests/batch-backtest-copy.spec.ts:
        //   AAA: 3 long pairs as base -> score=+3, activePairs=3, mean=1.0
        //   BBB: 1 long pair as base  -> score=+1, activePairs=1, mean=1.0
        //   CCC: 5 long pairs as base -> score=+5, activePairs=5, mean=1.0
        // TOP_MEAN NOW ties AAA=BBB=CCC at mean=1.0 — all three are surfaced.
        const arts: CompactPairArtifact[] = [
            ...[1, 2, 3].map((i) => openPair(`AAA+X${i}`, "long", { dataEndTime: ENDPOINT, pairIndex: i })),
            openPair("BBB+Y1", "long", { dataEndTime: ENDPOINT, pairIndex: 4 }),
            ...[1, 2, 3, 4, 5].map((i) => openPair(`CCC+Z${i}`, "long", { dataEndTime: ENDPOINT, pairIndex: i + 4 })),
        ];
        const r = await reduceCurrentTopMeanSnapshot(asyncFrom(...arts), { commonEndpoint: ENDPOINT });

        // All three assets are positive candidates.
        const map = new Map(r.snapshot.candidates.map((c) => [c.asset, c]));
        expect(map.get("AAA")).to.deep.include({ score: 3, activePairs: 3 });
        expect(map.get("AAA")!.mean).to.be.closeTo(1, 1e-9);
        expect(map.get("BBB")).to.deep.include({ score: 1, activePairs: 1 });
        expect(map.get("BBB")!.mean).to.be.closeTo(1, 1e-9);
        expect(map.get("CCC")).to.deep.include({ score: 5, activePairs: 5 });
        expect(map.get("CCC")!.mean).to.be.closeTo(1, 1e-9);

        // Winners = all three tied at mean=1.0, sorted by score desc then name.
        expect(r.snapshot.winners.map((w) => w.asset)).to.deep.equal(["CCC", "AAA", "BBB"]);
        expect(r.snapshot.reason).to.equal("tied");
        expect(r.stats.tieCount).to.equal(3);
    });

    it("does NOT collapse a tie into a single arbitrary pick", async () => {
        // Two unrelated pairs: AAA+P long, BBB+Q long -> both mean=1.0 -> tie.
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(
                openPair("AAA+P", "long", { dataEndTime: ENDPOINT, pairIndex: 0 }),
                openPair("BBB+Q", "long", { dataEndTime: ENDPOINT, pairIndex: 1 }),
            ),
            { commonEndpoint: ENDPOINT },
        );
        expect(r.snapshot.reason).to.equal("tied");
        const winnerAssets = r.snapshot.winners.map((w) => w.asset).sort();
        expect(winnerAssets).to.deep.equal(["AAA", "BBB"]);
    });

    it("picks a unique winner when exactly one asset is positive", async () => {
        // A single long pair: AAA is the base (+1), BBB the quote (-1).
        // AAA is the only positive candidate -> unique winner, reason "ok".
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(openPair("AAA+BBB", "long", { dataEndTime: ENDPOINT })),
            { commonEndpoint: ENDPOINT },
        );
        expect(r.snapshot.reason).to.equal("ok");
        expect(r.snapshot.winners.map((w) => w.asset)).to.deep.equal(["AAA"]);
        expect(r.snapshot.winners[0]!.mean).to.be.closeTo(1, 1e-9);
        // F6: a unique winner is NOT a tie; tieCount is 0, not 1.
        expect(r.stats.tieCount).to.equal(0);
    });

    it("reconstructs the latest decision event separately from the closed-candle endpoint", async () => {
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(openPair("AAA+BBB", "long", {
                dataEndTime: ENDPOINT,
                entryTime: ENDPOINT + 14_400,
            })),
            { commonEndpoint: ENDPOINT },
        );

        // A direct reducer call has no second pass to discover the latest
        // decision event. The one-shot coordinator path supplies that pass.
        expect(r.decision).to.equal(undefined);

        const computed = await computeCurrentTopMeanSnapshot(
            () => asyncFrom(openPair("AAA+BBB", "long", {
                dataEndTime: ENDPOINT,
                entryTime: ENDPOINT + 14_400,
            })),
        );
        expect(computed.decision).to.deep.include({
            status: "VERIFY_ENTRY_WINDOW",
            reason: "latest_decision_event",
            asset: "AAA",
            decisionTime: ENDPOINT + 14_400,
            entryPairs: 1,
            entryRule: "first_target_bar_strictly_after_decision",
            researchNotionalUsd: 1000,
            researchHoldBars: 24,
            researchExitRule: "24th_bar_close",
            verification: "manual_entry_window_check",
        });
    });

    it("does not claim a live entry when the latest event is tied", async () => {
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(
                openPair("AAA+P", "long", {
                    dataEndTime: ENDPOINT,
                    entryTime: ENDPOINT,
                    pairIndex: 0,
                }),
                openPair("BBB+Q", "long", {
                    dataEndTime: ENDPOINT,
                    entryTime: ENDPOINT,
                    pairIndex: 1,
                }),
            ),
            { commonEndpoint: ENDPOINT },
        );

        expect(r.snapshot.reason).to.equal("tied");
        expect(r.decision).to.equal(undefined);

        const computed = await computeCurrentTopMeanSnapshot(
            () => asyncFrom(
                openPair("AAA+P", "long", {
                    dataEndTime: ENDPOINT,
                    entryTime: ENDPOINT + 14_400,
                }),
                openPair("BBB+Q", "long", {
                    dataEndTime: ENDPOINT,
                    entryTime: ENDPOINT + 14_400,
                    pairIndex: 1,
                }),
            ),
        );
        expect(computed.decision?.status).to.equal("NO_TRADE");
        expect(computed.decision?.reason).to.equal("tied");
        expect(computed.decision?.asset).to.equal(null);
    });

    it("keeps the decision-event winner separate from a later exit-only snapshot change", async () => {
        const first = openPair("AAA+P", "long", {
            dataEndTime: ENDPOINT,
            entryTime: 100,
        });
        first.trades[0]!.exitTime = 300 as Time;
        first.trades[0]!.exitReason = "signal";
        const second = openPair("BBB+Q", "long", {
            dataEndTime: ENDPOINT,
            entryTime: 200,
            pairIndex: 1,
        });

        const computed = await computeCurrentTopMeanSnapshot(() => asyncFrom(first, second));

        // At the latest entry event (200), AAA and BBB tie. After AAA exits at
        // 300, the current open-position snapshot contains only BBB.
        expect(computed.snapshot.winners.map((w) => w.asset)).to.deep.equal(["BBB"]);
        expect(computed.decision?.decisionTime).to.equal(200);
        expect(computed.decision?.status).to.equal("NO_TRADE");
        expect(computed.decision?.reason).to.equal("tied");
        expect(computed.decision?.asset).to.equal(null);
    });

    it("handles malformed artifacts without throwing (missing trades)", async () => {
        const malformed: CompactPairArtifact = {
            schema: "compact_pair_artifact.v1",
            pairIndex: 0,
            symbol: "AAA+BBB",
            baseAsset: "AAA",
            quoteAsset: "BBB",
            baseSymbol: "AAAUSDT",
            quoteSymbol: "BBBUSDT",
            trades: undefined as unknown as CompactPairArtifact["trades"],
            dataEndTime: ENDPOINT,
        };
        const r = await reduceCurrentTopMeanSnapshot(
            asyncFrom(malformed, openPair("CCC+DDD", "long", { dataEndTime: ENDPOINT })),
            { commonEndpoint: ENDPOINT },
        );
        // Malformed skipped (no open position); CCC still wins.
        expect(r.snapshot.winners.map((w) => w.asset)).to.deep.equal(["CCC"]);
        expect(r.snapshot.openPositions).to.equal(1);
    });
});

describe("computeCurrentTopMeanSnapshot (bounded multi-pass)", () => {
    it("F3: returns no_common_endpoint on a 50/50 endpoint split", async () => {
        const factory = () => asyncFrom(
            openPair("A+B", "long", { dataEndTime: 100 }),
            openPair("C+D", "long", { dataEndTime: 200 }),
        );
        // 50/50 split -> no strict majority -> refuse to rank on half the universe.
        const r = await computeCurrentTopMeanSnapshot(factory);
        expect(r.snapshot.reason).to.equal("no_common_endpoint");
        expect(r.snapshot.asOf).to.equal(null);
        expect(r.snapshot.winners).to.deep.equal([]);
    });

    it("F3: picks the strict-majority endpoint and excludes the minority as stale", async () => {
        // endpoint 300 appears 3x (strict majority of 4), endpoint 400 1x.
        const factory = () => asyncFrom(
            openPair("AAA+X1", "long", { dataEndTime: 300, pairIndex: 0 }),
            openPair("AAA+X2", "long", { dataEndTime: 300, pairIndex: 1 }),
            openPair("BBB+Y1", "long", { dataEndTime: 300, pairIndex: 2 }),
            openPair("CCC+Z1", "long", { dataEndTime: 400, pairIndex: 3 }), // stale
        );
        const r = await computeCurrentTopMeanSnapshot(factory);
        expect(r.snapshot.asOf).to.equal(300);
        expect(r.snapshot.reason).to.equal("tied");
        expect(r.stats.staleEndpoints).to.equal(1);
        expect(r.snapshot.winners.map((w) => w.asset).sort()).to.deep.equal(["AAA", "BBB"]);
    });

    it("returns empty when NO artifact carries a usable endpoint", async () => {
        const factory = () => asyncFrom(
            openPair("A+B", "long"),
            openPair("C+D", "long"),
        );
        const r = await computeCurrentTopMeanSnapshot(factory);
        expect(r.snapshot.reason).to.equal("empty");
        expect(r.snapshot.asOf).to.equal(null);
        expect(r.snapshot.winners).to.deep.equal([]);
        expect(r.stats.missingEndpoints).to.be.greaterThan(0);
    });

    it("respects shouldStop during the endpoint pass", async () => {
        let calls = 0;
        const factory = () => (async function* () {
            for (let i = 0; i < 10; i++) {
                calls += 1;
                yield openPair(`A${i}+B${i}`, "long", { dataEndTime: ENDPOINT, pairIndex: i });
            }
        })();
        const r = await computeCurrentTopMeanSnapshot(factory, {
            shouldStop: () => calls >= 3,
        });
        // Stopped mid-pass; reducer returns empty snapshot, asOf null.
        expect(r.snapshot.reason).to.equal("empty");
        expect(r.snapshot.asOf).to.equal(null);
    });
});
