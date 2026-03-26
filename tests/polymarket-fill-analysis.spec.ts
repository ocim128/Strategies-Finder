import { expect } from "chai";
import { describe, it } from "node:test";
import { analyzePolymarketFillability } from "../lib/polymarket-fill-analysis";
import type { PolymarketFillHistorySummary } from "../lib/polymarket-fill-history";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";
import type { Trade } from "../lib/types/strategies";

function makeTrade(id: number, type: Trade["type"], entryTs: number): Trade {
    return {
        id,
        type,
        entryTime: entryTs,
        entryPrice: 30_000,
        exitTime: entryTs + 300,
        exitPrice: 30_100,
        pnl: 10,
        pnlPercent: 0.3,
        size: 1,
        exitReason: "signal",
    };
}

function makeOutcomeRow(entryTs: number, yesPrices: Array<number | null>, resolvedUp: 0 | 1): PolymarketOutcomeRow {
    return {
        series_id: "10684",
        event_slug: `event-${entryTs}`,
        market_slug: `market-${entryTs}`,
        interval: "5m",
        event_start_ts: entryTs,
        event_end_ts: entryTs + 300,
        yes_token_id: "yes",
        no_token_id: "no",
        yes_open_price: yesPrices[0] ?? null,
        yes_entry_minute_1_price: yesPrices[1] ?? null,
        yes_entry_minute_2_price: yesPrices[2] ?? null,
        yes_entry_minute_3_price: yesPrices[3] ?? null,
        yes_entry_minute_4_price: yesPrices[4] ?? null,
        resolved_outcome_up: resolvedUp,
        resolution_source: "test",
        updated_at: 1,
    };
}

function makeHistorySummary(entryTs: number, yesMins: Array<number | null>, yesMaxes: Array<number | null>): PolymarketFillHistorySummary {
    return {
        eventStartTs: entryTs,
        yesTokenId: `yes-${entryTs}`,
        windows: yesMins.map((yesMinPrice, index) => ({
            yesMinPrice,
            yesMaxPrice: yesMaxes[index] ?? null,
            sampleCount: yesMinPrice === null && yesMaxes[index] === null ? 0 : 1,
        })),
    };
}

