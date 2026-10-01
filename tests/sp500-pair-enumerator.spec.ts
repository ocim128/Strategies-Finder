import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateSp500Pairs, deriveReplayTargetsFromCanonicalPairs } from "../lib/batch-backtest/sp500-pair-enumerator";

const FIXTURE_TICKERS = ["AAPL", "AMGN", "CVX", "GOOGL", "KO", "MSFT", "PANW"];

function createPriceDataFixture(): string {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-pair-enumerator-"));
    const ibkrDir = join(baseDir, "price-data", "ibkr");
    const seedDir = join(ibkrDir, "csv", "30m");
    mkdirSync(seedDir, { recursive: true });

    writeFileSync(
        join(ibkrDir, "catalog.json"),
        JSON.stringify({ entries: FIXTURE_TICKERS.map((symbol) => ({ symbol })) }),
    );
    for (const ticker of FIXTURE_TICKERS) {
        writeFileSync(join(seedDir, `${ticker}.csv`), "time,open,high,low,close,volume\n");
    }
    return baseDir;
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
        assert.throws(() => enumerateSp500Pairs({ baseDir }), /explicit pair list/);
        assert.throws(() => enumerateSp500Pairs({ baseDir, pairListText: "  " }), /explicit pair list/);
        testCustomPairListText(baseDir);
        testCustomCryptoMarkets();
        testDeriveReplayTargetsFromCanonicalPairs();
        console.log("PASS: sp500-pair-enumerator.spec.ts");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
}

main();
