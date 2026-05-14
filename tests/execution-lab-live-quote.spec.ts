import { expect } from "chai";
import { describe, it } from "node:test";
import { Readable } from "node:stream";
import { executionLabVitePlugin, normalizeExecutionLabClobPrice } from "../lib/execution-lab/execution-lab-vite-plugin";
import { isExecutionLabTransientPollError } from "../lib/execution-lab/poll-errors";
import { collectExecutionLabTradeQuoteTimes } from "../lib/execution-lab/trade-quote-times";
import type { Trade } from "../lib/types/strategies";

type MockHandler = (req: NodeJS.ReadableStream & { method?: string; url?: string }, res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
}) => void | Promise<void>;

function createHandler(): MockHandler {
    let handler: MockHandler | null = null;
    const plugin = executionLabVitePlugin();
    plugin.configurePreviewServer?.({
        middlewares: {
            use(prefix: string, registered: MockHandler) {
                if (prefix === "/api/execution-lab") handler = registered;
            },
        },
    } as never);
    if (!handler) throw new Error("Expected execution lab middleware to register");
    return handler;
}

async function invoke(handler: MockHandler, path: string): Promise<{ statusCode: number; json: any }> {
    return await new Promise((resolve, reject) => {
        const request = Readable.from([]) as NodeJS.ReadableStream & { method?: string; url?: string };
        request.method = "GET";
        request.url = path;
        const response = {
            statusCode: 200,
            setHeader() {},
            end(rawBody?: string) {
                try {
                    resolve({ statusCode: response.statusCode, json: rawBody ? JSON.parse(rawBody) : null });
                } catch (error) {
                    reject(error);
                }
            },
        };
        Promise.resolve(handler(request, response)).catch(reject);
    });
}

function trade(id: number, entryTime: number, exitTime: number, exitReason: Trade["exitReason"]): Trade {
    return {
        id,
        type: "long",
        entryTime,
        entryPrice: 100,
        exitTime,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason,
    };
}

describe("Execution Lab live helpers", () => {
    it("preserves zero CLOB prices as valid boundary prices", () => {
        expect(normalizeExecutionLabClobPrice(0)).to.equal(0);
        expect(normalizeExecutionLabClobPrice("0")).to.equal(0);
        expect(normalizeExecutionLabClobPrice(1)).to.equal(1);
    });

    it("rejects invalid CLOB prices", () => {
        expect(normalizeExecutionLabClobPrice(-0.01)).to.equal(null);
        expect(normalizeExecutionLabClobPrice(1.01)).to.equal(null);
        expect(normalizeExecutionLabClobPrice("")).to.equal(null);
    });

    it("loads closed outcomes by event end date", async () => {
        const handler = createHandler();
        const originalFetch = globalThis.fetch;
        let requestedUrl: URL | null = null;
        globalThis.fetch = (async (input) => {
            requestedUrl = new URL(String(input));
            return new Response(JSON.stringify([{
                slug: "btc-updown-5m-1700000100",
                endDate: new Date(1_700_000_400 * 1000).toISOString(),
                markets: [{
                    id: "market-1",
                    slug: "btc-updown-5m-1700000100",
                    conditionId: "condition-1",
                    outcomes: JSON.stringify(["Up", "Down"]),
                    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
                    outcomePrices: JSON.stringify(["0.99", "0.01"]),
                }],
            }]));
        }) as typeof fetch;

        try {
            const response = await invoke(
                handler,
                "/live-outcomes?symbol=BTCUSDT&outcomeInterval=5m&seriesId=10684&startTs=1700000340&endTs=1700000460"
            );

            expect(response.statusCode).to.equal(200);
            expect(requestedUrl?.searchParams.get("end_date_min")).to.not.equal(null);
            expect(requestedUrl?.searchParams.get("start_date_min")).to.equal(null);
            expect(response.json.outcomes).to.have.length(1);
            expect(response.json.outcomes[0].event_end_ts).to.equal(1_700_000_400);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("rejects unsupported live stream symbols instead of silently using BTCUSDT", async () => {
        const handler = createHandler();
        const response = await invoke(handler, "/live-candles?symbol=DOGEUSDT&limit=1");

        expect(response.statusCode).to.equal(400);
        expect(response.json.error).to.include("symbol");
    });

    it("requests quotes for backtest trade seconds missed by the latest quote", () => {
        const times = collectExecutionLabTradeQuoteTimes({
            previousProcessedCandleTimeSec: 1_700_000_101,
            latestCandleTimeSec: 1_700_000_104,
            trades: [
                trade(1, 1_700_000_100, 1_700_000_103, "signal"),
                trade(2, 1_700_000_104, 1_700_000_109, "end_of_data"),
                trade(3, 1_700_000_099, 1_700_000_102, "time_stop"),
            ],
        });

        expect(times).to.deep.equal([1_700_000_102, 1_700_000_103, 1_700_000_104]);
    });

    it("classifies live fetch timeouts as transient poll errors", () => {
        expect(isExecutionLabTransientPollError(new Error("The operation was aborted due to timeout"))).to.equal(true);
        expect(isExecutionLabTransientPollError(new Error("Strategy changed. Stop and start a new Execution Lab session."))).to.equal(false);
    });
});
