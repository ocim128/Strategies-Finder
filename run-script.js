const fs = require('fs');
let qv = fs.readFileSync('lib/quick-view.ts', 'utf8');

// 1. Restore QuickViewPolymarketSummary type
const typeSummary = `
type QuickViewPolymarketSummary = {
    wins: number;
    losses: number;
    scoredTrades: number;
    missingTrades: number;
    unscoredTrades: number;
    coverage: number;
    winRate: number;
    expectancy: number | null;
    outcomeRowsLoaded: number;
    bestBaselineWinRate: number;
    baselineDelta: number;
    longestWinStreak: number;
    longestLossStreak: number;
    recentFormTrades: number;
    recentFormWins: number;
    recentFormLosses: number;
    recentFormWinRate: number;
    exitReasonWinRates: {
        maxHold: { trades: number; wins: number; losses: number; winRate: number; };
        takeProfit: { trades: number; wins: number; losses: number; winRate: number; };
        signal: { trades: number; wins: number; losses: number; winRate: number; };
    };
    afterTakeProfitExpectancy: {
        pricedTrades: number;
        expectancy: number | null;
    };
    entryOffset?: number;
    timingProfile?: import("./types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry[];
    bestTimingProfile?: import("./types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry | null;
};\n\n`;
qv = qv.replace('type QuickViewPolymarketPayoutSummary = {', typeSummary + 'type QuickViewPolymarketPayoutSummary = {');

// 2. Restore getPolymarketSummary
const getPolymarketSummaryCode = `
    private getBestTimingProfileEntry(
        timingProfile: readonly import("./types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry[]
    ): import("./types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry | null {
        if (timingProfile.length === 0) return null;
        const scoredEntries = timingProfile.filter((entry) => entry.scoredTrades > 0);
        if (scoredEntries.length === 0) return null;
        return [...scoredEntries].sort((left, right) => {
            if (right.winRate !== left.winRate) return right.winRate - left.winRate;
            if (right.scoredTrades !== left.scoredTrades) return right.scoredTrades - left.scoredTrades;
            return left.entryOffset - right.entryOffset;
        })[0] ?? null;
    }

    private getPolymarketSummary(result: BacktestResult): QuickViewPolymarketSummary | null {
        const wins = result.trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
        const losses = result.trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
        const scoredTrades = wins + losses;
        const summary = result.polymarketTradeSummary;

        if (!summary && scoredTrades === 0) return null;

        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const missingTrades = summary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades);
        const unscoredTrades = summary?.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades);
        const coverageBase = Math.max(0, scoredTrades + unscoredTrades);
        const coverage = coverageBase > 0 ? scoredTrades / coverageBase : 0;
        const bestBaselineWinRate = computePolymarketBestBaselineWinRate(result.trades);
        const timingProfile = summary?.timingProfile;
        const bestTimingProfile = timingProfile ? this.getBestTimingProfileEntry(timingProfile) : null;
        const payoutSummary = summarizePolymarketPayoutDiagnostics(result.trades);
        const streakSummary = summarizePolymarketStreaks(result.trades);
        const recentFormSummary = summarizeRecentPolymarketForm(result.trades, 50);
        const exitReasonWinRates = summarizePolymarketExitReasonWinRates(result.trades);
        const afterTakeProfitExpectancy = summarizePolymarketExpectancyAfterTakeProfit(result.trades);

        return {
            wins, losses, scoredTrades, missingTrades, unscoredTrades, coverage,
            winRate: scoredTrades > 0 ? wins / scoredTrades : 0,
            expectancy: payoutSummary?.expectancy ?? null,
            outcomeRowsLoaded: summary?.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(result.trades),
            bestBaselineWinRate,
            baselineDelta: (scoredTrades > 0 ? wins / scoredTrades : 0) - bestBaselineWinRate,
            longestWinStreak: streakSummary.longestWinStreak,
            longestLossStreak: streakSummary.longestLossStreak,
            recentFormTrades: recentFormSummary.recentFormTrades,
            recentFormWins: recentFormSummary.recentFormWins,
            recentFormLosses: recentFormSummary.recentFormLosses,
            recentFormWinRate: recentFormSummary.recentFormWinRate,
            exitReasonWinRates, afterTakeProfitExpectancy,
            entryOffset: summary?.entryOffset,
            timingProfile, bestTimingProfile,
        };
    }\n\n`;
qv = qv.replace('private fmtPrice(price: number): string {', getPolymarketSummaryCode + '    private fmtPrice(price: number): string {');

