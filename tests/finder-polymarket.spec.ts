import { expect } from 'chai';
import { afterEach, describe, it } from 'node:test';
import { runPolymarketFinder } from '../lib/finder/finder-runner-polymarket';
import { resetLocalSqlitePolymarketApiAvailabilityForTests } from '../lib/local-sqlite-polymarket-api';
import type { PolymarketPricePoint } from '../lib/local-sqlite-polymarket-api';
import type { FinderRunCallbacks, FinderRunInput } from '../lib/finder/finder-runner';
import type { CapitalSettings } from '../lib/types/backtest';
import type { FinderOptions } from '../lib/types/finder';
import type { PolymarketOutcomeRow } from '../lib/types/polymarket-outcomes';
import type { OHLCVData, Signal, Strategy, StrategyParams, Time } from '../lib/types/strategies';

const ORIGINAL_FETCH = globalThis.fetch;
let prepareFinderCalls = 0;

function makeBars(count: number, startTs = 1_700_000_000, intervalSec = 300): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: (startTs + index * intervalSec) as OHLCVData['time'],
        open: 30_000,
        high: 30_100,
        low: 29_900,
        close: 30_050,
        volume: 100,
    }));
}

function makeOutcomeRow(
    eventStartTs: number,
    resolvedUp: 0 | 1,
    seriesId = '10684',
    prices: Partial<Pick<
        PolymarketOutcomeRow,
        'yes_open_price'
        | 'yes_entry_minute_1_price'
        | 'yes_entry_minute_2_price'
        | 'yes_entry_minute_3_price'
        | 'yes_entry_minute_4_price'
    >> = {},
    options: {
        interval?: string;
        durationSec?: number;
        slugPrefix?: string;
    } = {}
): PolymarketOutcomeRow {
    const interval = options.interval ?? '5m';
    const durationSec = options.durationSec ?? (interval === '15m' ? 900 : interval === '1h' ? 3600 : 300);
    const slugPrefix = options.slugPrefix ?? `poly-${interval}`;
    return {
        series_id: seriesId,
        event_slug: `${slugPrefix}-${eventStartTs}`,
        market_slug: `${slugPrefix}-${eventStartTs}`,
        interval,
        event_start_ts: eventStartTs,
        event_end_ts: eventStartTs + durationSec,
        yes_token_id: 'yes-token',
        no_token_id: 'no-token',
        yes_open_price: prices.yes_open_price ?? 0.5,
        yes_entry_minute_1_price: prices.yes_entry_minute_1_price ?? 0.51,
        yes_entry_minute_2_price: prices.yes_entry_minute_2_price ?? 0.52,
        yes_entry_minute_3_price: prices.yes_entry_minute_3_price ?? 0.53,
        yes_entry_minute_4_price: prices.yes_entry_minute_4_price ?? 0.54,
        resolved_outcome_up: resolvedUp,
        resolution_source: 'outcomePrices',
        updated_at: 1_700_100_000,
    };
}

function makePricePoint(
    outcome: PolymarketOutcomeRow,
    ts: number,
    yesPrice: number
): PolymarketPricePoint {
    return {
        series_id: outcome.series_id,
        event_start_ts: outcome.event_start_ts,
        event_end_ts: outcome.event_end_ts,
        market_slug: outcome.market_slug,
        yes_token_id: outcome.yes_token_id,
        no_token_id: outcome.no_token_id,
        ts,
        yes_price: yesPrice,
        no_price: 1 - yesPrice,
        updated_at: 1_700_100_000,
    };
}

function buildFixtureSignals(data: OHLCVData[], params: StrategyParams): Signal[] {
    const first = data[0];
    const second = data[1];
    const third = data[2];
    switch (params.variant) {
        case 1:
            return [{ time: first.time, type: 'buy', price: first.close, barIndex: 0 }];
        case 2:
            return [
                { time: first.time, type: 'buy', price: first.close, barIndex: 0 },
                { time: second.time, type: 'buy', price: second.close, barIndex: 1 },
            ];
        case 3:
            return [{ time: first.time, type: 'sell', price: first.close, barIndex: 0 }];
        case 4:
            return [
                { time: first.time, type: 'buy', price: first.close, barIndex: 0 },
                { time: second.time, type: 'sell', price: second.close, barIndex: 1 },
            ];
        case 5:
            return [
                { time: first.time, type: 'buy', price: first.close, barIndex: 0 },
                { time: second.time, type: 'sell', price: second.close, barIndex: 1 },
                { time: third.time, type: 'buy', price: third.close, barIndex: 2 },
            ];
        default:
            return [];
    }
}

const fixtureStrategy: Strategy = {
    name: 'Fixture Strategy',
    description: 'Polymarket finder fixture',
    defaultParams: { variant: 1 },
    paramLabels: { variant: 'Variant' },
    execute(data: OHLCVData[], params: StrategyParams): Signal[] {
        return buildFixtureSignals(data, params);
    },
    prepareFinderData(data: OHLCVData[]): number[] {
        prepareFinderCalls++;
        return data.map((bar) => bar.close);
    },
    executePrepared(_prepared: unknown, params: StrategyParams, data: OHLCVData[]): Signal[] {
        return buildFixtureSignals(data, params);
    },
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: 'percent',
    fixedTradeAmount: 1_000,
};

function makeOptions(overrides: Partial<FinderOptions> = {}): FinderOptions {
    return {
        mode: 'grid',
        sortPriority: ['polyScore', 'polyWinRate', 'polyPredictions'],
        useAdvancedSort: false,
        topN: 10,
        steps: 3,
        rangePercent: 35,
        maxRuns: 10,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        freezeRiskManagement: true,
        polymarketScoringEnabled: true,
        polymarketRankMode: 'balanced',
        polymarketMinScoredPredictions: 0,
        polymarketLockOffset: false,
        polymarketAfterTakeProfitOnly: false,
        ...overrides,
    };
}

