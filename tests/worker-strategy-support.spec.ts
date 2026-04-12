import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    getWorkerSupportedStrategyKeys,
    isWorkerSupportedStrategyKey,
} from './lib/alert-subscription-utils';
import { strategyManifest } from './lib/strategies/manifest';
import { strategies } from './lib/strategies/library';

describe('Worker strategy support', () => {
    it('supports every non-cross-symbol manifest strategy in the worker path', () => {
        const crossSymbolKeys = new Set(
            Object.entries(strategies)
                .filter(([, s]) => s.crossSymbolConfig != null)
                .map(([key]) => key)
        );
        const expectedWorkerKeys = strategyManifest
            .map((entry) => entry.key)
            .filter((key) => !crossSymbolKeys.has(key))
            .sort((a, b) => a.localeCompare(b));
        const workerKeys = getWorkerSupportedStrategyKeys();

        expect(workerKeys).to.deep.equal(expectedWorkerKeys);

        for (const key of expectedWorkerKeys) {
            expect(
                isWorkerSupportedStrategyKey(key),
                `worker should support manifest strategy ${key}`
            ).to.equal(true);
        }

        for (const key of crossSymbolKeys) {
            expect(
                isWorkerSupportedStrategyKey(key),
                `worker should NOT support cross-symbol strategy ${key}`
            ).to.equal(false);
        }
    });
});
