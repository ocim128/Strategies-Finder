import type { PolymarketPanelDom } from "./polymarket-panel-dom";
import {
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarket5mRun,
} from "./polymarket-btc5m";
import { state } from "./state";
import { settingsManager, type StrategyConfig } from "./settings-manager";
import { uiManager } from "./ui-manager";
import { strategyRegistry } from "../strategyRegistry";

export class PolymarketBridgeExport {
    private bridgeConfigSignature = "";
    private selectedBridgeConfigName = "";
    private getDom: () => PolymarketPanelDom;

    constructor(getDom: () => PolymarketPanelDom) {
        this.getDom = getDom;
    }

    get selectedConfigName(): string {
        return this.selectedBridgeConfigName;
    }

    set selectedConfigName(name: string) {
        this.selectedBridgeConfigName = name;
    }

    renderBridgeControls(): void {
        const dom = this.getDom();
        const supportedRun = isSupportedPolymarket5mRun(state.currentSymbol, state.currentInterval);
        const configs = this.ensureBridgeConfigOptions();
        const selectedConfig = this.getSelectedBridgeConfig(configs);
        const botSymbol = resolveExternalSignalSymbol(state.currentSymbol);
        const strategyAvailable = selectedConfig ? strategyRegistry.has(selectedConfig.strategyKey) : false;
        const canExport = Boolean(supportedRun && botSymbol && selectedConfig && strategyAvailable);

        dom.polymarketBridgeDownloadScript.disabled = !canExport;
        dom.polymarketBridgeCopyEnv.disabled = !canExport;

        if (configs.length === 0) {
            dom.polymarketBridgeStatus.textContent = "Save a configuration in Settings first. Bridge export uses saved strategy params, backtest settings, and capital settings.";
            return;
        }

        if (!selectedConfig) {
            dom.polymarketBridgeStatus.textContent = "Select a saved configuration to generate the bridge bundle.";
            return;
        }

        if (!strategyAvailable) {
            dom.polymarketBridgeStatus.textContent = `Saved config "${selectedConfig.name}" references unavailable strategy "${selectedConfig.strategyKey}".`;
            return;
        }

        if (!supportedRun || !botSymbol) {
            dom.polymarketBridgeStatus.textContent = `Bridge export currently supports ${getSupportedPolymarket5mSymbolsLabel()} on the 5m chart. Current chart: ${state.currentSymbol} ${state.currentInterval}.`;
            return;
        }

        dom.polymarketBridgeStatus.textContent = `Ready: "${selectedConfig.name}" -> ${selectedConfig.strategyKey} on ${state.currentSymbol} ${state.currentInterval}. The script writes bridge JSON files, exports the latest signal, generates a reusable refresh script, and writes a bot env snippet.`;
    }

    ensureBridgeConfigOptions(force = false): StrategyConfig[] {
        const dom = this.getDom();
        const configs = [...settingsManager.loadAllStrategyConfigs()].sort((left, right) => {
            const timeDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
            if (Number.isFinite(timeDelta) && timeDelta !== 0) {
                return timeDelta;
            }
            return left.name.localeCompare(right.name);
        });
        const signature = configs
            .map((config) => `${config.name}|${config.updatedAt}|${config.strategyKey}`)
            .join("||");

        if (
            !force
            && signature === this.bridgeConfigSignature
            && dom.polymarketBridgeConfig.options.length > 0
        ) {
            return configs;
        }

        const preferredName = dom.polymarketBridgeConfig.value || this.selectedBridgeConfigName;
        dom.polymarketBridgeConfig.innerHTML = "";

        const placeholderOption = document.createElement("option");
        placeholderOption.value = "";
        placeholderOption.textContent = "Select saved configuration";
        dom.polymarketBridgeConfig.appendChild(placeholderOption);

        for (const config of configs) {
            const option = document.createElement("option");
            option.value = config.name;
            option.textContent = `${config.name} | ${config.strategyKey}`;
            option.title = `Updated ${config.updatedAt}`;
            dom.polymarketBridgeConfig.appendChild(option);
        }

        const nextSelection = preferredName && configs.some((config) => config.name === preferredName)
            ? preferredName
            : configs[0]?.name ?? "";

        dom.polymarketBridgeConfig.value = nextSelection;
        this.selectedBridgeConfigName = nextSelection;
        this.bridgeConfigSignature = signature;
        return configs;
    }

