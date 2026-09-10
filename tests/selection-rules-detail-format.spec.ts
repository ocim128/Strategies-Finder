import { expect } from "chai";
import { describe, it } from "node:test";
import {
    appendDetailPage,
    detailStatusClass,
    detailStatusLabel,
    formatDetailPercent,
    formatDetailPp,
    formatDetailScore,
    formatDetailSignalTime,
    isStaleDetailResponse,
    parseDetailResultKey,
    selectionRulesDetailsUrl,
} from "../lib/selection-rules/detail-format";
import { SELECTION_RULES_DETAIL_PAGE_DEFAULT, SELECTION_RULES_DETAIL_PAGE_MAX } from "../lib/selection-rules/stream-types";

describe("selection-rules detail formatting helpers", () => {
    it("formats signal timestamps in UTC without entry/exit columns", () => {
        // 2023-11-14 22:13:20 UTC
        expect(formatDetailSignalTime(1_700_000_000)).to.equal("2023-11-14 22:13:20");
    });

    it("formats returns, deltas, and scores with n/a for unavailable values", () => {
        expect(formatDetailPercent(0.1534)).to.equal("+15.34%");
        expect(formatDetailPercent(-0.02)).to.equal("-2.00%");
        expect(formatDetailPercent(null)).to.equal("n/a");
        expect(formatDetailPp(0.1534)).to.equal("+15.34pp");
        expect(formatDetailPp(null)).to.equal("n/a");
        expect(formatDetailScore(1.5)).to.equal("1.5000");
    });

    it("labels the three detail statuses and derives their CSS classes", () => {
        expect(detailStatusLabel("COMPLETE")).to.equal("COMPLETE");
        expect(detailStatusLabel("PENDING")).to.equal("PENDING");
        expect(detailStatusLabel("SELECTED_OUTCOME_KNOWN_POOL_INCOMPLETE")).to.equal("POOL INCOMPLETE");
        expect(detailStatusClass("PENDING")).to.equal("selection-rules-detail-status-pending");
    });

    it("treats responses from another run (or no active run) as stale", () => {
        expect(isStaleDetailResponse({ runId: "run-a" }, "run-a")).to.equal(false);
        expect(isStaleDetailResponse({ runId: "run-b" }, "run-a")).to.equal(true);
        expect(isStaleDetailResponse({ runId: "run-a" }, null)).to.equal(true);
    });

    it("builds the details URL with the required query parameters", () => {
        expect(selectionRulesDetailsUrl("run a", "reference_alphabetical", 24, 250))
            .to.equal("/api/selection-rules/details?runId=run%20a&ruleKey=reference_alphabetical&horizonBars=24&offset=250&limit=250");
        expect(SELECTION_RULES_DETAIL_PAGE_DEFAULT).to.equal(250);
        expect(SELECTION_RULES_DETAIL_PAGE_MAX).to.equal(500);
    });

    it("parses the per-row detail button keys", () => {
        expect(parseDetailResultKey("reference_alphabetical|24")).to.deep.equal({ ruleKey: "reference_alphabetical", horizonBars: 24 });
        expect(parseDetailResultKey("no-horizon")).to.equal(null);
        expect(parseDetailResultKey("|24")).to.equal(null);
        expect(parseDetailResultKey("rule|zero")).to.equal(null);
    });

    it("accumulates history pages oldest-page-last for newest-first rendering", () => {
        const first = [{ signalTime: 300 }, { signalTime: 200 }];
        const second = [{ signalTime: 100 }];
        expect(appendDetailPage(first as never, second as never).map((row) => row.signalTime)).to.deep.equal([300, 200, 100]);
    });
});
