import { describe, it } from "node:test";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BATCH_BACKTEST_REQUIRED_IDS } from "../lib/batch-backtest/batch-backtest-dom";
import { formatPortfolioFitSummary, shortFingerprint } from "../lib/batch-backtest/batch-portfolio-fit-summary";
import { resolvePortfolioFitOptions } from "../lib/batch-backtest/batch-portfolio-fit-types";
import type { BatchPortfolioFitResult } from "../lib/batch-backtest/batch-portfolio-fit-types";

function result(): BatchPortfolioFitResult {
    return {
        schemaVersion: 1,
        fingerprint: "fp-test",
        generatedAt: 1_700_000_000_000,
        asOfTimeKey: "1700000000",
        engine: "typescript",
        rows: [{
            asset: "BTC",
            direction: "long",
            decision: "ADD_SMALL",
            allocationFraction: 0.05,
            allocationAmount: 500,
            expectedEdgePct: 0.02,
            volatilityPct: 0.01,
            expectedShortfallPct: -0.01,
            marginalVolatilityPct: 0.002,
            marginalExpectedShortfallPct: -0.001,
            maxAcceptedCorrelation: 0.4,
            reasonCodes: ["ACCEPTED_WITHIN_LIMITS"],
            allocationLimitReasonCodes: ["PORTFOLIO_CAP_REACHED"],
        }],
        portfolio: {
            allocatedFraction: 0.05,
            expectedReturnPct: 0.001,
            volatilityPct: 0.002,
            expectedShortfallPct: -0.001,
            grossLongFraction: 0.05,
            grossShortFraction: 0,
        },
        warnings: [],
        kellyFraction: null,
        baseAllocationSource: "direct_fraction_fallback_fixed",
        configuredKellyFraction: "half",
    };
}

describe("Portfolio Fit copy", () => {
    it("labels output experimental and reports allocation provenance", () => {
        const lines = formatPortfolioFitSummary(result());
        expect(lines.some((line) => line.includes("EXPERIMENTAL"))).to.equal(true);
        expect(lines.some((line) => line.includes("direct_fraction_fallback_fixed"))).to.equal(true);
        expect(lines.some((line) => line.includes("allocationLimit [PORTFOLIO_CAP_REACHED]"))).to.equal(true);
    });

    it("uses a stable short fingerprint", () => {
        expect(shortFingerprint("fp-test")).to.equal(shortFingerprint("fp-test"));
        expect(shortFingerprint(null)).to.equal("--");
    });

    it("rejects invalid supported option values and ignores removed options", () => {
        const options = resolvePortfolioFitOptions({
            correlationCap: 2,
            allocationIncrement: -1,
        } as never);
        expect(options.correlationCap).to.equal(0.85);
        expect("allocationIncrement" in options).to.equal(false);
    });
});

describe("Portfolio Fit DOM contract", () => {
    const ids = [
        "batchBacktestPortfolioFitBtn",
        "batchBacktestCopyPortfolioFitBtn",
        "batchBacktestPortfolioFitSummary",
        "batchBacktestPortfolioFitResults",
    ];

    it("registers and renders all required ids", () => {
        const html = readFileSync(join(process.cwd(), "html-partials", "tab-batch-backtest.html"), "utf8");
        for (const id of ids) {
            expect(BATCH_BACKTEST_REQUIRED_IDS).to.include(id);
            expect(html).to.include(`id="${id}"`);
        }
    });
});
