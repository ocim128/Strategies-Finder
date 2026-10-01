import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSp500CompanyInfoCsv, enumerateSp500Pairs, deriveReplayTargetsFromCanonicalPairs } from "../lib/batch-backtest/sp500-pair-enumerator";

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
    assert.equal(res.counts.sp500AssetsCount, 7);
    assert.equal(res.counts.catalogAssetsCount, 7);
    assert.equal(res.counts.usable30mSeedCount, 7);
    assert.equal(res.counts.usableTargetIntervalCount, 7);
    assert.deepEqual(res.eligibleAssets, FIXTURE_TICKERS);
    const expectedPairs = [
        "AAPL\u2022+AMGN\u2022", "AAPL\u2022+CVX\u2022", "AAPL\u2022+GOOGL\u2022", "AAPL\u2022+KO\u2022", "AAPL\u2022+MSFT\u2022", "AAPL\u2022+PANW\u2022",
        "AMGN\u2022+CVX\u2022", "AMGN\u2022+GOOGL\u2022", "AMGN\u2022+KO\u2022", "AMGN\u2022+MSFT\u2022", "AMGN\u2022+PANW\u2022",
        "CVX\u2022+GOOGL\u2022", "CVX\u2022+KO\u2022", "CVX\u2022+MSFT\u2022", "CVX\u2022+PANW\u2022",
        "GOOGL\u2022+KO\u2022", "GOOGL\u2022+MSFT\u2022", "GOOGL\u2022+PANW\u2022",
        "KO\u2022+MSFT\u2022", "KO\u2022+PANW\u2022", "MSFT\u2022+PANW\u2022",
    ];
    assert.equal(res.counts.pairCount, 21);
    assert.deepEqual(res.canonicalPairs, expectedPairs, "all unique unordered pairs in canonical order");
    assert.deepEqual(res.excludedAssets, []);
    assert.equal(res.counts.excludedPairsCount, 0);

    const capped = enumerateSp500Pairs({ interval: "4h", baseDir, maxPairs: 5 });
    assert.equal(capped.counts.pairCount, 5);
    assert.deepEqual(capped.canonicalPairs, expectedPairs.slice(0, 5), "the cap retains the ordered prefix");
}

function testCustomPairListText(baseDir: string): void {
    const customText = `CVX•+AMGN•\nPANW•+CVX•\nKO•+PANW•`;
    const res = enumerateSp500Pairs({ interval: "4h", baseDir, pairListText: customText });
    assert.equal(res.counts.pairCount, 3);
    assert.deepEqual(res.canonicalPairs, ["CVX\u2022+AMGN\u2022", "PANW\u2022+CVX\u2022", "KO\u2022+PANW\u2022"]);

    const bareLocal = enumerateSp500Pairs({
        interval: "4h",
        baseDir,
        pairListText: "AAPL+MSFT\nAAPL",
    });
    assert.deepEqual(
        bareLocal.canonicalPairs,
        ["AAPL•+MSFT•", "AAPL•"],
        "Bare tickers present in the local IBKR catalog should use the IBKR loader.",
    );

    const rejected = enumerateSp500Pairs({
        interval: "4h",
        baseDir,
        pairListText: "AAPL•+MSFT•\nMISSING•+AMGN•\nAAPL•+AAPL•",
    });
    assert.deepEqual(rejected.skippedPairTokens, ["MISSING•+AMGN•"]);
    assert.deepEqual(rejected.rejectedPairTokens, ["AAPL•+AAPL•"]);
    assert.deepEqual(rejected.excludedAssets, ["MISSING"]);

    const partiallyAvailable = enumerateSp500Pairs({
        interval: "4h",
        baseDir,
        pairListText: "AAPL•+MSFT•\nMISSING•+AMGN•\nUNKNOWN•+PANW•",
    });
    assert.deepEqual(partiallyAvailable.canonicalPairs, ["AAPL•+MSFT•"]);
    assert.deepEqual(partiallyAvailable.eligibleTargets, [
        { asset: "AAPL", symbol: "AAPL•" },
        { asset: "MSFT", symbol: "MSFT•" },
    ]);
    assert.deepEqual(
        partiallyAvailable.skippedPairTokens,
        ["MISSING•+AMGN•", "UNKNOWN•+PANW•"],
        "a missing leg skips its whole pair without pulling the available mate into the evaluation target set",
    );
    assert.deepEqual(partiallyAvailable.rejectedPairTokens, []);
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

function testDeriveReplayTargetsFromCanonicalPairs(): void {
    // Audit (smoke-replay-bounds finding): the coordinator's replay target
    // loader must be derivable from the pairs a run actually executes, so a
    // maxPairs smoke run never loads the full universe's datasets.
    const targets = deriveReplayTargetsFromCanonicalPairs([
        "BTCUSDT+ETHUSDT",
        "ZECUSDT+APTUSDT",
        "BTCUSDT+APTUSDT",
        "MSFTUSDT",
    ]);
    assert.deepEqual(
        targets,
        [
            { asset: "APT", symbol: "APTUSDT" },
            { asset: "BTC", symbol: "BTCUSDT" },
            { asset: "ETH", symbol: "ETHUSDT" },
            { asset: "MSFT", symbol: "MSFTUSDT" },
            { asset: "ZEC", symbol: "ZECUSDT" },
        ],
        "targets must cover exactly the pair legs, deduped and asset-sorted",
    );

    assert.deepEqual(
        deriveReplayTargetsFromCanonicalPairs([]),
        [],
        "an empty pair list derives an empty target set",
    );
}

function main(): void {
    const baseDir = createPriceDataFixture();
    try {
        testParseCsv();
        testEnumerationOrderingAndExclusion(baseDir);
        testCustomPairListText(baseDir);
        testCustomCryptoMarkets();
        testDeriveReplayTargetsFromCanonicalPairs();
        console.log("PASS: sp500-pair-enumerator.spec.ts");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
}

main();
