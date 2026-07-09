import { expect } from "chai";
import { describe, it } from "node:test";
import {
    aggregateLegScores,
    type LegScoreRow,
} from "../lib/signal-committee-score";

type TestLegScoreRow = LegScoreRow & { voteDirection?: "long" | "short" | null };

/**
 * Per-leg decomposition tests.
 *
 * Synthetic-pair exposure splits into two opposite underlying-leg votes:
 *   long  BASE/QUOTE -> +1 base,  -1 quote
 *   short BASE/QUOTE -> -1 base,  +1 quote
 *
 * The committee headline score can hide this: 3 short ZECAPT votes net to
 * -3 at the member level, but decompose to -3 ZEC and +3 APT at the leg
 * level. These tests pin that decomposition so the leaderboard can't silently
 * drift from the ratio-pair convention.
 */

function openLong(overrides: Partial<TestLegScoreRow> = {}): TestLegScoreRow {
    return {
        streamId: "s",
        ok: true,
        latestTrade: { entryTimeSec: 1, entryPrice: 100, isOpen: true },
        latestClose: 110,
        symbol: "BTCUSDT",
        syntheticPair: null,
        voteDirection: "long",
        ...overrides,
    };
}

describe("signal-committee / aggregateLegScores", () => {
    it("decomposes 3 short ZECAPT into ZEC -3 and APT +3", () => {
        // The user's headline example: shorting the ZEC/APT ratio pair is
        // short ZEC and long APT. Three such members should net to -3 / +3,
        // not collapse to a single -3.
        const rows: TestLegScoreRow[] = [1, 2, 3].map((i) => openLong({
            streamId: `s${i}`,
            symbol: "ZECAPT",
            syntheticPair: { baseSymbol: "ZEC", quoteSymbol: "APT" },
            voteDirection: "short",
        }));
        const legs = aggregateLegScores(rows);
        const bySymbol = new Map(legs.map((l) => [l.symbol, l]));
        expect(bySymbol.get("ZEC")?.score).to.equal(-3);
        expect(bySymbol.get("ZEC")?.shortCount).to.equal(3);
        expect(bySymbol.get("APT")?.score).to.equal(3);
        expect(bySymbol.get("APT")?.longCount).to.equal(3);
    });

    it("decomposes a long APTZEC synthetic into APT +1 and ZEC -1", () => {
        // Second example, with base/quote flipped: long APT/ZEC is long APT,
        // short ZEC.
        const rows: TestLegScoreRow[] = [openLong({
            symbol: "APTZEC",
            syntheticPair: { baseSymbol: "APT", quoteSymbol: "ZEC" },
        })];
        const legs = aggregateLegScores(rows);
        const bySymbol = new Map(legs.map((l) => [l.symbol, l]));
        expect(bySymbol.get("APT")?.score).to.equal(1);
        expect(bySymbol.get("ZEC")?.score).to.equal(-1);
    });

    it("counts a non-synthetic member directly under its own symbol", () => {
        const rows: TestLegScoreRow[] = [openLong({
            symbol: "BTCUSDT",
            syntheticPair: null,
        })];
        const legs = aggregateLegScores(rows);
        const bySymbol = new Map(legs.map((l) => [l.symbol, l]));
        expect(bySymbol.get("BTCUSDT")?.score).to.equal(1);
        expect(bySymbol.get("BTCUSDT")?.longCount).to.equal(1);
        expect(bySymbol.get("BTCUSDT")?.syntheticOnly).to.equal(false);
    });

    it("marks legs as syntheticOnly when no direct member voted on them", () => {
        const rows: TestLegScoreRow[] = [openLong({
            symbol: "ZECAPT",
            syntheticPair: { baseSymbol: "ZEC", quoteSymbol: "APT" },
        })];
        const legs = aggregateLegScores(rows);
        const bySymbol = new Map(legs.map((l) => [l.symbol, l]));
        // Both legs came from decomposition; neither had a direct member.
        expect(bySymbol.get("ZEC")?.syntheticOnly).to.equal(true);
        expect(bySymbol.get("APT")?.syntheticOnly).to.equal(true);
    });

    it("keeps direct member symbols and synthetic leg symbols separate", () => {
        // Synthetic decomposition uses the raw base/quote currency from the
        // pair (e.g. "BTC"), while a direct member's symbol is the full pair
        // (e.g. "BTCUSDT"). They are different strings and must NOT merge,
        // otherwise unrelated symbols would silently combine.
        const rows: TestLegScoreRow[] = [
            openLong({
                streamId: "direct",
                symbol: "BTCUSDT",
                syntheticPair: null,
            }),
            openLong({
                streamId: "synthetic",
                symbol: "BTCPAXG",
                syntheticPair: { baseSymbol: "BTC", quoteSymbol: "PAXG" },
                voteDirection: "short",
            }),
        ];
        const legs = aggregateLegScores(rows);
        const bySymbol = new Map(legs.map((l) => [l.symbol, l]));
        // Direct BTCUSDT long stays as its own leg.
        expect(bySymbol.get("BTCUSDT")?.score).to.equal(1);
        expect(bySymbol.get("BTCUSDT")?.syntheticOnly).to.equal(false);
        // Synthetic legs are the raw currencies; -1 BTC and +1 PAXG.
        expect(bySymbol.get("BTC")?.score).to.equal(-1);
        expect(bySymbol.get("BTC")?.syntheticOnly).to.equal(true);
        expect(bySymbol.get("PAXG")?.score).to.equal(1);
    });

    it("skips flat and excluded members", () => {
        const rows: TestLegScoreRow[] = [
            openLong({ symbol: "BTCUSDT" }),
            openLong({ ok: false, symbol: "ETHUSDT" }),
            openLong({
                // closed trade -> flat -> no vote
                latestTrade: { entryTimeSec: 1, entryPrice: 100, isOpen: false },
                symbol: "SOLUSDT",
            }),
        ];
        const legs = aggregateLegScores(rows);
        const symbols = legs.map((l) => l.symbol).sort();
        expect(symbols).to.deep.equal(["BTCUSDT"]);
    });

    it("sorts by absolute score desc, then alphabetically", () => {
        const rows: TestLegScoreRow[] = [
            openLong({ streamId: "a", symbol: "AAA" }),
            openLong({ streamId: "b", symbol: "BBB", voteDirection: "short" }),
            openLong({ streamId: "c", symbol: "CCC" }),
            openLong({ streamId: "d", symbol: "DDD" }),
        ];
        const legs = aggregateLegScores(rows);
        // AAA +1, CCC +1, DDD +1 tie at |1| -> alphabetical (AAA, CCC, DDD);
        // BBB -1 also at |1|, alphabetically before CCC and DDD but after AAA.
        expect(legs.map((l) => `${l.symbol}:${l.score}`)).to.deep.equal([
            "AAA:1",
            "BBB:-1",
            "CCC:1",
            "DDD:1",
        ]);
    });

    it("returns empty when no members have open trades", () => {
        expect(aggregateLegScores([])).to.deep.equal([]);
    });
});