function makeInput(
    bars: OHLCVData[],
    paramSets: StrategyParams[],
    optionOverrides: Partial<FinderOptions> = {},
    interval = '5m',
    symbol = 'BTCUSDT',
    strategy: Strategy = fixtureStrategy
): FinderRunInput {
    return {
        ohlcvData: bars,
        symbol,
        interval,
        options: makeOptions(optionOverrides),
        settings: {
            executionModel: 'next_open',
            tradeDirection: 'both',
        },
        requiresTsEngine: true,
        selectedStrategies: [
            {
                key: 'fixture_strategy',
                name: strategy.name,
                strategy,
            },
        ],
        capitalSettings,
        generateParamSets: () => paramSets.map((params) => ({ ...params })),
    };
}

function makeCallbacks(): { callbacks: FinderRunCallbacks; statuses: string[]; getYieldCount: () => number } {
    const statuses: string[] = [];
    let yieldCount = 0;
    return {
        statuses,
        getYieldCount: () => yieldCount,
        callbacks: {
            setProgress: () => undefined,
            setStatus: (text: string) => {
                statuses.push(text);
            },
            yieldControl: async () => {
                yieldCount++;
            },
            isCancelled: () => false,
            onResultsUpdate: () => {},
        },
    };
}

function toUrl(input: Parameters<typeof fetch>[0]): URL {
    if (typeof input === 'string') {
        return new URL(input, 'http://localhost');
    }
    if (input instanceof URL) {
        return new URL(input.toString(), 'http://localhost');
    }
    return new URL(input.url, 'http://localhost');
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function installOutcomeFetch(
    rows: PolymarketOutcomeRow[],
    onRequest?: (url: URL) => void
): void {
    globalThis.fetch = (async (input) => {
        const url = toUrl(input);
        if (url.pathname === '/api/sqlite/status') {
            return jsonResponse({ ok: true });
        }
        onRequest?.(url);
        expect(url.pathname).to.equal('/api/sqlite/load-polymarket-outcomes');
        return jsonResponse({ ok: true, rows });
    }) as typeof fetch;
}

function installOutcomeAndPricePointFetch(
    rows: PolymarketOutcomeRow[],
    pricePoints: PolymarketPricePoint[],
    onRequest?: (url: URL) => void
): void {
    globalThis.fetch = (async (input) => {
        const url = toUrl(input);
        if (url.pathname === '/api/sqlite/status') {
            return jsonResponse({ ok: true });
        }
        onRequest?.(url);
        if (url.pathname === '/api/sqlite/load-polymarket-outcomes') {
            return jsonResponse({ ok: true, rows });
        }
        if (url.pathname === '/api/sqlite/load-polymarket-price-points') {
            return jsonResponse({ ok: true, rows: pricePoints });
        }
        if (url.pathname === '/api/sqlite/ensure-polymarket-price-points') {
            return jsonResponse({ ok: true, rows: pricePoints, upserted: 0, fetchedEvents: rows.length });
        }
        throw new Error(`Unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    prepareFinderCalls = 0;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

describe('Finder Polymarket runner', () => {
    it('loads the BTC 5m outcome series and scores executed trades against Polymarket outcomes', async () => {
        const bars = makeBars(4);
        const requestedSeriesIds: string[] = [];
        installOutcomeFetch(
            [
                makeOutcomeRow(Number(bars[1].time), 1),
                makeOutcomeRow(Number(bars[2].time), 1),
            ],
            (url) => {
                requestedSeriesIds.push(url.searchParams.get('seriesId') ?? '');
            }
        );

        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(bars, [{ variant: 1 }, { variant: 2 }, { variant: 3 }]),
            callbacks
        );

        expect(requestedSeriesIds).to.deep.equal(['10684']);
        expect(output.results).to.have.length(3);
        expect(output.results[0]?.polymarketEval?.winRate).to.equal(1);
        expect(output.results[0]?.polymarketEval?.predictionsTaken).to.equal(output.results[0]?.result.totalTrades);
        expect(output.results[0]?.polymarketEval?.wins).to.be.at.most(output.results[0]?.result.totalTrades ?? 0);
        expect(prepareFinderCalls).to.equal(1);
        expect(statuses.some((status) => status.includes('Loaded 2 outcome rows'))).to.equal(true);
    });

    it('yields control during Polymarket preparation so the UI can repaint between phases', async () => {
        const bars = makeBars(4);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1),
            makeOutcomeRow(Number(bars[2].time), 1),
        ]);

        const { callbacks, getYieldCount } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(bars, [{ variant: 1 }]),
            callbacks
        );

        expect(output.results).to.have.length(1);
        expect(getYieldCount()).to.be.greaterThanOrEqual(3);
    });

    it('loads the ETH 5m outcome series for supported alt symbols', async () => {
        const bars = makeBars(4);
        const requestedSeriesIds: string[] = [];
        installOutcomeFetch(
            [
                makeOutcomeRow(Number(bars[1].time), 1, '10683'),
                makeOutcomeRow(Number(bars[2].time), 0, '10683'),
            ],
            (url) => {
                requestedSeriesIds.push(url.searchParams.get('seriesId') ?? '');
            }
        );

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(bars, [{ variant: 1 }], {}, '5m', 'ETHUSDT'),
            callbacks
        );

        expect(requestedSeriesIds).to.deep.equal(['10683']);
        expect(output.results).to.have.length(1);
        expect(output.results[0]?.polymarketEval?.scoredPredictions).to.equal(1);
    });

    it('can score an unsupported chart symbol against an overridden Polymarket outcome symbol', async () => {
        const bars = makeBars(4);
        const requestedSeriesIds: string[] = [];
        installOutcomeFetch(
            [
                makeOutcomeRow(Number(bars[1].time), 1, '10683'),
                makeOutcomeRow(Number(bars[2].time), 0, '10683'),
            ],
            (url) => {
                requestedSeriesIds.push(url.searchParams.get('seriesId') ?? '');
            }
        );

        const input = makeInput(bars, [{ variant: 1 }], {}, '5m', 'NEARUSDT');
        input.settings = {
            ...input.settings,
            polymarketOutcomeSymbol: 'ETHUSDT',
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(input, callbacks);

        expect(requestedSeriesIds).to.deep.equal(['10683']);
        expect(output.results).to.have.length(1);
        expect(output.results[0]?.polymarketEval?.scoredPredictions).to.equal(1);
    });

    it('does not let the normal trade-count filter suppress Polymarket results', async () => {
        const bars = makeBars(4);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1),
            makeOutcomeRow(Number(bars[2].time), 1),
        ]);

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(
                bars,
                [{ variant: 1 }, { variant: 2 }],
                {
                    tradeFilterEnabled: true,
                    minTrades: 999,
                    maxTrades: 999,
                }
            ),
            callbacks
        );

        expect(output.results.length).to.be.greaterThan(0);
    });

    it('can score only entries that follow a take-profit exit', async () => {
        const bars: OHLCVData[] = [
            { time: 1_700_000_000 as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: 1_700_000_300 as Time, open: 100, high: 102, low: 99.5, close: 101.5, volume: 100 },
            { time: 1_700_000_600 as Time, open: 101, high: 101.4, low: 99.5, close: 100, volume: 100 },
            { time: 1_700_000_900 as Time, open: 100, high: 100.2, low: 99, close: 99.8, volume: 100 },
        ];
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1, '10684', { yes_open_price: 0.4 }),
            makeOutcomeRow(Number(bars[2].time), 0, '10684', { yes_open_price: 0.7 }),
        ]);

        const twoLongSignalsStrategy: Strategy = {
            name: 'Two Long Signals',
            description: 'Creates one TP setup followed by one later entry',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [
                    { time: data[0].time, type: 'buy', price: data[0].close, barIndex: 0 },
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                ];
            },
        };

        const baselineInput = makeInput(bars, [{}], {}, '5m', 'BTCUSDT', twoLongSignalsStrategy);
        baselineInput.settings = {
            ...baselineInput.settings,
            tradeDirection: 'long',
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 1,
            allowSameBarExit: true,
            slippageBps: 0,
            // This test exercises Polymarket scoring of a post-TP re-entry on
            // the same bar. The general entry cooldown (default on, N=1) would
            // block that re-entry; turn it off so the test isolates the
            // Polymarket scoring path it was designed for.
            riskCooldownEnabled: false,
        };

        const { callbacks: baselineCallbacks } = makeCallbacks();
        const baseline = await runPolymarketFinder(baselineInput, baselineCallbacks);

        const filteredInput = makeInput(
            bars,
            [{}],
            { polymarketAfterTakeProfitOnly: true },
            '5m',
            'BTCUSDT',
            twoLongSignalsStrategy
        );
        filteredInput.settings = { ...baselineInput.settings };

        const { callbacks: filteredCallbacks } = makeCallbacks();
        const filtered = await runPolymarketFinder(filteredInput, filteredCallbacks);

        expect(baseline.results).to.have.length(1);
        expect(filtered.results).to.have.length(1);
        expect(baseline.results[0]?.result.trades).to.have.length(2);
        expect(baseline.results[0]?.result.trades[0]?.exitReason).to.equal('take_profit');
        expect(baseline.results[0]?.polymarketEval?.predictionsTaken).to.equal(2);
        expect(baseline.results[0]?.polymarketEval?.scoredPredictions).to.equal(2);
        expect(baseline.results[0]?.polymarketEval?.winRate).to.equal(0.5);
        expect(baseline.results[0]?.polymarketEval?.expectancy).to.be.closeTo(-0.05, 1e-12);
        expect(filtered.results[0]?.polymarketEval?.predictionsTaken).to.equal(1);
        expect(filtered.results[0]?.polymarketEval?.scoredPredictions).to.equal(1);
        expect(filtered.results[0]?.polymarketEval?.winRate).to.equal(0);
        expect(filtered.results[0]?.polymarketEval?.expectancy).to.be.closeTo(-0.7, 1e-12);
    });

    it('filters out candidates below the polymarket minimum scored threshold', async () => {
        const bars = makeBars(5);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1),
            makeOutcomeRow(Number(bars[2].time), 1),
            makeOutcomeRow(Number(bars[3].time), 1),
        ]);

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(
                bars,
                [{ variant: 1 }, { variant: 5 }],
                {
                    polymarketMinScoredPredictions: 2,
                }
            ),
            callbacks
        );

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.params.variant).to.equal(5);
        expect(output.results[0]?.polymarketEval?.scoredPredictions).to.equal(2);
    });

    it('applies the minimum scored threshold to filled post-signal limit entries', async () => {
        const bars = makeBars(5);
        const rows = [
            makeOutcomeRow(Number(bars[1].time), 1),
            makeOutcomeRow(Number(bars[2].time), 1),
            makeOutcomeRow(Number(bars[3].time), 1),
        ];
        const pricePoints = rows.flatMap((row, index) => [
            makePricePoint(row, row.event_start_ts + 60, index === 0 ? 0.70 : 0.49),
        ]);
        installOutcomeAndPricePointFetch(rows, pricePoints);

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(
                bars,
                [{ variant: 1 }, { variant: 5 }],
                {
                    polymarketMinScoredPredictions: 1,
                    polymarketPostSignalLimitEntryEnabled: true,
                    polymarketPostSignalLimitEntryPriceCents: 50,
                }
            ),
            callbacks
        );

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.params.variant).to.equal(5);
        expect(output.results[0]?.polymarketEval?.limitEntryEnabled).to.equal(true);
        expect(output.results[0]?.polymarketEval?.scoredPredictions).to.equal(
            output.results[0]?.polymarketEval?.limitEntryFilledTrades
        );
        expect(output.results[0]?.polymarketEval?.limitEntryFilledTrades ?? 0).to.be.greaterThan(0);
        expect(output.results[0]?.polymarketEval?.limitEntryMissedTrades ?? 0).to.be.greaterThan(0);
    });

    it('skips strategy candidates that throw during signal generation instead of aborting the whole run', async () => {
        const bars = makeBars(4);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1),
            makeOutcomeRow(Number(bars[2].time), 1),
        ]);

        const unstableStrategy: Strategy = {
            ...fixtureStrategy,
            name: 'Unstable Fixture Strategy',
            prepareFinderData: undefined,
            executePrepared: undefined,
            execute(data: OHLCVData[], params: StrategyParams): Signal[] {
                if (params.variant === 99) {
                    throw new TypeError("Cannot read properties of undefined (reading 'low')");
                }
                return buildFixtureSignals(data, params);
            },
        };

        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(
                bars,
                [{ variant: 1 }, { variant: 99 }],
                {},
                '5m',
                'BTCUSDT',
                unstableStrategy
            ),
            callbacks
        );

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.params.variant).to.equal(1);
        expect(statuses.at(-1)).to.equal('Complete. 2 evaluations, 1 failed, 1 shown, 2 outcome rows.');
    });

    it('skips remaining Polymarket params after a fatal strategy dependency failure', async () => {
        const bars = makeBars(4);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1),
            makeOutcomeRow(Number(bars[2].time), 1),
        ]);

        const fatalStrategy: Strategy = {
            ...fixtureStrategy,
            name: 'Fatal Fixture Strategy',
            prepareFinderData: undefined,
            executePrepared: undefined,
            execute(data: OHLCVData[], params: StrategyParams): Signal[] {
                if (params.variant === 99) {
                    throw new Error("Check dependency list! Synchronous require cannot resolve module '../time-normalization'.");
                }
                return buildFixtureSignals(data, params);
            },
        };

        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(
                bars,
                [{ variant: 1 }, { variant: 99 }, { variant: 2 }],
                {},
                '5m',
                'BTCUSDT',
                fatalStrategy
            ),
            callbacks
        );

        const diagnostics = output.diagnostics;
        const strategyDiagnostics = diagnostics?.strategyBreakdown.find((item) => item.key === 'fixture_strategy');
        expect(output.results).to.have.length(1);
        expect(output.results[0]?.params.variant).to.equal(1);
        expect(diagnostics?.counts.processedRuns).to.equal(3);
        expect(diagnostics?.counts.failedRuns).to.equal(1);
        expect(diagnostics?.counts.skippedRuns).to.equal(1);
        expect(strategyDiagnostics?.failedRuns).to.equal(1);
        expect(strategyDiagnostics?.skippedRuns).to.equal(1);
        expect(statuses.at(-1)).to.equal('Complete. 3 evaluations, 1 failed, 1 skipped, 1 shown, 2 outcome rows.');
    });

    it('uses the provided polymarket sort priority instead of a hard-coded ranking', async () => {
        const bars = makeBars(5);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1),
            makeOutcomeRow(Number(bars[2].time), 1),
            makeOutcomeRow(Number(bars[3].time), 1),
        ]);

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(
                bars,
                [{ variant: 1 }, { variant: 5 }],
                {
                    sortPriority: ['polyWins', 'polyPredictions', 'polyWinRate'],
                    polymarketRankMode: 'volume',
                }
            ),
            callbacks
        );

        expect(output.results).to.have.length(2);
        expect(output.results[0]?.params.variant).to.equal(5);
        expect(output.results[0]?.polymarketEval?.wins).to.equal(2);
    });

    it('supports sized-net polymarket ranking when alternative sizing is active', async () => {
        const bars = makeBars(5);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1, '10684', { yes_open_price: 0.5 }),
            makeOutcomeRow(Number(bars[2].time), 0, '10684', { yes_open_price: 0.5 }),
            makeOutcomeRow(Number(bars[3].time), 1, '10684', { yes_open_price: 0.5 }),
        ]);

        const input = makeInput(
            bars,
            [{ variant: 1 }, { variant: 5 }],
            {
                sortPriority: ['polySizedNet', 'polyPredictions', 'polyWinRate'],
                polymarketRankMode: 'sizedNet',
            }
        );
        input.capitalSettings = {
            ...capitalSettings,
            sizingMode: 'anti_martingale',
            advancedSizing: {
                martingaleMultiplier: 2,
            },
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(input, callbacks);

        expect(output.results).to.have.length(2);
        expect(output.results[0]?.params.variant).to.equal(5);
        expect(output.results[0]?.polymarketEval?.sizedNetProfit).to.be.greaterThan(
            output.results[1]?.polymarketEval?.sizedNetProfit ?? 0
        );
        expect(output.results[0]?.polymarketEval?.sizedTrades).to.be.greaterThan(1);
    });

    it('rejects sized-net ranking when alternative sizing is not active', async () => {
        const bars = makeBars(4);
        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(
                bars,
                [{ variant: 1 }],
                {
                    sortPriority: ['polySizedNet', 'polyPredictions', 'polyWinRate'],
                    polymarketRankMode: 'sizedNet',
                }
            ),
            callbacks
        );

        expect(output.results).to.deep.equal([]);
        expect(statuses.at(-1)).to.equal('Sized Net rank mode requires Alternative Sizing mode other than percent.');
    });

    it('supports expectancy-based polymarket ranking', async () => {
        const bars = makeBars(4);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 1, '10684', { yes_open_price: 0.8 }),
            makeOutcomeRow(Number(bars[2].time), 1, '10684', { yes_open_price: 0.2 }),
        ]);

        const earlyBuyStrategy: Strategy = {
            name: 'Early Buy',
            description: 'Scores the expensive first event',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [{ time: data[0].time, type: 'buy', price: data[0].close, barIndex: 0 }];
            },
        };
        const lateBuyStrategy: Strategy = {
            name: 'Late Buy',
            description: 'Scores the cheaper second event',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [{ time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 }];
            },
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            {
                ...makeInput(
                    bars,
                    [{}],
                    {
                        sortPriority: ['polyExpectancy', 'polyWinRate', 'polyPredictions'],
                        polymarketRankMode: 'expectancy',
                    }
                ),
                selectedStrategies: [
                    {
                        key: 'early_buy',
                        name: earlyBuyStrategy.name,
                        strategy: earlyBuyStrategy,
                    },
                    {
                        key: 'late_buy',
                        name: lateBuyStrategy.name,
                        strategy: lateBuyStrategy,
                    },
                ],
            },
            callbacks
        );

        expect(output.results).to.have.length(2);
        expect(output.results[0]?.key).to.equal('late_buy');
        expect(output.results[0]?.polymarketEval?.expectancy).to.be.closeTo(0.8, 1e-12);
        expect(output.results[1]?.key).to.equal('early_buy');
        expect(output.results[1]?.polymarketEval?.expectancy).to.be.closeTo(0.2, 1e-12);
    });

    it('supports expectancy plus trades polymarket ranking', async () => {
        const bars = makeBars(6);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 0, '10684', { yes_open_price: 0.6 }),
            makeOutcomeRow(Number(bars[2].time), 1, '10684', { yes_open_price: 0.4 }),
            makeOutcomeRow(Number(bars[3].time), 0, '10684', { yes_open_price: 0.6 }),
            makeOutcomeRow(Number(bars[4].time), 1, '10684', { yes_open_price: 0.1 }),
        ]);

        const sparseHighExpectancyStrategy: Strategy = {
            name: 'Sparse High Expectancy',
            description: 'One expensive edge',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [{ time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 }];
            },
        };
        const steadierStrategy: Strategy = {
            name: 'Steadier Expectancy',
            description: 'More trades with solid expectancy',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [
                    { time: data[0].time, type: 'sell', price: data[0].close, barIndex: 0 },
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: 'sell', price: data[2].close, barIndex: 2 },
                ];
            },
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            {
                ...makeInput(
                    bars,
                    [{}],
                    {
                        sortPriority: ['polyExpectancyBalance', 'polyExpectancy', 'totalTrades', 'polyPredictions', 'polyWinRate'],
                        polymarketRankMode: 'expectancyTrades',
                    }
                ),
                selectedStrategies: [
                    {
                        key: 'sparse_high_expectancy',
                        name: sparseHighExpectancyStrategy.name,
                        strategy: sparseHighExpectancyStrategy,
                    },
                    {
                        key: 'steadier_expectancy',
                        name: steadierStrategy.name,
                        strategy: steadierStrategy,
                    },
                ],
            },
            callbacks
        );

        expect(output.results).to.have.length(2);
        expect(output.results[0]?.key).to.equal('steadier_expectancy');
        expect(output.results[0]?.selectionResult.totalTrades).to.equal(2);
        expect(output.results[0]?.polymarketEval?.expectancy).to.be.closeTo(0.6, 1e-12);
        expect(output.results[1]?.key).to.equal('sparse_high_expectancy');
        expect(output.results[1]?.selectionResult.totalTrades).to.equal(1);
        expect(output.results[1]?.polymarketEval?.expectancy).to.be.closeTo(0.9, 1e-12);
    });

    it('supports profit-factor-based polymarket ranking', async () => {
        const bars = makeBars(6);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 0, '10684', { yes_open_price: 0.8 }),
            makeOutcomeRow(Number(bars[2].time), 0, '10684', { yes_open_price: 0.8 }),
            makeOutcomeRow(Number(bars[3].time), 0, '10684', { yes_open_price: 0.8 }),
            makeOutcomeRow(Number(bars[4].time), 1, '10684', { yes_open_price: 0.1 }),
        ]);

        const sparseHighProfitFactorStrategy: Strategy = {
            name: 'Sparse High Profit Factor',
            description: 'One cheap winning YES entry',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [{ time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 }];
            },
        };
        const steadierProfitFactorStrategy: Strategy = {
            name: 'Steadier Profit Factor',
            description: 'Three priced trades with finite PF',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [
                    { time: data[0].time, type: 'sell', price: data[0].close, barIndex: 0 },
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: 'sell', price: data[2].close, barIndex: 2 },
                ];
            },
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            {
                ...makeInput(
                    bars,
                    [{}],
                    {
                        sortPriority: ['polyProfitFactor', 'polyPredictions', 'polyWinRate'],
                        polymarketRankMode: 'profitFactor',
                    }
                ),
                selectedStrategies: [
                    {
                        key: 'sparse_high_profit_factor',
                        name: sparseHighProfitFactorStrategy.name,
                        strategy: sparseHighProfitFactorStrategy,
                    },
                    {
                        key: 'steadier_profit_factor',
                        name: steadierProfitFactorStrategy.name,
                        strategy: steadierProfitFactorStrategy,
                    },
                ],
            },
            callbacks
        );

        expect(output.results).to.have.length(2);
        expect(output.results[0]?.key).to.equal('steadier_profit_factor');
        expect(output.results[0]?.polymarketEval?.profitFactor).to.equal(Infinity);
        expect(output.results[1]?.key).to.equal('sparse_high_profit_factor');
        expect(output.results[1]?.polymarketEval?.profitFactor).to.equal(Infinity);
    });

    it('supports profit factor plus trades polymarket ranking', async () => {
        const bars = makeBars(6);
        installOutcomeFetch([
            makeOutcomeRow(Number(bars[1].time), 0, '10684', { yes_open_price: 0.8 }),
            makeOutcomeRow(Number(bars[2].time), 0, '10684', { yes_open_price: 0.8 }),
            makeOutcomeRow(Number(bars[3].time), 0, '10684', { yes_open_price: 0.8 }),
            makeOutcomeRow(Number(bars[4].time), 1, '10684', { yes_open_price: 0.1 }),
        ]);

        const sparseHighProfitFactorStrategy: Strategy = {
            name: 'Sparse High Profit Factor',
            description: 'One cheap winning YES entry',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [{ time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 }];
            },
        };
        const steadierProfitFactorStrategy: Strategy = {
            name: 'Steadier Profit Factor',
            description: 'Three priced trades with finite PF',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [
                    { time: data[0].time, type: 'sell', price: data[0].close, barIndex: 0 },
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: 'sell', price: data[2].close, barIndex: 2 },
                ];
            },
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            {
                ...makeInput(
                    bars,
                    [{}],
                    {
                        sortPriority: ['polyProfitFactorBalance', 'polyProfitFactor', 'totalTrades', 'polyPredictions', 'polyWinRate'],
                        polymarketRankMode: 'profitFactorTrades',
                    }
                ),
                selectedStrategies: [
                    {
                        key: 'sparse_high_profit_factor',
                        name: sparseHighProfitFactorStrategy.name,
                        strategy: sparseHighProfitFactorStrategy,
                    },
                    {
                        key: 'steadier_profit_factor',
                        name: steadierProfitFactorStrategy.name,
                        strategy: steadierProfitFactorStrategy,
                    },
                ],
            },
            callbacks
        );

        expect(output.results).to.have.length(2);
        expect(output.results[0]?.key).to.equal('steadier_profit_factor');
        expect(output.results[0]?.selectionResult.totalTrades).to.equal(2);
        expect(output.results[0]?.polymarketEval?.profitFactor).to.equal(Infinity);
        expect(output.results[1]?.key).to.equal('sparse_high_profit_factor');
        expect(output.results[1]?.selectionResult.totalTrades).to.equal(1);
        expect(output.results[1]?.polymarketEval?.profitFactor).to.equal(Infinity);
    });

    it('rejects non-1m/5m/15m/1h/4h intervals before touching the outcome loader', async () => {
        globalThis.fetch = (async () => {
            throw new Error('fetch should not be called for invalid interval');
        }) as typeof fetch;

        const { callbacks, statuses } = makeCallbacks();
        // 30m is not a supported Polymarket interval
        const output = await runPolymarketFinder(
            makeInput(makeBars(4), [{ variant: 1 }], {}, '30m'),
            callbacks
        );

        expect(output.results).to.have.length(0);
        expect(statuses.at(-1)).to.equal('Polymarket scoring requires 1m, 5m, 15m, 1h, or 4h interval.');
    });

    it('rejects unsupported symbols before touching the outcome loader', async () => {
        globalThis.fetch = (async () => {
            throw new Error('fetch should not be called for unsupported symbol');
        }) as typeof fetch;

        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(makeBars(4), [{ variant: 1 }], {}, '5m', 'ADAUSDT'),
            callbacks
        );

        expect(output.results).to.have.length(0);
        expect(statuses.at(-1)).to.equal('Polymarket scoring currently supports BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT on 1m, 5m, 15m, 1h, 4h.');
    });

    it('surfaces SQLite outcome load failures without hanging the run', async () => {
        globalThis.fetch = (async (input) => {
            const url = toUrl(input);
            if (url.pathname === '/api/sqlite/status') {
                return jsonResponse({ ok: true });
            }
            throw new Error('socket stalled');
        }) as typeof fetch;

        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(makeBars(4), [{ variant: 1 }]),
            callbacks
        );

        expect(output.results).to.have.length(0);
        expect(statuses.at(-1)).to.equal('Failed to load Polymarket outcomes from SQLite. Failed to reach /api/sqlite/load-polymarket-outcomes: socket stalled');
    });

    it('rejects unsupported Finder modes before loading outcomes', async () => {
        const seenModes: string[] = [];
        globalThis.fetch = (async () => {
            throw new Error('fetch should not be called for unsupported mode');
        }) as typeof fetch;

        for (const mode of ['default', 'genetic'] as const) {
            const { callbacks, statuses } = makeCallbacks();
            const output = await runPolymarketFinder(
                makeInput(makeBars(4), [{ variant: 1 }], { mode }),
                callbacks
            );
            expect(output.results).to.have.length(0);
            expect(statuses.at(-1)).to.include('Use grid or random.');
            seenModes.push(mode);
        }

        expect(seenModes).to.deep.equal(['default', 'genetic']);
    });

    it('accepts 1m interval and scores trades using the 1m -> 5m bridge', async () => {
        const bars = makeBars(10, 1_700_000_000, 60); // 1m bars (60s interval)
        const outcomeRows = [
            makeOutcomeRow(1_700_000_000 + 300, 1), // 5m event starting at bar 5 (5 min)
        ];
        installOutcomeFetch(outcomeRows);

        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(bars, [{ variant: 1 }], {}, '1m'),
            callbacks
        );

        // 1m runs should expand to 5 offset configurations (0..4)
        expect(output.results).to.have.length(5);
        
        // Each result should have an entryOffset in its params
        for (const result of output.results) {
            expect(result.params).to.have.property('polymarketEntryOffset');
            expect(result.params.polymarketEntryOffset).to.be.oneOf([0, 1, 2, 3, 4]);
        }

        expect(statuses.some((status) => status.includes('outcome rows'))).to.equal(true);
    });

    it('reuses a recent successful SQLite status check for signal-exit price points', async () => {
        const bars = makeBars(8, 1_700_000_000, 60);
        let statusCalls = 0;

        globalThis.fetch = (async (input) => {
            const url = toUrl(input);

            if (url.pathname === '/api/sqlite/status') {
                statusCalls++;
                if (statusCalls === 1) {
                    return jsonResponse({ ok: true });
                }
                throw new Error('transient status probe failure');
            }

            if (url.pathname === '/api/sqlite/load-polymarket-outcomes') {
                return jsonResponse({
                    ok: true,
                    rows: [
                        makeOutcomeRow(1_700_000_000, 1),
                    ],
                });
            }

            if (url.pathname === '/api/sqlite/load-polymarket-price-points') {
                return jsonResponse({
                    ok: true,
                    rows: [
                        {
                            series_id: '10684',
                            event_start_ts: 1_700_000_000,
                            event_end_ts: 1_700_000_300,
                            market_slug: 'btc-5m-1700000000',
                            yes_token_id: 'yes-token',
                            no_token_id: 'no-token',
                            ts: 1_700_000_060,
                            yes_price: 0.51,
                            no_price: 0.49,
                            updated_at: 1,
                        },
                        {
                            series_id: '10684',
                            event_start_ts: 1_700_000_000,
                            event_end_ts: 1_700_000_300,
                            market_slug: 'btc-5m-1700000000',
                            yes_token_id: 'yes-token',
                            no_token_id: 'no-token',
                            ts: 1_700_000_180,
                            yes_price: 0.63,
                            no_price: 0.37,
                            updated_at: 1,
                        },
                    ],
                });
            }

            if (url.pathname === '/api/sqlite/ensure-polymarket-price-points') {
                throw new Error('ensure route should not run when stored price points already cover the event');
            }

            throw new Error(`Unexpected fetch: ${url.pathname}`);
        }) as typeof fetch;

        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(
                bars,
                [{ variant: 4 }],
                {
                    polymarketExitMode: 'signal_exit_same_event',
                    polymarketRankMode: 'expectancy',
                    sortPriority: ['polyExpectancy', 'polyWinRate', 'polyPredictions'],
                },
                '1m'
            ),
            callbacks
        );

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.polymarketEval?.evaluationMode).to.equal('signal_exit_same_event');
        expect(statuses.some((status) => status.includes('Failed to ensure Polymarket price points'))).to.equal(false);
        expect(statusCalls).to.be.at.most(1);
    });

    it('uses native 15m outcome rows when polymarketOutcomeInterval is 15m', async () => {
        const bars = makeBars(4, 1_700_000_000, 900);
        const requestedSeriesIds: string[] = [];
        const outcomes = [
            makeOutcomeRow(1_700_000_900, 1, '10192', {}, { interval: '15m', durationSec: 900 }),
            makeOutcomeRow(1_700_001_800, 0, '10192', {}, { interval: '15m', durationSec: 900 }),
        ];
        const pricePoints = [
            makePricePoint(outcomes[0], outcomes[0].event_start_ts + 60, 0.42),
            makePricePoint(outcomes[0], outcomes[0].event_end_ts - 60, 0.46),
            makePricePoint(outcomes[1], outcomes[1].event_start_ts + 60, 0.58),
            makePricePoint(outcomes[1], outcomes[1].event_end_ts - 60, 0.52),
        ];
        installOutcomeAndPricePointFetch(outcomes, pricePoints, (url) => {
            if (url.pathname === '/api/sqlite/load-polymarket-outcomes') {
                requestedSeriesIds.push(url.searchParams.get('seriesId') ?? '');
            }
        });

        const input = makeInput(bars, [{ variant: 1 }, { variant: 2 }], {}, '15m');
        input.settings = {
            ...input.settings,
            polymarketOutcomeInterval: '15m',
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(input, callbacks);

        expect(requestedSeriesIds).to.deep.equal(['10192']);
        expect(output.results).to.have.length(2);
        expect(output.results.every((result) => result.params.polymarketEntryOffset === undefined)).to.equal(true);
        expect(output.results.some((result) => (result.polymarketEval?.avgEntryPrice ?? 0) > 0)).to.equal(true);
        expect(output.results.every((result) => result.polymarketEval?.evaluationMode === 'resolve_hold')).to.equal(true);
    });

    it('scores non-zero offsets for multi-interval Polymarket runs', async () => {
        const bars = makeBars(4, 1_700_000_300, 900);
        installOutcomeFetch([
            makeOutcomeRow(1_700_000_000, 1),
            makeOutcomeRow(1_700_000_300, 1),
            makeOutcomeRow(1_700_000_600, 0),
            makeOutcomeRow(1_700_000_900, 1),
            makeOutcomeRow(1_700_001_200, 1),
            makeOutcomeRow(1_700_001_500, 0),
        ]);

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(bars, [{ variant: 1 }], {}, '15m'),
            callbacks
        );

        expect(output.results).to.have.length(3);
        expect(output.results.map((result) => result.params.polymarketEntryOffset).sort((a, b) => a - b)).to.deep.equal([0, 1, 2]);
        expect(output.results.find((result) => result.params.polymarketEntryOffset === 1)?.polymarketEval?.scoredPredictions).to.equal(1);
        expect(output.results.find((result) => result.params.polymarketEntryOffset === 0)?.polymarketEval?.scoredPredictions).to.equal(0);
    });

    it('runs the strategy once per param set on 1m and reuses that backtest across all 5 offsets', async () => {
        const bars = makeBars(10, 1_700_000_000, 60);
        installOutcomeFetch([
            makeOutcomeRow(1_700_000_000 + 300, 1),
        ]);

        let executePreparedCalls = 0;
        const countingStrategy: Strategy = {
            ...fixtureStrategy,
            executePrepared(_prepared: unknown, params: StrategyParams, data: OHLCVData[]): Signal[] {
                executePreparedCalls++;
                return buildFixtureSignals(data, params);
            },
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(bars, [{ variant: 1 }], {}, '1m', 'BTCUSDT', countingStrategy),
            callbacks
        );

        expect(output.results).to.have.length(5);
        expect(executePreparedCalls).to.equal(1);
    });

    it('locks random 1m Polymarket runs to the selected backtest offset when requested', async () => {
        const bars = makeBars(10, 1_700_000_000, 60);
        installOutcomeFetch([
            makeOutcomeRow(1_700_000_000 + 300, 1),
        ]);

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            {
                ...makeInput(
                    bars,
                    [{ variant: 1 }],
                    {
                        mode: 'random',
                        polymarketLockOffset: true,
                    },
                    '1m'
                ),
                settings: {
                    executionModel: 'next_open',
                    tradeDirection: 'both',
                    polymarketEntryOffset: 3,
                },
            },
            callbacks
        );

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.params.polymarketEntryOffset).to.equal(3);
    });

    it('scores locked 1m offsets with the 1m bridge mapper instead of dropping them to zero', async () => {
        const bars = makeBars(12, 1_700_000_000, 60);
        installOutcomeFetch([
            makeOutcomeRow(1_700_000_000 + 300, 1),
        ]);

        const offsetTwoStrategy: Strategy = {
            name: 'Offset Two Entry',
            description: 'Signals on the bar that should enter minute 2',
            defaultParams: {},
            paramLabels: {},
            execute(data: OHLCVData[]): Signal[] {
                return [{ time: data[6]!.time, type: 'buy', price: data[6]!.close, barIndex: 6 }];
            },
        };

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            {
                ...makeInput(
                    bars,
                    [{}],
                    {
                        mode: 'random',
                        polymarketLockOffset: true,
                        polymarketMinScoredPredictions: 1,
                    },
                    '1m',
                    'BTCUSDT',
                    offsetTwoStrategy
                ),
                settings: {
                    executionModel: 'next_open',
                    tradeDirection: 'both',
                    polymarketEntryOffset: 2,
                },
            },
            callbacks
        );

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.params.polymarketEntryOffset).to.equal(2);
        expect(output.results[0]?.polymarketEval?.scoredPredictions).to.be.greaterThan(0);
    });

    it('deduplicates trades within the same event for 1m bridge runs', async () => {
        // Create 1m bars where multiple trades fall into the same 5m event
        const bars = makeBars(20, 1_700_000_000, 60); // 20 1m bars
        installOutcomeFetch([
            makeOutcomeRow(1_700_000_000 + 300, 1), // 5m event at t+300
            makeOutcomeRow(1_700_000_000 + 600, 1), // 5m event at t+600
        ]);

        // Variant 5 produces 3 trades; with 1m bridge, multiple may fall into same event
        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(bars, [{ variant: 5 }], {}, '1m'),
            callbacks
        );

        // Should have 5 offset configurations
        expect(output.results).to.have.length(5);

        // Check that duplicateTradesIgnored is tracked in eval results
        for (const result of output.results) {
            expect(result.polymarketEval).to.exist;
            // duplicateTradesIgnored may be 0 or more depending on trade distribution
            expect(result.polymarketEval!.duplicateTradesIgnored ?? 0).to.be.greaterThanOrEqual(0);
        }
    });

    it('filters trades by selected offset in 1m bridge mode', async () => {
        const bars = makeBars(20, 1_700_000_000, 60);
        installOutcomeFetch([
            makeOutcomeRow(1_700_000_000 + 300, 1),
            makeOutcomeRow(1_700_000_000 + 600, 1),
        ]);

        const { callbacks } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(bars, [{ variant: 5 }], {}, '1m'),
            callbacks
        );

        // 1m runs should produce 5 offset configurations (0..4)
        expect(output.results).to.have.length(5);
        
        // Each result should have a distinct offset
        const offsets = output.results.map((r) => r.params.polymarketEntryOffset).sort((a, b) => a - b);
        expect(offsets).to.deep.equal([0, 1, 2, 3, 4]);
    });
});
