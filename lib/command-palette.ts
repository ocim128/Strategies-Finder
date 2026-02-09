import { state } from "./state";
import { strategyRegistry, getStrategyList } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { clearAll } from "./app-actions";
import { debugLogger } from "./debug-logger";

interface CommandItem {
    id: string;
    title: string;
    subtitle?: string;
    icon: string;
    category: 'Strategy' | 'Navigation' | 'Action' | 'Symbol';
    action: () => void;
    shortcut?: string;
}

export class CommandPaletteManager {
    private overlay: HTMLElement | null = null;
    private input: HTMLInputElement | null = null;
    private resultsContainer: HTMLElement | null = null;
    private items: CommandItem[] = [];
    private selectedIndex: number = 0;
    private filteredItems: CommandItem[] = [];

    constructor() {
        this.init();
    }

    private init() {
        if (typeof document === 'undefined') return;

        this.createElements();
        this.setupListeners();
        this.refreshItems();
    }

    private createElements() {
        const html = `
            <div class="command-palette-overlay" id="commandPaletteOverlay">
                <div class="command-palette">
                    <div class="command-palette-input-wrapper">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="11" cy="11" r="8"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        </svg>
                        <input type="text" class="command-palette-input" id="commandPaletteInput" placeholder="Search strategies, symbols, or commands..." autocomplete="off">
                    </div>
                    <div class="command-palette-results" id="commandPaletteResults"></div>
                    <div class="command-palette-footer">
                        <div class="command-palette-shortcut-hint"><kbd>↑↓</kbd> to navigate</div>
                        <div class="command-palette-shortcut-hint"><kbd>Enter</kbd> to select</div>
                        <div class="command-palette-shortcut-hint"><kbd>ESC</kbd> to close</div>
                    </div>
                </div>
            </div>
        `;

        const div = document.createElement('div');
        div.innerHTML = html;
        const paletteElement = div.firstElementChild;
        if (paletteElement) {
            document.body.appendChild(paletteElement);
        }

        this.overlay = document.getElementById('commandPaletteOverlay');
        this.input = document.getElementById('commandPaletteInput') as HTMLInputElement;
        this.resultsContainer = document.getElementById('commandPaletteResults');
    }

    private setupListeners() {
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                this.open();
            }

