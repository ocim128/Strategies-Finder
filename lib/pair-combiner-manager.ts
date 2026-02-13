import { state } from "./state";
import { assetSearchService, Asset } from "./asset-search-service";
import { binanceSearchService } from "./binance-search-service";
import { uiManager } from "./ui-manager";
import { debugLogger } from "./debug-logger";
import { chartManager } from "./chart-manager";
import { dataManager } from "./data-manager";
import { debounce } from "./debounce";
import { alignPairData } from "./pairCombiner";
import { calculateCopulaDependence } from "./pairCombiner";
import { waveletDecompose } from "./pairCombiner";
import { calculateTransferEntropy } from "./pairCombiner";
import { clamp, mean, std, pearsonCorrelation } from "./pairCombiner/utils";
import type {
    AnalysisMethod,
    PairAnalysisResults,
    WaveletResult,
    TransferEntropyResult,
    CopulaResult,
} from "./pairCombiner";

const DEFAULT_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];

function calculateReturns(closes: number[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
        const prev = Math.max(1e-12, closes[i - 1]);
        const current = Math.max(1e-12, closes[i]);
        returns.push(Math.log(current / prev));
    }
    return returns;
}

function scoreWavelet(wavelet: WaveletResult): number {
    const z = Math.min(3, Math.abs(wavelet.spreadZScore));
    const signalClarity = clamp(1 - wavelet.noiseRatio, 0, 1);
    return clamp((z / 3) * 60 + signalClarity * 40, 0, 100);
}

function scoreTransferEntropy(entropy: TransferEntropyResult): number {
    const flow = clamp(Math.abs(entropy.netFlow), 0, 1);
    const strength = clamp((entropy.te_1_to_2 + entropy.te_2_to_1) / 0.2, 0, 1);
    return clamp(flow * 70 + strength * 30, 0, 100);
}

