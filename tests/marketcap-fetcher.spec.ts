/**
 * Focused unit tests for the EDGAR + Alpaca-splits market-cap fetcher leaf.
 *
 * Locks the Phase 1 contract from docs/marketcap-download.md:
 *  - URL builders (no secrets, CIK zero-padding)
 *  - EDGAR ticker map parsing with `.`→`-` share-class normalization
 *  - the point-in-time step function keyed by `filed` (availability), with
 *    same-filed dedupe (latest wins) and positive-finite `val` validation
 *  - the split-factor convention: `applySplitFactors` MULTIPLIES each raw
 *    EDGAR count by the cumulative share-count multiplier of later splits —
 *    locked by the NVDA 10:1 cap-invariance test
 *      `adjPrice × adjustedShares === rawPrice × rawShares`
 *  - Alpaca corporate-actions parsing (pagination token, unrecognized
 *    payloads throw) and the paged fetch
 *  - the tickers disk cache (age check, atomic write, loud fetch failure)
 * No real network — `fetch` is stubbed per-test.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    EDGAR_USER_AGENT,
    applySplitFactors,
    buildAlpacaSplitsUrl,
    buildCompanyTickersUrl,
    buildEdgarConceptUrl,
    fetchAlpacaSplits,
    fetchEdgarSharesOutstanding,
    loadCompanyTickersCached,
    lookupSharesForDate,
    normalizeEdgarTicker,
    parseAlpacaSplits,
    parseCompanyTickers,
    parseSharesOutstandingFacts,
    type SharesFactPoint,
} from "../lib/ibkr-data/shares-outstanding-fetcher";
import { HttpStatusError } from "../lib/vite-http-utils";

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchResponses: Response[] = [];

function pushResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): void {
    const status = init.status ?? 200;
    const headers = new Map(Object.entries(init.headers ?? {}));
    const text = typeof body === "string" ? body : JSON.stringify(body);
    fetchResponses.push({
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (name: string) => headers.get(name.toLowerCase()) ?? null,
        },
        json: async () => (typeof body === "string" ? JSON.parse(body) : body),
        text: async () => text,
    } as unknown as Response);
}

const originalFetch = globalThis.fetch;

describe("marketcap URL builders", () => {
    it("builds the EDGAR company_tickers URL", () => {
        assert.equal(buildCompanyTickersUrl(), "https://www.sec.gov/files/company_tickers.json");
    });

    it("zero-pads the CIK to 10 digits in the company-concept URL", () => {
        assert.equal(
            buildEdgarConceptUrl(320193),
            "https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/dei/EntityCommonStockSharesOutstanding.json",
        );
        assert.equal(
            buildEdgarConceptUrl(1067983),
            "https://data.sec.gov/api/xbrl/companyconcept/CIK0001067983/dei/EntityCommonStockSharesOutstanding.json",
        );
    });

    it("builds the Alpaca corporate-actions URL with symbol + split filter, explicit window, and page token", () => {
        const url = buildAlpacaSplitsUrl(
            { host: "https://data.alpaca.markets" },
            { symbol: "nvda", end: "2026-09-12" },
        );
        assert.ok(url.startsWith("https://data.alpaca.markets/v1/corporate-actions?"), url);
        const params = new URL(url).searchParams;
        assert.equal(params.get("symbols"), "NVDA");
        assert.equal(params.get("types"), "forward_split,reverse_split");
        // Without an explicit window the endpoint only searches recent months
        // (verified live), so the builder always pins one.
        assert.equal(params.get("start"), "2000-01-01");
        assert.equal(params.get("end"), "2026-09-12");
        assert.equal(params.get("limit"), "1000");
        assert.equal(params.get("page_token"), null);

        const paged = buildAlpacaSplitsUrl(
            { host: "https://data.alpaca.markets" },
            { symbol: "NVDA", end: "2026-09-12", pageToken: "abc==" },
        );
        assert.equal(new URL(paged).searchParams.get("page_token"), "abc==");
        // No credentials in the URL: auth is header-based.
        assert.doesNotMatch(url, /APCA-API-KEY-ID|secret/i);
    });
});

describe("marketcap parseCompanyTickers", () => {
    it("parses the EDGAR map and normalizes share-class dots to hyphens", () => {
        const tickers = parseCompanyTickers({
            "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
            "1": { cik_str: 1067983, ticker: "BRK.B", title: "Berkshire Hathaway Inc." },
            "2": { cik_str: 1067983, ticker: "BRK.A", title: "Berkshire Hathaway Inc." },
        });
        assert.equal(tickers["AAPL"], 320193);
        // The lookup key matches the app's symbol form (BRK-B), not EDGAR's dot form.
        assert.equal(tickers["BRK-B"], 1067983);
        assert.equal(tickers["BRK.B"], undefined);
        assert.equal(tickers["BRK-A"], 1067983);
    });

    it("uppercases tickers and skips invalid rows; non-object payload yields an empty map", () => {
        const tickers = parseCompanyTickers({
            "0": { cik_str: 320193, ticker: "aapl" },
            "1": { cik_str: "bad", ticker: "NOPE" },
            "2": { ticker: "NOPE2" },
            "3": { cik_str: -5, ticker: "NEG" },
        });
        assert.equal(tickers["AAPL"], 320193);
        assert.equal(tickers["NOPE"], undefined);
        assert.equal(tickers["NEG"], undefined);
        assert.deepEqual(parseCompanyTickers("garbage"), {});
    });

    it("normalizeEdgarTicker maps dot form to hyphen form", () => {
        assert.equal(normalizeEdgarTicker("brk.b"), "BRK-B");
    });
});

describe("marketcap parseSharesOutstandingFacts (point-in-time step function)", () => {
    const payload = {
        cik: 320193,
        units: {
            shares: [
                { end: "2024-01-01", val: 100, filed: "2024-02-02", form: "10-K" },
                { end: "2024-04-01", val: 110, filed: "2024-05-03", form: "10-Q" },
                { end: "2023-10-01", val: 90, filed: "2023-11-03", form: "10-Q" },
            ],
        },
    };

    it("keys each fact on its filed date and sorts ascending (never backdated to end)", () => {
        const facts = parseSharesOutstandingFacts(payload);
        assert.deepEqual(facts.map((f) => f.filed), ["2023-11-03", "2024-02-02", "2024-05-03"]);
        assert.equal(facts[1]!.shares, 100);
        assert.equal(facts[1]!.end, "2024-01-01");
    });

    it("looks up the latest fact with filed <= date; null before the first filing", () => {
        const facts = parseSharesOutstandingFacts(payload);
        assert.equal(lookupSharesForDate(facts, "2023-01-01"), null);
        assert.equal(lookupSharesForDate(facts, "2023-11-03"), 90);
        assert.equal(lookupSharesForDate(facts, "2024-02-01"), 90);
        assert.equal(lookupSharesForDate(facts, "2024-02-02"), 100);
        assert.equal(lookupSharesForDate(facts, "2026-01-01"), 110);
    });

    it("dedupes the same filed date with latest-wins", () => {
        const facts = parseSharesOutstandingFacts({
            units: { shares: [
                { end: "2024-01-01", val: 100, filed: "2024-02-02" },
                { end: "2024-01-01", val: 105, filed: "2024-02-02" },
            ] },
        });
        assert.equal(facts.length, 1);
        assert.equal(facts[0]!.shares, 105);
    });

    it("drops rows with non-positive/non-finite val or invalid filed dates", () => {
        const facts = parseSharesOutstandingFacts({
            units: { shares: [
                { end: "2024-01-01", val: 0, filed: "2024-02-02" },
                { end: "2024-01-01", val: -5, filed: "2024-02-02" },
                { end: "2024-01-01", val: "abc", filed: "2024-02-02" },
                { end: "2024-01-01", val: 100, filed: "not-a-date" },
                { end: "2024-01-01", filed: "2024-02-02" },
                { end: "2024-01-01", val: 120, filed: "2024-02-05" },
            ] },
        });
        assert.deepEqual(facts, [{ filed: "2024-02-05", end: "2024-01-01", shares: 120 }]);
    });

    it("returns an empty list for payloads without a usable units array", () => {
        assert.deepEqual(parseSharesOutstandingFacts({}), []);
        assert.deepEqual(parseSharesOutstandingFacts({ units: {} }), []);
        assert.deepEqual(parseSharesOutstandingFacts({ units: { shares: "nope" } }), []);
        assert.deepEqual(parseSharesOutstandingFacts("garbage"), []);
        // Live finding (2026-09-12): issuers that stopped/never tagged the
        // count (e.g. ABT) return an EMPTY OBJECT container, not an array.
        assert.deepEqual(parseSharesOutstandingFacts({ units: { shares: {} } }), []);
    });
});

describe("marketcap split-factor convention (MULTIPLY, non-negotiable)", () => {
    it("NVDA 10:1 invariance: adjPrice × adjustedShares === rawPrice × rawShares", () => {
        // Worked example from docs/marketcap-download.md: raw price $1200,
        // EDGAR 2023 count 2.4B raw shares → raw cap $2.88T. The repo's 1d
        // bars are split-adjusted ($120), so the paired count must be
        // 2.4B × 10 = 24B — MULTIPLIED, never divided (dividing would print
        // $28.8B, a smooth-looking 100× level error).
        const rawPrice = 1200;
        const rawShares = 2_400_000_000;
        const adjPrice = 120;
        const facts: SharesFactPoint[] = [{ filed: "2024-02-21", end: "2024-01-28", shares: rawShares }];
        const adjusted = applySplitFactors(facts, [{ executionDate: "2024-06-10", factor: 10 }]);
        assert.equal(adjusted[0]!.shares, 24_000_000_000);
        assert.equal(adjPrice * adjusted[0]!.shares, rawPrice * rawShares);
        assert.equal(adjPrice * adjusted[0]!.shares, 2_880_000_000_000);
    });

    it("does not apply splits that executed on or before the fact's filed date", () => {
        const facts: SharesFactPoint[] = [
            { filed: "2024-02-21", end: "2024-01-28", shares: 100 },
            { filed: "2024-08-01", end: "2024-07-15", shares: 1000 },
        ];
        const adjusted = applySplitFactors(facts, [{ executionDate: "2024-06-10", factor: 10 }]);
        assert.equal(adjusted[0]!.shares, 1000);
        assert.equal(adjusted[1]!.shares, 1000);
    });

    it("compounds multiple later splits multiplicatively", () => {
        const facts: SharesFactPoint[] = [{ filed: "2020-01-01", end: "2019-12-31", shares: 100 }];
        const adjusted = applySplitFactors(facts, [
            { executionDate: "2021-08-31", factor: 4 },
            { executionDate: "2022-07-15", factor: 3 },
        ]);
        assert.equal(adjusted[0]!.shares, 1200);
    });
});

describe("marketcap parseAlpacaSplits (verified v1 payload shape)", () => {
    it("parses the type-keyed corporate_actions object; factor = new_rate/old_rate at ex_date", () => {
        const { splits, nextPageToken } = parseAlpacaSplits({
            corporate_actions: {
                cash_dividends: [{ rate: 0.01, ex_date: "2024-06-11" }],
                forward_splits: [{ new_rate: 10, old_rate: 1, ex_date: "2024-06-10" }],
            },
            next_page_token: " next== ",
        });
        assert.deepEqual(splits, [{ executionDate: "2024-06-10", factor: 10 }]);
        assert.equal(nextPageToken, "next==");
    });

    it("maps a reverse split to a fractional share-count multiplier", () => {
        const { splits } = parseAlpacaSplits({
            corporate_actions: { reverse_splits: [{ new_rate: 1, old_rate: 10, ex_date: "2023-09-05" }] },
        });
        assert.deepEqual(splits, [{ executionDate: "2023-09-05", factor: 0.1 }]);
    });

    it("treats an empty corporate_actions object as zero splits (symbol never split)", () => {
        const { splits, nextPageToken } = parseAlpacaSplits({ corporate_actions: {}, next_page_token: null });
        assert.deepEqual(splits, []);
        assert.equal(nextPageToken, null);
    });

    it("throws HttpStatusError for unrecognized payloads (strict, no partial write)", () => {
        assert.throws(() => parseAlpacaSplits("garbage"), HttpStatusError);
        assert.throws(() => parseAlpacaSplits({ corporate_actions: "nope" }), HttpStatusError);
        assert.throws(() => parseAlpacaSplits({ corporate_actions: [] }), HttpStatusError);
        assert.throws(
            () => parseAlpacaSplits({ corporate_actions: { forward_splits: "nope" } }),
            HttpStatusError,
        );
        assert.throws(
            () => parseAlpacaSplits({ corporate_actions: { forward_splits: [{ new_rate: 0, old_rate: 1, ex_date: "2024-06-10" }] } }),
            HttpStatusError,
        );
        assert.throws(
            () => parseAlpacaSplits({ corporate_actions: { forward_splits: [{ new_rate: 10, old_rate: 1 }] } }),
            HttpStatusError,
        );
    });
});

describe("marketcap loadCompanyTickersCached (stubbed fetch, temp cache path)", () => {
    let cacheDir: string;
    let cachePath: string;

    beforeEach(() => {
        fetchCalls = [];
        fetchResponses = [];
        cacheDir = mkdtempSync(join(tmpdir(), "mktcap-tickers-"));
        cachePath = join(cacheDir, "marketcap", ".company-tickers.json");
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        rmSync(cacheDir, { recursive: true, force: true });
    });

    function stubTickersFetch(): void {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ url: input.toString(), init });
            const response = fetchResponses.shift();
            if (!response) throw new Error("test forgot to push a response");
            return response;
        }) as typeof fetch;
    }

    it("fetches, caches atomically, and serves the second call from cache", async () => {
        stubTickersFetch();
        pushResponse({ "0": { cik_str: 320193, ticker: "AAPL" } });

        const first = await loadCompanyTickersCached({ cachePath });
        assert.equal(first["AAPL"], 320193);
        assert.equal(fetchCalls.length, 1);
        assert.ok(existsSync(cachePath), "cache file should be written");
        const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { fetchedAt: string; tickers: Record<string, number> };
        assert.equal(cached.tickers["AAPL"], 320193);

        const second = await loadCompanyTickersCached({ cachePath });
        assert.equal(second["AAPL"], 320193);
        assert.equal(fetchCalls.length, 1, "fresh cache must not refetch");
    });

    it("refetches when the cache is older than maxAgeMs", async () => {
        stubTickersFetch();
        pushResponse({ "0": { cik_str: 320193, ticker: "AAPL" } });
        await loadCompanyTickersCached({ cachePath });
        // Backdate the cache beyond the age ceiling.
        const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { fetchedAt: string };
        cached.fetchedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
        writeFileSync(cachePath, JSON.stringify(cached));
        pushResponse({ "0": { cik_str: 320193, ticker: "AAPL" } });
        await loadCompanyTickersCached({ cachePath, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
        assert.equal(fetchCalls.length, 2);
    });

    it("throws loudly when the EDGAR fetch fails (fatal, no stale fallback)", async () => {
        stubTickersFetch();
        pushResponse("forbidden", { status: 403 });
        await assert.rejects(
            loadCompanyTickersCached({ cachePath }),
            (error: unknown) => error instanceof HttpStatusError && error.status === 403,
        );
        assert.ok(!existsSync(cachePath), "no cache file should be written on failure");
    });

    it("sends the descriptive EDGAR User-Agent on outbound requests", async () => {
        stubTickersFetch();
        pushResponse({ "0": { cik_str: 320193, ticker: "AAPL" } });
        await loadCompanyTickersCached({ cachePath });
        const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
        assert.equal(headers["User-Agent"], EDGAR_USER_AGENT);
    });
});

describe("marketcap fetchEdgarSharesOutstanding (stubbed fetch)", () => {
    beforeEach(() => {
        fetchCalls = [];
        fetchResponses = [];
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function stubJsonFetch(): void {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ url: input.toString(), init });
            const response = fetchResponses.shift();
            if (!response) throw new Error("test forgot to push a response");
            return response;
        }) as typeof fetch;
    }

    it("requests the company-concept URL with the EDGAR User-Agent and returns the payload", async () => {
        stubJsonFetch();
        pushResponse({ cik: 320193, units: { shares: [] } });
        const payload = await fetchEdgarSharesOutstanding(320193) as { cik: number };
        assert.equal(payload.cik, 320193);
        assert.equal(fetchCalls.length, 1);
        assert.ok(fetchCalls[0]!.url.includes("CIK0000320193/dei/EntityCommonStockSharesOutstanding"), fetchCalls[0]!.url);
        const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
        assert.equal(headers["User-Agent"], EDGAR_USER_AGENT);
    });

    it("does NOT retry a 403 (SEC User-Agent/policy block) and surfaces it loudly", async () => {
        stubJsonFetch();
        pushResponse("blocked", { status: 403 });
        await assert.rejects(
            fetchEdgarSharesOutstanding(320193),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 403
                && /User-Agent/.test(error.message),
        );
        assert.equal(fetchCalls.length, 1);
    });

    it("retries a 429 honoring Retry-After and then succeeds", async () => {
        stubJsonFetch();
        pushResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
        pushResponse({ cik: 320193, units: { shares: [] } });
        const payload = await fetchEdgarSharesOutstanding(320193) as { cik: number };
        assert.equal(payload.cik, 320193);
        assert.equal(fetchCalls.length, 2);
    });

    it("propagates a user abort without retrying", async () => {
        stubJsonFetch();
        const controller = new AbortController();
        globalThis.fetch = (async () => {
            controller.abort();
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
        }) as unknown as typeof fetch;
        await assert.rejects(
            fetchEdgarSharesOutstanding(320193, controller.signal),
            (error: unknown) => (error as Error).name === "AbortError",
        );
    });
});

describe("marketcap fetchAlpacaSplits (stubbed fetch)", () => {
    const config = {
        apiKey: "PKTESTKEY",
        apiSecret: "testsecret",
        host: "https://data.alpaca.markets",
        feed: "iex",
        adjustment: "split",
    };

    beforeEach(() => {
        fetchCalls = [];
        fetchResponses = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ url: input.toString(), init });
            const response = fetchResponses.shift();
            if (!response) throw new Error("test forgot to push a response");
            return response;
        }) as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("pages through next_page_token and accumulates splits", async () => {
        pushResponse({
            corporate_actions: { forward_splits: [{ new_rate: 10, old_rate: 1, ex_date: "2024-06-10" }] },
            next_page_token: "page2",
        });
        pushResponse({
            corporate_actions: { forward_splits: [{ new_rate: 4, old_rate: 1, ex_date: "2021-07-19" }] },
            next_page_token: null,
        });
        const splits = await fetchAlpacaSplits(config, "NVDA");
        assert.deepEqual(splits, [
            { executionDate: "2024-06-10", factor: 10 },
            { executionDate: "2021-07-19", factor: 4 },
        ]);
        assert.equal(fetchCalls.length, 2);
        assert.ok(fetchCalls[1]!.url.includes("page_token=page2"), fetchCalls[1]!.url);
        assert.ok(fetchCalls[0]!.url.includes("end="), "split queries must pin an explicit end date");
        // Credentials ride the header, never the URL.
        const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
        assert.equal(headers["APCA-API-KEY-ID"], "PKTESTKEY");
        assert.doesNotMatch(fetchCalls[0]!.url, /PKTESTKEY|testsecret/);
    });

    it("surfaces a 401 immediately without retry", async () => {
        pushResponse("unauthorized", { status: 401 });
        await assert.rejects(
            fetchAlpacaSplits(config, "NVDA"),
            (error: unknown) => error instanceof HttpStatusError && error.status === 401,
        );
        assert.equal(fetchCalls.length, 1);
    });

    it("treats an unrecognized payload as a strict failure", async () => {
        pushResponse("not json envelope");
        await assert.rejects(
            fetchAlpacaSplits(config, "NVDA"),
            HttpStatusError,
        );
    });
});

/**
 * Live-fixture gate (docs/marketcap-download.md Phase 1b): the committed
 * fixtures were pulled from the real EDGAR / Alpaca endpoints before Phase 2
 * and encode the empirical findings this feature is written against:
 *  - AAPL: single-class baseline WITH ≥5 years of dei facts.
 *  - BRK.B: the filer (Berkshire, CIK 1067983) tags the dei count only
 *    2009–2011 (Class A counts) — coverage is shallow; recent windows fail
 *    per-symbol by design.
 *  - GOOGL (Alphabet, CIK 1652044): the companyconcept endpoint returns
 *    NoSuchKey — Alphabet publishes NO dei:EntityCommonStockSharesOutstanding
 *    facts at all (companyfacts lists only EntityPublicFloat under dei).
 *    Failure is per-symbol and loud, never a partial dataset.
 *  - NVDA Alpaca splits: corporate-actions v1 payload, factor new_rate/old_rate
 *    = 10 at ex_date 2024-06-10, fetched with the configured IEX-tier account
 *    (entitlement verified).
 */
