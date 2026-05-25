import {
    strategyRegistry,
    createCustomStrategy,
    saveCustomStrategiesToStorage,
    loadCustomStrategiesFromStorage,
    CustomStrategyConfig
} from "../strategyRegistry";
import { setCurrentStrategyKey } from "./state-actions";
import { backtestService } from "./backtest-service";
import { StrategyExecutor } from "./strategy-executor";
import { createEditorManagerDom, type EditorManagerDom } from "./editor-manager-dom";
import { debugLogger } from "./debug-logger";

interface MonacoEditor {
    getValue(): string;
    setValue(value: string): void;
    getModel(): { onDidChangeContent: (callback: () => void) => void } | null;
    layout(): void;
    dispose(): void;
}

type MonacoRequire = {
    config: (config: { paths: Record<string, string> }) => void;
    (modules: string[], callback: (...args: unknown[]) => void, errorback?: (error: unknown) => void): void;
};

declare global {
    interface Window {
        require?: MonacoRequire;
    }
}

const MONACO_VERSION = "0.45.0";
const MONACO_CDN_BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`;
const MONACO_LOADER_SRC = `${MONACO_CDN_BASE}/vs/loader.js`;

export class EditorManager {
    private monacoEditor: MonacoEditor | null = null;
    private monacoEditorLoadPromise: Promise<void> | null = null;
    private customPresets: CustomStrategyConfig[] = [];
    private currentPresetKey: string | null = null;
    private dom: EditorManagerDom | null = null;
    private initialized = false;
    private editorCode = "";

    private readonly DEFAULT_STRATEGY_CODE = `// Custom Strategy Template
// The function receives 'data' (OHLCV array), 'params' (your parameters),
// and 'indicators' (helper functions)

const closes = data.map(d => d.close);
const highs = data.map(d => d.high);
const lows = data.map(d => d.low);

// Calculate your indicators
const fastEMA = indicators.calculateEMA(closes, params.fastPeriod || 12);
const slowEMA = indicators.calculateEMA(closes, params.slowPeriod || 26);

const signals = [];

for (let i = 1; i < data.length; i++) {
    if (fastEMA[i] === null || slowEMA[i] === null ||
        fastEMA[i - 1] === null || slowEMA[i - 1] === null) continue;

    // Buy signal: fast crosses above slow
    if (fastEMA[i - 1] <= slowEMA[i - 1] && fastEMA[i] > slowEMA[i]) {
        signals.push({
            time: data[i].time,
            type: 'buy',
            price: data[i].close,
            reason: 'EMA Bullish Crossover'
        });
    }
    // Sell signal: fast crosses below slow
    else if (fastEMA[i - 1] >= slowEMA[i - 1] && fastEMA[i] < slowEMA[i]) {
        signals.push({
            time: data[i].time,
            type: 'sell',
            price: data[i].close,
            reason: 'EMA Bearish Crossover'
        });
    }
}

