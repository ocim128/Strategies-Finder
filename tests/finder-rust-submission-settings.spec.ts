/**
 * Characterization for the current-chart Finder Rust submission path: the
 * per-item `settings` each batch item carries and the run-level `settings`
 * argument, captured from the real `runFinderExecution` flow with the Rust
 * engine stubbed (the same mock pattern as
 * `tests/finder-rust-batch-cancellation.spec.ts`).
 *
 * Locked baseline (pre-dating the removal of the candidate-level
 * `rustBacktestSettings` mirror):
 *  - Eligible ATR-period candidate overrides and enabled percentage SL/TP
 *    candidate overrides reach the per-item mirror; the run-level settings
 *    keep the unsanitized-with-stripped-keys base values.
 *  - Candidate `riskMaxHoldBars` overrides never reach the per-item mirror.
 *  - Frozen risk management leaves per-item settings identical (by
 *    reference) to the run-level settings.
 *  - `requiresTsEngine` bypasses the Rust engine entirely.
 *  - The current-chart run sanitizes its base WITHOUT capabilities, so the
 *    run-level and per-item payloads carry no `executionModel` even for
 *    signal_close settings.
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import { runFinderExecution } from "../lib/finder/finder-runner";
import { rustEngine } from "../lib/rust-engine-client";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const candles: OHLCVData[] = Array.from({ length: 8 }, (_value, index) => ({
    time: (1_700_000_000 + index * 300) as Time,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1000,
}));

const strategy: Strategy = {
    name: "Rust Submission Settings",
    description: "Generates deterministic buy/sell signals for capture.",
    defaultParams: {},
    paramLabels: {},
    execute(data) {
        const first = data[0];
        const last = data.at(-1);
        return first && last
            ? [
                { time: first.time, type: "buy", price: first.close },
                { time: last.time, type: "sell", price: last.close },
            ]
            : [];
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

type CapturedBatch = {
    items: Array<{ id: string; settings: Record<string, unknown> }>;
    runLevel: Record<string, unknown>;
    callCount: number;
};

/**
 * Drive one real run with the Rust engine stubbed, capturing the per-item
 * batch settings (args[1]) and the run-level settings (args[5]). The stub
 * reports an empty result set so every run falls back to the TypeScript
 * backtest and the run still completes.
 */
