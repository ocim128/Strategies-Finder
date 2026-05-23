import { debugLogger } from "../debug-logger";

type BacktestResultUiStep = {
    step: string;
    run: () => void;
};

export function logBacktestResultUiFailure(step: string, error: unknown): void {
    debugLogger.warn("backtest.result_ui_step_failed", {
        step,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
}

export function runBacktestResultUiSteps(steps: readonly BacktestResultUiStep[]): void {
    for (const { step, run } of steps) {
        try {
            run();
        } catch (error) {
            logBacktestResultUiFailure(step, error);
        }
    }
}