    getSelectedBridgeConfig(configs = this.ensureBridgeConfigOptions()): StrategyConfig | null {
        const selectedName = this.getDom().polymarketBridgeConfig.value || this.selectedBridgeConfigName;
        if (!selectedName) {
            return null;
        }
        return configs.find((config) => config.name === selectedName) ?? null;
    }

    async handleBridgeScriptDownload(): Promise<void> {
        const context = this.getBridgeExportContext();
        if (!context) {
            uiManager.showToast("Select a supported 5m chart and a valid saved config first.", "error");
            return;
        }

        const fileName = `run-polymarket-bridge-${context.slug}.ps1`;
        const script = buildBridgeScript(context.config, context.slug, context.botSymbol);
        downloadTextFile(fileName, script, "text/plain;charset=utf-8");
        this.getDom().polymarketBridgeStatus.textContent = `Downloaded ${fileName}. Run it in PowerShell to write the bridge bundle, generate the refresh helper, and export the latest signal.`;
        uiManager.showToast(`Downloaded ${fileName}`, "success");
    }

    async handleCopyBotEnv(): Promise<void> {
        const context = this.getBridgeExportContext();
        if (!context) {
            uiManager.showToast("Select a supported 5m chart and a valid saved config first.", "error");
            return;
        }

        const snippet = buildBotEnvSnippet(context.slug, context.botSymbol, context.config.name);
        const copied = await copyToClipboard(snippet);
        if (!copied) {
            uiManager.showToast("Failed to copy bot env snippet.", "error");
            return;
        }

        this.getDom().polymarketBridgeStatus.textContent = `Copied bot env snippet for "${context.config.name}". The downloaded script will also generate a matching .env snippet file with the resolved signal and refresh-script paths.`;
        uiManager.showToast("Copied bot env snippet", "success");
    }

    getBridgeExportContext(): { config: StrategyConfig; slug: string; botSymbol: string } | null {
        const supportedRun = isSupportedPolymarket5mRun(state.currentSymbol, state.currentInterval);
        if (!supportedRun) {
            return null;
        }

        const config = this.getSelectedBridgeConfig();
        if (!config || !strategyRegistry.has(config.strategyKey)) {
            return null;
        }

        const strategy = strategyRegistry.get(config.strategyKey)!;
        if (strategy.crossSymbolConfig) {
            this.getDom().polymarketBridgeStatus.textContent = `"${config.name}" uses cross-symbol strategy "${config.strategyKey}" which is not supported by bridge export.`;
            return null;
        }

        const botSymbol = resolveExternalSignalSymbol(state.currentSymbol);
        if (!botSymbol) {
            return null;
        }

        return {
            config,
            slug: slugifyConfigName(config.name),
            botSymbol,
        };
    }
}

export function resolveExternalSignalSymbol(symbol: string): string | null {
    const normalized = symbol.trim().toUpperCase();
    if (normalized === "BTCUSDT") return "btc";
    if (normalized === "ETHUSDT") return "eth";
    if (normalized === "SOLUSDT") return "sol";
    if (normalized === "XRPUSDT") return "xrp";
    return null;
}

export function slugifyConfigName(name: string): string {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "saved-config";
}

