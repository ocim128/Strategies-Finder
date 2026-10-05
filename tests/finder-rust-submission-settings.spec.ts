/**
 * Client-submission argument tests for the current-chart Finder Rust path:
 * they capture the arguments handed to the Rust client (`rustEngine`) from
 * the real `runFinderExecution` flow with the client stubbed (the mock
 * pattern from `tests/finder-rust-batch-cancellation.spec.ts`). They do NOT
 * observe serialized HTTP payloads; the wire shape is owned by
 * `rust-engine-client` and covered by `tests/rust-engine-client.spec.ts`.
 *
 * Locked baseline (pre-dating the removal of the candidate-level
 * `rustBacktestSettings` mirror):
 *  - Direct AND cached batches: eligible ATR-period candidate overrides and
 *    enabled percentage SL/TP candidate overrides reach each item's
 *    `settings`; the run-level `settings` keep the base values.
 *  - Candidate `riskMaxHoldBars` overrides never appear in the per-item
 *    settings (capability-gated away at the current-chart run level).
 *  - Frozen risk management leaves per-item settings identical (by
 *    reference) to the run-level settings.
 *  - `requiresTsEngine` bypasses the Rust client entirely; the caller owns
 *    engine eligibility, so `next_close` settings still submit (without an
 *    `executionModel` key, because the current-chart run sanitizes without
 *    capabilities). Short-direction runs project identically to long runs.
 *  - A successful Rust response owns the RANKING: the surviving top
 *    candidates follow the Rust-reported ordering even when TypeScript
 *    would rank them differently. The top slice is then reconciled through
 *    the TypeScript engine (the documented reconciliation contract), so the
 *    final scalars are TypeScript's, not the stub's.
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import { runFinderExecution } from "../lib/finder/finder-runner";
import type { FinderRunOutput } from "../lib/finder/finder-runner";
import { rustEngine } from "../lib/rust-engine-client";
import { projectRustBatchItemSettings } from "../lib/finder/finder-runner-core";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, BacktestResult, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const candles: OHLCVData[] = Array.from({ length: 8 }, (_value, index) => ({
    time: (1_700_000_000 + index * 300) as Time,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1000,
}));

/**
 * Params-sensitive so the TypeScript ranking (lower buy price for a larger
 * atrPeriod wins) is the OPPOSITE of the stubbed Rust ranking below — that
 * contrast proves which engine decided the surviving top slice.
 */
const strategy: Strategy = {
    name: "Rust Submission Settings",
    description: "Generates deterministic, params-sensitive signals for capture.",
    defaultParams: {},
    paramLabels: {},
    execute(data, params) {
        const first = data[0]!;
        const last = data.at(-1)!;
        const shift = Number((params as Record<string, number> | undefined)?.atrPeriod ?? 0) * 0.5;
        return [
            { time: first.time, type: "buy" as const, price: Math.max(1, first.close - shift) },
            { time: last.time, type: "sell" as const, price: last.close },
        ];
    },
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
};

function makeOptions(overrides: Partial<FinderOptions> = {}): FinderOptions {
    return {
        scope: "current_chart",
        mode: "random",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        topN: 2,
        steps: 1,
        rangePercent: 0,
        maxRuns: 2,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        dataSlice: "all",
        ...overrides,
    };
}

type CapturedItem = { id: string; settings: Record<string, unknown> };

type CapturedSubmission = {
    allItems: CapturedItem[];
    runLevel: Record<string, unknown>;
    directCalls: number;
    cachedCalls: number;
    cacheDataCalls: number;
    statuses: string[];
};

/**
 * Result the stub returns per batch item when a successful Rust response is
 * requested. The trades/win-rate/avg-trade fields satisfy
 * `isBacktestResultConsistent`; the ranking contrast against the
 * TypeScript engine is what the assertion observes.
 */
function makeRustRankingResult(id: string): BacktestResult {
    const netProfit = id.endsWith("0") ? 777.5 : 100;
    return {
        netProfit,
        totalTrades: 4,
        winningTrades: 2,
        losingTrades: 2,
        winRate: 50,
        avgTrade: netProfit / 4,
        sharpeRatio: 1,
        equityCurve: [],
        trades: [],
    } as unknown as BacktestResult;
}

