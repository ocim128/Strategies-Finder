import type { ExecutionModel } from "./types/strategies";
import { resolvePolymarketEntrySelectionMode, type PolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";
import { resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import {
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_ENABLED,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_MODE,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_PRICE_CENTS,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_OFFSET_CENTS,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_ENABLED,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_MODE,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_PRICE_CENTS,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_OFFSET_CENTS,
    clampPolymarketPostSignalLimitEntryPriceCents,
    clampPolymarketPostSignalLimitExitPriceCents,
    clampPolymarketPostSignalLimitOffsetCents,
    resolvePolymarketPostSignalLimitEntryMode,
    resolvePolymarketPostSignalLimitExitMode,
    type PolymarketLimitEntryPriceMode,
    type PolymarketLimitExitPriceMode,
} from "./polymarket-post-signal-limit-entry";

export interface PolymarketDomSettings {
    entryOffset: number | null;
    entrySelectionMode: PolymarketEntrySelectionMode;
    outcomeSymbol: string | null;
    outcomeInterval: PolymarketOutcomeInterval;
    exitMode: "resolve_hold" | "signal_exit_same_event" | undefined;
    postSignalLimitEntryEnabled: boolean;
    postSignalLimitEntryMode: PolymarketLimitEntryPriceMode;
    postSignalLimitEntryPriceCents: number;
    postSignalLimitEntryOffsetCents: number;
    postSignalLimitExitEnabled: boolean;
    postSignalLimitExitMode: PolymarketLimitExitPriceMode;
    postSignalLimitExitPriceCents: number;
    postSignalLimitExitOffsetCents: number;
    executionModel: ExecutionModel | undefined;
}

function readSelectElement(doc: Document, id: string): HTMLSelectElement | null {
    const element = doc.getElementById(id);
    if (!element) return null;
    if (typeof HTMLSelectElement !== "undefined") {
        return element instanceof HTMLSelectElement ? element : null;
    }
    return "value" in element ? element as HTMLSelectElement : null;
}

function readInputElement(doc: Document, id: string): HTMLInputElement | null {
    const element = doc.getElementById(id);
    if (!element) return null;
    if (typeof HTMLInputElement !== "undefined") {
        return element instanceof HTMLInputElement ? element : null;
    }
    return "value" in element || "checked" in element ? element as HTMLInputElement : null;
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
    const limitEntryToggle = readInputElement(doc, "polymarketPostSignalLimitEntryEnabled");
    const limitEntryModeSelect = readSelectElement(doc, "polymarketPostSignalLimitEntryMode");
    const limitEntryPriceInput = readInputElement(doc, "polymarketPostSignalLimitEntryPriceCents");
    const limitEntryOffsetInput = readInputElement(doc, "polymarketPostSignalLimitEntryOffsetCents");
    const limitExitToggle = readInputElement(doc, "polymarketPostSignalLimitExitEnabled");
    const limitExitModeSelect = readSelectElement(doc, "polymarketPostSignalLimitExitMode");
    const limitExitPriceInput = readInputElement(doc, "polymarketPostSignalLimitExitPriceCents");
    const limitExitOffsetInput = readInputElement(doc, "polymarketPostSignalLimitExitOffsetCents");
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
        postSignalLimitEntryEnabled: limitEntryToggle
            ? limitEntryToggle.checked
            : DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_ENABLED,
        postSignalLimitEntryMode: resolvePolymarketPostSignalLimitEntryMode(
            limitEntryModeSelect?.value ?? DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_MODE
        ),
        postSignalLimitEntryPriceCents: clampPolymarketPostSignalLimitEntryPriceCents(
            limitEntryPriceInput?.value ?? DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_PRICE_CENTS
        ),
        postSignalLimitEntryOffsetCents: clampPolymarketPostSignalLimitOffsetCents(
            limitEntryOffsetInput?.value ?? DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_OFFSET_CENTS
        ),
        postSignalLimitExitEnabled: limitExitToggle
            ? limitExitToggle.checked
            : DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_ENABLED,
        postSignalLimitExitMode: resolvePolymarketPostSignalLimitExitMode(
            limitExitModeSelect?.value ?? DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_MODE
        ),
        postSignalLimitExitPriceCents: clampPolymarketPostSignalLimitExitPriceCents(
            limitExitPriceInput?.value ?? DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_PRICE_CENTS
        ),
        postSignalLimitExitOffsetCents: clampPolymarketPostSignalLimitOffsetCents(
            limitExitOffsetInput?.value ?? DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_OFFSET_CENTS
        ),
        executionModel: executionModelSelect ? parseExecutionModel(executionModelSelect.value) : undefined,
    };
}
