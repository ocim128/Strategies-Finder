import assert from "node:assert/strict";
import { parseSp500CompanyInfoCsv, enumerateSp500Pairs } from "../lib/batch-backtest/sp500-pair-enumerator";
import { stripIbkrMarker } from "../lib/local-daily-datasets";

function testParseCsv(): void {
    const csvContent = `Ticker,Name,Sector,Industry,MarketCap,Country,Website,Employees
AAPL,Apple Inc.,Technology,Consumer Electronics,3888777003008,United States,https://www.apple.com,150000.0
MSFT,Microsoft Corporation,Technology,Software - Infrastructure,2952363507712,United States,https://www.microsoft.com,228000.0
GOOGL,Alphabet Inc.,Communication Services,Internet Content & Information,3810313371648,United States,https://abc.xyz,190820.0
`;
    const tickers = parseSp500CompanyInfoCsv(csvContent);
    assert.deepEqual(tickers, ["AAPL", "MSFT", "GOOGL"]);
}

function testEnumerationOrderingAndExclusion(): void {
    const res = enumerateSp500Pairs({ interval: "4h" });
    assert.ok(res.counts.sp500AssetsCount > 0, "Should detect S&P 500 assets");
    assert.ok(res.counts.catalogAssetsCount >= 0, "Catalog count >= 0");
    assert.ok(res.eligibleAssets.length >= 0, "Eligible assets array exists");

    // Test canonical ordering and exclusion of reverse pairs
    for (const pair of res.canonicalPairs) {
        const parts = pair.split("+");
        assert.equal(parts.length, 2, "Pair should contain 2 assets split by +");
        const baseClean = stripIbkrMarker(parts[0]);
        const quoteClean = stripIbkrMarker(parts[1]);
        assert.ok(baseClean < quoteClean, `Base asset ${baseClean} must be strictly less than quote asset ${quoteClean}`);
    }

    // Verify maxPairs cap
    if (res.canonicalPairs.length > 5) {
        const capped = enumerateSp500Pairs({ maxPairs: 5 });
        assert.equal(capped.canonicalPairs.length, 5);
        assert.equal(capped.counts.pairCount, 5);
    }
}

function testCustomPairListText(): void {
    const customText = `CVX•+AMGN•\nPANW•+CVX•\nKO•+PANW•`;
    const res = enumerateSp500Pairs({ interval: "4h", pairListText: customText });
    assert.ok(res.counts.pairCount <= 3, "Should parse custom pair list lines");
    assert.ok(res.canonicalPairs.length > 0, "Should extract canonical pairs from custom list");
}

function main(): void {
    testParseCsv();
    testEnumerationOrderingAndExclusion();
    testCustomPairListText();
    console.log("PASS: sp500-pair-enumerator.spec.ts");
}

main();
