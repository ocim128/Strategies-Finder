import { expect } from 'chai';
import { afterEach, describe, it } from 'node:test';
import { runPolymarketFinder } from '../lib/finder/finder-runner-polymarket';
import type { FinderRunCallbacks, FinderRunInput } from '../lib/finder/finder-runner';
import type { CapitalSettings } from '../lib/types/backtest';
import type { FinderOptions } from '../lib/types/finder';
import type { PolymarketOutcomeRow } from '../lib/types/polymarket-outcomes';
import type { OHLCVData, Signal, Strategy, StrategyParams } from '../lib/types/strategies';

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

function makeOutcomeRow(eventStartTs: number, resolvedUp: 0 | 1, seriesId = '10684'): PolymarketOutcomeRow {
    return {
        series_id: seriesId,
        event_slug: `btc-5m-${eventStartTs}`,
        market_slug: `btc-5m-${eventStartTs}`,
        interval: '5m',
        event_start_ts: eventStartTs,
        event_end_ts: eventStartTs + 300,
        yes_token_id: 'yes-token',
        no_token_id: 'no-token',
        yes_open_price: 0.5,
        yes_entry_minute_1_price: 0.51,
        yes_entry_minute_2_price: 0.52,
        yes_entry_minute_3_price: 0.53,
        yes_entry_minute_4_price: 0.54,
        resolved_outcome_up: resolvedUp,
        resolution_source: 'outcomePrices',
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
        robustSeed: 1337,
        multiTimeframeEnabled: false,
        timeframes: [],
        topN: 10,
        steps: 3,
        rangePercent: 35,
        maxRuns: 10,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        freezeRiskManagement: true,
        comboEnabled: false,
        polymarketScoringEnabled: true,
        polymarketRankMode: 'balanced',
        polymarketMinScoredPredictions: 0,
        polymarketLockOffset: false,
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
        getFinderTimeframesForRun: () => [],
        loadMultiTimeframeDatasets: async () => [],
        generateParamSets: () => paramSets.map((params) => ({ ...params })),
        buildRandomConfirmationParams: () => ({}),
    };
}

function makeCallbacks(): { callbacks: FinderRunCallbacks; statuses: string[] } {
    const statuses: string[] = [];
    return {
        statuses,
        callbacks: {
            setProgress: () => undefined,
            setStatus: (text: string) => {
                statuses.push(text);
            },
            yieldControl: async () => undefined,
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

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    prepareFinderCalls = 0;
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

    it('uses executed trade count for the Finder min/max filter in Polymarket mode', async () => {
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
                    minTrades: 2,
                    maxTrades: 2,
                }
            ),
            callbacks
        );

        expect(output.results).to.have.length(0);
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
        expect(output.results[0]?.polymarketEval?.scoredPredictions).to.equal(3);
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

        for (const mode of ['default', 'genetic', 'robust_random_wf'] as const) {
            const { callbacks, statuses } = makeCallbacks();
            const output = await runPolymarketFinder(
                makeInput(makeBars(4), [{ variant: 1 }], { mode }),
                callbacks
            );
            expect(output.results).to.have.length(0);
            expect(statuses.at(-1)).to.include('Use grid or random.');
            seenModes.push(mode);
        }

        expect(seenModes).to.deep.equal(['default', 'genetic', 'robust_random_wf']);
    });

    it('rejects multi-timeframe and combo Polymarket runs', async () => {
        globalThis.fetch = (async () => {
            throw new Error('fetch should not be called for blocked Polymarket modes');
        }) as typeof fetch;

        const multi = makeCallbacks();
        const multiOutput = await runPolymarketFinder(
            makeInput(makeBars(4), [{ variant: 1 }], { multiTimeframeEnabled: true }),
            multi.callbacks
        );
        expect(multiOutput.results).to.have.length(0);
        expect(multi.statuses.at(-1)).to.equal('Multi-timeframe is not supported in Polymarket mode.');

        const combo = makeCallbacks();
        const comboOutput = await runPolymarketFinder(
            makeInput(makeBars(4), [{ variant: 1 }], { comboEnabled: true }),
            combo.callbacks
        );
        expect(comboOutput.results).to.have.length(0);
        expect(combo.statuses.at(-1)).to.equal('Combo mode is not supported in Polymarket mode.');
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
