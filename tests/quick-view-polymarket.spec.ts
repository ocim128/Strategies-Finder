import { expect } from "chai";
import { describe, it } from "node:test";
import {
    countDistinctPolymarketOutcomeRows,
    computePolymarketBestBaselineWinRate,
    summarizePolymarketStreaks,
    summarizeRecentPolymarketForm,
} from "../lib/quick-view";
import type { Trade } from "../lib/strategies/index";

function makeTrade(id: number, isWin: boolean | null): Trade {
    return {
        id,
        type: "long",
        entryTime: 1_700_000_000 + id * 300,
        entryPrice: 30_000,
        exitTime: 1_700_000_300 + id * 300,
        exitPrice: 30_100,
        pnl: isWin === false ? -10 : 10,
        pnlPercent: isWin === false ? -0.3 : 0.3,
        size: 1,
        exitReason: "signal",
        polymarketOutcome: isWin === null ? null : {
            eventStartTs: 1_700_000_000 + id * 300,
            eventEndTs: 1_700_000_300 + id * 300,
            eventSlug: `event-${id}`,
            marketSlug: `market-${id}`,
            prediction: "yes",
            actualOutcomeUp: isWin ? 1 : 0,
            isWin,
        },
    };
}

describe("Quick View Polymarket streak summary", () => {
    it("counts longest win and loss streaks and breaks on missing outcomes", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, true),
            makeTrade(3, false),
            makeTrade(4, false),
            makeTrade(5, false),
            makeTrade(6, null),
            makeTrade(7, true),
            makeTrade(8, true),
            makeTrade(9, true),
            makeTrade(10, false),
        ];

        const summary = summarizePolymarketStreaks(trades);

        expect(summary.longestWinStreak).to.equal(3);
        expect(summary.longestLossStreak).to.equal(3);
    });

    it("summarizes recent form from the latest scored trades only", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, null),
            makeTrade(3, false),
            makeTrade(4, true),
            makeTrade(5, true),
            makeTrade(6, false),
        ];

        const summary = summarizeRecentPolymarketForm(trades, 4);

        expect(summary.recentFormTrades).to.equal(4);
        expect(summary.recentFormWins).to.equal(2);
        expect(summary.recentFormLosses).to.equal(2);
        expect(summary.recentFormWinRate).to.equal(0.5);
    });

    it("computes the best naive baseline from scored trade outcomes", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, true),
            makeTrade(3, false),
            makeTrade(4, true),
            makeTrade(5, null),
        ];

        const baseline = computePolymarketBestBaselineWinRate(trades);

        expect(baseline).to.equal(0.75);
    });

    it("computes best win streak on the last 100 trades slice", () => {
        const trades: Trade[] = [];
        for (let i = 1; i <= 110; i++) {
            trades.push(makeTrade(i, i <= 10 ? true : false));
        }
        for (let i = 106; i <= 110; i++) {
            trades[i - 1] = makeTrade(i, true);
        }

        const summary = summarizePolymarketStreaks(trades.slice(-100));

        expect(summary.longestWinStreak).to.equal(5);
    });

    it("counts distinct annotated outcome rows instead of defaulting to zero", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, false),
            {
                ...makeTrade(3, true),
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    isWin: true,
                },
            },
            makeTrade(4, null),
        ];

        expect(countDistinctPolymarketOutcomeRows(trades)).to.equal(2);
    });
});
