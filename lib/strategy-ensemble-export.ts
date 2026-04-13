import {
    buildEnsembleRecipeBotEnvSnippet,
    buildEnsembleRecipeBridgeScript,
    resolveExternalSignalSymbol,
    slugifyEnsembleSignalRecipeName,
} from "./ensemble-signal-bridge";
import {
    buildEnsembleRecipeVariantSlug,
    describeEnsembleRecipeReplayDirectionOverride,
    type EnsembleRecipeReplayDirectionOverride,
} from "./ensemble-signal-direction";
import { uiManager } from "./ui-manager";
import { settingsManager, type EnsembleSignalRecipe } from "./settings-manager";

export type EnsembleExportDeps = {
    getSelectedSignalRecipe: () => EnsembleSignalRecipe | null;
    updateSignalRecipeStatus: (message: string) => void;
    getSelectedRecipeDirectionOverride: () => EnsembleRecipeReplayDirectionOverride;
    syncSavedSignalRecipeOptions: () => void;
};

export class StrategyEnsembleExport {
    private deps: EnsembleExportDeps;

    constructor(deps: EnsembleExportDeps) {
        this.deps = deps;
    }

    async downloadSelectedSignalRecipeBridge(): Promise<void> {
        const recipe = this.deps.getSelectedSignalRecipe();
        if (!recipe) {
            const message = "Select a saved ensemble signal recipe first.";
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        const botSymbol = resolveExternalSignalSymbol(recipe.symbol);
        if (!botSymbol) {
            const message = `Recipe ${recipe.name} uses unsupported external-signal symbol ${recipe.symbol}.`;
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        const slug = slugifyEnsembleSignalRecipeName(recipe.name);
        const directionOverride = this.deps.getSelectedRecipeDirectionOverride();
        const variantSlug = buildEnsembleRecipeVariantSlug(slug, directionOverride);
        const variantLabel = describeEnsembleRecipeReplayDirectionOverride(directionOverride);
        const script = buildEnsembleRecipeBridgeScript(recipe, slug, botSymbol, directionOverride);
        downloadTextFile(`${variantSlug}.bridge.ps1`, script, "text/plain;charset=utf-8");
        this.deps.updateSignalRecipeStatus(`Downloaded recipe bridge script for ${recipe.name} (${variantLabel}).`);
        uiManager.showToast(`Downloaded bridge for ${recipe.name} (${variantLabel})`, "success");
    }

    async copySelectedSignalRecipeEnv(): Promise<void> {
        const recipe = this.deps.getSelectedSignalRecipe();
        if (!recipe) {
            const message = "Select a saved ensemble signal recipe first.";
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        const botSymbol = resolveExternalSignalSymbol(recipe.symbol);
        if (!botSymbol) {
            const message = `Recipe ${recipe.name} uses unsupported external-signal symbol ${recipe.symbol}.`;
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        const slug = slugifyEnsembleSignalRecipeName(recipe.name);
        const directionOverride = this.deps.getSelectedRecipeDirectionOverride();
        const variantLabel = describeEnsembleRecipeReplayDirectionOverride(directionOverride);
        const snippet = buildEnsembleRecipeBotEnvSnippet(recipe, slug, botSymbol, directionOverride);
        const copied = await copyToClipboard(snippet);
        if (!copied) {
            const message = `Failed to copy env snippet for ${recipe.name}.`;
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        this.deps.updateSignalRecipeStatus(`Copied recipe env snippet for ${recipe.name} (${variantLabel}).`);
        uiManager.showToast(`Copied env snippet for ${recipe.name} (${variantLabel})`, "success");
    }

    deleteSelectedSignalRecipe(): void {
        const recipe = this.deps.getSelectedSignalRecipe();
        if (!recipe) {
            const message = "Select a saved ensemble signal recipe first.";
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        if (!window.confirm(`Delete saved ensemble signal recipe "${recipe.name}"?`)) {
            return;
        }

        const deleted = settingsManager.deleteEnsembleSignalRecipe(recipe.name);
        if (!deleted) {
            const message = `Failed to delete recipe ${recipe.name}.`;
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        this.deps.syncSavedSignalRecipeOptions();
        this.deps.updateSignalRecipeStatus(`Deleted recipe ${recipe.name}.`);
        uiManager.showToast(`Deleted recipe: ${recipe.name}`, "success");
    }
}

export function downloadTextFile(fileName: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        return copied;
    }
}
