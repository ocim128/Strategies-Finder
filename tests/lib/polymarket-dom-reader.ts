import type { ExecutionModel } from "./types/strategies";
import { resolvePolymarketEntrySelectionMode, type PolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";
import { resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "./polymarket-outcome-interval";

export interface PolymarketDomSettings {
    entryOffset: number | null;
    entrySelectionMode: PolymarketEntrySelectionMode;
    outcomeSymbol: string | null;
    outcomeInterval: PolymarketOutcomeInterval;
    exitMode: "resolve_hold" | "signal_exit_same_event" | undefined;
    executionModel: ExecutionModel | undefined;
}

function readSelectElement(doc: Document, id: string): HTMLSelectElement | null {
    const element = doc.getElementById(id);
    return element instanceof HTMLSelectElement ? element : null;
}

function parseExecutionModel(value: string): ExecutionModel | undefined {
    return value === "signal_close" || value === "next_open" || value === "next_close"
        ? value
        : undefined;
}

export function resolvePolymarketDomSettings(doc: Document = document): PolymarketDomSettings {
    const entryOffsetSelect = readSelectElement(doc, "polymarketEntryOffset");
    const entrySelectionModeSelect = readSelectElement(doc, "polymarketEntrySelectionMode");
    const outcomeSymbolSelect = readSelectElement(doc, "polymarketOutcomeSymbol");
    const outcomeIntervalSelect = readSelectElement(doc, "polymarketOutcomeInterval");
    const exitModeSelect = readSelectElement(doc, "polymarketExitMode");
    const executionModelSelect = readSelectElement(doc, "executionModel");

    const rawEntryOffset = entryOffsetSelect ? Number(entryOffsetSelect.value) : null;
    const outcomeSymbol = outcomeSymbolSelect?.value.trim().toUpperCase() ?? "";

    return {
        entryOffset: rawEntryOffset !== null && Number.isFinite(rawEntryOffset) ? rawEntryOffset : null,
        entrySelectionMode: resolvePolymarketEntrySelectionMode(entrySelectionModeSelect?.value),
        outcomeSymbol: outcomeSymbol.length > 0 ? outcomeSymbol : null,
        outcomeInterval: resolvePolymarketOutcomeInterval(outcomeIntervalSelect?.value),
        exitMode: exitModeSelect
            ? (exitModeSelect.value === "signal_exit_same_event" ? "signal_exit_same_event" : "resolve_hold")
            : undefined,
        executionModel: executionModelSelect ? parseExecutionModel(executionModelSelect.value) : undefined,
    };
}