describe("marketcap live fixtures (Phase 1b gate)", () => {
    // Tests run from the repo root (same process.cwd() caveat as
    // tests/ibkr-download-merge-safety.spec.ts).
    const fixturesDir = join(process.cwd(), "tests", "fixtures", "marketcap");

    it("AAPL fixture has ≥5y of dei facts and parses into a valid step function", () => {
        const payload = JSON.parse(readFileSync(join(fixturesDir, "aapl-dei-shares.json"), "utf8"));
        assert.equal(payload.entityName, "Apple Inc.");
        const facts = parseSharesOutstandingFacts(payload);
        assert.ok(facts.length > 0, "facts must parse");
        const fiveYearsAgo = "2021-01-01";
        const recent = facts.filter((f) => f.filed >= fiveYearsAgo);
        assert.ok(recent.length >= 15, `expected ≥5y quarterly coverage, got ${recent.length} facts since 2021`);
        assert.ok(facts.every((f) => f.shares > 0 && Number.isFinite(f.shares)));
    });

    it("BRK.B fixture parses but documents shallow coverage (last fact filed ≤ 2012)", () => {
        const payload = JSON.parse(readFileSync(join(fixturesDir, "brkb-dei-shares.json"), "utf8"));
        assert.equal(payload.entityName, "BERKSHIRE HATHAWAY INC");
        const facts = parseSharesOutstandingFacts(payload);
        assert.ok(facts.length > 0);
        assert.ok(facts[facts.length - 1]!.filed <= "2012-01-01",
            "Berkshire stopped tagging the dei count after 2011-05-06; a recent-window join must fail per-symbol, not write a stale series");
    });

    it("NVDA Alpaca splits fixture yields factor 10 at ex_date 2024-06-10, closing the cap invariant", () => {
        const payload = JSON.parse(readFileSync(join(fixturesDir, "nvda-alpaca-splits.json"), "utf8"));
        const { splits } = parseAlpacaSplits(payload);
        assert.deepEqual(splits, [{ executionDate: "2024-06-10", factor: 10 }]);
        // Real numbers (verified live in Phase 1b):
        //  - EDGAR nvda-dei-shares.json: the last fact filed before the split
        //    reports 2,460,000,000 raw shares (10-Q cover, filed 2024-05-29).
        //  - The repo's local 1d bar for 2024-06-07 closes at $120.89 — the
        //    split-adjusted form of the raw $1,208.90 close (×10 exactly), so
        //    the paired count must be the MULTIPLIED 24.6B shares.
        const facts = parseSharesOutstandingFacts({
            units: { shares: [{ end: "2024-05-24", val: 2_460_000_000, filed: "2024-05-29" }] },
        });
        const adjusted = applySplitFactors(facts, splits);
        const adjustedClose = 120.89;
        const rawClose = 1208.90;
        assert.equal(adjusted[0]!.shares, 24_600_000_000);
        // Invariant: cap from adjusted series === cap from raw series (~$2.97T).
        const expectedCap = rawClose * 2_460_000_000;
        assert.ok(
            Math.abs(adjustedClose * adjusted[0]!.shares - expectedCap) / expectedCap < 1e-9,
            `cap mismatch: ${adjustedClose * adjusted[0]!.shares} vs ${expectedCap}`,
        );
    });

    it("real company_tickers rows: BRK-B and BRK-A map to the Berkshire filer CIK", () => {
        // Extracted verbatim from the live www.sec.gov/files/company_tickers.json
        // (10,426 rows live; only the BRK* rows are committed). The live map
        // lists share classes with HYPHENS ("BRK-B") — the '.'→'-' mapping is
        // legacy-compat for dot forms. Both BRK classes share one filer CIK.
        const payload = JSON.parse(readFileSync(join(fixturesDir, "edgar-company-tickers-brk.json"), "utf8"));
        const tickers = parseCompanyTickers(payload);
        assert.equal(tickers["BRK-B"], 1067983);
        assert.equal(tickers["BRK-A"], 1067983);
        assert.equal(tickers["BRKR"], 1109354);
    });

    it("NVDA EDGAR fixture has ≥5y of dei facts and a 2.46B pre-split count", () => {
        const payload = JSON.parse(readFileSync(join(fixturesDir, "nvda-dei-shares.json"), "utf8"));
        assert.equal(payload.entityName, "NVIDIA CORP");
        const facts = parseSharesOutstandingFacts(payload);
        const recent = facts.filter((f) => f.filed >= "2021-01-01");
        assert.ok(recent.length >= 15, `expected ≥5y quarterly coverage, got ${recent.length} facts since 2021`);
        const preSplit = facts.filter((f) => f.filed < "2024-06-10");
        assert.equal(preSplit[preSplit.length - 1]!.shares, 2_460_000_000);
    });
});
