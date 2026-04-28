import { strategyRegistry, isBuiltInStrategyKey } from "../strategyRegistry";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "./strategy-defaults";
import { debugLogger } from "./debug-logger";
import { createStrategyLibraryAdminDom, type StrategyLibraryAdminDom } from "./strategy-library-admin-dom";
import { deleteBuiltInStrategyLibraryEntries, deleteBuiltInStrategyLibraryEntry } from "./strategy-library-admin-api";
import { parseStrategyLibraryBulkEntries } from "./strategy-library-admin-utils";
import { state } from "./state";
import { uiManager } from "./ui-manager";

type StrategyLibraryStatusTone = "ready" | "warning" | "muted" | "busy";

interface StrategyLibraryStatus {
    canDelete: boolean;
    message: string;
    tone: StrategyLibraryStatusTone;
}

class StrategyLibraryAdminService {
    private dom: StrategyLibraryAdminDom | null = null;
    private initialized = false;
    private deleteBusy = false;

    public init(): void {
        if (this.initialized) {
            return;
        }

        this.dom = createStrategyLibraryAdminDom();
        this.bindEvents();
        state.subscribe("currentStrategyKey", () => this.syncUi());
        strategyRegistry.subscribe(() => this.syncUi());
        this.syncUi();
        this.initialized = true;
    }

    private getDom(): StrategyLibraryAdminDom {
        return this.dom ??= createStrategyLibraryAdminDom();
    }

    private bindEvents(): void {
        const {
            deleteBuiltInStrategyBtn,
            strategyLibraryBulkKeys,
            useCurrentStrategyKeyBtn,
            useCurrentStrategyNameBtn,
            deleteBulkBuiltInStrategiesBtn,
        } = this.getDom();

        deleteBuiltInStrategyBtn.addEventListener("click", () => {
            void this.handleDeleteCurrentStrategy();
        });
        strategyLibraryBulkKeys.addEventListener("input", () => this.syncUi());
        useCurrentStrategyKeyBtn.addEventListener("click", () => {
            this.appendCurrentKeyToBulkList();
        });
        useCurrentStrategyNameBtn.addEventListener("click", () => {
            this.appendCurrentNameToBulkList();
        });
        deleteBulkBuiltInStrategiesBtn.addEventListener("click", () => {
            void this.handleDeleteBulkStrategies();
        });
    }

    private describeCurrentStrategy(): StrategyLibraryStatus {
        const key = state.currentStrategyKey;
        const strategyName = strategyRegistry.get(key)?.name?.trim();
        const strategyLabel = strategyName && strategyName !== key
            ? `"${strategyName}" (${key})`
            : `"${key}"`;

        if (this.deleteBusy) {
            return {
                canDelete: false,
                message: `Deleting ${strategyLabel} and syncing the manifest...`,
                tone: "busy",
            };
        }

        if (!key || !strategyRegistry.has(key)) {
            return {
                canDelete: false,
                message: "Select an available strategy first.",
                tone: "muted",
            };
        }

        if (!isBuiltInStrategyKey(key)) {
            return {
                canDelete: false,
                message: "Current selection is not a manifest-backed built-in strategy.",
                tone: "muted",
            };
        }

        if (key === DEFAULT_BUILT_IN_STRATEGY_KEY) {
            return {
                canDelete: false,
                message: "The default built-in strategy is protected. Change lib/strategy-defaults.ts first if you really need to remove it.",
                tone: "warning",
            };
        }

        return {
            canDelete: true,
            message: `Archive + delete ${strategyLabel}. The source file is backed up to archive/strategy and lib/strategies/manifest.ts is resynced automatically.`,
            tone: "ready",
        };
    }

    private syncUi(): void {
        const {
            strategyLibraryMenuStatus,
            deleteBuiltInStrategyBtn,
            deleteBulkBuiltInStrategiesBtn,
            useCurrentStrategyKeyBtn,
            useCurrentStrategyNameBtn,
        } = this.getDom();
        const status = this.describeCurrentStrategy();
        const bulkEntries = this.getParsedBulkEntries();
        const currentStrategyName = this.getCurrentStrategyName();
        strategyLibraryMenuStatus.textContent = status.message;
        strategyLibraryMenuStatus.dataset.state = status.tone;
        deleteBuiltInStrategyBtn.disabled = !status.canDelete;
        deleteBuiltInStrategyBtn.classList.toggle("is-loading", this.deleteBusy);
        deleteBulkBuiltInStrategiesBtn.disabled = this.deleteBusy || bulkEntries.length === 0;
        deleteBulkBuiltInStrategiesBtn.classList.toggle("is-loading", this.deleteBusy);
        useCurrentStrategyKeyBtn.disabled = this.deleteBusy || !state.currentStrategyKey.trim();
        useCurrentStrategyNameBtn.disabled = this.deleteBusy || currentStrategyName.length === 0;
    }

