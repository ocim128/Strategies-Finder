import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    canonicalizeLegIdentity,
    dedupeWithinProviderAliases,
    detectAliasCollisions,
    hasKnownQuoteSuffix,
    stripKnownQuoteSuffix,
    type CanonicalLegIdentity,
} from "../lib/synthetic-leg-identity";
import { parseSyntheticPairToken } from "../lib/synthetic-pair-token";
import { parsePortfolioSyntheticPairSymbol } from "../lib/synthetic-pair-parser";

describe("synthetic-leg-identity", () => {
    describe("canonicalizeLegIdentity — parity with existing parsers", () => {
        it("preserves diamond-marked stock legs end-to-end (matches parseSyntheticPairToken)", () => {
            // Existing parser keeps AAPL♦ as-is.
            const existing = parseSyntheticPairToken("AAPL\u2666+BTCUSDT");
            assert.deepEqual(existing, { baseSymbol: "AAPL\u2666", quoteSymbol: "BTCUSDT" });
            // The leaf must keep the same loader symbol for the marked leg.
            const id = canonicalizeLegIdentity("AAPL\u2666");
            assert.equal(id?.loaderSymbol, "AAPL\u2666");
            assert.equal(id?.emittedToken, "AAPL\u2666");
            assert.equal(id?.scoringAsset, "AAPL");
            assert.equal(id?.provider, "stock");
        });

        it("preserves bullet-marked IBKR legs end-to-end", () => {
            const existing = parseSyntheticPairToken("NVDA\u2022+AAPL\u2022");
            assert.deepEqual(existing, { baseSymbol: "NVDA\u2022", quoteSymbol: "AAPL\u2022" });
            const id = canonicalizeLegIdentity("NVDA\u2022");
            assert.equal(id?.loaderSymbol, "NVDA\u2022");
            assert.equal(id?.emittedToken, "NVDA\u2022");
            assert.equal(id?.scoringAsset, "NVDA");
            assert.equal(id?.provider, "ibkr");
        });

        it("resolves bare crypto tokens to Binance USDT-quoted symbols (matches the batch loader)", () => {
            // Existing parser: bare BTC -> BTCUSDT.
            const existing = parseSyntheticPairToken("BNB+PAXG");
            assert.deepEqual(existing, { baseSymbol: "BNBUSDT", quoteSymbol: "PAXGUSDT" });
            const btc = canonicalizeLegIdentity("BTC");
            assert.equal(btc?.loaderSymbol, "BTCUSDT");
            assert.equal(btc?.scoringAsset, "BTC");
            assert.equal(btc?.provider, "market");
        });

        it("preserves existing quote-suffix tokens verbatim (BTCUSDT stays BTCUSDT)", () => {
            const id = canonicalizeLegIdentity("BTCUSDT");
            assert.equal(id?.loaderSymbol, "BTCUSDT");
            assert.equal(id?.scoringAsset, "BTC");
        });

        it("handles USDC-quoted tokens (recognized by the union of parser suffix lists)", () => {
            // Portfolio parser recognizes USD/USDC; synthetic-pair-token does too via USDC.
            const id = canonicalizeLegIdentity("ETHUSDC");
            assert.equal(id?.loaderSymbol, "ETHUSDC");
            assert.equal(id?.scoringAsset, "ETH");
        });

        it("normalizes case and whitespace", () => {
            const a = canonicalizeLegIdentity("  btc  ");
            const b = canonicalizeLegIdentity("BTC");
            assert.deepEqual(a, b);
        });

        it("rejects empty input", () => {
            assert.equal(canonicalizeLegIdentity(""), null);
            assert.equal(canonicalizeLegIdentity("   "), null);
        });

        it("rejects tokens containing +", () => {
            assert.equal(canonicalizeLegIdentity("BTC+ETH"), null);
        });

        it("rejects marker characters that are not proper suffix markers", () => {
            // A diamond marker in the middle of the token is malformed.
            assert.equal(canonicalizeLegIdentity("AAP\u2666L"), null);
            // A leading marker is malformed.
            assert.equal(canonicalizeLegIdentity("\u2666AAPL"), null);
        });
    });

    describe("hasKnownQuoteSuffix / stripKnownQuoteSuffix", () => {
        it("matches the longest known suffix (USDC does not shadow USD)", () => {
            assert.ok(hasKnownQuoteSuffix("ETHUSDC"));
            assert.equal(stripKnownQuoteSuffix("ETHUSDC"), "ETH");
            // FDUSD > USDT in length so it wins.
            assert.equal(stripKnownQuoteSuffix("BTCFDUSD"), "BTC");
            // The trailing USD on a USDC token is NOT stripped because USDC matches first.
            assert.equal(stripKnownQuoteSuffix("ETHUSD"), "ETH");
        });

        it("returns the input unchanged when no known suffix is present", () => {
            assert.equal(stripKnownQuoteSuffix("NEAR"), "NEAR");
            assert.equal(hasKnownQuoteSuffix("NEAR"), false);
        });

        it("requires a non-empty base prefix (does not strip the entire token)", () => {
            // "USD" alone has no base; hasKnownQuoteSuffix must be false.
            assert.equal(hasKnownQuoteSuffix("USD"), false);
            assert.equal(stripKnownQuoteSuffix("USD"), "USD");
        });
    });

    describe("dedupeWithinProviderAliases", () => {
        it("collapses BTC and BTCUSDT to one identity (same provider + scoring asset)", () => {
            const btc = canonicalizeLegIdentity("BTC")!;
            const btcUsdt = canonicalizeLegIdentity("BTCUSDT")!;
            const eth = canonicalizeLegIdentity("ETH")!;
            const out = dedupeWithinProviderAliases([btc, btcUsdt, eth]);
            assert.equal(out.length, 2);
            // First-seen token wins (BTC, not BTCUSDT).
            assert.equal(out[0]!.emittedToken, "BTCUSDT");
            assert.equal(out[1]!.scoringAsset, "ETH");
        });

        it("keeps same-scoring-asset tokens from different providers separate", () => {
            // NOTE: cross-provider collisions are reported separately and the
            // generator fails loudly, but dedupe itself preserves provider
            // distinction so a future "mixed" mode could surface the choice.
            const stock = canonicalizeLegIdentity("AAPL\u2666")!;
            const ibkr = canonicalizeLegIdentity("AAPL\u2022")!;
            const out = dedupeWithinProviderAliases([stock, ibkr]);
            assert.equal(out.length, 2);
        });

        it("preserves first-appearance order", () => {
            const a = canonicalizeLegIdentity("XRP")!;
            const b = canonicalizeLegIdentity("ADA")!;
            const c = canonicalizeLegIdentity("DOT")!;
            const out = dedupeWithinProviderAliases([a, b, c]);
            assert.deepEqual(out.map((x) => x.scoringAsset), ["XRP", "ADA", "DOT"]);
        });
    });

    describe("detectAliasCollisions", () => {
        it("returns no collisions when all scoring assets map to one provider", () => {
            const ids = ["BTC", "ETH", "XRP"].map((t) => canonicalizeLegIdentity(t)!) as CanonicalLegIdentity[];
            assert.deepEqual(detectAliasCollisions(ids), []);
        });

        it("flags a cross-provider collision (stock ♦ vs IBKR • on AAPL)", () => {
            const ids = [
                canonicalizeLegIdentity("AAPL\u2666")!,
                canonicalizeLegIdentity("AAPL\u2022")!,
            ];
            const collisions = detectAliasCollisions(ids);
            assert.equal(collisions.length, 1);
            assert.equal(collisions[0]!.scoringAsset, "AAPL");
            assert.equal(collisions[0]!.tokens.length, 2);
        });

        it("flags multiple independent collisions, sorted by scoring asset", () => {
            const ids = [
                canonicalizeLegIdentity("MSFT\u2666")!,
                canonicalizeLegIdentity("MSFT\u2022")!,
                canonicalizeLegIdentity("AAPL\u2666")!,
                canonicalizeLegIdentity("AAPL\u2022")!,
            ];
            const collisions = detectAliasCollisions(ids);
            assert.equal(collisions.length, 2);
            assert.equal(collisions[0]!.scoringAsset, "AAPL");
            assert.equal(collisions[1]!.scoringAsset, "MSFT");
        });

        it("does NOT flag the same token listed twice as a collision", () => {
            const ids = [
                canonicalizeLegIdentity("AAPL\u2666")!,
                canonicalizeLegIdentity("AAPL\u2666")!,
            ];
            // Same provider + same token -> not a cross-provider collision.
            assert.deepEqual(detectAliasCollisions(ids), []);
        });
    });

    describe("parsePortfolioSyntheticPairSymbol — parity with existing parser", () => {
        // These are the same fixtures already locked in stock-market-data.spec.ts.
        // We repeat them here so the shared-identity leaf's behavior can be
        // compared side-by-side with the existing portfolio parser.
        it("parses a Binance pair into base/quote assets and symbols", () => {
            const parsed = parsePortfolioSyntheticPairSymbol("near+apt");
            assert.deepEqual(parsed, {
                baseAsset: "NEAR",
                quoteAsset: "APT",
                baseSymbol: "NEARUSDT",
                quoteSymbol: "APTUSDT",
                syntheticSymbol: "NEARAPT",
            });
        });

        it("preserves diamond-marked stock legs", () => {
            const parsed = parsePortfolioSyntheticPairSymbol("NVDA\u2666+AAPL\u2666");
            assert.equal(parsed?.baseSymbol, "NVDA\u2666");
            assert.equal(parsed?.baseAsset, "NVDA");
        });

        it("preserves bullet-marked IBKR legs", () => {
            const parsed = parsePortfolioSyntheticPairSymbol("NVDA\u2022+AAPL\u2022");
            assert.equal(parsed?.baseSymbol, "NVDA\u2022");
            assert.equal(parsed?.baseAsset, "NVDA");
        });
    });
});
