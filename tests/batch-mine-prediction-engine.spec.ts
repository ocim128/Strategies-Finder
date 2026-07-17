import { expect } from "chai";
import { describe, it } from "node:test";
import { runMinePredictionDiagnostic } from "../lib/batch-backtest/batch-mine-prediction-engine";
import type { BatchSyntheticPairArtifact, BatchSyntheticTargetArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
import type { BacktestResult, OHLCVData, Time } from "../lib/types/strategies";

function makeCandles(length: number, priceAt: (index: number) => number): OHLCVData[] {
    return Array.from({ length }, (_, index) => {
        const close = priceAt(index);
        return {
            time: (1_700_000_000 + index * 86400) as Time,
            open: close,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 1000,
        };
    });
}

function emptyResult(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

describe("batch-mine-prediction-engine diagnostic", () => {
    it("returns a graceful 'no artifacts' result when the artifact list is empty", () => {
        const result = runMinePredictionDiagnostic({
            artifacts: [],
            targets: [],
            interval: "4h",
            horizons: [12, 24],
        });
        expect(result.pairs).to.equal(0);
        expect(result.samples).to.equal(0);
        expect(result.verdict).to.match(/No synthetic-pair artifacts/);
        expect(result.reportLines.length).to.be.greaterThan(0);
    });

    it("returns a graceful 'no targets' result when assets are missing", () => {
        const data = makeCandles(20, (i) => 100 + i);
        const artifacts: BatchSyntheticPairArtifact[] = [
            { symbol: "AAA+BBB", baseAsset: "AAA", quoteAsset: "BBB", data, signals: [], result: emptyResult() },
        ];
        const result = runMinePredictionDiagnostic({
            artifacts,
            targets: [],
            interval: "4h",
        });
        expect(result.verdict).to.match(/No target asset candles/);
    });

    it("produces a report with RANK_IC / HIT_RATE / VERDICT lines when given valid inputs", () => {
        // Minimal but valid setup: a synthetic pair with trades + a target
        // asset with enough history. The Mine engine will run; we don't assert
        // on the verdict value (depends on the analog engine's behavior on
        // synthetic data) — only that the report structure is populated.
        const length = 500;
        const asset = makeCandles(length, (i) => 100 + i * 0.05);
        const targets: BatchSyntheticTargetArtifact[] = [
            { asset: "AAA", symbol: "AAAUSDT", data: asset },
        ];
        // Construct a pair artifact with one long trade so Mine has a state to verdict on.
        const artifacts: BatchSyntheticPairArtifact[] = [{
            symbol: "AAA+BBB",
            baseAsset: "AAA",
            quoteAsset: "BBB",
            data: asset,
            signals: [{ time: asset[10]!.time, type: "buy", price: asset[10]!.close }],
            result: {
                ...emptyResult(),
                totalTrades: 1,
                trades: [{
                    id: 0,
                    type: "long",
                    entryTime: asset[10]!.time,
                    entryPrice: asset[10]!.close,
                    exitTime: asset[length - 1]!.time,
                    exitPrice: asset[length - 1]!.close,
                    pnl: 0,
                    pnlPercent: 0,
                    size: 1,
                    exitReason: "end_of_data",
                }],
            },
        }];

        const result = runMinePredictionDiagnostic({
            artifacts,
            targets,
            interval: "4h",
            horizons: [12, 24],
            sampleBars: 5,
            sampleStep: 50,
            minSamples: 4,
            minOosSamples: 2,
            neighborMin: 2,
            neighborMax: 8,
        });

        // Report must include the key lines regardless of verdict.
        expect(result.reportLines.some((l) => l.startsWith("MINE_PRED | strategy="))).to.equal(true);
        expect(result.reportLines.some((l) => l.startsWith("RANK_IC"))).to.equal(true);
        expect(result.reportLines.some((l) => l.startsWith("HIT_RATE"))).to.equal(true);
        expect(result.reportLines.some((l) => l.startsWith("VERDICT"))).to.equal(true);
        expect(result.reportLines.some((l) => l.startsWith("LIFT_COR"))).to.equal(true);
    });

    it("does NOT mislabel a negative-primary-IC as WEAK_PREDICTIVE (sign-correctness regression)", () => {
        // This is the bug I caught twice in earlier iterations: a verdict
        // logic that checks |IC| >= threshold without checking sign labels a
        // counter-predictive signal as "WEAK_PREDICTIVE". The engine's verdict
        // must be sign-aware and primary-horizon-anchored.
        //
        // We can't easily force a specific IC value through the public API
        // (it depends on the analog engine's k-NN on real data), but we CAN
        // verify the verdict vocabulary is sign-aware by checking that the
        // verdict string never contains "WEAK_PREDICTIVE" alongside a negative
        // primary IC. Construct a case where Mine is likely INCONCLUSIVE
        // (flat data → no analog edge) and verify the verdict is NO_EDGE or
        // ANTI, never a self-contradicting WEAK_PREDICTIVE-on-negative.
        const length = 300;
        const flat = makeCandles(length, () => 100);
        const targets: BatchSyntheticTargetArtifact[] = [
            { asset: "FLAT", symbol: "FLATUSDT", data: flat },
        ];
        const artifacts: BatchSyntheticPairArtifact[] = [{
            symbol: "FLAT+QUOTE",
            baseAsset: "FLAT",
            quoteAsset: "QUOTE",
            data: flat,
            signals: [],
            result: emptyResult(),
        }];

        const result = runMinePredictionDiagnostic({
            artifacts,
            targets,
            interval: "4h",
            horizons: [12],
            sampleBars: 5,
            sampleStep: 30,
        });

        // On flat data Mine should produce no edge. Verify the verdict is one
        // of the sign-aware outcomes, and that if primaryIc is negative the
        // verdict is NOT WEAK_PREDICTIVE.
        expect(result.verdict).to.match(/^(NO_EDGE|ANTI|WEAK_PREDICTIVE)/);
        if (Number.isFinite(result.primaryIc) && result.primaryIc < 0) {
            expect(result.verdict, `verdict must not be WEAK_PREDICTIVE on negative IC (${result.primaryIc})`).to.not.match(/^WEAK_PREDICTIVE/);
        }
        // If verdict claims WEAK_PREDICTIVE, primary IC must actually be > 0.05.
        if (result.verdict.startsWith("WEAK_PREDICTIVE")) {
            expect(result.primaryIc, "WEAK_PREDICTIVE requires primary IC > 0.05").to.be.greaterThan(0.05);
        }
    });

    it("invokes the per-asset progress callback", () => {
        const length = 300;
        const data = makeCandles(length, (i) => 100 + i * 0.01);
        const targets: BatchSyntheticTargetArtifact[] = [
            { asset: "A1", symbol: "A1USDT", data },
            { asset: "A2", symbol: "A2USDT", data },
        ];
        const artifacts: BatchSyntheticPairArtifact[] = [{
            symbol: "A1+A2", baseAsset: "A1", quoteAsset: "A2",
            data, signals: [], result: emptyResult(),
        }];
        const progressCalls: string[] = [];
        runMinePredictionDiagnostic({
            artifacts,
            targets,
            interval: "4h",
            horizons: [12],
            sampleBars: 3,
            sampleStep: 30,
            onAssetProgress: (asset) => progressCalls.push(asset),
        });
        // Progress callback fires once per asset that produced samples (or
        // attempted). At least one call should have happened.
        expect(progressCalls.length).to.be.greaterThan(0);
    });

    it("uses corrected CAVEAT/EDGE wording (no misleading 'does not exceed' or 'baseline drift')", () => {
        // Regression for the AI-audit finding: the CAVEAT condition is
        // `< 0.5% threshold`, NOT `<= 0`. The old wording ("LONG mean return
        // does not exceed INCONCLUSIVE mean") lied about the condition. Also
        // the EDGE baseline is passive-long drift (direction=null defaults to
        // long-sign), NOT cash — so the label must say so.
        const length = 300;
        const data = makeCandles(length, (i) => 100 + i * 0.01);
        const targets: BatchSyntheticTargetArtifact[] = [
            { asset: "A1", symbol: "A1USDT", data },
        ];
        const artifacts: BatchSyntheticPairArtifact[] = [{
            symbol: "A1+QUOTE", baseAsset: "A1", quoteAsset: "QUOTE",
            data, signals: [], result: emptyResult(),
        }];
        const result = runMinePredictionDiagnostic({
            artifacts, targets, interval: "4h",
            horizons: [12], sampleBars: 5, sampleStep: 30,
        });
        const allText = result.reportLines.join("\n");
        // The old misleading phrases must NEVER appear, regardless of whether
        // the caveat fired. This guards against a revert.
        expect(allText, "must not contain the old misleading CAVEAT wording").to.not.contain("does not exceed INCONCLUSIVE mean");
        expect(allText, "must not contain the old misleading 'refusing' wording").to.not.contain("no edge over refusing");
        // EDGE line must label the baseline as passive-long drift, not 'baseline drift'.
        const edgeLine = result.reportLines.find((l) => l.startsWith("EDGE"));
        if (edgeLine) {
            expect(edgeLine, "EDGE baseline must be labeled passive-long drift, not 'baseline drift'").to.contain("passive-long drift");
            expect(edgeLine, "EDGE baseline must clarify it is NOT cash").to.contain("NOT cash");
        }
        // If a LONG-edge caveat fired, it must reference the threshold.
        const caveatLine = result.reportLines.find((l) => l.startsWith("CAVEAT") && l.includes("LONG edge"));
        if (caveatLine) {
            expect(caveatLine, "LONG-edge caveat must reference the meaningful-edge threshold").to.contain("meaningful-edge threshold");
        }
    });
});