describe("Polymarket fill analysis", () => {
    it("counts cumulative YES fills across minute checkpoints", () => {
        const t1 = 1_700_000_300;
        const t2 = 1_700_000_600;
        const trades = [
            makeTrade(1, "long", t1),
            makeTrade(2, "long", t2),
        ];
        const outcomeByStartTs = new Map<number, PolymarketOutcomeRow>([
            [t1, makeOutcomeRow(t1, [0.55, 0.39, 0.39, 0.39, 0.39], 1)],
            [t2, makeOutcomeRow(t2, [0.48, 0.47, 0.46, 0.45, 0.44], 0)],
        ]);

        const analysis = analyzePolymarketFillability({
            trades,
            outcomeByStartTs,
            targetPriceCents: 40,
        });

        expect(analysis.selectedTrades).to.equal(2);
        expect(analysis.eligibleTrades).to.equal(2);
        expect(analysis.enrichedEligibleTrades).to.equal(0);
        expect(analysis.fallbackEligibleTrades).to.equal(2);
        expect(analysis.windows[0]?.filledTrades).to.equal(0);
        expect(analysis.windows[1]?.filledTrades).to.equal(1);
        expect(analysis.windows[4]?.filledTrades).to.equal(1);
        expect(analysis.windows[4]?.filledWinRate).to.equal(1);
    });

    it("uses implied NO prices for short trades", () => {
        const t1 = 1_700_001_200;
        const trades = [makeTrade(1, "short", t1)];
        const outcomeByStartTs = new Map<number, PolymarketOutcomeRow>([
            [t1, makeOutcomeRow(t1, [0.62, 0.64, 0.65, 0.62, 0.58], 0)],
        ]);

        const analysis = analyzePolymarketFillability({
            trades,
            outcomeByStartTs,
            targetPriceCents: 35,
            scope: "short",
        });

        expect(analysis.selectedTrades).to.equal(1);
        expect(analysis.enrichedEligibleTrades).to.equal(0);
        expect(analysis.fallbackEligibleTrades).to.equal(1);
        expect(analysis.windows[0]?.filledTrades).to.equal(0);
        expect(analysis.windows[2]?.filledTrades).to.equal(1);
        expect(analysis.windows[4]?.filledWinRate).to.equal(1);
    });

    it("tracks missing outcome rows and missing sampled prices separately", () => {
        const t1 = 1_700_002_100;
        const t2 = 1_700_002_400;
        const trades = [
            makeTrade(1, "long", t1),
            makeTrade(2, "long", t2),
        ];
        const outcomeByStartTs = new Map<number, PolymarketOutcomeRow>([
            [t1, makeOutcomeRow(t1, [null, null, null, null, null], 1)],
        ]);

        const analysis = analyzePolymarketFillability({
            trades,
            outcomeByStartTs,
            targetPriceCents: 40,
        });

        expect(analysis.selectedTrades).to.equal(2);
        expect(analysis.eligibleTrades).to.equal(1);
        expect(analysis.enrichedEligibleTrades).to.equal(0);
        expect(analysis.fallbackEligibleTrades).to.equal(1);
        expect(analysis.missingOutcomeTrades).to.equal(1);
        expect(analysis.windows[0]?.missingPriceTrades).to.equal(1);
        expect(analysis.windows[4]?.filledTrades).to.equal(0);
    });

    it("uses raw prices-history extrema when available instead of coarse synced checkpoints", () => {
        const t1 = 1_700_003_000;
        const trades = [makeTrade(1, "long", t1)];
        const outcomeByStartTs = new Map<number, PolymarketOutcomeRow>([
            [t1, makeOutcomeRow(t1, [0.50, 0.50, 0.50, 0.50, 0.50], 1)],
        ]);
        const historySummaryByStartTs = new Map<number, PolymarketFillHistorySummary>([
            [t1, makeHistorySummary(t1, [0.50, 0.495, 0.49, 0.49, 0.49], [0.50, 0.51, 0.52, 0.52, 0.52])],
        ]);

        const coarse = analyzePolymarketFillability({
            trades,
            outcomeByStartTs,
            targetPriceCents: 49,
        });
        const enriched = analyzePolymarketFillability({
            trades,
            outcomeByStartTs,
            historySummaryByStartTs,
            targetPriceCents: 49,
        });

        expect(coarse.windows[4]?.filledTrades).to.equal(0);
        expect(enriched.enrichedEligibleTrades).to.equal(1);
        expect(enriched.fallbackEligibleTrades).to.equal(0);
        expect(enriched.windows[2]?.filledTrades).to.equal(1);
        expect(enriched.windows[4]?.filledTrades).to.equal(1);
    });

    it("falls back to synced checkpoints when raw history enrichment has no usable samples", () => {
        const t1 = 1_700_003_300;
        const trades = [makeTrade(1, "long", t1)];
        const outcomeByStartTs = new Map<number, PolymarketOutcomeRow>([
            [t1, makeOutcomeRow(t1, [0.39, 0.39, 0.39, 0.39, 0.39], 1)],
        ]);
        const historySummaryByStartTs = new Map<number, PolymarketFillHistorySummary>([
            [t1, makeHistorySummary(t1, [null, null, null, null, null], [null, null, null, null, null])],
        ]);

        const analysis = analyzePolymarketFillability({
            trades,
            outcomeByStartTs,
            historySummaryByStartTs,
            targetPriceCents: 40,
        });

        expect(analysis.enrichedEligibleTrades).to.equal(0);
        expect(analysis.fallbackEligibleTrades).to.equal(1);
        expect(analysis.windows[0]?.filledTrades).to.equal(1);
        expect(analysis.windows[4]?.filledTrades).to.equal(1);
    });
});