async function captureRustSubmission(args: {
    settings: BacktestSettings;
    paramSets: Array<Record<string, number>>;
    options?: Partial<FinderOptions>;
    requiresTsEngine?: boolean;
    response?: "empty" | "successful";
}): Promise<{ captured: CapturedSubmission; output: FinderRunOutput }> {
    const savedDocument = (globalThis as { document?: unknown }).document;
    const originalCheckHealth = rustEngine.checkHealth;
    const originalCacheData = rustEngine.cacheData;
    const originalRunBatch = rustEngine.runBatchBacktestWithStatus;
    const originalRunCachedBatch = rustEngine.runCachedBatchBacktestWithStatus;
    const captured: CapturedSubmission = {
        allItems: [],
        runLevel: {},
        directCalls: 0,
        cachedCalls: 0,
        cacheDataCalls: 0,
        statuses: [],
    };
    (globalThis as { document?: unknown }).document = { getElementById: () => ({ checked: true }) };
    rustEngine.checkHealth = async () => true;
    rustEngine.cacheData = (async () => {
        captured.cacheDataCalls += 1;
        return "spec-cache-id";
    }) as never;
    const respondWith = (items: CapturedItem[]) => args.response === "successful"
        ? {
            ok: true as const,
            response: {
                results: items.map((item) => ({ id: item.id, result: makeRustRankingResult(item.id) })),
            },
        }
        : { ok: true as const, response: { results: [] } };
    rustEngine.runBatchBacktestWithStatus = (async (...engineArgs: unknown[]) => {
        captured.directCalls += 1;
        const items = (engineArgs[1] as CapturedItem[]).map((item) => ({ id: item.id, settings: item.settings }));
        captured.allItems.push(...items);
        captured.runLevel = engineArgs[5] as Record<string, unknown>;
        return respondWith(items);
    }) as never;
    rustEngine.runCachedBatchBacktestWithStatus = (async (...engineArgs: unknown[]) => {
        captured.cachedCalls += 1;
        const items = (engineArgs[1] as CapturedItem[]).map((item) => ({ id: item.id, settings: item.settings }));
        captured.allItems.push(...items);
        captured.runLevel = engineArgs[5] as Record<string, unknown>;
        return respondWith(items);
    }) as never;
    let output: FinderRunOutput;
    try {
        output = await runFinderExecution(
            {
                ohlcvData: candles,
                symbol: "TEST",
                interval: "5m",
                options: makeOptions(args.options),
                settings: args.settings,
                requiresTsEngine: args.requiresTsEngine ?? false,
                selectedStrategies: [{ key: "rust_submit", name: strategy.name, strategy }],
                capitalSettings,
                generateParamSets: () => args.paramSets,
            },
            {
                setProgress: () => undefined,
                setStatus: (text: string) => captured.statuses.push(text),
                yieldControl: async () => undefined,
                isCancelled: () => false,
                onResultsUpdate: () => undefined,
            },
        );
    } finally {
        (globalThis as { document?: unknown }).document = savedDocument;
        rustEngine.checkHealth = originalCheckHealth;
        rustEngine.cacheData = originalCacheData;
        rustEngine.runBatchBacktestWithStatus = originalRunBatch;
        rustEngine.runCachedBatchBacktestWithStatus = originalRunCachedBatch;
    }
    return { captured, output };
}

const ATR_SETTINGS: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    riskMode: "simple",
    atrPeriod: 14,
    stopLossAtr: 1.5,
    takeProfitAtr: 3,
    trailingAtr: 2,
};

const PERCENT_SETTINGS: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    riskMode: "percentage",
    stopLossEnabled: true,
    takeProfitEnabled: true,
    stopLossPercent: 5,
    takeProfitPercent: 10,
};