async function captureRustSubmission(args: {
    settings: BacktestSettings;
    paramSets: Array<Record<string, number>>;
    options?: Partial<FinderOptions>;
    requiresTsEngine?: boolean;
}): Promise<CapturedBatch> {
    const savedDocument = (globalThis as { document?: unknown }).document;
    const originalCheckHealth = rustEngine.checkHealth;
    const originalRunBatch = rustEngine.runBatchBacktestWithStatus;
    const captured: CapturedBatch = { items: [], runLevel: {}, callCount: 0 };
    (globalThis as { document?: unknown }).document = { getElementById: () => ({ checked: true }) };
    rustEngine.checkHealth = async () => true;
    rustEngine.runBatchBacktestWithStatus = (async (...engineArgs: unknown[]) => {
        captured.callCount += 1;
        captured.items = (engineArgs[1] as Array<{ id: string; settings: Record<string, unknown> }>).map(
            (item) => ({ id: item.id, settings: item.settings }),
        );
        captured.runLevel = engineArgs[5] as Record<string, unknown>;
        return { ok: true, response: { results: [] } };
    }) as never;
    try {
        await runFinderExecution(
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
                setStatus: () => undefined,
                yieldControl: async () => undefined,
                isCancelled: () => false,
                onResultsUpdate: () => undefined,
            },
        );
    } finally {
        (globalThis as { document?: unknown }).document = savedDocument;
        rustEngine.checkHealth = originalCheckHealth;
        rustEngine.runBatchBacktestWithStatus = originalRunBatch;
    }
    return captured;
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
        const captured = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }, { atrPeriod: 55 }],
        });
        expect(captured.callCount).to.equal(1);
        expect(captured.items).to.have.length(2);
        const atrPeriods = captured.items.map((item) => item.settings.atrPeriod).sort((a, b) => Number(a) - Number(b));
        expect(atrPeriods).to.deep.equal([29, 55]);
        expect(captured.runLevel.atrPeriod).to.equal(14, "run-level settings keep the base ATR period");
        // Sanitization strips keys but never changes values, so every other
        // per-item value matches the run-level payload exactly.
        for (const item of captured.items) {
            expect(item.settings.stopLossAtr).to.equal(captured.runLevel.stopLossAtr);
            expect(item.settings.takeProfitAtr).to.equal(captured.runLevel.takeProfitAtr);
            expect(item.settings.slippageBps).to.equal(captured.runLevel.slippageBps);
        }
    });

    it("projects enabled percentage SL/TP candidate overrides per item, clamped like the resolved settings", async () => {
        const captured = await captureRustSubmission({
            settings: PERCENT_SETTINGS,
            paramSets: [
                { stopLossPercent: 2, takeProfitPercent: 40 },
                { stopLossPercent: 99, takeProfitPercent: 8 },
            ],
        });
        expect(captured.items).to.have.length(2);
        const stopLossValues = captured.items.map((item) => Number(item.settings.stopLossPercent)).sort((a, b) => a - b);
        const takeProfitValues = captured.items.map((item) => Number(item.settings.takeProfitPercent)).sort((a, b) => a - b);
        expect(stopLossValues).to.deep.equal([2, 15], "stop-loss candidates clamp to the 0..15 mirror range");
        expect(takeProfitValues).to.deep.equal([8, 40]);
        expect(captured.runLevel.stopLossPercent).to.equal(5);
        expect(captured.runLevel.takeProfitPercent).to.equal(10);
        for (const item of captured.items) {
            expect(item.settings.stopLossEnabled).to.equal(true);
            expect(item.settings.takeProfitEnabled).to.equal(true);
        }
    });

    it("keeps candidate riskMaxHoldBars overrides out of the per-item mirror", async () => {
        const captured = await captureRustSubmission({
            settings: {
                ...PERCENT_SETTINGS,
                riskMaxHoldEnabled: true,
                riskMaxHoldBars: 10,
            },
            paramSets: [{ riskMaxHoldBars: 999 }],
        });
        expect(captured.items).to.have.length(1);
        // riskMaxHoldBars is capability-gated and the current-chart run
        // sanitizes without capabilities, so the mirror strips it entirely —
        // the candidate's clamped override must not reintroduce it.
        expect("riskMaxHoldBars" in captured.items[0]!.settings).to.equal(false);
        expect("riskMaxHoldBars" in captured.runLevel).to.equal(false);
    });

    it("frozen risk management keeps every per-item settings identical to the run-level object", async () => {
        const captured = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }, { atrPeriod: 55 }],
            options: { freezeRiskManagement: true },
        });
        expect(captured.items).to.have.length(2);
        for (const item of captured.items) {
            expect(item.settings).to.equal(
                captured.runLevel as unknown,
                "frozen runs share the run-level settings object per item (no per-item mirror)",
            );
        }
    });

    it("never calls the Rust engine when the run requires the TypeScript engine", async () => {
        const captured = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }],
            requiresTsEngine: true,
        });
        expect(captured.callCount).to.equal(0);
        expect(captured.items).to.have.length(0);
    });

    it("carries no executionModel in the payloads: the current-chart run sanitizes without capabilities", async () => {
        const captured = await captureRustSubmission({
            settings: ATR_SETTINGS,
            paramSets: [{ atrPeriod: 29 }],
        });
        expect("executionModel" in captured.runLevel).to.equal(false);
        expect("executionModel" in captured.items[0]!.settings).to.equal(false);
    });
});
