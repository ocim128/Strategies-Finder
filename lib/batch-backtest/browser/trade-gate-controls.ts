/**
 * Trade Gate form controls (Batch menu): persisted gate options, the server
 * sweep catalog fetch, selection rendering/validation, and the estimate
 * status line. Owns the catalog + persisted-options state; the run preflight
 * (facade/`BatchRunController`) consumes the validated options.
 */
import { debugLogger } from "../../debug-logger";
import type { LedgerSweepCatalogResponse } from "../trade-ledger-sweep-stream-types";
import type { BatchBacktestDom } from "../batch-backtest-dom";
import {
    BATCH_TRADE_GATE_STORAGE,
    readPersistedTradeGateOptions,
    type BatchTradeGateOptions,
} from "./batch-browser-store";
import { writePersistedJson } from "../../persisted-json";

function formatGatePercent(value: number | null): string {
    return value !== null && Number.isFinite(value) ? value.toFixed(2) : "--";
}

function formatGateBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function formatGateSweepDate(modifiedAt: number): string {
    return Number.isFinite(modifiedAt) ? new Date(modifiedAt).toISOString().slice(0, 10) : "unknown date";
}

export class TradeGateControls {
    private catalog: LedgerSweepCatalogResponse | null = null;
    private persistedOptions = readPersistedTradeGateOptions();

    getCatalog(): LedgerSweepCatalogResponse | null {
        return this.catalog;
    }

    getPersistedOptions(): BatchTradeGateOptions {
        return this.persistedOptions;
    }

    restoreOptions(dom: BatchBacktestDom): void {
        dom.batchBacktestTradeGateToggle.checked = this.persistedOptions.enabled;
    }

    readOptions(dom: BatchBacktestDom): BatchTradeGateOptions {
        return {
            enabled: dom.batchBacktestTradeGateToggle.checked,
            folderId: dom.batchBacktestTradeGateFolder.value.trim(),
            ruleIds: Array.from(dom.batchBacktestTradeGateRules.selectedOptions).map((option) => option.value),
        };
    }