// 3. Restore buildPolymarketTimingProfileSection
const buildPolymarketTimingProfileSectionCode = `
    private buildPolymarketTimingProfileSection(summary: QuickViewPolymarketSummary): string {
        const timingProfile = summary.timingProfile ?? [];
        if (timingProfile.length === 0) return '';
        const bestOffset = summary.bestTimingProfile?.entryOffset;
        const rows = timingProfile.map((entry) => \`
            <div class="qv-poly-profile-row \${entry.entryOffset === bestOffset ? 'is-best' : ''} \${entry.entryOffset === summary.entryOffset ? 'is-selected' : ''}">
                <div class="qv-poly-profile-cell qv-poly-profile-cell--offset">Minute \${entry.entryOffset}</div>
                <div class="qv-poly-profile-cell">\${(entry.winRate * 100).toFixed(1)}%</div>
                <div class="qv-poly-profile-cell">\${entry.scoredTrades}</div>
                <div class="qv-poly-profile-cell">\${(entry.coverage * 100).toFixed(1)}%</div>
                <div class="qv-poly-profile-cell">\${entry.duplicateTradesIgnored}</div>
            </div>
        \`).join('');
        return \`
            <div class="qv-stat-card full-width qv-poly-meta-card">
                <div class="qv-stat-label">Entry Timing Profile (1m -> 5m)</div>
                <div class="qv-poly-profile-grid">
                    <div class="qv-poly-profile-row qv-poly-profile-row--header">
                        <div class="qv-poly-profile-cell qv-poly-profile-cell--offset">Offset</div>
                        <div class="qv-poly-profile-cell">Win Rate</div>
                        <div class="qv-poly-profile-cell">Scored</div>
                        <div class="qv-poly-profile-cell">Coverage</div>
                        <div class="qv-poly-profile-cell">Dupes</div>
                    </div>
                    \${rows}
                </div>
            </div>
        \`;
    }\n\n`;
qv = qv.replace('    private getBestTimingProfileEntry', buildPolymarketTimingProfileSectionCode + '    private getBestTimingProfileEntry');

// 4. Restore buildPolymarketSection
const buildPolymarketSectionCode = `
    private buildPolymarketSection(result: BacktestResult): string {
        const summary = this.getPolymarketSummary(result);
        if (!summary) return '';
        const offsetSummary = typeof summary.entryOffset === 'number'
            ? \`Selected Offset: Minute \${summary.entryOffset}\`
            : 'Run Mode: Native 5m scoring';
        const timingProfileSection = summary.timingProfile && summary.timingProfile.length > 0
            ? this.buildPolymarketTimingProfileSection(summary)
            : '';
        const diagnosticsNote = \`
            <div class="qv-stat-card full-width qv-poly-meta-card">
                <div class="qv-stat-label">Detailed Diagnostics</div>
                <div class="qv-diagnostic-hint">Payout summary, timing buckets, snapshot profile, and PM filter suggestions now live in the Polymarket tab for readability.</div>
            </div>
        \`;

        return \`
            <div class="qv-section-title">Polymarket</div>
            <div class="qv-stats-grid">
                <div class="qv-stat-card full-width qv-poly-meta-card">
                    <div class="qv-stat-label">\${offsetSummary}</div>
                    <div class="qv-stat-value">\${summary.bestTimingProfile ? \`Best Minute \${summary.bestTimingProfile.entryOffset} (\${(summary.bestTimingProfile.winRate * 100).toFixed(1)}%)\` : 'See Polymarket tab for full diagnostics'}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Win Rate</div>
                    <div class="qv-stat-value \${summary.winRate >= 0.5 ? 'positive' : 'negative'}">
                        \${(summary.winRate * 100).toFixed(1)}%
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Exp / Trade</div>
                    <div class="qv-stat-value \${summary.expectancy === null ? '' : (summary.expectancy >= 0 ? 'positive' : 'negative')}">
                        \${summary.expectancy === null ? 'n/a' : this.formatPolymarketCents(summary.expectancy)}
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Scored Trade Share</div>
                    <div class="qv-stat-value">\${(summary.coverage * 100).toFixed(1)}%</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Wins</div>
                    <div class="qv-stat-value positive">\${summary.wins}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Losses</div>
                    <div class="qv-stat-value negative">\${summary.losses}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Baseline Delta</div>
                    <div class="qv-stat-value \${summary.baselineDelta >= 0 ? 'positive' : 'negative'}">
                        \${summary.baselineDelta >= 0 ? '+' : ''}\${(summary.baselineDelta * 100).toFixed(1)}pp
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Max Win Streak</div>
                    <div class="qv-stat-value positive">\${summary.longestWinStreak}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Max Loss Streak</div>
                    <div class="qv-stat-value negative">\${summary.longestLossStreak}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Last 50 W/L</div>
                    <div class="qv-stat-value \${summary.recentFormTrades === 0 ? '' : (summary.recentFormWinRate >= 0.5 ? 'positive' : 'negative')}">
                        \${summary.recentFormTrades === 0 ? 'n/a' : \`\${summary.recentFormWins} win - \${summary.recentFormLosses} lose\`}
                    </div>
                </div>
                \${this.renderPolymarketExitReasonWinRateCard('Entry Win % | After Max Hold', summary.exitReasonWinRates.maxHold)}
                \${this.renderPolymarketExitReasonWinRateCard('Entry Win % | After TP', summary.exitReasonWinRates.takeProfit)}
                \${this.renderPolymarketExpectancyCard('Entry Exp / Trade | After TP', summary.afterTakeProfitExpectancy)}
                \${this.renderPolymarketExitReasonWinRateCard('Entry Win % | After Signal', summary.exitReasonWinRates.signal)}
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Scored Trades</div>
                    <div class="qv-stat-value">\${summary.scoredTrades}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Unscored Trades</div>
                    <div class="qv-stat-value">\${summary.unscoredTrades}</div>
                </div>
                \${summary.missingTrades > 0 ? \`
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Missing Outcome Rows</div>
                    <div class="qv-stat-value">\${summary.missingTrades}</div>
                </div>
                \` : ''}
                <div class="qv-stat-card full-width qv-poly-meta-card">
                    <div class="qv-stat-label">Outcome Rows Fetched</div>
                    <div class="qv-stat-value">\${summary.outcomeRowsLoaded}</div>
                </div>
                \${diagnosticsNote}
                \${timingProfileSection}
            </div>
        \`;
    }\n\n`;