            if (e.key === 'Escape' && this.isOpen()) {
                this.close();
            }
        });

        this.overlay?.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.close();
            }
        });

        this.input?.addEventListener('input', () => {
            this.filterItems();
        });

        this.input?.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.moveSelection(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.moveSelection(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.executeSelected();
            }
        });
    }

    private refreshItems() {
        const strategies = getStrategyList();
        const symbols = [
            { id: 'BTCUSDT', name: 'Bitcoin' },
            { id: 'ETHUSDT', name: 'Ethereum' },
            { id: 'SOLUSDT', name: 'Solana' },
            { id: 'AAPL', name: 'Apple Inc.' },
            { id: 'TSLA', name: 'Tesla Inc.' },
            { id: 'EURUSD', name: 'Euro / US Dollar' },
            { id: 'XAUUSD', name: 'Gold' },
            { id: 'XAGUSD', name: 'Silver' },
            { id: 'WTIUSD', name: 'WTI Oil' }
        ];

        const tabs = [
            { id: 'settings', name: 'Settings', icon: 'settings' },
            { id: 'finder', name: 'Strategy Finder', icon: 'search' },
            { id: 'paircombiner', name: 'Pair Combiner', icon: 'compare_arrows' },
            { id: 'walkforward', name: 'Walk-Forward Analysis', icon: 'fast_forward' },
            { id: 'results', name: 'Backtest Results', icon: 'bar_chart' },
            { id: 'trades', name: 'Trade History', icon: 'history' }
        ];

        this.items = [
            // Actions
            {
                id: 'run-backtest',
                title: 'Run Backtest',
                subtitle: 'Execute current strategy' + (state.currentStrategyKey ? `: ${strategyRegistry.get(state.currentStrategyKey)?.name}` : ''),
                icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>',
                category: 'Action',
                shortcut: 'Ctrl+Enter',
                action: () => {
                    backtestService.runCurrentBacktest();
                }
            },
            {
                id: 'clear-results',
                title: 'Clear Session',
                subtitle: 'Clear all trades and results',
                icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>',
                category: 'Action',
                action: () => clearAll()
            },
            {
                id: 'toggle-theme',
                title: 'Toggle Theme',
                subtitle: 'Switch between dark and light mode',
                icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z" /></svg>',
                category: 'Action',
                action: () => state.set('isDarkTheme', !state.isDarkTheme)
            },

            // Navigation
            ...tabs.map(tab => ({
                id: `nav-${tab.id}`,
                title: `Go to ${tab.name}`,
                subtitle: `Switch to ${tab.name} tab`,
                icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z" /></svg>',
                category: 'Navigation' as const,
                action: () => {
                    const tabBtn = document.querySelector(`.panel-tab[data-tab="${tab.id}"]`) as HTMLElement;
                    tabBtn?.click();
                }
            })),

            // Strategies
            ...strategies.map(s => ({
                id: `strat-${s.key}`,
                title: s.name,
                subtitle: s.description,
                icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" /></svg>',
                category: 'Strategy' as const,
                action: () => {
                    const select = document.getElementById('strategySelect') as HTMLSelectElement;
                    if (select) {
                        select.value = s.key;
                        select.dispatchEvent(new Event('change'));
                    }
                }
            })),

            // Symbols
            ...symbols.map(sym => ({
                id: `sym-${sym.id}`,
                title: sym.id,
                subtitle: sym.name,
                icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z" /></svg>',
                category: 'Symbol' as const,
                action: () => {
                    state.set('currentSymbol', sym.id);
                }
            }))
        ];
    }

    private open() {
        this.refreshItems();
        this.overlay?.classList.add('active');
        if (this.input) {
            this.input.value = '';
            this.input.focus();
        }
        this.selectedIndex = 0;
        this.filterItems();
        debugLogger.event('ui.command_palette.open');
    }

    private close() {
        this.overlay?.classList.remove('active');
        debugLogger.event('ui.command_palette.close');
    }

    private isOpen(): boolean {
        return this.overlay?.classList.contains('active') || false;
    }

    private filterItems() {
        const query = this.input?.value.toLowerCase() || '';

        if (!query) {
            this.filteredItems = this.items.slice(0, 10);
        } else {
            this.filteredItems = this.items.filter(item =>
                item.title.toLowerCase().includes(query) ||
                item.subtitle?.toLowerCase().includes(query) ||
                item.category.toLowerCase().includes(query)
            ).slice(0, 15);
        }

        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
        this.renderResults();
    }

    private moveSelection(delta: number) {
        if (this.filteredItems.length === 0) return;
        this.selectedIndex = (this.selectedIndex + delta + this.filteredItems.length) % this.filteredItems.length;
        this.renderResults();

        const selected = this.resultsContainer?.querySelector('.selected') as HTMLElement;
        selected?.scrollIntoView({ block: 'nearest' });
    }

    private executeSelected() {
        const item = this.filteredItems[this.selectedIndex];
        if (item) {
            item.action();
            this.close();
            debugLogger.event('ui.command_palette.execute', { id: item.id });
        }
    }

    private renderResults() {
        if (!this.resultsContainer) return;

        if (this.filteredItems.length === 0) {
            this.resultsContainer.innerHTML = '<div class="empty-state">No results found</div>';
            return;
        }

        let currentCategory = '';
        let html = '';

        this.filteredItems.forEach((item, index) => {
            if (item.category !== currentCategory) {
                currentCategory = item.category;
                html += `<div class="command-palette-group-title">${currentCategory}</div>`;
            }

            const isSelected = index === this.selectedIndex;
            html += `
                <div class="command-palette-item ${isSelected ? 'selected' : ''}" data-index="${index}">
                    <div class="command-palette-item-icon">${item.icon}</div>
                    <div class="command-palette-item-info">
                        <div class="command-palette-item-title">${item.title}</div>
                        ${item.subtitle ? `<div class="command-palette-item-subtitle">${item.subtitle}</div>` : ''}
                    </div>
                    ${item.shortcut ? `<div class="command-palette-item-shortcut">${item.shortcut}</div>` : ''}
                </div>
            `;
        });

        this.resultsContainer.innerHTML = html;

        this.resultsContainer.querySelectorAll('.command-palette-item').forEach(el => {
            el.addEventListener('click', () => {
                this.selectedIndex = parseInt((el as HTMLElement).dataset.index!);
                this.executeSelected();
            });
        });
    }
}

export const commandPaletteManager = new CommandPaletteManager();
