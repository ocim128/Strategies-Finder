import { expect } from 'chai';
import { afterEach, describe, it } from 'node:test';
import { runPolymarketFinder } from '../lib/finder/finder-runner-polymarket';
import type { FinderRunCallbacks, FinderRunInput } from '../lib/finder/finder-runner';
import type { CapitalSettings } from '../lib/types/backtest';
import type { FinderOptions } from '../lib/types/finder';
import type { PolymarketOutcomeRow } from '../lib/types/polymarket-outcomes';
import type { OHLCVData, Signal, Strategy, StrategyParams } from '../lib/types/strategies';

const ORIGINAL_FETCH = globalThis.fetch;

function makeBars(count: number, startTs = 1_700_000_000): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: (startTs + index * 300) as OHLCVData['time'],
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

const fixtureStrategy: Strategy = {
    name: 'Fixture Strategy',
    description: 'Polymarket finder fixture',
    defaultParams: { variant: 1 },
    paramLabels: { variant: 'Variant' },
    execute(data: OHLCVData[], params: StrategyParams): Signal[] {
        const first = data[0];
        const second = data[1];
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
            default:
                return [];
        }
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
        sortPriority: ['polyWinRate', 'polyPredictions', 'polyCoverage'],
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
        ...overrides,
    };
}

function makeInput(
    bars: OHLCVData[],
    paramSets: StrategyParams[],
    optionOverrides: Partial<FinderOptions> = {},
    interval = '5m'
): FinderRunInput {
    return {
        ohlcvData: bars,
        symbol: 'BTCUSDT',
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
                name: fixtureStrategy.name,
                strategy: fixtureStrategy,
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
        onRequest?.(url);
        expect(url.pathname).to.equal('/api/sqlite/load-polymarket-outcomes');
        return jsonResponse({ ok: true, rows });
    }) as typeof fetch;
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

describe('Finder Polymarket runner', () => {
    it('loads the BTC 5m outcome series and ranks by Polymarket metrics', async () => {
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
        expect(output.results.map((item) => item.params.variant)).to.deep.equal([2, 1, 3]);
        expect(output.results[0]?.polymarketEval?.winRate).to.equal(1);
        expect(output.results[0]?.polymarketEval?.predictionsTaken).to.equal(2);
        expect(statuses.some((status) => status.includes('Loaded 2 outcome rows'))).to.equal(true);
    });

    it('uses predictionsTaken for the Finder min/max filter in Polymarket mode', async () => {
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

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.params.variant).to.equal(2);
        expect(output.results[0]?.polymarketEval?.predictionsTaken).to.equal(2);
    });

    it('rejects non-5m intervals before touching the outcome loader', async () => {
        globalThis.fetch = (async () => {
            throw new Error('fetch should not be called for invalid interval');
        }) as typeof fetch;

        const { callbacks, statuses } = makeCallbacks();
        const output = await runPolymarketFinder(
            makeInput(makeBars(4), [{ variant: 1 }], {}, '1m'),
            callbacks
        );

        expect(output.results).to.have.length(0);
        expect(statuses.at(-1)).to.equal('Polymarket scoring requires 5m interval.');
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
});
