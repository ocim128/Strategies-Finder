import { describe, it } from "node:test";
import { expect } from "chai";
import {
    findPostSignalLimitEntryFill,
    findPostSignalLimitExitFill,
    clampPolymarketPostSignalLimitEntryPriceCents,
    clampPolymarketPostSignalLimitExitPriceCents,
    clampPolymarketPostSignalLimitOffsetCents,
    resolvePolymarketLimitExitTargetPrice,
} from "../lib/polymarket-post-signal-limit-entry";
import { getPolymarketSidePrice } from "../lib/polymarket-price-points";
import type { PolymarketPricePoint } from "../lib/local-sqlite-polymarket-api";

function point(ts: number, yes: number | null, no: number | null = null): PolymarketPricePoint {
    return {
        series_id: "btc-5m",
        event_start_ts: 1_000,
        event_end_ts: 1_300,
        market_slug: "btc-updown-5m",
        yes_token_id: "yes",
        no_token_id: "no",
        ts,
        yes_price: yes,
        no_price: no,
        updated_at: ts,
    };
}

describe("Polymarket post-signal limit entry", () => {
    it("fills when the selected side touches the limit before the cutoff", () => {
        const result = findPostSignalLimitEntryFill(
            [point(1_060, 0.61), point(1_090, 0.5), point(1_120, 0.48)],
            { side: "yes", startTs: 1_050, eventEndTs: 1_300, limitPrice: 0.5 }
        );

        expect(result.status).to.equal("filled");
        expect(result.fillTs).to.equal(1_090);
        expect(result.fillPrice).to.equal(0.5);
        expect(result.entryImprovement).to.be.closeTo(0.11, 1e-12);
    });

    it("derives NO from YES only when no_price is absent", () => {
        expect(getPolymarketSidePrice(point(1_060, 0.42, null), "no")).to.be.closeTo(0.58, 1e-12);
        expect(getPolymarketSidePrice(point(1_060, 0.42, 0.55), "no")).to.equal(0.55);

        const result = findPostSignalLimitEntryFill(
            [point(1_060, 0.5), point(1_090, 0.52)],
            { side: "no", startTs: 1_050, eventEndTs: 1_300, limitPrice: 0.49 }
        );

        expect(result.status).to.equal("filled");
        expect(result.fillTs).to.equal(1_090);
    });

    it("separates no touch, missing price points, final-minute-only touch, and invalid windows", () => {
        expect(findPostSignalLimitEntryFill(
            [point(1_060, 0.7), point(1_090, 0.61)],
            { side: "yes", startTs: 1_050, eventEndTs: 1_300, limitPrice: 0.5 }
        ).status).to.equal("not_touched");

        expect(findPostSignalLimitEntryFill(
            [],
            { side: "yes", startTs: 1_050, eventEndTs: 1_300, limitPrice: 0.5 }
        ).status).to.equal("missing_price_points");

        expect(findPostSignalLimitEntryFill(
            [point(1_250, 0.49)],
            { side: "yes", startTs: 1_050, eventEndTs: 1_300, limitPrice: 0.5 }
        ).status).to.equal("last_minute_only");

        expect(findPostSignalLimitEntryFill(
            [point(1_090, 0.49)],
            { side: "yes", startTs: 1_240, eventEndTs: 1_300, limitPrice: 0.5 }
        ).status).to.equal("invalid_window");
    });

    it("allows an exact chart signal-exit timestamp but rejects later fills", () => {
        const exact = findPostSignalLimitEntryFill(
            [point(1_090, 0.51), point(1_110, 0.49)],
            { side: "yes", startTs: 1_050, eventEndTs: 1_300, limitPrice: 0.5, latestAllowedTs: 1_110 }
        );
        expect(exact.status).to.equal("filled");
        expect(exact.fillTs).to.equal(1_110);

        const result = findPostSignalLimitEntryFill(
            [point(1_090, 0.51), point(1_120, 0.49)],
            { side: "yes", startTs: 1_050, eventEndTs: 1_300, limitPrice: 0.5, latestAllowedTs: 1_110 }
        );

        expect(result.status).to.equal("invalid_window");
        expect(result.firstDisallowedTouchTs).to.equal(1_120);
    });

    it("derives a signal-offset entry limit from the first side quote", () => {
        const result = findPostSignalLimitEntryFill(
            [point(1_060, 0.60), point(1_090, 0.42), point(1_120, 0.40)],
            {
                side: "yes",
                startTs: 1_050,
                eventEndTs: 1_300,
                priceMode: "signal_offset",
                offsetPrice: 0.20,
            }
        );

        expect(result.status).to.equal("filled");
        expect(result.firstAvailablePrice).to.equal(0.60);
        expect(result.limitPrice).to.equal(0.40);
        expect(result.fillTs).to.equal(1_120);
        expect(result.fillPrice).to.equal(0.40);
    });

    it("keeps zero-offset signal entries equal to sub-cent first quotes", () => {
        const result = findPostSignalLimitEntryFill(
            [point(1_060, 0.604), point(1_090, 0.602)],
            {
                side: "yes",
                startTs: 1_050,
                eventEndTs: 1_300,
                priceMode: "signal_offset",
                offsetPrice: 0,
            }
        );

        expect(result.status).to.equal("filled");
        expect(result.firstAvailablePrice).to.equal(0.604);
        expect(result.limitPrice).to.equal(0.604);
        expect(result.fillTs).to.equal(1_060);
        expect(result.fillPrice).to.equal(0.604);
        expect(result.entryImprovement).to.equal(0);
    });

    it("fills fixed and entry-offset exit targets after entry fill", () => {
        const offsetTarget = resolvePolymarketLimitExitTargetPrice(0.60, {
            exitMode: "entry_offset",
            exitOffsetCents: 20,
        });
        expect(offsetTarget).to.equal(0.80);

        const offsetFill = findPostSignalLimitExitFill(
            [point(1_060, 0.60), point(1_090, 0.79), point(1_120, 0.82)],
            { side: "yes", startTs: 1_060, eventEndTs: 1_300, targetPrice: offsetTarget }
        );
        expect(offsetFill.status).to.equal("filled");
        expect(offsetFill.fillTs).to.equal(1_120);
        expect(offsetFill.fillPrice).to.equal(0.80);

        const fixedTarget = resolvePolymarketLimitExitTargetPrice(0.60, {
            exitMode: "fixed_price",
            exitPriceCents: 75,
        });
        expect(fixedTarget).to.equal(0.75);
    });

    it("marks entry-offset exit targets at or above one dollar as unreachable", () => {
        const target = resolvePolymarketLimitExitTargetPrice(0.80, {
            exitMode: "entry_offset",
            exitOffsetCents: 20,
        });
        expect(target).to.equal(null);

        const result = findPostSignalLimitExitFill(
            [point(1_060, 0.80), point(1_120, 0.99)],
            { side: "yes", startTs: 1_060, eventEndTs: 1_300, targetPrice: target }
        );
        expect(result.status).to.equal("unreachable");
    });

    it("clamps cents to the supported integer range", () => {
        expect(clampPolymarketPostSignalLimitEntryPriceCents(-3)).to.equal(1);
        expect(clampPolymarketPostSignalLimitEntryPriceCents(140)).to.equal(99);
        expect(clampPolymarketPostSignalLimitEntryPriceCents("47.8")).to.equal(48);
        expect(clampPolymarketPostSignalLimitEntryPriceCents("bad")).to.equal(50);
        expect(clampPolymarketPostSignalLimitEntryPriceCents("")).to.equal(50);
        expect(clampPolymarketPostSignalLimitExitPriceCents("bad")).to.equal(80);
        expect(clampPolymarketPostSignalLimitExitPriceCents("")).to.equal(80);
        expect(clampPolymarketPostSignalLimitOffsetCents("")).to.equal(20);
    });
});
