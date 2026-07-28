import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSp500CompanyInfoCsv, enumerateSp500Pairs } from "../lib/batch-backtest/sp500-pair-enumerator";
import { stripIbkrMarker } from "../lib/local-daily-datasets";

const FIXTURE_TICKERS = ["AAPL", "AMGN", "CVX", "GOOGL", "KO", "MSFT", "PANW"];

function createPriceDataFixture(): string {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-pair-enumerator-"));
    const companyInfoDir = join(
        baseDir,
        "price-data",
        "sp500_comprehensive_dataset",
        "sp500_comprehensive",
    );
    const ibkrDir = join(baseDir, "price-data", "ibkr");
    const seedDir = join(ibkrDir, "csv", "30m");
    mkdirSync(companyInfoDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    writeFileSync(
        join(companyInfoDir, "sp500_company_info.csv"),
        `Ticker,Name\n${FIXTURE_TICKERS.map((ticker) => `${ticker},${ticker} Inc.`).join("\n")}\n`,
    );
    writeFileSync(
        join(ibkrDir, "catalog.json"),
        JSON.stringify({ entries: FIXTURE_TICKERS.map((symbol) => ({ symbol })) }),
    );
    for (const ticker of FIXTURE_TICKERS) {
        writeFileSync(join(seedDir, `${ticker}.csv`), "time,open,high,low,close,volume\n");
    }
    return baseDir;
}

function testParseCsv(): void {
    const csvContent = `Ticker,Name,Sector,Industry,MarketCap,Country,Website,Employees
AAPL,Apple Inc.,Technology,Consumer Electronics,3888777003008,United States,https://www.apple.com,150000.0
MSFT,Microsoft Corporation,Technology,Software - Infrastructure,2952363507712,United States,https://www.microsoft.com,228000.0
GOOGL,Alphabet Inc.,Communication Services,Internet Content & Information,3810313371648,United States,https://abc.xyz,190820.0
`;
    const tickers = parseSp500CompanyInfoCsv(csvContent);
    assert.deepEqual(tickers, ["AAPL", "MSFT", "GOOGL"]);
}

function testEnumerationOrderingAndExclusion(baseDir: string): void {
    const res = enumerateSp500Pairs({ interval: "4h", baseDir });
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
        const capped = enumerateSp500Pairs({ baseDir, maxPairs: 5 });
        assert.equal(capped.canonicalPairs.length, 5);
        assert.equal(capped.counts.pairCount, 5);
    }
}

function testCustomPairListText(baseDir: string): void {
    const customText = `CVX•+AMGN•\nPANW•+CVX•\nKO•+PANW•`;
    const res = enumerateSp500Pairs({ interval: "4h", baseDir, pairListText: customText });
    assert.ok(res.counts.pairCount <= 3, "Should parse custom pair list lines");
    assert.ok(res.canonicalPairs.length > 0, "Should extract canonical pairs from custom list");
}

function testCustomCryptoMarkets(): void {
    const res = enumerateSp500Pairs({
        interval: "15m",
        pairListText: "BTCUSDT\nZEC+APT\nBTCUSDT+ETHUSDT",
    });
    assert.deepEqual(
        res.canonicalPairs,
        ["BTCUSDT", "ZECUSDT+APTUSDT", "BTCUSDT+ETHUSDT"],
        "Direct and synthetic crypto markets should remain loader-ready.",
    );
    assert.deepEqual(
        res.eligibleTargets,
        [
            { asset: "APT", symbol: "APTUSDT" },
            { asset: "BTC", symbol: "BTCUSDT" },
            { asset: "ETH", symbol: "ETHUSDT" },
            { asset: "ZEC", symbol: "ZECUSDT" },
        ],
        "Replay targets should map scoring assets to their real crypto markets.",
    );
    assert.equal(res.counts.excludedPairsCount, 0);
}

function main(): void {
    const baseDir = createPriceDataFixture();
    try {
        testParseCsv();
        testEnumerationOrderingAndExclusion(baseDir);
        testCustomPairListText(baseDir);
        testCustomCryptoMarkets();
        console.log("PASS: sp500-pair-enumerator.spec.ts");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
}

main();