    private getParsedBulkEntries(): string[] {
        const { strategyLibraryBulkKeys } = this.getDom();
        return parseStrategyLibraryBulkEntries(strategyLibraryBulkKeys.value);
    }

    private setBulkEntries(entries: readonly string[]): void {
        const { strategyLibraryBulkKeys } = this.getDom();
        strategyLibraryBulkKeys.value = entries.join("\n");
        this.syncUi();
    }

    private appendCurrentKeyToBulkList(): void {
        const key = state.currentStrategyKey.trim();
        if (!key) {
            return;
        }

        const entries = this.getParsedBulkEntries();
        if (!entries.includes(key)) {
            entries.push(key);
            this.setBulkEntries(entries);
        } else {
            this.syncUi();
        }
    }

    private getCurrentStrategyName(): string {
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        return strategy?.name?.trim() ?? "";
    }

    private appendCurrentNameToBulkList(): void {
        const strategyName = this.getCurrentStrategyName();
        if (!strategyName) {
            return;
        }

        const entries = this.getParsedBulkEntries();
        if (!entries.includes(strategyName)) {
            entries.push(strategyName);
            this.setBulkEntries(entries);
        } else {
            this.syncUi();
        }
    }

    private async handleDeleteCurrentStrategy(): Promise<void> {
        const key = state.currentStrategyKey;
        const status = this.describeCurrentStrategy();

        if (!status.canDelete) {
            uiManager.showToast(status.message, status.tone === "warning" ? "warning" : "error");
            return;
        }

        const confirmed = window.confirm(
            `Archive and delete built-in strategy "${key}"?\n\n` +
            `Backup folder: archive/strategy\n` +
            `Manifest sync: automatic\n` +
            `This removes the strategy from the current session after the backup succeeds.`
        );

        if (!confirmed) {
            return;
        }

        this.deleteBusy = true;
        this.syncUi();

        try {
            const result = await deleteBuiltInStrategyLibraryEntry(key);
            const removed = strategyRegistry.unregister(key);
            this.getDom().strategyLibraryMenu.open = false;

            debugLogger.event("strategy_library.delete", {
                strategy: key,
                sourcePath: result.sourceRelativePath,
                backupPath: result.backupRelativePath,
                manifestStrategies: result.manifestStrategyCount,
                removedFromRegistry: removed,
            });

            uiManager.showToast(
                `Archived + deleted "${key}". Backup: ${result.backupRelativePath}`,
                "success"
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to delete built-in strategy.";
            debugLogger.error("strategy_library.delete_failed", {
                strategy: key,
                error: message,
            });
            uiManager.showToast(message, "error");
        } finally {
            this.deleteBusy = false;
            this.syncUi();
        }
    }

    private async handleDeleteBulkStrategies(): Promise<void> {
        const entries = this.getParsedBulkEntries();
        if (entries.length === 0) {
            uiManager.showToast("Enter at least one built-in strategy key, name, or filename to delete.", "error");
            return;
        }

        const preview = entries.slice(0, 8).join(", ");
        const moreCount = entries.length > 8 ? `, +${entries.length - 8} more` : "";
        const confirmed = window.confirm(
            `Archive and delete ${entries.length} built-in strategies?\n\n` +
            `Entries: ${preview}${moreCount}\n` +
            `Backup folder: archive/strategy\n` +
            `Manifest sync: automatic\n` +
            `The current browser session keeps running, but deleted strategies are removed from the dropdown.`
        );

        if (!confirmed) {
            return;
        }

        this.deleteBusy = true;
        this.syncUi();

        try {
            const result = await deleteBuiltInStrategyLibraryEntries(entries);
            for (const item of result.deleted) {
                strategyRegistry.unregister(item.key);
            }

            this.getDom().strategyLibraryMenu.open = false;
            this.setBulkEntries([]);

            debugLogger.event("strategy_library.delete_batch", {
                requested: entries,
                deleted: result.deleted.map((item) => item.key),
                manifestStrategies: result.manifestStrategyCount,
            });

            uiManager.showToast(
                `Archived + deleted ${result.deleted.length} strategies.`,
                "success"
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to delete built-in strategies.";
            debugLogger.error("strategy_library.delete_batch_failed", {
                requested: entries,
                error: message,
            });
            uiManager.showToast(message, "error");
        } finally {
            this.deleteBusy = false;
            this.syncUi();
        }
    }
}

export const strategyLibraryAdminService = new StrategyLibraryAdminService();
