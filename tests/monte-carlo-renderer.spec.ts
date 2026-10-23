import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createMonteCarloDom, MONTE_CARLO_REQUIRED_IDS } from '../lib/monte-carlo-dom';
import { renderMonteCarloResults } from '../lib/monte-carlo-renderer';
import { runMonteCarloSimulation, type MonteCarloSimulation } from '../lib/strategies/monte-carlo';
import type { BacktestResult } from '../lib/types/strategies';
import { createFakeElement } from './helpers/fake-element';

it('renders interpolated drawdown percentiles and fan bands for unequal-length paths without changing samples', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const elements = new Map(MONTE_CARLO_REQUIRED_IDS.map(id => [id as string, {
        ...createFakeElement(), getContext: (): unknown => null,
    }]));
    const paths: Array<Array<[number, number]>> = [];
    const ctx = {
        clearRect() {},
        beginPath() { paths.push([]); },
        moveTo(x: number, y: number) { paths.at(-1)!.push([x, y]); },
        lineTo(x: number, y: number) { paths.at(-1)!.push([x, y]); },
        closePath() {}, fill() {}, stroke() {},
    };
    elements.get('mc-equity-fan')!.getContext = () => ctx;
    Object.defineProperty(globalThis, 'document', {
        configurable: true, value: { getElementById: (id: string) => elements.get(id) ?? null },
    });
    try {
        const result = await runMonteCarloSimulation({ trades: [], netProfit: 0, sharpeRatio: 0 } as unknown as BacktestResult, {
            simulations: 1, seed: 1, enableSequenceRandomization: false,
            enableBootstrap: false, ruinThresholdPercent: 50, initialCapital: 100,
        });
        result.status = 'success';
        result.metricSamples.maxDrawdownPercentValues = [30, 0, 20, 10];
        result.simulations = [[30, 60], [10], [], [20, 40]].map((equityCurve, simulationId) => ({
            simulationId, equityCurve,
        } as MonteCarloSimulation));
        const snapshot = structuredClone(result);
        const dom = createMonteCarloDom();
        renderMonteCarloResults(result, dom);
        for (const expected of ['15.00%', '27.00%', '28.50%', '29.70%']) {
            assert.ok(dom.ddPercentilesBody.innerHTML.includes(expected), expected);
        }
        // Fan p5/p95 values are [11, 29] and [13, 58], spanning [11, 58].
        const y = (value: number) => 270 - (value - 11) / 47 * 240;
        const expectedPaths = [
            [[0, y(29)], [0, y(29)], [600, y(58)], [600, y(13)], [0, y(11)]],
            [[0, y(25)], [0, y(25)], [600, y(50)], [600, y(25)], [0, y(15)]],
            [[0, y(20)], [0, y(20)], [600, y(40)]],
        ];
        for (let path = 0; path < expectedPaths.length; path++) {
            assert.equal(paths[path].length, expectedPaths[path].length);
            for (let point = 0; point < paths[path].length; point++) {
                assert.equal(paths[path][point][0], expectedPaths[path][point][0]);
                assert.ok(Math.abs(paths[path][point][1] - expectedPaths[path][point][1]) < 1e-10);
            }
        }
        assert.deepEqual(result, snapshot);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
        else Reflect.deleteProperty(globalThis, 'document');
    }
});
