import { debugLogger } from "../debug-logger";

type BacktestResultUiStep = {
    step: string;
    run: () => void;
};

const SLOW_UI_STEP_THRESHOLD_MS = 16;

function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function logBacktestResultUiFailure(step: string, error: unknown): void {
    debugLogger.warn("backtest.result_ui_step_failed", {
        step,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
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