describe("Finder current-chart Rust submission settings", () => {
    it("projects eligible ATR candidate overrides per item while the run level keeps the base", async () => {
        const { captured } = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }, { atrPeriod: 55 }],
        });
        expect(captured.directCalls).to.equal(1);
        expect(captured.cachedCalls).to.equal(0);
        expect(captured.allItems).to.have.length(2);
        const atrPeriods = captured.allItems.map((item) => item.settings.atrPeriod).sort((a, b) => Number(a) - Number(b));
        expect(atrPeriods).to.deep.equal([29, 55]);
        expect(captured.runLevel.atrPeriod).to.equal(14, "run-level settings keep the base ATR period");
        // Sanitization strips keys but never changes values, so every other
        // per-item value matches the run-level payload exactly.
        for (const item of captured.allItems) {
            expect(item.settings.stopLossAtr).to.equal(captured.runLevel.stopLossAtr);
            expect(item.settings.takeProfitAtr).to.equal(captured.runLevel.takeProfitAtr);
            expect(item.settings.slippageBps).to.equal(captured.runLevel.slippageBps);
        }
    });

    it("projects the same per-item overrides onto CACHED batches", async () => {
        // 512 runs / default batch size 64 = 8 batches: the cache gate's
        // high-batch-count threshold. The run uploads the data once, then
        // every cached batch item carries its projected override.
        const { captured } = await captureRustSubmission({
            settings: ATR_SETTINGS,
            // The `noise` value keeps every set unique — candidate
            // normalization dedupes identical params, which would collapse
            // the run count below the cache gate.
            paramSets: Array.from({ length: 512 }, (_value, index) => ({
                atrPeriod: index % 2 === 0 ? 29 : 55,
                noise: index,
            })),
            options: { maxRuns: 512 },
        });
        expect(captured.cacheDataCalls).to.equal(1, "the run crossed the high-batch-count cache gate");
        expect(captured.cachedCalls).to.equal(8);
        expect(captured.allItems).to.have.length(512);
        const projected = captured.allItems.filter(
            (item) => item.settings.atrPeriod === 29 || item.settings.atrPeriod === 55,
        );
        expect(projected).to.have.length(512, "every cached item carries its projected ATR override");
        expect(captured.runLevel.atrPeriod).to.equal(14);
    });

    it("projects enabled percentage SL/TP candidate overrides per item, clamped like the resolved settings", async () => {
        const { captured } = await captureRustSubmission({
            settings: PERCENT_SETTINGS,
            paramSets: [
                { stopLossPercent: 2, takeProfitPercent: 40 },
                { stopLossPercent: 99, takeProfitPercent: 8 },
            ],
        });
        expect(captured.allItems).to.have.length(2);
        const stopLossValues = captured.allItems.map((item) => Number(item.settings.stopLossPercent)).sort((a, b) => a - b);
        const takeProfitValues = captured.allItems.map((item) => Number(item.settings.takeProfitPercent)).sort((a, b) => a - b);
        expect(stopLossValues).to.deep.equal([2, 15], "stop-loss candidates clamp to the 0..15 mirror range");
        expect(takeProfitValues).to.deep.equal([8, 40]);
        expect(captured.runLevel.stopLossPercent).to.equal(5);
        expect(captured.runLevel.takeProfitPercent).to.equal(10);
        for (const item of captured.allItems) {
            expect(item.settings.stopLossEnabled).to.equal(true);
            expect(item.settings.takeProfitEnabled).to.equal(true);
        }
    });

    it("keeps candidate riskMaxHoldBars overrides out of the per-item mirror", async () => {
        const { captured } = await captureRustSubmission({
            settings: {
                ...PERCENT_SETTINGS,
                riskMaxHoldEnabled: true,
                riskMaxHoldBars: 10,
            },
            paramSets: [{ riskMaxHoldBars: 999 }],
        });
        expect(captured.allItems).to.have.length(1);
        // riskMaxHoldBars is capability-gated and the current-chart run
        // sanitizes without capabilities, so the mirror strips it entirely —
        // the candidate's clamped override must not reintroduce it.
        expect("riskMaxHoldBars" in captured.allItems[0]!.settings).to.equal(false);
        expect("riskMaxHoldBars" in captured.runLevel).to.equal(false);
    });

    it("frozen risk management keeps every per-item settings identical to the run-level object", async () => {
        const { captured } = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }, { atrPeriod: 55 }],
            options: { freezeRiskManagement: true },
        });
        expect(captured.allItems).to.have.length(2);
        for (const item of captured.allItems) {
            expect(item.settings).to.equal(
                captured.runLevel as unknown,
                "frozen runs share the run-level settings object per item (no per-item mirror)",
            );
        }
    });

    it("never calls the Rust client when the run requires the TypeScript engine", async () => {
        const { captured } = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }],
            requiresTsEngine: true,
        });
        expect(captured.directCalls + captured.cachedCalls).to.equal(0);
        expect(captured.allItems).to.have.length(0);
    });

    it("submits next_close runs without an executionModel key: eligibility belongs to the caller, stripping to the sanitizer", async () => {
        const { captured } = await captureRustSubmission({
            settings: { ...ATR_SETTINGS, executionModel: "next_close" },
            paramSets: [{ atrPeriod: 29 }],
        });
        expect(captured.directCalls).to.equal(1, "the caller's requiresTsEngine=false lets the batch submit");
        expect("executionModel" in captured.runLevel).to.equal(false);
        expect("executionModel" in captured.allItems[0]!.settings).to.equal(false);
    });

    it("a successful Rust response owns the ranking; the top slice is then reconciled through TypeScript", async () => {
        // Rust ranks candidate ...-0 first (777.5 vs 100) while TypeScript
        // would rank ...-1 first (its signals profit more at atrPeriod 55).
        // The surviving top slice follows the RUST ordering, and its final
        // scalars are reconciled through the TypeScript engine — so the
        // assertion observes params (ranking ownership), not Rust scalars.
        const { captured, output } = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }, { atrPeriod: 55 }],
            response: "successful",
            options: { topN: 1 },
        });
        expect(captured.directCalls).to.equal(1);
        expect(captured.statuses).to.include("Reconciling top results with full backtest...");
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.params.atrPeriod).to.equal(
            29,
            "the Rust-reported ranking decides which candidate survives",
        );
        const projected = captured.allItems.map((item) => item.settings.atrPeriod).sort((a, b) => Number(a) - Number(b));
        expect(projected).to.deep.equal([29, 55], "the adopted batch ran with the projected per-item settings");
    });

    it("projects short-direction runs identically to long runs", async () => {
        const { captured } = await captureRustSubmission({
            settings: { ...ATR_SETTINGS, tradeDirection: "short" },
            paramSets: [{ atrPeriod: 29 }],
        });
        expect(captured.allItems).to.have.length(1);
        expect(captured.allItems[0]!.settings.atrPeriod).to.equal(29);
        expect(captured.allItems[0]!.settings.tradeDirection).to.equal("short");
    });

    it("carries no executionModel in the payloads: the current-chart run sanitizes without capabilities", async () => {
        const { captured } = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }],
        });
        expect("executionModel" in captured.runLevel).to.equal(false);
        expect("executionModel" in captured.allItems[0]!.settings).to.equal(false);
    });

    it("projection on a capability-shaped base preserves base-only keys and never adds candidate max-hold", () => {
        // A base shaped like a capability-present sanitization (executionModel
        // and max-hold retained). The projection still copies only eligible
        // ATR/percentage overrides; it never lifts candidate keys beyond
        // them, even when the base itself carries the key.
        const capabilityBase: BacktestSettings = {
            ...ATR_SETTINGS,
            executionModel: "next_open",
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 4,
        };
        const candidate: BacktestSettings = {
            ...capabilityBase,
            atrPeriod: 21,
            riskMaxHoldBars: 9,
        };
        const projected = projectRustBatchItemSettings(capabilityBase, candidate);
        expect(projected).to.not.equal(capabilityBase);
        expect(projected.executionModel).to.equal("next_open", "the base's capability-gated key passes through untouched");
        expect(projected.riskMaxHoldBars).to.equal(4, "the candidate max-hold override stays out of the request");
        expect(projected.atrPeriod).to.equal(21, "the eligible ATR override projects");
    });
});
