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

declare const require: {
    config: (config: { paths: Record<string, string> }) => void;
    (modules: string[], callback: (...args: unknown[]) => void): void;
};

export class EditorManager {
    private monacoEditor: MonacoEditor | null = null;
    private customPresets: CustomStrategyConfig[] = [];
    private currentPresetKey: string | null = null;
    private dom: EditorManagerDom | null = null;

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
        this.initMonacoEditor();
        this.loadPresetList();
        this.setupHandlers(onStrategyUpdated);
    }

    private initMonacoEditor() {
        if (typeof require === "undefined") {
            debugLogger.warn("editor.monaco_loader_unavailable");
            return;
        }

        require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs" } });

        require(["vs/editor/editor.main"], (monaco: any) => {
            const monacoNamespace = monaco;

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
                value: this.DEFAULT_STRATEGY_CODE,
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
                    this.updateStatus("Modified", "");
                });
            }
        });
    }

    private setupHandlers(onStrategyUpdated: () => void) {
        const dom = this.getDom();

        dom.openCodeEditor.addEventListener("click", () => {
            dom.codeEditorModal.classList.add("active");
            this.monacoEditor?.layout();
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

    public loadPresetList() {
        this.customPresets = loadCustomStrategiesFromStorage();
        this.renderPresetList();
    }

    private renderPresetList() {
        const { presetList } = this.getDom();

        if (this.customPresets.length === 0) {
            presetList.innerHTML = '<div class="empty-state" style="padding: 20px; font-size: 12px; text-align: center; color: var(--text-secondary);">No saved presets</div>';
            return;
        }

        presetList.innerHTML = this.customPresets.map((preset, index) => `
            <div class="preset-item ${this.currentPresetKey === preset.key ? "active" : ""}" data-key="${preset.key}" tabindex="0">
                <span class="preset-name">${preset.name}</span>
                <button class="preset-delete" data-index="${index}">&times;</button>
            </div>
        `).join("");

        presetList.querySelectorAll(".preset-item").forEach(item => {
            const activatePreset = (event: Event) => {
                if ((event.target as HTMLElement).closest(".preset-delete")) return;
                const key = item.getAttribute("data-key");
                const preset = this.customPresets.find(p => p.key === key);
                if (preset) this.loadPreset(preset);
            };

            item.addEventListener("click", (event) => {
                activatePreset(event);
            });

            item.addEventListener("keydown", (event) => {
                if ((event as KeyboardEvent).key === "Enter" || (event as KeyboardEvent).key === " ") {
                    event.preventDefault();
                    activatePreset(event);
                }
            });
        });

        presetList.querySelectorAll(".preset-delete").forEach(button => {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                const index = parseInt(button.getAttribute("data-index") || "0", 10);
                this.deletePreset(index);
            });
        });
    }

    private loadPreset(preset: CustomStrategyConfig) {
        this.currentPresetKey = preset.key;
        this.setDraftIdentity(preset.name, preset.key);
        this.monacoEditor?.setValue(preset.executeCode);
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
        this.monacoEditor?.setValue(this.DEFAULT_STRATEGY_CODE);
        this.renderPresetList();
    }

    private validateCode(): boolean {
        if (!this.monacoEditor) return false;

        const code = this.monacoEditor.getValue();
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
        if (!this.monacoEditor || !this.validateCode()) {
            return false;
        }

        const { name, key } = this.getDraftIdentity();
        const code = this.monacoEditor.getValue();

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
