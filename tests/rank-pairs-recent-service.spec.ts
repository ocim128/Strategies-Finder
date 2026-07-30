import { expect } from "chai";
import { describe, it } from "node:test";
import {
    formatRecentCopyText,
    formatRecentOverallSummary,
    RECENT_COPY_COLUMNS,
    RECENT_COPY_HEADER,
    recentBadgeLabelFor,
    type RecentRankResult,
} from "../lib/rank-pairs/rank-pairs-service";
import type { RecentPairType } from "../lib/rank-pairs/recent-pair-classifier";

function result(
    symbol: string,
    type: RecentPairType,
    status: RecentRankResult["status"] = "ok",
): RecentRankResult {
    return {
        symbol,
        status,
        error: status === "failed" ? "load failed" : undefined,
        recent: {
            symbol,
            type,
            direction: type === "D" ? "BASE" : type === "E" ? "QUOTE" : type === "J" ? "THIN" : "NEUTRAL",
            label: type === "J" ? "TYPE J — THIN" : `TYPE ${type} — TEST`,
            reason: type === "J" ? "INSUFFICIENT_BARS" : "OK",
            metrics: {
                barCount: type === "J" ? 100 : 200,
                asOf: 1_735_689_600,
                ratioReturn: 0.10,
                logReturn: 0.0953,
                pathEfficiency: 0.20,
                reversalRate: 0.30,
                volatilityRatio: 1.10,
                baselineTrendStrength: 0.50,
                recentTrendStrength: 0.60,
                levelShiftSigma: 0.70,
            },
        },
    };
}

describe("rank-pairs latest-200 presentation", () => {
    it("summarizes TYPE A through TYPE J without treating failures as chart types", () => {
        const summary = formatRecentOverallSummary([
            result("A", "A"),
            result("B", "F"),
            result("C", "J", "no_data"),
            result("D", "J", "failed"),
        ]);
        expect(summary).to.include("Pairs 4");
        expect(summary).to.include("TYPE A 1");
        expect(summary).to.include("TYPE F 1");
        expect(summary).to.include("TYPE J 1");
        expect(summary).to.include("FAILED 1");
    });

    it("uses a separate versioned copy contract with one field per column", () => {
        const text = formatRecentCopyText([
            result("Z", "J", "no_data"),
            result("A", "A"),
        ]);
        const lines = text.split("\n");
        expect(lines[0]).to.equal(RECENT_COPY_HEADER);
        expect(lines[1]).to.equal(RECENT_COPY_COLUMNS.join(" | "));
        for (const line of lines.slice(2)) {
            expect(line.split(" | ")).to.have.length(RECENT_COPY_COLUMNS.length);
        }
        expect(lines[2].startsWith("A | ok | A |")).to.equal(true);
    });

    it("surfaces TYPE J reasons and load failures in badges", () => {
        expect(recentBadgeLabelFor(result("A", "J", "no_data")))
            .to.equal("TYPE J — THIN (INSUFFICIENT_BARS)");
        expect(recentBadgeLabelFor(result("B", "J", "failed"))).to.equal("FAIL");
    });
});