function formatSigned(value: number, decimals: number): string {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(decimals)}`;
}

export class PairCombinerManager {
    private searchInitialized = false;
    private isLoadingSecondary = false;
    private isAnalyzing = false;
    private secondaryDisplayName: string | null = null;

    private searchInput: HTMLInputElement | null = null;
    private searchResults: HTMLElement | null = null;
    private searchSpinner: HTMLElement | null = null;
    private searchClear: HTMLButtonElement | null = null;
    private searchLoading: HTMLElement | null = null;
    private searchEmpty: HTMLElement | null = null;
    private analyzeButton: HTMLButtonElement | null = null;
    private clearButton: HTMLButtonElement | null = null;
    private linkIntervalToggle: HTMLInputElement | null = null;
    private intervalSelect: HTMLSelectElement | null = null;
    private primaryIntervalLabel: HTMLElement | null = null;
    private selectedSymbolLabel: HTMLElement | null = null;
    private selectedIntervalLabel: HTMLElement | null = null;
    private statusLabel: HTMLElement | null = null;
    private warningLabel: HTMLElement | null = null;
    private resultsEmpty: HTMLElement | null = null;
    private resultsContent: HTMLElement | null = null;
    private notesList: HTMLElement | null = null;
    private exportButton: HTMLButtonElement | null = null;
    private scanButton: HTMLButtonElement | null = null;
    private scanStopButton: HTMLButtonElement | null = null;
    private scanStatusLabel: HTMLElement | null = null;
    private scanResults: HTMLElement | null = null;
    private isScanning = false;
    private scanCancelled = false;

    public init() {
        const tab = document.getElementById('paircombinerTab');
        if (!tab) return;

        this.searchInput = document.getElementById('pairSearchInput') as HTMLInputElement | null;
        this.searchResults = document.getElementById('pairSearchResults');
        this.searchSpinner = document.getElementById('pairSearchSpinner');
        this.searchClear = document.getElementById('pairSearchClear') as HTMLButtonElement | null;
        this.searchLoading = document.getElementById('pairSearchLoading');
        this.searchEmpty = document.getElementById('pairSearchEmpty');
        this.analyzeButton = document.getElementById('pairAnalyzeBtn') as HTMLButtonElement | null;
        this.clearButton = document.getElementById('pairClearBtn') as HTMLButtonElement | null;
        this.linkIntervalToggle = document.getElementById('pairLinkInterval') as HTMLInputElement | null;
        this.intervalSelect = document.getElementById('pairIntervalSelect') as HTMLSelectElement | null;
        this.primaryIntervalLabel = document.getElementById('pairPrimaryInterval');
        this.selectedSymbolLabel = document.getElementById('pairSelectedSymbol');
        this.selectedIntervalLabel = document.getElementById('pairSelectedInterval');
        this.statusLabel = document.getElementById('pairStatus');
        this.warningLabel = document.getElementById('pairWarning');
        this.resultsEmpty = document.getElementById('pairResultsEmpty');
        this.resultsContent = document.getElementById('pairResultsContent');
        this.notesList = document.getElementById('pairNotes');
        this.exportButton = document.getElementById('pairExportBtn') as HTMLButtonElement | null;
        this.scanButton = document.getElementById('pairScanBtn') as HTMLButtonElement | null;
        this.scanStopButton = document.getElementById('pairScanStopBtn') as HTMLButtonElement | null;
        this.scanStatusLabel = document.getElementById('pairScanStatus');
        this.scanResults = document.getElementById('pairScanResults');

        this.setupIntervalSelect();
        this.updateIntervalLabels();
        this.updateSelectedDisplay();
        this.setupSearchHandlers();
        this.setupActionHandlers();
        this.setupStateSubscriptions();
    }

    private setupIntervalSelect() {
        if (!this.intervalSelect) return;
        this.intervalSelect.innerHTML = '';
        DEFAULT_INTERVALS.forEach(interval => {
            const option = document.createElement('option');
            option.value = interval;
            option.textContent = interval.toUpperCase();
            this.intervalSelect?.appendChild(option);
        });
        if (!DEFAULT_INTERVALS.includes(state.currentInterval)) {
            const option = document.createElement('option');
            option.value = state.currentInterval;
            option.textContent = state.currentInterval.toUpperCase();
            this.intervalSelect.appendChild(option);
        }
        this.intervalSelect.value = state.currentInterval;
        this.intervalSelect.disabled = true;
    }

    private setupStateSubscriptions() {
        state.subscribe('currentInterval', () => {
            this.updateIntervalLabels();
            if (this.linkIntervalToggle?.checked) {
                if (this.intervalSelect) {
                    const exists = Array.from(this.intervalSelect.options).some(option => option.value === state.currentInterval);
                    if (!exists) {
                        const option = document.createElement('option');
                        option.value = state.currentInterval;
                        option.textContent = state.currentInterval.toUpperCase();
                        this.intervalSelect.appendChild(option);
                    }
                    this.intervalSelect.value = state.currentInterval;
                }
                state.set('secondaryInterval', state.currentInterval);
                this.selectedIntervalLabel && (this.selectedIntervalLabel.textContent = state.currentInterval);
            }
            if (state.secondarySymbol) {
                this.setStatus('Primary interval changed. Reload secondary or re-run analysis.', 'warning');
                this.clearResults();
                chartManager.removeSecondaryPairLine();
                state.set('secondaryOhlcvData', []);
                state.set('pairCombinerEnabled', false);
            }
        });

        state.subscribe('currentSymbol', () => {
            this.updateIntervalLabels();
            if (state.secondarySymbol) {
                this.setStatus('Primary symbol changed. Re-run analysis for accurate results.', 'warning');
                this.clearResults();
                chartManager.removeSecondaryPairLine();
                state.set('secondaryOhlcvData', []);
                state.set('pairCombinerEnabled', false);
            }
        });
    }

    private updateIntervalLabels() {
        if (this.primaryIntervalLabel) {
            this.primaryIntervalLabel.textContent = state.currentInterval;
        }
    }

    private setupSearchHandlers() {
        if (!this.searchInput || !this.searchResults) return;

        const debouncedSearch = debounce(async (query: string) => {
            this.searchSpinner?.classList.remove('is-hidden');
            try {
                const results = await assetSearchService.searchAssets(query, 20);
                this.renderSearchResults(results, query);
            } catch (error) {
                console.error('Pair search failed:', error);
                this.searchEmpty?.classList.remove('is-hidden');
            } finally {
                this.searchSpinner?.classList.add('is-hidden');
            }
        }, 250);

        const initializeSearch = async () => {
            if (this.searchInitialized) return;
            this.searchInitialized = true;
            this.searchLoading?.classList.remove('is-hidden');

            try {
                const popularAssets = await assetSearchService.searchAssets('', 20);
                this.renderSearchResults(popularAssets);
            } catch (error) {
                console.error('Failed to initialize pair search:', error);
            } finally {
                this.searchLoading?.classList.add('is-hidden');
            }
        };

        this.searchInput.addEventListener('focus', () => {
            initializeSearch();
        });

        this.searchInput.addEventListener('input', (e) => {
            const query = (e.target as HTMLInputElement).value;
            if (query) {
                this.searchClear?.classList.remove('is-hidden');
            } else {
                this.searchClear?.classList.add('is-hidden');
            }
            debouncedSearch(query);
        });

        this.searchClear?.addEventListener('click', () => {
            if (!this.searchInput) return;
            this.searchInput.value = '';
            this.searchInput.focus();
            this.searchClear?.classList.add('is-hidden');
            debouncedSearch('');
        });

        initializeSearch();
    }

    private setupActionHandlers() {
        this.analyzeButton?.addEventListener('click', () => {
            void this.runAnalysis();
        });

        this.clearButton?.addEventListener('click', () => {
            this.clearSecondaryPair();
        });

        this.exportButton?.addEventListener('click', () => {
            this.exportResults();
        });

        this.scanButton?.addEventListener('click', () => {
            void this.runBatchScan();
        });

        this.scanStopButton?.addEventListener('click', () => {
            this.stopBatchScan();
        });

        this.linkIntervalToggle?.addEventListener('change', () => {
            const isLinked = this.linkIntervalToggle?.checked ?? true;
            if (this.intervalSelect) {
                this.intervalSelect.disabled = isLinked;
            }
            if (isLinked) {
                state.set('secondaryInterval', state.currentInterval);
                if (this.intervalSelect) this.intervalSelect.value = state.currentInterval;
                this.selectedIntervalLabel && (this.selectedIntervalLabel.textContent = state.currentInterval);
            } else if (this.intervalSelect) {
                state.set('secondaryInterval', this.intervalSelect.value);
                this.selectedIntervalLabel && (this.selectedIntervalLabel.textContent = this.intervalSelect.value);
            }
        });

        this.intervalSelect?.addEventListener('change', () => {
            if (this.linkIntervalToggle?.checked) return;
            state.set('secondaryInterval', this.intervalSelect?.value ?? state.currentInterval);
            this.selectedIntervalLabel && (this.selectedIntervalLabel.textContent = this.intervalSelect?.value ?? state.currentInterval);
        });
    }

    private renderSearchResults(assets: Asset[], query: string = '') {
        if (!this.searchResults) return;

        const existingItems = this.searchResults.querySelectorAll('.symbol-search-item, .symbol-search-results-header');
        existingItems.forEach(item => item.remove());

        this.searchLoading?.classList.add('is-hidden');
        this.searchEmpty?.classList.add('is-hidden');

        if (assets.length === 0) {
            this.searchEmpty?.classList.remove('is-hidden');
            return;
        }

        const header = document.createElement('div');
        header.className = 'symbol-search-results-header';
        header.textContent = query ? `Results for "${query}"` : 'Popular Assets';
        this.searchResults.insertBefore(header, this.searchResults.firstChild);

        assets.forEach(asset => {
            const item = document.createElement('div');
            item.className = 'symbol-search-item';
            item.dataset.symbol = asset.symbol;
            item.role = 'button';
            item.tabIndex = 0;

            if (asset.symbol === state.secondarySymbol) {
                item.classList.add('active');
            }

            const badgeClass = asset.type === 'crypto' ? 'crypto' :
                asset.type === 'stock' ? 'stock' :
                    asset.type === 'forex' ? 'forex' : 'commodity';

            const iconText = asset.baseAsset?.substring(0, 3) || asset.symbol.substring(0, 3);
            const badgeText = asset.type === 'crypto' ? 'Crypto' :
                asset.type === 'stock' ? 'Stock' :
                    asset.type === 'forex' ? 'Forex' : 'Commodity';

            item.innerHTML = `
                <div class="symbol-item-icon">${iconText}</div>
                <div class="symbol-item-details">
                    <div class="symbol-item-name">
                        ${asset.displayName}
                        <span class="symbol-item-badge ${badgeClass}">${badgeText}</span>
                    </div>
                    <div class="symbol-item-pair">${asset.symbol}</div>
                </div>
            `;

            item.addEventListener('click', () => this.selectSecondarySymbol(asset));
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.selectSecondarySymbol(asset);
                }
            });

            const insertBeforeTarget = this.searchLoading ?? null;
            this.searchResults?.insertBefore(item, insertBeforeTarget);
        });
    }

    private selectSecondarySymbol(asset: Asset) {
        this.secondaryDisplayName = asset.displayName;
        if (asset.symbol !== state.secondarySymbol) {
            debugLogger.event('pairCombiner.secondary.select', { symbol: asset.symbol });
            state.set('secondarySymbol', asset.symbol);
            this.clearResults();
        }
        this.updateSelectedDisplay();
        void this.loadSecondaryPair(asset.symbol);
    }

    private updateSelectedDisplay() {
        if (this.selectedSymbolLabel) {
            if (!state.secondarySymbol) {
                this.selectedSymbolLabel.textContent = 'None selected';
            } else {
                const display = this.secondaryDisplayName || state.secondarySymbol;
                this.selectedSymbolLabel.textContent = display;
            }
        }

        if (this.selectedIntervalLabel) {
            const interval = state.secondaryInterval || state.currentInterval;
            this.selectedIntervalLabel.textContent = interval;
        }
    }

    private async loadSecondaryPair(symbol: string, options?: { skipOverlay?: boolean }) {
        if (this.isLoadingSecondary) return;
        const interval = this.getSecondaryInterval();
        if (!interval) return;

        this.hideWarning();

        if (state.secondarySymbol === symbol && state.secondaryInterval === interval && state.secondaryOhlcvData.length > 0) {
            this.setStatus('Secondary pair already loaded.', 'success');
            return;
        }

        this.isLoadingSecondary = true;
        this.setStatus('Loading secondary pair data...', 'loading');
        this.toggleAnalyzeButton(true);

        try {
            const data = await assetSearchService.getAssetInfo(symbol);
            if (!data) {
                uiManager.showToast('Unknown symbol. Please select a valid asset.', 'error');
                return;
            }
            if (!this.secondaryDisplayName) {
                this.secondaryDisplayName = data.displayName;
            }

            state.set('secondaryInterval', interval);
            const series = await dataManager.fetchData(symbol, interval);
            let alignedSecondary = series;
            let alignedBars = series.length;
            let hasOverlap = true;
            if (state.ohlcvData.length > 0) {
                const aligned = alignPairData(state.ohlcvData, series);
                if (aligned.secondary.length > 0) {
                    alignedSecondary = aligned.secondary;
                    alignedBars = aligned.secondary.length;
                } else {
                    hasOverlap = false;
                    alignedSecondary = [];
                    alignedBars = 0;
                }
            }
            state.set('secondaryOhlcvData', alignedSecondary);
            state.set('pairCombinerEnabled', true);

            const alignmentNote = alignedBars !== series.length
                ? `Aligned ${alignedBars} bars`
                : `${alignedBars} bars`;
            const statusType = hasOverlap ? 'success' : 'warning';
            this.setStatus(`Loaded ${symbol} (${interval}) • ${alignmentNote}`, statusType);
            this.updateSelectedDisplay();

            if (alignedSecondary.length > 0) {
                if (!options?.skipOverlay) {
                    chartManager.addSecondaryPairLine(alignedSecondary, 'rgba(246, 195, 67, 0.9)');
                }
            } else if (state.ohlcvData.length > 0) {
                this.showWarning('No overlapping timestamps found. Check interval alignment.');
                chartManager.removeSecondaryPairLine();
            }
        } catch (error) {
            console.error('Failed to load secondary pair:', error);
            uiManager.showToast('Failed to load secondary pair data.', 'error');
            this.setStatus('Failed to load secondary pair.', 'error');
        } finally {
            this.isLoadingSecondary = false;
            this.toggleAnalyzeButton(false);
        }
    }

    public async runAnalysis() {
        if (this.isAnalyzing) return;
        if (!state.secondarySymbol) {
            uiManager.showToast('Select a secondary pair first.', 'error');
            return;
        }

        if (state.secondaryOhlcvData.length === 0) {
            await this.loadSecondaryPair(state.secondarySymbol, { skipOverlay: true });
        }

        if (state.secondaryOhlcvData.length === 0 || state.ohlcvData.length === 0) {
            uiManager.showToast('Not enough data to analyze.', 'error');
            return;
        }

        const methods = this.getSelectedMethods();
        if (methods.length === 0) {
            uiManager.showToast('Select at least one analysis method.', 'error');
            return;
        }

        this.isAnalyzing = true;
        this.setStatus('Running analysis...', 'loading');
        this.toggleAnalyzeButton(true);

        try {
            const aligned = alignPairData(state.ohlcvData, state.secondaryOhlcvData);
            const MIN_BARS = 30;
            if (aligned.primary.length < MIN_BARS) {
                uiManager.showToast(`Need at least ${MIN_BARS} aligned bars.`, 'error');
                this.setStatus(`Need at least ${MIN_BARS} aligned bars (got ${aligned.primary.length}).`, 'warning');
                this.clearResults();
                return;
            }

            const analysisWindow = aligned.primary.length > 12000 ? 12000 : aligned.primary.length;
            const trimmedPrimary = aligned.primary.slice(-analysisWindow);
            const trimmedSecondary = aligned.secondary.slice(-analysisWindow);
            const trimmedSpread = aligned.spread.slice(-analysisWindow);
            const trimmedTimestamps = aligned.alignedTimestamps.slice(-analysisWindow);

            if (aligned.primary.length > 12000) {
                this.showWarning(`Using the most recent ${analysisWindow} bars to keep calculations fast.`);
            } else if (this.isCrossProvider(state.currentSymbol, state.secondarySymbol)) {
                this.showWarning('Cross-provider pairs may have timestamp alignment gaps.');
            } else if (aligned.alignmentStats.matchRate < 0.85) {
                this.showWarning(`Alignment match rate ${(aligned.alignmentStats.matchRate * 100).toFixed(1)}% (${aligned.alignmentStats.primaryMissing} primary, ${aligned.alignmentStats.secondaryMissing} secondary missing).`);
            } else {
                this.hideWarning();
            }

            const closes1 = trimmedPrimary.map(d => d.close);
            const closes2 = trimmedSecondary.map(d => d.close);
            const returns1 = calculateReturns(closes1);
            const returns2 = calculateReturns(closes2);
            const correlation = pearsonCorrelation(returns1, returns2);

            const spreadMean = mean(trimmedSpread);
            const spreadStd = std(trimmedSpread, spreadMean);
            const spreadZScore = spreadStd > 0
                ? (trimmedSpread[trimmedSpread.length - 1] - spreadMean) / spreadStd
                : 0;

            const ratioSeries = trimmedPrimary.map((bar, idx) => {
                const second = trimmedSecondary[idx]?.close ?? 0;
                return second > 0 ? bar.close / second : 0;
            });

            let copula: CopulaResult | undefined;
            let wavelet: WaveletResult | undefined;
            let transferEntropy: TransferEntropyResult | undefined;

            if (methods.includes('copula')) {
                copula = calculateCopulaDependence(returns1, returns2, undefined, trimmedTimestamps.slice(1));
            }
            if (methods.includes('wavelet')) {
                wavelet = waveletDecompose(trimmedSpread, 'db4', 4);
            }
            if (methods.includes('transferEntropy')) {
                transferEntropy = calculateTransferEntropy(returns1, returns2, 2, 8);
            }

            const methodScores: number[] = [];
            if (copula) methodScores.push(copula.opportunityScore);
            if (wavelet) methodScores.push(scoreWavelet(wavelet));
            if (transferEntropy) methodScores.push(scoreTransferEntropy(transferEntropy));
            const methodAverage = methodScores.length > 0
                ? methodScores.reduce((sum, score) => sum + score, 0) / methodScores.length
                : 0;

            const spreadOpportunity = clamp((Math.min(3, Math.abs(spreadZScore)) / 3) * 100, 0, 100);
            const overallOpportunity = Math.round(spreadOpportunity * 0.6 + methodAverage * 0.4);

            const result: PairAnalysisResults = {
                primarySymbol: state.currentSymbol,
                secondarySymbol: state.secondarySymbol,
                interval: this.getSecondaryInterval() || state.currentInterval,
                alignedBars: trimmedPrimary.length,
                correlation,
                spreadMean,
                spreadStd,
                spreadZScore,
                ratio: ratioSeries[ratioSeries.length - 1] ?? 0,
                opportunityScore: overallOpportunity,
                generatedAt: Date.now(),
                copula,
                wavelet,
                transferEntropy,
                notes: this.buildNotes(spreadZScore, correlation, transferEntropy),
            };

            state.set('pairAnalysisResults', result);
            this.renderResults(result, methods);

            const divergenceUpper = trimmedSpread.map(() => spreadMean + 2 * spreadStd);
            const divergenceLower = trimmedSpread.map(() => spreadMean - 2 * spreadStd);
            chartManager.addSecondaryPairLine(trimmedSecondary, 'rgba(100, 181, 246, 0.7)');
            chartManager.displaySpreadSeries(trimmedSpread, trimmedTimestamps);
            chartManager.displayDivergenceBands(divergenceUpper, divergenceLower, trimmedTimestamps);
            this.setStatus('Analysis complete.', 'success');
        } catch (error) {
            console.error('Pair analysis failed:', error);
            uiManager.showToast('Pair analysis failed. Check console.', 'error');
            this.setStatus('Analysis failed.', 'error');
        } finally {
            this.isAnalyzing = false;
            this.toggleAnalyzeButton(false);
        }
    }

    private buildNotes(
        spreadZ: number,
        correlation: number,
        entropy?: TransferEntropyResult
    ): string[] {
        const notes: string[] = [];
        const z = spreadZ;
        if (Math.abs(z) >= 2) {
            notes.push(`Spread Z-score ${formatSigned(z, 2)}σ: consider mean-reversion entry.`);
        } else if (Math.abs(z) >= 1) {
            notes.push(`Spread Z-score ${formatSigned(z, 2)}σ: divergence building.`);
        } else {
            notes.push('Spread is near its mean; low divergence right now.');
        }

        if (Math.abs(correlation) >= 0.7) {
            notes.push(`Returns correlation is strong (${formatSigned(correlation, 2)}).`);
        } else if (Math.abs(correlation) >= 0.4) {
            notes.push(`Returns correlation is moderate (${formatSigned(correlation, 2)}).`);
        } else {
            notes.push(`Returns correlation is weak (${formatSigned(correlation, 2)}).`);
        }

        if (entropy && Math.abs(entropy.netFlow) > 0.1) {
            const leader = entropy.leadingAsset === 'primary' ? 'Primary' : 'Secondary';
            notes.push(`${leader} leads by ~${entropy.lagBars} bars: monitor for follow-through.`);
        }

        return notes;
    }

    private renderResults(result: PairAnalysisResults, methods: AnalysisMethod[]) {
        this.resultsEmpty?.classList.add('is-hidden');
        this.resultsContent?.classList.remove('is-hidden');

        this.setValue('pairOpportunityScore', `${result.opportunityScore}%`, this.scoreClass(result.opportunityScore));
        this.setValue('pairCorrelationValue', result.correlation.toFixed(3), this.signedClass(result.correlation));
        this.setValue('pairSpreadZValue', formatSigned(result.spreadZScore, 2), this.signedClass(result.spreadZScore));
        this.setValue('pairRatioValue', result.ratio.toFixed(4));
        this.setValue('pairAlignedBars', result.alignedBars.toString());

        this.toggleSection('pairCopulaSection', methods.includes('copula'));
        this.toggleSection('pairWaveletSection', methods.includes('wavelet'));
        this.toggleSection('pairEntropySection', methods.includes('transferEntropy'));

        if (result.copula) {
            this.setValue('pairCopulaTau', result.copula.kendallTau.toFixed(3), this.signedClass(result.copula.kendallTau));
            this.setValue('pairCopulaUpper', result.copula.tailDependence.upper.toFixed(2));
            this.setValue('pairCopulaLower', result.copula.tailDependence.lower.toFixed(2));
            this.setValue('pairCopulaType', result.copula.copulaType);
            this.setValue('pairCopulaScore', `${Math.round(result.copula.opportunityScore)}%`, this.scoreClass(result.copula.opportunityScore));
        }

        if (result.wavelet) {
            this.setValue('pairWaveletCycle', `${result.wavelet.dominantCycle} bars`);
            this.setValue('pairWaveletNoise', `${Math.round(result.wavelet.noiseRatio * 100)}%`);
            this.setValue('pairWaveletSpreadZ', formatSigned(result.wavelet.spreadZScore, 2), this.signedClass(result.wavelet.spreadZScore));
            this.setValue('pairWaveletSignal', `${Math.round(scoreWavelet(result.wavelet))}%`, this.scoreClass(scoreWavelet(result.wavelet)));
        }

        if (result.transferEntropy) {
            this.setValue('pairEntropy12', result.transferEntropy.te_1_to_2.toFixed(4));
            this.setValue('pairEntropy21', result.transferEntropy.te_2_to_1.toFixed(4));
            this.setValue('pairEntropyNet', formatSigned(result.transferEntropy.netFlow, 2), this.signedClass(result.transferEntropy.netFlow));
            this.setValue('pairEntropyLeader', result.transferEntropy.leadingAsset);
            this.setValue('pairEntropyLag', `${result.transferEntropy.lagBars} bars`);
            this.setValue('pairEntropySignificance', `${Math.round(result.transferEntropy.significance * 100)}%`);
        }

        if (this.notesList) {
            this.notesList.innerHTML = '';
            result.notes?.forEach(note => {
                const li = document.createElement('li');
                li.textContent = note;
                this.notesList?.appendChild(li);
            });
        }
    }

    private setValue(id: string, value: string, className?: string) {
        const element = document.getElementById(id);
        if (!element) return;
        element.textContent = value;
        if (className) {
            element.className = className;
        }
    }

    private scoreClass(score: number): string {
        if (score >= 70) return 'stat-value text-green';
        if (score >= 40) return 'stat-value text-warning';
        return 'stat-value text-secondary';
    }

    private signedClass(value: number): string {
        if (value > 0) return 'stat-value positive';
        if (value < 0) return 'stat-value negative';
        return 'stat-value';
    }

    private toggleSection(id: string, visible: boolean) {
        const element = document.getElementById(id);
        if (!element) return;
        element.style.display = visible ? 'block' : 'none';
    }

    private getSecondaryInterval(): string | null {
        if (this.linkIntervalToggle?.checked) return state.currentInterval;
        return this.intervalSelect?.value ?? state.secondaryInterval ?? state.currentInterval;
    }

    private getSelectedMethods(): AnalysisMethod[] {
        const methods: AnalysisMethod[] = [];
        const copula = document.getElementById('pairMethodCopula') as HTMLInputElement | null;
        const wavelet = document.getElementById('pairMethodWavelet') as HTMLInputElement | null;
        const entropy = document.getElementById('pairMethodEntropy') as HTMLInputElement | null;

        if (copula?.checked) methods.push('copula');
        if (wavelet?.checked) methods.push('wavelet');
        if (entropy?.checked) methods.push('transferEntropy');

        return methods;
    }

    private setStatus(message: string, type: 'loading' | 'success' | 'error' | 'warning' | 'info' = 'info') {
        if (!this.statusLabel) return;
        this.statusLabel.textContent = message;
        this.statusLabel.className = `pair-status ${type}`;
    }

    private showWarning(message: string) {
        if (!this.warningLabel) return;
        this.warningLabel.textContent = message;
        this.warningLabel.classList.remove('is-hidden');
    }

    private hideWarning() {
        this.warningLabel?.classList.add('is-hidden');
    }

    private toggleAnalyzeButton(isLoading: boolean) {
        if (!this.analyzeButton) return;
        this.analyzeButton.disabled = isLoading;
        this.analyzeButton.classList.toggle('is-loading', isLoading);
    }

    private setScanStatus(message: string) {
        if (this.scanStatusLabel) {
            this.scanStatusLabel.textContent = message;
        }
    }

    private toggleScanButtons(isScanning: boolean) {
        if (this.scanButton) this.scanButton.disabled = isScanning;
        if (this.scanStopButton) {
            this.scanStopButton.classList.toggle('is-hidden', !isScanning);
        }
    }

    private clearResults() {
        state.set('pairAnalysisResults', null);
        this.resultsContent?.classList.add('is-hidden');
        this.resultsEmpty?.classList.remove('is-hidden');
        this.notesList && (this.notesList.innerHTML = '');
    }

    public clearSecondaryPair() {
        state.set('secondarySymbol', null);
        state.set('secondaryInterval', null);
        state.set('secondaryOhlcvData', []);
        state.set('pairCombinerEnabled', false);
        this.secondaryDisplayName = null;
        this.updateSelectedDisplay();
        this.setStatus('Secondary pair cleared.', 'info');
        this.hideWarning();
        this.clearResults();
        chartManager.removeSecondaryPairLine();
        chartManager.displaySpreadSeries([], []);
        chartManager.displayDivergenceBands([], []);
    }

    private isCrossProvider(primary: string, secondary: string): boolean {
        const primaryProvider = assetSearchService.getProvider(primary);
        const secondaryProvider = assetSearchService.getProvider(secondary);
        return primaryProvider !== secondaryProvider;
    }

    private exportResults() {
        const results = state.pairAnalysisResults;
        if (!results) {
            uiManager.showToast('Run analysis before exporting.', 'error');
            return;
        }

        const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `pair-analysis-${results.primarySymbol}-${results.secondarySymbol}-${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    private stopBatchScan() {
        this.scanCancelled = true;
        this.setScanStatus('Stopping...');
    }

    private async runBatchScan() {
        if (this.isScanning) return;
        if (state.ohlcvData.length === 0) {
            uiManager.showToast('Load primary data before scanning.', 'error');
            return;
        }

        const interval = this.getSecondaryInterval() || state.currentInterval;
        const provider = assetSearchService.getProvider(state.currentSymbol);
        const minAlignedBars = interval.includes('m') ? 300 : 80;
        const thresholds = {
            minAlignedBars,
            minMatchRate: 0.85,
            minAbsZ: 2.0,
            minOpportunity: 65,
            minWaveletScore: 70,
            minEntropySignificance: 0.5,
        };

        this.isScanning = true;
        this.scanCancelled = false;
        this.toggleScanButtons(true);
        this.setScanStatus('Preparing scan...');
        this.renderScanResults([]);

        try {
            const symbols = await this.getScanUniverse(provider, 100, state.currentSymbol);
            const total = symbols.length;
            const results: PairAnalysisResults[] = [];
            let processed = 0;

            for (const symbol of symbols) {
                if (this.scanCancelled) break;
                processed++;
                this.setScanStatus(`Scanning ${processed}/${total} (${symbol})...`);

                try {
                    const secondaryData = await dataManager.fetchData(symbol, interval);
                    const aligned = alignPairData(state.ohlcvData, secondaryData);
                    if (aligned.primary.length < thresholds.minAlignedBars) continue;
                    if (aligned.alignmentStats.matchRate < thresholds.minMatchRate) continue;

                    const analysisWindow = aligned.primary.length > 12000 ? 12000 : aligned.primary.length;
                    const trimmedPrimary = aligned.primary.slice(-analysisWindow);
                    const trimmedSecondary = aligned.secondary.slice(-analysisWindow);
                    const trimmedSpread = aligned.spread.slice(-analysisWindow);

                    const closes1 = trimmedPrimary.map(d => d.close);
                    const closes2 = trimmedSecondary.map(d => d.close);
                    const returns1 = calculateReturns(closes1);
                    const returns2 = calculateReturns(closes2);
                    const correlation = pearsonCorrelation(returns1, returns2);

                    const spreadMean = mean(trimmedSpread);
                    const spreadStd = std(trimmedSpread, spreadMean);
                    const spreadZScore = spreadStd > 0
                        ? (trimmedSpread[trimmedSpread.length - 1] - spreadMean) / spreadStd
                        : 0;

                    const copula = calculateCopulaDependence(returns1, returns2);
                    const wavelet = waveletDecompose(trimmedSpread, 'db4', 4);
                    const transferEntropy = calculateTransferEntropy(returns1, returns2, 2, 8);

                    const methodScores: number[] = [];
                    methodScores.push(copula.opportunityScore);
                    methodScores.push(scoreWavelet(wavelet));
                    methodScores.push(scoreTransferEntropy(transferEntropy));
                    const methodAverage = methodScores.reduce((sum, score) => sum + score, 0) / methodScores.length;
                    const spreadOpportunity = clamp((Math.min(3, Math.abs(spreadZScore)) / 3) * 100, 0, 100);
                    const overallOpportunity = Math.round(spreadOpportunity * 0.6 + methodAverage * 0.4);

                    if (Math.abs(spreadZScore) < thresholds.minAbsZ) continue;
                    if (overallOpportunity < thresholds.minOpportunity) continue;
                    if (scoreWavelet(wavelet) < thresholds.minWaveletScore) continue;
                    if (transferEntropy.significance < thresholds.minEntropySignificance) continue;

                    const ratioSeries = trimmedPrimary.map((bar, idx) => {
                        const second = trimmedSecondary[idx]?.close ?? 0;
                        return second > 0 ? bar.close / second : 0;
                    });

                    const result: PairAnalysisResults = {
                        primarySymbol: state.currentSymbol,
                        secondarySymbol: symbol,
                        interval,
                        alignedBars: trimmedPrimary.length,
                        correlation,
                        spreadMean,
                        spreadStd,
                        spreadZScore,
                        ratio: ratioSeries[ratioSeries.length - 1] ?? 0,
                        opportunityScore: overallOpportunity,
                        generatedAt: Date.now(),
                        copula,
                        wavelet,
                        transferEntropy,
                        notes: this.buildNotes(spreadZScore, correlation, transferEntropy),
                    };

                    results.push(result);
                } catch (error) {
                    console.warn('Batch scan failed for symbol', symbol, error);
                }
            }

            const sorted = results.sort((a, b) => b.opportunityScore - a.opportunityScore);
            this.renderScanResults(sorted.slice(0, 20));
            const status = this.scanCancelled ? 'Scan stopped.' : `Scan complete. ${sorted.length} matches.`;
            this.setScanStatus(status);
        } catch (error) {
            console.error('Batch scan failed:', error);
            this.setScanStatus('Scan failed.');
        } finally {
            this.isScanning = false;
            this.toggleScanButtons(false);
            this.scanCancelled = false;
        }
    }

    private async getScanUniverse(
        provider: 'binance' | 'bybit-tradfi' | 'twelvedata' | 'mock',
        limit: number,
        primarySymbol: string
    ): Promise<string[]> {
        if (provider === 'binance') {
            const symbols = await binanceSearchService.getAllSymbols();
            return symbols
                .filter(sym => sym.quoteAsset === 'USDT' && sym.symbol !== primarySymbol)
                .slice(0, limit)
                .map(sym => sym.symbol);
        }

        const assets = await assetSearchService.searchAssets('', limit + 5);
        return assets
            .filter(asset => asset.provider === provider && asset.symbol !== primarySymbol)
            .slice(0, limit)
            .map(asset => asset.symbol);
    }

    private renderScanResults(results: PairAnalysisResults[]) {
        if (!this.scanResults) return;
        if (results.length === 0) {
            this.scanResults.innerHTML = '<div class="pair-scan-empty">Run a scan to see ranked opportunities.</div>';
            return;
        }

        const rows = results.map((result, index) => {
            const scoreClass = this.scoreClass(result.opportunityScore);
            const correlationClass = this.signedClass(result.correlation);
            const spreadClass = this.signedClass(result.spreadZScore);
            const highlight = index < 5 ? 'pair-scan-row-highlight' : '';
            const leader = result.transferEntropy?.leadingAsset ?? 'neutral';
            return `
                <tr class="${highlight}">
                    <td>${index + 1}</td>
                    <td>${result.secondarySymbol}</td>
                    <td class="${scoreClass}">${result.opportunityScore}%</td>
                    <td class="${spreadClass}">${formatSigned(result.spreadZScore, 2)}</td>
                    <td class="${correlationClass}">${result.correlation.toFixed(2)}</td>
                    <td>${leader}</td>
                    <td>${result.alignedBars}</td>
                </tr>
            `;
        }).join('');

        this.scanResults.innerHTML = `
            <table class="pair-scan-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Pair</th>
                        <th>Opp</th>
                        <th>Spread Z</th>
                        <th>Corr</th>
                        <th>Leader</th>
                        <th>Bars</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `;
    }

}

export const pairCombinerManager = new PairCombinerManager();
