import type { BacktestResultSource } from "./state";

export interface BacktestRerunContext {
    source: BacktestResultSource;
    label: string;
    rerun: () => Promise<void>;
}

let activeBacktestRerunContext: BacktestRerunContext | null = null;

export function getActiveBacktestRerunContext(): BacktestRerunContext | null {
    return activeBacktestRerunContext;
}

export function setActiveBacktestRerunContext(context: BacktestRerunContext | null): void {
    activeBacktestRerunContext = context;
}

export function clearActiveBacktestRerunContext(): void {
    activeBacktestRerunContext = null;
}