export function toPowerShellSingleQuoted(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export function buildBotEnvSnippet(slug: string, botSymbol: string, configName: string): string {
    return [
        `# ${configName}`,
        "# Replace <STRATEGY_FINDER_ROOT> with your local Strategies-Finder path, using forward slashes, or run the downloaded script and use the generated .bot.env file.",
        "TRADING_MODE=external_signal",
        "DRY_RUN=true",
        `EXTERNAL_SIGNAL_SYMBOL=${botSymbol}`,
        `EXTERNAL_SIGNAL_FILE=<STRATEGY_FINDER_ROOT>/signals/bridge/${slug}.latest-entry-signal.json`,
        "EXTERNAL_SIGNAL_POLL_INTERVAL_MS=2000",
        "EXTERNAL_SIGNAL_MAX_SIGNAL_LAG_SECS=600",
        "EXTERNAL_SIGNAL_LOG_FILE=logs/external_signal.jsonl",
        `EXTERNAL_SIGNAL_REFRESH_SCRIPT=<STRATEGY_FINDER_ROOT>/signals/bridge/${slug}.refresh.ps1`,
        "EXTERNAL_SIGNAL_REFRESH_DELAY_SECS=2",
        "EXTERNAL_SIGNAL_REFRESH_TIMEOUT_SECS=120",
        "MULTI_WALLET_NON_INTERACTIVE=true",
        "WALLET_1_STRATEGY=external_signal",
    ].join("\r\n");
}

export function buildBridgeScript(config: StrategyConfig, slug: string, botSymbol: string): string {
    const paramsJson = JSON.stringify(config.strategyParams, null, 2);
    const backtestJson = JSON.stringify(config.backtestSettings, null, 2);
    const capitalJson = JSON.stringify(settingsManager.resolveCapitalFromConfig(config), null, 2);
    const configName = toPowerShellSingleQuoted(config.name);
    const strategyKey = toPowerShellSingleQuoted(config.strategyKey);
    const symbol = toPowerShellSingleQuoted(state.currentSymbol);
    const interval = toPowerShellSingleQuoted(state.currentInterval);
    const slugLiteral = toPowerShellSingleQuoted(slug);
    const botSymbolLiteral = toPowerShellSingleQuoted(botSymbol);
    const refreshScriptBody = [
        "param(",
        "    [string]$StrategyFinderRoot = '',",
        "    [int]$Bars = 500,",
        "    [int]$FreshnessBars = 0",
        ")",
        "",
        "$ErrorActionPreference = 'Stop'",
        "",
        `function Test-StrategyFinderRoot {`,
        "    param([string]$CandidatePath)",
        "    if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return $false }",
        "    $resolved = Resolve-Path -LiteralPath $CandidatePath -ErrorAction SilentlyContinue",
        "    if (-not $resolved) { return $false }",
        "    $root = $resolved.Path",
        "    return (Test-Path (Join-Path $root 'package.json')) -and (Test-Path (Join-Path $root 'scripts\\export-latest-entry-signal.ts'))",
        "}",
        "",
        "function Resolve-StrategyFinderRoot {",
        "    param([string]$ExplicitPath)",
        "    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {",
        "        if (Test-StrategyFinderRoot $ExplicitPath) {",
        "            return (Resolve-Path -LiteralPath $ExplicitPath).Path",
        "        }",
        "        throw ('Invalid StrategyFinderRoot: ' + $ExplicitPath)",
        "    }",
        "    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {",
        "        throw 'PSScriptRoot is empty. Pass -StrategyFinderRoot explicitly.'",
        "    }",
        "    $signalsDir = Split-Path -Path $PSScriptRoot -Parent",
        "    if ([string]::IsNullOrWhiteSpace($signalsDir)) {",
        "        throw 'Could not resolve signals directory from bridge refresh script.'",
        "    }",
        "    $candidateRoot = Split-Path -Path $signalsDir -Parent",
        "    if (Test-StrategyFinderRoot $candidateRoot) {",
        "        return (Resolve-Path -LiteralPath $candidateRoot).Path",
        "    }",
        "    throw ('Could not resolve Strategies-Finder root from ' + $PSScriptRoot + '. Pass -StrategyFinderRoot explicitly.')",
        "}",
        "",
        `$StrategyKey = ${strategyKey}`,
        `$Symbol = ${symbol}`,
        `$Interval = ${interval}`,
        `$ConfigSlug = ${slugLiteral}`,
        "",
        "$ResolvedRoot = Resolve-StrategyFinderRoot -ExplicitPath $StrategyFinderRoot",
        "$BridgeDir = Join-Path $ResolvedRoot 'signals\\bridge'",
        "$ParamsPath = Join-Path $BridgeDir ($ConfigSlug + '.params.json')",
        "$BacktestPath = Join-Path $BridgeDir ($ConfigSlug + '.backtest.json')",
        "$CapitalPath = Join-Path $BridgeDir ($ConfigSlug + '.capital.json')",
        "$SignalPath = Join-Path $BridgeDir ($ConfigSlug + '.latest-entry-signal.json')",
        "",
        "$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue",
        "if (-not $npmCommand) {",
        "    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue",
        "}",
        "if (-not $npmCommand) {",
        "    throw 'npm was not found on PATH.'",
        "}",
        "",
        "Push-Location $ResolvedRoot",
        "try {",
        "    & $npmCommand.Source run signal:export -- --strategy $StrategyKey --symbol $Symbol --interval $Interval --bars $Bars --freshness-bars $FreshnessBars --params-file $ParamsPath --backtest-settings-file $BacktestPath --capital-settings-file $CapitalPath --out $SignalPath",
        "    if ($LASTEXITCODE -ne 0) {",
        "        throw ('signal:export exited with code ' + $LASTEXITCODE)",
        "    }",
        "}",
        "finally {",
        "    Pop-Location",
        "}",
        "",
        "Write-Host ('Signal refreshed: ' + $SignalPath)",
        "",
    ].join("\r\n");

    return [
        "param(",
        "    [string]$StrategyFinderRoot = '',",
        "    [int]$Bars = 500,",
        "    [int]$FreshnessBars = 0",
        ")",
        "",
        "$ErrorActionPreference = 'Stop'",
        "",
        `$ConfigName = ${configName}`,
        `$ConfigSlug = ${slugLiteral}`,
        `$StrategyKey = ${strategyKey}`,
        `$Symbol = ${symbol}`,
        `$Interval = ${interval}`,
        `$BotSymbol = ${botSymbolLiteral}`,
        "",
        "function Test-StrategyFinderRoot {",
        "    param([string]$CandidatePath)",
        "    if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return $false }",
        "    $resolved = Resolve-Path -LiteralPath $CandidatePath -ErrorAction SilentlyContinue",
        "    if (-not $resolved) { return $false }",
        "    $root = $resolved.Path",
        "    return (Test-Path (Join-Path $root 'package.json')) -and (Test-Path (Join-Path $root 'scripts\\export-latest-entry-signal.ts'))",
        "}",
        "",
        "function Find-StrategyFinderRootFromSeed {",
        "    param([string]$SeedPath)",
        "    if ([string]::IsNullOrWhiteSpace($SeedPath)) { return $null }",
        "    $current = $SeedPath",
        "    while (-not [string]::IsNullOrWhiteSpace($current)) {",
        "        if (Test-StrategyFinderRoot $current) {",
        "            return (Resolve-Path -LiteralPath $current).Path",
        "        }",
        "        $parent = Split-Path -Path $current -Parent",
        "        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {",
        "            break",
        "        }",
        "        $current = $parent",
        "    }",
        "    return $null",
        "}",
        "",
        "function Resolve-StrategyFinderRoot {",
        "    param([string]$ExplicitPath)",
        "    $candidates = @()",
        "    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { $candidates += $ExplicitPath }",
        "    if (-not [string]::IsNullOrWhiteSpace($env:STRATEGY_FINDER_ROOT)) { $candidates += $env:STRATEGY_FINDER_ROOT }",
        "    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $candidates += $PSScriptRoot }",
        "    $candidates += (Get-Location).Path",
        "    $userProfile = [Environment]::GetFolderPath('UserProfile')",
        "    if (-not [string]::IsNullOrWhiteSpace($userProfile)) {",
        "        $candidates += (Join-Path $userProfile 'Documents\\Repo\\Experimental\\lightweight-charts\\debug\\playground\\Strategies-Finder')",
        "        $candidates += (Join-Path $userProfile 'Documents\\Strategies-Finder')",
        "    }",
        "    foreach ($candidate in $candidates) {",
        "        $resolved = Find-StrategyFinderRootFromSeed $candidate",
        "        if (-not [string]::IsNullOrWhiteSpace($resolved)) {",
        "            return $resolved",
        "        }",
        "    }",
        "    throw 'Could not locate the Strategies-Finder repo. Run this script from the repo, pass -StrategyFinderRoot, or set STRATEGY_FINDER_ROOT.'",
        "}",
        "",
        "function Write-Utf8NoBomFile {",
        "    param(",
        "        [string]$Path,",
        "        [string]$Content",
        "    )",
        "    $encoding = New-Object System.Text.UTF8Encoding($false)",
        "    [System.IO.File]::WriteAllText($Path, $Content, $encoding)",
        "}",
        "",
        "$StrategyFinderRoot = Resolve-StrategyFinderRoot -ExplicitPath $StrategyFinderRoot",
        "$BridgeDir = Join-Path $StrategyFinderRoot 'signals\\bridge'",
        "$ParamsPath = Join-Path $BridgeDir ($ConfigSlug + '.params.json')",
        "$BacktestPath = Join-Path $BridgeDir ($ConfigSlug + '.backtest.json')",
        "$CapitalPath = Join-Path $BridgeDir ($ConfigSlug + '.capital.json')",
        "$SignalPath = Join-Path $BridgeDir ($ConfigSlug + '.latest-entry-signal.json')",
        "$RefreshScriptPath = Join-Path $BridgeDir ($ConfigSlug + '.refresh.ps1')",
        "$BotEnvPath = Join-Path $BridgeDir ($ConfigSlug + '.bot.env')",
        "$SignalPathForEnv = $SignalPath -replace '\\\\', '/'",
        "$RefreshScriptPathForEnv = $RefreshScriptPath -replace '\\\\', '/'",
        "New-Item -ItemType Directory -Path $BridgeDir -Force | Out-Null",
        "",
        "$ParamsJson = @'",
        paramsJson,
        "'@",
        "",
        "$BacktestJson = @'",
        backtestJson,
        "'@",
        "",
        "$CapitalJson = @'",
        capitalJson,
        "'@",
        "",
        "Write-Utf8NoBomFile -Path $ParamsPath -Content $ParamsJson",
        "Write-Utf8NoBomFile -Path $BacktestPath -Content $BacktestJson",
        "Write-Utf8NoBomFile -Path $CapitalPath -Content $CapitalJson",
        "",
        "$RefreshScript = @'",
        refreshScriptBody,
        "'@",
        "",
        "Write-Utf8NoBomFile -Path $RefreshScriptPath -Content $RefreshScript",
        "",
        '$BotEnv = @"',
        "TRADING_MODE=external_signal",
        "DRY_RUN=true",
        "EXTERNAL_SIGNAL_SYMBOL=$BotSymbol",
        "EXTERNAL_SIGNAL_FILE=$SignalPathForEnv",
        "EXTERNAL_SIGNAL_POLL_INTERVAL_MS=2000",
        "EXTERNAL_SIGNAL_MAX_SIGNAL_LAG_SECS=600",
        "EXTERNAL_SIGNAL_LOG_FILE=logs/external_signal.jsonl",
        "EXTERNAL_SIGNAL_REFRESH_SCRIPT=$RefreshScriptPathForEnv",
        "EXTERNAL_SIGNAL_REFRESH_DELAY_SECS=2",
        "EXTERNAL_SIGNAL_REFRESH_TIMEOUT_SECS=120",
        "MULTI_WALLET_NON_INTERACTIVE=true",
        "WALLET_1_STRATEGY=external_signal",
        '"@',
        "Write-Utf8NoBomFile -Path $BotEnvPath -Content $BotEnv",
        "",
        "& $RefreshScriptPath -StrategyFinderRoot $StrategyFinderRoot -Bars $Bars -FreshnessBars $FreshnessBars",
        "",
        "Write-Host ('Bridge ready for ' + $ConfigName)",
        "Write-Host ('Signal file: ' + $SignalPath)",
        "Write-Host ('Refresh script: ' + $RefreshScriptPath)",
        "Write-Host ('Bot env snippet: ' + $BotEnvPath)",
        "",
    ].join("\r\n");
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