return signals;`;

    constructor() {
        this.editorCode = this.DEFAULT_STRATEGY_CODE;
    }

    private getDom(): EditorManagerDom {
        return this.dom ??= createEditorManagerDom();
    }

    private getDraftIdentity(): { name: string; key: string } {
        const { strategyName, strategyKey } = this.getDom();
        return {
            name: strategyName.value.trim(),
            key: strategyKey.value.trim(),
        };
    }

    private setDraftIdentity(name: string, key: string): void {
        const { strategyName, strategyKey } = this.getDom();
        strategyName.value = name;
        strategyKey.value = key;
    }

    public init(onStrategyUpdated: () => void) {
        if (this.initialized) {
            return;
        }

        this.loadPresetList();
        this.setupHandlers(onStrategyUpdated);
        this.initialized = true;
    }

    private ensureMonacoLoader(): Promise<MonacoRequire> {
        if (typeof window === "undefined" || typeof document === "undefined") {
            return Promise.reject(new Error("Monaco editor requires a browser environment"));
        }

        if (window.require) {
            return Promise.resolve(window.require);
        }

        return new Promise((resolve, reject) => {
            const existingScript = document.querySelector<HTMLScriptElement>('script[data-monaco-loader="true"]');
            const resolveRequire = () => {
                if (window.require) {
                    resolve(window.require);
                    return;
                }
                reject(new Error("Monaco loader completed without exposing require"));
            };

            if (existingScript) {
                if (existingScript.dataset.monacoLoaded === "true") {
                    resolveRequire();
                    return;
                }
                existingScript.addEventListener("load", resolveRequire, { once: true });
                existingScript.addEventListener("error", () => reject(new Error("Failed to load Monaco loader")), { once: true });
                return;
            }

            const script = document.createElement("script");
            script.src = MONACO_LOADER_SRC;
            script.async = true;
            script.dataset.monacoLoader = "true";
            script.addEventListener("load", () => {
                script.dataset.monacoLoaded = "true";
                resolveRequire();
            }, { once: true });
            script.addEventListener("error", () => reject(new Error("Failed to load Monaco loader")), { once: true });
            document.head.appendChild(script);
        });
    }

    private ensureMonacoEditor(): Promise<void> {
        if (this.monacoEditor) {
            return Promise.resolve();
        }

        if (this.monacoEditorLoadPromise) {
            return this.monacoEditorLoadPromise;
        }

        this.monacoEditorLoadPromise = this.ensureMonacoLoader()
            .then((monacoRequire) => new Promise<void>((resolve, reject) => {
                monacoRequire.config({ paths: { vs: `${MONACO_CDN_BASE}/vs` } });

                monacoRequire(["vs/editor/editor.main"], (monaco: any) => {
                    this.createMonacoEditor(monaco);
                    resolve();
                }, reject);
            }))
            .catch((error: unknown) => {
                this.monacoEditorLoadPromise = null;
                debugLogger.error("editor.monaco_load_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            });

        return this.monacoEditorLoadPromise;
    }

    private createMonacoEditor(monacoNamespace: any): void {
        if (this.monacoEditor) {
            return;
        }

        if (!this.getDom().monacoContainer) {
            debugLogger.warn("editor.monaco_loader_unavailable");
            return;
        }

        monacoNamespace.editor.defineTheme("strategyDark", {
            base: "vs-dark",
            inherit: true,
            rules: [
                { token: "comment", foreground: "6a737d", fontStyle: "italic" },
                { token: "keyword", foreground: "ff7b72" },
                { token: "string", foreground: "a5d6ff" },
                { token: "number", foreground: "79c0ff" },
                { token: "identifier", foreground: "d1d4dc" }
            ],
            colors: {
                "editor.background": "#131722",
                "editor.foreground": "#d1d4dc",
                "editorCursor.foreground": "#2962ff",
                "editor.lineHighlightBackground": "#1e222d",
                "editorLineNumber.foreground": "#787b86",
                "editor.selectionBackground": "#2962ff44",
                "editor.inactiveSelectionBackground": "#2962ff22"
            }
        });

        monacoNamespace.editor.setTheme("strategyDark");

        this.monacoEditor = monacoNamespace.editor.create(this.getDom().monacoContainer, {
            value: this.editorCode,
            language: "javascript",
            theme: "strategyDark",
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Consolas', monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            glyphMargin: false,
            folding: true,
            lineDecorationsWidth: 10,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: "on",
            padding: { top: 12, bottom: 12 }
        });

        const model = this.monacoEditor?.getModel();
        if (model) {
            model.onDidChangeContent(() => {
                this.editorCode = this.monacoEditor?.getValue() ?? this.editorCode;
                this.updateStatus("Modified", "");
            });
        }
    }

    private setEditorCode(code: string): void {
        this.editorCode = code;
        this.monacoEditor?.setValue(code);
    }

    private getEditorCode(): string {
        return this.monacoEditor?.getValue() ?? this.editorCode;
    }

    private setupHandlers(onStrategyUpdated: () => void) {
        const dom = this.getDom();

        dom.openCodeEditor.addEventListener("click", () => {
            dom.codeEditorModal.classList.add("active");
            this.updateStatus(this.monacoEditor ? "Ready" : "Loading editor...", "");
            void this.ensureMonacoEditor()
                .then(() => {
                    this.monacoEditor?.layout();
                    this.updateStatus("Ready", "");
                })
                .catch((error: unknown) => {
                    this.updateStatus("Editor failed to load", "error");
                    debugLogger.error("editor.open_failed", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
        });

        dom.closeCodeEditor.addEventListener("click", () => {
            dom.codeEditorModal.classList.remove("active");
        });

        dom.newPresetBtn.addEventListener("click", () => this.newStrategy());
        dom.validateCodeBtn.addEventListener("click", () => this.validateCode());
        dom.savePresetBtn.addEventListener("click", () => {
            this.savePreset();
            onStrategyUpdated();
        });
        dom.applyStrategyBtn.addEventListener("click", () => {
            this.applyAndRun();
        });

        dom.presetList.addEventListener("click", (event) => {
            this.handlePresetListClick(event);
        });

        dom.presetList.addEventListener("keydown", (event) => {
            this.handlePresetListKeydown(event);
        });

        dom.strategyName.addEventListener("input", () => {
            if (!dom.strategyKey.value || this.currentPresetKey === null) {
                dom.strategyKey.value = dom.strategyName.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, "_")
                    .replace(/_+/g, "_")
                    .replace(/^_|_$/g, "");
            }
        });
    }

    private handlePresetListClick(event: MouseEvent): void {
        const target = event.target as HTMLElement | null;
        const presetList = this.getDom().presetList;
        const deleteButton = target?.closest<HTMLButtonElement>(".preset-delete");
        if (deleteButton && presetList.contains(deleteButton)) {
            event.stopPropagation();
            const index = parseInt(deleteButton.dataset.index || "0", 10);
            this.deletePreset(index);
            return;
        }

        const item = target?.closest<HTMLElement>(".preset-item");
        if (item && presetList.contains(item)) {
            this.activatePresetItem(item);
        }
    }

    private handlePresetListKeydown(event: KeyboardEvent): void {
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }
        const target = event.target as HTMLElement | null;
        if (target?.closest(".preset-delete")) {
            return;
        }
        const item = target?.closest<HTMLElement>(".preset-item");
        if (!item || !this.getDom().presetList.contains(item)) {
            return;
        }
        event.preventDefault();
        this.activatePresetItem(item);
    }

    private activatePresetItem(item: HTMLElement): void {
        const key = item.dataset.key;
        const preset = this.customPresets.find(preset => preset.key === key);
        if (preset) this.loadPreset(preset);
    }

    public loadPresetList() {
        this.customPresets = loadCustomStrategiesFromStorage();
        this.renderPresetList();
    }

    private renderPresetList() {
        const { presetList } = this.getDom();
        presetList.innerHTML = "";

        if (this.customPresets.length === 0) {
            presetList.innerHTML = '<div class="empty-state" style="padding: 20px; font-size: 12px; text-align: center; color: var(--text-secondary);">No saved presets</div>';
            return;
        }

        const fragment = document.createDocumentFragment();
        this.customPresets.forEach((preset, index) => {
            const item = document.createElement("div");
            item.className = `preset-item ${this.currentPresetKey === preset.key ? "active" : ""}`;
            item.dataset.key = preset.key;
            item.tabIndex = 0;

            const name = document.createElement("span");
            name.className = "preset-name";
            name.textContent = preset.name;

            const deleteButton = document.createElement("button");
            deleteButton.className = "preset-delete";
            deleteButton.dataset.index = String(index);
            deleteButton.textContent = "\u00d7";

            item.append(name, deleteButton);
            fragment.appendChild(item);
        });
        presetList.appendChild(fragment);
    }

    private loadPreset(preset: CustomStrategyConfig) {
        this.currentPresetKey = preset.key;
        this.setDraftIdentity(preset.name, preset.key);
        this.setEditorCode(preset.executeCode);
        this.renderPresetList();
        this.updateStatus(`Loaded: ${preset.name}`, "");
    }

    private deletePreset(index: number) {
        const preset = this.customPresets[index];
        if (!preset) return;

        strategyRegistry.unregister(preset.key);
        this.customPresets.splice(index, 1);
        saveCustomStrategiesToStorage(this.customPresets);

        if (this.currentPresetKey === preset.key) {
            this.currentPresetKey = null;
            this.newStrategy();
            return;
        }

        this.renderPresetList();
    }

    private newStrategy() {
        this.currentPresetKey = null;
        this.setDraftIdentity("", "");
        this.setEditorCode(this.DEFAULT_STRATEGY_CODE);
        this.renderPresetList();
    }

    private validateCode(): boolean {
        const code = this.getEditorCode();
        const { name, key } = this.getDraftIdentity();

        if (!name || !key) {
            this.updateStatus("Name and key are required", "error");
            return false;
        }

        try {
            StrategyExecutor.compile(code);
            this.updateStatus("Code is valid", "success");
            return true;
        } catch (error) {
            this.updateStatus(`Syntax error: ${(error as Error).message}`, "error");
            return false;
        }
    }

    private savePreset(): boolean {
        if (!this.validateCode()) {
            return false;
        }

        const { name, key } = this.getDraftIdentity();
        const code = this.getEditorCode();

        const config: CustomStrategyConfig = {
            key,
            name,
            description: `Custom: ${name}`,
            defaultParams: { fastPeriod: 12, slowPeriod: 26 },
            paramLabels: { fastPeriod: "Fast Period", slowPeriod: "Slow Period" },
            executeCode: code
        };

        const existingIndex = this.customPresets.findIndex(preset => preset.key === key);
        if (existingIndex >= 0) {
            this.customPresets[existingIndex] = config;
        } else {
            this.customPresets.push(config);
        }

        saveCustomStrategiesToStorage(this.customPresets);
        this.currentPresetKey = key;
        this.renderPresetList();
        createCustomStrategy(config);
        return true;
    }

    private applyAndRun() {
        if (!this.savePreset()) {
            return;
        }

        const { codeEditorModal } = this.getDom();
        const { key } = this.getDraftIdentity();
        setCurrentStrategyKey(key);
        codeEditorModal.classList.remove("active");
        setTimeout(() => backtestService.runCurrentBacktest(), 100);
    }

    private updateStatus(message: string, className: string) {
        const { editorStatus } = this.getDom();
        editorStatus.textContent = message;
        editorStatus.className = `editor-status ${className}`;
    }
}

export const editorManager = new EditorManager();
