import { state } from "./state";
import { assetSearchService, Asset } from "./assetSearchService";
import { uiManager } from "./uiManager";
import { debugLogger } from "./debugLogger";
import { chartManager } from "./chartManager";
import { dataManager } from "./dataManager";
import { alignPairData } from "./pairCombiner";
import { calculateCopulaDependence } from "./pairCombiner";
import { waveletDecompose } from "./pairCombiner";
import { calculateTransferEntropy } from "./pairCombiner";
import type {
    AnalysisMethod,
    PairAnalysisResults,
    WaveletResult,
    TransferEntropyResult,
    CopulaResult,
} from "./pairCombiner";

const DEFAULT_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function pearsonCorrelation(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    let sumA = 0;
    let sumB = 0;
    let sumA2 = 0;
    let sumB2 = 0;
    let sumAB = 0;

    for (let i = 0; i < n; i++) {
        const x = a[i];
        const y = b[i];
        sumA += x;
        sumB += y;
        sumA2 += x * x;
        sumB2 += y * y;
        sumAB += x * y;
    }

    const numerator = (n * sumAB) - (sumA * sumB);
    const denomA = (n * sumA2) - (sumA * sumA);
    const denomB = (n * sumB2) - (sumB * sumB);
    if (denomA <= 0 || denomB <= 0) return 0;
    return numerator / Math.sqrt(denomA * denomB);
}

function calculateReturns(closes: number[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
        const prev = Math.max(1e-12, closes[i - 1]);
        const current = Math.max(1e-12, closes[i]);
        returns.push(Math.log(current / prev));
    }
    return returns;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function std(values: number[], avg: number): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) {
        const diff = v - avg;
        sum += diff * diff;
    }
    return Math.sqrt(sum / values.length);
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
                chartManager.removeSecondaryPairOverlay();
                state.set('secondaryOhlcvData', []);
                state.set('pairCombinerEnabled', false);
            }
        });

        state.subscribe('currentSymbol', () => {
            this.updateIntervalLabels();
            if (state.secondarySymbol) {
                this.setStatus('Primary symbol changed. Re-run analysis for accurate results.', 'warning');
                this.clearResults();
                chartManager.removeSecondaryPairOverlay();
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

        const debouncedSearch = this.debounce(async (query: string) => {
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

    private async loadSecondaryPair(symbol: string) {
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
                chartManager.addSecondaryPairOverlay(alignedSecondary);
            } else if (state.ohlcvData.length > 0) {
                this.showWarning('No overlapping timestamps found. Check interval alignment.');
                chartManager.removeSecondaryPairOverlay();
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
            await this.loadSecondaryPair(state.secondarySymbol);
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
            if (aligned.primary.length < 20) {
                uiManager.showToast('Pairs have too few overlapping bars.', 'error');
                this.setStatus('Not enough overlapping bars.', 'error');
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
                copula = calculateCopulaDependence(returns1, returns2);
            }
            if (methods.includes('wavelet')) {
                wavelet = waveletDecompose(trimmedSpread, 'haar', 4);
            }
            if (methods.includes('transferEntropy')) {
                transferEntropy = calculateTransferEntropy(returns1, returns2, 1, 8);
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

            chartManager.addSecondaryPairOverlay(trimmedSecondary);
            chartManager.displaySpreadChart(trimmedSpread, trimmedTimestamps);
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
        if (Math.abs(z) >= 1) {
            const direction = z > 0 ? 'primary rich vs secondary' : 'secondary rich vs primary';
            notes.push(`Spread is ${formatSigned(z, 2)} z-score (${direction}).`);
        } else {
            notes.push('Spread is near its mean; low divergence right now.');
        }

        if (Math.abs(correlation) >= 0.6) {
            notes.push(`Returns correlation is strong (${formatSigned(correlation, 2)}).`);
        } else {
            notes.push(`Returns correlation is moderate (${formatSigned(correlation, 2)}).`);
        }

        if (entropy && Math.abs(entropy.netFlow) > 0.1) {
            const leader = entropy.leadingAsset === 'primary' ? 'Primary' : 'Secondary';
            notes.push(`${leader} asset leads flow (lag ~${entropy.lagBars} bars).`);
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
        if (score >= 70) return 'stat-value positive';
        if (score <= 30) return 'stat-value negative';
        return 'stat-value';
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
        chartManager.removeSecondaryPairOverlay();
        chartManager.displaySpreadChart([], []);
    }

    private debounce<T extends (...args: any[]) => void>(fn: T, delay: number): (...args: Parameters<T>) => void {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        return (...args: Parameters<T>) => {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn(...args), delay);
        };
    }
}

export const pairCombinerManager = new PairCombinerManager();