qv = qv.replace('    private fmtPrice(price: number): string {', buildPolymarketSectionCode + '    private fmtPrice(price: number): string {');

// 5. Restore renderers
const renderersCode = `
    private renderPolymarketExitReasonWinRateCard(
        label: string,
        summary: QuickViewPolymarketExitReasonSummary
    ): string {
        const value = summary.trades > 0
            ? \`\${(summary.winRate * 100).toFixed(1)}% | \${summary.trades}t\`
            : 'n/a';
        const toneClass = summary.trades > 0
            ? (summary.winRate >= 0.5 ? 'positive' : 'negative')
            : '';

        return \`
            <div class="qv-stat-card">
                <div class="qv-stat-label">\${label}</div>
                <div class="qv-stat-value \${toneClass}">\${value}</div>
            </div>
        \`;
    }

    private renderPolymarketExpectancyCard(
        label: string,
        summary: QuickViewPolymarketExpectancySummary
    ): string {
        const expectancyValue = summary.expectancy;
        const hasData = summary.pricedTrades > 0 && expectancyValue !== null;
        const value = hasData
            ? \`\${this.formatPolymarketCents(expectancyValue)} | \${summary.pricedTrades}t\`
            : "n/a";
        const toneClass = hasData
            ? (expectancyValue >= 0 ? "positive" : "negative")
            : "";

        return \`
            <div class="qv-stat-card">
                <div class="qv-stat-label">\${label}</div>
                <div class="qv-stat-value \${toneClass}">\${value}</div>
            </div>
        \`;
    }\n\n`;
qv = qv.replace('    private buildPolymarketSection', renderersCode + '    private buildPolymarketSection');

// 6. Fix resolveSelectedPolymarketEntryOffset signature
qv = qv.replace('private resolveSelectedPolymarketEntryOffset(_result: BacktestResult): number {', 'private resolveSelectedPolymarketEntryOffset(result: BacktestResult): number {');

// 7. Inject polymarketSection back into buildMainQuickView
qv = qv.replace(
    "const pfText = result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2);",
    "const pfText = result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2);\n        const polymarketSection = this.buildPolymarketSection(result);"
);
qv = qv.replace(
    '</div>\n            </div>\n        `;',
    '</div>\n            </div>\n            ${polymarketSection}\n        `;'
);

fs.writeFileSync('lib/quick-view.ts', qv);
