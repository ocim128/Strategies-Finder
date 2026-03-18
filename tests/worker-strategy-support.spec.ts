import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    getWorkerSupportedStrategyKeys,
    isWorkerSupportedStrategyKey,
} from './lib/alert-subscription-utils';
import { strategyManifest } from './lib/strategies/manifest';

describe('Worker strategy support', () => {
    it('supports every built-in manifest strategy in the worker path', () => {
        const manifestKeys = strategyManifest.map((entry) => entry.key).sort((a, b) => a.localeCompare(b));
        const workerKeys = getWorkerSupportedStrategyKeys();

        expect(workerKeys).to.deep.equal(manifestKeys);

        for (const key of manifestKeys) {
            expect(
                isWorkerSupportedStrategyKey(key),
                `worker should support manifest strategy ${key}`
            ).to.equal(true);
        }
    });
});
