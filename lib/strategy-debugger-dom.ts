import { getRequiredElement } from "./dom-utils";

export const STRATEGY_DEBUGGER_REQUIRED_IDS = [
    "strategyDebuggerBaseline",
    "strategyDebuggerMinScored",
    "strategyDebuggerSearch",
    "strategyDebuggerOnlyPolymarket1s",
    "strategyDebuggerSelectVisible",
    "strategyDebuggerSelectNone",
    "strategyDebuggerStrategySummary",
    "strategyDebuggerStrategyList",
    "strategyDebuggerRun",
    "strategyDebuggerStop",
    "strategyDebuggerCopyDiagnostic",
    "strategyDebuggerProgressFill",
    "strategyDebuggerProgressText",
    "strategyDebuggerStatus",
    "strategyDebuggerEmpty",
    "strategyDebuggerResults",
    "strategyDebuggerDiagnosticOutput",
] as const;

export function createStrategyDebuggerDom() {
    return {
        baseline: getRequiredElement<HTMLSelectElement>("strategyDebuggerBaseline"),
        minScored: getRequiredElement<HTMLInputElement>("strategyDebuggerMinScored"),
        search: getRequiredElement<HTMLInputElement>("strategyDebuggerSearch"),
        onlyPolymarket1s: getRequiredElement<HTMLInputElement>("strategyDebuggerOnlyPolymarket1s"),
        selectVisible: getRequiredElement<HTMLButtonElement>("strategyDebuggerSelectVisible"),
        selectNone: getRequiredElement<HTMLButtonElement>("strategyDebuggerSelectNone"),
        strategySummary: getRequiredElement("strategyDebuggerStrategySummary"),
        strategyList: getRequiredElement("strategyDebuggerStrategyList"),
        run: getRequiredElement<HTMLButtonElement>("strategyDebuggerRun"),
        stop: getRequiredElement<HTMLButtonElement>("strategyDebuggerStop"),
        copyDiagnostic: getRequiredElement<HTMLButtonElement>("strategyDebuggerCopyDiagnostic"),
        progressFill: getRequiredElement("strategyDebuggerProgressFill"),
        progressText: getRequiredElement("strategyDebuggerProgressText"),
        status: getRequiredElement("strategyDebuggerStatus"),
        empty: getRequiredElement("strategyDebuggerEmpty"),
        results: getRequiredElement("strategyDebuggerResults"),
        diagnosticOutput: getRequiredElement("strategyDebuggerDiagnosticOutput"),
    };
}

export type StrategyDebuggerDom = ReturnType<typeof createStrategyDebuggerDom>;