    persistOptions(dom: BatchBacktestDom): void {
        this.persistedOptions = this.readOptions(dom);
        writePersistedJson({
            ...BATCH_TRADE_GATE_STORAGE,
            data: this.persistedOptions,
            onError: (error) => debugLogger.warn("batch_backtest.trade_gate_save_failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        });
    }

    async refreshCatalog(getDom: () => BatchBacktestDom): Promise<boolean> {
        const dom = getDom();
        try {
            const response = await fetch("/api/trade-ledger-sweep/catalog");
            if (!response.ok) throw new Error(`catalog request failed (${response.status})`);
            const payload = await response.json() as LedgerSweepCatalogResponse;
            if (payload.ok !== true) throw new Error("catalog response was not successful");
            this.catalog = payload;
            const eligibleFolders = payload.folders.filter((folder) => folder.runnable && folder.latestSweep !== null);
            dom.batchBacktestTradeGateFolder.replaceChildren(...eligibleFolders.map((folder) => {
                const option = document.createElement("option");
                option.value = folder.folderId;
                option.textContent = `${folder.name} · ${formatGateBytes(folder.ledgerBytes)} · sweep ${formatGateSweepDate(folder.latestSweep?.modifiedAt ?? Number.NaN)} · ${folder.latestSweep?.edgeRules.length ?? 0} EDGE rules`;
                return option;
            }));
            if (eligibleFolders.some((folder) => folder.folderId === this.persistedOptions.folderId)) {
                dom.batchBacktestTradeGateFolder.value = this.persistedOptions.folderId;
            } else if (eligibleFolders[0]) {
                dom.batchBacktestTradeGateFolder.value = eligibleFolders[0].folderId;
            }
            this.renderSelection(dom);
            return true;
        } catch (error) {
            this.catalog = null;
            dom.batchBacktestTradeGateWarning.textContent = "Trade Gate is server-side only; the local sweep catalog is unavailable.";
            debugLogger.warn("batch_backtest.trade_gate_catalog_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    renderSelection(dom: BatchBacktestDom): void {
        const folder = this.catalog?.folders.find((entry) => entry.folderId === dom.batchBacktestTradeGateFolder.value) ?? null;
        const edgeRules = [...(folder?.latestSweep?.edgeRules ?? [])].sort((a, b) =>
            (b.holdoutMeanPnlDeltaPp ?? Number.NEGATIVE_INFINITY) - (a.holdoutMeanPnlDeltaPp ?? Number.NEGATIVE_INFINITY)
            || a.ruleId.localeCompare(b.ruleId));
        const selectedRuleIds = new Set(this.persistedOptions.ruleIds);
        dom.batchBacktestTradeGateRules.replaceChildren(...edgeRules.map((rule) => {
            const option = document.createElement("option");
            option.value = rule.ruleId;
            option.textContent = `${rule.ruleName} · kept ${formatGatePercent(rule.keptPct)}% · IS ${formatGatePercent(rule.isMeanPnlDeltaPp)}pp · holdout ${formatGatePercent(rule.holdoutMeanPnlDeltaPp)}pp`;
            option.selected = selectedRuleIds.has(rule.ruleId);
            return option;
        }));
        const selected = Array.from(dom.batchBacktestTradeGateRules.selectedOptions);
        if (!dom.batchBacktestTradeGateToggle.checked) {
            dom.batchBacktestTradeGateEstimate.textContent = "Trade Gate off. Batch results use the ordinary engine path.";
            dom.batchBacktestTradeGateWarning.textContent = "";
            return;
        }
        if (!folder || edgeRules.length === 0) {
            dom.batchBacktestTradeGateEstimate.textContent = "No completed sweep with EDGE-CANDIDATE rules is available.";
            dom.batchBacktestTradeGateWarning.textContent = "Enable the gate only after selecting a current local sweep folder and rule.";
            return;
        }
        const selectedRules = edgeRules.filter((rule) => selected.some((option) => option.value === rule.ruleId));
        if (selectedRules.length === 0) {
            dom.batchBacktestTradeGateEstimate.textContent = "Select at least one EDGE-CANDIDATE rule.";
            dom.batchBacktestTradeGateWarning.textContent = "The estimate is based on sweep kept rates and is not a measured admission rate.";
            return;
        }
        const estimatedAdmission = 100 * (1 - selectedRules.reduce(
            (product, rule) => product * (1 - Math.max(0, Math.min(100, rule.keptPct ?? 0)) / 100),
            1,
        ));
        const estimatedRejection = Math.max(0, 100 - estimatedAdmission);
        dom.batchBacktestTradeGateEstimate.textContent = `Rule rejects ~${estimatedRejection.toFixed(1)}% of signals (from sweep) · ${selectedRules.length} rule${selectedRules.length === 1 ? "" : "s"} selected.`;
        dom.batchBacktestTradeGateWarning.textContent = selectedRules.length > 1
            ? "OR semantics: a signal is admitted if any selected rule passes. Overlapping rules can stack admissions; this is not diversification."
            : "Server-side only. The run performs a causal feature pre-pass and records gate counters.";
    }

    /**
     * Authoritative run-preflight validation: gate off passes through; gate on
     * requires a catalog folder plus at least one EDGE-CANDIDATE rule.
     */
    validateSelection(dom: BatchBacktestDom): BatchTradeGateOptions | null {
        const options = this.readOptions(dom);
        if (!options.enabled) return options;
        const folder = this.catalog?.folders.find((entry) => entry.folderId === options.folderId);
        const edgeRuleIds = new Set(folder?.latestSweep?.edgeRules.map((rule) => rule.ruleId) ?? []);
        if (!folder || options.ruleIds.length === 0 || options.ruleIds.some((ruleId) => !edgeRuleIds.has(ruleId))) {
            dom.batchBacktestStatus.textContent = "Trade Gate is server-side only; select a current sweep folder and at least one EDGE-CANDIDATE rule.";
            return null;
        }
        return options;
    }
}

