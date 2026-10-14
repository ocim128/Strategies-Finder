import { debugLogger } from "../debug-logger";
import { formatError } from "../error-format";
import { nowMs } from "../perf-clock";

type BacktestResultUiStep = {
    step: string;
    run: () => void;
};

const SLOW_UI_STEP_THRESHOLD_MS = 16;

export function logBacktestResultUiFailure(step: string, error: unknown): void {
    debugLogger.warn("backtest.result_ui_step_failed", {
        step,
        error: formatError(error),
    });
}

export function runBacktestResultUiSteps(steps: readonly BacktestResultUiStep[]): void {
    for (const { step, run } of steps) {
        const startMs = nowMs();
        try {
            run();
        } catch (error) {
            logBacktestResultUiFailure(step, error);
        } finally {
            const durationMs = nowMs() - startMs;
            if (durationMs >= SLOW_UI_STEP_THRESHOLD_MS) {
                debugLogger.event("backtest.result_ui_step_slow", {
                    step,
                    durationMs: Number(durationMs.toFixed(1)),
                });
            }
        }
    }
}
